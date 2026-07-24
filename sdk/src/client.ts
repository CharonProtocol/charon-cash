import { WasmFactory, type LightWasm } from "@lightprotocol/hasher.rs"
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token"
import BN from "bn.js"

import {
  envProgramId,
  FIELD_SIZE,
  MERKLE_TREE_DEPTH,
  SIGN_MESSAGE,
  SOL_TREE_KEY,
  WRAPPED_SOL_MINT,
} from "./constants"
import { EncryptionService, Keypair, Utxo, getExtDataHash, getMintAddressField } from "./crypto"
import {
  fetchMerkleProof,
  fetchRelayerInfo,
  fetchTreeState,
  type RelayerInfo,
} from "./merkle"
import { markNoteSpent, newNoteId, pruneStaleNotes, saveNote, unspentNotes } from "./notes"
import { parseProofToBytesArray, parseToBytesArray, prove } from "./prover"
import { buildTransactTransaction, buildTransactSplInstruction, type ProofBytes } from "./program"

export interface Signer {
  publicKey: PublicKey
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
}

export interface DepositResult {
  signature: string
  amountLamports: number
  leafIndex: number
}

export interface WithdrawResult {
  signature: string
  recipientLamports: number
  feeLamports: number
  changeLamports: string
}

const DEPOSIT_FEE = 0

export class PrivacyCashClient {
  private conn: Connection
  private signer: Signer
  private wasm?: LightWasm
  private enc?: EncryptionService
  private utxoKeypair?: Keypair
  private programId?: PublicKey
  private info?: RelayerInfo
  private unlocking: Promise<void> | null = null
  private _lastNullifiers: string[] = []

  /** Nullifier hashes (hex, no 0x) from the most recent deposit/withdraw — for the nullifier checker. */
  get lastNullifiers(): string[] {
    return this._lastNullifiers
  }

  constructor(conn: Connection, signer: Signer, programId?: PublicKey) {
    this.conn = conn
    this.signer = signer
    this.programId = programId ?? envProgramId() ?? undefined
  }

  get publicKey(): PublicKey {
    return this.signer.publicKey
  }

  get feeRecipient(): PublicKey {
    return new PublicKey(this.info!.feeRecipient)
  }

  async init(): Promise<void> {
    if (!this.wasm) this.wasm = await WasmFactory.getInstance()
    if (!this.programId || !this.info) {
      this.info = await fetchRelayerInfo()
      if (!this.programId) this.programId = new PublicKey(this.info.programId)
    }
    // Prune stale notes whose leaf index isn't in the current tree (e.g. after
    // a simnet reset). This keeps the displayed balance honest.
    try {
      const { nextLeafIndex } = await fetchTreeState(SOL_TREE_KEY)
      pruneStaleNotes(this.publicKey, nextLeafIndex)
    } catch {
      /* tree may not be initialized yet — skip */
    }
  }

  /** Prompt wallet to sign the constant message; derive the note keypair. */
  async unlock(): Promise<void> {
    await this.init()
    if (this.utxoKeypair) return
    if (!this.unlocking) {
      this.unlocking = (async () => {
        const sig = await this.signer.signMessage(
          new TextEncoder().encode(SIGN_MESSAGE),
        )
        const enc = new EncryptionService()
        enc.deriveFromSignature(sig)
        this.enc = enc
        this.utxoKeypair = new Keypair(enc.utxoPrivateKey, this.wasm!)
      })()
    }
    await this.unlocking
  }

  isUnlocked(): boolean {
    return !!this.utxoKeypair
  }

