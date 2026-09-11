export declare class SilentPayError extends Error {
    readonly code: SilentPayErrorCode;
    constructor(message: string, code: SilentPayErrorCode, options?: {
        cause?: unknown;
        details?: Record<string, unknown>;
    });
}
export declare enum SilentPayErrorCode {
    INVALID_INPUT = "INVALID_INPUT",
    INVALID_UTXO_COUNT = "INVALID_UTXO_COUNT",
    API_ERROR = "API_ERROR",
    ENCRYPTION_ERROR = "ENCRYPTION_ERROR",
    PROOF_GENERATION_ERROR = "PROOF_GENERATION_ERROR",
    SOLANA_ERROR = "SOLANA_ERROR",
    TRANSACTION_ERROR = "TRANSACTION_ERROR",
    INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
    INVALID_STATE = "INVALID_STATE",
    STORAGE_ERROR = "STORAGE_ERROR",
    PROGRAM_ERROR = "PROGRAM_ERROR",
    WITHDRAWAL_LIMIT = "WITHDRAWAL_LIMIT",
    UTXO_FINISHED = "UTXO_FINISHED",
    INVALID_VIEWING_KEY = "INVALID_VIEWING_KEY",
    UNKNOWN = "UNKNOWN"
}
//# sourceMappingURL=error.d.ts.map