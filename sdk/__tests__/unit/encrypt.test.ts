import { describe, beforeAll, test, expect } from "bun:test";
import {
  EncryptionService,
  generateX25519CipherKeypair,
  generateSharedSecret,
  aes_decrypt,
} from "../../src/encrypt";
import { gunzipSync } from "node:zlib";
import { randomBytes } from "@noble/ciphers/utils.js";

describe("Encryption Service Tests", () => {
  let alice: EncryptionService;
  let bob: EncryptionService;
  let charlie: EncryptionService;

  beforeAll(async () => {
    const textEncoder = new TextEncoder();

    alice = await EncryptionService.startEncryptionService(
      textEncoder.encode("ALICE"),
    );
    bob = await EncryptionService.startEncryptionService(
      textEncoder.encode("BOB"),
    );
    charlie = await EncryptionService.startEncryptionService(
      textEncoder.encode("CHARLIE"),
    );
  });

  test("Alice encrypt message for Bob and only Bob can decrypt it ", async () => {
    const sentMessage = "Ronaldo is the GOAT";

    const bobViewingKey = bob.getViewingKey();

    // Encrypting message for bob
    const encryptedMessage = await alice.encrypt(
      new TextEncoder().encode(sentMessage),
      bobViewingKey,
    );

    // Alice must NOT be able to decrypt
    await expect(alice.decrypt(encryptedMessage)).rejects.toThrow();

    // Charlie must NOT be able to decrypt
    await expect(charlie.decrypt(encryptedMessage)).rejects.toThrow();

    // Bob MUST be able to decrypt
    const decryptedMessage = await bob.decrypt(encryptedMessage);

    const receivedMessage = new TextDecoder().decode(decryptedMessage);

    expect(receivedMessage).toBe(sentMessage);
  });

  test("encrypted notes contain standard gzip data", async () => {
    const recipient = await generateX25519CipherKeypair("GZIP_RECIPIENT");
    const note = randomBytes(108);
    const encrypted = await alice.encrypt(note, recipient.publicKey);
    const sharedSecret = await generateSharedSecret(
      recipient,
      encrypted.slice(8, 40),
    );
    const key = await alice.generateEncryptionDecryptionKey(sharedSecret);
    const compressed = await aes_decrypt(encrypted.slice(40), key);

    expect(new Uint8Array(gunzipSync(compressed))).toEqual(note);
  });

  test("Alice encrypt message to self ", async () => {
    const sentMessage = "Ronaldo is the GOAT";

    const aliceViewingKey = alice.getViewingKey();

    // Encrypting message for bob
    const encryptedMessage = await alice.encrypt(
      new TextEncoder().encode(sentMessage),
      aliceViewingKey,
    );

    // Bob must NOT be able to decrypt
    await expect(bob.decrypt(encryptedMessage)).rejects.toThrow();

    // Charlie must NOT be able to decrypt
    await expect(charlie.decrypt(encryptedMessage)).rejects.toThrow();

    // Bob MUST be able to decrypt
    const decryptedMessage = await alice.decrypt(encryptedMessage);

    const receivedMessage = new TextDecoder().decode(decryptedMessage);

    expect(receivedMessage).toBe(sentMessage);
  });

  test("modified ciphertext", async () => {
    const sentMessage = "Ronaldo is the GOAT";

    const bobViewingKey = bob.getViewingKey();

    // Encrypting message for bob
    const encryptedMessage = await alice.encrypt(
      new TextEncoder().encode(sentMessage),
      bobViewingKey,
    );

    let modifiedEncryptedMessage = new Uint8Array(encryptedMessage.length + 9);
    modifiedEncryptedMessage.set([1, 2, 3, 4, 5, 6, 7, 8, 9], 0);
    modifiedEncryptedMessage.set(encryptedMessage, 9);

    // Bob must NOT be able to decrypt
    await expect(bob.decrypt(modifiedEncryptedMessage)).rejects.toThrow();
  });
  test("modified IV/nonce", async () => {
    const sentMessage = "Ronaldo is the GOAT";

    const bobViewingKey = bob.getViewingKey();

    // Encrypting message for bob
    const encryptedMessage = await alice.encrypt(
      new TextEncoder().encode(sentMessage),
      bobViewingKey,
    );

    // [version (8B) | ephemeral_pubkey (32B) | iv/nonce (12B) | ciphertext + authTag (16B)]
    let modifiedEncryptedMessage = new Uint8Array(encryptedMessage.length);
    modifiedEncryptedMessage.set(encryptedMessage.slice(0, 40));
    let modifiedIV = randomBytes(12);
    modifiedEncryptedMessage.set(modifiedIV, 40);
    modifiedEncryptedMessage.set(encryptedMessage.slice(52));

    // Bob must NOT be able to decrypt
    await expect(bob.decrypt(modifiedEncryptedMessage)).rejects.toThrow();
  });
  test("modified Key", async () => {
    const sentMessage = "Ronaldo is the GOAT";

    const bobViewingKey = bob.getViewingKey();

    // Encrypting message for bob
    const encryptedMessage = await alice.encrypt(
      new TextEncoder().encode(sentMessage),
      bobViewingKey,
    );

    // [version (8B) | ephemeral_pubkey (32B) | iv/nonce (12B) | ciphertext + authTag (16B)]
    let modifiedEncryptedMessage = new Uint8Array(encryptedMessage.length);
    modifiedEncryptedMessage.set(encryptedMessage.slice(0, 8));
    let newEphemeralKeyair = await generateX25519CipherKeypair("CryBaby");
    modifiedEncryptedMessage.set(newEphemeralKeyair.publicKey, 8);
    modifiedEncryptedMessage.set(encryptedMessage.slice(40));

    // Bob must NOT be able to decrypt
    await expect(bob.decrypt(modifiedEncryptedMessage)).rejects.toThrow();
  });
  test("modified authTag", async () => {
    const sentMessage = "Ronaldo is the GOAT";

    const bobViewingKey = bob.getViewingKey();

    // Encrypting message for bob
    const encryptedMessage = await alice.encrypt(
      new TextEncoder().encode(sentMessage),
      bobViewingKey,
    );

    // [version (8B) | ephemeral_pubkey (32B) | iv/nonce (12B) | ciphertext + authTag (16B)]
    let cipherTextLength = encryptedMessage.length - (8 + 32 + 12 + 16);
    let cipherTextEnd = 8 + 32 + 12 + cipherTextLength;

    let modifiedEncryptedMessage = new Uint8Array(encryptedMessage.length);
    let newAuthTag = randomBytes(16);
    modifiedEncryptedMessage.set(encryptedMessage.slice(0, cipherTextEnd));
    modifiedEncryptedMessage.set(newAuthTag, cipherTextEnd);

    // Bob must NOT be able to decrypt
    await expect(bob.decrypt(modifiedEncryptedMessage)).rejects.toThrow();
  });
});
