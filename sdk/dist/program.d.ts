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
/** Build the 13-account Pinocchio transact_spl instruction. */
export declare function buildTransactSplInstruction(params: BuildTxParams & SplTransactExtras): {
    ix: TransactionInstruction;
    accounts: TransactAccounts;
    treeAccount: PublicKey;
};
/** Assemble an unsigned v0 SPL transaction (uses ALT — required to fit proof + 13 accounts). */
export declare function buildTransactSplTransaction(params: BuildTxParams & SplTransactExtras & {
    lookupTables: AddressLookupTableAccount[];
}): Promise<{
    transaction: VersionedTransaction;
    accounts: TransactAccounts;
}>;
//# sourceMappingURL=program.d.ts.map