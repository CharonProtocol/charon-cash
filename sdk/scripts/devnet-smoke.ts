// Real devnet transactions with SDK encryption and WASM proofs. No backend shim.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import BN from "bn.js";
import { WasmFactory } from "@lightprotocol/hasher.rs";
import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
  AddressLookupTableProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount,
} from "@solana/spl-token";
import { Utxo } from "../src/model/utxo";
import { EncryptionService } from "../src/encrypt";
import { configureProver, prove, terminateProver } from "../src/prover";
import { verifyArtifact } from "../src/circuit-artifacts";
import { deriveAccounts, getExtDataHash, getMintAddressField, serializeProofAndExtData } from "../src/utils";
import type { ProofBytes } from "../src/prover";

const root = fileURLToPath(new URL("../../", import.meta.url));
const loadKey = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const payer = loadKey(process.env.PAYER_KEYPAIR || `${homedir()}/.config/solana/id.json`);
const recipientPath = `${root}target/deploy/devnet-recipient.json`;
if (!existsSync(recipientPath)) writeFileSync(recipientPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
const recipient = loadKey(recipientPath).publicKey;
const deployment = JSON.parse(readFileSync(`${root}target/deploy/devnet.json`, "utf8"));
assert.equal(deployment.cluster, "devnet");
const program = new PublicKey(deployment.programId);
const config = new PublicKey(deployment.globalConfig);
const feeRecipient = new PublicKey(deployment.feeRecipient);
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const lightWasm = await WasmFactory.getInstance();
const field = new BN("21888242871839275222246405745257275088548364400416034343698204186575808495617");
const solMint = "11111111111111111111111111111112";
const hash = (a: string, b: string) => lightWasm.poseidonHashString([a, b]);
const zeros = ["0"];
for (let level = 0; level < 26; level++) zeros.push(hash(zeros[level], zeros[level]));
const decimal = (bytes: Uint8Array) => new BN(bytes).toString();
const reports: any[] = [];
const reportPath = `${root}target/deploy/devnet-smoke.json`;
const save = () => writeFileSync(reportPath, JSON.stringify({
  programId: program.toBase58(), cluster: "devnet", checkedAt: new Date().toISOString(), checks: reports,
}, null, 2) + "\n");
const record = (result: any) => { reports.push(result); save(); console.log(JSON.stringify(result)); };
configureProver({
  inThread: true,
  wasm: readFileSync(`${root}sdk/prover-wasm/privacy_cash_prover_bg.wasm`),
  loadArtifacts: async () => {
    const base = `${root}programs/privacy-cash/artifacts/circuits/transaction2`;
    const zkey = readFileSync(`${base}.zkey`), graph = readFileSync(`${base}.graph`);
    await verifyArtifact("zkey", zkey); await verifyArtifact("graph", graph);
    return { zkey, graph };
  },
});
const encryption = await EncryptionService.startEncryptionService(randomBytes(32));
const receiverEncryption = await EncryptionService.startEncryptionService(randomBytes(32));
const meta = (pubkey: PublicKey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
const altAddress = new PublicKey(deployment.altAddress);
let alt = (await connection.getAddressLookupTable(altAddress)).value;
assert(alt, "Lookup table missing");
// Random encrypted notes plus SPL account metas need recipient addresses in
// the table as well as protocol addresses to stay below the 1,232-byte limit.
const recipientAddresses = [recipient, getAssociatedTokenAddressSync(new PublicKey(deployment.testMint), recipient)];
const missing = recipientAddresses.filter(address => !alt!.state.addresses.some(a => a.equals(address)));
if (missing.length) {
  await sendAndConfirmTransaction(connection, new Transaction().add(AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: altAddress, addresses: missing,
  })), [payer]);
  alt = (await connection.getAddressLookupTable(altAddress)).value;
  assert(alt);
  let active = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    if (await connection.getSlot() > alt.state.lastExtendedSlot) { active = true; break; }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  assert(active, "Lookup-table extension is not active yet");
}

