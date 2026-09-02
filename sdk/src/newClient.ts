import {
  AddressLookupTableAccount,
  Connection,
  ProgramAccountSubscriptionConfig,
  PublicKey,
  sendAndConfirmRawTransaction,
  sendAndConfirmTransaction,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { EncryptionService } from "./encrypt";
import { StorageService, StoredNoteSchema } from "./storage";
import { Utxo } from "./model/utxo";
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";
import BN from "bn.js";
import {
  ALT_ADDRESS,
  DEPOSIT_FEE_RATE,
  FEE_RECIPIENT,
  FIELD_SIZE,
  MERKLE_TREE_DEPTH,
  PROGRAM_ID,
  SOL_MINT,
  WITHDRAW_FEE_RATE,
} from "./constants";
import { register } from "module";
import {
  checkRegistration,
  fetchMerkleProofForLeaves,
  fetchRecipientViewingKey,
  fetchTreeState,
  registerUserInfo,
  RegistrationInfo,
} from "./api";
import {
  buildMerkleCircuitInputs,
  bytesToBN,
  CircuitParams,
  deriveAccounts,
  ExtData,
  serializeProofAndExtData,
} from "./utils";
import { parseProofToBytesArray, parseToBytesArray, prove } from "./prover";
import { ProofBytes, getExtDataHash } from "./utils";

export interface Signer {
  publicKey: PublicKey;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}

export const SIGN_MESSAGE = "Privacy Money account sign in";

type SanitizedNote = {
  note_id: number; // this corresponds to client side storage ID
  walletPubkey: string;
  amount: BN;
};

type NotesInfo = {
  maxAmountInSingleTransaction: BN;
  totalAmount: BN;
  notes: SanitizedNote[];
};

export class SilentPay {
  private connection: Connection;
  public publicKey: PublicKey;
  private encryptionService: EncryptionService;
  private signer: Signer;
  private storageService: StorageService;
  private isRuning?: boolean = false;
  private lightwasm: LightWasm;

  mintToNotesMap: Map<string, NotesInfo>;
  lastLoadedNote: number;
  worker: Worker;

  private constructor({
    connection,
    publicKey,
    signer,
    storageService,
    encryptionService,
    isRuning,
    lightwasm,
    mintToNotesMap,
    lastLoadedNote,
    worker,
  }: {
    connection: Connection;
    publicKey: PublicKey;
    signer: Signer;
    storageService: StorageService;
    encryptionService: EncryptionService;
    isRuning: boolean;
    lightwasm: LightWasm;
    mintToNotesMap: Map<string, NotesInfo>;
    lastLoadedNote: number;
    worker: Worker;
  }) {
    this.publicKey = publicKey;
    this.signer = signer;
    this.storageService = storageService;
    this.encryptionService = encryptionService;
    this.isRuning = isRuning;
    this.connection = connection;
    this.lightwasm = lightwasm;
    this.mintToNotesMap = mintToNotesMap;
    this.lastLoadedNote = lastLoadedNote;
    this.worker = worker;

    worker.addEventListener("message", (event) => {
      if (event.data.type === "syncNotes") {
        this.syncNotes();
      }
    });
  }

  static async generateClient({
    RPC_url,
    owner,
  }: {
    RPC_url: string;
    owner: Signer;
    API_URL: string;
  }) {
    const isRegistered = await checkRegistration(owner.publicKey);

    const masterSeed = await owner.signMessage(
      new TextEncoder().encode(SIGN_MESSAGE),
    );

    const encryptionService =
      await EncryptionService.startEncryptionService(masterSeed);

    if (!isRegistered.data) {
      const viewingKey = encryptionService.getViewingKey();
      const data: RegistrationInfo = {
        wallet_pubkey: owner.publicKey,
        viewing_pubkey: viewingKey,
      };
      await registerUserInfo(data);
    }

    const lightwasm = await WasmFactory.getInstance();

    const storageService = await StorageService.start();
    // fetch all the notes from local storage and keep them in memory
    let storedNotes = await storageService.loadNotes(
      owner.publicKey.toString(),
    );

    let lastLoadedNote = storedNotes[storedNotes.length - 1].id;

    let mintToNotesMap = new Map<string, NotesInfo>();

    await Promise.all(
      storedNotes.map(
        async ({
          encryptedNote,
          id,
          walletPubkey,
        }: StoredNoteSchema): Promise<undefined> => {
          const decryptedNote = Utxo.deserialize(
            await encryptionService.decrypt(encryptedNote),
            lightwasm,
          );

          if (!mintToNotesMap.has(decryptedNote.mintAddress)) {
            let newNotesInfo: NotesInfo = {
              totalAmount: new BN(0),
              maxAmountInSingleTransaction: new BN(0),
              notes: [],
            };

            mintToNotesMap.set(decryptedNote.mintAddress, newNotesInfo);
          }

          let requiredNotesInfo = mintToNotesMap.get(
            decryptedNote.mintAddress,
          )!;

          requiredNotesInfo.totalAmount = requiredNotesInfo.totalAmount.add(
            decryptedNote.amount.abs(),
          );

          let newNote: SanitizedNote = {
            note_id: id!,
            walletPubkey,
            amount: decryptedNote.amount,
          };
          requiredNotesInfo.notes.push(newNote);
        },
      ),
    );

    mintToNotesMap.forEach((notesInfo) => {
      notesInfo.notes.sort((a, b) => a.amount.sub(b.amount).toNumber());

      let n = notesInfo.notes.length;
      notesInfo.maxAmountInSingleTransaction = notesInfo.notes[
        n - 1
      ].amount.add(notesInfo.notes[n - 2].amount);
    });

    let connection = new Connection(RPC_url);

    let worker = createSilentPayWorker(owner.publicKey.toString(), masterSeed);

    return new SilentPay({
      connection,
      publicKey: owner.publicKey,
      signer: owner,
      storageService,
      encryptionService,
      isRuning: true,
      lightwasm,
      mintToNotesMap,
      lastLoadedNote,
      worker,
    });
  }

  async sendSol(
    amountInLamports: number,
    mintAddress: string,
    recipientKey: string,
  ) {
    let inputUtxos = [
      new Utxo({ lightWasm: this.lightwasm, mintAddress }),
      new Utxo({ lightWasm: this.lightwasm, mintAddress }),
    ];

    const fee = new BN(
      Math.ceil((amountInLamports * DEPOSIT_FEE_RATE) / 10000),
    );
    let extAmount = new BN(amountInLamports).sub(fee);

    // sumINs + publicAmount = sumOuts
    let publicAmount = extAmount.add(FIELD_SIZE).mod(FIELD_SIZE);

    let treeState = await fetchTreeState(mintAddress);
    const recipientViewingKey = await fetchRecipientViewingKey(
      new PublicKey(recipientKey),
    );

    let outputUtxos = [
      new Utxo({
        lightWasm: this.lightwasm,
        amount: publicAmount,
        index: treeState.nextLeafIndex.toNumber(),
        mintAddress,
      }),
      new Utxo({
        lightWasm: this.lightwasm,
        amount: 0,
        index: treeState.nextLeafIndex.toNumber() + 1,
        mintAddress,
      }),
    ];

    const encryptedOutput1 = await this.encryptionService.encrypt(
      outputUtxos[0].serialize(),
      recipientViewingKey,
    );
    const encryptedOutput2 = await this.encryptionService.encrypt(
      outputUtxos[1].serialize(),
      recipientViewingKey,
    );

    const extData: ExtData = {
      // recipient - just a placeholder, not actually used for deposits.
      recipient: FEE_RECIPIENT, // Using fee recipient as dummy recipient for deposit,
      extAmount: extAmount,
      encryptedOutput1: encryptedOutput1,
      encryptedOutput2,
      fee,
      feeRecipient: FEE_RECIPIENT,
      mintAddress: mintAddress,
    };

    const extDataHash = getExtDataHash(extData);

    const circuitInput: CircuitParams = {
      root: bytesToBN(treeState.currentRoot).toString(),
      inputNullifier: inputUtxos.map((x) => x.getNullifier()),
      outputCommitment: outputUtxos.map((x) => x.getCommitment()),
      publicAmount: publicAmount.toString(),
      extDataHash: extDataHash,

      // inputs
      inAmount: inputUtxos.map((x) => x.amount.toString(10)),
      inPrivateKey: inputUtxos.map((x) => x.keypair.privkey),
      inBlinding: inputUtxos.map((x) => x.blinding.toString(10)),
      inPathIndices: inputUtxos.map((x) => 0),
      inPathElements: inputUtxos.map(() => {
        return [...new Array(MERKLE_TREE_DEPTH).fill("0")];
      }),

      // outputs
      outAmount: outputUtxos.map((x) => x.amount.toString(10)),
      outBlinding: outputUtxos.map((x) => x.blinding.toString(10)),
      outPubkey: outputUtxos.map((x) => x.keypair.pubkey),

      mintAddress,
    };

    const circuitOutput = await prove(circuitInput);
    const proofBytes = parseProofToBytesArray(circuitOutput.proof);
    const inputBytes = parseToBytesArray(circuitOutput.publicSignals);
    const proofToSubmit: ProofBytes = {
      proofA: proofBytes.proofA,
      proofB: proofBytes.proofB,
      proofC: proofBytes.proofC,
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
        { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: this.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: serializeProofAndExtData(proofToSubmit, extData, false),
    });

    const addressLookTable = (
      await this.connection.getAddressLookupTable(ALT_ADDRESS)
    ).value!;

    const messageV0 = new TransactionMessage({
      instructions: [ix],
      payerKey: this.signer.publicKey,
      recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
    }).compileToV0Message([addressLookTable]);

    let versionedTransaction = new VersionedTransaction(messageV0);
    let signedTx = await this.signer.signTransaction(versionedTransaction);

    let txid = await this.connection.sendRawTransaction(signedTx.serialize());
  }

  async withdrawSol(amountInLamports: number, mintAddress: string) {
    if (mintAddress != SOL_MINT.toString()) {
      throw new Error("Non-native mints not allowed");
    }

    // Check if user has notes to withdraw
    let notesExists = this.mintToNotesMap.has(mintAddress);
    if (!notesExists) {
      throw new Error("No Notes Exists to Withdraw");
    }

    // if user can withdraw the specified amount
    let notesInfo = this.mintToNotesMap.get(mintAddress)!;

    if (notesInfo.maxAmountInSingleTransaction.lt(new BN(amountInLamports))) {
      throw new Error(
        `You can currently only withdraw equal or less than ${notesInfo.maxAmountInSingleTransaction.toNumber()}`,
      );
    }

    // which utxo to choose when withdrawing
    // least amount one shall be removed
    let requiredNotes = [];
    for (let i = 0; i < notesInfo.notes.length; i++) {
      let least = notesInfo.notes[i];

      if (least.amount.gte(new BN(amountInLamports))) {
        requiredNotes.push(least);
        break;
      }

      let pairFind = false;

      for (let j = i + 1; j < notesInfo.notes.length; j++) {
        let upper = notesInfo.notes[j];

        // check if these add to satisy withdrawAmount
        if (upper.amount.add(least.amount).gte(new BN(amountInLamports))) {
          requiredNotes.push(least);
          requiredNotes.push(upper);
          pairFind = true;
          break;
        }
      }

      if (pairFind) {
        break;
      }
    }

    let inputUtxos: Utxo[] = [];

    if (requiredNotes.length < 2) {
      let encryptedNote = await this.storageService.loadSingleNote(
        requiredNotes[0].note_id,
      );
      let input1 = Utxo.deserialize(
        await this.encryptionService.decrypt(encryptedNote),
        this.lightwasm,
      );
      let input2 = new Utxo({
        lightWasm: this.lightwasm,
        mintAddress: input1.mintAddress,
      });

      inputUtxos.push(input1);
      inputUtxos.push(input2);
    } else {
      let encryptedNotes = await this.storageService.loadPairOfNotes(
        requiredNotes[0].note_id,
        requiredNotes[1].note_id,
      );

      let input1 = Utxo.deserialize(
        await this.encryptionService.decrypt(encryptedNotes[0]),
        this.lightwasm,
      );
      let input2 = Utxo.deserialize(
        await this.encryptionService.decrypt(encryptedNotes[1]),
        this.lightwasm,
      );

      inputUtxos.push(input1);
      inputUtxos.push(input2);
    }

    const fee = new BN(
      Math.ceil((amountInLamports * WITHDRAW_FEE_RATE) / 10000),
    );
    // extAmount is the amount for withdrawals and deposits so fee excluded
    let extAmount = new BN(amountInLamports).sub(fee).neg();

    // sumINs + publicAmount = sumOuts
    let publicAmount = extAmount.sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE);

    let treeState = await fetchTreeState(mintAddress);
    const recipientViewingKey = this.encryptionService.getViewingKey();

    const totalInputs: BN = inputUtxos.reduce(
      (prev, n) => n.amount.add(prev),
      new BN(0),
    );

    const change = totalInputs.sub(new BN(amountInLamports));

    let outputUtxos = [
      new Utxo({
        lightWasm: this.lightwasm,
        amount: change,
        index: treeState.nextLeafIndex.toNumber(),
        mintAddress,
      }),
      new Utxo({
        lightWasm: this.lightwasm,
        amount: 0,
        index: treeState.nextLeafIndex.toNumber() + 1,
        mintAddress,
      }),
    ];

    const encryptedOutput1 = await this.encryptionService.encrypt(
      outputUtxos[0].serialize(),
      recipientViewingKey,
    );
    const encryptedOutput2 = await this.encryptionService.encrypt(
      outputUtxos[1].serialize(),
      recipientViewingKey,
    );

    const extData: ExtData = {
      // recipient - just a placeholder, not actually used for deposits.
      recipient: FEE_RECIPIENT, // Using fee recipient as dummy recipient for deposit,
      extAmount: extAmount,
      encryptedOutput1: encryptedOutput1,
      encryptedOutput2,
      fee,
      feeRecipient: FEE_RECIPIENT,
      mintAddress: mintAddress,
    };

    const extDataHash = getExtDataHash(extData);
    const merkleProofPair = await fetchMerkleProofForLeaves(
      mintAddress,
      inputUtxos[0].index.toString(10),
      inputUtxos[1].index.toString(10),
    );

    const { inPathElements, inPathIndices, root } =
      buildMerkleCircuitInputs(merkleProofPair);

    const circuitInput: CircuitParams = {
      root: root,
      inputNullifier: inputUtxos.map((x) => x.getNullifier()),
      outputCommitment: outputUtxos.map((x) => x.getCommitment()),
      publicAmount: publicAmount.toString(),
      extDataHash: extDataHash,

      // inputs
      inAmount: inputUtxos.map((x) => x.amount.toString(10)),
      inPrivateKey: inputUtxos.map((x) => x.keypair.privkey),
      inBlinding: inputUtxos.map((x) => x.blinding.toString(10)),
      inPathIndices: inPathIndices,
      inPathElements: inPathElements,

      // outputs
      outAmount: outputUtxos.map((x) => x.amount.toString(10)),
      outBlinding: outputUtxos.map((x) => x.blinding.toString(10)),
      outPubkey: outputUtxos.map((x) => x.keypair.pubkey),

      mintAddress,
    };

    const circuitOutput = await prove(circuitInput);
    const proofBytes = parseProofToBytesArray(circuitOutput.proof);
    const inputBytes = parseToBytesArray(circuitOutput.publicSignals);
    const proofToSubmit: ProofBytes = {
      proofA: proofBytes.proofA,
      proofB: proofBytes.proofB,
      proofC: proofBytes.proofC,
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
        { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: this.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: serializeProofAndExtData(proofToSubmit, extData, false),
    });

    const addressLookTable = (
      await this.connection.getAddressLookupTable(ALT_ADDRESS)
    ).value!;

    const messageV0 = new TransactionMessage({
      instructions: [ix],
      payerKey: this.signer.publicKey,
      recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
    }).compileToV0Message([addressLookTable]);

    let versionedTransaction = new VersionedTransaction(messageV0);
    let signedTx = await this.signer.signTransaction(versionedTransaction);

    let txid = await this.connection.sendRawTransaction(signedTx.serialize());
  }

  async syncNotes() {
    let loadNewNotes = await this.storageService.loadNotesFrom(
      this.signer.publicKey.toString(),
      this.lastLoadedNote,
    );

    await Promise.all(
      loadNewNotes.map(
        async ({
          encryptedNote,
          id,
          walletPubkey,
        }: StoredNoteSchema): Promise<undefined> => {
          const decryptedNote = Utxo.deserialize(
            await this.encryptionService.decrypt(encryptedNote),
            this.lightwasm,
          );

          if (!this.mintToNotesMap.has(decryptedNote.mintAddress)) {
            let newNotesInfo: NotesInfo = {
              totalAmount: new BN(0),
              maxAmountInSingleTransaction: new BN(0),
              notes: [],
            };

            this.mintToNotesMap.set(decryptedNote.mintAddress, newNotesInfo);
          }

          let requiredNotesInfo = this.mintToNotesMap.get(
            decryptedNote.mintAddress,
          )!;

          requiredNotesInfo.totalAmount = requiredNotesInfo.totalAmount.add(
            decryptedNote.amount.abs(),
          );

          let newNote: SanitizedNote = {
            note_id: id!,
            walletPubkey,
            amount: decryptedNote.amount,
          };
          requiredNotesInfo.notes.push(newNote);
        },
      ),
    );

    this.mintToNotesMap.forEach((notesInfo) => {
      notesInfo.notes.sort((a, b) => a.amount.sub(b.amount).toNumber());

      let n = notesInfo.notes.length;
      notesInfo.maxAmountInSingleTransaction = notesInfo.notes[
        n - 1
      ].amount.add(notesInfo.notes[n - 2].amount);
    });
  }
}

function createSilentPayWorker(walletPubkey: string, masterSeed: Uint8Array) {
  const worker = new Worker(new URL("./worker/worker.ts", import.meta.url), {
    type: "module",
  });

  worker.postMessage({
    type: "start",
    walletPubkey,
    masterSeed,
  });

  return worker;
}
