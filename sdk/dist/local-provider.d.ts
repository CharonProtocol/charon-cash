import type { LightWasm } from "@lightprotocol/hasher.rs";
import { Connection, PublicKey } from "@solana/web3.js";
export interface SolTreeState {
    /** Merkle root as a decimal field-element string (circuit-ready). */
    root: string;
    nextLeafIndex: number;
}
/**
 * Local Poseidon Merkle mirror (zeroElement = 0), matching the on-chain tree.
 * Backed by localStorage (per wallet) so it survives reloads. The browser owns
 * its note set, so this tracks every commitment it created — no shared indexer.
 */
export declare class LocalMirror {
    private zeros;
    private layers;
    private wasm;
    constructor(wasm: LightWasm);
    static fromLeaves(wasm: LightWasm, leaves: string[]): LocalMirror;
    insert(leaf: string): void;
    indexOf(leaf: string): number;
    path(index: number): string[];
    leaves(): string[];
    /** Current root as a decimal field-element string. */
    root(): string;
}
/** Read current root + next leaf index from an on-chain tree account (SOL or SPL). */
export declare function readTreeState(connection: Connection, programId: PublicKey, treeKey?: string): Promise<SolTreeState>;
/** @deprecated use readTreeState(connection, programId, "sol") */
export declare function readSolTreeState(connection: Connection, programId: PublicKey): Promise<SolTreeState>;
/** Read withdrawal fee rate + error margin (bps) from the on-chain global config. */
export declare function readGlobalFees(connection: Connection, programId: PublicKey): Promise<{
    withdrawalFeeRateBps: number;
    feeErrorMarginBps: number;
}>;
export declare function isProgramInitialized(connection: Connection, programId: PublicKey): Promise<boolean>;
//# sourceMappingURL=local-provider.d.ts.map