import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js"
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token"
import BN from "bn.js"

import {
  DISC_TRANSACT,
  DISC_TRANSACT_SPL,
  JUPITER_PROGRAM_ID,
  NATIVE_MINT,
  SEED,
  SWAP_IX_DISCRIMINATOR,
  WRAP_SOL_IX_DISCRIMINATOR,
  WRAPPED_SOL_MINT,
} from "./constants"
import { compileV1Transaction } from "./tx-v1"

/** Byte layout the Pinocchio program's TransactArgs expects (see state/transact.rs). */
export interface ProofBytes {
  proofA: number[]
  proofB: number[]
  proofC: number[]
  root: number[]
  publicAmount: number[]
  extDataHash: number[]
  inputNullifiers: number[][]
  outputCommitments: number[][]
}

export interface TransactAccounts {
  treeAccount: PublicKey
  treeTokenAccount: PublicKey
  globalConfig: PublicKey
  nullifier0: PublicKey
  nullifier1: PublicKey
  nullifier2: PublicKey
  nullifier3: PublicKey
  bump0: number
  bump1: number
}

export function deriveAccounts(
  programId: PublicKey,
  nullifierHash0: Uint8Array,
  nullifierHash1: Uint8Array,
): TransactAccounts {
  const [treeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TREE_ACCOUNT)],
    programId,
  )
  const [treeTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TREE_TOKEN)],
    programId,
  )
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.GLOBAL_CONFIG)],
    programId,
  )
  const [nullifier0, bump0] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.NULLIFIER0), Buffer.from(nullifierHash0)],
    programId,
  )
  const [nullifier1, bump1] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.NULLIFIER1), Buffer.from(nullifierHash1)],
    programId,
  )
  const [nullifier2] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.NULLIFIER0), Buffer.from(nullifierHash1)],
    programId,
  )
  const [nullifier3] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.NULLIFIER1), Buffer.from(nullifierHash0)],
    programId,
  )
  return {
    treeAccount,
    treeTokenAccount,
    globalConfig,
    nullifier0,
    nullifier1,
    nullifier2,
    nullifier3,
    bump0,
    bump1,
  }
}

export function buildTransactIxData(
  isSpl: boolean,
  proof: ProofBytes,
  extAmount: BN,
  fee: BN,
  encryptedOutput1: Uint8Array,
  encryptedOutput2: Uint8Array,
  bump0: number,
  bump1: number,
): Buffer {
  const disc = isSpl ? DISC_TRANSACT_SPL : DISC_TRANSACT
  return Buffer.concat([
    Buffer.from([disc]),
    Buffer.from(proof.proofA),
    Buffer.from(proof.proofB),
    Buffer.from(proof.proofC),
    Buffer.from(proof.root),
    Buffer.from(proof.publicAmount),
    Buffer.from(proof.extDataHash),
    Buffer.from(proof.inputNullifiers[0]),
    Buffer.from(proof.inputNullifiers[1]),
    Buffer.from(proof.outputCommitments[0]),
    Buffer.from(proof.outputCommitments[1]),
    new BN(extAmount).toTwos(64).toArrayLike(Buffer, "le", 8),
    new BN(fee).toArrayLike(Buffer, "le", 8),
    toU32LE(encryptedOutput1.length),
    Buffer.from(encryptedOutput1),
    toU32LE(encryptedOutput2.length),
    Buffer.from(encryptedOutput2),
    Buffer.from([bump0, bump1]),
  ])
}

