// import { WasmFactory, type LightWasm } from "@lightprotocol/hasher.rs"
// import {
//   createAssociatedTokenAccountIdempotentInstruction,
//   getAssociatedTokenAddressSync,
// } from "@solana/spl-token"
// import {
//   PublicKey,
//   TransactionInstruction,
//   VersionedTransaction,
// } from "@solana/web3.js"
// import BN from "bn.js"

// import {
//   envProgramId,
//   FIELD_SIZE,
//   MERKLE_TREE_DEPTH,
//   SIGN_MESSAGE,
//   SOL_TREE_KEY,
//   WRAPPED_SOL_MINT,
// } from "./constants"
// import {
//   EncryptionService,
//   Keypair,
//   Utxo,
//   getExtDataHash,
//   getMintAddressField,
// } from "./crypto"
// import {
//   bytesToHex,
//   fetchMerkleProof,
//   fetchRelayerInfo,
//   fetchBlockhash,
//   fetchTreeState,
//   fetchUtxoRange,
//   fieldToHex32,
//   isNullifierSpent,
//   submitTransaction,
//   relayWithdraw,
//   waitForLeafIndex,
//   type RelayerInfo,
// } from "./merkle"
// import {
//   clearNotes,
//   exportNotes,
//   getSyncOffset,
//   importNotes,
//   loadNotes,
//   markNoteSpent,
//   newNoteId,
//   purgeLegacyStorage,
//   readLegacyNotes,
//   saveNote,
//   setSyncOffset,
//   unspentNotes,
//   upsertNote,
//   markNoteSpentByIndex,
//   type Note,
// } from "./notes"
// import { pushEncryptedNotes, pullEncryptedNotes } from "./notestore"
// import { parseProofToBytesArray, parseToBytesArray, prove } from "./prover"
// import {
//   buildTransactSplTransaction,
//   buildTransactTransaction,
//   type ProofBytes,
// } from "./program"
// import {
//   ensureAlt,
//   envAltAddress,
//   splAltAddresses,
//   type AltSigner,
// } from "./alt"

// export interface Signer {
//   publicKey: PublicKey
//   signMessage: (message: Uint8Array) => Promise<Uint8Array>
//   signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
// }

// export interface DepositResult {
//   signature: string
//   amountLamports: number
//   leafIndex: number
//   nullifiers?: string[]
// }

// export interface WithdrawResult {
//   signature: string
//   recipientLamports: number
//   feeLamports: number
//   changeLamports: string
//   nullifiers?: string[]
// }

// export interface SyncResult {
//   scanned: number
//   added: number
//   spent: number
// }

// const DEPOSIT_FEE = 0
// const RANGE_PAGE = 2_000

// function toPubkey(value: PublicKey | string): PublicKey {
//   return value instanceof PublicKey ? value : new PublicKey(value)
// }

// export class PrivacyCashClient {
//   private signer: Signer
//   private wasm?: LightWasm
//   private enc?: EncryptionService
//   private utxoKeypair?: Keypair
//   private programId?: PublicKey
//   private info?: RelayerInfo
//   private unlocking: Promise<void> | null = null

//   constructor(signer: Signer, programId?: PublicKey) {
//     this.signer = signer
//     this.programId = programId ?? envProgramId() ?? undefined
//   }

//   get publicKey(): PublicKey {
//     return this.signer.publicKey
//   }

//   get feeRecipient(): PublicKey {
//     return new PublicKey(this.info!.feeRecipient)
//   }

//   async init(): Promise<void> {
//     if (!this.wasm) this.wasm = await WasmFactory.getInstance()
//     if (!this.programId || !this.info) {
//       this.info = await fetchRelayerInfo()
//       if (!this.programId) this.programId = new PublicKey(this.info.programId)
//     }
//   }

//   /** Prompt wallet to sign the constant message; derive the note keypair. */
//   async unlock(): Promise<void> {
//     await this.init()
//     if (this.utxoKeypair) return
//     if (!this.unlocking) {
//       this.unlocking = (async () => {
//         const sig = await this.signer.signMessage(
//           new TextEncoder().encode(SIGN_MESSAGE),
//         )
//         const enc = new EncryptionService()
//         enc.deriveFromSignature(sig)
//         this.enc = enc
//         this.utxoKeypair = new Keypair(enc.utxoPrivateKey, this.wasm!)
//         // One-time migration: move any legacy plaintext notes out of localStorage
//         // into the encrypted backend store, then purge them from disk so no
//         // spending secret lingers locally. No-op outside the browser.
//         for (const n of readLegacyNotes(this.publicKey)) upsertNote(this.publicKey, n)
//         purgeLegacyStorage(this.publicKey)
//         // Recover notes from the indexer scan (decrypted straight into memory).
//         await this.syncNotes(SOL_TREE_KEY).catch(() => {
//           /* unlock still succeeds if indexer is briefly down */
//         })
//         // Hydrate from the encrypted note blob in the backend (new device / cleared browser).
//         await pullEncryptedNotes(this.publicKey, this.enc!).catch(() => {
//           /* restore is best-effort */
//         })
//         // Persist the unified in-memory note set to the encrypted backend blob.
//         await this.persistNotes().catch(() => {
//           /* best-effort: indexer scan can still recover notes later */
//         })
//       })()
//     }
//     await this.unlocking
//   }

