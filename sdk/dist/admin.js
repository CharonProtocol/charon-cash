/**
 * Operator (admin) API.
 *
 * The mutating operator endpoints on the backend are guarded by a password
 * sent in the `x-admin-password` header and checked against the backend's
 * `ADMIN_PASSWORD` env var. This module owns that flow for the SDK:
 *
 *   - `verifyOperator(pwd)`  → POST /api/admin/verify (login)
 *   - `setOperatorPassword`  → stash the password for subsequent operator calls
 *   - `operatorInitialize…`  → the guarded operator actions
 *
 * Read-only data (merkle proofs, nullifiers, utxos, pool info, encrypted notes)
 * does NOT go through here — those routes are unauthenticated.
 */
import { backendUrl } from "./constants";
/** Error carrying the backend's machine-readable code (e.g. HTTP_401, INVALID_HEX). */
export class OperatorError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "OperatorError";
        this.code = code;
    }
}
let operatorPassword = null;
export function setOperatorPassword(pwd) {
    operatorPassword = pwd;
}
export function getOperatorPassword() {
    return operatorPassword;
}
function authHeaders() {
    const h = { "content-type": "application/json" };
    if (operatorPassword)
        h["x-admin-password"] = operatorPassword;
    return h;
}
/** Verify a password against the backend. Resolves false on any failure. */
export async function verifyOperator(password) {
    try {
        const res = await fetch(`${backendUrl()}/api/admin/verify`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-admin-password": password },
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
async function operatorPost(path, body) {
    let res;
    try {
        res = await fetch(`${backendUrl()}${path}`, {
            method: "POST",
            headers: authHeaders(),
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    }
    catch (e) {
        throw new OperatorError("NETWORK", `cannot reach backend: ${e.message}`);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        let code = `HTTP_${res.status}`;
        let message = text || `HTTP ${res.status}`;
        try {
            const j = JSON.parse(text);
            code = j?.error?.code ?? code;
            message = j?.error?.message ?? message;
        }
        catch {
            /* response was not JSON */
        }
        throw new OperatorError(code, message);
    }
    return (await res.json());
}
export function operatorInitialize() {
    return operatorPost("/api/relayer/initialize");
}
export function operatorInitializeSpl(mint, maxDepositAmount) {
    return operatorPost("/api/relayer/initialize-spl", {
        mint,
        max_deposit_amount: maxDepositAmount,
    });
}
export function operatorUpdateConfig(cfg) {
    return operatorPost("/api/relayer/update-config", cfg);
}
export function operatorUpdateDepositLimit(newLimit) {
    return operatorPost("/api/relayer/update-deposit-limit", { new_limit: newLimit });
}
export function operatorUpdateDepositLimitSpl(mint, newLimit) {
    return operatorPost("/api/relayer/update-deposit-limit-spl", {
        mint,
        new_limit: newLimit,
    });
}
