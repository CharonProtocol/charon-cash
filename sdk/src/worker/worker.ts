import { WasmFactory } from "@lightprotocol/hasher.rs";
import { API } from "../api";
import { EncryptionService } from "../encrypt";
import { Utxo } from "../model/utxo";
import { StorageService } from "../storage";
import { Connection } from "@solana/web3.js";
import { deriveNullifiers, poseidonStringToBytes32 } from "../utils";

const POLL_TIME = 2 * 1000;
let isRunning = false;
const SYNC_MESSAGE = "SYNC_UTXOS";
let wakePoll: (() => void) | null = null;
let pendingWake = false;

function waitForPollInterval() {
  if (pendingWake) {
    pendingWake = false;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (wakePoll === finish) wakePoll = null;
      resolve();
    }, POLL_TIME);
    const finish = () => {
      clearTimeout(timer);
      wakePoll = null;
      resolve();
    };
    wakePoll = finish;
  });
}

self.addEventListener("message", async (event) => {
  if (event.data.type === "poll") {
    if (wakePoll) wakePoll();
    else pendingWake = true;
    return;
  }

  if (event.data.type !== "start") {
    return;
  }

  if (isRunning) {
    return;
  }

  isRunning = true;
  const { walletPubkey, masterSeed, rpcUrl } = event.data;

  await startWorker(walletPubkey, masterSeed, rpcUrl);
});

async function startWorker(
  walletPubkey: string,
  masterSeed: Uint8Array,
  rpcUrl: string,
) {
  const encryptionService =
    await EncryptionService.startEncryptionService(masterSeed);

  const storageService = await StorageService.start();
  const connection = new Connection(rpcUrl);

  const lightWasm = await WasmFactory.getInstance();

  let nextNoteIndex = Number(
    (await storageService.getNextUtxoToFetchIndex(walletPubkey)).index,
  );

  while (true) {
    try {
      const encryptedNotes = await API.fetchNotes(nextNoteIndex);

      let newNotes: Uint8Array[] = [];

      for (const encryptedNote of encryptedNotes) {
        try {
          const decryptedNote = await encryptionService.decrypt(encryptedNote);

          // if note can be decrypted it belongs to this user , store it
          const utxo = Utxo.deserialize(decryptedNote, lightWasm);

          // No need to store utxo with amount zero
          if (!utxo.amount.isZero()) {
            const [nullifer0, nullifer1] = deriveNullifiers(
              poseidonStringToBytes32(utxo.getNullifier()),
            )!;

            // is the note used previously
            const nullifer0Exists = await connection.getAccountInfo(nullifer0);
            const nullifer1Exists = await connection.getAccountInfo(nullifer1);

            if (!nullifer0Exists && !nullifer1Exists) {
              newNotes.push(encryptedNote);
            }
          }
        } catch {
          // not ours
        }
        nextNoteIndex++;
      }

      if (newNotes.length > 0) {
        await storageService.saveUtxoBatch(walletPubkey, newNotes);
        self.postMessage({
          type: SYNC_MESSAGE,
        });
      }

      await storageService.updateNextUtxoToFetchIndex(
        walletPubkey,
        nextNoteIndex,
      );
    } catch (error) {
      console.log("Worker Sync Failed", error);
    }
    await waitForPollInterval();
  }
}
