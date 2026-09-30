// Comprehensive e2e on surfpool: multiple accounts do SOL deposit+withdraw,
// then SPL deposit+withdraw. Proves the client-sdk works for all interactions
// against our Pinocchio program. Run:  bun scripts/e2e-surfpool.mjs
import "./local-prover.mjs"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
  AddressLookupTableProgram, AddressLookupTableAccount,
} from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount,
  mintTo, getAssociatedTokenAddress, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token"
import nacl from "tweetnacl"
import BN from "bn.js"
import { WasmFactory } from "@lightprotocol/hasher.rs"

import {
  EncryptionService, Keypair as UtxoKeypair, Utxo, getExtDataHash, getMintAddressField,
  prove, parseToBytesArray,
  buildTransactIxData, deriveAccounts,
  FIELD_SIZE, MERKLE_TREE_DEPTH, WRAPPED_SOL_MINT,
  buildUnlockMessage,
} from "privacy-cash-sdk"

const PROGRAM = new PublicKey("6e5ioWVHAyuzfNSGAmJLfiGwKrmwr2GkqoDYWAhqvdjX")
const RPC = process.env.RPC ?? "http://localhost:8899"
const DEPTH = MERKLE_TREE_DEPTH
const ROOT_HISTORY_OFF = 848, NEXT_INDEX_OFF = 8, ROOT_INDEX_OFF = 12
const SIWS = { domain: "localhost", uri: "http://localhost", chainId: "localnet" }
const unlockMsg = (pk) => buildUnlockMessage({ address: pk.toBase58(), ...SIWS })
const be = (b) => { let r = 0n; for (const x of b) r = (r << 8n) + BigInt(x); return r }

class Mirror {
  constructor(wasm) {
    this.wasm = wasm; this.zeros = ["0"]
    for (let i = 1; i <= DEPTH; i++) this.zeros[i] = wasm.poseidonHashString([this.zeros[i - 1], this.zeros[i - 1]])
    this.layers = [[]]
  }
  insert(leaf) {
    const ix = this.layers[0].length; this.layers[0][ix] = leaf; let i = ix
    for (let lv = 1; lv <= DEPTH; lv++) {
      i >>= 1
      const l = this.layers[lv - 1][i * 2]
      const r = i * 2 + 1 < this.layers[lv - 1].length ? this.layers[lv - 1][i * 2 + 1] : this.zeros[lv - 1]
      ;(this.layers[lv] ??= [])[i] = this.wasm.poseidonHashString([l, r])
    }
  }
  indexOf(leaf) { return this.layers[0].indexOf(leaf) }
  path(index) {
    const els = []
    for (let lv = 0; lv < DEPTH; lv++) {
      const sib = index ^ 1
      els[lv] = sib < (this.layers[lv]?.length ?? 0) ? this.layers[lv][sib] : this.zeros[lv]
      index >>= 1
    }
    return els
  }
}

let conn, wasm, payer

async function fund(conn, kp, sol) {
  if ((await conn.getBalance(kp.publicKey)) < sol * LAMPORTS_PER_SOL) {
    const s = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL)
    await conn.confirmTransaction(s)
  }
}

function signFor(kp) {
  return {
    publicKey: kp.publicKey,
    signMessage: (m) => Promise.resolve(nacl.sign.detached(m, kp.secretKey)),
  }
}

async function sendIx(ix, signerKp) {
  const { blockhash } = await conn.getLatestBlockhash()
  const msg = new TransactionMessage({
    payerKey: signerKp.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix],
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg); tx.sign([signerKp])
  const sig = await sendWithRetry(conn, tx)
  const r = await conn.confirmTransaction(sig, "confirmed")
  if (r.value.err) {
    try { console.error((await conn.simulateTransaction(tx, undefined)).value.logs?.join("\n")) } catch {}
    throw new Error("tx reverted: " + JSON.stringify(r.value.err))
  }
  return sig
}

async function sendWithRetry(conn, tx, attempts = 6) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      // refresh blockhash each attempt
      return await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5, skipPreflight: true })
    } catch (e) {
      lastErr = e
      const msg = String(e?.message ?? e)
      if (/Failed to fetch accounts from remote|mainnet-beta|429|Too Many|timeout/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 800))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