//   isUnlocked(): boolean {
//     return !!this.utxoKeypair
//   }

//   /** Push the local note set to the backend (encrypted blob; server can't read it). */
//   async backupNotes(): Promise<void> {
//     await this.unlock()
//     await pushEncryptedNotes(this.publicKey, this.enc!)
//   }

//   /** Pull + decrypt the encrypted note blob from the backend into the in-memory cache. */
//   async restoreNotes(): Promise<Note[]> {
//     await this.unlock()
//     return pullEncryptedNotes(this.publicKey, this.enc!)
//   }

//   /**
//    * Best-effort: encrypt the in-memory note set and PUT it to the backend. This
//    * is the single persistence path — call it after every note mutation. Failure
//    * is non-fatal because `syncNotes` can always rebuild notes from the indexer.
//    */
//   private async persistNotes(): Promise<void> {
//     if (!this.enc) return
//     await pushEncryptedNotes(this.publicKey, this.enc)
//   }

//   /** In-memory notes for the current session (decrypted; never persisted locally). */
//   getNotes(): Note[] {
//     return loadNotes(this.publicKey)
//   }

//   exportNotesString(): string {
//     return exportNotes(this.publicKey)
//   }

//   /** Import notes from JSON into the in-memory cache and persist to the backend. */
//   async importNotesJson(json: string, replace = false): Promise<number> {
//     await this.unlock()
//     const n = importNotes(this.publicKey, json, replace)
//     await this.persistNotes().catch(() => {})
//     return n
//   }

//   /** Clear all notes — wipes the in-memory cache and the encrypted backend blob. */
//   async clearAllNotes(): Promise<void> {
//     await this.unlock()
//     clearNotes(this.publicKey)
//     await this.persistNotes().catch(() => {})
//   }

//   /** Unlock + rescan + persist. Powers the UI "Load notes" action. */
//   async refreshNotes(): Promise<SyncResult> {
//     await this.unlock()
//     const r = await this.syncNotes(SOL_TREE_KEY).catch(() => ({
//       scanned: 0,
//       added: 0,
//       spent: 0,
//     }))
//     await this.persistNotes().catch(() => {})
//     return r
//   }

//   /**
//    * Scan encrypted outputs from the backend, decrypt ours, upsert notes,
//    * and mark spent via nullifier checks.
//    */
//   async syncNotes(treeKey: string, fromScratch = false): Promise<SyncResult> {
//     await this.unlock()
//     const enc = this.enc!
//     const wasm = this.wasm!
//     const wallet = this.publicKey

//     let start = fromScratch ? 0 : getSyncOffset(wallet, treeKey)
//     let scanned = 0
//     let added = 0
//     let spent = 0

//     while (true) {
//       const page = await fetchUtxoRange(treeKey, start, start + RANGE_PAGE)
//       for (const row of page.utxos) {
//         scanned++
//         let utxo: Utxo
//         try {
//           const bytes = Buffer.from(row.encryptedOutputHex, "hex")
//           utxo = await enc.decryptUtxo(bytes, wasm)
//         } catch {
//           continue // not ours / garbage
//         }
//         if (utxo.amount.isZero()) continue

//         // Prefer leaf index from the indexer (authoritative).
//         utxo.index = row.leafIndex

//         const nullifier = await utxo.getNullifier()
//         const spentOnChain = await isNullifierSpent(fieldToHex32(nullifier))
//         if (spentOnChain) {
//           markNoteSpentByIndex(wallet, utxo.mintAddress, utxo.index)
//           spent++
//           continue
//         }

//         const before = unspentNotes(wallet).some(
//           (n) => n.mintAddress === utxo.mintAddress && n.index === utxo.index,
//         )
//         upsertNote(wallet, {
//           id: newNoteId(),
//           amount: utxo.amount.toString(),
//           blinding: utxo.blinding.toString(),
//           index: utxo.index,
//           mintAddress: utxo.mintAddress,
//           spent: false,
//           createdAt: Date.now(),
//           depositTx: row.signature,
//         })
//         if (!before) added++
//       }

