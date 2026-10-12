import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { PROGRAM_ID, SEED, DISC_TRANSACT, DISC_TRANSACT_SPL, } from "./constants";
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
export function deriveAccounts(programId, nullifierHash0, nullifierHash1, mintAddress) {
    const treeAccountSeeds = [
        Buffer.from(SEED.TREE_ACCOUNT),
    ];
    if (mintAddress) {
        treeAccountSeeds.push(mintAddress.toBuffer());
    }
    const [treeAccount] = PublicKey.findProgramAddressSync(treeAccountSeeds, programId);
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
export function deriveNullifiers(nullifierHash) {
    if (nullifierHash.length !== 32) {
        console.error("BAD SEED LENGTH:", nullifierHash.length, Array.from(nullifierHash));
        return;
    }
    try {
        const [nullifier0, bump0] = PublicKey.findProgramAddressSync([Buffer.from(SEED.NULLIFIER0), Buffer.from(nullifierHash)], PROGRAM_ID);
        const [nullifier1, bump1] = PublicKey.findProgramAddressSync([Buffer.from(SEED.NULLIFIER1), Buffer.from(nullifierHash)], PROGRAM_ID);
        return [nullifier0, nullifier1];
    }
    catch (error) {
        console.log("Web Worker Error ,", error);
    }
}
export function poseidonStringToBytes32(hashStr) {
    const big = BigInt(hashStr);
    const hex = big.toString(16).padStart(64, "0"); // 32 bytes = 64 hex chars
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}
export function serializeProofAndExtData(proof, extData, isSpl = false, bump0, bump1) {
    // Create the ExtDataMinified object for the program call (only extAmount and fee)
    const extDataMinified = {
        extAmount: extData.extAmount,
        fee: extData.fee,
    };
    // Use the appropriate discriminator based on whether this is SPL or native SOL
    const discriminator = isSpl ? [DISC_TRANSACT_SPL] : [DISC_TRANSACT];
    const nullifierHash0 = Uint8Array.from(proof.inputNullifiers[0]);
    const nullifierHash1 = Uint8Array.from(proof.inputNullifiers[1]);
    // Use the same serialization approach as deposit script
    const instructionData = Buffer.concat([
        Buffer.from(discriminator),
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
        new BN(extData.extAmount).toTwos(64).toArrayLike(Buffer, "le", 8),
        new BN(extData.fee).toArrayLike(Buffer, "le", 8),
        // Serialize encrypted outputs as separate parameters
        toU32LE(extData.encryptedOutput1.length),
        Buffer.from(extData.encryptedOutput1),
        toU32LE(extData.encryptedOutput2.length),
        Buffer.from(extData.encryptedOutput2),
        Buffer.from([bump0, bump1]),
    ]);
    return instructionData;
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
const SWAP_IN_DOMAIN = Buffer.from("privacy_cash:swap_in:v1");
const SWAP_OUT_DOMAIN = Buffer.from("privacy_cash:swap_out:v1");
/** In-leg hash. Byte layout matches `calculate_swap_in_ext_data_hash`. */
export function getSwapInExtDataHash(args) {
    const data = Buffer.concat([
        SWAP_IN_DOMAIN,
        new BN(args.extAmountIn.toString()).toTwos(64).toArrayLike(Buffer, "le", 8),
        toU32LE(args.encryptedOutput1.length),
        Buffer.from(args.encryptedOutput1),
        toU32LE(args.encryptedOutput2.length),
        Buffer.from(args.encryptedOutput2),
        toPubkeyBytes(args.inMint),
        toPubkeyBytes(args.outMint),
        new BN(args.minAmountOut.toString()).toTwos(64).toArrayLike(Buffer, "le", 8),
        Buffer.from(args.outCommitments[0]),
        Buffer.from(args.outCommitments[1]),
    ]);
    return Buffer.from(sha256(data).slice(2), "hex");
}
/** Out-leg hash. Does not mention the in-leg. Matches `calculate_swap_out_ext_data_hash`. */
export function getSwapOutExtDataHash(args) {
    const data = Buffer.concat([
        SWAP_OUT_DOMAIN,
        new BN(args.extAmountOut.toString()).toTwos(64).toArrayLike(Buffer, "le", 8),
        toU32LE(args.encryptedOutput1.length),
        Buffer.from(args.encryptedOutput1),
        toU32LE(args.encryptedOutput2.length),
        Buffer.from(args.encryptedOutput2),
        toPubkeyBytes(args.outMint),
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
