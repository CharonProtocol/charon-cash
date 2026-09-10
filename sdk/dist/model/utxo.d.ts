/**
 * UTXO (Unspent Transaction Output) module for ZK Cash
 *
 * Provides UTXO functionality for the ZK Cash system
 * Based on: https://github.com/tornadocash/tornado-nova
 */
import * as hasher from "@lightprotocol/hasher.rs";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { Keypair } from "./keypair.js";
/**
 * Simplified Utxo class inspired by Tornado Cash Nova
 * Based on: https://github.com/tornadocash/tornado-nova/blob/f9264eeffe48bf5e04e19d8086ee6ec58cdf0d9e/src/utxo.js
 */
export declare class Utxo {
    amount: BN;
    blinding: BN;
    keypair: Keypair;
    index: number;
    mintAddress: string;
    private lightWasm;
    constructor({ lightWasm, amount, 
    /**
     * Tornado nova doesn't use solana eddsa with curve 25519 but their own "keypair"
     * which is:
     * - private key: random [31;u8]
     * - public key: PoseidonHash(privateKey)
     *
     * Generate a new keypair for each UTXO
     */
    keypair, blinding, // Use fixed value for consistency instead of randomBN()
    index, mintAddress, }: {
        lightWasm: hasher.LightWasm;
        amount?: BN | number | string;
        keypair?: Keypair;
        blinding?: BN | number | string;
        index?: number;
        mintAddress?: string;
    });
    getCommitment(): string;
    getNullifier(): Promise<string>;
    /**
     * Serialize the UTXO into a JSON string for storage/transmission.
     * Contains everything needed to reconstruct the UTXO and its keypair:
     * [amount, blinding, mintAddress, index, privateKey]
     */
    serialize(): Uint8Array;
    /**
     * Deserialize a UTXO from a string produced by `serialize()`.
     */
    static deserialize(serialized: Uint8Array, lightWasm: hasher.LightWasm): Utxo;
}
export declare function getMintAddressField(mint: PublicKey): string;
//# sourceMappingURL=utxo.d.ts.map