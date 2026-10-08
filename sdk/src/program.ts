import { LightWasm } from "@lightprotocol/hasher.rs";
import { API } from "./api";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  sendAndConfirmRawTransaction,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Utxo } from "./model/utxo";
import {
  ALT_ADDRESS,
  DEPOSIT_FEE_RATE,
  FEE_RECIPIENT,
  FIELD_SIZE,
  MERKLE_TREE_DEPTH,
  PROGRAM_ID,
} from "./constants";
import BN from "bn.js";
import { EncryptionService } from "./encrypt";
import {
  bytesToBN,
  deriveAccounts,
  ExtData,
  getExtDataHash,
  getMintAddressField,
  serializeProofAndExtData,
} from "./utils";
import { CircuitParams, parseToBytesArray, ProofBytes, prove } from "./prover";
import { CharonProtocolError, CharonProtocolErrorCode } from "./error";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

export class ProgramError extends CharonProtocolError {
  programErrorCode: ProgramErrorCode | undefined;
  constructor(
    message: string,
    programErrorCode: ProgramErrorCode | undefined = undefined,
    options?: { cause: unknown },
  ) {
    super(message, CharonProtocolErrorCode.PROGRAM_ERROR, {
      cause: options?.cause,
    });

    this.name = "ProgramError";
    this.programErrorCode = programErrorCode;

    Object.setPrototypeOf(this, ProgramError.prototype);
  }
}

export enum ProgramErrorCode {
  Unauthorized = "Unauthorized",
  InvalidMintAddress = "InvalidMintAddress",
  InvalidMerkleTreeHeight = "InvalidMerkleTreeHeight",
  InvalidRootHistorySize = "InvalidRootHistorySize",
  InvalidFeeRate = "InvalidFeeRate",
  UnknownRoot = "UnknownRoot",
  ExtDataHashMismatch = "ExtDataHashMismatch",
  InvalidPublicAmountData = "InvalidPublicAmountData",
  DepositLimitExceeded = "DepositLimitExceeded",
  InsufficientFundsForWithdrawal = "InsufficientFundsForWithdrawal",
  InsufficientFundsForFee = "InsufficientFundsForFee",
  InvalidFeeAmount = "InvalidFeeAmount",
  InvalidTokenAccount = "InvalidTokenAccount",
  InvalidTokenAccountMintAddress = "InvalidTokenAccountMintAddress",
  InvalidProof = "InvalidProof",
  InvalidMerkleTreeAccount = "InvalidMerkleTreeAccount",
}

export type TransactArgs = {
  inputUtxos: Utxo[];
  extAmount: BN;
  fee: BN;
  mintAddress: string;
  recipientKey: string;
  lightwasm: LightWasm;
  encryptionService: EncryptionService;
  signer: PublicKey;
  connection: Connection;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
};

export type TransferArgs = {
  inputUtxos: Utxo[];
  transferAmount: BN;
  fee: BN;
  mintAddress: string;
  recipientKey: string;
  lightwasm: LightWasm;
  encryptionService: EncryptionService;
  signer: PublicKey;
  connection: Connection;

  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
};