//       setSyncOffset(wallet, treeKey, page.end)
//       if (!page.hasMore) break
//       start = page.end
//     }

//     return { scanned, added, spent }
//   }

//   async depositSOL(amountLamports: number): Promise<DepositResult> {
//     await this.unlock()
//     const treeKey = SOL_TREE_KEY
//     const onChain = await fetchTreeState(treeKey)
//     const root = onChain.root
//     const nextLeafIndex = onChain.nextLeafIndex

//     const extAmount = new BN(amountLamports)
//     const fee = new BN(DEPOSIT_FEE)
//     const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0")

//     const inputs = [
//       new Utxo({ wasm: this.wasm!, keypair: this.utxoKeypair! }),
//       new Utxo({ wasm: this.wasm!, keypair: this.utxoKeypair! }),
//     ]
//     const outputs = [
//       new Utxo({
//         wasm: this.wasm!,
//         amount: extAmount.sub(fee).toString(),
//         keypair: this.utxoKeypair!,
//         index: nextLeafIndex,
//         mintAddress: WRAPPED_SOL_MINT,
//       }),
//       new Utxo({
//         wasm: this.wasm!,
//         amount: "0",
//         keypair: this.utxoKeypair!,
//         index: nextLeafIndex + 1,
//         mintAddress: WRAPPED_SOL_MINT,
//       }),
//     ]

//     const enc1 = await this.enc!.encryptUtxo(outputs[0])
//     const enc2 = await this.enc!.encryptUtxo(outputs[1])

//     const { signature, nullifiers } = await this.proveAndSend({
//       root,
//       inputs,
//       outputs,
//       encryptedOutput1: enc1,
//       encryptedOutput2: enc2,
//       inputPathElements: [dummyPath, dummyPath],
//       inputPathIndices: inputs.map((u) => u.index),
//       extAmount,
//       fee,
//       recipient: this.feeRecipient,
//       feeRecipientForHash: this.feeRecipient,
//       mintAddress: WRAPPED_SOL_MINT,
//       isSpl: false,
//     })

//     // Persist note immediately — deposit already settled; indexer wait is best-effort.
//     saveNote(this.publicKey, {
//       id: newNoteId(),
//       amount: outputs[0].amount.toString(),
//       blinding: outputs[0].blinding.toString(),
//       index: nextLeafIndex,
//       mintAddress: WRAPPED_SOL_MINT,
//       spent: false,
//       createdAt: Date.now(),
//       depositTx: signature,
//     })
//     await this.persistNotes().catch(() => {})

//     await this.waitForLeaves(treeKey, nextLeafIndex + 1)

//     return { signature, amountLamports, leafIndex: nextLeafIndex, nullifiers }
//   }

//   async withdrawSOL(
//     grossLamports: number,
//     recipient: PublicKey | string,
//     opts?: { relay?: boolean },
//   ): Promise<WithdrawResult> {
//     await this.unlock()
//     await this.syncNotes(SOL_TREE_KEY).catch(() => { })
//     return this.withdrawInternal({
//       treeKey: SOL_TREE_KEY,
//       mintAddress: WRAPPED_SOL_MINT,
//       grossLamports,
//       recipient: toPubkey(recipient),
//       isSpl: false,
//       relay: opts?.relay,
//     })
//   }

//   async depositSPL(
//     mint: PublicKey | string,
//     amountRaw: number | string,
//   ): Promise<DepositResult> {
//     await this.unlock()
//     const mintPk = toPubkey(mint)
//     const mintStr = mintPk.toBase58()
//     const treeKey = mintStr

//     const onChain = await fetchTreeState(treeKey)
//     const root = onChain.root
//     const nextLeafIndex = onChain.nextLeafIndex

//     const extAmount = new BN(amountRaw.toString())
//     const fee = new BN(DEPOSIT_FEE)
//     const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0")

//     const inputs = [
//       new Utxo({ wasm: this.wasm!, keypair: this.utxoKeypair!, mintAddress: mintStr }),
//       new Utxo({ wasm: this.wasm!, keypair: this.utxoKeypair!, mintAddress: mintStr }),
//     ]
//     const outputs = [
//       new Utxo({
//         wasm: this.wasm!,
//         amount: extAmount.sub(fee).toString(),
//         keypair: this.utxoKeypair!,
//         index: nextLeafIndex,
//         mintAddress: mintStr,
//       }),
//       new Utxo({
//         wasm: this.wasm!,
//         amount: "0",
//         keypair: this.utxoKeypair!,
//         index: nextLeafIndex + 1,
//         mintAddress: mintStr,
//       }),
//     ]

