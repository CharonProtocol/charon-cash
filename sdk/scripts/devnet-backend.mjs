// Local backend runner. No deploy, airdrop, transfer, or program initialization.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Keypair } from "@solana/web3.js";

const root = new URL("../../", import.meta.url);
const deployment = JSON.parse(readFileSync(new URL("deployments/devnet.json", root), "utf8"));
const envFile = new URL("backend/.env.devnet", root);
const settings = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const signerPath = fileURLToPath(new URL("target/deploy/devnet-relayer.json", root));
const env = {
  ...process.env,
  PROGRAM_ID: deployment.programId,
  SOLANA_RPC_URL: deployment.rpcUrl,
  DATABASE_URL: "postgres://charon:charon-local-only@127.0.0.1:5434/charon_devnet",
  SUPPORTED_MINTS: `11111111111111111111111111111112,${deployment.testMint}`,
  RELAYER_KEYPAIR: signerPath,
  RELAYER_FEE_RECIPIENT: deployment.feeRecipient,
  RELAYER_ALT_ADDRESS: deployment.altAddress,
  RELAYER_FEE_RECIPIENT_KEYPAIR: "",
  RELAYER_SKIP_PREFLIGHT: "false",
  ADMIN_PASSWORD: "",
  BACKEND_BIND_ADDR: "127.0.0.1:8080",
  INDEXER_RPC_FALLBACK: settings.YELLOWSTONE_GRPC_URL ? "false" : "true",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CXXFLAGS: "-g0",
  ...settings,
};
if (env.PROGRAM_ID !== deployment.programId) throw new Error("Backend profile points to a different program");
if (env.RELAYER_KEYPAIR === signerPath && !existsSync(signerPath)) {
  mkdirSync(new URL("target/deploy/", root), { recursive: true, mode: 0o700 });
  const signer = Keypair.generate();
  writeFileSync(signerPath, JSON.stringify(Array.from(signer.secretKey)), { mode: 0o600, flag: "wx" });
  console.log(`Created local devnet relayer: ${signer.publicKey.toBase58()}`);
  console.log("This key has not been funded. Private transfers require a devnet SOL float.");
}
console.log(`Starting local devnet backend (${env.INDEXER_RPC_FALLBACK === "true" ? "RPC polling" : "Yellowstone"}).`);
const result = spawnSync("cargo", ["run", "--locked", "-j", "2"], {
  cwd: fileURLToPath(new URL("backend/", root)), env, stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
