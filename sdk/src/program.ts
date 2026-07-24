import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import BN from "bn.js"

import { DISC_TRANSACT, DISC_TRANSACT_SPL, SEED } from "./constants"

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
  connection: Connection
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

  const { blockhash } = await params.connection.getLatestBlockhash()
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
  const { blockhash } = await params.connection.getLatestBlockhash()
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
