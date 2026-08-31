import { fetchNotes } from "../api";
import { EncryptionService } from "../encrypt";
import { StorageService } from "../storage";

const POLL_TIME = 10 * 1000; // in ms

/**
 * These params are required to start encryption and storage service
 *
 * @param walletPubkey
 * @param signedMessage
 * @returns
 */
function createWorker(walletPubkey: string, signedMessage: Uint8Array) {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("start", () => {
    startWorker(walletPubkey, signedMessage);
  });
  return worker;
}

// Worker will have its own encryptionService and storageService
async function startWorker(walletPubkey: string, signedMessage: Uint8Array) {
  let encryptionService =
    await EncryptionService.startEncryptionService(signedMessage);
  let storageService = await StorageService.start();

  while (true) {
    let encryptedNotes = await fetchNotes();

    let newNotesAdded = false;

    for (let e_note of encryptedNotes) {
      try {
        let decryptedNote = await encryptionService.decrypt(e_note);

        await storageService.saveNote(walletPubkey, decryptedNote);
        newNotesAdded = true;
      } catch (error) {
        continue;
      }
    }

    if (newNotesAdded) {
      postMessage("syncNotes");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_TIME));
  }
}
