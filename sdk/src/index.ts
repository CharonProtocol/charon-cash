export { PrivacyCashClient } from "./client"
export type {
  Signer,
  DepositResult,
  WithdrawResult,
  TransferNoteResult,
  SyncResult,
  PendingTransfer,
  OnSubmitted,
} from "./client"
export {
  EncryptionService,
  Keypair,
  Utxo,
  deriveReceiveKeys,
  encryptUtxoTo,
  getExtDataHash,
  getMintAddressField,
} from "./crypto"
export {
  prove,
  parseProofToBytesArray,
  parseToBytesArray,
  setCircuitBuffers,
  setProver,
} from "./prover"
export type { ProverOverride } from "./prover"
export {
  buildTransactTransaction,
  buildTransactIxData,
  buildTransactSplTransaction,
  buildTransactSplInstruction,
  deriveAccounts,
  deriveSplTreeAccount,
} from "./program"
export type { ProofBytes, TransactAccounts } from "./program"
export {
  ensureAlt,
  fetchAlt,
  splAltAddresses,
  envAltAddress,
  cachedAltAddress,
  cacheAltAddress,
} from "./alt"
export type { AltSigner } from "./alt"
export { LocalMirror, readSolTreeState, readTreeState, readGlobalFees } from "./local-provider"
export {
  fetchRelayerInfo,
  fetchBlockhash,
  fetchAltAccount,
  fetchTreeState,
  fetchMerkleProof,
  fetchUtxoRange,
  checkEncryptedOutput,
  waitForLeafIndex,
  waitForEncryptedOutput,
  isNullifierSpent,
  submitTransaction,
  relayWithdraw,
  fetchJupiterRoute,
  relaySwap,
  type JupiterRoute,
  fieldToHex32,
  setBackendUrl,
  getBackendUrl,
  solTreeKey,
  splTreeKey,
  fetchCommitmentLeaf,
} from "./merkle"
export type {
  RelayerInfo,
  BlockhashInfo,
  TreeState,
  MerkleProof,
  IndexedUtxo,
  UtxoRangePage,
  UtxoCheckResult,
} from "./merkle"
export {
  loadNotes,
  unspentNotes,
  saveNote,
  upsertNote,
  markNoteSpent,
  totalBalance,
  exportNotes,
  importNotes,
  clearNotes,
  newNoteId,
  getSyncOffset,
  setSyncOffset,
  resetSyncOffset,
} from "./notes"
export type { Note } from "./notes"
export {
  encryptNotesBlob,
  decryptNotesBlob,
  pushEncryptedNotes,
  pullEncryptedNotes,
  noteBackupMessage,
  noteKeyLinkMessage,
} from "./notestore"
export {
  setOperatorPassword,
  getOperatorPassword,
  verifyOperator,
  operatorInitialize,
  operatorInitializeSpl,
  operatorUpdateConfig,
  operatorUpdateDepositLimit,
  operatorUpdateDepositLimitSpl,
  OperatorError,
  type OperatorResponse,
} from "./admin"
export { publishRecipientKeys, fetchRecipientKeys, fetchRecipientsBatch, type RecipientKeys } from "./recipients"
export {
  FIELD_SIZE,
  MERKLE_TREE_DEPTH,
  RECEIVE_SIGN_MESSAGE,
  SIGN_MESSAGE,
  SOL_TREE_KEY,
  WRAPPED_SOL_MINT,
} from "./constants"

export { compressG1, compressG2 } from "./compress"
export { rememberUnlockSigner } from "./session"
