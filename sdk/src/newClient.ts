import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { EncryptionService } from "./encrypt";
import { StorageService, StoredNoteSchema } from "./storage";
import { Utxo } from "./model/utxo";
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";

export interface Signer {
  publicKey: PublicKey;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}

export const SIGN_MESSAGE = "Privacy Money account sign in";

type DecryptedNote = {
  id: number;
  decryptedNote: Utxo;
};

class SilentPay {
  private connection: Connection;
  public publicKey: PublicKey;
  private encryptionService: EncryptionService;
  private signer: Signer;
  private storageService: StorageService;
  private isRuning?: boolean = false;
  private lightwasm: LightWasm;

  private decryptedNotes: DecryptedNote[];

  private constructor({
    connection,
    publicKey,
    signer,
    storageService,
    encryptionService,
    isRuning,
    decryptedNotes,
    lightwasm,
  }: {
    connection: Connection;
    publicKey: PublicKey;
    signer: Signer;
    storageService: StorageService;
    encryptionService: EncryptionService;
    isRuning: boolean;
    decryptedNotes: DecryptedNote[];
    lightwasm: LightWasm;
  }) {
    this.publicKey = publicKey;
    this.signer = signer;
    this.storageService = storageService;
    this.encryptionService = encryptionService;
    this.isRuning = isRuning;
    this.decryptedNotes = decryptedNotes;
    this.connection = connection;
    this.lightwasm = lightwasm;
  }

  static async generateClient({
    RPC_url,
    owner,
    API_URL,
  }: {
    RPC_url: string;
    owner: Signer;
    API_URL: string;
  }) {
    const isRegistered = await fetch(
      `${API_URL}/api/registration/check/${owner.publicKey.toString()}`,
    );

    if (!isRegistered.ok) {
      throw new Error("Failed to verify registration");
    }

    const masterSeed = await owner.signMessage(
      new TextEncoder().encode(SIGN_MESSAGE),
    );

    const encryptionService =
      await EncryptionService.startEncryptionService(masterSeed);

    const registrationResponse = await isRegistered.json();

    if (!registrationResponse.data) {
      const viewingKey = encryptionService.getViewingKey();
      const data = {
        wallet_pubkey: owner.publicKey.toString(),
        viewing_pubkey: viewingKey,
      };
      let register = await fetch(`${API_URL}/api/registration/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });

      if (!register.ok) {
        throw new Error(`HTTP error! Status: ${register.status}`);
      }
    }

    const lightwasm = await WasmFactory.getInstance();

    const storageService = await StorageService.start();
    // fetch all the notes from local storage and keep them in memory
    // TODO : Optimize this step by adding spent field while storing
    let storedNotes = await storageService.fetchNotes(
      owner.publicKey.toString(),
    );

    let decryptedNotes = await Promise.all(
      storedNotes.map(
        async ({
          encryptedNote,
          id,
          walletPubkey,
        }: StoredNoteSchema): Promise<DecryptedNote> => {
          return {
            id: id!,
            decryptedNote: Utxo.deserialize(
              await encryptionService.decrypt(encryptedNote),
              lightwasm,
            ),
          };
        },
      ),
    );

    let connection = new Connection(RPC_url);

    return new SilentPay({
      connection,
      publicKey: owner.publicKey,
      signer: owner,
      storageService,
      encryptionService,
      isRuning: true,
      decryptedNotes,
      lightwasm,
    });
  }
}
