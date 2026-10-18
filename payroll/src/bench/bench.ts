// Headless end-to-end payroll bench: the real engine + browser prover pool
// against a local simnet + backend, driven by payroll/bench/run-bench.mjs.
// A burner keypair stands in for the wallet; results POST to the driver's
// collector. Dev-server only (bench.html is not part of the build).
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import nacl from "tweetnacl"
import { PrivacyCashClient, fetchRelayerInfo, totalBalance, WRAPPED_SOL_MINT } from "privacy-cash-sdk"

import { config } from "@/lib/config"
import { recommendLanes } from "@/lib/estimate"
import { createEngine } from "@/lib/engine"
import { browserProverInfo, detectNativeProver, ensureBrowserProver, proverPlan, useNativeProver } from "@/lib/browserProver"
import type { Asset } from "@/lib/types"

const q = new URLSearchParams(location.search)
const rows = Number(q.get("rows") ?? 20)
// no ?lanes: the app's own recommendation for this machine
const lanes = q.get("lanes") ? Number(q.get("lanes")) : recommendLanes(Number(q.get("rows") ?? 20), navigator.hardwareConcurrency || 4)
const amount = q.get("amount") ?? "0.01"
// ?asset=spl:<mint>:<decimals> pays from that token's pool (default SOL)
const assetArg = q.get("asset")?.split(":")
const asset: Asset =
  assetArg?.[0] === "spl" ? { kind: "spl", mint: assetArg[1]!, decimals: Number(assetArg[2] ?? 6) } : { kind: "sol" }
const backend = q.get("backend") ?? "http://localhost:8080"
const rpc = q.get("rpc") ?? "http://localhost:8899"
const collector = q.get("collector") ?? "http://localhost:8978"
const forcedWorkers = Number(q.get("workers") ?? "") || undefined
const rawMode = q.get("mode")
const forcedMode = rawMode === "mt" || rawMode === "st" ? rawMode : undefined

// ?claim=N: after the run, the first N paid employees withdraw their whole
// private balance like the employee portal does (keys from --claim-keys)
const claimN = Number(q.get("claim") ?? 0)

const out = document.getElementById("out")!
const log = (s: string) => {
  out.textContent = s
  void fetch(`${collector}/progress`, { method: "POST", body: s }).catch(() => {})
}

async function main() {
  config.set({ backendUrl: backend, rpcUrl: rpc, fastRpcUrl: "" })
  config.apply()

  const csv = (await (await fetch(`${collector}/entries`)).json()) as Array<{ address: string; amountHuman: string }> | null
  const recipients = csv ? csv.map((e) => e.address) : ((await (await fetch(`${collector}/recipients`)).json()) as string[])
  if (recipients.length < rows) throw new Error(`only ${recipients.length} registered recipients, need ${rows}`)

  // --wallet file: reuse one wallet across runs (its note history grows like a real employer's)
  const saved = (await (await fetch(`${collector}/wallet`)).json()) as number[] | null
  const kp = saved ? Keypair.fromSecretKey(Uint8Array.from(saved)) : Keypair.generate()
  const conn = new Connection(rpc, "confirmed")
  const lamports = Math.ceil((rows * Number(amount) + 2) * LAMPORTS_PER_SOL)
  // a pre-funded --wallet skips the airdrop (devnet airdrops are rate-limited)
  if ((await conn.getBalance(kp.publicKey)) < lamports) {
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, lamports), "confirmed")
  }

  const client = new PrivacyCashClient(signerOf(kp))
  await client.init()
  await client.unlock()
  if (asset.kind === "spl") await client.syncNotes(asset.mint)
  const info = await fetchRelayerInfo()

  const cores = navigator.hardwareConcurrency || 4
  const plan = proverPlan(lanes, cores)
  const tProver = performance.now()
  // prover=native routes proofs to the loopback helper (prover-server)
  const helper = q.get("prover") === "native" ? await detectNativeProver(q.get("proverToken")) : null
  if (q.get("prover") === "native" && !helper) throw new Error("prover=native but no paired helper on 127.0.0.1:8790 (pass proverToken)")
  const prover = helper
    ? useNativeProver(helper)
    : await ensureBrowserProver({ workers: forcedWorkers ?? plan.workers, mode: forcedMode ?? plan.mode })
  const proverStartMs = Math.round(performance.now() - tProver)
  log(`prover ${prover.mode} ${prover.workers}w ${prover.threads}t; paying ${rows} rows on ${lanes} lanes`)

  const entries = csv ? csv.slice(0, rows) : recipients.slice(0, rows).map((address) => ({ address, amountHuman: amount }))
  const engine = createEngine(client)
  const t0 = Date.now()
  const receipt = await engine.run(
    {
      fileHash: crypto.randomUUID(),
      asset,
      entries,
      bps: info.withdrawalFeeRateBps,
      vaultRaw: totalBalance(client.publicKey, asset.kind === "spl" ? asset.mint : WRAPPED_SOL_MINT),
      mode: "shielded",
      minTransferFee: Number(info.minTransferFee) || 0,
      lanes,
      tree: q.get("tree") === "1",
      exactLanes: q.get("exact") !== "0",
    },
    (s) => {
      const done = s.rows.filter((r) => r.status === "confirmed" || r.status === "relayed").length
      const failed = s.rows.filter((r) => r.status === "failed").length
      log(`${s.phase} ${done}/${rows} failed=${failed} t=${((Date.now() - t0) / 1000).toFixed(1)}s`)
    },
  )
  const t1 = Date.now()
  const claims = claimN > 0 ? await claimAll(conn, receipt.entries.filter((e) => e.status === "sent").map((e) => e.address)) : undefined

  const result = {
    at: new Date().toISOString(),
    params: { rows, lanes, amount, backend, cores, plan, forcedWorkers, forcedMode, tree: q.get("tree") === "1" },
    prover: { ...browserProverInfo(), startMs: proverStartMs },
    wallMs: t1 - t0,
    fundingMs: receipt.fundedAt && receipt.startedAt ? receipt.fundedAt - receipt.startedAt : null,
    payoutMs: receipt.finishedAt && receipt.fundedAt ? receipt.finishedAt - receipt.fundedAt : null,
    splits: receipt.splits ?? 0,
    fundingTiming: receipt.fundingTiming,
    merges: receipt.merges ?? 0,
    sent: receipt.entries.filter((e) => e.status === "sent").length,
    failed: receipt.entries.filter((e) => e.status === "failed").length,
    confirming: receipt.entries.filter((e) => e.status === "confirming").length,
    errors: receipt.entries.filter((e) => e.error).map((e) => e.error),
    claims,
    perRow: receipt.entries.map((e) => ({
      status: e.status,
      sig: e.txSignature,
      error: e.error,
      attempts: e.attempts,
      startedAt: e.startedAt,
      relayedAt: e.relayedAt,
      confirmedAt: e.confirmedAt,
      leaf: e.noteLeafIndex,
      commitment: e.noteCommitment,
      timing: e.timing,
    })),
  }
  await fetch(`${collector}/result`, { method: "POST", body: JSON.stringify(result) })
  log("done")
}