function toU32LE(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

export interface BuildTxParams {
  blockhash: string
  programId: PublicKey
  signer: PublicKey
  isSpl: boolean
  proof: ProofBytes
  extAmount: BN
  fee: BN
  encryptedOutput1: Uint8Array
  encryptedOutput2: Uint8Array
  recipient: PublicKey
  feeRecipient: PublicKey
}

/** Assemble an unsigned v0 transaction (no ALT — sized to fit inline). */
export async function buildTransactTransaction(
  params: BuildTxParams,
): Promise<{ transaction: VersionedTransaction; accounts: TransactAccounts }> {
  const nullifierHash0 = Uint8Array.from(params.proof.inputNullifiers[0])
  const nullifierHash1 = Uint8Array.from(params.proof.inputNullifiers[1])
  const accounts = deriveAccounts(
    params.programId,
    nullifierHash0,
    nullifierHash1,
  )

  const ixData = buildTransactIxData(
    params.isSpl,
    params.proof,
    params.extAmount,
    params.fee,
    params.encryptedOutput1,
    params.encryptedOutput2,
    accounts.bump0,
    accounts.bump1,
  )

  const transactIx = new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: accounts.treeAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifier0, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifier1, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifier2, isSigner: false, isWritable: false },
      { pubkey: accounts.nullifier3, isSigner: false, isWritable: false },
      { pubkey: accounts.treeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
      { pubkey: params.recipient, isSigner: false, isWritable: true },
      { pubkey: params.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: params.signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  })

  const blockhash = params.blockhash
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })
  const priceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 5_000,
  })

  const tryCompile = (instructions: TransactionInstruction[]) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: params.signer,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(),
    )

  let tx = tryCompile([limitIx, priceIx, transactIx])
  if (tx.serialize().length > 1232) {
    tx = tryCompile([limitIx, transactIx])
  }
  if (tx.serialize().length > 1232) {
    throw new Error(
      `transaction too large (${tx.serialize().length} > 1232); an Address Lookup Table is required`,
    )
  }
  return { transaction: tx, accounts }
}

// ---------------- SPL ----------------

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")

/** SPL tree PDA includes the mint: PDA(['merkle_tree', mint], programId). */
export function deriveSplTreeAccount(programId: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TREE_ACCOUNT), mint.toBytes()],
    programId,
  )
}

export function buildInitializeSplIxData(maxDeposit: bigint | number, bump: number): Buffer {
  const data = Buffer.alloc(17)
  data[0] = 1 // DISC_INITIALIZE_SPL
  data.writeBigUInt64LE(BigInt(maxDeposit), 1)
  data[9] = bump
  return data
}

export interface SplTransactExtras {
  mint: PublicKey
  signerTokenAccount: PublicKey
  recipientTokenAccount: PublicKey
  feeRecipientAta: PublicKey
  /** Optional instructions prepended (e.g. create ATA idempotent). */
  preIxs?: TransactionInstruction[]
}

/** Build the 16-account Pinocchio transact_spl instruction. */
export function buildTransactSplInstruction(
  params: BuildTxParams & SplTransactExtras,
): { ix: TransactionInstruction; accounts: TransactAccounts; treeAccount: PublicKey } {
  const nullifierHash0 = Uint8Array.from(params.proof.inputNullifiers[0])
  const nullifierHash1 = Uint8Array.from(params.proof.inputNullifiers[1])
  const accounts = deriveAccounts(params.programId, nullifierHash0, nullifierHash1)
  const [treeAccount] = deriveSplTreeAccount(params.programId, params.mint)
  const treeAta = getAssociatedTokenAddressSync(params.mint, accounts.globalConfig, true)
  const ixData = buildTransactIxData(
    true,
    params.proof,
    params.extAmount,
    params.fee,
    params.encryptedOutput1,
    params.encryptedOutput2,
    accounts.bump0,
    accounts.bump1,
  )
  const ix = new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifier0, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifier1, isSigner: false, isWritable: true },
      { pubkey: accounts.nullifier2, isSigner: false, isWritable: false },
      { pubkey: accounts.nullifier3, isSigner: false, isWritable: false },
      { pubkey: accounts.globalConfig, isSigner: false, isWritable: false },
      { pubkey: params.signer, isSigner: true, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.signerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: params.recipient, isSigner: false, isWritable: false },
      { pubkey: params.recipientTokenAccount, isSigner: false, isWritable: true },
      { pubkey: treeAta, isSigner: false, isWritable: true },
      { pubkey: params.feeRecipientAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  })
  return { ix, accounts, treeAccount }
}

