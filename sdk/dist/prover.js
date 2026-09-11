import { groth16 } from "snarkjs";
import { utils } from "ffjavascript";
import { CIRCUIT } from "./constants";
import { SilentPayError, SilentPayErrorCode } from "./error";
export class ProofGenError extends SilentPayError {
    constructor(message, options) {
        super(message, SilentPayErrorCode.PROOF_GENERATION_ERROR, {
            cause: options?.cause,
        });
        this.name = "ProofGenerationError";
        Object.setPrototypeOf(this, ProofGenError.prototype);
    }
}
let wasmBuf = null;
let zkeyBuf = null;
/** Inject pre-loaded circuit buffers (used by tests / non-browser runners). */
export function setCircuitBuffers(wasm, zkey) {
    wasmBuf = wasm;
    zkeyBuf = zkey;
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
    try {
        const { wasm, zkey } = await loadCircuit();
        return groth16.fullProve(utils.stringifyBigInts(input), wasm, zkey, undefined, { singleThread: true }, { singleThread: true });
    }
    catch (error) {
        throw new ProofGenError("Unable to generate Proof", { cause: error });
    }
}
/** Parse a groth16 proof into the byte layout the Pinocchio Proof struct expects. */
export function parseProofToBytesArray(proof) {
    const d = JSON.parse(JSON.stringify(proof));
    for (const i in d) {
        if (i === "pi_a" || i === "pi_c") {
            for (const j in d[i]) {
                d[i][j] = Array.from(utils.leInt2Buff(utils.unstringifyBigInts(d[i][j]), 32)).reverse();
            }
        }
        else if (i === "pi_b") {
            for (const j in d[i]) {
                for (const z in d[i][j]) {
                    d[i][j][z] = Array.from(utils.leInt2Buff(utils.unstringifyBigInts(d[i][j][z]), 32));
                }
            }
        }
    }
    return {
        proofA: [d.pi_a[0], d.pi_a[1]].flat(),
        proofB: [d.pi_b[0].flat().reverse(), d.pi_b[1].flat().reverse()].flat(),
        proofC: [d.pi_c[0], d.pi_c[1]].flat(),
    };
}
/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export function parseToBytesArray(publicSignals) {
    return JSON.parse(JSON.stringify(publicSignals)).map((s) => Array.from(utils.leInt2Buff(utils.unstringifyBigInts(s), 32)).reverse());
}
