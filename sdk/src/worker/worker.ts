import { EncryptionService } from "../encrypt";
import { StorageService } from "../storage";

function createWorker(signMessage: Uint8Array) {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });

  return worker;
}

// Worker will have its own encryptionService and storageService
async function startWorker(signedMessage: Uint8Array) {
  let encryptionService =
    await EncryptionService.startEncryptionService(signedMessage);
  let storageService = await StorageService.start();

  while (true) {}
}
