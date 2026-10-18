// Headless end-to-end of the dashboard's operations: the real adapter
// (lib/charon.ts) + the browser prover, two wallets, against the local stack.
// Driven by scripts/e2e-app.mjs; results POST to its collector. Dev-server
// only (e2e.html is not part of the build).
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";

import { browserProverInfo, ensureBrowserProver } from "../lib/browserProver";
import { CharonProtocol } from "../lib/charon";
import { SOL_POOL_MINT } from "../lib/payment";
import { SUPPORTED_SPL_MINTS } from "../hooks/usePaymentTransaction";

const q = new URLSearchParams(location.search);
const collector = q.get("collector") ?? "http://localhost:8977";
const out = document.getElementById("out")!;
const log = (s: string) => {
  out.textContent += `\n${s}`;
  void fetch(`${collector}/progress`, { method: "POST", body: s }).catch(() => {});
};

/** wallet popups per wallet: message prompts (sign-in, registry, backup link) */
const prompts = new Map<string, string[]>();
const owner = (kp: Keypair) => ({
  publicKey: kp.publicKey,
  signMessage: async (m: Uint8Array) => {
    const k = kp.publicKey.toBase58();
    prompts.set(k, [...(prompts.get(k) ?? []), new TextDecoder().decode(m).split("\n")[0].slice(0, 40)]);
    return nacl.sign.detached(m, kp.secretKey);
  },
  signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  },
});

const balance = async (c: CharonProtocol, mint: string) => {
  await c.syncUtxos();
  return BigInt(c.utxoByMint.get(mint)?.totalAmount.toString(10) ?? "0");
};

async function main() {
  const keys = (await (await fetch(`${collector}/wallets`)).json()) as { a: number[]; b: number[] };
  const a = Keypair.fromSecretKey(Uint8Array.from(keys.a));
  const b = Keypair.fromSecretKey(Uint8Array.from(keys.b));
  await ensureBrowserProver();
  const A = await CharonProtocol.generateClient({ owner: owner(a) });
  const B = await CharonProtocol.generateClient({ owner: owner(b) });
  const usdc = SUPPORTED_SPL_MINTS.usdc;
  const steps: Array<{ step: string; ok: boolean; ms: number; detail?: string }> = [];
  const step = async (name: string, run: () => Promise<unknown>, check: () => Promise<string | null>) => {
    const t = performance.now();
    try {
      await run();
      await new Promise((r) => setTimeout(r, 1500));
      const bad = await check();
      steps.push({ step: name, ok: !bad, ms: Math.round(performance.now() - t), detail: bad ?? undefined });
    } catch (e) {
      steps.push({ step: name, ok: false, ms: Math.round(performance.now() - t), detail: (e as Error).message });
    }
    log(`${steps.at(-1)!.ok ? "ok  " : "FAIL"} ${name} (${steps.at(-1)!.ms} ms)${steps.at(-1)!.detail ? " " + steps.at(-1)!.detail : ""}`);
  };
  const want = (c: CharonProtocol, mint: string, v: bigint) => async () => {
    const got = await balance(c, mint);
    return got === v ? null : `private balance ${got}, want ${v}`;
  };
  const A58 = a.publicKey.toBase58(), B58 = b.publicKey.toBase58();

  await step("SOL: send 0.3 to own private balance", () => A.sendSol(300_000_000, A58), want(A, SOL_POOL_MINT, 300_000_000n));
  await step("SOL: send 0.1 to B", () => A.sendSol(100_000_000, B58), want(B, SOL_POOL_MINT, 100_000_000n));
  await step("SOL: private transfer 0.05 to B", () => A.shieldedTransferSol(50_000_000, B58), want(B, SOL_POOL_MINT, 150_000_000n));
  await step("SOL: B withdraws 0.1 to wallet", () => B.withdrawSol(100_000_000), want(B, SOL_POOL_MINT, 50_000_000n));
  await step("USDC: send 30 to own private balance", () => A.sendSpl(30_000_000, A58, usdc), want(A, usdc, 30_000_000n));
  await step("USDC: send 10 to B", () => A.sendSpl(10_000_000, B58, usdc), want(B, usdc, 10_000_000n));
  await step("USDC: private transfer 5 to B", () => A.shieldedTransferSpl(5_000_000, usdc, B58), want(B, usdc, 15_000_000n));
  await step("USDC: B withdraws 10 to wallet", () => B.withdrawSpl(10_000_000, usdc), want(B, usdc, 5_000_000n));

  const firstVisit = { a: prompts.get(A58)?.length ?? 0, b: prompts.get(B58)?.length ?? 0 };
  log(`message prompts on first visit: A ${firstVisit.a} [${prompts.get(A58)?.join(" | ")}], B ${firstVisit.b}`);
  // reload: a fresh client for the same wallet in the same tab must not prompt
  const before = prompts.get(A58)?.length ?? 0;
  await step("reload: unlock again without new prompts", async () => {
    const again = await CharonProtocol.generateClient({ owner: owner(a) });
    await again.stopClient();
  }, async () => {
    const extra = (prompts.get(A58)?.length ?? 0) - before;
    return extra === 0 ? null : `${extra} new prompt(s): ${prompts.get(A58)?.slice(before).join(" | ")}`;
  });

  await fetch(`${collector}/result`, {
    method: "POST",
    body: JSON.stringify({ firstVisit, steps, prover: browserProverInfo(), isolated: globalThis.crossOriginIsolated, cores: navigator.hardwareConcurrency }),
  });
}

main().catch(async (e) => {
  const error = String((e as Error)?.stack ?? e);
  out.textContent += `\n${error}`;
  await fetch(`${collector}/result`, { method: "POST", body: JSON.stringify({ error }) }).catch(() => {});
});
