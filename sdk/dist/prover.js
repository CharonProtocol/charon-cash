import { groth16 } from "snarkjs";
import { utils } from "ffjavascript";
import { CIRCUIT } from "./constants";
import { getBackendUrl } from "./merkle";
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
    try {
        const hosted = await proveHosted(input);
        return {
            proof: {
                pi_a: [],
                pi_b: [],
                pi_c: [],
                protocol: "groth16",
                curve: "bn128",
            },
            publicSignals: hosted.publicSignals,
            proofA: hosted.proofA,
            proofB: hosted.proofB,
            proofC: hosted.proofC,
        };
    }
    catch (err) {
        if (!wasmBuf || !zkeyBuf)
            throw err;
        const local = await proveSnarkjs(input);
        const parsed = parseProofToBytesArray(local.proof);
        return {
            ...local,
            proofA: parsed.proofA,
            proofB: parsed.proofB,
            proofC: parsed.proofC,
        };
    }
}
/** In-process snarkjs prove (tests / leftover path). */
export async function proveSnarkjs(input) {
    const { wasm, zkey } = await loadCircuit();
    return groth16.fullProve(utils.stringifyBigInts(input), wasm, zkey, undefined, { singleThread: true }, { singleThread: true });
}
/** Parse a groth16 proof into the compressed byte layout the Pinocchio Proof struct expects. */
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
    const proofA = [d.pi_a[0], d.pi_a[1]].flat();
    const proofB = [
        d.pi_b[0].flat().reverse(),
        d.pi_b[1].flat().reverse(),
    ].flat();
    const proofC = [d.pi_c[0], d.pi_c[1]].flat();
    return {
        proofA: compressG1(proofA),
        proofB: compressG2(proofB),
        proofC: compressG1(proofC),
    };
}
const FQ = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");
function beToBig(bytes) {
    let r = 0n;
    for (const b of bytes)
        r = (r << 8n) + BigInt(b);
    return r;
}
function compressG1(uncomp) {
    const x = uncomp.slice(0, 32);
    const y = beToBig(uncomp.slice(32, 64));
    if (y + y > FQ)
        x[0] |= 0x80;
    return x;
}
function compressG2(uncomp) {
    const xc1 = uncomp.slice(0, 32);
    const xc0 = uncomp.slice(32, 64);
    const yc1 = beToBig(uncomp.slice(64, 96));
    const yc0 = beToBig(uncomp.slice(96, 128));
    const out = xc0.concat(xc1);
    const mid = FQ / 2n;
    const yPositive = yc0 < mid ? true : yc0 > mid ? false : yc1 < mid;
    if (!yPositive)
        out[32] |= 0x80;
    return out;
}
/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export function parseToBytesArray(publicSignals) {
    return JSON.parse(JSON.stringify(publicSignals)).map((s) => Array.from(utils.leInt2Buff(utils.unstringifyBigInts(s), 32)).reverse());
}