// Send an ix via a freshly-created Address Lookup Table (needed when >~11 accounts).
async function sendWithAlt(ix, signerKp) {
  const addrs = [signerKp.publicKey, ComputeBudgetProgram.programId, ix.programId, ...ix.keys.map((k) => k.pubkey)]
  const uniq = [...new Set(addrs.map((a) => a.toBase58()))].map((s) => new PublicKey(s))
  const recentSlot = await conn.getSlot("confirmed")
  const [ltIx, ltAddr] = AddressLookupTableProgram.createLookupTable({ authority: signerKp.publicKey, payer: signerKp.publicKey, recentSlot })
  await sendIx(ltIx, signerKp)
  for (let i = 0; i < uniq.length; i += 18) {
    await sendIx(AddressLookupTableProgram.extendLookupTable({ lookupTable: ltAddr, authority: signerKp.publicKey, payer: signerKp.publicKey, addresses: uniq.slice(i, i + 18) }), signerKp)
  }
  // wait for the ALT to become usable (creation slot must age)
  const start = await conn.getSlot("confirmed")
  while ((await conn.getSlot("confirmed")) <= start + 1) await new Promise((r) => setTimeout(r, 400))
  const acct = await conn.getAccountInfo(ltAddr)
  const alt = new AddressLookupTableAccount({ key: ltAddr, state: AddressLookupTableAccount.deserialize(acct.data) })
  const { blockhash } = await conn.getLatestBlockhash()
  const msg = new TransactionMessage({ payerKey: signerKp.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix] }).compileToV0Message([alt])
  const tx = new VersionedTransaction(msg); tx.sign([signerKp])
  const sig = await sendWithRetry(conn, tx)
  const r = await conn.confirmTransaction(sig, "confirmed")
  if (r.value.err) {
    try { console.error((await conn.simulateTransaction(tx, [alt])).value.logs?.join("\n")) } catch {}
    throw new Error("tx reverted: " + JSON.stringify(r.value.err))
  }
  return sig
}

