import { PublicKey, TransactionInstruction, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import BN from "bn.js";
/** Byte layout the Pinocchio program's TransactArgs expects (see state/transact.rs). */
export interface ProofBytes {
    proofA: number[];
    proofB: number[];
    proofC: number[];
    root: number[];
    publicAmount: number[];
    extDataHash: number[];
    inputNullifiers: number[][];
    outputCommitments: number[][];
}
export interface TransactAccounts {
    treeAccount: PublicKey;
    treeTokenAccount: PublicKey;
    globalConfig: PublicKey;
    nullifier0: PublicKey;
    nullifier1: PublicKey;
    nullifier2: PublicKey;
    nullifier3: PublicKey;
    bump0: number;
    bump1: number;
}
export declare function deriveAccounts(programId: PublicKey, nullifierHash0: Uint8Array, nullifierHash1: Uint8Array): TransactAccounts;
export declare function buildTransactIxData(isSpl: boolean, proof: ProofBytes, extAmount: BN, fee: BN, encryptedOutput1: Uint8Array, encryptedOutput2: Uint8Array, bump0: number, bump1: number): Buffer;
export interface BuildTxParams {
    blockhash: string;
    programId: PublicKey;
    signer: PublicKey;
    isSpl: boolean;
    proof: ProofBytes;
    extAmount: BN;
    fee: BN;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    recipient: PublicKey;
    feeRecipient: PublicKey;
}
/** Assemble an unsigned v0 transaction (no ALT — sized to fit inline). */
export declare function buildTransactTransaction(params: BuildTxParams): Promise<{
    transaction: VersionedTransaction;
    accounts: TransactAccounts;
}>;
export declare const TOKEN_PROGRAM_ID: PublicKey;
export declare const ATA_PROGRAM_ID: PublicKey;
/** SPL tree PDA includes the mint: PDA(['merkle_tree', mint], programId). */
export declare function deriveSplTreeAccount(programId: PublicKey, mint: PublicKey): [PublicKey, number];
export declare function buildInitializeSplIxData(maxDeposit: bigint | number, bump: number): Buffer;
export interface SplTransactExtras {
    mint: PublicKey;
    signerTokenAccount: PublicKey;
    recipientTokenAccount: PublicKey;
    feeRecipientAta: PublicKey;
    /** Optional instructions prepended (e.g. create ATA idempotent). */
    preIxs?: TransactionInstruction[];
}
/** Build the 16-account Pinocchio transact_spl instruction. */
export declare function buildTransactSplInstruction(params: BuildTxParams & SplTransactExtras): {
    ix: TransactionInstruction;
    accounts: TransactAccounts;
    treeAccount: PublicKey;
};
/** Assemble an unsigned v0 SPL transaction (uses ALT — required to fit proof + 16 accounts). */
export declare function buildTransactSplTransaction(params: BuildTxParams & SplTransactExtras & {
    lookupTables: AddressLookupTableAccount[];
}): Promise<{
    transaction: VersionedTransaction;
    accounts: TransactAccounts;
}>;
export interface SwapAccounts {
    solTreeAccount: PublicKey;
    treeTokenAccount: PublicKey;
    globalConfig: PublicKey;
    outTreeAccount: PublicKey;
    poolWsolAccount: PublicKey;
    poolSplAccount: PublicKey;
}
export declare function deriveSwapAccounts(programId: PublicKey, splMint: PublicKey): SwapAccounts;
export interface SwapIxParams {
    programId: PublicKey;
    signer: PublicKey;
    proofIn: ProofBytes;
    proofOut: ProofBytes;
    extAmountIn: BN | number | string;
    extAmountOut: BN | number | string;
    encryptedOutputIn1: Uint8Array;
    encryptedOutputIn2: Uint8Array;
    encryptedOutputOut1: Uint8Array;
    encryptedOutputOut2: Uint8Array;
    outMint: PublicKey;
    fromMint?: PublicKey | string;
    routeData: Buffer | Uint8Array;
    routeAccounts: {
        pubkey: PublicKey;
        isSigner?: boolean;
        isWritable: boolean;
    }[];
}
export declare function buildSwapIxData(params: SwapIxParams, jupiterAccountIndices?: number[]): Buffer;
export declare function buildSwapInstruction(params: SwapIxParams): {
    ix: TransactionInstruction;
};
export declare function buildSwapTransaction(params: SwapIxParams & {
    blockhash: string;
    feePayer?: PublicKey;
    computeUnitLimit?: number;
}): {
    bytes: Uint8Array;
    ix: TransactionInstruction;
};
export declare function buildWrapSolInstruction(params: {
    programId: PublicKey;
    signer: PublicKey;
    amount: BN | number | string;
}): TransactionInstruction;
//# sourceMappingURL=program.d.ts.map