//     const enc1 = await this.enc!.encryptUtxo(outputs[0])
//     const enc2 = await this.enc!.encryptUtxo(outputs[1])

//     const signerAta = getAssociatedTokenAddressSync(mintPk, this.publicKey)
//     const feeAta = this.feeAta(mintPk)
//     // For deposits, on-chain hashes recipient_token_account — use fee ATA (fee=0).
//     const recipientAta = feeAta

//     const { signature, nullifiers } = await this.proveAndSend({
//       root,
//       inputs,
//       outputs,
//       encryptedOutput1: enc1,
//       encryptedOutput2: enc2,
//       inputPathElements: [dummyPath, dummyPath],
//       inputPathIndices: inputs.map((u) => u.index),
//       extAmount,
//       fee,
//       recipient: this.feeRecipient,
//       feeRecipientForHash: feeAta,
//       mintAddress: mintStr,
//       isSpl: true,
//       mint: mintPk,
//       signerTokenAccount: signerAta,
//       recipientTokenAccount: recipientAta,
//       feeRecipientAta: feeAta,
//     })

//     saveNote(this.publicKey, {
//       id: newNoteId(),
//       amount: outputs[0].amount.toString(),
//       blinding: outputs[0].blinding.toString(),
//       index: nextLeafIndex,
//       mintAddress: mintStr,
//       spent: false,
//       createdAt: Date.now(),
//       depositTx: signature,
//     })
//     await this.persistNotes().catch(() => {})

//     await this.waitForLeaves(treeKey, nextLeafIndex + 1)

//     return {
//       signature,
//       amountLamports: Number(amountRaw),
//       leafIndex: nextLeafIndex,
//       nullifiers,
//     }
//   }

//   async withdrawSPL(
//     mint: PublicKey | string,
//     grossRaw: number | string,
//     recipient: PublicKey | string,
//     opts?: { relay?: boolean },
//   ): Promise<WithdrawResult> {
//     await this.unlock()
//     const mintPk = toPubkey(mint)
//     const mintStr = mintPk.toBase58()
//     await this.syncNotes(mintStr).catch(() => { })
//     return this.withdrawInternal({
//       treeKey: mintStr,
//       mintAddress: mintStr,
//       grossLamports: Number(grossRaw),
//       recipient: toPubkey(recipient),
//       isSpl: true,
//       mint: mintPk,
//       relay: opts?.relay,
//     })
//   }

//   getPrivateBalanceSOL(): bigint {
//     return this.balanceForMint(WRAPPED_SOL_MINT)
//   }

//   getPrivateBalanceSPL(mint: PublicKey | string): bigint {
//     const m = mint instanceof PublicKey ? mint.toBase58() : mint
//     return this.balanceForMint(m)
//   }

//   /** Poll the indexer's next_leaf_index. Never throws — deposit already settled. */
//   private async waitForLeaves(treeKey: string, minLeafIndex: number): Promise<void> {
//     const deadline = Date.now() + 45_000
//     while (Date.now() < deadline) {
//       try {
//         const st = await fetchTreeState(treeKey)
//         if (st.nextLeafIndex > minLeafIndex) return
//       } catch {
//         /* keep polling */
//       }
//       await new Promise((r) => setTimeout(r, 750))
//     }
//   }

//   private balanceForMint(mintAddress: string): bigint {
//     return unspentNotes(this.publicKey)
//       .filter((n) => n.mintAddress === mintAddress)
//       .reduce((s, n) => s + BigInt(n.amount), 0n)
//   }

//   private feeAta(mint: PublicKey): PublicKey {
//     const hit = this.info!.supportedMints.find((m) => m.mint === mint.toBase58())
//     if (hit) return new PublicKey(hit.feeAta)
//     return getAssociatedTokenAddressSync(mint, this.feeRecipient, true)
//   }

//   /**
//    * Private transfer: spend a private note to pay another address. Mechanically a
//    * withdraw to `recipient` — your deposit stays unlinked (proven via ZK), and the
//    * recipient receives public SOL at their address. Honors the same { relay } option
//    * as withdraw (default true = gasless relayer-signed).
//    */
//   async transferSOL(
//     amountLamports: number,
//     recipient: PublicKey | string,
//     opts?: { relay?: boolean },
//   ): Promise<WithdrawResult> {
//     return this.withdrawSOL(amountLamports, recipient, opts)
//   }

