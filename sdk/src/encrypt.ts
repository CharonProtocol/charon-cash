/**
 *  Flow of encryption key generation
 *
 *  1. Generate random X25519 CipherKeypair
 *       (note_p,note_s) = x25519()
 *  2. Get the recipient pubkey
 *        (recv_p)
 *  3. Generate shared secret
 *        shared_secret = keygen.shared_secret(note_s,recv_p);
 *  4. Pass the shared_secret through hkdf function
 *        note_encryption_key = hkdf(shared_secret,salt)
 *
 * Pure JS (noble), not WebCrypto. Browser `crypto.subtle` X25519 import/export
 * on Safari and Firefox produced a ciphertext that encrypted and then failed
 * to decrypt. The gzip step stays: notes are compressed before they are encrypted.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CharonProtocolError, CharonProtocolErrorCode } from "./error";

interface CipherKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function copy32(bytes: Uint8Array, label: string): Uint8Array {
  const copied = Uint8Array.from(bytes);
  if (copied.length !== 32) {
    throw new Error(`${label}: expected 32 bytes, got ${copied.length}`);
  }
  return copied;
}

export class EncryptionError extends CharonProtocolError {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, CharonProtocolErrorCode.ENCRYPTION_ERROR, {
      cause: options?.cause,
    });

    this.name = "EncryptionError";

    Object.setPrototypeOf(this, EncryptionError.prototype);
  }
}

/**
 * Encryption/Decryption of Notes
 */
export class EncryptionService {
  public static readonly ENCRYPTION_VERSION_V1 = Uint8Array.from([
    0, 0, 0, 0, 0, 0, 0, 1,
  ]);

  // This represents the wallet's X25519 CipherKeypair
  private CipherKeypair: CipherKeypair;

  private constructor(CipherKeypair: CipherKeypair) {
    this.CipherKeypair = CipherKeypair;
  }

  public static async startEncryptionService(masterSeed: Uint8Array | string) {
    try {
      const CipherKeypair = await generateX25519CipherKeypair(masterSeed);
      return new EncryptionService(CipherKeypair);
    } catch (error) {
      throw new EncryptionError("Failed to generate cipher keypair", {
        cause: error,
      });
    }
  }

  getViewingKey() {
    return Uint8Array.from(this.CipherKeypair.publicKey);
  }

  /**
   * Encrypts UTXO bytes for network.
   *
   * @param data - raw UTXO bytes to encrypt.
   * @returns The encrypted output buffer structured as:
   * `[version (8B) | ephemeral_pubkey (32B) | iv/nonce (12B) | ciphertext + authTag (16B)]`
   */
  async encrypt(data: Uint8Array, targetViewingKey: Uint8Array) {
    try {
      // Note's ephemeral CipherKeypair used for sharedSecret/Encryption
      // After encryption secret key will be discarded making the target only one that can
      // decrypt the note .
      const noteEphemeralCipherKeypair = await generateX25519CipherKeypair();

      const sharedSecret = await generateSharedSecret(
        noteEphemeralCipherKeypair,
        copy32(targetViewingKey, "recipient viewing key"),
      );

      const encryptionKey =
        await this.generateEncryptionDecryptionKey(sharedSecret);

      // compression should happen before encryption
      const cs = new CompressionStream("gzip");

      const compressedPromise = new Response(cs.readable).arrayBuffer();

      const writer = cs.writable.getWriter();
      await writer.write(data as Uint8Array<ArrayBuffer>);
      await writer.close();

      const compressedData = new Uint8Array(await compressedPromise);
      const ciphertext = await aes_encrypt(compressedData, encryptionKey);

      const encryptedOutput = new Uint8Array(8 + 32 + ciphertext.length);

      encryptedOutput.set(EncryptionService.ENCRYPTION_VERSION_V1);
      encryptedOutput.set(
        copy32(noteEphemeralCipherKeypair.publicKey, "ephemeral pub"),
        8,
      );
      encryptedOutput.set(ciphertext, 40);

      return encryptedOutput;
    } catch (error) {
      throw new EncryptionError("Failed to perform encryption", {
        cause: error,
      });
    }
  }

  /**
   * Decrypts the UTXO bytes received from the network.
   *
   * @param data - encrypted output stored on the network
   * `[version (8B) | ephemeral_pubkey (32B) | iv/nonce (12B) | ciphertext + authTag (16B)]`
   * @returns The decrypted output: `raw UTXO bytes`
   */
  async decrypt(encryptedOutput: Uint8Array) {
    try {
      const ephemeralPubkey = copy32(
        Uint8Array.from(encryptedOutput.slice(8, 40)),
        "ephemeral pubkey",
      );

      const sharedSecret = await generateSharedSecret(
        this.CipherKeypair,
        ephemeralPubkey,
      );

      const decryptionKey =
        await this.generateEncryptionDecryptionKey(sharedSecret);

      const deciphertext = await aes_decrypt(
        encryptedOutput.slice(40),
        decryptionKey,
      );

      // decompression should happen after decryption
      const cs = new DecompressionStream("gzip");
      const decompressedPromise = new Response(cs.readable).arrayBuffer();

      const writer = cs.writable.getWriter();
      await writer.write(deciphertext);
      await writer.close();

      return new Uint8Array(await decompressedPromise);
    } catch (error) {
      throw new EncryptionError("Failed to perform decryption", {
        cause: error,
      });
    }
  }

  async generateEncryptionDecryptionKey(sharedSecret: Uint8Array) {
    try {
      return Uint8Array.from(
        hkdf(
          sha256,
          sharedSecret,
          new TextEncoder().encode("SILENTPAYENCRYPT"),
          new TextEncoder().encode("sharedsecret-to-gcmkey"),
          16,
        ),
      );
    } catch (error) {
      throw new EncryptionError(
        "Failed to generate encryption/decryption key",
        { cause: error },
      );
    }
  }
}

export async function generateX25519CipherKeypair(
  seed?: Uint8Array | string,
): Promise<CipherKeypair> {
  if (seed) {
    const ikm = typeof seed === "string" ? new TextEncoder().encode(seed) : seed;
    const secretKey = Uint8Array.from(
      hkdf(
        sha256,
        ikm,
        new TextEncoder().encode("SILENTPAYX25519SECRETKEY"),
        new TextEncoder().encode("secretKey-for-x25519"),
        32,
      ),
    );
    // getPublicKey may clamp the scalar in place — copy first.
    const publicKey = x25519.getPublicKey(Uint8Array.from(secretKey));
    return { secretKey, publicKey: Uint8Array.from(publicKey) };
  }

  const generated = x25519.keygen();
  return {
    publicKey: Uint8Array.from(generated.publicKey),
    secretKey: Uint8Array.from(generated.secretKey),
  };
}

export async function generateSharedSecret(
  client: CipherKeypair,
  pubKey: Uint8Array,
) {
  return x25519.getSharedSecret(
    copy32(client.secretKey, "x25519 secret"),
    copy32(pubKey, "x25519 public"),
  );
}

/**
 * @returns prepends nonce/iv (12 bytes) + ciphertext + authtag (16 bytes)
 */
export async function aes_encrypt(data: Uint8Array, encryptionKey: Uint8Array) {
  const iv = randomBytes(12);
  const ciphertext = gcm(encryptionKey, iv).encrypt(data);
  const ret = new Uint8Array(ciphertext.length + iv.length);
  ret.set(iv);
  ret.set(ciphertext, iv.length);
  return ret;
}

export async function aes_decrypt(data: Uint8Array, decryptionKey: Uint8Array) {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  return gcm(decryptionKey, iv).decrypt(ciphertext);
}
