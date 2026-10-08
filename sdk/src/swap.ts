import type { LightWasm } from "@lightprotocol/hasher.rs";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import { API } from "./api";
import { API_URL, FIELD_SIZE, MERKLE_TREE_DEPTH, PROGRAM_ID, SEED } from "./constants";
import { EncryptionService } from "./encrypt";
import { Utxo } from "./model/utxo";
import { parseToBytesArray, prove, type CircuitParams, type ProofBytes } from "./prover";
import {
  bytesToBN,
  getMintAddressField,
  getSwapInExtDataHash,
  getSwapOutExtDataHash,
} from "./utils";

const SOL_MIXER_MINT = "11111111111111111111111111111112";
const JUPITER_SOL_MINT = "So11111111111111111111111111111111111111112";

export function isSolMixerMint(mint: string): boolean {
  return mint === SOL_MIXER_MINT;
}

function jupiterMint(mixerMint: string): string {
  return isSolMixerMint(mixerMint) ? JUPITER_SOL_MINT : mixerMint;
}

function bytesToHex(bytes: ArrayLike<number>): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

function commitmentBytes(commitment: string): Uint8Array {
  return Uint8Array.from(parseToBytesArray([commitment])[0]!);
}

function zeroPath(): string[] {
  return new Array<string>(MERKLE_TREE_DEPTH).fill("0");
}

export interface JupiterRoute {
  minOut: string;
  outAmount: string;
  routeData: Uint8Array;
  routeAccounts: { pubkey: string; isWritable: boolean }[];
}

export async function fetchJupiterRoute(req: {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  userPublicKey: string;
  slippageBps?: number;
}): Promise<JupiterRoute> {
  const res = await fetch(`${API_URL}/api/jupiter/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: String(req.amount),
      userPublicKey: req.userPublicKey,
      slippageBps: req.slippageBps ?? 100,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message ?? `jupiter route failed: HTTP ${res.status}`);
  }
  const data = json.data ?? json;
  const hex = String(data.route_data ?? data.routeData ?? "").replace(/^0x/i, "");
  if (!hex || hex.length % 2 !== 0) {
    throw new Error("jupiter route returned no instruction data");
  }
  const routeData = new Uint8Array(hex.length / 2);
  for (let i = 0; i < routeData.length; i++) {
    routeData[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const accounts = (data.route_accounts ?? data.routeAccounts ?? []) as {
    pubkey: string;
    isWritable?: boolean;
    is_writable?: boolean;
  }[];
  return {
    minOut: String(data.minOut ?? data.min_out ?? data.otherAmountThreshold ?? ""),
    outAmount: String(data.outAmount ?? data.out_amount ?? ""),
    routeData,
    routeAccounts: accounts.map((account) => ({
      pubkey: account.pubkey,
      isWritable: !!(account.isWritable ?? account.is_writable),
    })),
  };
}

async function relaySwap(req: {
  proofIn: ProofBytes;
  proofOut: ProofBytes;
  extAmountIn: string;
  extAmountOut: string;
  encryptedOutputIn1: Uint8Array;
  encryptedOutputIn2: Uint8Array;
  encryptedOutputOut1: Uint8Array;
  encryptedOutputOut2: Uint8Array;
  fromMint: string;
  outMint: string;
  routeData: Uint8Array;
  routeAccounts: { pubkey: string; isWritable: boolean }[];
}): Promise<string> {
  const pack = (proof: ProofBytes) => ({
    proof_a: bytesToHex(proof.proofA),
    proof_b: bytesToHex(proof.proofB),
    proof_c: bytesToHex(proof.proofC),
    root: bytesToHex(proof.root),
    public_amount: bytesToHex(proof.publicAmount),
    ext_data_hash: bytesToHex(proof.extDataHash),
    input_nullifiers: proof.inputNullifiers.map((nullifier) => bytesToHex(nullifier)),
    output_commitments: proof.outputCommitments.map((commitment) => bytesToHex(commitment)),
  });
  const res = await fetch(`${API_URL}/api/relayer/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proof_in: pack(req.proofIn),
      proof_out: pack(req.proofOut),
      ext_amount_in: req.extAmountIn,
      ext_amount_out: req.extAmountOut,
      encrypted_output_in1: bytesToHex(req.encryptedOutputIn1),
      encrypted_output_in2: bytesToHex(req.encryptedOutputIn2),
      encrypted_output_out1: bytesToHex(req.encryptedOutputOut1),
      encrypted_output_out2: bytesToHex(req.encryptedOutputOut2),
      from_mint: req.fromMint,
      out_mint: req.outMint,
      route_data: bytesToHex(req.routeData),
      route_accounts: req.routeAccounts,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message ?? `relayer swap failed: HTTP ${res.status}`);
  }
  const signature = json.signature ?? json.data?.signature;
  if (!signature) throw new Error("relayer swap returned no signature");
  return signature as string;
}

