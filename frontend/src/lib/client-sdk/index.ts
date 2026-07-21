export { PrivacyCashClient } from "./client"
export type { Signer, DepositResult, WithdrawResult } from "./client"
export {
  EncryptionService,
  Keypair,
  Utxo,
  getExtDataHash,
  getMintAddressField,
} from "./crypto"
export {
  prove,
  parseProofToBytesArray,
  parseToBytesArray,
} from "./prover"
export {
  buildTransactTransaction,
  buildTransactIxData,
  deriveAccounts,
} from "./program"
export type { ProofBytes, TransactAccounts } from "./program"
export {
  fetchRelayerInfo,
  fetchTreeState,
  fetchMerkleProof,
  isNullifierSpent,
} from "./merkle"
export type { RelayerInfo, TreeState, MerkleProof } from "./merkle"
export {
  loadNotes,
  unspentNotes,
  saveNote,
  markNoteSpent,
  totalBalance,
  exportNotes,
  importNotes,
  clearNotes,
  newNoteId,
} from "./notes"
export type { Note } from "./notes"
export {
  FIELD_SIZE,
  MERKLE_TREE_DEPTH,
  SIGN_MESSAGE,
  SOL_TREE_KEY,
  WRAPPED_SOL_MINT,
} from "./constants"
