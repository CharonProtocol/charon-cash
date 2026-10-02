import { API } from "./api";
import { ComputeBudgetProgram, PublicKey, sendAndConfirmRawTransaction, SendTransactionError, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, } from "@solana/web3.js";
import { Utxo } from "./model/utxo";
import { ALT_ADDRESS, FEE_RECIPIENT, FIELD_SIZE, PROGRAM_ID, } from "./constants";
import BN from "bn.js";
import { bytesToBN, deriveAccounts, getExtDataHash, getMintAddressField, serializeProofAndExtData, } from "./utils";
import { parseProofToBytesArray, parseToBytesArray, prove, } from "./prover";
import { CharonProtocolError, CharonProtocolErrorCode } from "./error";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, TOKEN_PROGRAM_ID, } from "@solana/spl-token";
export class ProgramError extends CharonProtocolError {
    programErrorCode;
    constructor(message, programErrorCode = undefined, options) {
        super(message, CharonProtocolErrorCode.PROGRAM_ERROR, {
            cause: options?.cause,
        });
        this.name = "ProgramError";
        this.programErrorCode = programErrorCode;
        Object.setPrototypeOf(this, ProgramError.prototype);
    }
}
export var ProgramErrorCode;
(function (ProgramErrorCode) {
    ProgramErrorCode["Unauthorized"] = "Unauthorized";
    ProgramErrorCode["InvalidMintAddress"] = "InvalidMintAddress";
    ProgramErrorCode["InvalidMerkleTreeHeight"] = "InvalidMerkleTreeHeight";
    ProgramErrorCode["InvalidRootHistorySize"] = "InvalidRootHistorySize";
    ProgramErrorCode["InvalidFeeRate"] = "InvalidFeeRate";
    ProgramErrorCode["UnknownRoot"] = "UnknownRoot";
    ProgramErrorCode["ExtDataHashMismatch"] = "ExtDataHashMismatch";
    ProgramErrorCode["InvalidPublicAmountData"] = "InvalidPublicAmountData";
    ProgramErrorCode["DepositLimitExceeded"] = "DepositLimitExceeded";
    ProgramErrorCode["InsufficientFundsForWithdrawal"] = "InsufficientFundsForWithdrawal";
    ProgramErrorCode["InsufficientFundsForFee"] = "InsufficientFundsForFee";
    ProgramErrorCode["InvalidFeeAmount"] = "InvalidFeeAmount";
    ProgramErrorCode["InvalidTokenAccount"] = "InvalidTokenAccount";
    ProgramErrorCode["InvalidTokenAccountMintAddress"] = "InvalidTokenAccountMintAddress";
    ProgramErrorCode["InvalidProof"] = "InvalidProof";
    ProgramErrorCode["InvalidMerkleTreeAccount"] = "InvalidMerkleTreeAccount";
})(ProgramErrorCode || (ProgramErrorCode = {}));
export async function transactSol({ inputUtxos, extAmount, fee, mintAddress, lightwasm, recipientKey, encryptionService, signer, connection, signTransaction, circuit, }) {
    if (inputUtxos.length != 2) {
        throw new ProgramError("Invalid number of input utxos , only 2 allowed");
    }
    let publicAmount;
    if (extAmount.isNeg()) {
        // withdraw
        publicAmount = extAmount.sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE);
    }
    else {
        // send
        publicAmount = extAmount.add(FIELD_SIZE).mod(FIELD_SIZE);
    }
    let recipientViewingKey;
    if (extAmount.isNeg()) {
        // withdraw
        recipientViewingKey = encryptionService.getViewingKey();
    }
    else {
        // send
        recipientViewingKey = await API.fetchRecipientViewingKey(new PublicKey(recipientKey));
    }
    let change;
    if (extAmount.isNeg()) {
        // withdraw
        const totalInputs = inputUtxos.reduce((prev, n) => n.amount.add(prev), new BN(0));
        let amountInLamports = extAmount.abs().add(fee).toNumber();
        change = totalInputs.sub(new BN(amountInLamports));
    }
    else {
        // send
        change = publicAmount;
    }
    let { root, proofs, nextIndex } = await API.fetchMerkleProof(mintAddress, [inputUtxos[0].index, inputUtxos[1].index], inputUtxos.map((u) => u.getCommitment()));
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
    const encryptedOutput1 = await encryptionService.encrypt(outputUtxos[0].serialize(), recipientViewingKey);
    const encryptedOutput2 = await encryptionService.encrypt(outputUtxos[1].serialize(), recipientViewingKey);
    let recipient = extAmount.isNeg() ? signer : FEE_RECIPIENT;
    const extData = {
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
    const circuitInput = {
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
        inPathElements: proofs.map((path) => path.map((node) => bytesToBN(node).toString())),
        // outputs
        outAmount: outputUtxos.map((x) => x.amount.toString(10)),
        outBlinding: outputUtxos.map((x) => x.blinding.toString(10)),
        outPubkey: outputUtxos.map((x) => x.keypair.pubkey),
        mintAddress: getMintAddressField(new PublicKey(mintAddress)),
    };
    const circuitOutput = await prove(circuitInput, circuit.wasm, circuit.zkey);
    const proofBytes = parseProofToBytesArray(circuitOutput.proof);
    const inputBytes = parseToBytesArray(circuitOutput.publicSignals);
    const proofToSubmit = {
        proofA: proofBytes.proofA,
        proofB: proofBytes.proofB,
        proofC: proofBytes.proofC,
        root: inputBytes[0],
        publicAmount: inputBytes[1],
        extDataHash: inputBytes[2],
        inputNullifiers: [inputBytes[3], inputBytes[4]],
        outputCommitments: [inputBytes[5], inputBytes[6]],
    };
    const programAccounts = deriveAccounts(PROGRAM_ID, Uint8Array.from(proofToSubmit.inputNullifiers[0]), Uint8Array.from(proofToSubmit.inputNullifiers[1]));
    const ixData = serializeProofAndExtData(proofToSubmit, extData, false, programAccounts.bump0, programAccounts.bump1);
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
        .value;
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
        let txid = await sendAndConfirmRawTransaction(connection, Buffer.from(signedTx.serialize()), {
            commitment: "finalized",
        });
        return txid;
    }
    catch (error) {
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
export async function transactSpl({ inputUtxos, extAmount, fee, mintAddress, lightwasm, recipientKey, encryptionService, signer, connection, signTransaction, circuit, }) {
    if (inputUtxos.length != 2) {
        throw new ProgramError("Invalid number of input utxos , only 2 allowed");
    }
    const signerAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), signer);
    let publicAmount;
    if (extAmount.isNeg()) {
        // withdraw
        publicAmount = extAmount.sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE);
    }
    else {
        // send
        publicAmount = extAmount.add(FIELD_SIZE).mod(FIELD_SIZE);
    }
    let recipientViewingKey;
    if (extAmount.isNeg()) {
        // withdraw
        recipientViewingKey = encryptionService.getViewingKey();
    }
    else {
        // send
        recipientViewingKey = await API.fetchRecipientViewingKey(new PublicKey(recipientKey));
    }
    let change;
    if (extAmount.isNeg()) {
        // withdraw
        const totalInputs = inputUtxos.reduce((prev, n) => n.amount.add(prev), new BN(0));
        let amountInLamports = extAmount.abs().add(fee).toNumber();
        change = totalInputs.sub(new BN(amountInLamports));
    }
    else {
        // send
        change = publicAmount;
    }
    let { root, proofs, nextIndex } = await API.fetchMerkleProof(mintAddress, [inputUtxos[0].index, inputUtxos[1].index], inputUtxos.map((u) => u.getCommitment()));
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
    const encryptedOutput1 = await encryptionService.encrypt(outputUtxos[0].serialize(), recipientViewingKey);
    const encryptedOutput2 = await encryptionService.encrypt(outputUtxos[1].serialize(), recipientViewingKey);
    let recipient = extAmount.isNeg() ? signer : FEE_RECIPIENT;
    const extData = {
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
    const circuitInput = {
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
        inPathElements: proofs.map((path) => path.map((node) => bytesToBN(node).toString())),
        // outputs
        outAmount: outputUtxos.map((x) => x.amount.toString(10)),
        outBlinding: outputUtxos.map((x) => x.blinding.toString(10)),
        outPubkey: outputUtxos.map((x) => x.keypair.pubkey),
        mintAddress: getMintAddressField(new PublicKey(mintAddress)),
    };
    const circuitOutput = await prove(circuitInput, circuit.wasm, circuit.zkey);
    const proofBytes = parseProofToBytesArray(circuitOutput.proof);
    const inputBytes = parseToBytesArray(circuitOutput.publicSignals);
    const proofToSubmit = {
        proofA: proofBytes.proofA,
        proofB: proofBytes.proofB,
        proofC: proofBytes.proofC,
        root: inputBytes[0],
        publicAmount: inputBytes[1],
        extDataHash: inputBytes[2],
        inputNullifiers: [inputBytes[3], inputBytes[4]],
        outputCommitments: [inputBytes[5], inputBytes[6]],
    };
    const programAccounts = deriveAccounts(PROGRAM_ID, Uint8Array.from(proofToSubmit.inputNullifiers[0]), Uint8Array.from(proofToSubmit.inputNullifiers[1]));
    const ixData = serializeProofAndExtData(proofToSubmit, extData, false, programAccounts.bump0, programAccounts.bump1);
    const treeTokenAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), programAccounts.treeTokenAccount);
    const feeRecipientAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), FEE_RECIPIENT);
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
                pubkey: extAmount.isNeg() ? signerAta : FEE_RECIPIENT,
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
        .value;
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
        let txid = await sendAndConfirmRawTransaction(connection, Buffer.from(signedTx.serialize()), {
            commitment: "finalized",
        });
        return txid;
    }
    catch (error) {
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
