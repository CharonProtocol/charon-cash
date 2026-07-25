export interface OperatorResponse {
    signature: string;
    slot: number | null;
    status: string;
}
/** Error carrying the backend's machine-readable code (e.g. HTTP_401, INVALID_HEX). */
export declare class OperatorError extends Error {
    code: string;
    constructor(code: string, message: string);
}
export declare function setOperatorPassword(pwd: string | null): void;
export declare function getOperatorPassword(): string | null;
/** Verify a password against the backend. Resolves false on any failure. */
export declare function verifyOperator(password: string): Promise<boolean>;
export declare function operatorInitialize(): Promise<OperatorResponse>;
export declare function operatorInitializeSpl(mint: string, maxDepositAmount?: number): Promise<OperatorResponse>;
export declare function operatorUpdateConfig(cfg: {
    deposit_fee_rate?: number;
    withdrawal_fee_rate?: number;
    fee_error_margin?: number;
}): Promise<OperatorResponse>;
export declare function operatorUpdateDepositLimit(newLimit: number): Promise<OperatorResponse>;
export declare function operatorUpdateDepositLimitSpl(mint: string, newLimit: number): Promise<OperatorResponse>;
//# sourceMappingURL=admin.d.ts.map