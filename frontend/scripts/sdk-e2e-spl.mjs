// SPL e2e for the backend-only SDK on surfpool. Creates a fresh mint + a per-mint
// ALT (reusing create-alt's proven pattern), then drives PrivacyCashClient through
// SPL deposit + withdraw. Exercises fetchAlt (/api/relayer/alt) + ensureAlt + the
// ALT-compressed SPL tx, all via the backend. The Connection below is test-harness
// setup (mint/ATA/ALT) only — PrivacyCashClient makes NO rpc calls.
import { readFileSync } from "node:fs"
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey,
  SystemProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js"
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token"
import nacl from "tweetnacl"
import {
  PrivacyCashClient, setBackendUrl, setCircuitBuffers, fetchAlt, deriveAccounts,
} from "privacy-cash-sdk"

const _ls = new Map()
globalThis.localStorage = { getItem:(k)=>_ls.has(k)?_ls.get(k):null, setItem:(k,v)=>{_ls.set(k,String(v))}, removeItem:(k)=>{_ls.delete(k)}, clear:()=>_ls.clear() }

const RPC = "http://localhost:8899"
const BACKEND = "http://localhost:8080"
setBackendUrl(BACKEND)
setCircuitBuffers(new Uint8Array(readFileSync("public/circuit/transaction2.wasm")), new Uint8Array(readFileSync("public/circuit/transaction2.zkey")))

const env = Object.fromEntries(readFileSync(".env","utf8").split("\n").filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim()]}))
const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? env.VITE_PROGRAM_ID)
const conn = new Connection(RPC, "confirmed")
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json","utf8"))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dedupe = (keys) => { const s = new Set(); return keys.filter((k) => !s.has(k.toBase58()) && s.add(k.toBase58())) }

async function sendPayer(ixs) {
  const { blockhash } = await conn.getLatestBlockhash()
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs] }).compileToV0Message()
  const tx = new VersionedTransaction(msg); tx.sign([payer])
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 })
  await conn.confirmTransaction(sig, "confirmed")
}

// ---- test wallet ----
const kp = Keypair.generate()
console.log("test wallet:", kp.publicKey.toBase58())
await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 5e9), "confirmed")

// ---- mint + token accounts ----
const mint = await createMint(conn, payer, payer.publicKey, null, 6)
const mintStr = mint.toBase58()
console.log("mint:", mintStr)

const r = await fetch(BACKEND + "/api/relayer/initialize-spl", { method: "POST", headers: { "content-type": "application/json", "x-admin-password": process.env.ADMIN_PASSWORD ?? "local-dev" }, body: JSON.stringify({ mint: mintStr, max_deposit_amount: 1_000_000_000_000 }) })
console.log("initialize-spl:", (await r.json()).status ?? (await r.text()))
await sleep(1500)

const signerAta = (await getOrCreateAssociatedTokenAccount(conn, kp, mint, kp.publicKey)).address
const feeAta = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey)).address
const globalCfg = deriveAccounts(PROGRAM, new Uint8Array(32), new Uint8Array(32)).globalConfig
const treeAta = getAssociatedTokenAddressSync(mint, globalCfg, true)
if (!(await conn.getAccountInfo(treeAta))) await sendPayer([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, treeAta, globalCfg, mint)])
await mintTo(conn, payer, mint, signerAta, payer, 10_000_000)
console.log("minted 10 tokens; signer bal:", (await conn.getTokenAccountBalance(signerAta)).value.uiAmount)

// ---- per-mint ALT (reuse create-alt pattern) ----
const [splTree] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), mint.toBytes()], PROGRAM)
const altAddrs = dedupe([PROGRAM, globalCfg, splTree, treeAta, payer.publicKey, feeAta, mint, SystemProgram.programId,
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), ComputeBudgetProgram.programId])
const slot = await conn.getSlot("confirmed")
const [createIx, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot - 1 })
await sendPayer([createIx])
for (let i = 0; i < altAddrs.length; i += 20) await sendPayer([AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: altAddr, addresses: altAddrs.slice(i, i + 20) })])
await sleep(1500)
process.env.VITE_ALT_ADDRESS = altAddr.toBase58()
console.log("ALT:", altAddr.toBase58())

// ---- direct verification of the SDK's backend ALT read (fetchAlt) ----
const fetchedAlt = await fetchAlt(altAddr)
console.log("fetchAlt via /api/relayer/alt -> addresses:", fetchedAlt?.state.addresses.length, "(want 11)")
if (!fetchedAlt || fetchedAlt.state.addresses.length !== 11) throw new Error("fetchAlt did not return the expected 11-address ALT via the backend")

// ---- SDK SPL deposit + withdraw ----
const signer = { publicKey: kp.publicKey, signMessage: async (m) => nacl.sign.detached(new Uint8Array(m), kp.secretKey), signTransaction: async (t) => { t.sign([kp]); return t } }
const client = new PrivacyCashClient(signer, PROGRAM)
await client.unlock()

console.log("\n— DEPOSIT SPL 2 tokens —")
const dep = await client.depositSPL(mint, 2_000_000)
console.log("deposit:", dep.signature, "leaf:", dep.leafIndex)

for (let i = 0; i < 40; i++) { await client.syncNotes(mintStr).catch(() => {}); if (client.getPrivateBalanceSPL(mint) >= 2_000_000n) break; await sleep(1500) }
console.log("private SPL balance:", client.getPrivateBalanceSPL(mint).toString())

console.log("\n— WITHDRAW SPL 1 token to self —")
const wd = await client.withdrawSPL(mint, 1_000_000, kp.publicKey)
console.log("withdraw:", wd.signature, "recipient got:", wd.recipientLamports, "fee:", wd.feeLamports)

console.log("\n✅ SPL PASSED — ALT read via /api/relayer/alt + ensureAlt + ALT-compressed deposit/withdraw, all backend-only.")
