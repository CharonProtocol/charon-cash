export { PrivacyCashClient } from "./client"
export type {
  Signer,
  DepositResult,
  WithdrawResult,
  SyncResult,
} from "./client"
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
  setCircuitBuffers,
} from "./prover"
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
  fieldToHex32,
  setBackendUrl,
  getBackendUrl,
  solTreeKey,
  splTreeKey,
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
export {
  FIELD_SIZE,
  MERKLE_TREE_DEPTH,
  SIGN_MESSAGE,
  SOL_TREE_KEY,
  WRAPPED_SOL_MINT,
} from "./constants"