export async function transactSol({
  inputUtxos,
  extAmount,
  fee,
  mintAddress,
  lightwasm,
  recipientKey,
  encryptionService,
  signer,
  connection,
  signTransaction,
}: TransactArgs) {
  if (inputUtxos.length != 2) {
    throw new ProgramError("Invalid number of input utxos , only 2 allowed");
  }

  let publicAmount: BN;

  if (extAmount.isNeg()) {
    // withdraw

    publicAmount = extAmount.sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE);
  } else {
    // send
    publicAmount = extAmount.add(FIELD_SIZE).mod(FIELD_SIZE);
  }

  let recipientViewingKey: Uint8Array;

  if (extAmount.isNeg()) {
    // withdraw
    recipientViewingKey = encryptionService.getViewingKey();
  } else {
    // send
    recipientViewingKey = await API.fetchRecipientViewingKey(
      new PublicKey(recipientKey),
    );
  }

  let change: BN;

  if (extAmount.isNeg()) {
    // withdraw
    const totalInputs: BN = inputUtxos.reduce(
      (prev, n) => n.amount.add(prev),
      new BN(0),
    );

    let amountInLamports = extAmount.abs().add(fee);
    change = totalInputs.sub(new BN(amountInLamports));
  } else {
    // send
    change = publicAmount;
  }

  let { root, proofs, nextIndex } = await API.fetchMerkleProof(
    mintAddress,
    [inputUtxos[0].index, inputUtxos[1].index],
    inputUtxos.map((u) => u.getCommitment()),
  );

  let outputUtxos = [
    new Utxo({
      lightWasm: lightwasm,
      amount: 0,
      index: Number(nextIndex),
      mintAddress: inputUtxos[0].mintAddress,
    }),
    new Utxo({
      lightWasm: lightwasm,
      amount: change,
      index: Number(nextIndex) + 1,
      mintAddress: inputUtxos[0].mintAddress,
    }),
  ];

  const encryptedOutput1 = await encryptionService.encrypt(
    outputUtxos[0].serialize(),
    recipientViewingKey,
  );
  const encryptedOutput2 = await encryptionService.encrypt(
    outputUtxos[1].serialize(),
    recipientViewingKey,
  );

  let recipient = extAmount.isNeg() ? signer : FEE_RECIPIENT;
  const extData: ExtData = {
    // recipient - just a placeholder, not actually used for deposits.
    recipient: recipient.toString(), // Using fee recipient as dummy recipient for deposit,
    extAmount: extAmount,
    encryptedOutput1: encryptedOutput1,
    encryptedOutput2: encryptedOutput2,
    fee,
    feeRecipient: FEE_RECIPIENT,
    mintAddress: mintAddress,
  };

  const extDataHash = getExtDataHash(extData);

  const circuitInput: CircuitParams = {
    root: bytesToBN(root).toString(),
    inputNullifier: inputUtxos.map((x) => x.getNullifier()),
    outputCommitment: outputUtxos.map((x) => x.getCommitment()),
    publicAmount: publicAmount.toString(),
    extDataHash: extDataHash,

    // inputs
    inAmount: inputUtxos.map((x) => x.amount.toString(10)),
    inPrivateKey: inputUtxos.map((x) => x.keypair.privkey),
    inBlinding: inputUtxos.map((x) => x.blinding.toString(10)),
    inPathIndices: inputUtxos.map((x) => x.index),
    inPathElements: proofs.map((path) =>
      path.map((node) => bytesToBN(node).toString()),
    ),

    // outputs
    outAmount: outputUtxos.map((x) => x.amount.toString(10)),
    outBlinding: outputUtxos.map((x) => x.blinding.toString(10)),
    outPubkey: outputUtxos.map((x) => x.keypair.pubkey),

    mintAddress: getMintAddressField(new PublicKey(mintAddress)),
  };

  const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
  const inputBytes = parseToBytesArray(publicSignals);
  const proofToSubmit: ProofBytes = {
    proofA: proofA,
    proofB: proofB,
    proofC: proofC,
    root: inputBytes[0],
    publicAmount: inputBytes[1],
    extDataHash: inputBytes[2],
    inputNullifiers: [inputBytes[3], inputBytes[4]],
    outputCommitments: [inputBytes[5], inputBytes[6]],
  };

  const programAccounts = deriveAccounts(
    PROGRAM_ID,
    Uint8Array.from(proofToSubmit.inputNullifiers[0]),
    Uint8Array.from(proofToSubmit.inputNullifiers[1]),
  );

  const ixData = serializeProofAndExtData(
    proofToSubmit,
    extData,
    false,
    programAccounts.bump0,
    programAccounts.bump1,
  );

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      {
        pubkey: programAccounts.treeAccount,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier0,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier1,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier2,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: programAccounts.nullifier3,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: programAccounts.treeTokenAccount,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.globalConfig,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: extAmount.isNeg() ? signer : FEE_RECIPIENT,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  const addressLookTable = (await connection.getAddressLookupTable(ALT_ADDRESS))
    .value!;

  if (!addressLookTable) {
    throw new Error("Lookup table not found or not yet active");
  }
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000,
  });

  const messageV0 = new TransactionMessage({
    instructions: [limitIx, ix],
    payerKey: signer,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
  }).compileToV0Message([addressLookTable]);

  let versionedTransaction = new VersionedTransaction(messageV0);

  console.log("Size", versionedTransaction.serialize().length);
  let signedTx = await signTransaction(versionedTransaction);

  try {
    let txid = await sendAndConfirmRawTransaction(
      connection,
      Buffer.from(signedTx.serialize()),
      {
        commitment: "finalized",
      },
    );
    return txid;
  } catch (error) {
    if (error instanceof SendTransactionError) {
      let logs = error.logs;

      let programErrorCode = undefined;

      for (let code of Object.values(ProgramErrorCode)) {
        let found = logs?.some((line) => line.includes(code));

        if (found) {
          programErrorCode = code;
          break;
        }
      }

      throw new ProgramError(error.message, programErrorCode, { cause: error });
    }

    throw new ProgramError("Transaction Failed", undefined, { cause: error });
  }
}

