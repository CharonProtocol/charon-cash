export class CharonProtocolError extends Error {
    code;
    constructor(message, code, options) {
        super(message, { cause: options?.cause });
        this.code = code;
        this.name = "CharonProtocolError";
    }
}
export var CharonProtocolErrorCode;
(function (CharonProtocolErrorCode) {
    CharonProtocolErrorCode["INVALID_INPUT"] = "INVALID_INPUT";
    CharonProtocolErrorCode["INVALID_UTXO_COUNT"] = "INVALID_UTXO_COUNT";
    CharonProtocolErrorCode["API_ERROR"] = "API_ERROR";
    CharonProtocolErrorCode["ENCRYPTION_ERROR"] = "ENCRYPTION_ERROR";
    CharonProtocolErrorCode["PROOF_GENERATION_ERROR"] = "PROOF_GENERATION_ERROR";
    CharonProtocolErrorCode["SOLANA_ERROR"] = "SOLANA_ERROR";
    CharonProtocolErrorCode["TRANSACTION_ERROR"] = "TRANSACTION_ERROR";
    CharonProtocolErrorCode["INSUFFICIENT_BALANCE"] = "INSUFFICIENT_BALANCE";
    CharonProtocolErrorCode["INVALID_STATE"] = "INVALID_STATE";
    CharonProtocolErrorCode["STORAGE_ERROR"] = "STORAGE_ERROR";
    CharonProtocolErrorCode["PROGRAM_ERROR"] = "PROGRAM_ERROR";
    CharonProtocolErrorCode["WITHDRAWAL_LIMIT"] = "WITHDRAWAL_LIMIT";
    CharonProtocolErrorCode["UTXO_FINISHED"] = "UTXO_FINISHED";
    CharonProtocolErrorCode["INVALID_VIEWING_KEY"] = "INVALID_VIEWING_KEY";
    CharonProtocolErrorCode["UNKNOWN"] = "UNKNOWN";
})(CharonProtocolErrorCode || (CharonProtocolErrorCode = {}));
