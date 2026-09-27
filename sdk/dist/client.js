import { Connection, } from "@solana/web3.js";
import { EncryptionService } from "./encrypt";
import { StorageService } from "./storage";
import { Utxo } from "./model/utxo";
import { WasmFactory } from "@lightprotocol/hasher.rs";
import BN from "bn.js";
import { DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE, WRAPPED_SOL_MINT, } from "./constants";
import { API } from "./api";
import { transactSol } from "./program";
import { SilentPayError, SilentPayErrorCode } from "./error";
import { loadCircuit } from "./prover";
export const SIGN_MESSAGE = "Privacy Money account sign in";
export class SilentPay {
    connection;
    publicKey;
    encryptionService;
    signer;
    storageService;
    isRuning = false;
    lightwasm;
    circuit;
    utxoByMint;
    lastLoadedNote; // NOTE: this represents last loaded note in memory not from DB => initially it will be zero
    worker;
    SYNC_MESSAGE = "SYNC_UTXOS";
    constructor({ connection, publicKey, signer, storageService, encryptionService, isRuning, lightwasm, utxoByMint, lastLoadedNote, worker, circuit, }) {
        this.publicKey = publicKey;
        this.signer = signer;
        this.storageService = storageService;
        this.encryptionService = encryptionService;
        this.isRuning = isRuning;
        this.connection = connection;
        this.lightwasm = lightwasm;
        this.utxoByMint = utxoByMint;
        this.lastLoadedNote = lastLoadedNote;
        this.worker = worker;
        this.circuit = circuit;
        worker.addEventListener("message", (event) => {
            if (event.data.type === this.SYNC_MESSAGE) {
                this.syncUtxos();
            }
        });
    }
    static async generateClient({ rpcUrl, owner, }) {
        const isRegistered = await API.checkRegistration(owner.publicKey);
        const masterSeed = await owner.signMessage(new TextEncoder().encode(SIGN_MESSAGE));
        const encryptionService = await EncryptionService.startEncryptionService(masterSeed);
        if (!isRegistered) {
            const viewingKey = encryptionService.getViewingKey();
            const data = {
                walletPubkey: owner.publicKey.toString(),
                viewingkey: Array.from(viewingKey),
            };
            await API.registerUser(data);
        }
        const lightwasm = await WasmFactory.getInstance();
        const storageService = await StorageService.start();
        // fetch all the utxos from Client's Storage and keep them in memory
        let storedutxos = await storageService.loadUtxoBatch(owner.publicKey.toString());
        let lastLoadedNote = 0;
        let utxoByMint = new Map();
        if (storedutxos.length > 0) {
            let highestId = 1;
            await Promise.all(storedutxos.map(async ({ encryptedUtxo, id, walletPubkey, }) => {
                const utxo = Utxo.deserialize(await encryptionService.decrypt(encryptedUtxo), lightwasm);
                if (!utxoByMint.has(utxo.mintAddress)) {
                    let newUtxoSummary = {
                        totalAmount: new BN(0),
                        maxSingleTxAmount: new BN(0),
                        utxos: [],
                    };
                    utxoByMint.set(utxo.mintAddress, newUtxoSummary);
                }
                let requiredUtxoSummary = utxoByMint.get(utxo.mintAddress);
                requiredUtxoSummary.totalAmount =
                    requiredUtxoSummary.totalAmount.add(utxo.amount.abs());
                let newNote = {
                    utxoId: id,
                    walletPubkey,
                    amount: utxo.amount,
                };
                requiredUtxoSummary.utxos.push(newNote);
                if (id > highestId) {
                    highestId = id;
                }
            }));
            utxoByMint.forEach((UtxoSummary) => {
                UtxoSummary.utxos.sort((a, b) => a.amount.sub(b.amount).toNumber());
                let n = UtxoSummary.utxos.length;
                if (n >= 2) {
                    UtxoSummary.maxSingleTxAmount = UtxoSummary.utxos[n - 1].amount.add(UtxoSummary.utxos[n - 2].amount);
                }
                else {
                    UtxoSummary.maxSingleTxAmount = UtxoSummary.utxos[n - 1].amount;
                }
            });
            lastLoadedNote = highestId;
        }
        let connection = new Connection(rpcUrl);
        let worker = createSilentPayWorker(owner.publicKey.toString(), masterSeed, rpcUrl);
        let { zkey, wasm } = await loadCircuit();
        return new SilentPay({
            connection,
            publicKey: owner.publicKey,
            signer: owner,
            storageService,
            encryptionService,
            isRuning: true,
            lightwasm,
            utxoByMint,
            lastLoadedNote,
            worker,
            circuit: { zkey, wasm },
        });
    }
    async sendSol(amountInLamports, recipientKey) {
        let mintAddress = WRAPPED_SOL_MINT;
        let inputUtxos = [
            new Utxo({ lightWasm: this.lightwasm, mintAddress }),
            new Utxo({ lightWasm: this.lightwasm, mintAddress }),
        ];
        const fee = new BN(Math.ceil((amountInLamports * DEPOSIT_FEE_RATE) / 10000));
        let extAmount = new BN(amountInLamports).sub(fee);
        let txid = await transactSol({
            inputUtxos,
            extAmount,
            fee,
            mintAddress,
            recipientKey,
            signer: this.signer.publicKey,
            encryptionService: this.encryptionService,
            connection: this.connection,
            lightwasm: this.lightwasm,
            signTransaction: this.signer.signTransaction,
            circuit: this.circuit,
        });
        return { signature: txid };
    }
    async withdrawSol(amountInLamports) {
        let mintAddress = WRAPPED_SOL_MINT;
        // Check if user has utxos to withdraw
        let utxosExists = this.utxoByMint.has(mintAddress);
        if (!utxosExists) {
            throw new SilentPayError("No utxos Exists to Withdraw", SilentPayErrorCode.UTXO_FINISHED);
        }
        // if user can withdraw the specified amount
        let UtxoSummary = this.utxoByMint.get(mintAddress);
        if (UtxoSummary.maxSingleTxAmount.lt(new BN(amountInLamports))) {
            throw new SilentPayError(`You can currently only withdraw equal or less than ${UtxoSummary.maxSingleTxAmount.toNumber()}`, SilentPayErrorCode.WITHDRAWAL_LIMIT);
        }
        // which utxo to choose when withdrawing
        // least amount one shall be removed
        let requiredutxos = [];
        for (let i = 0; i < UtxoSummary.utxos.length; i++) {
            let least = UtxoSummary.utxos[i];
            if (least.amount.gte(new BN(amountInLamports))) {
                requiredutxos.push(least);
                break;
            }
            let pairFind = false;
            for (let j = i + 1; j < UtxoSummary.utxos.length; j++) {
                let upper = UtxoSummary.utxos[j];
                // check if these add to satisy withdrawAmount
                if (upper.amount.add(least.amount).gte(new BN(amountInLamports))) {
                    requiredutxos.push(least);
                    requiredutxos.push(upper);
                    pairFind = true;
                    break;
                }
            }
            if (pairFind) {
                break;
            }
        }
        let inputUtxos = [];
        if (requiredutxos.length < 2) {
            let encryptedNote = await this.storageService.loadUtxo(requiredutxos[0].utxoId);
            let input1 = Utxo.deserialize(await this.encryptionService.decrypt(encryptedNote.encryptedUtxo), this.lightwasm);
            let input2 = new Utxo({
                lightWasm: this.lightwasm,
                mintAddress: input1.mintAddress,
            });
            inputUtxos.push(input1);
            inputUtxos.push(input2);
        }
        else {
            let encryptedUtxos = await this.storageService.loadPairOfUtxo(requiredutxos[0].utxoId, requiredutxos[1].utxoId);
            let input1 = Utxo.deserialize(await this.encryptionService.decrypt(encryptedUtxos[0].encryptedUtxo), this.lightwasm);
            let input2 = Utxo.deserialize(await this.encryptionService.decrypt(encryptedUtxos[1].encryptedUtxo), this.lightwasm);
            inputUtxos.push(input1);
            inputUtxos.push(input2);
        }
        const fee = new BN(Math.ceil((amountInLamports * WITHDRAW_FEE_RATE) / 10000));
        // extAmount is the amount for withdrawals and deposits so fee excluded
        let extAmount = new BN(amountInLamports).sub(fee).neg();
        let txid = await transactSol({
            inputUtxos,
            extAmount,
            fee,
            mintAddress,
            recipientKey: this.signer.publicKey.toString(),
            signer: this.signer.publicKey,
            encryptionService: this.encryptionService,
            connection: this.connection,
            lightwasm: this.lightwasm,
            signTransaction: this.signer.signTransaction,
            circuit: this.circuit,
        });
        // transaction is successful now remove the notes used from browser storage
        for (let u of requiredutxos) {
            await this.storageService.removeUtxo(u.utxoId);
            let noteSummary = this.utxoByMint.get(inputUtxos[0].mintAddress);
            noteSummary.utxos = noteSummary.utxos.filter((u) => u.utxoId != u.utxoId);
        }
        return { signature: txid };
    }
    async syncUtxos() {
        let newutxos = await this.storageService.loadUtxosFrom(this.signer.publicKey.toString(), this.lastLoadedNote);
        console.log("Sync utxos :", newutxos);
        if (newutxos.length > 0) {
            await Promise.all(newutxos.map(async ({ encryptedUtxo, id, walletPubkey, }) => {
                const utxo = Utxo.deserialize(await this.encryptionService.decrypt(encryptedUtxo), this.lightwasm);
                if (!this.utxoByMint.has(utxo.mintAddress)) {
                    let newUtxoSummary = {
                        totalAmount: new BN(0),
                        maxSingleTxAmount: new BN(0),
                        utxos: [],
                    };
                    this.utxoByMint.set(utxo.mintAddress, newUtxoSummary);
                }
                let requiredUtxoSummary = this.utxoByMint.get(utxo.mintAddress);
                requiredUtxoSummary.totalAmount =
                    requiredUtxoSummary.totalAmount.add(utxo.amount);
                let newNote = {
                    utxoId: id,
                    walletPubkey,
                    amount: utxo.amount,
                };
                requiredUtxoSummary.utxos.push(newNote);
            }));
            this.utxoByMint.forEach((UtxoSummary) => {
                UtxoSummary.utxos.sort((a, b) => a.amount.sub(b.amount).toNumber());
                let n = UtxoSummary.utxos.length;
                if (n >= 2) {
                    UtxoSummary.maxSingleTxAmount = UtxoSummary.utxos[n - 1].amount.add(UtxoSummary.utxos[n - 2].amount);
                }
                else {
                    UtxoSummary.maxSingleTxAmount = UtxoSummary.utxos[n - 1].amount;
                }
            });
        }
        this.lastLoadedNote += newutxos.length;
    }
    async stopClient() {
        this.worker.terminate();
        this.storageService.stop();
    }
}
function createSilentPayWorker(walletPubkey, masterSeed, rpcUrl) {
    const worker = new Worker(new URL("./worker/worker.js", import.meta.url), {
        type: "module",
    });
    worker.postMessage({
        type: "start",
        walletPubkey,
        masterSeed,
        rpcUrl,
    });
    return worker;
}
