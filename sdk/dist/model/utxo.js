/**
 * UTXO (Unspent Transaction Output) module for ZK Cash
 *
 * Provides UTXO functionality for the ZK Cash system
 * Based on: https://github.com/tornadocash/tornado-nova
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ethers } from "ethers";
import { Keypair } from "./keypair.js";
import { getMintAddressField } from "../utils.js";
// Byte layout (all integers big-endian):
// [0..8)    amount       (8 bytes,  u64)
// [8..40)   blinding     (32 bytes, field element)
// [40..72)  mintAddress  (32 bytes, Solana pubkey)
// [72..76)  index        (4 bytes,  u32)
// [76..108) privateKey   (32 bytes, field element)
const UTXO_SERIALIZED_LENGTH = 108;
function bnToFixedBytes(bn, length) {
    // BN.toArray throws if the value doesn't fit in `length` bytes,
    // which is exactly the guard we want here.
    return Uint8Array.from(bn.toArray("be", length));
}
function concatBytes(chunks) {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}
/**
 * Simplified Utxo class inspired by Tornado Cash Nova
 * Based on: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/utxo.js
 */
export class Utxo {
    amount;
    blinding;
    keypair;
    index;
    mintAddress;
    lightWasm;
    constructor({ lightWasm, amount = new BN(0), 
    /**
     * Tornado nova doesn't use solana eddsa with curve 25519 but their own "keypair"
     * which is:
     * - private key: random [31;u8]
     * - public key: PoseidonHash(privateKey)
     *
     * Generate a new keypair for each UTXO
     */
    keypair, blinding = new BN(Math.floor(Math.random() * 1000000000)), // Use fixed value for consistency instead of randomBN()
    index = 0, mintAddress = "11111111111111111111111111111112", // Default to Solana native SOL mint address,
     }) {
        this.amount = new BN(amount.toString());
        this.blinding = new BN(blinding.toString());
        this.lightWasm = lightWasm;
        this.keypair =
            keypair ||
                new Keypair(ethers.Wallet.createRandom().privateKey, lightWasm);
        this.index = index;
        this.mintAddress = mintAddress;
    }
    getCommitment() {
        // return this.lightWasm.poseidonHashString([this.amount.toString(), this.keypair.pubkey.toString(), this.blinding.toString(), this.mintAddress]);
        const mintAddressField = getMintAddressField(new PublicKey(this.mintAddress));
        return this.lightWasm.poseidonHashString([
            this.amount.toString(),
            this.keypair.pubkey.toString(),
            this.blinding.toString(),
            mintAddressField,
        ]);
    }
    getNullifier() {
        const commitmentValue = this.getCommitment();
        const signature = this.keypair.sign(commitmentValue, new BN(this.index).toString());
        return this.lightWasm.poseidonHashString([
            commitmentValue,
            new BN(this.index).toString(),
            signature,
        ]);
    }
    /**
     * Serialize the UTXO into a JSON string for storage/transmission.
     * Contains everything needed to reconstruct the UTXO and its keypair:
     * [amount, blinding, mintAddress, index, privateKey]
     */
    serialize() {
        const amountBytes = bnToFixedBytes(this.amount, 8);
        const blindingBytes = bnToFixedBytes(this.blinding, 32);
        const mintAddressBytes = new PublicKey(this.mintAddress).toBytes(); // 32 bytes
        const indexBytes = bnToFixedBytes(new BN(this.index), 4);
        // this.keypair.privkey is already reduced mod FIELD_SIZE (see Keypair constructor)
        const privateKeyBytes = bnToFixedBytes(this.keypair.privkey, 32);
        return concatBytes([
            amountBytes,
            blindingBytes,
            mintAddressBytes,
            indexBytes,
            privateKeyBytes,
        ]);
    }
    /**
     * Deserialize a UTXO from a string produced by `serialize()`.
     */
    static deserialize(serialized, lightWasm) {
        if (serialized.length !== UTXO_SERIALIZED_LENGTH) {
            throw new Error(`Invalid serialized UTXO length: expected ${UTXO_SERIALIZED_LENGTH}, got ${serialized.length}`);
        }
        const amountBytes = serialized.slice(0, 8);
        const blindingBytes = serialized.slice(8, 40);
        const mintAddressBytes = serialized.slice(40, 72);
        const indexBytes = serialized.slice(72, 76);
        const privateKeyBytes = serialized.slice(76, 108);
        const amount = new BN(amountBytes, "be");
        const blinding = new BN(blindingBytes, "be");
        const mintAddress = new PublicKey(mintAddressBytes).toString();
        const index = new BN(indexBytes, "be").toNumber();
        const privateKeyHex = "0x" + Buffer.from(privateKeyBytes).toString("hex");
        const keypair = new Keypair(privateKeyHex, lightWasm);
        return new Utxo({
            lightWasm,
            amount,
            keypair,
            blinding,
            index,
            mintAddress,
        });
    }
}
