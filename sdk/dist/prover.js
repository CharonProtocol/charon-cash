import { utils } from "ffjavascript";
import { CIRCUIT } from "./constants.js";
import { CharonProtocolError, CharonProtocolErrorCode } from "./error.js";
import { DEFAULT_CIRCUIT_BASE_URL, SDK_CIRCUIT_BASE_URL, loadCircuitArtifacts, } from "./circuit-artifacts.js";
import { createWasmProver } from "./prover-core.js";
import { compressedToSnarkjs } from "./groth16-decompress.js";
export class ProofGenError extends CharonProtocolError {
    constructor(message, options) {
        super(message, CharonProtocolErrorCode.PROOF_GENERATION_ERROR, {
            cause: options?.cause,
        });
        this.name = "ProofGenerationError";
        Object.setPrototypeOf(this, ProofGenError.prototype);
    }
}
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
function resolveOnPage(base) {
    // Resolve on the page so a relative base does not resolve against the worker script.
    return typeof location === "undefined" ? base : new URL(base, location.href).toString();
}
function circuitBaseUrl() {
    if (options.circuitBaseUrl)
        return resolveOnPage(options.circuitBaseUrl);
    // Browsers fetch the artifacts from the app-hosted static dir (raw same-origin
    // files — bundler-transformed module URLs mangle the binary); Node/Bun read
    // the package's own copies from disk.
    const base = typeof window !== "undefined" ? DEFAULT_CIRCUIT_BASE_URL : SDK_CIRCUIT_BASE_URL;
    return resolveOnPage(base);
}
function workerScriptUrl() {
    const base = options.proverBaseUrl;
    if (!base)
        return new URL("./prover-worker.js", import.meta.url).href;
    return new URL("prover-worker.js", resolveOnPage(base)).href;
}
function getWorker() {
    if (worker)
        return worker;
    const w = new Worker(workerScriptUrl(), { type: "module" });
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
        .then((artifacts) => createWasmProver(artifacts, { wasm: options.wasm, threads: options.threads }))
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
    console.warn(`charonprotocol: threaded prover failed to start, proving on one thread (${reason})`);
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
// ---------------------------------------------------------------------------
// snarkjs-era public API, unchanged signatures. The engine behind prove() is
// the wasm-arkworks prover above; the snarkjs wasm buffer only remains for
// API compatibility.
// ---------------------------------------------------------------------------
let wasmBuf = null;
let zkeyBuf = null;
/** Kept for API compatibility with snarkjs-era callers; the wasm engine loads its own artifacts. */
export function setCircuitBuffers(wasm, zkey) {
    wasmBuf = wasm;
    zkeyBuf = zkey;
}
export async function loadCircuit() {
    if (!zkeyBuf)
        zkeyBuf = new Uint8Array(await (await fetch(CIRCUIT.ZKEY_URL)).arrayBuffer());
    // The snarkjs witness-calc wasm is no longer used (the engine computes the
    // witness from the witness graph); return an empty buffer so callers that
    // hold a `circuit` object keep working unchanged.
    if (!wasmBuf)
        wasmBuf = new Uint8Array(0);
    return { wasm: wasmBuf, zkey: zkeyBuf };
}
// The wasm parser reads extDataHash little-endian (pad_be then from_bytes_le =
// byte-swap) while every other 32-byte value is big-endian, so pre-swap it;
// the wasm's internal swap then restores the true value as the circuit signal.
function swapBytes32(v) {
    const h = typeof v === "bigint" ? v : BigInt(v);
    let out = 0n;
    for (let i = 0; i < 32; i++)
        out = (out << 8n) | ((h >> BigInt(8 * i)) & 0xffn);
    return out;
}
// ffjavascript's stringifyBigInts turns buffers/bn into bigints, which
// JSON.stringify rejects — finish the walk to decimal strings like the
// bench-proven oracle path.
function bigintsToString(v) {
    if (typeof v === "bigint")
        return v.toString(10);
    if (Array.isArray(v))
        return v.map(bigintsToString);
    if (v && typeof v === "object") {
        const o = {};
        for (const [k, val] of Object.entries(v))
            o[k] = bigintsToString(val);
        return o;
    }
    return v;
}
function toProverJson(input) {
    const s = utils.stringifyBigInts(input);
    if (s.extDataHash !== undefined)
        s.extDataHash = swapBytes32(s.extDataHash);
    return JSON.stringify(bigintsToString(s));
}
/**
 * Generate a groth16 proof on this device. Same signature and return shape as
 * the snarkjs implementation it replaces — `{proof, publicSignals}` with
 * uncompressed pi_a/pi_b/pi_c — so the downstream proof pipeline is unchanged.
 * Engine: wasm-arkworks in a Web Worker (browser) or on this thread (Node,
 * Bun, tests); multi-threaded when the page is cross-origin isolated.
 */
export async function prove(input, _wasm, _zkey) {
    const json = toProverJson(input);
    try {
        let out;
        if (!useWorker()) {
            const p = await getInThreadProver();
            out = p.prover.prove(json);
        }
        else {
            await preloadProver();
            const r = await call({ type: "prove", input: json });
            if (r === undefined)
                throw new Error("prover returned no result");
            out = r;
        }
        // The wasm emits compressed points; decompress into the snarkjs shape
        // parseProofToBytesArray consumes. Self-checks the curve equation.
        return compressedToSnarkjs(JSON.parse(out));
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
