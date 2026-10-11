import { Connection } from "@solana/web3.js";
import { EncryptionService } from "./encrypt";
import { StorageService } from "./storage";
import { Utxo } from "./model/utxo";
import { WasmFactory } from "@lightprotocol/hasher.rs";
import BN from "bn.js";
import { DEPOSIT_FEE_RATE, SUPPORTED_SPL_MINTS, WITHDRAW_FEE_RATE, WRAPPED_SOL_MINT, } from "./constants";
import { API } from "./api";
import { shieldedTransferSol, shieldedTransferSpl, transactSol, transactSpl, } from "./program";
import { swapPrivate } from "./swap";
import { CharonProtocolError, CharonProtocolErrorCode } from "./error";
export const SIGN_MESSAGE = "Privacy Money account sign in";
export class CharonProtocol {
    connection;
    publicKey;
    encryptionService;
    signer;
    storageService;
    isRuning = false;
    lightwasm;
    utxoByMint;
    lastLoadedNote; // NOTE: this represents last loaded note in memory not from DB => initially it will be zero
    worker;
    SYNC_MESSAGE = "SYNC_UTXOS";
    balanceListeners = new Set();
    constructor({ connection, publicKey, signer, storageService, encryptionService, isRuning, lightwasm, utxoByMint, lastLoadedNote, worker, }) {
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
        worker.addEventListener("message", (event) => {
            if (event.data.type === this.SYNC_MESSAGE) {
                void this.syncUtxos();
            }
        });
    }
    /** Runs after the in-memory note totals change: a spend, or a note synced from IndexedDB. */
    watchBalances(listener) {
        this.balanceListeners.add(listener);
        return () => {
            this.balanceListeners.delete(listener);
        };
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
                UtxoSummary.utxos.sort((a, b) => a.amount.cmp(b.amount));
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
        else {
            // The scan cursor only moves forward. If it is already past this
            // wallet's notes and none were saved, start again at the first note.
            const cursor = Number((await storageService.getNextUtxoToFetchIndex(owner.publicKey.toString()))
                .index);
            if (cursor > 1) {
                await storageService.updateNextUtxoToFetchIndex(owner.publicKey.toString(), 1);
            }
        }
        let connection = new Connection(rpcUrl);
        let worker = createSharonProtocolWorker(owner.publicKey.toString(), masterSeed, rpcUrl);
        return new CharonProtocol({
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
        });
    }
    requestNoteScan() {
        this.worker.postMessage({ type: "poll" });
    }
    completeTx(signature) {
        this.requestNoteScan();
        return { signature };
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
        });
        return this.completeTx(txid);
    }
    async withdrawSol(amountInLamports) {
        await this.syncUtxos();
        let mintAddress = WRAPPED_SOL_MINT;
        let [inputUtxos, requiredutxos] = await this.getRequiredUtxosForAmount(mintAddress, new BN(amountInLamports));
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
        });
        // transaction is successful now remove the notes used from browser storage
        for (let u of requiredutxos) {
            await this.storageService.removeUtxo(u.utxoId);
            let noteSummary = this.utxoByMint.get(inputUtxos[0].mintAddress);
            noteSummary.utxos = noteSummary.utxos.filter((note) => note.utxoId !== u.utxoId);
        }
        this.recalculateBalances();
        return this.completeTx(txid);
    }
    async shieldedTransferSol(amountInLamports, recipientKey) {
        await this.syncUtxos();
        let mintAddress = WRAPPED_SOL_MINT;
        let [inputUtxos, requiredutxos] = await this.getRequiredUtxosForAmount(mintAddress, new BN(amountInLamports));
        const fee = new BN(0);
        // extAmount is the amount for withdrawals and deposits so fee excluded
        let txid = await shieldedTransferSol({
            inputUtxos,
            transferAmount: new BN(amountInLamports),
            fee,
            mintAddress,
            recipientKey: recipientKey,
            signer: this.signer.publicKey,
            encryptionService: this.encryptionService,
            connection: this.connection,
            lightwasm: this.lightwasm,
            signTransaction: this.signer.signTransaction,
        });
        // transaction is successful now remove the notes used from browser storage
        for (let u of requiredutxos) {
            await this.storageService.removeUtxo(u.utxoId);
            let noteSummary = this.utxoByMint.get(inputUtxos[0].mintAddress);
            noteSummary.utxos = noteSummary.utxos.filter((note) => note.utxoId !== u.utxoId);
        }
        this.recalculateBalances();
        return this.completeTx(txid);
    }
    /**
     * Private SOL↔SPL swap. `amountIn` is lamports for SOL and base units for SPL.
     * The relayer signs the transaction.
     */
    async swap(fromMint, outMint, amountIn) {
        await this.syncUtxos();
        const [inputUtxos, requiredutxos] = await this.getRequiredUtxosForAmount(fromMint, new BN(amountIn));
        const signature = await swapPrivate({
            fromMint,
            outMint,
            amountIn: new BN(amountIn),
            inputUtxos,
            lightwasm: this.lightwasm,
            encryptionService: this.encryptionService,
        });
        for (const spent of requiredutxos) {
            await this.storageService.removeUtxo(spent.utxoId);
            const noteSummary = this.utxoByMint.get(fromMint);
            if (noteSummary) {
                noteSummary.utxos = noteSummary.utxos.filter((note) => note.utxoId !== spent.utxoId);
            }
        }
        this.recalculateBalances();
        return this.completeTx(signature);
    }
    async sendSpl(amount, recipientKey, mintAddress) {
        if (!SUPPORTED_SPL_MINTS.includes(mintAddress)) {
            throw new CharonProtocolError("Given Mint is Not Supported by our Charon", CharonProtocolErrorCode.INVALID_MINT);
        }
        let inputUtxos = [
            new Utxo({ lightWasm: this.lightwasm, mintAddress }),
            new Utxo({ lightWasm: this.lightwasm, mintAddress }),
        ];
        const fee = new BN(Math.ceil((amount * DEPOSIT_FEE_RATE) / 10000));
        let extAmount = new BN(amount).sub(fee);
        let txid = await transactSpl({
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
        });
        return this.completeTx(txid);
    }
    async withdrawSpl(amount, mintAddress) {
        await this.syncUtxos();
        let [inputUtxos, requiredutxos] = await this.getRequiredUtxosForAmount(mintAddress, new BN(amount));
        const fee = new BN(Math.ceil((amount * WITHDRAW_FEE_RATE) / 10000));
        // extAmount is the amount for withdrawals and deposits so fee excluded
        let extAmount = new BN(amount).sub(fee).neg();
        let txid = await transactSpl({
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
        });
        // transaction is successful now remove the notes used from browser storage
        for (let u of requiredutxos) {
            await this.storageService.removeUtxo(u.utxoId);
            let noteSummary = this.utxoByMint.get(inputUtxos[0].mintAddress);
            noteSummary.utxos = noteSummary.utxos.filter((note) => note.utxoId !== u.utxoId);
        }
        this.recalculateBalances();
        return this.completeTx(txid);
    }
    async shieldedTransferSpl(amount, mintAddress, recipientKey) {
        await this.syncUtxos();
        let [inputUtxos, requiredutxos] = await this.getRequiredUtxosForAmount(mintAddress, new BN(amount));
        const fee = new BN(0);
        // extAmount is the amount for withdrawals and deposits so fee excluded
        let txid = await shieldedTransferSpl({
            inputUtxos,
            transferAmount: new BN(amount),
            fee,
            mintAddress,
            recipientKey: recipientKey,
            signer: this.signer.publicKey,
            encryptionService: this.encryptionService,
            connection: this.connection,
            lightwasm: this.lightwasm,
            signTransaction: this.signer.signTransaction,
        });
        // transaction is successful now remove the notes used from browser storage
        for (let u of requiredutxos) {
            await this.storageService.removeUtxo(u.utxoId);
            let noteSummary = this.utxoByMint.get(inputUtxos[0].mintAddress);
            noteSummary.utxos = noteSummary.utxos.filter((note) => note.utxoId !== u.utxoId);
        }
        this.recalculateBalances();
        return this.completeTx(txid);
    }
    async syncUtxos() {
        const wallet = this.signer.publicKey.toString();
        let newutxos = await this.storageService.loadUtxosFrom(wallet, this.lastLoadedNote);
        if (newutxos.length === 0) {
            const known = new Set();
            for (const summary of this.utxoByMint.values()) {
                for (const note of summary.utxos)
                    known.add(note.utxoId);
            }
            const stored = await this.storageService.loadUtxoBatch(wallet);
            newutxos = stored.filter((note) => note.id != null && !known.has(note.id));
        }
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
                if (!requiredUtxoSummary.utxos.some((note) => note.utxoId === id)) {
                    requiredUtxoSummary.utxos.push(newNote);
                }
            }));
            this.recalculateBalances();
        }
        this.lastLoadedNote = newutxos.reduce((highest, note) => Math.max(highest, note.id ?? 0), this.lastLoadedNote);
    }
    recalculateBalances() {
        this.utxoByMint.forEach((summary) => {
            summary.utxos.sort((a, b) => a.amount.cmp(b.amount));
            summary.totalAmount = summary.utxos.reduce((total, note) => total.add(note.amount), new BN(0));
            summary.maxSingleTxAmount = summary.utxos
                .slice(-2)
                .reduce((total, note) => total.add(note.amount), new BN(0));
        });
        for (const listener of this.balanceListeners)
            listener();
    }
    /**
     * @param mintAddress
     * @param amount : For Sol , it has to be in Lamports.
     * @returns
     */
    async getRequiredUtxosForAmount(mintAddress, amount) {
        // Check if user has utxos to withdraw
        let utxosExists = this.utxoByMint.has(mintAddress);
        if (!utxosExists) {
            throw new CharonProtocolError("No utxos Exists to Withdraw", CharonProtocolErrorCode.UTXO_FINISHED);
        }
        // if user can withdraw the specified amount
        let UtxoSummary = this.utxoByMint.get(mintAddress);
        if (UtxoSummary.maxSingleTxAmount.lt(new BN(amount))) {
            throw new CharonProtocolError(`You can currently only withdraw equal or less than ${UtxoSummary.maxSingleTxAmount.toString()}`, CharonProtocolErrorCode.WITHDRAWAL_LIMIT);
        }
        // which utxo to choose when withdrawing
        // least amount one shall be removed
        let requiredutxos = [];
        for (let i = 0; i < UtxoSummary.utxos.length; i++) {
            let least = UtxoSummary.utxos[i];
            if (least.amount.gte(new BN(amount))) {
                requiredutxos.push(least);
                break;
            }
            let pairFind = false;
            for (let j = i + 1; j < UtxoSummary.utxos.length; j++) {
                let upper = UtxoSummary.utxos[j];
                // check if these add to satisy withdrawAmount
                if (upper.amount.add(least.amount).gte(new BN(amount))) {
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
        return [inputUtxos, requiredutxos];
    }
    async stopClient() {
        this.worker.terminate();
        this.storageService.stop();
    }
}
function createSharonProtocolWorker(walletPubkey, masterSeed, rpcUrl) {
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