/// This is done for convenience , could be implemented in transactSol itself but making in comprehensible
export async function shieldedTransferSol({
  inputUtxos,
  transferAmount,
  fee,
  mintAddress,
  lightwasm,
  recipientKey,
  encryptionService,
  signer,
  connection,
  signTransaction,
}: TransferArgs) {
  if (inputUtxos.length != 2) {
    throw new ProgramError("Invalid number of input utxos , only 2 allowed");
  }

  // Since Public Amount represent the amount coming in and out of pool , it will be zero
  let publicAmount = new BN(0);

  // recipient X25519 key needed to encrypt the notes
  let recipientViewingKey: Uint8Array;
  recipientViewingKey = await API.fetchRecipientViewingKey(
    new PublicKey(recipientKey),
  );

  // Change that will remain for the user after transaction
  let change: BN;
  const totalInputs: BN = inputUtxos.reduce(
    (prev, n) => n.amount.add(prev),
    new BN(0),
  );

  let netAmount = transferAmount.abs().sub(fee);
  // change has to be encrypted for signer
  change = totalInputs.sub(new BN(netAmount));

  // Get the Merkle Proof for the notes needed to be sent
  let { root, proofs, nextIndex } = await API.fetchMerkleProof(
    mintAddress,
    [inputUtxos[0].index, inputUtxos[1].index],
    inputUtxos.map((u) => u.getCommitment()),
  );

  let outputUtxos = [
    new Utxo({
      lightWasm: lightwasm,
      amount: netAmount,
      index: Number(nextIndex),
      mintAddress: inputUtxos[0].mintAddress,
    }),
    new Utxo({
      lightWasm: lightwasm,
      amount: change,
      index: Number(nextIndex) + 1,
      mintAddress: inputUtxos[0].mintAddress,
    }),
  ];

  // This represent note generate for the recipient
  const encryptedOutput1 = await encryptionService.encrypt(
    outputUtxos[0].serialize(),
    recipientViewingKey,
  );

  // any change should get back to the sender appropriately
  const encryptedOutput2 = await encryptionService.encrypt(
    outputUtxos[1].serialize(),
    encryptionService.getViewingKey(),
  );

  let recipient = recipientKey;
  const extData: ExtData = {
    // recipient - just a placeholder, not actually used for deposits.
    recipient: FEE_RECIPIENT, // Using fee recipient as dummy recipient for deposit,
    extAmount: new BN(0),
    encryptedOutput1: encryptedOutput1,
    encryptedOutput2: encryptedOutput2,
    fee,
    feeRecipient: FEE_RECIPIENT,
    mintAddress: mintAddress,
  };

  const extDataHash = getExtDataHash(extData);

  const circuitInput: CircuitParams = {
    root: bytesToBN(root).toString(),
    inputNullifier: inputUtxos.map((x) => x.getNullifier()),
    outputCommitment: outputUtxos.map((x) => x.getCommitment()),
    publicAmount: publicAmount.toString(),
    extDataHash: extDataHash,

    // inputs
    inAmount: inputUtxos.map((x) => x.amount.toString(10)),
    inPrivateKey: inputUtxos.map((x) => x.keypair.privkey),
    inBlinding: inputUtxos.map((x) => x.blinding.toString(10)),
    inPathIndices: inputUtxos.map((x) => x.index),
    inPathElements: proofs.map((path) =>
      path.map((node) => bytesToBN(node).toString()),
    ),

    // outputs
    outAmount: outputUtxos.map((x) => x.amount.toString(10)),
    outBlinding: outputUtxos.map((x) => x.blinding.toString(10)),
    outPubkey: outputUtxos.map((x) => x.keypair.pubkey),

    mintAddress: getMintAddressField(new PublicKey(mintAddress)),
  };

  const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
  const inputBytes = parseToBytesArray(publicSignals);
  const proofToSubmit: ProofBytes = {
    proofA: proofA,
    proofB: proofB,
    proofC: proofC,
    root: inputBytes[0],
    publicAmount: inputBytes[1],
    extDataHash: inputBytes[2],
    inputNullifiers: [inputBytes[3], inputBytes[4]],
    outputCommitments: [inputBytes[5], inputBytes[6]],
  };

  const programAccounts = deriveAccounts(
    PROGRAM_ID,
    Uint8Array.from(proofToSubmit.inputNullifiers[0]),
    Uint8Array.from(proofToSubmit.inputNullifiers[1]),
  );

  const ixData = serializeProofAndExtData(
    proofToSubmit,
    extData,
    false,
    programAccounts.bump0,
    programAccounts.bump1,
  );

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      {
        pubkey: programAccounts.treeAccount,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier0,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier1,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier2,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: programAccounts.nullifier3,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: programAccounts.treeTokenAccount,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.globalConfig,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: FEE_RECIPIENT,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  const addressLookTable = (await connection.getAddressLookupTable(ALT_ADDRESS))
    .value!;

  if (!addressLookTable) {
    throw new Error("Lookup table not found or not yet active");
  }
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000,
  });

  const messageV0 = new TransactionMessage({
    instructions: [limitIx, ix],
    payerKey: signer,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
  }).compileToV0Message([addressLookTable]);

  let versionedTransaction = new VersionedTransaction(messageV0);
  let signedTx = await signTransaction(versionedTransaction);

  try {
    let txid = await sendAndConfirmRawTransaction(
      connection,
      Buffer.from(signedTx.serialize()),
      {
        commitment: "finalized",
      },
    );
    return txid;
  } catch (error) {
    if (error instanceof SendTransactionError) {
      let logs = error.logs;

      let programErrorCode = undefined;

      for (let code of Object.values(ProgramErrorCode)) {
        let found = logs?.some((line) => line.includes(code));

        if (found) {
          programErrorCode = code;
          break;
        }
      }

      throw new ProgramError(error.message, programErrorCode, { cause: error });
    }

    throw new ProgramError("Transaction Failed", undefined, { cause: error });
  }
}