//   /**
//    * Private SPL transfer: spend a private SPL note to pay another address (their
//    * ATA is created idempotently). Same mechanics/privacy as transferSOL.
//    */
//   async transferSPL(
//     mint: PublicKey | string,
//     amountRaw: number | string,
//     recipient: PublicKey | string,
//     opts?: { relay?: boolean },
//   ): Promise<WithdrawResult> {
//     return this.withdrawSPL(mint, amountRaw, recipient, opts)
//   }

//   /**
//    * Private send to a PUBLIC address (Mode A): deposit fresh from the user, then
//    * withdraw-to-recipient gaslessly via the relayer (relay=true). The user signs +
//    * pays the deposit; the relayer signs the withdraw. Recipient gets public SOL/SPL
//    * (amount − withdrawFee) at their address; the sender's deposit is unlinkable to
//    * it via ZK. (deposit can never be gasless — the signer is who puts funds in.)
//    */
//   async sendPrivateSOL(
//     amountLamports: number,
//     recipient: PublicKey | string,
//     opts?: { relay?: boolean },
//   ): Promise<WithdrawResult> {
//     await this.unlock()
//     const dep = await this.depositSOL(amountLamports)
//     await this.waitForNoteIndexed(SOL_TREE_KEY, dep.leafIndex)
//     return this.withdrawSOL(amountLamports, recipient, { relay: true, ...opts })
//   }

//   async sendPrivateSPL(
//     mint: PublicKey | string,
//     amountRaw: number | string,
//     recipient: PublicKey | string,
//     opts?: { relay?: boolean },
//   ): Promise<WithdrawResult> {
//     const mintStr = (mint instanceof PublicKey ? mint : new PublicKey(mint)).toBase58()
//     await this.unlock()
//     const dep = await this.depositSPL(mint, amountRaw)
//     await this.waitForNoteIndexed(mintStr, dep.leafIndex)
//     return this.withdrawSPL(mint, amountRaw, recipient, { relay: true, ...opts })
//   }

//   /** Poll until the indexer can serve a Merkle proof for `leafIndex` (mirror caught up). */
//   private async waitForNoteIndexed(treeKey: string, leafIndex: number, timeoutMs = 30_000): Promise<void> {
//     const deadline = Date.now() + timeoutMs
//     while (Date.now() < deadline) {
//       try {
//         await fetchMerkleProof(treeKey, leafIndex)
//         return
//       } catch {
//         await new Promise((r) => setTimeout(r, 1000))
//       }
//     }
//   }

//   private async withdrawInternal(args: {
//     treeKey: string
//     mintAddress: string
//     grossLamports: number
//     recipient: PublicKey
//     isSpl: boolean
//     mint?: PublicKey
//     /** default true: gasless relayer-signed withdraw; false = client-signed broadcast. */
//     relay?: boolean
//   }): Promise<WithdrawResult> {
//     const feeBps = this.info!.withdrawalFeeRateBps
//     const wasm = this.wasm!
//     const utxoKeypair = this.utxoKeypair!

//     const sorted = unspentNotes(this.publicKey)
//       .filter((n) => n.mintAddress === args.mintAddress)
//       .sort((a, b) => Number(b.amount) - Number(a.amount))
//     if (sorted.length === 0) throw new Error("no spendable notes")

//     let inputNotes = sorted.filter(
//       (n) => BigInt(n.amount) >= BigInt(args.grossLamports),
//     )
//     if (inputNotes.length === 0) {
//       const a = sorted[0]
//       const need = BigInt(args.grossLamports) - BigInt(a.amount)
//       const b = sorted.slice(1).find((n) => BigInt(n.amount) >= need)
//       if (!b && BigInt(a.amount) < BigInt(args.grossLamports)) {
//         throw new Error(
//           `insufficient private balance: have ${a.amount}, need ${args.grossLamports}`,
//         )
//       }
//       inputNotes = b ? [a, b] : [a]
//     } else {
//       inputNotes = [inputNotes[0]]
//     }

//     const realInputs = inputNotes.map(
//       (n) =>
//         new Utxo({
//           wasm,
//           amount: n.amount,
//           blinding: n.blinding,
//           keypair: utxoKeypair,
//           index: n.index,
//           mintAddress: args.mintAddress,
//         }),
//     )
//     const inputs =
//       realInputs.length === 2
//         ? realInputs
//         : [
//           realInputs[0],
//           new Utxo({
//             wasm,
//             keypair: utxoKeypair,
//             amount: "0",
//             mintAddress: args.mintAddress,
//           }),
//         ]

//     const totalInput = inputs.reduce((s, x) => s.add(x.amount), new BN(0))
//     const gross = new BN(args.grossLamports)
//     if (gross.gt(totalInput)) {
//       throw new Error(
//         `insufficient private balance: have ${totalInput.toString()}, need ${gross.toString()}`,
//       )
//     }
//     const fee = new BN(Math.ceil((gross.toNumber() * feeBps) / 10000))
//     const recipientGets = gross.sub(fee)
//     const extAmount = recipientGets.neg()
//     const change = totalInput.sub(gross)

