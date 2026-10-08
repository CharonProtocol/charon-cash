import { utils } from "ffjavascript";
import { DEFAULT_CIRCUIT_BASE_URL, loadCircuitArtifacts, } from "./circuit-artifacts";
import { createWasmProver, } from "./prover-core";
let options = {};
let worker = null;
let workerReady = null;
let nextId = 1;
const pending = new Map();
let inThreadProver = null;
let threadsInUse = null;
/** Overrides prover settings. Drops any loaded prover so the next call reloads. */
export function configureProver(opts) {
    terminateProver();
    options = { ...opts };
}
/** Stops the worker and frees the parsed proving key. */
export function terminateProver() {
    worker?.terminate();
    worker = null;
    workerReady = null;
    inThreadProver = null;
    threadsInUse = null;
    for (const p of pending.values())
        p.reject(new Error("prover terminated"));
    pending.clear();
}
function useWorker() {
    if (options.inThread !== undefined)
        return !options.inThread;
    return typeof window !== "undefined" && typeof Worker !== "undefined";
}
function circuitBaseUrl() {
    const base = options.circuitBaseUrl ?? DEFAULT_CIRCUIT_BASE_URL;
    // Resolve on the page so a relative base does not resolve against the worker script.
    return typeof location === "undefined"
        ? base
        : new URL(base, location.href).toString();
}
function getWorker() {
    if (worker)
        return worker;
    const w = new Worker(new URL("./prover-worker.js", import.meta.url), {
        type: "module",
    });
    w.onmessage = (ev) => {
        const msg = ev.data;
        const p = pending.get(msg.id);
        if (!p)
            return;
        pending.delete(msg.id);
        if (msg.ok)
            p.resolve(msg.result);
        else
            p.reject(new Error(msg.error));
    };
    w.onerror = (ev) => {
        const err = new Error(`prover worker failed: ${ev.message || "unknown error"}`);
        for (const p of pending.values())
            p.reject(err);
        pending.clear();
        worker = null;
        workerReady = null;
    };
    worker = w;
    return w;
}
function call(req) {
    const id = nextId++;
    const w = getWorker();
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({
            ...req,
            id,
            circuitBaseUrl: circuitBaseUrl(),
            threads: options.threads,
        });
    });
}
function getInThreadProver() {
    inThreadProver ??= (options.loadArtifacts ?? (() => loadCircuitArtifacts(circuitBaseUrl())))()
        .then((artifacts) => createWasmProver(artifacts, {
        wasm: options.wasm,
        threads: options.threads,
    }))
        .then((loaded) => {
        threadsInUse = loaded.threads;
        if (loaded.threadError)
            warnThreadFallback(loaded.threadError);
        return loaded;
    })
        .catch((e) => {
        inThreadProver = null;
        throw e;
    });
    return inThreadProver;
}
function warnThreadFallback(reason) {
    console.warn(`privacy-cash: threaded prover failed to start, proving on one thread (${reason})`);
}
/**
 * Threads the loaded prover uses: more than 1 only with the threaded build on
 * a cross-origin isolated page. `null` until `preloadProver()` or `prove()` has loaded it.
 */
export function proverThreads() {
    return threadsInUse;
}
/**
 * Starts downloading, verifying and parsing the proving artifacts so the
 * first `prove()` does not pay for it. Safe to call repeatedly.
 */
export function preloadProver() {
    if (!useWorker())
        return getInThreadProver().then(() => undefined);
    workerReady ??= call({ type: "init" }).then((result) => {
        const info = JSON.parse(result ?? "{}");
        threadsInUse = info.threads ?? 1;
        if (info.threadError)
            warnThreadFallback(info.threadError);
    }, (e) => {
        workerReady = null;
        throw e;
    });
    return workerReady;
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
        if (v &&
            typeof v === "object" &&
            typeof v.eq !== "function") {
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
function parseProof(json) {
    const data = JSON.parse(json);
    const proofA = hexToBytes(data.proof_a);
    const proofB = hexToBytes(data.proof_b);
    const proofC = hexToBytes(data.proof_c);
    if (proofA.length !== 32 || proofB.length !== 64 || proofC.length !== 32) {
        throw new Error(`prover returned unexpected sizes ${proofA.length}/${proofB.length}/${proofC.length}`);
    }
    return { proofA, proofB, proofC, publicSignals: data.public_signals };
}
/**
 * Generates a Groth16 proof on this device (Web Worker in browsers).
 * Returns compressed 32/64/32 bytes and the 7 public signals. The witness,
 * including the spend key, is never sent over the network.
 */
export async function prove(input) {
    const json = JSON.stringify(jsonSafeCircuitInput(input));
    if (!useWorker()) {
        const p = await getInThreadProver();
        return parseProof(p.prover.prove(json));
    }
    await preloadProver();
    const out = await call({ type: "prove", input: json });
    if (out === undefined)
        throw new Error("prover returned no result");
    return parseProof(out);
}
/**
 * Parse public signals into 32-byte big-endian field-element byte arrays.
 *
 * `extDataHash` is already the little-endian reading of the SHA-256 digest
 * (see `circuit_inputs` in the prover crate). Reversing here only writes that
 * field element big-endian, which is the byte order the proof and the program
 * store. Do not pre-swap the hash before `prove()`.
 */
export function parseToBytesArray(publicSignals) {
    return JSON.parse(JSON.stringify(publicSignals)).map((s) => Array.from(utils.leInt2Buff(utils.unstringifyBigInts(s), 32)).reverse());
}
