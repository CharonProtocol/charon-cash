// Dashboard e2e in headless Chrome against the local stack (./run.sh):
// funds two fresh wallets (SOL airdrop + local test USDC), opens e2e.html
// on the dev server, and prints every operation's result.
//   bun scripts/e2e-app.mjs [--app http://localhost:5173]
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token"

const here = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d)
const app = arg("app", "http://localhost:5173")
const port = Number(arg("port", 8977))
const rpc = arg("rpc", "http://localhost:8899")
// CHROME, else the newest chrome-headless-shell under ~/.cache/charon-browsers
const chrome =
  process.env.CHROME ??
  (() => {
    const base = path.join(homedir(), ".cache/charon-browsers/chrome-headless-shell")
    const found = (existsSync(base) ? readdirSync(base) : [])
      .flatMap((v) => (statSync(path.join(base, v)).isDirectory() ? readdirSync(path.join(base, v)).map((d) => path.join(base, v, d, "chrome-headless-shell")) : []))
      .filter((f) => existsSync(f))
      .sort()
    if (!found.length) throw new Error(`no chrome-headless-shell under ${base} (set CHROME=...)`)
    return found.at(-1)
  })()

// local test USDC (run.sh): mint key in payroll/, authority = the CLI wallet
const conn = new Connection(rpc, "confirmed")
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.join(homedir(), ".config/solana/id.json"), "utf8"))))
const mint = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.join(here, "../../payroll/.local-usdc-mint.json"), "utf8")))).publicKey
const fund = async (kp) => {
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed")
  const ata = await getOrCreateAssociatedTokenAccount(conn, authority, mint, kp.publicKey)
  await mintTo(conn, authority, mint, ata.address, authority, 100_000_000n)
}
const a = Keypair.generate(), b = Keypair.generate()
await Promise.all([fund(a), fund(b)])
console.log(`wallets A ${a.publicKey.toBase58()} / B ${b.publicKey.toBase58()} funded (5 SOL + 100 USDC each)`)

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }
let resolveResult
const resultP = new Promise((r) => (resolveResult = r))
Bun.serve({
  port,
  async fetch(req) {
    const u = new URL(req.url)
    if (req.method === "OPTIONS") return new Response(null, { headers: cors })
    if (u.pathname === "/wallets") return Response.json({ a: [...a.secretKey], b: [...b.secretKey] }, { headers: cors })
    if (u.pathname === "/progress") {
      console.log(`  ${await req.text()}`)
      return new Response("ok", { headers: cors })
    }
    if (u.pathname === "/result") {
      resolveResult(JSON.parse(await req.text()))
      return new Response("ok", { headers: cors })
    }
    return new Response("404", { status: 404, headers: cors })
  },
})
const profile = mkdtempSync(path.join(tmpdir(), "charon-e2e-"))
const proc = spawn(chrome, ["--headless", "--disable-gpu", `--user-data-dir=${profile}`, `${app}/e2e.html?collector=http://localhost:${port}`], { stdio: "ignore" })
const timer = setTimeout(() => resolveResult({ error: "timeout after 15 min" }), 15 * 60_000)
const res = await resultP
clearTimeout(timer)
proc.kill()
if (res.error) {
  console.error(`e2e failed: ${res.error}`)
  process.exit(1)
}
const failed = res.steps.filter((s) => !s.ok)
console.log(`prover: ${res.prover?.mode} ${res.prover?.workers}w x${res.prover?.threads}t, avg ${res.prover?.avgMs} ms/proof, ${res.prover?.proves} proofs (isolated=${res.isolated}, ${res.cores} cores)`)
console.log(failed.length ? `FAILED ${failed.length}/${res.steps.length}` : `ALL ${res.steps.length} operations OK`)
process.exit(failed.length ? 1 : 0)
