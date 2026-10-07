import { utils } from "ffjavascript";

import {
  DEFAULT_CIRCUIT_BASE_URL,
  loadCircuitArtifacts,
  type CircuitArtifacts,
} from "./circuit-artifacts";
import {
  createWasmProver,
  type LoadedProver,
  type ProverWasmSource,
} from "./prover-core";
import type { ProverRequest, ProverResponse } from "./prover-worker";
import BN from "bn.js";

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

export interface Groth16Proof {
  proofA: number[];
  proofB: number[];
  proofC: number[];
  publicSignals: string[];
}

export interface ProverOptions {
  /** Where `transaction2.zkey` and `transaction2.graph` are served. Default `/circuit/`. */
  circuitBaseUrl?: string;
  /**
   * Prove on the calling thread instead of a Web Worker. Defaults to true
   * when there is no `window`/`Worker` (Node, Bun, tests).
   */
  inThread?: boolean;
  /**
   * Max threads for the threaded wasm build. It is used only on cross-origin
   * isolated pages (COOP `same-origin` + COEP `require-corp`); elsewhere the
   * single-threaded build runs. `1` forces single-threaded. Default: all cores.
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
const pending = new Map<
  number,
  { resolve: (v: string | undefined) => void; reject: (e: Error) => void }
>();
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

function circuitBaseUrl(): string {
  const base = options.circuitBaseUrl ?? DEFAULT_CIRCUIT_BASE_URL;
  // Resolve on the page so a relative base does not resolve against the worker script.
  return typeof location === "undefined"
    ? base
    : new URL(base, location.href).toString();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./prover-worker.js", import.meta.url), {
    type: "module",
  });
  w.onmessage = (ev: MessageEvent<ProverResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  w.onerror = (ev) => {
    const err = new Error(
      `prover worker failed: ${ev.message || "unknown error"}`,
    );
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
    workerReady = null;
  };
  worker = w;
  return w;
}

function call(
  req: { type: "init" } | { type: "prove"; input: string },
): Promise<string | undefined> {
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
  inThreadProver ??= (
    options.loadArtifacts ?? (() => loadCircuitArtifacts(circuitBaseUrl()))
  )()
    .then((artifacts) =>
      createWasmProver(artifacts, {
        wasm: options.wasm,
        threads: options.threads,
      }),
    )
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
  console.warn(
    `privacy-cash: threaded prover failed to start, proving on one thread (${reason})`,
  );
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
      const info = JSON.parse(result ?? "{}") as {
        threads?: number;
        threadError?: string;
      };
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

function hexToBytes(hex: string): number[] {
  const h = hex.replace(/^0x/i, "");
  if (h.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Array<number>(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function jsonSafeCircuitInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const replaceBytes = (v: unknown): unknown => {
    if (v instanceof Uint8Array) {
      let hex = "0x";
      for (let i = 0; i < v.length; i++)
        hex += v[i]!.toString(16).padStart(2, "0");
      return hex;
    }
    if (Array.isArray(v)) return v.map(replaceBytes);
    // BN.js instances have `.eq`; leave them for stringifyBigInts.
    if (
      v &&
      typeof v === "object" &&
      typeof (v as { eq?: unknown }).eq !== "function"
    ) {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        o[k] = replaceBytes(val);
      }
      return o;
    }
    return v;
  };
  return utils.stringifyBigInts(replaceBytes(input)) as Record<string, unknown>;
}

function parseProof(json: string): Groth16Proof {
  const data = JSON.parse(json) as {
    proof_a: string;
    proof_b: string;
    proof_c: string;
    public_signals: string[];
  };
  const proofA = hexToBytes(data.proof_a);
  const proofB = hexToBytes(data.proof_b);
  const proofC = hexToBytes(data.proof_c);
  if (proofA.length !== 32 || proofB.length !== 64 || proofC.length !== 32) {
    throw new Error(
      `prover returned unexpected sizes ${proofA.length}/${proofB.length}/${proofC.length}`,
    );
  }
  return { proofA, proofB, proofC, publicSignals: data.public_signals };
}

/**
 * Generates a Groth16 proof on this device (Web Worker in browsers).
 * Returns compressed 32/64/32 bytes and the 7 public signals. The witness,
 * including the spend key, is never sent over the network.
 */
export async function prove(
  input: Record<string, unknown>,
): Promise<Groth16Proof> {
  const json = JSON.stringify(jsonSafeCircuitInput(input));
  if (!useWorker()) {
    const p = await getInThreadProver();
    return parseProof(p.prover.prove(json));
  }
  await preloadProver();
  const out = await call({ type: "prove", input: json });
  if (out === undefined) throw new Error("prover returned no result");
  return parseProof(out);
}

/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export function parseToBytesArray(publicSignals: string[]): number[][] {
  return JSON.parse(JSON.stringify(publicSignals)).map((s: string) =>
    Array.from(utils.leInt2Buff(utils.unstringifyBigInts(s), 32)).reverse(),
  );
}
