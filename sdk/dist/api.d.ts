import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { SilentPayError } from "./error";
export declare class ApiClientError extends SilentPayError {
    apiErrorCode: ApiErrorCode;
    details?: ErrorDetail | null;
    status: number;
    constructor(apiErrorCode: ApiErrorCode, message: string, status: number, details?: ErrorDetail | null);
}
export type Success<T> = {
    success: boolean;
    data: T;
    meta: RequestMeta;
};
export type ErrorResponse = {
    success: boolean;
    error: ApiError;
    meta: RequestMeta;
};
export type ApiError = {
    code: string;
    message: string;
    details?: null | ErrorDetail;
};
export type ErrorDetail = {
    field: string;
    reason: string;
};
export type RequestMeta = {
    requestId: string;
    timestamp: string;
};
declare enum ApiErrorCode {
    ValidationError = "Validation_Error",
    DbError = "Db_Error",// Most Likely DB connection failed or maintainence
    ValueNotFound = "Value_Not_Found",// Unregistered User
    InvalidInput = "Invalid_Input",
    DuplicateValue = "Duplicate_Value",// Re-registration of user
    BadGateway = "Bad_Gateway",
    Unauthorized = "Unauthorized",
    PoolDoesNotExists = "Pool_Does_Not_Exists",
    PoolError = "Pool_Error"
}
declare function fetchRecipientViewingKey(pubkey: PublicKey): Promise<Uint8Array<ArrayBuffer>>;
declare function checkRegistration(pubkey: PublicKey): Promise<Boolean>;
export type RegistrationInfo = {
    walletPubkey: string;
    viewingkey: number[];
};
declare function registerUser(info: RegistrationInfo): Promise<void>;
export type TreeState = {
    nextLeafIndex: BN;
    poolId: string;
    currentRoot: Uint8Array;
};
declare function fetchTreeState(mintAddress: string): Promise<TreeState>;
export type MerkleProof = {
    root: Uint8Array;
    nextIndex: string;
    proofs: Uint8Array[][];
};
declare function fetchMerkleProof(mintAddress: string, leafIndex1: string, leafIndex2: string): Promise<MerkleProof>;
declare function fetchNotes(lastFetchedNoteIndex: number): Promise<Uint8Array<ArrayBufferLike>[]>;
export declare const API: {
    fetchNotes: typeof fetchNotes;
    fetchMerkleProof: typeof fetchMerkleProof;
    fetchRecipientViewingKey: typeof fetchRecipientViewingKey;
    fetchTreeState: typeof fetchTreeState;
    checkRegistration: typeof checkRegistration;
    registerUser: typeof registerUser;
};
export {};
//# sourceMappingURL=api.d.ts.map