//     const { root, nextLeafIndex } = await fetchTreeState(args.treeKey)

//     const inputPathElements: string[][] = []
//     for (const u of inputs) {
//       if (u.amount.gt(new BN(0))) {
//         inputPathElements.push(
//           (await fetchMerkleProof(args.treeKey, u.index)).pathElements,
//         )
//       } else {
//         inputPathElements.push(new Array(MERKLE_TREE_DEPTH).fill("0"))
//       }
//     }

//     const outputs = [
//       new Utxo({
//         wasm,
//         amount: change.toString(),
//         keypair: utxoKeypair,
//         index: nextLeafIndex,
//         mintAddress: args.mintAddress,
//       }),
//       new Utxo({
//         wasm,
//         amount: "0",
//         keypair: utxoKeypair,
//         index: nextLeafIndex + 1,
//         mintAddress: args.mintAddress,
//       }),
//     ]

//     const enc1 = await this.enc!.encryptUtxo(outputs[0])
//     const enc2 = await this.enc!.encryptUtxo(outputs[1])

//     const relay = args.relay !== false // default: gasless relayer-signed withdraw

//     let feeRecipientForHash: PublicKey = this.feeRecipient
//     if (args.isSpl && args.mint) feeRecipientForHash = this.feeAta(args.mint)

//     const commonProof = {
//       root,
//       inputs,
//       outputs,
//       encryptedOutput1: enc1,
//       encryptedOutput2: enc2,
//       inputPathElements,
//       inputPathIndices: inputs.map((u) => u.index),
//       extAmount,
//       fee,
//       feeRecipientForHash,
//       mintAddress: args.mintAddress,
//       isSpl: args.isSpl,
//     }

//     let signature: string
//     let nullifiers: string[]

//     if (relay) {
//       // Gasless: backend signs with RELAYER_KEYPAIR. Recipient = wallet (SOL) / recipient ATA (SPL).
//       let hashRecipient: PublicKey = args.recipient
//       let relayRecipient = args.recipient.toBase58()
//       let recipientOwner: string | undefined
//       let mintStr: string | undefined
//       if (args.isSpl && args.mint) {
//         const recipientAta = getAssociatedTokenAddressSync(args.mint, args.recipient)
//         hashRecipient = recipientAta
//         relayRecipient = recipientAta.toBase58()
//         recipientOwner = args.recipient.toBase58()
//         mintStr = args.mint.toBase58()
//       }
//       const r = await this.proveAndRelay({ ...commonProof, hashRecipient, relayRecipient, recipientOwner, mint: mintStr })
//       signature = r.signature
//       nullifiers = r.nullifiers
//     } else {
//       // Client-signed: wallet signs, backend broadcasts.
//       let splExtras:
//         | {
//           mint: PublicKey
//           signerTokenAccount: PublicKey
//           recipientTokenAccount: PublicKey
//           feeRecipientAta: PublicKey
//           preIxs?: TransactionInstruction[]
//         }
//         | undefined
//       if (args.isSpl && args.mint) {
//         const mint = args.mint
//         const recipientAta = getAssociatedTokenAddressSync(mint, args.recipient)
//         const signerAta = getAssociatedTokenAddressSync(mint, this.publicKey)
//         const feeAta = this.feeAta(mint)
//         splExtras = {
//           mint,
//           signerTokenAccount: signerAta,
//           recipientTokenAccount: recipientAta,
//           feeRecipientAta: feeAta,
//           preIxs: [
//             createAssociatedTokenAccountIdempotentInstruction(this.publicKey, recipientAta, args.recipient, mint),
//             createAssociatedTokenAccountIdempotentInstruction(this.publicKey, feeAta, this.feeRecipient, mint),
//           ],
//         }
//       }
//       const r = await this.proveAndSend({ ...commonProof, recipient: args.recipient, ...splExtras })
//       signature = r.signature
//       nullifiers = r.nullifiers
//     }

//     for (const n of inputNotes) markNoteSpent(this.publicKey, n.id, signature)
//     if (change.gt(new BN(0))) {
//       await waitForLeafIndex(args.treeKey, nextLeafIndex).catch(() => { })
//       saveNote(this.publicKey, {
//         id: newNoteId(),
//         amount: outputs[0].amount.toString(),
//         blinding: outputs[0].blinding.toString(),
//         index: nextLeafIndex,
//         mintAddress: args.mintAddress,
//         spent: false,
//         createdAt: Date.now(),
//         depositTx: signature,
//       })
//     }
//     await this.persistNotes().catch(() => {})

