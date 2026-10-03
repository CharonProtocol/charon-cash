interface Keypair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}
export declare function generateX25519Keypair(seed?: Uint8Array | string): Promise<Keypair>;
export declare function generateSharedSecret(client: Keypair, pubKey: Uint8Array): Promise<Uint8Array<ArrayBufferLike>>;
/**
 *
 * @param data
 * @param shared_secret
 *
 * @returns prepends nonce/iv (12 bytes) + ciphertext + authtag (16 bytes)
 */
export declare function aes_encrypt(data: Uint8Array, encryptionKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
export declare function aes_decrypt(data: Uint8Array, decryptionKey: Uint8Array): Promise<Uint8Array<ArrayBufferLike> & Uint8Array<ArrayBuffer>>;
/**
 * Encryption/Decryption of Notes
 */
export declare class EncryptionService {
    static readonly ENCRYPTION_VERSION_V1: Uint8Array<ArrayBuffer>;
    private keypair;
    private constructor();
    static startEncryptionService(masterSeed: Uint8Array | string): Promise<EncryptionService>;
    getViewingKey(): Uint8Array<ArrayBuffer>;
    /**
     * Encrypts UTXO bytes for network.
     *
     * @param data - raw UTXO bytes to encrypt.
     * @returns The encrypted output buffer structured as:
     * `[version (8B) | ephemeral_pubkey (32B) | iv/nonce (12B) | ciphertext + authTag (16B)]`
     */
    encrypt(data: Uint8Array, targetViewingKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
    /**
     * Decrypts the UTXO bytes received from the network.
     *
     * @param data - encrypted output stored on the network
     * `[version (8B) | ephemeral_pubkey (32B) | iv/nonce (12B) | ciphertext + authTag (16B)]`
     * @returns The decrypted output: `raw UTXO bytes`
     */
    decrypt(encryptedOutput: Uint8Array): Promise<Uint8Array<ArrayBufferLike> & Uint8Array<ArrayBuffer>>;
    generateEncryptionDecryptionKey(sharedSecret: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
}
export {};
//# sourceMappingURL=encrypt.d.ts.map