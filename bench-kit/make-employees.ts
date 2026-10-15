// Make N throwaway local-test employees, register their receive keys with the
// local backend (the same signed PUT the employee app does), and write the
// payroll CSV. Keys are generated here and never leave this machine; reruns
// reuse them. Amounts repeat 0.00105..0.00200 SOL in 0.00005 steps, the
// reference 100-row test (0.1525 SOL in total).
//
//   bun bench-kit/make-employees.ts <dir> [count=100] [backend=http://localhost:8080]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import { publishRecipientKeys, setBackendUrl } from "../sdk/src/index"

const req = createRequire(path.join(import.meta.dir, "../sdk/package.json"))
const { Keypair } = req("@solana/web3.js")
const nacl = req("tweetnacl")

const [dir, countArg = "100", backend = "http://localhost:8080"] = process.argv.slice(2)
if (!dir) throw new Error("usage: bun bench-kit/make-employees.ts <dir> [count] [backend]")
const count = Number(countArg)
mkdirSync(dir, { recursive: true })
setBackendUrl(backend)

const keysFile = path.join(dir, "employees-keys.json")
const saved: Array<{ i: number; wallet: string; secretKey: string }> = existsSync(keysFile)
  ? JSON.parse(readFileSync(keysFile, "utf8"))
  : []
const employees = Array.from({ length: count }, (_, i) =>
  saved[i] ? Keypair.fromSecretKey(Uint8Array.from(Buffer.from(saved[i].secretKey, "base64"))) : Keypair.generate(),
)
writeFileSync(
  keysFile,
  JSON.stringify(
    employees.map((kp: { publicKey: { toBase58(): string }; secretKey: Uint8Array }, i: number) => ({
      i: i + 1,
      wallet: kp.publicKey.toBase58(),
      secretKey: Buffer.from(kp.secretKey).toString("base64"),
    })),
  ),
  { mode: 0o600 },
)

const registry: Record<string, { note_pubkey: string; enc_pubkey: string }> = {}
for (const kp of employees) {
  const keys = await publishRecipientKeys({
    publicKey: kp.publicKey,
    signMessage: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
    signTransaction: async <T>(tx: T) => tx,
  })
  registry[kp.publicKey.toBase58()] = { note_pubkey: keys.notePubkey, enc_pubkey: keys.encPubkey }
}

// The app's "Local simnet" asks 127.0.0.1, this kit asks localhost: both must
// see every employee, or the browser shows them "not enrolled".
const wallets = employees.map((kp: { publicKey: { toBase58(): string } }) => kp.publicKey.toBase58())
for (const base of new Set([backend, backend.replace("://localhost", "://127.0.0.1")])) {
  let seen = 0
  for (let i = 0; i < wallets.length; i += 90) {
    const res = await fetch(`${base}/api/recipients/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallets: wallets.slice(i, i + 90) }),
    }).catch(() => null)
    const body = await res?.json().catch(() => null)
    seen += Array.isArray(body?.results) ? body.results.length : 0
  }
  if (seen !== wallets.length) {
    console.error(`✗ ${base} sees ${seen}/${wallets.length} test employees enrolled: another server answers there.`)
    console.error("  check: lsof -nP -iTCP:8080 -sTCP:LISTEN   (then stop it and re-run)")
    process.exit(1)
  }
}

// backend-fast saves registrations to the seed file run.sh loads; merge them
// (public keys only) here too, so they survive a restart on the shim backend.
const seedFile = path.join(import.meta.dir, "../payroll/.local-recipients.json")
const seed = existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, "utf8")) : {}
writeFileSync(seedFile, JSON.stringify({ ...seed, ...registry }, null, 1))

const amount = (i: number) => (0.00105 + 0.00005 * (i % 20)).toFixed(5)
const csv = ["address,amount,memo", ...employees.map((kp: { publicKey: { toBase58(): string } }, i: number) => `${kp.publicKey.toBase58()},${amount(i)},employee-${i + 1}`)]
const csvFile = path.join(dir, `employees-${count}.csv`)
writeFileSync(csvFile, csv.join("\n") + "\n")
console.log(`${count} test employees registered; csv ${csvFile}`)