function signerOf(kp: Keypair) {
  return {
    publicKey: kp.publicKey,
    signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (tx instanceof VersionedTransaction) tx.sign([kp])
      else tx.partialSign(kp)
      return tx
    },
  }
}

/** Public balance of `owner` in the run's asset (raw units; 0 = no token account yet). */
async function publicBalance(conn: Connection, owner: PublicKey): Promise<bigint> {
  if (asset.kind === "sol") return BigInt(await conn.getBalance(owner))
  const ata = getAssociatedTokenAddressSync(new PublicKey(asset.mint), owner)
  return conn.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount)).catch(() => 0n)
}

/** Employee side: each paid employee scans, then withdraws everything (relayed, gasless). */
async function claimAll(conn: Connection, paid: string[]) {
  const keys = (await (await fetch(`${collector}/claimers`)).json()) as Record<string, string> | null
  if (!keys) throw new Error("?claim needs --claim-keys")
  const mint = asset.kind === "spl" ? asset.mint : WRAPPED_SOL_MINT
  const out = []
  for (const wallet of paid.filter((w) => keys[w]).slice(0, claimN)) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(atob(keys[wallet]!), (c) => c.charCodeAt(0)))
    const row: { wallet: string; note?: string; expected?: number; received?: string; sig?: string; ms?: number; error?: string } = { wallet }
    const t = Date.now()
    try {
      const c = new PrivacyCashClient(signerOf(kp))
      await c.init()
      await c.unlock()
      await c.syncNotes(asset.kind === "spl" ? asset.mint : "sol")
      const note = totalBalance(kp.publicKey, mint)
      row.note = note.toString()
      const before = await publicBalance(conn, kp.publicKey)
      const r =
        asset.kind === "spl"
          ? await c.withdrawSPL(asset.mint, Number(note), kp.publicKey, { relay: true })
          : await c.withdrawSOL(Number(note), kp.publicKey, { relay: true })
      row.sig = r.signature
      row.expected = r.recipientLamports
      // the relay answers on broadcast: wait for the funds to land
      let after = before
      for (let i = 0; i < 60 && after === before; i++) {
        await new Promise((res) => setTimeout(res, 500))
        after = await publicBalance(conn, kp.publicKey)
      }
      row.received = (after - before).toString()
      if (after - before !== BigInt(r.recipientLamports)) row.error = `received ${after - before}, expected ${r.recipientLamports}`
    } catch (e) {
      row.error = (e as Error).message
    }
    row.ms = Date.now() - t
    log(`claim ${out.length + 1}/${claimN}: ${row.error ?? `ok ${row.received}`}`)
    out.push(row)
  }
  return out
}

main().catch(async (e) => {
  const error = String((e as Error)?.stack ?? e)
  out.textContent = error
  await fetch(`${collector}/result`, { method: "POST", body: JSON.stringify({ error }) }).catch(() => {})
})
