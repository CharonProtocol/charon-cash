import { API } from "./api";
import { ComputeBudgetProgram, PublicKey, SendTransactionError, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, } from "@solana/web3.js";
import { Utxo } from "./model/utxo";
import { ALT_ADDRESS, FEE_RECIPIENT, FIELD_SIZE, API_URL, SOL_MINT, PROGRAM_ID, } from "./constants";
import BN from "bn.js";
import { bytesToBN, deriveAccounts, getExtDataHash, getMintAddressField, serializeProofAndExtData, } from "./utils";
import { parseToBytesArray, prove } from "./prover";
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
export async function transactSol({ inputUtxos, extAmount, fee, mintAddress, lightwasm, recipientKey, encryptionService, signer, connection, signTransaction, }) {
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
        let amountInLamports = extAmount.abs().add(fee);
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
    const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
    const inputBytes = parseToBytesArray(publicSignals);
    const proofToSubmit = {
        proofA: proofA,
        proofB: proofB,
        proofC: proofC,
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
    console.log("Size", versionedTransaction.serialize().length);
    let signedTx = await signTransaction(versionedTransaction);
    try {
        const rawTxHex = Buffer.from(signedTx.serialize()).toString("hex");
        const response = await fetch(`${API_URL}/api/relayer/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transaction: rawTxHex }),
        });
        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Relayer submit failed: ${response.status} ${errBody}`);
        }
        const data = await response.json();
        return data.signature;
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
/// This is done for convenience , could be implemented in transactSol itself but making in comprehensible
export async function shieldedTransferSol({ inputUtxos, transferAmount, fee, mintAddress, lightwasm, recipientKey, encryptionService, signer, connection, signTransaction, }) {
    if (inputUtxos.length != 2) {
        throw new ProgramError("Invalid number of input utxos , only 2 allowed");
    }
    // Since Public Amount represent the amount coming in and out of pool , it will be zero
    let publicAmount = new BN(0);
    // recipient X25519 key needed to encrypt the notes
    let recipientViewingKey;
    recipientViewingKey = await API.fetchRecipientViewingKey(new PublicKey(recipientKey));
    // Change that will remain for the user after transaction
    let change;
    const totalInputs = inputUtxos.reduce((prev, n) => n.amount.add(prev), new BN(0));
    let netAmount = transferAmount.abs().sub(fee);
    // change has to be encrypted for signer
    change = totalInputs.sub(new BN(netAmount));
    // Get the Merkle Proof for the notes needed to be sent
    let { root, proofs, nextIndex } = await API.fetchMerkleProof(mintAddress, [inputUtxos[0].index, inputUtxos[1].index], inputUtxos.map((u) => u.getCommitment()));
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
    const encryptedOutput1 = await encryptionService.encrypt(outputUtxos[0].serialize(), recipientViewingKey);
    // any change should get back to the sender appropriately
    const encryptedOutput2 = await encryptionService.encrypt(outputUtxos[1].serialize(), encryptionService.getViewingKey());
    let recipient = recipientKey;
    const extData = {
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
    const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
    const inputBytes = parseToBytesArray(publicSignals);
    const proofToSubmit = {
        proofA: proofA,
        proofB: proofB,
        proofC: proofC,
        root: inputBytes[0],
        publicAmount: inputBytes[1],
        extDataHash: inputBytes[2],
        inputNullifiers: [inputBytes[3], inputBytes[4]],
        outputCommitments: [inputBytes[5], inputBytes[6]],
    };
    const programAccounts = deriveAccounts(PROGRAM_ID, Uint8Array.from(proofToSubmit.inputNullifiers[0]), Uint8Array.from(proofToSubmit.inputNullifiers[1]));
    const ixData = serializeProofAndExtData(proofToSubmit, extData, false, programAccounts.bump0, programAccounts.bump1);
    const toHex = (arr) => Buffer.from(arr).toString("hex");
    const proofPayload = {
        proof_a: toHex(proofToSubmit.proofA),
        proof_b: toHex(proofToSubmit.proofB),
        proof_c: toHex(proofToSubmit.proofC),
        root: toHex(proofToSubmit.root),
        public_amount: toHex(proofToSubmit.publicAmount),
        ext_data_hash: toHex(proofToSubmit.extDataHash),
        input_nullifiers: proofToSubmit.inputNullifiers.map(toHex),
        output_commitments: proofToSubmit.outputCommitments.map(toHex),
    };
    const transactPayload = {
        proof: proofPayload,
        ext_amount: extData.extAmount.toString(),
        fee: extData.fee.toString(),
        encrypted_output1: toHex(extData.encryptedOutput1),
        encrypted_output2: toHex(extData.encryptedOutput2),
        recipient: FEE_RECIPIENT.toBase58(),
        mint: SOL_MINT.toBase58(),
        is_spl: false,
        fee_recipient: FEE_RECIPIENT.toBase58(),
    };
    try {
        const response = await fetch(`${API_URL}/api/relayer/transact`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(transactPayload),
        });
        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Relayer transact failed: ${response.status} ${errBody}`);
        }
        const data = await response.json();
        return data.signature;
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
export async function transactSpl({ inputUtxos, extAmount, fee, mintAddress, lightwasm, recipientKey, encryptionService, signer, connection, signTransaction, }) {
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
        let netAmount = extAmount.abs().add(fee);
        change = totalInputs.sub(new BN(netAmount));
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
    const feeRecipientAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), FEE_RECIPIENT);
    let recipientAta = extAmount.isNeg() ? signerAta : feeRecipientAta;
    const extData = {
        recipient: recipientAta,
        extAmount: extAmount,
        encryptedOutput1: encryptedOutput1,
        encryptedOutput2: encryptedOutput2,
        fee,
        feeRecipient: feeRecipientAta,
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
    const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
    const inputBytes = parseToBytesArray(publicSignals);
    const proofToSubmit = {
        proofA: proofA,
        proofB: proofB,
        proofC: proofC,
        root: inputBytes[0],
        publicAmount: inputBytes[1],
        extDataHash: inputBytes[2],
        inputNullifiers: [inputBytes[3], inputBytes[4]],
        outputCommitments: [inputBytes[5], inputBytes[6]],
    };
    const programAccounts = deriveAccounts(PROGRAM_ID, Uint8Array.from(proofToSubmit.inputNullifiers[0]), Uint8Array.from(proofToSubmit.inputNullifiers[1]), new PublicKey(mintAddress));
    const ixData = serializeProofAndExtData(proofToSubmit, extData, true, programAccounts.bump0, programAccounts.bump1);
    const treeTokenAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), programAccounts.globalConfig, true);
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
            { pubkey: TOKEN_PROGRAM_ID,
                isSigner: false, isWritable: false },
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
        const rawTxHex = Buffer.from(signedTx.serialize()).toString("hex");
        const response = await fetch(`${API_URL}/api/relayer/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transaction: rawTxHex }),
        });
        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Relayer submit failed: ${response.status} ${errBody}`);
        }
        const data = await response.json();
        return data.signature;
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
/**
 * This does shielded transfer for spl tokens.
 *
 * @param param0
 * @returns
 */
export async function shieldedTransferSpl({ inputUtxos, transferAmount, fee, mintAddress, lightwasm, recipientKey, encryptionService, signer, connection, signTransaction, }) {
    if (inputUtxos.length != 2) {
        throw new ProgramError("Invalid number of input utxos , only 2 allowed");
    }
    const signerAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), signer);
    // Since Public Amount represent the amount coming in and out of pool , it will be zero
    let publicAmount;
    publicAmount = new BN(0);
    // recipient X25519 key needed to encrypt the notes
    let recipientViewingKey;
    recipientViewingKey = await API.fetchRecipientViewingKey(new PublicKey(recipientKey));
    // Change that will remain for the user after transaction
    let change;
    const totalInputs = inputUtxos.reduce((prev, n) => n.amount.add(prev), new BN(0));
    let netAmount = transferAmount.abs().sub(fee);
    change = totalInputs.sub(new BN(netAmount));
    // Get the Merkle Proof for the notes needed to be sent
    let { root, proofs, nextIndex } = await API.fetchMerkleProof(mintAddress, [inputUtxos[0].index, inputUtxos[1].index], inputUtxos.map((u) => u.getCommitment()));
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
    const encryptedOutput1 = await encryptionService.encrypt(outputUtxos[0].serialize(), recipientViewingKey);
    // This is the remaining change for the user
    const encryptedOutput2 = await encryptionService.encrypt(outputUtxos[1].serialize(), encryptionService.getViewingKey());
    const feeRecipientAta = await getAssociatedTokenAddress(new PublicKey(mintAddress), FEE_RECIPIENT);
    const extData = {
        recipient: feeRecipientAta,
        extAmount: new BN(0),
        encryptedOutput1: encryptedOutput1,
        encryptedOutput2: encryptedOutput2,
        fee,
        feeRecipient: feeRecipientAta,
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
    const { publicSignals, proofA, proofB, proofC } = await prove(circuitInput);
    const inputBytes = parseToBytesArray(publicSignals);
    const proofToSubmit = {
        proofA: proofA,
        proofB: proofB,
        proofC: proofC,
        root: inputBytes[0],
        publicAmount: inputBytes[1],
        extDataHash: inputBytes[2],
        inputNullifiers: [inputBytes[3], inputBytes[4]],
        outputCommitments: [inputBytes[5], inputBytes[6]],
    };
    const programAccounts = deriveAccounts(PROGRAM_ID, Uint8Array.from(proofToSubmit.inputNullifiers[0]), Uint8Array.from(proofToSubmit.inputNullifiers[1]), new PublicKey(mintAddress));
    const ixData = serializeProofAndExtData(proofToSubmit, extData, true, programAccounts.bump0, programAccounts.bump1);
    const toHex = (arr) => Buffer.from(arr).toString("hex");
    const proofPayload = {
        proof_a: toHex(proofToSubmit.proofA),
        proof_b: toHex(proofToSubmit.proofB),
        proof_c: toHex(proofToSubmit.proofC),
        root: toHex(proofToSubmit.root),
        public_amount: toHex(proofToSubmit.publicAmount),
        ext_data_hash: toHex(proofToSubmit.extDataHash),
        input_nullifiers: proofToSubmit.inputNullifiers.map(toHex),
        output_commitments: proofToSubmit.outputCommitments.map(toHex),
    };
    const transactPayload = {
        proof: proofPayload,
        ext_amount: extData.extAmount.toString(),
        fee: extData.fee.toString(),
        encrypted_output1: toHex(extData.encryptedOutput1),
        encrypted_output2: toHex(extData.encryptedOutput2),
        recipient: FEE_RECIPIENT.toBase58(),
        mint: mintAddress,
        is_spl: true,
        fee_recipient: FEE_RECIPIENT.toBase58(),
        recipient_token_account: feeRecipientAta.toBase58(),
    };
    try {
        const response = await fetch(`${API_URL}/api/relayer/transact`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(transactPayload),
        });
        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Relayer transact failed: ${response.status} ${errBody}`);
        }
        const data = await response.json();
        return data.signature;
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
