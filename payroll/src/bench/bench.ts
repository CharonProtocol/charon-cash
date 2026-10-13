// Headless end-to-end payroll bench: the real engine + browser prover pool
// against a local simnet + backend, driven by payroll/bench/run-bench.mjs.
// A burner keypair stands in for the wallet; results POST to the driver's
// collector. Dev-server only (bench.html is not part of the build).
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, VersionedTransaction } from "@solana/web3.js"
import nacl from "tweetnacl"
import { PrivacyCashClient, fetchRelayerInfo, totalBalance, WRAPPED_SOL_MINT } from "privacy-cash-sdk"

import { config } from "@/lib/config"
import { createEngine } from "@/lib/engine"
import { browserProverInfo, detectNativeProver, ensureBrowserProver, proverPlan, useNativeProver } from "@/lib/browserProver"

const q = new URLSearchParams(location.search)
const rows = Number(q.get("rows") ?? 20)
const lanes = Number(q.get("lanes") ?? 8)
const amount = q.get("amount") ?? "0.01"
const backend = q.get("backend") ?? "http://localhost:8080"
const rpc = q.get("rpc") ?? "http://localhost:8899"
const collector = q.get("collector") ?? "http://localhost:8978"
const forcedWorkers = Number(q.get("workers") ?? "") || undefined
const rawMode = q.get("mode")
const forcedMode = rawMode === "mt" || rawMode === "st" ? rawMode : undefined

const out = document.getElementById("out")!
const log = (s: string) => {
  out.textContent = s
  void fetch(`${collector}/progress`, { method: "POST", body: s }).catch(() => {})
}

async function main() {
  config.set({ backendUrl: backend, rpcUrl: rpc, fastRpcUrl: "" })
  config.apply()

  const recipients = (await (await fetch(`${collector}/recipients`)).json()) as string[]
  if (recipients.length < rows) throw new Error(`only ${recipients.length} registered recipients, need ${rows}`)

  const kp = Keypair.generate()
  const conn = new Connection(rpc, "confirmed")
  const lamports = Math.ceil((rows * Number(amount) + 2) * LAMPORTS_PER_SOL)
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, lamports), "confirmed")

  const signer = {
    publicKey: kp.publicKey,
    signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (tx instanceof VersionedTransaction) tx.sign([kp])
      else tx.partialSign(kp)
      return tx
    },
  }
  const client = new PrivacyCashClient(signer)
  await client.init()
  await client.unlock()
  const info = await fetchRelayerInfo()

  const cores = navigator.hardwareConcurrency || 4
  const plan = proverPlan(lanes, cores)
  const tProver = performance.now()
  // prover=native routes proofs to the loopback helper (prover-server)
  const helper = q.get("prover") === "native" ? await detectNativeProver() : null
  if (q.get("prover") === "native" && !helper) throw new Error("prover=native but no helper on 127.0.0.1:8790")
  const prover = helper
    ? useNativeProver(helper)
    : await ensureBrowserProver({ workers: forcedWorkers ?? plan.workers, mode: forcedMode ?? plan.mode })
  const proverStartMs = Math.round(performance.now() - tProver)
  log(`prover ${prover.mode} ${prover.workers}w ${prover.threads}t; paying ${rows} rows on ${lanes} lanes`)

  const entries = recipients.slice(0, rows).map((address) => ({ address, amountHuman: amount }))
  const engine = createEngine(client)
  const t0 = Date.now()
  const receipt = await engine.run(
    {
      fileHash: crypto.randomUUID(),
      asset: { kind: "sol" },
      entries,
      bps: info.withdrawalFeeRateBps,
      vaultRaw: totalBalance(client.publicKey, WRAPPED_SOL_MINT),
      mode: "shielded",
      minTransferFee: Number(info.minTransferFee) || 0,
      lanes,
    },
    (s) => {
      const done = s.rows.filter((r) => r.status === "confirmed" || r.status === "relayed").length
      const failed = s.rows.filter((r) => r.status === "failed").length
      log(`${s.phase} ${done}/${rows} failed=${failed} t=${((Date.now() - t0) / 1000).toFixed(1)}s`)
    },
  )
  const t1 = Date.now()

  const result = {
    at: new Date().toISOString(),
    params: { rows, lanes, amount, backend, cores, plan, forcedWorkers, forcedMode },
    prover: { ...browserProverInfo(), startMs: proverStartMs },
    wallMs: t1 - t0,
    fundingMs: receipt.fundedAt && receipt.startedAt ? receipt.fundedAt - receipt.startedAt : null,
    payoutMs: receipt.finishedAt && receipt.fundedAt ? receipt.finishedAt - receipt.fundedAt : null,
    splits: receipt.splits ?? 0,
    merges: receipt.merges ?? 0,
    sent: receipt.entries.filter((e) => e.status === "sent").length,
    failed: receipt.entries.filter((e) => e.status === "failed").length,
    confirming: receipt.entries.filter((e) => e.status === "confirming").length,
    errors: receipt.entries.filter((e) => e.error).map((e) => e.error),
    perRow: receipt.entries.map((e) => ({
      status: e.status,
      sig: e.txSignature,
      error: e.error,
      attempts: e.attempts,
      startedAt: e.startedAt,
      relayedAt: e.relayedAt,
      confirmedAt: e.confirmedAt,
      timing: e.timing,
    })),
  }
  await fetch(`${collector}/result`, { method: "POST", body: JSON.stringify(result) })
  log("done")
}

main().catch(async (e) => {
  const error = String((e as Error)?.stack ?? e)
  out.textContent = error
  await fetch(`${collector}/result`, { method: "POST", body: JSON.stringify({ error }) }).catch(() => {})
})
