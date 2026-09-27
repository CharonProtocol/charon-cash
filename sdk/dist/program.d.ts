import { LightWasm } from "@lightprotocol/hasher.rs";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Utxo } from "./model/utxo";
import BN from "bn.js";
import { EncryptionService } from "./encrypt";
import { SilentPayError } from "./error";
export declare class ProgramError extends SilentPayError {
    programErrorCode: ProgramErrorCode | undefined;
    constructor(message: string, programErrorCode?: ProgramErrorCode | undefined, options?: {
        cause: unknown;
    });
}
export declare enum ProgramErrorCode {
    Unauthorized = "Unauthorized",
    InvalidMintAddress = "InvalidMintAddress",
    InvalidMerkleTreeHeight = "InvalidMerkleTreeHeight",
    InvalidRootHistorySize = "InvalidRootHistorySize",
    InvalidFeeRate = "InvalidFeeRate",
    UnknownRoot = "UnknownRoot",
    ExtDataHashMismatch = "ExtDataHashMismatch",
    InvalidPublicAmountData = "InvalidPublicAmountData",
    DepositLimitExceeded = "DepositLimitExceeded",
    InsufficientFundsForWithdrawal = "InsufficientFundsForWithdrawal",
    InsufficientFundsForFee = "InsufficientFundsForFee",
    InvalidFeeAmount = "InvalidFeeAmount",
    InvalidTokenAccount = "InvalidTokenAccount",
    InvalidTokenAccountMintAddress = "InvalidTokenAccountMintAddress",
    InvalidProof = "InvalidProof",
    InvalidMerkleTreeAccount = "InvalidMerkleTreeAccount"
}
export type TransactArgs = {
    inputUtxos: Utxo[];
    extAmount: BN;
    fee: BN;
    mintAddress: string;
    recipientKey: string;
    lightwasm: LightWasm;
    encryptionService: EncryptionService;
    signer: PublicKey;
    connection: Connection;
    circuit: {
        wasm: Uint8Array;
        zkey: Uint8Array;
    };
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
};
export declare function transactSol({ inputUtxos, extAmount, fee, mintAddress, lightwasm, recipientKey, encryptionService, signer, connection, signTransaction, circuit, }: TransactArgs): Promise<string>;
export declare function transactSpl({ inputUtxos, extAmount, fee, mintAddress, lightwasm, recipientKey, encryptionService, signer, connection, signTransaction, circuit, }: TransactArgs): Promise<string>;
//# sourceMappingURL=program.d.ts.map