import { utils } from "ffjavascript";
import { getBackendUrl } from "./merkle";
function hexToBytes(hex) {
    const h = hex.replace(/^0x/i, "");
    if (h.length % 2 !== 0)
        throw new Error("odd hex length");
    const out = new Array(h.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}
function jsonSafeCircuitInput(input) {
    const replaceBytes = (v) => {
        if (v instanceof Uint8Array) {
            let hex = "0x";
            for (let i = 0; i < v.length; i++)
                hex += v[i].toString(16).padStart(2, "0");
            return hex;
        }
        if (Array.isArray(v))
            return v.map(replaceBytes);
        // BN.js instances have `.eq`; leave them for stringifyBigInts.
        if (v && typeof v === "object" && typeof v.eq !== "function") {
            const o = {};
            for (const [k, val] of Object.entries(v)) {
                o[k] = replaceBytes(val);
            }
            return o;
        }
        return v;
    };
    return utils.stringifyBigInts(replaceBytes(input));
}
async function proveHosted(input) {
    const res = await fetch(getBackendUrl() + "/api/prove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jsonSafeCircuitInput(input)),
    });
    const json = await res.json();
    const data = json.data ?? json;
    if (!res.ok || json.success === false) {
        throw new Error(json.error?.message ?? json.message ?? `prove failed (${res.status})`);
    }
    const proofA = hexToBytes(String(data.proof_a));
    const proofB = hexToBytes(String(data.proof_b));
    const proofC = hexToBytes(String(data.proof_c));
    if (proofA.length !== 32 || proofB.length !== 64 || proofC.length !== 32) {
        throw new Error(`hosted prove returned unexpected sizes ${proofA.length}/${proofB.length}/${proofC.length}`);
    }
    return {
        proofA,
        proofB,
        proofC,
        publicSignals: data.public_signals,
    };
}
/**
 * Generate a groth16 proof via POST /api/prove (ark-groth16).
 * Returns compressed 32/64/32 bytes. Does not log the witness.
 */
export async function prove(input) {
    return proveHosted(input);
}
/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export function parseToBytesArray(publicSignals) {
    return JSON.parse(JSON.stringify(publicSignals)).map((s) => Array.from(utils.leInt2Buff(utils.unstringifyBigInts(s), 32)).reverse());
}
