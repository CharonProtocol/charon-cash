import * as s from "privacy-cash-sdk"
import { AddressLookupTableAccount } from "@solana/web3.js"
console.log(["deriveAccounts","encryptUtxoTo","Utxo","EncryptionService","parseProofToBytesArray","parseToBytesArray","fetchMerkleProof","fetchTreeState","submitTransaction","publishRecipientKeys","fetchRecipientKeys","FIELD_SIZE","MERKLE_TREE_DEPTH","getMintAddressField","fetchBlockhash","fetchRelayerInfo","SOL_TREE_KEY","setProver","setBackendUrl"].map(k=>k+":"+(typeof s[k])).join(" "))
console.log("web3 ALT:", typeof AddressLookupTableAccount)