export async function transactSpl({
  inputUtxos,
  extAmount,
  fee,
  mintAddress,
  lightwasm,
  recipientKey,
  encryptionService,
  signer,
  connection,
  signTransaction,
}: TransactArgs) {
  if (inputUtxos.length != 2) {
    throw new ProgramError("Invalid number of input utxos , only 2 allowed");
  }

  const signerAta = await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    signer,
  );

  let publicAmount: BN;

  if (extAmount.isNeg()) {
    // withdraw

    publicAmount = extAmount.sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE);
  } else {
    // send
    publicAmount = extAmount.add(FIELD_SIZE).mod(FIELD_SIZE);
  }

  let recipientViewingKey: Uint8Array;

  if (extAmount.isNeg()) {
    // withdraw
    recipientViewingKey = encryptionService.getViewingKey();
  } else {
    // send
    recipientViewingKey = await API.fetchRecipientViewingKey(
      new PublicKey(recipientKey),
    );
  }

  let change: BN;

  if (extAmount.isNeg()) {
    // withdraw
    const totalInputs: BN = inputUtxos.reduce(
      (prev, n) => n.amount.add(prev),
      new BN(0),
    );

    let netAmount = extAmount.abs().add(fee);
    change = totalInputs.sub(new BN(netAmount));
  } else {
    // send
    change = publicAmount;
  }

  let { root, proofs, nextIndex } = await API.fetchMerkleProof(
    mintAddress,
    [inputUtxos[0].index, inputUtxos[1].index],
    inputUtxos.map((u) => u.getCommitment()),
  );

  let outputUtxos = [
    new Utxo({
      lightWasm: lightwasm,
      amount: 0,
      index: Number(nextIndex),
      mintAddress: inputUtxos[0].mintAddress,
    }),
    new Utxo({
      lightWasm: lightwasm,
      amount: change,
      index: Number(nextIndex) + 1,
      mintAddress: inputUtxos[0].mintAddress,
    }),
  ];

  const encryptedOutput1 = await encryptionService.encrypt(
    outputUtxos[0].serialize(),
    recipientViewingKey,
  );
  const encryptedOutput2 = await encryptionService.encrypt(
    outputUtxos[1].serialize(),
    recipientViewingKey,
  );

  const feeRecipientAta = await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    FEE_RECIPIENT,
  );

  let recipientAta = extAmount.isNeg() ? signerAta : feeRecipientAta;
  const extData: ExtData = {
    recipient: recipientAta,
    extAmount: extAmount,
    encryptedOutput1: encryptedOutput1,
    encryptedOutput2: encryptedOutput2,
    fee,
    feeRecipient: feeRecipientAta,
    mintAddress: mintAddress,
  };

  const extDataHash = getExtDataHash(extData);

  const circuitInput: CircuitParams = {
    root: bytesToBN(root).toString(),
    inputNullifier: inputUtxos.map((x) => x.getNullifier()),
    outputCommitment: outputUtxos.map((x) => x.getCommitment()),
    publicAmount: publicAmount.toString(),
    extDataHash: extDataHash,

    // inputs
    inAmount: inputUtxos.map((x) => x.amount.toString(10)),
    inPrivateKey: inputUtxos.map((x) => x.keypair.privkey),
    inBlinding: inputUtxos.map((x) => x.blinding.toString(10)),
    inPathIndices: inputUtxos.map((x) => x.index),
    inPathElements: proofs.map((path) =>
      path.map((node) => bytesToBN(node).toString()),
    ),

    // outputs
    outAmount: outputUtxos.map((x) => x.amount.toString(10)),
    outBlinding: outputUtxos.map((x) => x.blinding.toString(10)),
    outPubkey: outputUtxos.map((x) => x.keypair.pubkey),

    mintAddress: getMintAddressField(new PublicKey(mintAddress)),
  };

  const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
  const inputBytes = parseToBytesArray(publicSignals);
  const proofToSubmit: ProofBytes = {
    proofA: proofA,
    proofB: proofB,
    proofC: proofC,
    root: inputBytes[0],
    publicAmount: inputBytes[1],
    extDataHash: inputBytes[2],
    inputNullifiers: [inputBytes[3], inputBytes[4]],
    outputCommitments: [inputBytes[5], inputBytes[6]],
  };

  const programAccounts = deriveAccounts(
    PROGRAM_ID,
    Uint8Array.from(proofToSubmit.inputNullifiers[0]),
    Uint8Array.from(proofToSubmit.inputNullifiers[1]),
    new PublicKey(mintAddress),
  );

  const ixData = serializeProofAndExtData(
    proofToSubmit,
    extData,
    true,
    programAccounts.bump0,
    programAccounts.bump1,
  );

  const treeTokenAta = await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    programAccounts.globalConfig,
    true,
  );

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      {
        pubkey: programAccounts.treeAccount,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier0,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier1,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier2,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: programAccounts.nullifier3,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: programAccounts.globalConfig,
        isSigner: false,
        isWritable: false,
      },
      // signer
      { pubkey: signer, isSigner: true, isWritable: true },
      // spl token mint
      {
        pubkey: new PublicKey(mintAddress),
        isSigner: false,
        isWritable: false,
      },
      // signer's token account
      { pubkey: signerAta, isSigner: false, isWritable: true },
      // recipient based on amount
      {
        pubkey: extAmount.isNeg() ? signer : FEE_RECIPIENT,
        isSigner: false,
        isWritable: true,
      },
      // recipientAta
      {
        pubkey: extAmount.isNeg() ? signerAta : feeRecipientAta,
        isSigner: false,
        isWritable: true,
      },
      // tree ata
      {
        pubkey: treeTokenAta,
        isSigner: false,
        isWritable: true,
      },

      { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  const addressLookTable = (await connection.getAddressLookupTable(ALT_ADDRESS))
    .value!;

  if (!addressLookTable) {
    throw new Error("Lookup table not found or not yet active");
  }
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000,
  });

  const messageV0 = new TransactionMessage({
    instructions: [limitIx, ix],
    payerKey: signer,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
  }).compileToV0Message([addressLookTable]);

  let versionedTransaction = new VersionedTransaction(messageV0);

  let signedTx = await signTransaction(versionedTransaction);

  try {
    let txid = await sendAndConfirmRawTransaction(
      connection,
      Buffer.from(signedTx.serialize()),
      {
        commitment: "finalized",
      },
    );
    return txid;
  } catch (error) {
    if (error instanceof SendTransactionError) {
      let logs = error.logs;

      let programErrorCode = undefined;

      for (let code of Object.values(ProgramErrorCode)) {
        let found = logs?.some((line) => line.includes(code));

        if (found) {
          programErrorCode = code;
          break;
        }
      }

      throw new ProgramError(error.message, programErrorCode, { cause: error });
    }

    throw new ProgramError("Transaction Failed", undefined, { cause: error });
  }
}

