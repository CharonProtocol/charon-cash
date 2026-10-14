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

// The backend keeps API registrations in memory; also merge them (public keys
// only) into the seed file run.sh loads, so the employees survive a restart.
const seedFile = path.join(import.meta.dir, "../payroll/.local-recipients.json")
const seed = existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, "utf8")) : {}
writeFileSync(seedFile, JSON.stringify({ ...seed, ...registry }, null, 1))

const amount = (i: number) => (0.00105 + 0.00005 * (i % 20)).toFixed(5)
const csv = ["address,amount,memo", ...employees.map((kp: { publicKey: { toBase58(): string } }, i: number) => `${kp.publicKey.toBase58()},${amount(i)},employee-${i + 1}`)]
const csvFile = path.join(dir, `employees-${count}.csv`)
writeFileSync(csvFile, csv.join("\n") + "\n")
console.log(`${count} test employees registered; csv ${csvFile}`)
