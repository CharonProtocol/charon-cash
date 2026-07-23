import { WasmFactory, type LightWasm } from "@lightprotocol/hasher.rs"
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js"
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
import { buildTransactTransaction, type ProofBytes } from "./program"

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
}
