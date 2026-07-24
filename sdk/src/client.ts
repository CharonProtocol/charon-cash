import { WasmFactory, type LightWasm } from "@lightprotocol/hasher.rs"
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token"
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js"
import BN from "bn.js"

import {
  envProgramId,
  FIELD_SIZE,
  MERKLE_TREE_DEPTH,
  SIGN_MESSAGE,
  SOL_TREE_KEY,
  WRAPPED_SOL_MINT,
} from "./constants"
import {
  EncryptionService,
  Keypair,
  Utxo,
  getExtDataHash,
  getMintAddressField,
} from "./crypto"
import {
  fetchMerkleProof,
  fetchRelayerInfo,
  fetchTreeState,
  fetchUtxoRange,
  fieldToHex32,
  isNullifierSpent,
  waitForLeafIndex,
  type RelayerInfo,
} from "./merkle"
import {
  getSyncOffset,
  markNoteSpent,
  newNoteId,
  saveNote,
  setSyncOffset,
  unspentNotes,
  upsertNote,
  markNoteSpentByIndex,
} from "./notes"
import { parseProofToBytesArray, parseToBytesArray, prove } from "./prover"
import {
  buildTransactSplTransaction,
  buildTransactTransaction,
  deriveSplTreeAccount,
  type ProofBytes,
} from "./program"
import {
  ensureAlt,
  envAltAddress,
  splAltAddresses,
  type AltSigner,
} from "./alt"
import { readTreeState } from "./local-provider"

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

export interface SyncResult {
  scanned: number
  added: number
  spent: number
}

const DEPOSIT_FEE = 0
const RANGE_PAGE = 2_000

