import { utils } from "ffjavascript";

import { CIRCUIT } from "./constants.js";
import BN from "bn.js";
import { CharonProtocolError, CharonProtocolErrorCode } from "./error.js";
import {
  DEFAULT_CIRCUIT_BASE_URL,
  SDK_CIRCUIT_BASE_URL,
  loadCircuitArtifacts,
  type CircuitArtifacts,
} from "./circuit-artifacts.js";
import { createWasmProver, type LoadedProver, type ProverWasmSource } from "./prover-core.js";
import type { ProverRequest, ProverResponse } from "./prover-worker.js";
import { compressedToSnarkjs } from "./groth16-decompress.js";

export class ProofGenError extends CharonProtocolError {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, CharonProtocolErrorCode.PROOF_GENERATION_ERROR, {
      cause: options?.cause,
    });

    this.name = "ProofGenerationError";

    Object.setPrototypeOf(this, ProofGenError.prototype);
  }
}

export type CircuitParams = {
  root: string;
  inputNullifier: string[];
  outputCommitment: string[];
  publicAmount: string;
  extDataHash: Uint8Array<ArrayBufferLike>;
  inAmount: string[];
  inPrivateKey: BN[];
  inBlinding: string[];
  inPathIndices: number[];
  inPathElements: string[][];
  outAmount: string[];
  outBlinding: string[];
  outPubkey: BN[];
  mintAddress: string;
};

export interface ProofBytes {
  proofA: number[];
  proofB: number[];
  proofC: number[];
  root: number[];
  publicAmount: number[];
  extDataHash: number[];
  inputNullifiers: number[][];
  outputCommitments: number[][];
}

export interface Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

// ---------------------------------------------------------------------------
// wasm-arkworks prover engine (from v2_prover): a Web Worker owns the prover,
// the witness (spend keys included) never leaves the device, and the threaded
// wasm build runs when the page is cross-origin isolated (COOP+COEP), with a
// silent single-threaded fallback everywhere else.
// ---------------------------------------------------------------------------

export interface ProverOptions {
  /** Where `transaction2.zkey` and `transaction2.graph` are served. Browsers: the app-hosted `/circuit/` static dir. Node/Bun: the sdk's own `circuits/` on disk. */
  circuitBaseUrl?: string;
  /**
   * Base dir serving the prover worker and wasm modules as raw static files
   * (e.g. `/prover/` for the layout `scripts/sync-prover` copies into the
   * app's public/). The wasm-bindgen glue and rayon's self-spawn break when
   * they are bundled, so browsers should serve them un-transformed. Default:
   * the sdk's own build output (works when unbundled, e.g. Node or tests).
   */
  proverBaseUrl?: string;
  /**
   * Prove on the calling thread instead of a Web Worker. Defaults to true
   * when there is no `window`/`Worker` (Node, Bun, tests).
   */
  inThread?: boolean;
  /**
   * Max threads for the threaded wasm build. Used only on cross-origin
   * isolated pages; elsewhere the single-threaded build runs. `1` forces
   * single-threaded. Default: all cores.
   */
  threads?: number;
  /** In-thread only: supply the artifacts yourself (they are still hash-checked by the caller). */
  loadArtifacts?: () => Promise<CircuitArtifacts>;
  /** In-thread only: the single-threaded `privacy_cash_prover_bg.wasm` bytes or URL. */
  wasm?: ProverWasmSource;
}

let options: ProverOptions = {};
let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: string | undefined) => void; reject: (e: Error) => void }>();
let inThreadProver: Promise<LoadedProver> | null = null;
let threadsInUse: number | null = null;

/** Overrides prover settings. Drops any loaded prover so the next call reloads. */
export function configureProver(opts: ProverOptions): void {
  terminateProver();
  options = { ...opts };
}

/** Stops the worker and frees the parsed proving key. */
export function terminateProver(): void {
  worker?.terminate();
  worker = null;
  workerReady = null;
  inThreadProver = null;
  threadsInUse = null;
  for (const p of pending.values()) p.reject(new Error("prover terminated"));
  pending.clear();
}