  async depositSOL(amountLamports: number): Promise<DepositResult> {
    await this.unlock()
    const { root, nextLeafIndex } = await fetchTreeState(SOL_TREE_KEY)

    const extAmount = new BN(amountLamports)
    const fee = new BN(DEPOSIT_FEE)
    const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0")

    const inputs = [
      new Utxo({ wasm: this.wasm!, keypair: this.utxoKeypair! }),
      new Utxo({ wasm: this.wasm!, keypair: this.utxoKeypair! }),
    ]
    const outputs = [
      new Utxo({
        wasm: this.wasm!,
        amount: extAmount.sub(fee).toString(),
        keypair: this.utxoKeypair!,
        index: nextLeafIndex,
        mintAddress: WRAPPED_SOL_MINT,
      }),
      new Utxo({
        wasm: this.wasm!,
        amount: "0",
        keypair: this.utxoKeypair!,
        index: nextLeafIndex + 1,
        mintAddress: WRAPPED_SOL_MINT,
      }),
    ]

    const signature = await this.proveAndSend({
      root,
      inputs,
      outputs,
      inputPathElements: [dummyPath, dummyPath],
      inputPathIndices: inputs.map((u) => u.index),
      extAmount,
      fee,
      recipient: this.feeRecipient,
      mintAddress: WRAPPED_SOL_MINT,
      isSpl: false,
    })

    saveNote(this.publicKey, {
      id: newNoteId(),
      amount: outputs[0].amount.toString(),
      blinding: outputs[0].blinding.toString(),
      index: nextLeafIndex,
      mintAddress: WRAPPED_SOL_MINT,
      spent: false,
      createdAt: Date.now(),
      depositTx: signature,
    })

    return { signature, amountLamports, leafIndex: nextLeafIndex }
  }

  async withdrawSOL(
    grossLamports: number,
    recipient: PublicKey,
  ): Promise<WithdrawResult> {
    await this.unlock()
    const feeBps = this.info!.withdrawalFeeRateBps
    const wasm = this.wasm!
    const utxoKeypair = this.utxoKeypair!

    // Fetch the current tree state FIRST, then drop any notes whose leaf index
    // isn't in this tree (stale leftovers from a prior simnet session — they can
    // never be spent because the leaf doesn't exist).
    const { root, nextLeafIndex } = await fetchTreeState(SOL_TREE_KEY)
    pruneStaleNotes(this.publicKey, nextLeafIndex)

    const sorted = unspentNotes(this.publicKey)
      .filter((n) => n.mintAddress === WRAPPED_SOL_MINT && n.index < nextLeafIndex)
      .sort((a, b) => Number(b.amount) - Number(a.amount))
    if (sorted.length === 0) throw new Error("no spendable notes in the current tree — deposit first")

    let inputNotes = sorted.filter((n) => BigInt(n.amount) >= BigInt(grossLamports))
    if (inputNotes.length === 0) {
      const a = sorted[0]
      const need = BigInt(grossLamports) - BigInt(a.amount)
      const b = sorted.slice(1).find((n) => BigInt(n.amount) >= need)
      inputNotes = b ? [a, b] : [a]
    }

    const realInputs = inputNotes.map(
      (n) =>
        new Utxo({
          wasm,
          amount: n.amount,
          blinding: n.blinding,
          keypair: utxoKeypair,
          index: n.index,
          mintAddress: WRAPPED_SOL_MINT,
        }),
    )
    const inputs =
      realInputs.length === 2
        ? realInputs
        : [realInputs[0], new Utxo({ wasm, keypair: utxoKeypair, amount: "0" })]

    const totalInput = inputs.reduce((s, x) => s.add(x.amount), new BN(0))
    const gross = BN.min(new BN(grossLamports), totalInput) // partial if short
    const fee = new BN(Math.ceil((gross.toNumber() * feeBps) / 10000))
    const recipientGets = gross.sub(fee)
    const extAmount = recipientGets.neg()
    const change = totalInput.sub(gross)

    const inputPathElements: string[][] = []
    for (const u of inputs) {
      if (u.amount.gt(new BN(0))) {
        inputPathElements.push((await fetchMerkleProof(SOL_TREE_KEY, u.index)).pathElements)
      } else {
        inputPathElements.push(new Array(MERKLE_TREE_DEPTH).fill("0"))
      }
    }

    const outputs = [
      new Utxo({
        wasm,
        amount: change.toString(),
        keypair: utxoKeypair,
        index: nextLeafIndex,
        mintAddress: WRAPPED_SOL_MINT,
      }),
      new Utxo({
        wasm,
        amount: "0",
        keypair: utxoKeypair,
        index: nextLeafIndex + 1,
        mintAddress: WRAPPED_SOL_MINT,
      }),
    ]

    const signature = await this.proveAndSend({
      root,
      inputs,
      outputs,
      inputPathElements,
      inputPathIndices: inputs.map((u) => u.index),
      extAmount,
      fee,
      recipient,
      mintAddress: WRAPPED_SOL_MINT,
      isSpl: false,
    })

    for (const n of inputNotes) markNoteSpent(this.publicKey, n.id, signature)
    if (change.gt(new BN(0))) {
      saveNote(this.publicKey, {
        id: newNoteId(),
        amount: outputs[0].amount.toString(),
        blinding: outputs[0].blinding.toString(),
        index: nextLeafIndex,
        mintAddress: WRAPPED_SOL_MINT,
        spent: false,
        createdAt: Date.now(),
        depositTx: signature,
      })
    }

    return {
      signature,
      recipientLamports: recipientGets.toNumber(),
      feeLamports: fee.toNumber(),
      changeLamports: change.toString(),
    }
  }