//     return {
//       signature,
//       recipientLamports: recipientGets.toNumber(),
//       feeLamports: fee.toNumber(),
//       changeLamports: change.toString(),
//       nullifiers,
//     }
//   }

//   /** Prove + POST to relayer (backend signs with RELAYER_KEYPAIR). No wallet tx. */
//   private async proveAndRelay(args: {
//     root: string
//     inputs: Utxo[]
//     outputs: Utxo[]
//     encryptedOutput1: Uint8Array
//     encryptedOutput2: Uint8Array
//     inputPathElements: string[][]
//     inputPathIndices: number[]
//     extAmount: BN
//     fee: BN
//     hashRecipient: PublicKey
//     feeRecipientForHash: PublicKey
//     mintAddress: string
//     isSpl: boolean
//     relayRecipient: string
//     recipientOwner?: string
//     mint?: string
//   }): Promise<{ signature: string; nullifiers: string[] }> {
//     const inputNullifiers = await Promise.all(
//       args.inputs.map((x) => x.getNullifier()),
//     )
//     const outputCommitments = args.outputs.map((x) => x.getCommitment())

//     const extDataHash = getExtDataHash({
//       recipient: args.hashRecipient,
//       extAmount: args.extAmount,
//       encryptedOutput1: args.encryptedOutput1,
//       encryptedOutput2: args.encryptedOutput2,
//       fee: args.fee,
//       feeRecipient: args.feeRecipientForHash,
//       mintAddress: args.mintAddress,
//     })

//     const publicAmount = args.extAmount
//       .sub(args.fee)
//       .add(FIELD_SIZE)
//       .mod(FIELD_SIZE)

//     const circuitInput = {
//       root: args.root,
//       inputNullifier: inputNullifiers,
//       outputCommitment: outputCommitments,
//       publicAmount: publicAmount.toString(),
//       extDataHash,
//       inAmount: args.inputs.map((x) => x.amount.toString(10)),
//       inPrivateKey: args.inputs.map((x) => x.keypair.privkey),
//       inBlinding: args.inputs.map((x) => x.blinding.toString(10)),
//       inPathIndices: args.inputPathIndices,
//       inPathElements: args.inputPathElements,
//       outAmount: args.outputs.map((x) => x.amount.toString(10)),
//       outBlinding: args.outputs.map((x) => x.blinding.toString(10)),
//       outPubkey: args.outputs.map((x) => x.keypair.pubkey),
//       mintAddress: getMintAddressField(args.mintAddress),
//     }

//     const { proof, publicSignals } = await prove(
//       circuitInput as unknown as Record<string, unknown>,
//     )
//     const proofBytes = parseProofToBytesArray(proof)
//     const pub = parseToBytesArray(publicSignals)
//     const nullifierHexes = [pub[3], pub[4]].map((b) => bytesToHex(b))

//     const signature = await relayWithdraw({
//       kind: args.isSpl ? "spl" : "sol",
//       proofA: proofBytes.proofA,
//       proofB: proofBytes.proofB,
//       proofC: proofBytes.proofC,
//       root: pub[0],
//       publicAmount: pub[1],
//       extDataHash: pub[2],
//       inputNullifiers: [pub[3], pub[4]],
//       outputCommitments: [pub[5], pub[6]],
//       extAmount: args.extAmount.toNumber(),
//       fee: args.fee.toNumber(),
//       encryptedOutput1: args.encryptedOutput1,
//       encryptedOutput2: args.encryptedOutput2,
//       recipient: args.relayRecipient,
//       mint: args.mint,
//       recipientOwner: args.recipientOwner,
//     })

//     return { signature, nullifiers: nullifierHexes }
//   }

//   private async proveAndSend(args: {
//     root: string
//     inputs: Utxo[]
//     outputs: Utxo[]
//     encryptedOutput1: Uint8Array
//     encryptedOutput2: Uint8Array
//     inputPathElements: string[][]
//     inputPathIndices: number[]
//     extAmount: BN
//     fee: BN
//     recipient: PublicKey
//     /** Pubkey bytes hashed into ext_data (wallet for SOL, ATA for SPL). */
//     feeRecipientForHash: PublicKey
//     mintAddress: string
//     isSpl: boolean
//     mint?: PublicKey
//     signerTokenAccount?: PublicKey
//     recipientTokenAccount?: PublicKey
//     feeRecipientAta?: PublicKey
//     preIxs?: TransactionInstruction[]
//   }): Promise<{ signature: string; nullifiers: string[] }> {
//     const inputNullifiers = await Promise.all(
//       args.inputs.map((x) => x.getNullifier()),
//     )
//     const outputCommitments = args.outputs.map((x) => x.getCommitment())