// generic transact (SOL or SPL)
async function transact({ signerKp, enc, extAmount, fee, inputs, outputs, inputPaths, rootBytes, treeAccount, isSpl, mint, recipient, feeRecipient, feeRecipientAta, recipientTokenAccount, signerTokenAccount }) {
  const utxoKp = new UtxoKeypair(enc.utxoPrivateKey, wasm)
  // rebind input/output Utxos to this signer's keypair if needed (handled by caller passing correct Utxos)
  const inputNullifiers = await Promise.all(inputs.map((x) => x.getNullifier()))
  const outputCommitments = outputs.map((x) => x.getCommitment())
  const ct1 = await enc.encryptUtxo(outputs[0]); const ct2 = await enc.encryptUtxo(outputs[1])
  const extDataHash = getExtDataHash({
    recipient: isSpl ? recipientTokenAccount : recipient,
    extAmount, encryptedOutput1: ct1, encryptedOutput2: ct2, fee,
    feeRecipient: isSpl ? feeRecipientAta : feeRecipient,
    mintAddress: isSpl ? mint : WRAPPED_SOL_MINT,
  })
  const publicAmount = extAmount.sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE)
  const { publicSignals, proofA, proofB, proofC } = await prove({
    root: be(rootBytes).toString(),
    inputNullifier: inputNullifiers, outputCommitment: outputCommitments,
    publicAmount: publicAmount.toString(), extDataHash,
    inAmount: inputs.map((x) => x.amount.toString(10)),
    inPrivateKey: inputs.map((x) => x.keypair.privkey),
    inBlinding: inputs.map((x) => x.blinding.toString(10)),
    inPathIndices: inputs.map((x) => x.index),
    inPathElements: inputPaths,
    outAmount: outputs.map((x) => x.amount.toString(10)),
    outBlinding: outputs.map((x) => x.blinding.toString(10)),
    outPubkey: outputs.map((x) => x.keypair.pubkey),
    mintAddress: getMintAddressField(isSpl ? mint : WRAPPED_SOL_MINT),
  })
  const pub = parseToBytesArray(publicSignals)
  const proofSubmit = {
    proofA, proofB, proofC,
    root: pub[0], publicAmount: pub[1], extDataHash: pub[2],
    inputNullifiers: [pub[3], pub[4]], outputCommitments: [pub[5], pub[6]],
  }
  const a = deriveAccounts(PROGRAM, Uint8Array.from(proofSubmit.inputNullifiers[0]), Uint8Array.from(proofSubmit.inputNullifiers[1]))
  const ixData = buildTransactIxData(isSpl, proofSubmit, extAmount, fee, ct1, ct2, a.bump0, a.bump1)
  let keys
  if (!isSpl) {
    keys = [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: a.nullifier0, isSigner: false, isWritable: true },
      { pubkey: a.nullifier1, isSigner: false, isWritable: true },
      { pubkey: a.nullifier2, isSigner: false, isWritable: false },
      { pubkey: a.nullifier3, isSigner: false, isWritable: false },
      { pubkey: deriveAccounts(PROGRAM, new Uint8Array(32), new Uint8Array(32)).treeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.globalConfig, isSigner: false, isWritable: false },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: signerKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]
  } else {
    keys = [
      { pubkey: treeAccount, isSigner: false, isWritable: true },            // 0 tree_account
      { pubkey: a.nullifier0, isSigner: false, isWritable: true },
      { pubkey: a.nullifier1, isSigner: false, isWritable: true },
      { pubkey: a.nullifier2, isSigner: false, isWritable: false },
      { pubkey: a.nullifier3, isSigner: false, isWritable: false },
      { pubkey: a.globalConfig, isSigner: false, isWritable: false },         // 5 global_config
      { pubkey: signerKp.publicKey, isSigner: true, isWritable: true },       // 6 signer
      { pubkey: mint, isSigner: false, isWritable: false },                   // 7 mint
      { pubkey: signerTokenAccount, isSigner: false, isWritable: true },      // 8 signer_token_account
      { pubkey: recipient, isSigner: false, isWritable: false },              // 9 _recipient (unused)
      { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },   // 10 recipient_token_account
      { pubkey: getAssociatedTokenAddressSync(mint, a.globalConfig, true), isSigner: false, isWritable: true }, // 11 tree_ata
      { pubkey: feeRecipientAta, isSigner: false, isWritable: true },         // 12 fee_recipient_ata
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },       // 13 token_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 14 ata_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },// 15 system_program
    ]
  }
  const ix = new TransactionInstruction({ programId: PROGRAM, keys, data: ixData })
  return isSpl ? sendWithAlt(ix, signerKp) : sendIx(ix, signerKp)
}

async function readRoot(treeAcct) { const a = await conn.getAccountInfo(treeAcct); const ri = a.data[ROOT_INDEX_OFF]; return a.data.subarray(ROOT_HISTORY_OFF + ri * 32, ROOT_HISTORY_OFF + ri * 32 + 32) }
async function readNext(treeAcct) { return (await conn.getAccountInfo(treeAcct)).data.readUInt32LE(NEXT_INDEX_OFF) }

async function initSolTree() {
  const [treeAccount, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)
  if (await conn.getAccountInfo(treeAccount)) return treeAccount
  const [treeToken, ttb] = PublicKey.findProgramAddressSync([Buffer.from("tree_token")], PROGRAM)
  const [globalCfg, gb] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  await sendIx(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: treeToken, isSigner: false, isWritable: true },
      { pubkey: globalCfg, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0, tb, ttb, gb]),
  }), payer)
  return treeAccount
}

async function initSplTree(mint) {
  const [treeAccount, tb] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree"), mint.toBytes()], PROGRAM)
  if (await conn.getAccountInfo(treeAccount)) return treeAccount
  const [globalCfg] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)
  const max = 1_000_000_000_000
  const data = Buffer.alloc(17); data[0] = 1; data.writeBigUInt64LE(BigInt(max), 1); data[9] = tb // +7 padding already zero
  await sendIx(new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: globalCfg, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  }), payer)
  return treeAccount
}

