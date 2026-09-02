import { fetchNotes } from "../api";
import { EncryptionService } from "../encrypt";
import { StorageService } from "../storage";
const POLL_TIME = 10 * 1000;
self.addEventListener("message", async (event) => {
    if (event.data.type !== "start") {
        return;
    }
    const { walletPubkey, masterSeed } = event.data;
    await startWorker(walletPubkey, masterSeed);
});
async function startWorker(walletPubkey, masterSeed) {
    const encryptionService = await EncryptionService.startEncryptionService(masterSeed);
    const storageService = await StorageService.start();
    let lastFetchedNoteIndex = await storageService.getLastFetchedNote();
    while (true) {
        const encryptedNotes = await fetchNotes(lastFetchedNoteIndex);
        let newNotesAdded = false;
        for (const encryptedNote of encryptedNotes) {
            try {
                const decryptedNote = await encryptionService.decrypt(encryptedNote);
                await storageService.saveNote(walletPubkey, decryptedNote);
                newNotesAdded = true;
            }
            catch {
                continue;
            }
            lastFetchedNoteIndex++;
        }
        if (newNotesAdded) {
            self.postMessage({
                type: "syncNotes",
            });
        }
        storageService.updateLastFetchedNote(lastFetchedNoteIndex);
        await new Promise((resolve) => setTimeout(resolve, POLL_TIME));
    }
}