function toPubkey(value: PublicKey | string): PublicKey {
  return value instanceof PublicKey ? value : new PublicKey(value)
}

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
        // Recover notes from indexer (localStorage may be empty on a new device).
        await this.syncNotes(SOL_TREE_KEY).catch(() => {
          /* unlock still succeeds if indexer is briefly down */
        })
      })()
    }
    await this.unlocking
  }

  isUnlocked(): boolean {
    return !!this.utxoKeypair
  }

  /**
   * Scan encrypted outputs from the backend, decrypt ours, upsert notes,
   * and mark spent via nullifier checks.
   */
  async syncNotes(treeKey: string, fromScratch = false): Promise<SyncResult> {
    await this.unlock()
    const enc = this.enc!
    const wasm = this.wasm!
    const wallet = this.publicKey

    let start = fromScratch ? 0 : getSyncOffset(wallet, treeKey)
    let scanned = 0
    let added = 0
    let spent = 0

    while (true) {
      const page = await fetchUtxoRange(treeKey, start, start + RANGE_PAGE)
      for (const row of page.utxos) {
        scanned++
        let utxo: Utxo
        try {
          const bytes = Buffer.from(row.encryptedOutputHex, "hex")
          utxo = await enc.decryptUtxo(bytes, wasm)
        } catch {
          continue // not ours / garbage
        }
        if (utxo.amount.isZero()) continue

        // Prefer leaf index from the indexer (authoritative).
        utxo.index = row.leafIndex

        const nullifier = await utxo.getNullifier()
        const spentOnChain = await isNullifierSpent(fieldToHex32(nullifier))
        if (spentOnChain) {
          markNoteSpentByIndex(wallet, utxo.mintAddress, utxo.index)
          spent++
          continue
        }

        const before = unspentNotes(wallet).some(
          (n) => n.mintAddress === utxo.mintAddress && n.index === utxo.index,
        )
        upsertNote(wallet, {
          id: newNoteId(),
          amount: utxo.amount.toString(),
          blinding: utxo.blinding.toString(),
          index: utxo.index,
          mintAddress: utxo.mintAddress,
          spent: false,
          createdAt: Date.now(),
          depositTx: row.signature,
        })
        if (!before) added++
      }

      setSyncOffset(wallet, treeKey, page.end)
      if (!page.hasMore) break
      start = page.end
    }

    return { scanned, added, spent }
  }

  async depositSOL(amountLamports: number): Promise<DepositResult> {
    await this.unlock()
    const treeKey = SOL_TREE_KEY
    // Prefer on-chain tree state (shim can lag / mix trees).
    const onChain = await readTreeState(this.conn, this.programId!, treeKey)
    const root = onChain.root
    const nextLeafIndex = onChain.nextLeafIndex

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

    const enc1 = await this.enc!.encryptUtxo(outputs[0])
    const enc2 = await this.enc!.encryptUtxo(outputs[1])

    const signature = await this.proveAndSend({
      root,
      inputs,
      outputs,
      encryptedOutput1: enc1,
      encryptedOutput2: enc2,
      inputPathElements: [dummyPath, dummyPath],
      inputPathIndices: inputs.map((u) => u.index),
      extAmount,
      fee,
      recipient: this.feeRecipient,
      feeRecipientForHash: this.feeRecipient,
      mintAddress: WRAPPED_SOL_MINT,
      isSpl: false,
    })

    // Persist note immediately — deposit already settled; indexer wait is best-effort.
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

    await this.waitForLeaves(treeKey, nextLeafIndex + 1)

    return { signature, amountLamports, leafIndex: nextLeafIndex }
  }

  async withdrawSOL(
    grossLamports: number,
    recipient: PublicKey | string,
  ): Promise<WithdrawResult> {
    await this.unlock()
    await this.syncNotes(SOL_TREE_KEY).catch(() => { })
    return this.withdrawInternal({
      treeKey: SOL_TREE_KEY,
      mintAddress: WRAPPED_SOL_MINT,
      grossLamports,
      recipient: toPubkey(recipient),
      isSpl: false,
    })
  }

  async depositSPL(
    mint: PublicKey | string,
    amountRaw: number | string,
  ): Promise<DepositResult> {
    await this.unlock()
    const mintPk = toPubkey(mint)
    const mintStr = mintPk.toBase58()
    const treeKey = mintStr

    // Fail fast if Admin → Initialize SPL hasn't been run for this mint.
    const [treePda] = deriveSplTreeAccount(this.programId!, mintPk)
    if (!(await this.conn.getAccountInfo(treePda))) {
      throw new Error(
        `SPL tree for mint ${mintStr} is not initialized — open Admin and click "Initialize SPL" first`,
      )
    }

    const onChain = await readTreeState(this.conn, this.programId!, treeKey)
    const root = onChain.root
    const nextLeafIndex = onChain.nextLeafIndex

    const extAmount = new BN(amountRaw.toString())
    const fee = new BN(DEPOSIT_FEE)
    const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0")

    const inputs = [
      new Utxo({ wasm: this.wasm!, keypair: this.utxoKeypair!, mintAddress: mintStr }),
      new Utxo({ wasm: this.wasm!, keypair: this.utxoKeypair!, mintAddress: mintStr }),
    ]
    const outputs = [
      new Utxo({
        wasm: this.wasm!,
        amount: extAmount.sub(fee).toString(),
        keypair: this.utxoKeypair!,
        index: nextLeafIndex,
        mintAddress: mintStr,
      }),
      new Utxo({
        wasm: this.wasm!,
        amount: "0",
        keypair: this.utxoKeypair!,
        index: nextLeafIndex + 1,
        mintAddress: mintStr,
      }),
    ]

    const enc1 = await this.enc!.encryptUtxo(outputs[0])
    const enc2 = await this.enc!.encryptUtxo(outputs[1])

    const signerAta = getAssociatedTokenAddressSync(mintPk, this.publicKey)
    const feeAta = this.feeAta(mintPk)
    // For deposits, on-chain hashes recipient_token_account — use fee ATA (fee=0).
    const recipientAta = feeAta

    const signature = await this.proveAndSend({
      root,
      inputs,
      outputs,
      encryptedOutput1: enc1,
      encryptedOutput2: enc2,
      inputPathElements: [dummyPath, dummyPath],
      inputPathIndices: inputs.map((u) => u.index),
      extAmount,
      fee,
      recipient: this.feeRecipient,
      feeRecipientForHash: feeAta,
      mintAddress: mintStr,
      isSpl: true,
      mint: mintPk,
      signerTokenAccount: signerAta,
      recipientTokenAccount: recipientAta,
      feeRecipientAta: feeAta,
    })

    saveNote(this.publicKey, {
      id: newNoteId(),
      amount: outputs[0].amount.toString(),
      blinding: outputs[0].blinding.toString(),
      index: nextLeafIndex,
      mintAddress: mintStr,
      spent: false,
      createdAt: Date.now(),
      depositTx: signature,
    })

    await this.waitForLeaves(treeKey, nextLeafIndex + 1)

    return {
      signature,
      amountLamports: Number(amountRaw),
      leafIndex: nextLeafIndex,
    }
  }

  async withdrawSPL(
    mint: PublicKey | string,
    grossRaw: number | string,
    recipient: PublicKey | string,
  ): Promise<WithdrawResult> {
    await this.unlock()
    const mintPk = toPubkey(mint)
    const mintStr = mintPk.toBase58()
    await this.syncNotes(mintStr).catch(() => { })
    return this.withdrawInternal({
      treeKey: mintStr,
      mintAddress: mintStr,
      grossLamports: Number(grossRaw),
      recipient: toPubkey(recipient),
      isSpl: true,
      mint: mintPk,
    })
  }

  getPrivateBalanceSOL(): bigint {
    return this.balanceForMint(WRAPPED_SOL_MINT)
  }

  getPrivateBalanceSPL(mint: PublicKey | string): bigint {
    const m = mint instanceof PublicKey ? mint.toBase58() : mint
    return this.balanceForMint(m)
  }

  /** Poll on-chain next_index (falls back to indexer). Never throws — deposit already settled. */
  private async waitForLeaves(treeKey: string, minLeafIndex: number): Promise<void> {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      try {
        const st = await readTreeState(this.conn, this.programId!, treeKey)
        if (st.nextLeafIndex > minLeafIndex) return
      } catch {
        try {
          const st = await fetchTreeState(treeKey)
          if (st.nextLeafIndex > minLeafIndex) return
        } catch {
          /* keep polling */
        }
      }
      await new Promise((r) => setTimeout(r, 750))
    }
  }

  private balanceForMint(mintAddress: string): bigint {
    return unspentNotes(this.publicKey)
      .filter((n) => n.mintAddress === mintAddress)
      .reduce((s, n) => s + BigInt(n.amount), 0n)
  }

  private feeAta(mint: PublicKey): PublicKey {
    const hit = this.info!.supportedMints.find((m) => m.mint === mint.toBase58())
    if (hit) return new PublicKey(hit.feeAta)
    return getAssociatedTokenAddressSync(mint, this.feeRecipient, true)
  }

  private async withdrawInternal(args: {
    treeKey: string
    mintAddress: string
    grossLamports: number
    recipient: PublicKey
    isSpl: boolean
    mint?: PublicKey
  }): Promise<WithdrawResult> {
    const feeBps = this.info!.withdrawalFeeRateBps
    const wasm = this.wasm!
    const utxoKeypair = this.utxoKeypair!

    const sorted = unspentNotes(this.publicKey)
      .filter((n) => n.mintAddress === args.mintAddress)
      .sort((a, b) => Number(b.amount) - Number(a.amount))
    if (sorted.length === 0) throw new Error("no spendable notes")

    let inputNotes = sorted.filter(
      (n) => BigInt(n.amount) >= BigInt(args.grossLamports),
    )
    if (inputNotes.length === 0) {
      const a = sorted[0]
      const need = BigInt(args.grossLamports) - BigInt(a.amount)
      const b = sorted.slice(1).find((n) => BigInt(n.amount) >= need)
      if (!b && BigInt(a.amount) < BigInt(args.grossLamports)) {
        throw new Error(
          `insufficient private balance: have ${a.amount}, need ${args.grossLamports}`,
        )
      }
      inputNotes = b ? [a, b] : [a]
    } else {
      inputNotes = [inputNotes[0]]
    }

    const realInputs = inputNotes.map(
      (n) =>
        new Utxo({
          wasm,
          amount: n.amount,
          blinding: n.blinding,
          keypair: utxoKeypair,
          index: n.index,
          mintAddress: args.mintAddress,
        }),
    )
    const inputs =
      realInputs.length === 2
        ? realInputs
        : [
          realInputs[0],
          new Utxo({
            wasm,
            keypair: utxoKeypair,
            amount: "0",
            mintAddress: args.mintAddress,
          }),
        ]

    const totalInput = inputs.reduce((s, x) => s.add(x.amount), new BN(0))
    const gross = new BN(args.grossLamports)
    if (gross.gt(totalInput)) {
      throw new Error(
        `insufficient private balance: have ${totalInput.toString()}, need ${gross.toString()}`,
      )
    }
    const fee = new BN(Math.ceil((gross.toNumber() * feeBps) / 10000))
    const recipientGets = gross.sub(fee)
    const extAmount = recipientGets.neg()
    const change = totalInput.sub(gross)

    const { root, nextLeafIndex } = await fetchTreeState(args.treeKey)

    const inputPathElements: string[][] = []
    for (const u of inputs) {
      if (u.amount.gt(new BN(0))) {
        inputPathElements.push(
          (await fetchMerkleProof(args.treeKey, u.index)).pathElements,
        )
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
        mintAddress: args.mintAddress,
      }),
      new Utxo({
        wasm,
        amount: "0",
        keypair: utxoKeypair,
        index: nextLeafIndex + 1,
        mintAddress: args.mintAddress,
      }),
    ]

    const enc1 = await this.enc!.encryptUtxo(outputs[0])
    const enc2 = await this.enc!.encryptUtxo(outputs[1])

    let feeRecipientForHash: PublicKey = this.feeRecipient
    let splExtras:
      | {
        mint: PublicKey
        signerTokenAccount: PublicKey
        recipientTokenAccount: PublicKey
        feeRecipientAta: PublicKey
        preIxs?: TransactionInstruction[]
      }
      | undefined

    if (args.isSpl && args.mint) {
      const mint = args.mint
      const feeAta = this.feeAta(mint)
      const recipientAta = getAssociatedTokenAddressSync(mint, args.recipient)
      const signerAta = getAssociatedTokenAddressSync(mint, this.publicKey)
      feeRecipientForHash = feeAta
      splExtras = {
        mint,
        signerTokenAccount: signerAta,
        recipientTokenAccount: recipientAta,
        feeRecipientAta: feeAta,
        preIxs: [
          createAssociatedTokenAccountIdempotentInstruction(
            this.publicKey,
            recipientAta,
            args.recipient,
            mint,
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            this.publicKey,
            feeAta,
            this.feeRecipient,
            mint,
          ),
        ],
      }
    }

    const signature = await this.proveAndSend({
      root,
      inputs,
      outputs,
      encryptedOutput1: enc1,
      encryptedOutput2: enc2,
      inputPathElements,
      inputPathIndices: inputs.map((u) => u.index),
      extAmount,
      fee,
      recipient: args.recipient,
      feeRecipientForHash,
      mintAddress: args.mintAddress,
      isSpl: args.isSpl,
      ...splExtras,
    })

    for (const n of inputNotes) markNoteSpent(this.publicKey, n.id, signature)
    if (change.gt(new BN(0))) {
      await waitForLeafIndex(args.treeKey, nextLeafIndex).catch(() => { })
      saveNote(this.publicKey, {
        id: newNoteId(),
        amount: outputs[0].amount.toString(),
        blinding: outputs[0].blinding.toString(),
        index: nextLeafIndex,
        mintAddress: args.mintAddress,
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
    encryptedOutput1: Uint8Array
    encryptedOutput2: Uint8Array
    inputPathElements: string[][]
    inputPathIndices: number[]
    extAmount: BN
    fee: BN
    recipient: PublicKey
    /** Pubkey bytes hashed into ext_data (wallet for SOL, ATA for SPL). */
    feeRecipientForHash: PublicKey
    mintAddress: string
    isSpl: boolean
    mint?: PublicKey
    signerTokenAccount?: PublicKey
    recipientTokenAccount?: PublicKey
    feeRecipientAta?: PublicKey
    preIxs?: TransactionInstruction[]
  }): Promise<string> {
    const inputNullifiers = await Promise.all(
      args.inputs.map((x) => x.getNullifier()),
    )
    const outputCommitments = args.outputs.map((x) => x.getCommitment())

    // SPL: program hashes recipient_token_account + fee_recipient_ata.
    const hashRecipient = args.isSpl
      ? args.recipientTokenAccount!
      : args.recipient
    const hashFeeRecipient = args.feeRecipientForHash

    const extDataHash = getExtDataHash({
      recipient: hashRecipient,
      extAmount: args.extAmount,
      encryptedOutput1: args.encryptedOutput1,
      encryptedOutput2: args.encryptedOutput2,
      fee: args.fee,
      feeRecipient: hashFeeRecipient,
      mintAddress: args.mintAddress,
    })

    const publicAmount = args.extAmount
      .sub(args.fee)
      .add(FIELD_SIZE)
      .mod(FIELD_SIZE)

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

    let transaction: VersionedTransaction
    if (args.isSpl) {
      const mint = args.mint!
      const alt = await ensureAlt({
        connection: this.conn,
        signer: this.signer as AltSigner,
        preferred: envAltAddress(),
        addresses: [
          ...splAltAddresses({
            programId: this.programId!,
            feeRecipient: this.feeRecipient,
            mint,
          }),
          args.signerTokenAccount!,
          args.recipientTokenAccount!,
          args.feeRecipientAta!,
          args.recipient,
        ],
      })
      const built = await buildTransactSplTransaction({
        connection: this.conn,
        programId: this.programId!,
        signer: this.publicKey,
        isSpl: true,
        proof: proofSubmit,
        extAmount: args.extAmount,
        fee: args.fee,
        encryptedOutput1: args.encryptedOutput1,
        encryptedOutput2: args.encryptedOutput2,
        recipient: args.recipient,
        feeRecipient: this.feeRecipient,
        mint,
        signerTokenAccount: args.signerTokenAccount!,
        recipientTokenAccount: args.recipientTokenAccount!,
        feeRecipientAta: args.feeRecipientAta!,
        preIxs: args.preIxs,
        lookupTables: [alt],
      })
      transaction = built.transaction
    } else {
      const built = await buildTransactTransaction({
        connection: this.conn,
        programId: this.programId!,
        signer: this.publicKey,
        isSpl: false,
        proof: proofSubmit,
        extAmount: args.extAmount,
        fee: args.fee,
        encryptedOutput1: args.encryptedOutput1,
        encryptedOutput2: args.encryptedOutput2,
        recipient: args.recipient,
        feeRecipient: this.feeRecipient,
      })
      transaction = built.transaction
    }

    const signed = (await this.signer.signTransaction(
      transaction,
    )) as VersionedTransaction
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
}