//     // SPL: program hashes recipient_token_account + fee_recipient_ata.
//     const hashRecipient = args.isSpl
//       ? args.recipientTokenAccount!
//       : args.recipient
//     const hashFeeRecipient = args.feeRecipientForHash

//     const extDataHash = getExtDataHash({
//       recipient: hashRecipient,
//       extAmount: args.extAmount,
//       encryptedOutput1: args.encryptedOutput1,
//       encryptedOutput2: args.encryptedOutput2,
//       fee: args.fee,
//       feeRecipient: hashFeeRecipient,
//       mintAddress: args.mintAddress,
//     })

//     const publicAmount = args.extAmount
//       .sub(args.fee)
//       .add(FIELD_SIZE)
//       .mod(FIELD_SIZE)

//     const circuitInput = {
//       root: args.root,
//       inputNullifier: inputNullifiers,
//       outputCommitment: outputCommitments,
//       publicAmount: publicAmount.toString(),
//       extDataHash,
//       inAmount: args.inputs.map((x) => x.amount.toString(10)),
//       inPrivateKey: args.inputs.map((x) => x.keypair.privkey),
//       inBlinding: args.inputs.map((x) => x.blinding.toString(10)),
//       inPathIndices: args.inputPathIndices,
//       inPathElements: args.inputPathElements,
//       outAmount: args.outputs.map((x) => x.amount.toString(10)),
//       outBlinding: args.outputs.map((x) => x.blinding.toString(10)),
//       outPubkey: args.outputs.map((x) => x.keypair.pubkey),
//       mintAddress: getMintAddressField(args.mintAddress),
//     }

//     const { proof, publicSignals } = await prove(
//       circuitInput as unknown as Record<string, unknown>,
//     )
//     const proofBytes = parseProofToBytesArray(proof)
//     const pub = parseToBytesArray(publicSignals)
//     const proofSubmit: ProofBytes = {
//       proofA: proofBytes.proofA,
//       proofB: proofBytes.proofB,
//       proofC: proofBytes.proofC,
//       root: pub[0],
//       publicAmount: pub[1],
//       extDataHash: pub[2],
//       inputNullifiers: [pub[3], pub[4]],
//       outputCommitments: [pub[5], pub[6]],
//     }

//     const nullifierHexes = [pub[3], pub[4]].map((b) => bytesToHex(b))

//     const { blockhash } = await fetchBlockhash()
//     let transaction: VersionedTransaction
//     if (args.isSpl) {
//       const mint = args.mint!
//       const alt = await ensureAlt({
//         signer: this.signer as AltSigner,
//         preferred: envAltAddress(),
//         addresses: [
//           ...splAltAddresses({
//             programId: this.programId!,
//             feeRecipient: this.feeRecipient,
//             mint,
//           }),
//           args.signerTokenAccount!,
//           args.recipientTokenAccount!,
//           args.feeRecipientAta!,
//           args.recipient,
//         ],
//       })
//       const built = await buildTransactSplTransaction({
//         blockhash,
//         programId: this.programId!,
//         signer: this.publicKey,
//         isSpl: true,
//         proof: proofSubmit,
//         extAmount: args.extAmount,
//         fee: args.fee,
//         encryptedOutput1: args.encryptedOutput1,
//         encryptedOutput2: args.encryptedOutput2,
//         recipient: args.recipient,
//         feeRecipient: this.feeRecipient,
//         mint,
//         signerTokenAccount: args.signerTokenAccount!,
//         recipientTokenAccount: args.recipientTokenAccount!,
//         feeRecipientAta: args.feeRecipientAta!,
//         preIxs: args.preIxs,
//         lookupTables: [alt],
//       })
//       transaction = built.transaction
//     } else {
//       const built = await buildTransactTransaction({
//         blockhash,
//         programId: this.programId!,
//         signer: this.publicKey,
//         isSpl: false,
//         proof: proofSubmit,
//         extAmount: args.extAmount,
//         fee: args.fee,
//         encryptedOutput1: args.encryptedOutput1,
//         encryptedOutput2: args.encryptedOutput2,
//         recipient: args.recipient,
//         feeRecipient: this.feeRecipient,
//       })
//       transaction = built.transaction
//     }

//     const signed = (await this.signer.signTransaction(
//       transaction,
//     )) as VersionedTransaction
//     const signature = await submitTransaction(signed.serialize())
//     return { signature, nullifiers: nullifierHexes }
//   }
// }