async function snapshot(tree: PublicKey) {
  const info = await connection.getAccountInfo(tree);
  assert(info?.owner.equals(program));
  assert.equal(info.data.length, 4080);
  const data = info.data;
  return {
    next: data.readUInt32LE(8), rootIndex: data[12],
    root: decimal(data.subarray(848 + data[12] * 32, 880 + data[12] * 32)),
    subtrees: Array.from({ length: 26 }, (_, i) => decimal(data.subarray(16 + i * 32, 48 + i * 32))),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
function append(state: Snapshot, outputs: Utxo[]) {
  assert.equal(state.next % 2, 0);
  const path = [outputs[1].getCommitment()];
  let value = hash(outputs[0].getCommitment(), outputs[1].getCommitment());
  for (let level = 1; level < 26; level++) {
    const right = ((state.next >> level) & 1) === 1;
    const sibling = right ? state.subtrees[level] : zeros[level];
    path.push(sibling);
    value = right ? hash(sibling, value) : hash(value, sibling);
  }
  return { root: value, path };
}
function notes(amount: number, mint: string, index: number) {
  return [amount, 0].map((value, i) => new Utxo({
    lightWasm, amount: value, index: index + i, mintAddress: mint,
    blinding: new BN(randomBytes(31)),
  }));
}
async function transaction(ix: TransactionInstruction) {
  const block = await connection.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: block.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }), ix],
  }).compileToV0Message([alt!]));
  tx.sign([payer]);
  return { tx, block };
}
async function reject(label: string, ix: TransactionInstruction, expected: unknown) {
  const { tx } = await transaction(ix);
  const result = (await connection.simulateTransaction(tx, { sigVerify: true })).value;
  assert(result.err, `${label} was unexpectedly accepted`);
  assert.deepEqual(result.err, { InstructionError: [1, expected] });
  assert(result.logs?.some(line => line.includes(`Program ${program} invoke`)), "Rejection happened before program execution");
  record({ label, rejected: true, error: result.err, logs: result.logs?.filter(line => line.includes(program.toBase58())) });
}
async function run(mint: string, label: string) {
  const isSpl = mint !== solMint;
  const mintKey = new PublicKey(mint);
  const tree = PublicKey.findProgramAddressSync(isSpl ? [Buffer.from("merkle_tree"), mintKey.toBuffer()] : [Buffer.from("merkle_tree")], program)[0];
  if (isSpl) await getOrCreateAssociatedTokenAccount(connection, payer, mintKey, recipient);
  const balance = async (owner: PublicKey) => isSpl
    ? (await getAccount(connection, getAssociatedTokenAddressSync(mintKey, owner, true))).amount
    : BigInt(await connection.getBalance(owner));
  const before = await balance(recipient);
  let input: Utxo | undefined;
  let inputPath: string[] | undefined;
  // 10,025,000 in = 10,000,000 withdrawn + 25,000 protocol fee, no change.
  const depositAmount = 10_025_000;
  for (const kind of ["deposit", "transfer", "withdraw"]) {
    const state = await snapshot(tree);
    const extAmount = kind === "deposit" ? depositAmount : kind === "withdraw" ? -10_000_000 : 0;
    const fee = kind === "withdraw" ? 25_000 : 0;
    const inputs = input ? [input, notes(0, mint, 0)[0]] : notes(0, mint, 0);
    const outputs = notes(kind === "withdraw" ? 0 : depositAmount, mint, state.next);
    const targetEncryption = kind === "deposit" ? encryption : receiverEncryption;
    const encryptedOutput1 = await encryption.encrypt(outputs[0].serialize(), targetEncryption.getViewingKey());
    const encryptedOutput2 = await encryption.encrypt(outputs[1].serialize(), targetEncryption.getViewingKey());
    assert.deepEqual(await targetEncryption.decrypt(encryptedOutput1), outputs[0].serialize());
    if (kind === "transfer") await assert.rejects(() => encryption.decrypt(encryptedOutput1));
    const ext = {
      recipient: isSpl ? getAssociatedTokenAddressSync(mintKey, recipient) : recipient,
      extAmount: new BN(extAmount), fee: new BN(fee),
      feeRecipient: isSpl ? getAssociatedTokenAddressSync(mintKey, feeRecipient) : feeRecipient,
      mintAddress: mintKey, encryptedOutput1, encryptedOutput2,
    };
    const proofResult = await prove({
      root: state.root, publicAmount: new BN(extAmount).sub(new BN(fee)).umod(field).toString(),
      extDataHash: getExtDataHash(ext), mintAddress: getMintAddressField(mintKey),
      inputNullifier: inputs.map(n => n.getNullifier()), outputCommitment: outputs.map(n => n.getCommitment()),
      inAmount: inputs.map(n => n.amount.toString()), inPrivateKey: inputs.map(n => n.keypair.privkey),
      inBlinding: inputs.map(n => n.blinding.toString()), inPathIndices: inputs.map(n => n.index),
      inPathElements: [inputPath ?? Array(26).fill("0"), Array(26).fill("0")],
      outAmount: outputs.map(n => n.amount.toString()), outBlinding: outputs.map(n => n.blinding.toString()), outPubkey: outputs.map(n => n.keypair.pubkey),
    });
    const signals = proofResult.publicSignals.map(s => new BN(s).toArray("be", 32));
    const proof: ProofBytes = {
      proofA: proofResult.proofA, proofB: proofResult.proofB, proofC: proofResult.proofC,
      root: signals[0], publicAmount: signals[1], extDataHash: signals[2],
      inputNullifiers: signals.slice(3, 5), outputCommitments: signals.slice(5, 7),
    };
    const a = deriveAccounts(program, Uint8Array.from(signals[3]), Uint8Array.from(signals[4]), isSpl ? mintKey : undefined);
    const common = [meta(a.treeAccount), meta(a.nullifier0), meta(a.nullifier1), meta(a.nullifier2, false), meta(a.nullifier3, false)];
    const keys = isSpl ? [...common, meta(config), meta(payer.publicKey, true, true), meta(mintKey, false),
      meta(getAssociatedTokenAddressSync(mintKey, payer.publicKey)), meta(recipient, false),
      meta(getAssociatedTokenAddressSync(mintKey, recipient)), meta(getAssociatedTokenAddressSync(mintKey, config, true)),
      meta(getAssociatedTokenAddressSync(mintKey, feeRecipient)), meta(TOKEN_PROGRAM_ID, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(SystemProgram.programId, false)]
      : [...common, meta(a.treeTokenAccount), meta(config, false), meta(recipient), meta(feeRecipient), meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)];
    const ix = new TransactionInstruction({ programId: program, keys, data: serializeProofAndExtData(proof, ext, isSpl, a.bump0, a.bump1) });
    const expected = append(state, outputs);
    if (kind === "deposit") {
      const bad = new TransactionInstruction({ programId: program, keys, data: Buffer.from(ix.data) });
      bad.data[1] ^= 1;
      await reject(`${label}:invalid-proof`, bad, { Custom: 14 });
      assert.deepEqual(await snapshot(tree), state);
    }
    const { tx, block } = await transaction(ix);
    const signature = await connection.sendTransaction(tx, { skipPreflight: false });
    const confirmation = await connection.confirmTransaction({ signature, ...block });
    assert.equal(confirmation.value.err, null);
    const after = await snapshot(tree);
    assert.equal(after.next, state.next + 2);
    assert.equal(after.root, expected.root);
    assert.equal(after.rootIndex, (state.rootIndex + 1) % 100);
    record({ label: `${label}:${kind}`, signature, nextIndex: after.next, root: after.root });
    if (kind === "deposit") {
      await reject(`${label}:double-spend`, ix, "AccountAlreadyInitialized");
      assert.deepEqual(await snapshot(tree), after);
    }
    input = outputs[0]; inputPath = expected.path;
  }
  assert.equal(await balance(recipient) - before, 10_000_000n);
  record({ label: `${label}:recipient-balance`, received: "10000000", passed: true });
}
try {
  await run(solMint, "SOL");
  await run(deployment.testMint, "SPL");
  record({ label: "complete", passed: true });
} finally { terminateProver(); }
