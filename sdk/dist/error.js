export class SilentPayError extends Error {
    code;
    constructor(message, code, options) {
        super(message, { cause: options?.cause });
        this.code = code;
        this.name = "SilentPayError";
    }
}
export var SilentPayErrorCode;
(function (SilentPayErrorCode) {
    SilentPayErrorCode["INVALID_INPUT"] = "INVALID_INPUT";
    SilentPayErrorCode["INVALID_UTXO_COUNT"] = "INVALID_UTXO_COUNT";
    SilentPayErrorCode["API_ERROR"] = "API_ERROR";
    SilentPayErrorCode["ENCRYPTION_ERROR"] = "ENCRYPTION_ERROR";
    SilentPayErrorCode["PROOF_GENERATION_ERROR"] = "PROOF_GENERATION_ERROR";
    SilentPayErrorCode["SOLANA_ERROR"] = "SOLANA_ERROR";
    SilentPayErrorCode["TRANSACTION_ERROR"] = "TRANSACTION_ERROR";
    SilentPayErrorCode["INSUFFICIENT_BALANCE"] = "INSUFFICIENT_BALANCE";
    SilentPayErrorCode["INVALID_STATE"] = "INVALID_STATE";
    SilentPayErrorCode["STORAGE_ERROR"] = "STORAGE_ERROR";
    SilentPayErrorCode["PROGRAM_ERROR"] = "PROGRAM_ERROR";
    SilentPayErrorCode["WITHDRAWAL_LIMIT"] = "WITHDRAWAL_LIMIT";
    SilentPayErrorCode["UTXO_FINISHED"] = "UTXO_FINISHED";
    SilentPayErrorCode["INVALID_VIEWING_KEY"] = "INVALID_VIEWING_KEY";
    SilentPayErrorCode["UNKNOWN"] = "UNKNOWN";
})(SilentPayErrorCode || (SilentPayErrorCode = {}));