/** Assemble an unsigned v0 SPL transaction (uses ALT — required to fit proof + 16 accounts). */
export async function buildTransactSplTransaction(
  params: BuildTxParams &
    SplTransactExtras & {
      lookupTables: AddressLookupTableAccount[]
    },
): Promise<{ transaction: VersionedTransaction; accounts: TransactAccounts }> {
  const { ix, accounts } = buildTransactSplInstruction(params)
  const blockhash = params.blockhash
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })
  const priceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 5_000,
  })
  const pre = params.preIxs ?? []
  const tables = params.lookupTables

  const tryCompile = (instructions: TransactionInstruction[]) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: params.signer,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(tables),
    )

  const safeSerialize = (tx: VersionedTransaction): number => {
    try {
      return tx.serialize().length
    } catch (e) {
      if (
        e instanceof RangeError ||
        (e instanceof Error && /overruns Uint8Array/i.test(e.message))
      ) {
        return Number.POSITIVE_INFINITY
      }
      throw e
    }
  }

  let tx = tryCompile([...pre, limitIx, priceIx, ix])
  if (safeSerialize(tx) > 1232) {
    tx = tryCompile([...pre, limitIx, ix])
  }
  const size = safeSerialize(tx)
  if (size > 1232) {
    throw new Error(
      `SPL transaction too large (${size} > 1232) even with ALT; extend the lookup table with more static accounts`,
    )
  }
  return { transaction: tx, accounts }
}

// ---------------- Swap (v1) ----------------

export interface SwapAccounts {
  solTreeAccount: PublicKey
  treeTokenAccount: PublicKey
  globalConfig: PublicKey
  outTreeAccount: PublicKey
  poolWsolAccount: PublicKey
  poolSplAccount: PublicKey
}

export function deriveSwapAccounts(
  programId: PublicKey,
  splMint: PublicKey,
): SwapAccounts {
  const [solTreeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TREE_ACCOUNT)],
    programId,
  )
  const [treeTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TREE_TOKEN)],
    programId,
  )
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.GLOBAL_CONFIG)],
    programId,
  )
  const [outTreeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TREE_ACCOUNT), splMint.toBytes()],
    programId,
  )
  const poolWsolAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    globalConfig,
    true,
  )
  const poolSplAccount = getAssociatedTokenAddressSync(
    splMint,
    globalConfig,
    true,
  )
  return {
    solTreeAccount,
    treeTokenAccount,
    globalConfig,
    outTreeAccount,
    poolWsolAccount,
    poolSplAccount,
  }
}

function serializeProof(proof: ProofBytes): Buffer {
  if (
    proof.proofA.length !== 32 ||
    proof.proofB.length !== 64 ||
    proof.proofC.length !== 32
  ) {
    throw new Error(
      `compressed proof must be 32/64/32, got ${proof.proofA.length}/${proof.proofB.length}/${proof.proofC.length}`,
    )
  }
  return Buffer.concat([
    Buffer.from(proof.proofA),
    Buffer.from(proof.proofB),
    Buffer.from(proof.proofC),
    Buffer.from(proof.root),
    Buffer.from(proof.publicAmount),
    Buffer.from(proof.extDataHash),
    Buffer.from(proof.inputNullifiers[0]),
    Buffer.from(proof.inputNullifiers[1]),
    Buffer.from(proof.outputCommitments[0]),
    Buffer.from(proof.outputCommitments[1]),
  ])
}

function i64le(n: BN | number | string): Buffer {
  return Buffer.from(new BN(n.toString()).toTwos(64).toArray("le", 8))
}

function prefixed(buf: Uint8Array | Buffer): Buffer {
  return Buffer.concat([toU32LE(buf.length), Buffer.from(buf)])
}