async function proveLeg(input: CircuitParams): Promise<ProofBytes> {
  const { publicSignals, proofA, proofB, proofC } = await prove(input);
  const bytes = parseToBytesArray(publicSignals);
  return {
    proofA,
    proofB,
    proofC,
    root: bytes[0]!,
    publicAmount: bytes[1]!,
    extDataHash: bytes[2]!,
    inputNullifiers: [bytes[3]!, bytes[4]!],
    outputCommitments: [bytes[5]!, bytes[6]!],
  };
}

/**
 * Atomic private swap. Spends `inputUtxos` of `fromMint`, Jupiter-swaps inside
 * the pool, and shields `minOut` of `outMint`. The relayer signs the v1 packet.
 */
export async function swapPrivate(args: {
  fromMint: string;
  outMint: string;
  amountIn: BN;
  inputUtxos: Utxo[];
  lightwasm: LightWasm;
  encryptionService: EncryptionService;
  slippageBps?: number;
}): Promise<string> {
  const { fromMint, outMint, amountIn, inputUtxos, lightwasm, encryptionService } = args;
  if (isSolMixerMint(fromMint) === isSolMixerMint(outMint)) {
    throw new Error("swap is SOL to SPL or SPL to SOL only");
  }
  if (inputUtxos.length !== 2) {
    throw new Error("swap needs exactly two input notes");
  }

  const totalInput = inputUtxos.reduce((sum, utxo) => sum.add(utxo.amount), new BN(0));
  if (amountIn.gt(totalInput)) {
    throw new Error(
      `insufficient private balance: have ${totalInput.toString()}, need ${amountIn.toString()}`,
    );
  }
  const changeAmount = totalInput.sub(amountIn);

  const { root, proofs, nextIndex } = await API.fetchMerkleProof(
    fromMint,
    [inputUtxos[0]!.index, inputUtxos[1]!.index],
    inputUtxos.map((utxo) => utxo.getCommitment()),
  );
  const outTree = await API.fetchTreeState(outMint);
  const inNext = Number(nextIndex);
  const outNext = outTree.nextLeafIndex.toNumber();

  const viewingKey = encryptionService.getViewingKey();
  const change = new Utxo({
    lightWasm: lightwasm,
    amount: changeAmount,
    index: inNext,
    mintAddress: fromMint,
  });
  const dummyChange = new Utxo({
    lightWasm: lightwasm,
    amount: 0,
    index: inNext + 1,
    mintAddress: fromMint,
  });

  const splMint = new PublicKey(isSolMixerMint(fromMint) ? outMint : fromMint);
  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.GLOBAL_CONFIG)],
    PROGRAM_ID,
  );
  const route = await fetchJupiterRoute({
    inputMint: jupiterMint(fromMint),
    outputMint: jupiterMint(outMint),
    amount: amountIn.toString(),
    userPublicKey: globalConfig.toBase58(),
    slippageBps: args.slippageBps,
  });
  const minOut = new BN(route.minOut);
  if (minOut.lten(0)) throw new Error("jupiter quote returned no output");

  const received = new Utxo({
    lightWasm: lightwasm,
    amount: minOut,
    index: outNext,
    mintAddress: outMint,
  });
  const dummyOut = new Utxo({
    lightWasm: lightwasm,
    amount: 0,
    index: outNext + 1,
    mintAddress: outMint,
  });
  const dummyInputs = [
    new Utxo({ lightWasm: lightwasm, amount: 0, mintAddress: outMint }),
    new Utxo({ lightWasm: lightwasm, amount: 0, mintAddress: outMint }),
  ];

  const encIn1 = await encryptionService.encrypt(change.serialize(), viewingKey);
  const encIn2 = await encryptionService.encrypt(dummyChange.serialize(), viewingKey);
  const encOut1 = await encryptionService.encrypt(received.serialize(), viewingKey);
  const encOut2 = await encryptionService.encrypt(dummyOut.serialize(), viewingKey);

  const extAmountIn = amountIn.neg();
  const inHash = getSwapInExtDataHash({
    extAmountIn,
    encryptedOutput1: encIn1,
    encryptedOutput2: encIn2,
    inMint: fromMint,
    outMint,
    minAmountOut: minOut,
    outCommitments: [commitmentBytes(received.getCommitment()), commitmentBytes(dummyOut.getCommitment())],
  });
  const outHash = getSwapOutExtDataHash({
    extAmountOut: minOut,
    encryptedOutput1: encOut1,
    encryptedOutput2: encOut2,
    outMint,
  });

  const publicAmountIn = extAmountIn.add(FIELD_SIZE).mod(FIELD_SIZE);
  const proofIn = await proveLeg({
    root: bytesToBN(root).toString(),
    inputNullifier: inputUtxos.map((utxo) => utxo.getNullifier()),
    outputCommitment: [change.getCommitment(), dummyChange.getCommitment()],
    publicAmount: publicAmountIn.toString(),
    extDataHash: inHash,
    inAmount: inputUtxos.map((utxo) => utxo.amount.toString(10)),
    inPrivateKey: inputUtxos.map((utxo) => utxo.keypair.privkey),
    inBlinding: inputUtxos.map((utxo) => utxo.blinding.toString(10)),
    inPathIndices: inputUtxos.map((utxo) => utxo.index),
    inPathElements: proofs.map((path) => path.map((node) => bytesToBN(node).toString())),
    outAmount: [change.amount.toString(10), dummyChange.amount.toString(10)],
    outBlinding: [change.blinding.toString(10), dummyChange.blinding.toString(10)],
    outPubkey: [change.keypair.pubkey, dummyChange.keypair.pubkey],
    mintAddress: getMintAddressField(new PublicKey(fromMint)),
  });
  const proofOut = await proveLeg({
    root: bytesToBN(Uint8Array.from(outTree.currentRoot)).toString(),
    inputNullifier: dummyInputs.map((utxo) => utxo.getNullifier()),
    outputCommitment: [received.getCommitment(), dummyOut.getCommitment()],
    publicAmount: minOut.toString(),
    extDataHash: outHash,
    inAmount: ["0", "0"],
    inPrivateKey: dummyInputs.map((utxo) => utxo.keypair.privkey),
    inBlinding: dummyInputs.map((utxo) => utxo.blinding.toString(10)),
    inPathIndices: [0, 0],
    inPathElements: [zeroPath(), zeroPath()],
    outAmount: [received.amount.toString(10), dummyOut.amount.toString(10)],
    outBlinding: [received.blinding.toString(10), dummyOut.blinding.toString(10)],
    outPubkey: [received.keypair.pubkey, dummyOut.keypair.pubkey],
    mintAddress: getMintAddressField(new PublicKey(outMint)),
  });

  return relaySwap({
    proofIn,
    proofOut,
    extAmountIn: extAmountIn.toString(),
    extAmountOut: minOut.toString(),
    encryptedOutputIn1: encIn1,
    encryptedOutputIn2: encIn2,
    encryptedOutputOut1: encOut1,
    encryptedOutputOut2: encOut2,
    fromMint,
    outMint,
    routeData: route.routeData,
    routeAccounts: route.routeAccounts,
  });
}