function useWorker(): boolean {
  if (options.inThread !== undefined) return !options.inThread;
  return typeof window !== "undefined" && typeof Worker !== "undefined";
}

function resolveOnPage(base: string): string {
  // Resolve on the page so a relative base does not resolve against the worker script.
  return typeof location === "undefined" ? base : new URL(base, location.href).toString();
}

function circuitBaseUrl(): string {
  if (options.circuitBaseUrl) return resolveOnPage(options.circuitBaseUrl);
  // Browsers fetch the artifacts from the app-hosted static dir (raw same-origin
  // files — bundler-transformed module URLs mangle the binary); Node/Bun read
  // the package's own copies from disk.
  const base = typeof window !== "undefined" ? DEFAULT_CIRCUIT_BASE_URL : SDK_CIRCUIT_BASE_URL;
  return resolveOnPage(base);
}

function workerScriptUrl(): string {
  const base = options.proverBaseUrl;
  if (!base) return new URL("./prover-worker.js", import.meta.url).href;
  return new URL("prover-worker.js", resolveOnPage(base)).href;
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(workerScriptUrl(), { type: "module" });
  w.onmessage = (ev: MessageEvent<ProverResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  w.onerror = (ev) => {
    const err = new Error(`prover worker failed: ${ev.message || "unknown error"}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
    workerReady = null;
  };
  worker = w;
  return w;
}

function call(req: { type: "init" } | { type: "prove"; input: string }): Promise<string | undefined> {
  const id = nextId++;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({
      ...req,
      id,
      circuitBaseUrl: circuitBaseUrl(),
      threads: options.threads,
    } as ProverRequest);
  });
}

function getInThreadProver(): Promise<LoadedProver> {
  inThreadProver ??= (options.loadArtifacts ?? (() => loadCircuitArtifacts(circuitBaseUrl())))()
    .then((artifacts) => createWasmProver(artifacts, { wasm: options.wasm, threads: options.threads }))
    .then((loaded) => {
      threadsInUse = loaded.threads;
      if (loaded.threadError) warnThreadFallback(loaded.threadError);
      return loaded;
    })
    .catch((e) => {
      inThreadProver = null;
      throw e;
    });
  return inThreadProver;
}

function warnThreadFallback(reason: string): void {
  console.warn(`charonprotocol: threaded prover failed to start, proving on one thread (${reason})`);
}

/**
 * Threads the loaded prover uses: more than 1 only with the threaded build on
 * a cross-origin isolated page. `null` until `preloadProver()` or `prove()` has loaded it.
 */
export function proverThreads(): number | null {
  return threadsInUse;
}

/**
 * Starts downloading, verifying and parsing the proving artifacts so the
 * first `prove()` does not pay for it. Safe to call repeatedly.
 */
export function preloadProver(): Promise<void> {
  if (!useWorker()) return getInThreadProver().then(() => undefined);
  workerReady ??= call({ type: "init" }).then(
    (result) => {
      const info = JSON.parse(result ?? "{}") as { threads?: number; threadError?: string };
      threadsInUse = info.threads ?? 1;
      if (info.threadError) warnThreadFallback(info.threadError);
    },
    (e) => {
      workerReady = null;
      throw e;
    },
  );
  return workerReady;
}

// ---------------------------------------------------------------------------
// snarkjs-era public API, unchanged signatures. The engine behind prove() is
// the wasm-arkworks prover above; the snarkjs wasm buffer only remains for
// API compatibility.
// ---------------------------------------------------------------------------

let wasmBuf: Uint8Array | null = null;
let zkeyBuf: Uint8Array | null = null;

/** Kept for API compatibility with snarkjs-era callers; the wasm engine loads its own artifacts. */
export function setCircuitBuffers(wasm: Uint8Array, zkey: Uint8Array): void {
  wasmBuf = wasm;
  zkeyBuf = zkey;
}

export async function loadCircuit(): Promise<{
  wasm: Uint8Array;
  zkey: Uint8Array;
}> {
  if (!zkeyBuf)
    zkeyBuf = new Uint8Array(
      await (await fetch(CIRCUIT.ZKEY_URL)).arrayBuffer(),
    );
  // The snarkjs witness-calc wasm is no longer used (the engine computes the
  // witness from the witness graph); return an empty buffer so callers that
  // hold a `circuit` object keep working unchanged.
  if (!wasmBuf) wasmBuf = new Uint8Array(0);
  return { wasm: wasmBuf, zkey: zkeyBuf };
}

// The wasm parser reads extDataHash little-endian (pad_be then from_bytes_le =
// byte-swap) while every other 32-byte value is big-endian, so pre-swap it;
// the wasm's internal swap then restores the true value as the circuit signal.
function swapBytes32(v: unknown): bigint {
  const h = typeof v === "bigint" ? v : BigInt(v as string | number);
  let out = 0n;
  for (let i = 0; i < 32; i++) out = (out << 8n) | ((h >> BigInt(8 * i)) & 0xffn);
  return out;
}

// ffjavascript's stringifyBigInts turns buffers/bn into bigints, which
// JSON.stringify rejects — finish the walk to decimal strings like the
// bench-proven oracle path.
function bigintsToString(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString(10);
  if (Array.isArray(v)) return v.map(bigintsToString);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = bigintsToString(val);
    return o;
  }
  return v;
}

function toProverJson(input: Record<string, unknown>): string {
  const s = utils.stringifyBigInts(input) as Record<string, unknown>;
  if (s.extDataHash !== undefined) s.extDataHash = swapBytes32(s.extDataHash);
  return JSON.stringify(bigintsToString(s));
}

/**
 * Generate a groth16 proof on this device. Same signature and return shape as
 * the snarkjs implementation it replaces — `{proof, publicSignals}` with
 * uncompressed pi_a/pi_b/pi_c — so the downstream proof pipeline is unchanged.
 * Engine: wasm-arkworks in a Web Worker (browser) or on this thread (Node,
 * Bun, tests); multi-threaded when the page is cross-origin isolated.
 */
export async function prove(
  input: Record<string, unknown>,
  _wasm?: Uint8Array,
  _zkey?: Uint8Array,
): Promise<{
  proof: Proof;
  publicSignals: string[];
}> {
  const json = toProverJson(input);
  try {
    let out: string;
    if (!useWorker()) {
      const p = await getInThreadProver();
      out = p.prover.prove(json);
    } else {
      await preloadProver();
      const r = await call({ type: "prove", input: json });
      if (r === undefined) throw new Error("prover returned no result");
      out = r;
    }
    // The wasm emits compressed points; decompress into the snarkjs shape
    // parseProofToBytesArray consumes. Self-checks the curve equation.
    return compressedToSnarkjs(JSON.parse(out));
  } catch (error) {
    throw new ProofGenError("Unable to generate Proof", { cause: error });
  }
}

/** Parse a groth16 proof into the byte layout the Pinocchio Proof struct expects. */
export function parseProofToBytesArray(proof: Proof): {
  proofA: number[];
  proofB: number[];
  proofC: number[];
} {
  const d = JSON.parse(JSON.stringify(proof));
  for (const i in d) {
    if (i === "pi_a" || i === "pi_c") {
      for (const j in d[i]) {
        d[i][j] = Array.from(
          utils.leInt2Buff(utils.unstringifyBigInts(d[i][j]), 32),
        ).reverse();
      }
    } else if (i === "pi_b") {
      for (const j in d[i]) {
        for (const z in d[i][j]) {
          d[i][j][z] = Array.from(
            utils.leInt2Buff(utils.unstringifyBigInts(d[i][j][z]), 32),
          );
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
export function parseToBytesArray(publicSignals: string[]): number[][] {
  return JSON.parse(JSON.stringify(publicSignals)).map((s: string) =>
    Array.from(utils.leInt2Buff(utils.unstringifyBigInts(s), 32)).reverse(),
  );
}