function isSolMixerMint(mint: PublicKey | string): boolean {
  const s = mint.toString()
  return (
    s === WRAPPED_SOL_MINT ||
    s === NATIVE_MINT.toBase58() ||
    s === PublicKey.default.toBase58()
  )
}

export interface SwapIxParams {
  programId: PublicKey
  signer: PublicKey
  proofIn: ProofBytes
  proofOut: ProofBytes
  extAmountIn: BN | number | string
  extAmountOut: BN | number | string
  encryptedOutputIn1: Uint8Array
  encryptedOutputIn2: Uint8Array
  encryptedOutputOut1: Uint8Array
  encryptedOutputOut2: Uint8Array
  outMint: PublicKey
  fromMint?: PublicKey | string
  routeData: Buffer | Uint8Array
  routeAccounts: { pubkey: PublicKey; isSigner?: boolean; isWritable: boolean }[]
}

function swapDirection(params: SwapIxParams): {
  solToSpl: boolean
  splMint: PublicKey
  swap: ReturnType<typeof deriveSwapAccounts>
} {
  const fromMint = new PublicKey(params.fromMint ?? WRAPPED_SOL_MINT)
  const toMint = params.outMint
  const solToSpl = isSolMixerMint(fromMint) && !isSolMixerMint(toMint)
  const splMint = solToSpl ? toMint : fromMint
  return { solToSpl, splMint, swap: deriveSwapAccounts(params.programId, splMint) }
}

export function buildSwapIxData(
  params: SwapIxParams,
  jupiterAccountIndices: number[] = [],
): Buffer {
  const inAccounts = deriveAccounts(
    params.programId,
    Uint8Array.from(params.proofIn.inputNullifiers[0]),
    Uint8Array.from(params.proofIn.inputNullifiers[1]),
  )
  const outAccounts = deriveAccounts(
    params.programId,
    Uint8Array.from(params.proofOut.inputNullifiers[0]),
    Uint8Array.from(params.proofOut.inputNullifiers[1]),
  )
  return Buffer.concat([
    SWAP_IX_DISCRIMINATOR,
    serializeProof(params.proofIn),
    serializeProof(params.proofOut),
    i64le(params.extAmountIn),
    i64le(params.extAmountOut),
    Buffer.from([
      inAccounts.bump0,
      inAccounts.bump1,
      outAccounts.bump0,
      outAccounts.bump1,
    ]),
    prefixed(params.encryptedOutputIn1),
    prefixed(params.encryptedOutputIn2),
    prefixed(params.encryptedOutputOut1),
    prefixed(params.encryptedOutputOut2),
    prefixed(params.routeData),
    prefixed(Uint8Array.from(jupiterAccountIndices)),
  ])
}