async function solFlow(kp, mirror, treeAccount, amountSol) {
  await fund(conn, kp, 0.5)
  const enc = new EncryptionService()
  enc.deriveFromSignature(nacl.sign.detached(new TextEncoder().encode(unlockMsg(kp.publicKey)), kp.secretKey))
  const utxoKp = new UtxoKeypair(enc.utxoPrivateKey, wasm)
  const D = Math.floor(amountSol * LAMPORTS_PER_SOL)
  const nextIdx = await readNext(treeAccount)
  const note = new Utxo({ wasm, amount: String(D), keypair: utxoKp, index: nextIdx, mintAddress: WRAPPED_SOL_MINT })
  const dummyOut = new Utxo({ wasm, amount: "0", keypair: utxoKp, index: nextIdx + 1, mintAddress: WRAPPED_SOL_MINT })
  console.log(`  [${kp.publicKey.toBase58().slice(0, 6)}] DEPOSIT ${D}`)
  const ds = await transact({
    signerKp: kp, enc, extAmount: new BN(D), fee: new BN(0),
    inputs: [new Utxo({ wasm, keypair: utxoKp }), new Utxo({ wasm, keypair: utxoKp })],
    outputs: [note, dummyOut],
    inputPaths: [new Array(DEPTH).fill("0"), new Array(DEPTH).fill("0")],
    rootBytes: await readRoot(treeAccount), treeAccount, isSpl: false,
    recipient: kp.publicKey, feeRecipient: kp.publicKey,
  })
  mirror.insert(note.getCommitment()); mirror.insert(dummyOut.getCommitment())
  console.log(`    sig ${ds.slice(0, 10)}…  next_index ${await readNext(treeAccount)}`)

  const gross = D, fee = Math.ceil((gross * 25) / 10000), recGets = gross - fee
  const noteIdx = mirror.indexOf(note.getCommitment())
  const before = await conn.getBalance(kp.publicKey)
  const wNext = await readNext(treeAccount)
  const wOut0 = new Utxo({ wasm, amount: "0", keypair: utxoKp, index: wNext, mintAddress: WRAPPED_SOL_MINT })
  const wOut1 = new Utxo({ wasm, amount: "0", keypair: utxoKp, index: wNext + 1, mintAddress: WRAPPED_SOL_MINT })
  const ws = await transact({
    signerKp: kp, enc, extAmount: new BN(recGets).neg(), fee: new BN(fee),
    inputs: [note, new Utxo({ wasm, keypair: utxoKp, amount: "0" })],
    outputs: [wOut0, wOut1],
    inputPaths: [mirror.path(noteIdx), new Array(DEPTH).fill("0")],
    rootBytes: await readRoot(treeAccount), treeAccount, isSpl: false,
    recipient: kp.publicKey, feeRecipient: kp.publicKey,
  })
  mirror.insert(wOut0.getCommitment()); mirror.insert(wOut1.getCommitment())
  const after = await conn.getBalance(kp.publicKey)
  console.log(`  [${kp.publicKey.toBase58().slice(0, 6)}] WITHDRAW sig ${ws.slice(0, 10)}…  recipient delta ${after - before}`)
}

