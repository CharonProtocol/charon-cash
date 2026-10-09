import { groth16 } from "snarkjs";
import { utils } from "ffjavascript";
import { CIRCUIT } from "./constants";
let wasmBuf = null;
let zkeyBuf = null;
/** Inject pre-loaded circuit buffers (used by tests / non-browser runners). */
export function setCircuitBuffers(wasm, zkey) {
    wasmBuf = wasm;
    zkeyBuf = zkey;
}
let proverOverride = null;
export function setProver(fn) {
    proverOverride = fn;
}
async function loadCircuit() {
    if (!wasmBuf)
        wasmBuf = new Uint8Array(await (await fetch(CIRCUIT.WASM_URL)).arrayBuffer());
    if (!zkeyBuf)
        zkeyBuf = new Uint8Array(await (await fetch(CIRCUIT.ZKEY_URL)).arrayBuffer());
    return { wasm: wasmBuf, zkey: zkeyBuf };
}
/**
 * Generate a groth16 proof in-browser. wasm/zkey are fetched once as
 * ArrayBuffers and reused. Mirrors privacy-cash-sdk prove() (single-thread).
 */
export async function prove(input) {
    const stringified = utils.stringifyBigInts(input);
    if (proverOverride)
        return proverOverride(stringified);
    const { wasm, zkey } = await loadCircuit();
    return groth16.fullProve(stringified, wasm, zkey, undefined, { singleThread: true }, { singleThread: true });
}
/** BN254 base field p — the sign flag compares y against p − y. */
const FQ = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
function be32(v) {
    const out = new Array(32).fill(0);
    for (let i = 31; i >= 0 && v > 0n; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}
/** arkworks compressed G1: x BE, byte 0 sets 0x80 when y is the lex-larger root. */
function compressG1(x, y) {
    const out = be32(x);
    if (y * 2n > FQ)
        out[0] |= 0x80;
    return out;
}
/**
 * arkworks compressed G2: [x.c1, x.c0] BE, flag in byte 0. Fq2 lex order
 * compares c1 first, c0 on tie — ark's YIsNegative rule.
 */
function compressG2(x0, x1, y0, y1) {
    const out = [...be32(x1), ...be32(x0)];
    const n1 = (FQ - y1) % FQ;
    const largest = y1 !== n1 ? y1 > n1 : y0 * 2n > FQ;
    if (largest)
        out[0] |= 0x80;
    return out;
}
function hexToBytes(hex) {
    const h = hex.replace(/^0x/i, "");
    if (h.length % 2 !== 0)
        throw new Error("odd hex length");
    const out = new Array(h.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
}
/**
 * Parse a groth16 proof into the byte layout the Pinocchio Proof struct
 * expects — 32/64/32 compressed bytes on the wire. Accepts the snarkjs
 * decimal shape (compressed here with arkworks' SWFlags convention) or the
 * wasm prover's already-compressed hex, which passes through untouched.
 */
export function parseProofToBytesArray(proof) {
    if ("proof_a" in proof) {
        return {
            proofA: hexToBytes(proof.proof_a),
            proofB: hexToBytes(proof.proof_b),
            proofC: hexToBytes(proof.proof_c),
        };
    }
    const toBig = (v) => BigInt(String(v));
    return {
        proofA: compressG1(toBig(proof.pi_a[0]), toBig(proof.pi_a[1])),
        proofB: compressG2(toBig(proof.pi_b[0][0]), toBig(proof.pi_b[0][1]), toBig(proof.pi_b[1][0]), toBig(proof.pi_b[1][1])),
        proofC: compressG1(toBig(proof.pi_c[0]), toBig(proof.pi_c[1])),
    };
}
/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export function parseToBytesArray(publicSignals) {
    return JSON.parse(JSON.stringify(publicSignals)).map((s) => Array.from(utils.leInt2Buff(utils.unstringifyBigInts(s), 32)).reverse());
}
