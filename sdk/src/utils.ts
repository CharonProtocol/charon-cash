import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  SEED,
  TRANSACT_IX_DISCRIMINATOR,
  TRANSACT_SPL_IX_DISCRIMINATOR,
} from "./constants";
import { Proof } from "./prover";
import { ProofBytes } from "./program";
import { MerkleProofPair } from "./api";

// Adjust endian ('le' | 'be') to match how Node bytes were produced on the Rust side.
export function bytesToBN(bytes: Uint8Array): BN {
  return new BN(bytes, undefined, "be");
}

export function getMintAddressField(mint: PublicKey): string {
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

export type ExtData = {
  recipient: PublicKey | string;
  extAmount: BN | number | string;
  encryptedOutput1: Uint8Array;
  encryptedOutput2: Uint8Array;
  fee: BN | number | string;
  feeRecipient: PublicKey | string;
  mintAddress: PublicKey | string;
};

export type CircuitParams = {
  root: string;
  inputNullifier: string[];
  outputCommitment: string[];
  publicAmount: string;
  extDataHash: Uint8Array<ArrayBufferLike>;
  inAmount: string[];
  inPrivateKey: BN[];
  inBlinding: string[];
  inPathIndices: number[];
  inPathElements: string[][];
  outAmount: string[];
  outBlinding: string[];
  outPubkey: BN[];
  mintAddress: string;
};

export interface TransactAccounts {
  treeAccount: PublicKey;
  treeTokenAccount: PublicKey;
  globalConfig: PublicKey;
  nullifier0: PublicKey;
  nullifier1: PublicKey;
  nullifier2: PublicKey;
  nullifier3: PublicKey;
  bump0: number;
  bump1: number;
}

export function deriveAccounts(
  programId: PublicKey,
  nullifierHash0: Uint8Array,
  nullifierHash1: Uint8Array,
): TransactAccounts {
  const [treeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TREE_ACCOUNT)],
    programId,
  );
  const [treeTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TREE_TOKEN)],
    programId,
  );
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.GLOBAL_CONFIG)],
    programId,
  );
  const [nullifier0, bump0] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.NULLIFIER0), Buffer.from(nullifierHash0)],
    programId,
  );
  const [nullifier1, bump1] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.NULLIFIER1), Buffer.from(nullifierHash1)],
    programId,
  );
  const [nullifier2] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.NULLIFIER0), Buffer.from(nullifierHash1)],
    programId,
  );
  const [nullifier3] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.NULLIFIER1), Buffer.from(nullifierHash0)],
    programId,
  );
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

export function serializeProofAndExtData(
  proof: ProofBytes,
  extData: ExtData,
  isSpl: boolean = false,
) {
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

export function buildMerkleCircuitInputs(pair: MerkleProofPair) {
  const inPathElements: string[][] = [pair.proof1, pair.proof2].map((mp) =>
    mp.proof.map((node) => bytesToBN(node).toString()),
  );

  const inPathIndices: number[] = [pair.proof1.index, pair.proof2.index];

  const root = bytesToBN(pair.proof1.root).toString();

  return { inPathElements, inPathIndices, root };
}