async function splFlow(kp, mirror, mint, treeAccount, amount) {
  await fund(conn, kp, 0.5)
  const enc = new EncryptionService()
  enc.deriveFromSignature(nacl.sign.detached(new TextEncoder().encode(unlockMsg(kp.publicKey)), kp.secretKey))
  const utxoKp = new UtxoKeypair(enc.utxoPrivateKey, wasm)
  const mintStr = mint.toBase58()
  // token accounts
  const signerAta = (await getOrCreateAssociatedTokenAccount(conn, kp, mint, kp.publicKey)).address
  const recipientAta = signerAta // withdraw to self
  const feeAta = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey)).address
  const globalCfg = deriveAccounts(PROGRAM, new Uint8Array(32), new Uint8Array(32)).globalConfig
  const treeAta = getAssociatedTokenAddressSync(mint, globalCfg, true)
  // pre-create the tree's ATA so surfpool doesn't try to lazy-load it from mainnet
  if (!(await conn.getAccountInfo(treeAta))) {
    await sendIx(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, treeAta, globalCfg, mint), payer)
  }
  await mintTo(conn, kp, mint, signerAta, payer, amount * 2)
  const signerBalBefore = (await conn.getTokenAccountBalance(signerAta)).value.uiAmount

  const nextIdx = await readNext(treeAccount)
  const note = new Utxo({ wasm, amount: String(amount), keypair: utxoKp, index: nextIdx, mintAddress: mintStr })
  const dummyOut = new Utxo({ wasm, amount: "0", keypair: utxoKp, index: nextIdx + 1, mintAddress: mintStr })
  console.log(`  [${kp.publicKey.toBase58().slice(0, 6)}] DEPOSIT SPL ${amount} (mint ${mintStr.slice(0, 6)}…)`)
  const ds = await transact({
    signerKp: kp, enc, extAmount: new BN(amount), fee: new BN(0),
    inputs: [new Utxo({ wasm, keypair: utxoKp, mintAddress: mintStr }), new Utxo({ wasm, keypair: utxoKp, mintAddress: mintStr })],
    outputs: [note, dummyOut],
    inputPaths: [new Array(DEPTH).fill("0"), new Array(DEPTH).fill("0")],
    rootBytes: await readRoot(treeAccount), treeAccount, isSpl: true, mint,
    recipient: kp.publicKey, feeRecipient: payer.publicKey, feeRecipientAta: feeAta,
    recipientTokenAccount: recipientAta, signerTokenAccount: signerAta,
  })
  mirror.insert(note.getCommitment()); mirror.insert(dummyOut.getCommitment())
  console.log(`    sig ${ds.slice(0, 10)}…  next_index ${await readNext(treeAccount)}`)

  const gross = amount, fee = Math.ceil((gross * 25) / 10000), recGets = gross - fee
  const noteIdx = mirror.indexOf(note.getCommitment())
  const wNext = await readNext(treeAccount)
  const wOut0 = new Utxo({ wasm, amount: "0", keypair: utxoKp, index: wNext, mintAddress: mintStr })
  const wOut1 = new Utxo({ wasm, amount: "0", keypair: utxoKp, index: wNext + 1, mintAddress: mintStr })
  const ws = await transact({
    signerKp: kp, enc, extAmount: new BN(recGets).neg(), fee: new BN(fee),
    inputs: [note, new Utxo({ wasm, keypair: utxoKp, amount: "0", mintAddress: mintStr })],
    outputs: [wOut0, wOut1],
    inputPaths: [mirror.path(noteIdx), new Array(DEPTH).fill("0")],
    rootBytes: await readRoot(treeAccount), treeAccount, isSpl: true, mint,
    recipient: kp.publicKey, feeRecipient: payer.publicKey, feeRecipientAta: feeAta,
    recipientTokenAccount: recipientAta, signerTokenAccount: signerAta,
  })
  mirror.insert(wOut0.getCommitment()); mirror.insert(wOut1.getCommitment())
  const signerBalAfter = (await conn.getTokenAccountBalance(signerAta)).value.uiAmount
  console.log(`  [${kp.publicKey.toBase58().slice(0, 6)}] WITHDRAW SPL sig ${ws.slice(0, 10)}…  token bal ${signerBalBefore}→${signerBalAfter}`)
}

async function main() {
  conn = new Connection(RPC, "confirmed")
  wasm = await WasmFactory.getInstance()
  const idJson = process.env.ID_JSON ?? path.join(homedir(), ".config/solana/id.json")
  payer = Keypair.fromSecretKey(Buffer.from(JSON.parse(readFileSync(idJson, "utf8"))))
  console.log("payer:", payer.publicKey.toBase58())

  console.log("\n=== SOL: 2 accounts deposit+withdraw ===")
  const solTree = await initSolTree()
  const accs = [Keypair.generate(), Keypair.generate()]
  if ((await readNext(solTree)) > 0) {
    console.log("  (SOL tree already used in a prior run — SOL proven, skipping)")
  } else {
    const solMirror = new Mirror(wasm)
    for (const [i, kp] of accs.entries()) await solFlow(kp, solMirror, solTree, 0.1 + i * 0.05)
  }

  console.log("\n=== SPL: mint + deposit + withdraw ===")
  const mint = await createMint(conn, payer, payer.publicKey, null, 6)
  console.log("mint:", mint.toBase58())
  const splTree = await initSplTree(mint)
  const splMirror = new Mirror(wasm)
  await splFlow(accs[0], splMirror, mint, splTree, 1_000_000)

  console.log("\n✅ ALL PASSED: multi-account SOL + SPL deposit/withdraw on surfpool")
}

main().catch((e) => { console.error("e2e failed:", e); process.exit(1) })
