import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { SEED, TRANSACT_IX_DISCRIMINATOR, TRANSACT_SPL_IX_DISCRIMINATOR, } from "./constants";
import { sha256 } from "ethers/crypto";
// Adjust endian ('le' | 'be') to match how Node bytes were produced on the Rust side.
export function bytesToBN(bytes) {
    return new BN(bytes, undefined, "be");
}
export function getMintAddressField(mint) {
    const mintStr = mint.toString();
    // Special case for SOL (system program)
    if (mintStr === "11111111111111111111111111111112") {
        return mintStr;
    }
    // For SPL tokens (USDC, USDT, etc): use first 31 bytes (248 bits)
    // This provides better collision resistance than 8 bytes while still fitting in the field
    // We will only suppport private SOL, USDC and USDT send, so there won't be any collision.
    const mintBytes = mint.toBytes();
    return new BN(mintBytes.slice(0, 31), "be").toString();
}
export function deriveAccounts(programId, nullifierHash0, nullifierHash1) {
    const [treeAccount] = PublicKey.findProgramAddressSync([Buffer.from(SEED.TREE_ACCOUNT)], programId);
    const [treeTokenAccount] = PublicKey.findProgramAddressSync([Buffer.from(SEED.TREE_TOKEN)], programId);
    const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from(SEED.GLOBAL_CONFIG)], programId);
    const [nullifier0, bump0] = PublicKey.findProgramAddressSync([Buffer.from(SEED.NULLIFIER0), Buffer.from(nullifierHash0)], programId);
    const [nullifier1, bump1] = PublicKey.findProgramAddressSync([Buffer.from(SEED.NULLIFIER1), Buffer.from(nullifierHash1)], programId);
    const [nullifier2] = PublicKey.findProgramAddressSync([Buffer.from(SEED.NULLIFIER0), Buffer.from(nullifierHash1)], programId);
    const [nullifier3] = PublicKey.findProgramAddressSync([Buffer.from(SEED.NULLIFIER1), Buffer.from(nullifierHash0)], programId);
    return {
        treeAccount,
        treeTokenAccount,
        globalConfig,
        nullifier0,
        nullifier1,
        nullifier2,
        nullifier3,
        bump0,
        bump1,
    };
}
export function serializeProofAndExtData(proof, extData, isSpl = false) {
    // Create the ExtDataMinified object for the program call (only extAmount and fee)
    const extDataMinified = {
        extAmount: extData.extAmount,
        fee: extData.fee,
    };
    // Use the appropriate discriminator based on whether this is SPL or native SOL
    const discriminator = isSpl
        ? TRANSACT_SPL_IX_DISCRIMINATOR
        : TRANSACT_IX_DISCRIMINATOR;
    // Use the same serialization approach as deposit script
    const instructionData = Buffer.concat([
        discriminator,
        // Serialize proof
        Buffer.from(proof.proofA),
        Buffer.from(proof.proofB),
        Buffer.from(proof.proofC),
        Buffer.from(proof.root),
        Buffer.from(proof.publicAmount),
        Buffer.from(proof.extDataHash),
        Buffer.from(proof.inputNullifiers[0]),
        Buffer.from(proof.inputNullifiers[1]),
        Buffer.from(proof.outputCommitments[0]),
        Buffer.from(proof.outputCommitments[1]),
        // Serialize ExtDataMinified (only extAmount and fee)
        Buffer.from(new BN(extDataMinified.extAmount).toTwos(64).toArray("le", 8)),
        Buffer.from(new BN(extDataMinified.fee).toArray("le", 8)),
        // Serialize encrypted outputs as separate parameters
        Buffer.from(new BN(extData.encryptedOutput1.length).toArray("le", 4)),
        extData.encryptedOutput1,
        Buffer.from(new BN(extData.encryptedOutput2.length).toArray("le", 4)),
        extData.encryptedOutput2,
    ]);
    return instructionData;
}
export function buildMerkleCircuitInputs(pair) {
    const inPathElements = [pair.proof1, pair.proof2].map((mp) => mp.proof.map((node) => bytesToBN(node).toString()));
    const inPathIndices = [pair.proof1.index, pair.proof2.index];
    const root = bytesToBN(pair.proof1.root).toString();
    return { inPathElements, inPathIndices, root };
}
export function getExtDataHash(ext) {
    const recipient = toPubkeyBytes(ext.recipient);
    const feeRecipient = toPubkeyBytes(ext.feeRecipient);
    const mint = toPubkeyBytes(ext.mintAddress);
    const extAmount = new BN(ext.extAmount.toString());
    const fee = new BN(ext.fee.toString());
    const data = Buffer.concat([
        recipient,
        new BN(extAmount).toTwos(64).toArrayLike(Buffer, "le", 8),
        toU32LE(ext.encryptedOutput1.length),
        Buffer.from(ext.encryptedOutput1),
        toU32LE(ext.encryptedOutput2.length),
        Buffer.from(ext.encryptedOutput2),
        fee.toArrayLike(Buffer, "le", 8),
        feeRecipient,
        mint,
    ]);
    return Buffer.from(sha256(data).slice(2), "hex");
}
function toU32LE(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}
function toPubkeyBytes(v) {
    return Buffer.from((v instanceof PublicKey ? v : new PublicKey(v)).toBytes());
}