/**
 * This does shielded transfer for spl tokens.
 *
 * @param param0
 * @returns
 */
export async function shieldedTransferSpl({
  inputUtxos,
  transferAmount,
  fee,
  mintAddress,
  lightwasm,
  recipientKey,
  encryptionService,
  signer,
  connection,
  signTransaction,
}: TransferArgs) {
  if (inputUtxos.length != 2) {
    throw new ProgramError("Invalid number of input utxos , only 2 allowed");
  }

  const signerAta = await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    signer,
  );

  // Since Public Amount represent the amount coming in and out of pool , it will be zero
  let publicAmount: BN;
  publicAmount = new BN(0);

  // recipient X25519 key needed to encrypt the notes
  let recipientViewingKey: Uint8Array;
  recipientViewingKey = await API.fetchRecipientViewingKey(
    new PublicKey(recipientKey),
  );

  // Change that will remain for the user after transaction
  let change: BN;
  const totalInputs: BN = inputUtxos.reduce(
    (prev, n) => n.amount.add(prev),
    new BN(0),
  );

  let netAmount = transferAmount.abs().sub(fee);
  change = totalInputs.sub(new BN(netAmount));

  // Get the Merkle Proof for the notes needed to be sent
  let { root, proofs, nextIndex } = await API.fetchMerkleProof(
    mintAddress,
    [inputUtxos[0].index, inputUtxos[1].index],
    inputUtxos.map((u) => u.getCommitment()),
  );

  let outputUtxos = [
    new Utxo({
      lightWasm: lightwasm,
      amount: netAmount,
      index: Number(nextIndex),
      mintAddress: inputUtxos[0].mintAddress,
    }),
    new Utxo({
      lightWasm: lightwasm,
      amount: change,
      index: Number(nextIndex) + 1,
      mintAddress: inputUtxos[0].mintAddress,
    }),
  ];

  // This represent note generate for the recipient
  const encryptedOutput1 = await encryptionService.encrypt(
    outputUtxos[0].serialize(),
    recipientViewingKey,
  );

  // This is the remaining change for the user
  const encryptedOutput2 = await encryptionService.encrypt(
    outputUtxos[1].serialize(),
    encryptionService.getViewingKey(),
  );

  const feeRecipientAta = await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    FEE_RECIPIENT,
  );

  const extData: ExtData = {
    recipient: feeRecipientAta,
    extAmount: new BN(0),
    encryptedOutput1: encryptedOutput1,
    encryptedOutput2: encryptedOutput2,
    fee,
    feeRecipient: feeRecipientAta,
    mintAddress: mintAddress,
  };

  const extDataHash = getExtDataHash(extData);

  const circuitInput: CircuitParams = {
    root: bytesToBN(root).toString(),
    inputNullifier: inputUtxos.map((x) => x.getNullifier()),
    outputCommitment: outputUtxos.map((x) => x.getCommitment()),
    publicAmount: publicAmount.toString(),
    extDataHash: extDataHash,

    // inputs
    inAmount: inputUtxos.map((x) => x.amount.toString(10)),
    inPrivateKey: inputUtxos.map((x) => x.keypair.privkey),
    inBlinding: inputUtxos.map((x) => x.blinding.toString(10)),
    inPathIndices: inputUtxos.map((x) => x.index),
    inPathElements: proofs.map((path) =>
      path.map((node) => bytesToBN(node).toString()),
    ),

    // outputs
    outAmount: outputUtxos.map((x) => x.amount.toString(10)),
    outBlinding: outputUtxos.map((x) => x.blinding.toString(10)),
    outPubkey: outputUtxos.map((x) => x.keypair.pubkey),

    mintAddress: getMintAddressField(new PublicKey(mintAddress)),
  };

  const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
  const inputBytes = parseToBytesArray(publicSignals);
  const proofToSubmit: ProofBytes = {
    proofA: proofA,
    proofB: proofB,
    proofC: proofC,
    root: inputBytes[0],
    publicAmount: inputBytes[1],
    extDataHash: inputBytes[2],
    inputNullifiers: [inputBytes[3], inputBytes[4]],
    outputCommitments: [inputBytes[5], inputBytes[6]],
  };

  const programAccounts = deriveAccounts(
    PROGRAM_ID,
    Uint8Array.from(proofToSubmit.inputNullifiers[0]),
    Uint8Array.from(proofToSubmit.inputNullifiers[1]),
    new PublicKey(mintAddress),
  );

  const ixData = serializeProofAndExtData(
    proofToSubmit,
    extData,
    true,
    programAccounts.bump0,
    programAccounts.bump1,
  );

  const treeTokenAta = await getAssociatedTokenAddress(
    new PublicKey(mintAddress),
    programAccounts.globalConfig,
    true,
  );

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      {
        pubkey: programAccounts.treeAccount,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier0,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier1,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: programAccounts.nullifier2,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: programAccounts.nullifier3,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: programAccounts.globalConfig,
        isSigner: false,
        isWritable: false,
      },
      // signer
      { pubkey: signer, isSigner: true, isWritable: true },

      // spl token mint
      {
        pubkey: new PublicKey(mintAddress),
        isSigner: false,
        isWritable: false,
      },
      // signer's token account
      { pubkey: signerAta, isSigner: false, isWritable: true },
      // recipient based on amount
      {
        pubkey: FEE_RECIPIENT,
        isSigner: false,
        isWritable: true,
      },
      // recipientAta
      {
        pubkey: feeRecipientAta,
        isSigner: false,
        isWritable: true,
      },
      // tree ata
      {
        pubkey: treeTokenAta,
        isSigner: false,
        isWritable: true,
      },

      { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  const addressLookTable = (await connection.getAddressLookupTable(ALT_ADDRESS))
    .value!;

  if (!addressLookTable) {
    throw new Error("Lookup table not found or not yet active");
  }
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000,
  });

  const messageV0 = new TransactionMessage({
    instructions: [limitIx, ix],
    payerKey: signer,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
  }).compileToV0Message([addressLookTable]);

  let versionedTransaction = new VersionedTransaction(messageV0);
  let signedTx = await signTransaction(versionedTransaction);

  try {
    let txid = await sendAndConfirmRawTransaction(
      connection,
      Buffer.from(signedTx.serialize()),
      {
        commitment: "finalized",
      },
    );
    return txid;
  } catch (error) {
    if (error instanceof SendTransactionError) {
      let logs = error.logs;

      let programErrorCode = undefined;

      for (let code of Object.values(ProgramErrorCode)) {
        let found = logs?.some((line) => line.includes(code));

        if (found) {
          programErrorCode = code;
          break;
        }
      }

      throw new ProgramError(error.message, programErrorCode, { cause: error });
    }

    throw new ProgramError("Transaction Failed", undefined, { cause: error });
  }
}
