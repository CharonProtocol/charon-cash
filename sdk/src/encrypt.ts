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
 */
import { x25519 as webX25519 } from "@noble/curves/webcrypto.js";
import * as webCryptoHash from "@noble/hashes/webcrypto.js";
import * as webCryptoCipher from "@noble/ciphers/webcrypto.js";
import { randomBytes } from "@noble/ciphers/utils.js";

interface CipherKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export async function generateX25519CipherKeypair(
  seed?: Uint8Array | string,
): Promise<CipherKeypair> {
  if (seed) {
    const ikm =
      typeof seed === "string" ? new TextEncoder().encode(seed) : seed;

    const secretKey = await webCryptoHash.hkdf(
      webCryptoHash.sha256,
      ikm,
      new TextEncoder().encode("SILENTPAYX25519SECRETKEY"),
      new TextEncoder().encode("secretKey-for-x25519"),
      32,
    );
    const publicKey = (await webX25519.getPublicKey(secretKey, {
      formatPub: "raw",
      formatSec: "raw",
    })) as Uint8Array<ArrayBufferLike>;

    return { secretKey, publicKey };
  } else {
    const CipherKeypair = await webX25519.keygen();
    const pub_key = (await webX25519.utils.convertPublicKey(
      CipherKeypair.publicKey,
      "spki",
      "raw",
    )) as Uint8Array<ArrayBufferLike>;
    const s_key = (await webX25519.utils.convertSecretKey(
      CipherKeypair.secretKey,
      "pkcs8",
      "raw",
    )) as Uint8Array<ArrayBufferLike>;
    return { publicKey: pub_key, secretKey: s_key };
  }
}

export async function generateSharedSecret(
  client: CipherKeypair,
  pubKey: Uint8Array,
) {
  const shared_secret = await webX25519.getSharedSecret(
    client.secretKey,
    pubKey,
    {
      formatPub: "raw",
      formatSec: "raw",
    },
  );
  return shared_secret;
}

/**
 *
 * @param data
 * @param shared_secret
 *
 * @returns prepends nonce/iv (12 bytes) + ciphertext + authtag (16 bytes)
 */
export async function aes_encrypt(data: Uint8Array, encryptionKey: Uint8Array) {
  const iv = randomBytes(12);

  const cipher = webCryptoCipher.gcm(encryptionKey, iv);

  // NOTE : webcrypto api automatically appends auth_tag( 16 bytes ) at the end
  const ciphertext = await cipher.encrypt(data);

  const ret = new Uint8Array(ciphertext.length + iv.length);
  ret.set(iv);
  ret.set(ciphertext, iv.length);

  return ret;
}

export async function aes_decrypt(data: Uint8Array, decryptionKey: Uint8Array) {
  const iv = data.slice(0, 12);

  const ciphertext = data.slice(12);

  const decipher = webCryptoCipher.gcm(decryptionKey, iv);

  const decrypted_data = await decipher.decrypt(ciphertext);

  return decrypted_data;
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
    const CipherKeypair = await generateX25519CipherKeypair(masterSeed);
    return new EncryptionService(CipherKeypair);
  }

  getViewingKey() {
    return this.CipherKeypair.publicKey;
  }

  /**
   * Encrypts UTXO bytes for network.
   *
   * @param data - raw UTXO bytes to encrypt.
   * @returns The encrypted output buffer structured as:
   * `[version (8B) | ephemeral_pubkey (32B) | iv/nonce (12B) | ciphertext + authTag (16B)]`
   */
  async encrypt(data: Uint8Array, targetViewingKey: Uint8Array) {
    // Note's ephemeral CipherKeypair used for sharedSecret/Encryption
    // After encryption secret key will be discarded making the target only one that can
    // decrypt the note .
    const noteEphemeralCipherKeypair = await generateX25519CipherKeypair();

    const sharedSecret = await generateSharedSecret(
      noteEphemeralCipherKeypair,
      targetViewingKey,
    );

    const encryptionKey =
      await this.generateEncryptionDecryptionKey(sharedSecret);

    const ciphertext = await aes_encrypt(data, encryptionKey);

    // EncryptionService.ENCRYPTION_VERSION_V1.length + noteEphemeralCipherKeypair.publicKey.length +ciphertext.length;
    const encryptedOutputLength = 8 + 32 + ciphertext.length;
    const encryptedOutput = new Uint8Array(encryptedOutputLength);

    encryptedOutput.set(EncryptionService.ENCRYPTION_VERSION_V1);
    encryptedOutput.set(noteEphemeralCipherKeypair.publicKey, 8);
    encryptedOutput.set(ciphertext, 40);

    return encryptedOutput;
  }

  /**
   * Decrypts the UTXO bytes received from the network.
   *
   * @param data - encrypted output stored on the network
   * `[version (8B) | ephemeral_pubkey (32B) | iv/nonce (32B) | ciphertext + authTag (16B)]`
   * @returns The decrypted output: `raw UTXO bytes`
   */
  async decrypt(encryptedOutput: Uint8Array) {
    const version = encryptedOutput.slice(0, 8);

    const ephemeralPubkey = encryptedOutput.slice(8, 40);

    const sharedSecret = await generateSharedSecret(
      this.CipherKeypair,
      ephemeralPubkey,
    );

    const decryptionKey =
      await this.generateEncryptionDecryptionKey(sharedSecret);

    const ciphertext = encryptedOutput.slice(40);
    const deciphertext = await aes_decrypt(ciphertext, decryptionKey);

    return deciphertext;
  }

  async generateEncryptionDecryptionKey(sharedSecret: Uint8Array) {
    const textEncoder = new TextEncoder();
    const salt = textEncoder.encode("SILENTPAYENCRYPT");
    const info = textEncoder.encode("sharedsecret-to-gcmkey");

    const key = await webCryptoHash.hkdf(
      webCryptoHash.sha256,
      sharedSecret,
      salt,
      info,
      16,
    );

    return key;
  }
}