  private async proveAndSend(args: {
    root: string
    inputs: Utxo[]
    outputs: Utxo[]
    inputPathElements: string[][]
    inputPathIndices: number[]
    extAmount: BN
    fee: BN
    recipient: PublicKey
    mintAddress: string
    isSpl: boolean
  }): Promise<string> {
    const enc = this.enc!

    const inputNullifiers = await Promise.all(args.inputs.map((x) => x.getNullifier()))
    const outputCommitments = args.outputs.map((x) => x.getCommitment())

    const encryptedOutput1 = await enc.encryptUtxo(args.outputs[0])
    const encryptedOutput2 = await enc.encryptUtxo(args.outputs[1])

    const extDataHash = getExtDataHash({
      recipient: args.recipient,
      extAmount: args.extAmount,
      encryptedOutput1: encryptedOutput1 as unknown as Uint8Array,
      encryptedOutput2: encryptedOutput2 as unknown as Uint8Array,
      fee: args.fee,
      feeRecipient: this.feeRecipient,
      mintAddress: args.mintAddress,
    })

    const publicAmount = args.extAmount.sub(args.fee).add(FIELD_SIZE).mod(FIELD_SIZE)

    const circuitInput = {
      root: args.root,
      inputNullifier: inputNullifiers,
      outputCommitment: outputCommitments,
      publicAmount: publicAmount.toString(),
      extDataHash,
      inAmount: args.inputs.map((x) => x.amount.toString(10)),
      inPrivateKey: args.inputs.map((x) => x.keypair.privkey),
      inBlinding: args.inputs.map((x) => x.blinding.toString(10)),
      inPathIndices: args.inputPathIndices,
      inPathElements: args.inputPathElements,
      outAmount: args.outputs.map((x) => x.amount.toString(10)),
      outBlinding: args.outputs.map((x) => x.blinding.toString(10)),
      outPubkey: args.outputs.map((x) => x.keypair.pubkey),
      mintAddress: getMintAddressField(args.mintAddress),
    }

    const { proof, publicSignals } = await prove(
      circuitInput as unknown as Record<string, unknown>,
    )
    const proofBytes = parseProofToBytesArray(proof)
    const pub = parseToBytesArray(publicSignals)
    // capture nullifier hashes (hex) so the UI can display them for the nullifier checker
    this._lastNullifiers = [pub[3], pub[4]].map((n) =>
      Array.from(n).map((b: number) => b.toString(16).padStart(2, "0")).join(""),
    )
    const proofSubmit: ProofBytes = {
      proofA: proofBytes.proofA,
      proofB: proofBytes.proofB,
      proofC: proofBytes.proofC,
      root: pub[0],
      publicAmount: pub[1],
      extDataHash: pub[2],
      inputNullifiers: [pub[3], pub[4]],
      outputCommitments: [pub[5], pub[6]],
    }

    const { transaction } = await buildTransactTransaction({
      connection: this.conn,
      programId: this.programId!,
      signer: this.publicKey,
      isSpl: args.isSpl,
      proof: proofSubmit,
      extAmount: args.extAmount,
      fee: args.fee,
      encryptedOutput1: encryptedOutput1 as unknown as Uint8Array,
      encryptedOutput2: encryptedOutput2 as unknown as Uint8Array,
      recipient: args.recipient,
      feeRecipient: this.feeRecipient,
    })

    const signed = (await this.signer.signTransaction(transaction)) as VersionedTransaction
    const signature = await this.conn.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 5,
    })
    try {
      await this.conn.confirmTransaction(signature, "confirmed")
    } catch {
      /* signature still returned for inspection */
    }
    return signature
  }

  getPrivateBalanceSOL(): bigint {
    return unspentNotes(this.publicKey)
      .filter((n) => n.mintAddress === WRAPPED_SOL_MINT)
      .reduce((s, n) => s + BigInt(n.amount), 0n)
  }

  getPrivateBalanceSPL(mint: PublicKey | string): bigint {
    const k = typeof mint === "string" ? mint : mint.toString()
    return unspentNotes(this.publicKey)
      .filter((n) => n.mintAddress === k)
      .reduce((s, n) => s + BigInt(n.amount), 0n)
  }

  // ---- SPL deposit / withdraw ----

  async depositSPL(mint: PublicKey, baseUnits: number): Promise<DepositResult> {
    await this.unlock()
    const treeKey = mint.toString()
    const { root, nextLeafIndex } = await fetchTreeState(treeKey)
    const wasm = this.wasm!, kp = this.utxoKeypair!
    const extAmount = new BN(baseUnits), fee = new BN(DEPOSIT_FEE)
    const dummy = new Array(MERKLE_TREE_DEPTH).fill("0")
    const inputs = [new Utxo({ wasm, keypair: kp, mintAddress: treeKey }), new Utxo({ wasm, keypair: kp, mintAddress: treeKey })]
    const outputs = [
      new Utxo({ wasm, amount: extAmount.sub(fee).toString(), keypair: kp, index: nextLeafIndex, mintAddress: treeKey }),
      new Utxo({ wasm, amount: "0", keypair: kp, index: nextLeafIndex + 1, mintAddress: treeKey }),
    ]
    const signerAta = await this.ensureAta(mint)
    const signature = await this.proveAndSendSpl({
      root, inputs, outputs, inputPathElements: [dummy, dummy], inputPathIndices: [0, 0],
      extAmount, fee, recipient: this.publicKey, mint, mintAddress: treeKey,
      signerTokenAccount: signerAta, recipientTokenAccount: signerAta, feeRecipientAta: signerAta,
    })
    saveNote(this.publicKey, { id: newNoteId(), amount: outputs[0].amount.toString(), blinding: outputs[0].blinding.toString(), index: nextLeafIndex, mintAddress: treeKey, spent: false, createdAt: Date.now(), depositTx: signature })
    return { signature, amountLamports: baseUnits, leafIndex: nextLeafIndex }
  }

  async withdrawSPL(mint: PublicKey, baseUnits: number, recipient: PublicKey): Promise<WithdrawResult> {
    await this.unlock()
    const treeKey = mint.toString()
    const feeBps = this.info!.withdrawalFeeRateBps
    const wasm = this.wasm!, kp = this.utxoKeypair!
    const { root, nextLeafIndex } = await fetchTreeState(treeKey)
    pruneStaleNotes(this.publicKey, nextLeafIndex)
    const sorted = unspentNotes(this.publicKey).filter((n) => n.mintAddress === treeKey && n.index < nextLeafIndex).sort((a, b) => Number(b.amount) - Number(a.amount))
    if (sorted.length === 0) throw new Error("no spendable SPL notes for this mint — deposit first")
    let inputNotes = sorted.filter((n) => BigInt(n.amount) >= BigInt(baseUnits))
    if (inputNotes.length === 0) { const a = sorted[0]; const need = BigInt(baseUnits) - BigInt(a.amount); const b = sorted.slice(1).find((n) => BigInt(n.amount) >= need); inputNotes = b ? [a, b] : [a] }
    const realInputs = inputNotes.map((n) => new Utxo({ wasm, amount: n.amount, blinding: n.blinding, keypair: kp, index: n.index, mintAddress: treeKey }))
    const inputs = realInputs.length === 2 ? realInputs : [realInputs[0], new Utxo({ wasm, keypair: kp, amount: "0", mintAddress: treeKey })]
    const totalInput = inputs.reduce((s, x) => s.add(x.amount), new BN(0))
    const gross = BN.min(new BN(baseUnits), totalInput)
    const fee = new BN(Math.ceil((gross.toNumber() * feeBps) / 10000))
    const recipientGets = gross.sub(fee)
    const extAmount = recipientGets.neg()
    const change = totalInput.sub(gross)
    const inputPathElements: string[][] = []
    for (const u of inputs) {
      if (u.amount.gt(new BN(0))) inputPathElements.push((await fetchMerkleProof(treeKey, u.index)).pathElements)
      else inputPathElements.push(new Array(MERKLE_TREE_DEPTH).fill("0"))
    }
    const outputs = [
      new Utxo({ wasm, amount: change.toString(), keypair: kp, index: nextLeafIndex, mintAddress: treeKey }),
      new Utxo({ wasm, amount: "0", keypair: kp, index: nextLeafIndex + 1, mintAddress: treeKey }),
    ]
    const signerAta = await this.ensureAta(mint)
    const signature = await this.proveAndSendSpl({
      root, inputs, outputs, inputPathElements, inputPathIndices: inputs.map((u) => u.index),
      extAmount, fee, recipient, mint, mintAddress: treeKey,
      signerTokenAccount: signerAta, recipientTokenAccount: signerAta, feeRecipientAta: signerAta,
    })
    for (const n of inputNotes) markNoteSpent(this.publicKey, n.id, signature)
    if (change.gt(new BN(0))) saveNote(this.publicKey, { id: newNoteId(), amount: outputs[0].amount.toString(), blinding: outputs[0].blinding.toString(), index: nextLeafIndex, mintAddress: treeKey, spent: false, createdAt: Date.now(), depositTx: signature })
    return { signature, recipientLamports: recipientGets.toNumber(), feeLamports: fee.toNumber(), changeLamports: change.toString() }
  }

  /** Ensure the signer's ATA for a mint exists (wallet signs the create). */
  private async ensureAta(mint: PublicKey): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, this.publicKey, false)
    if (await this.conn.getAccountInfo(ata)) return ata
    await this.sendIx(createAssociatedTokenAccountIdempotentInstruction(this.publicKey, ata, this.publicKey, mint))
    return ata
  }

  /** Build + send an SPL transact proof + tx via a fresh Address Lookup Table. */
  private async proveAndSendSpl(args: {
    root: string; inputs: Utxo[]; outputs: Utxo[]
    inputPathElements: string[][]; inputPathIndices: number[]
    extAmount: BN; fee: BN; recipient: PublicKey; mint: PublicKey; mintAddress: string
    signerTokenAccount: PublicKey; recipientTokenAccount: PublicKey; feeRecipientAta: PublicKey
  }): Promise<string> {
    const enc = this.enc!
    const inputNullifiers = await Promise.all(args.inputs.map((x) => x.getNullifier()))
    const outputCommitments = args.outputs.map((x) => x.getCommitment())
    const ct1 = await enc.encryptUtxo(args.outputs[0]); const ct2 = await enc.encryptUtxo(args.outputs[1])
    // SPL ext_data_hash uses the token accounts (not wallet addresses) + mint bytes
    const extDataHash = getExtDataHash({
      recipient: args.recipientTokenAccount, extAmount: args.extAmount,
      encryptedOutput1: ct1 as unknown as Uint8Array, encryptedOutput2: ct2 as unknown as Uint8Array,
      fee: args.fee, feeRecipient: args.feeRecipientAta, mintAddress: args.mint,
    })
    const publicAmount = args.extAmount.sub(args.fee).add(FIELD_SIZE).mod(FIELD_SIZE)
    const { proof, publicSignals } = await prove({
      root: args.root, inputNullifier: inputNullifiers, outputCommitment: outputCommitments,
      publicAmount: publicAmount.toString(), extDataHash,
      inAmount: args.inputs.map((x) => x.amount.toString(10)),
      inPrivateKey: args.inputs.map((x) => x.keypair.privkey),
      inBlinding: args.inputs.map((x) => x.blinding.toString(10)),
      inPathIndices: args.inputPathIndices, inPathElements: args.inputPathElements,
      outAmount: args.outputs.map((x) => x.amount.toString(10)),
      outBlinding: args.outputs.map((x) => x.blinding.toString(10)),
      outPubkey: args.outputs.map((x) => x.keypair.pubkey),
      mintAddress: getMintAddressField(args.mint),
    } as unknown as Record<string, unknown>)
    const proofBytes = parseProofToBytesArray(proof); const pub = parseToBytesArray(publicSignals)
    this._lastNullifiers = [pub[3], pub[4]].map((n) => Array.from(n).map((b: number) => b.toString(16).padStart(2, "0")).join(""))
    const proofSubmit: ProofBytes = {
      proofA: proofBytes.proofA, proofB: proofBytes.proofB, proofC: proofBytes.proofC,
      root: pub[0], publicAmount: pub[1], extDataHash: pub[2],
      inputNullifiers: [pub[3], pub[4]], outputCommitments: [pub[5], pub[6]],
    }
    const { ix } = buildTransactSplInstruction({
      connection: this.conn, programId: this.programId!, signer: this.publicKey, isSpl: true,
      proof: proofSubmit, extAmount: args.extAmount, fee: args.fee,
      encryptedOutput1: ct1 as unknown as Uint8Array, encryptedOutput2: ct2 as unknown as Uint8Array,
      recipient: args.recipient, feeRecipient: this.feeRecipient,
      mint: args.mint, signerTokenAccount: args.signerTokenAccount,
      recipientTokenAccount: args.recipientTokenAccount, feeRecipientAta: args.feeRecipientAta,
    })
    return this.sendWithAlt(ix)
  }

  /** Send a single ix (inline, no ALT — for small ixs like create-ATA, create-ALT). */
  private async sendIx(ix: TransactionInstruction): Promise<string> {
    const { blockhash } = await this.conn.getLatestBlockhash()
    const msg = new TransactionMessage({
      payerKey: this.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix],
    }).compileToV0Message()
    const tx = new VersionedTransaction(msg)
    const signed = await this.signer.signTransaction(tx)
    const sig = await this.conn.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 5 })
    try { await this.conn.confirmTransaction(sig, "confirmed") } catch {}
    return sig
  }

  /** Send a large ix (>11 accounts) via a freshly-created Address Lookup Table. */
  private async sendWithAlt(ix: TransactionInstruction): Promise<string> {
    const addrs = [this.publicKey, ComputeBudgetProgram.programId, ix.programId, ...ix.keys.map((k) => k.pubkey)]
    const uniq = [...new Set(addrs.map((a) => a.toBase58()))].map((s) => new PublicKey(s))
    const recentSlot = await this.conn.getSlot("confirmed")
    const [ltIx, ltAddr] = AddressLookupTableProgram.createLookupTable({ authority: this.publicKey, payer: this.publicKey, recentSlot })
    await this.sendIx(ltIx)
    for (let i = 0; i < uniq.length; i += 18) {
      await this.sendIx(AddressLookupTableProgram.extendLookupTable({ lookupTable: ltAddr, authority: this.publicKey, payer: this.publicKey, addresses: uniq.slice(i, i + 18) }))
    }
    const start = await this.conn.getSlot("confirmed")
    while ((await this.conn.getSlot("confirmed")) <= start + 1) await new Promise((r) => setTimeout(r, 400))
    const acct = await this.conn.getAccountInfo(ltAddr)
    const alt = new AddressLookupTableAccount({ key: ltAddr, state: AddressLookupTableAccount.deserialize(acct!.data) })
    const { blockhash } = await this.conn.getLatestBlockhash()
    const msg = new TransactionMessage({
      payerKey: this.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix],
    }).compileToV0Message([alt])
    const tx = new VersionedTransaction(msg)
    const signed = await this.signer.signTransaction(tx)
    const sig = await this.conn.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 5 })
    try { await this.conn.confirmTransaction(sig, "confirmed") } catch {}
    return sig
  }
}
