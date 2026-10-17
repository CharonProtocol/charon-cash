// Devnet only. Uses a persistent authority; never requests an airdrop or deploys code.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, AddressLookupTableProgram, ComputeBudgetProgram,
  sendAndConfirmTransaction, SYSVAR_SLOT_HASHES_PUBKEY,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getMint,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const root = fileURLToPath(new URL("../../", import.meta.url));
const loadKey = path => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const payer = loadKey(process.env.PAYER_KEYPAIR || `${homedir()}/.config/solana/id.json`);
const program = loadKey(`${root}target/deploy/devnet-program-keypair.json`).publicKey;
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const manifestPath = `${root}target/deploy/devnet.json`;
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {
  cluster: "devnet", rpcUrl: connection.rpcEndpoint, programId: program.toBase58(),
  authority: payer.publicKey.toBase58(), transactions: {},
};
assert.equal(manifest.programId, program.toBase58());
assert.equal(manifest.authority, payer.publicKey.toBase58());
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const deployed = await connection.getAccountInfo(program);
assert(deployed?.executable, "Deploy the matching SBF binary before initialization");
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === "string" ? Buffer.from(s) : s), program);
const [tree, treeBump] = pda("merkle_tree");
const [vault, vaultBump] = pda("tree_token");
const [config, configBump] = pda("global_config");
Object.assign(manifest, { tree: tree.toBase58(), vault: vault.toBase58(), globalConfig: config.toBase58(), feeRecipient: payer.publicKey.toBase58() });
save();
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
async function send(label, instructions) {
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(...instructions), [payer]);
  manifest.transactions[label] = signature;
  save();
  console.log(`${label}: ${signature}`);
}
if (!await connection.getAccountInfo(config)) {
  await send("initializeSol", [new TransactionInstruction({
    programId: program,
    keys: [meta(tree), meta(vault), meta(config), meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)],
    data: Buffer.from([0, treeBump, vaultBump, configBump]),
  })]);
}
for (const [address, size] of [[tree, 4080], [vault, 33], [config, 40]]) {
  const account = await connection.getAccountInfo(address);
  assert(account?.owner.equals(program), `Wrong owner for ${address}`);
  assert.equal(account.data.length, size, `Wrong size for ${address}`);
  const authorityOffset = size === 4080 ? 4048 : 0;
  assert(new PublicKey(account.data.subarray(authorityOffset, authorityOffset + 32)).equals(payer.publicKey), "Unexpected initialization authority");
}

// A dedicated 6-decimal test mint; mainnet USDC/USDT addresses are not devnet assets.
if (!manifest.testMint) {
  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  manifest.testMint = mint.toBase58();
  manifest.testMintLabel = "Charon devnet test token (6 decimals; not real USDC)";
  save();
}
const mint = new PublicKey(manifest.testMint);
const mintState = await getMint(connection, mint);
assert.equal(mintState.decimals, 6);
const [splTree, splBump] = pda("merkle_tree", mint.toBuffer());
manifest.splTree = splTree.toBase58();
if (!await connection.getAccountInfo(splTree)) {
  const data = Buffer.alloc(17);
  data[0] = 1;
  data.writeBigUInt64LE(1_000_000_000_000n, 1);
  data[9] = splBump;
  await send("initializeSpl", [new TransactionInstruction({
    programId: program,
    keys: [meta(splTree), meta(mint), meta(config), meta(payer.publicKey, true, true), meta(SystemProgram.programId, false)], data,
  })]);
}
const tokenAccounts = [];
for (const owner of [payer.publicKey, config]) {
  tokenAccounts.push(await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner, true));
}
if (tokenAccounts[0].amount < 10_000_000n) {
  manifest.transactions.mintTestTokens = await mintTo(connection, payer, mint, tokenAccounts[0].address, payer, 1_000_000_000n);
  save();
}
if (!manifest.altAddress) {
  // Pick an actual ancestor block from SlotHashes, leaving room for RPC-node
  // skew. Subtracting a slot number can select a skipped slot instead.
  const slotHashes = await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY);
  assert(slotHashes && slotHashes.data.readBigUInt64LE(0) > 32n);
  const recentSlot = Number(slotHashes.data.readBigUInt64LE(8 + 32 * 40));
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot,
  });
  const addresses = [tree, vault, config, program, payer.publicKey, SystemProgram.programId,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ComputeBudgetProgram.programId,
    mint, splTree, ...tokenAccounts.map(a => a.address),
    getAssociatedTokenAddressSync(mint, config, true)];
  await send("createAlt", [createIx, AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: address,
    addresses: [...new Map(addresses.map(a => [a.toBase58(), a])).values()],
  })]);
  manifest.altAddress = address.toBase58();
}
save();
console.log(JSON.stringify(manifest, null, 2));