export function buildSwapInstruction(params: SwapIxParams): {
  ix: TransactionInstruction
} {
  const programId = params.programId
  const { solToSpl, splMint, swap } = swapDirection(params)
  const inN = deriveAccounts(
    programId,
    Uint8Array.from(params.proofIn.inputNullifiers[0]),
    Uint8Array.from(params.proofIn.inputNullifiers[1]),
  )
  const outN = deriveAccounts(
    programId,
    Uint8Array.from(params.proofOut.inputNullifiers[0]),
    Uint8Array.from(params.proofOut.inputNullifiers[1]),
  )
  const inTree = solToSpl ? swap.solTreeAccount : swap.outTreeAccount
  const outTree = solToSpl ? swap.outTreeAccount : swap.solTreeAccount

  const keys: {
    pubkey: PublicKey
    isSigner: boolean
    isWritable: boolean
  }[] = [
    { pubkey: inTree, isSigner: false, isWritable: true },
    { pubkey: inN.nullifier0, isSigner: false, isWritable: true },
    { pubkey: inN.nullifier1, isSigner: false, isWritable: true },
    { pubkey: inN.nullifier2, isSigner: false, isWritable: false },
    { pubkey: inN.nullifier3, isSigner: false, isWritable: false },
    { pubkey: outN.nullifier0, isSigner: false, isWritable: true },
    { pubkey: outN.nullifier1, isSigner: false, isWritable: true },
    { pubkey: outN.nullifier2, isSigner: false, isWritable: false },
    { pubkey: outN.nullifier3, isSigner: false, isWritable: false },
    { pubkey: swap.treeTokenAccount, isSigner: false, isWritable: true },
    { pubkey: outTree, isSigner: false, isWritable: true },
    { pubkey: swap.globalConfig, isSigner: false, isWritable: true },
    { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
    { pubkey: swap.poolWsolAccount, isSigner: false, isWritable: true },
    { pubkey: splMint, isSigner: false, isWritable: false },
    { pubkey: swap.poolSplAccount, isSigner: false, isWritable: true },
    { pubkey: params.signer, isSigner: true, isWritable: true },
    { pubkey: JUPITER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]

  const indexByKey = new Map(keys.map((k, i) => [k.pubkey.toBase58(), i]))
  const jupiterAccountIndices: number[] = []
  for (const account of params.routeAccounts) {
    const id = account.pubkey.toBase58()
    const existing = indexByKey.get(id)
    if (existing !== undefined) {
      if (account.isWritable) keys[existing]!.isWritable = true
      jupiterAccountIndices.push(existing | (account.isWritable ? 0x80 : 0))
      continue
    }
    if (keys.length >= 64) {
      throw new Error(`swap instruction keys exceed entrypoint cap of 64`)
    }
    indexByKey.set(id, keys.length)
    jupiterAccountIndices.push(keys.length | (account.isWritable ? 0x80 : 0))
    keys.push({
      pubkey: account.pubkey,
      isSigner: false,
      isWritable: account.isWritable,
    })
  }

  const unique = new Set(keys.map((k) => k.pubkey.toBase58()))
  unique.add(programId.toBase58())
  if (unique.size > 64) {
    throw new Error(`swap unique keys ${unique.size} exceed v1 cap of 64`)
  }
  return {
    ix: new TransactionInstruction({
      programId,
      keys,
      data: buildSwapIxData(params, jupiterAccountIndices),
    }),
  }
}

export function buildSwapTransaction(
  params: SwapIxParams & {
    blockhash: string
    feePayer?: PublicKey
    computeUnitLimit?: number
  },
): { bytes: Uint8Array; ix: TransactionInstruction } {
  const { solToSpl, splMint, swap } = swapDirection(params)
  const { ix } = buildSwapInstruction(params)
  const payer = params.feePayer ?? params.signer
  const limit = params.computeUnitLimit ?? 1_400_000
  const amountIn = new BN(params.extAmountIn.toString()).abs()
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      swap.poolWsolAccount,
      swap.globalConfig,
      NATIVE_MINT,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      swap.poolSplAccount,
      swap.globalConfig,
      splMint,
    ),
  ]
  if (solToSpl) {
    instructions.push(
      buildWrapSolInstruction({
        programId: params.programId,
        signer: payer,
        amount: amountIn,
      }),
    )
  }
  instructions.push(ix)
  const bytes = compileV1Transaction({
    feePayer: payer,
    blockhash: params.blockhash,
    instructions,
    computeUnitLimit: limit,
  })
  return { bytes, ix }
}

export function buildWrapSolInstruction(params: {
  programId: PublicKey
  signer: PublicKey
  amount: BN | number | string
}): TransactionInstruction {
  const [treeTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TREE_TOKEN)],
    params.programId,
  )
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.GLOBAL_CONFIG)],
    params.programId,
  )
  const poolWsolAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    globalConfig,
    true,
  )
  const amount = Buffer.from(new BN(params.amount.toString()).toArray("le", 8))
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: treeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolWsolAccount, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: params.signer, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([WRAP_SOL_IX_DISCRIMINATOR, amount]),
  })
}
