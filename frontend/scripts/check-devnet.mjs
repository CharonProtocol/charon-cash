// Read-only readiness checks. Never loads a signing key or sends transactions.
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { Connection, PublicKey } from "@solana/web3.js";

const root = new URL("../", import.meta.url);
const local = new URL(".env.devnet.local", root);
const env = {
  ...parseEnv(readFileSync(new URL(".env.devnet", root), "utf8")),
  ...(existsSync(local) ? parseEnv(readFileSync(local, "utf8")) : {}),
};
const deployment = JSON.parse(readFileSync(new URL("../../deployments/devnet.json", import.meta.url), "utf8"));
const backend = (env.VITE_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const connection = new Connection(env.VITE_SOLANA_RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10000) }),
});
const checks = [];
async function check(label, fn) {
  try {
    await fn();
    checks.push({ label, passed: true });
  } catch (error) {
    checks.push({ label, passed: false, reason: error.message });
  }
}
function require(condition, message) {
  if (!condition) throw new Error(message);
}
async function get(path) {
  const response = await fetch(`${backend}${path}`, { signal: AbortSignal.timeout(10000) });
  require(response.ok, `${path}: HTTP ${response.status}`);
  const body = await response.json();
  require(body.success !== false, `${path}: backend reported an error`);
  return body;
}

await check("devnet RPC", async () => {
  const genesisHash = await connection.getGenesisHash();
  require(genesisHash === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", `RPC is not Solana devnet (genesis ${genesisHash})`);
});
await check("deployed program", async () => {
  require(env.VITE_PROGRAM_ID === deployment.programId, "Profile differs from deployment record");
  const account = await connection.getAccountInfo(new PublicKey(env.VITE_PROGRAM_ID));
  require(account?.executable, "Program is missing or not executable");
});
await check("lookup table", async () => {
  const table = (await connection.getAddressLookupTable(new PublicKey(env.VITE_ALT_ADDRESS))).value;
  require(table?.isActive(), "Lookup table is missing or inactive");
});
await check("backend and relayer configuration", async () => {
  const info = await get("/api/relayer/info");
  require(info.program_id === env.VITE_PROGRAM_ID, "Wrong backend program ID");
  require(info.fee_recipient === env.VITE_FEE_RECIPIENT, "Wrong backend fee recipient");
  for (const mint of env.VITE_SUPPORTED_SPL_MINTS.split(",")) {
    require(info.supported_mints?.some((entry) => entry.mint === mint), "Backend is missing the devnet test mint");
  }
  require(info.spl_relay_available, "Backend has no SPL lookup table configured");
});
for (const [mint, tree] of [
  ["11111111111111111111111111111112", deployment.tree],
  [deployment.testMint, deployment.splTree],
]) {
  await check(`indexed Merkle root: ${mint}`, async () => {
    const account = await connection.getAccountInfo(new PublicKey(tree));
    require(account?.owner.toBase58() === env.VITE_PROGRAM_ID, "Tree is missing or owned by a different program");
    const data = account.data;
    const rootIndex = data[12];
    const onchainRoot = data.subarray(848 + rootIndex * 32, 880 + rootIndex * 32);
    const { data: indexed } = await get(`/api/pools/${mint}/merkle`);
    require(Number(indexed.nextLeafIndex) === data.readUInt32LE(8), "Indexer has not replayed all leaves");
    require(Buffer.from(indexed.currentRoot).equals(onchainRoot), "Indexer root differs from on-chain root");
  });
}
console.log(JSON.stringify({ cluster: "devnet", checks }, null, 2));
process.exitCode = checks.every((entry) => entry.passed) ? 0 : 1;
