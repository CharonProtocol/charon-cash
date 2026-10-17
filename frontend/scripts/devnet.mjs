// Bun loads .env before starting scripts. Explicitly select the devnet files so
// a pre-existing localnet .env cannot override the addresses passed to Vite.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const action = process.argv[2];
if (!["dev", "build"].includes(action)) throw new Error("Expected dev or build");
const root = new URL("../", import.meta.url);
const local = new URL(".env.devnet.local", root);
const profile = {
  ...parseEnv(readFileSync(new URL(".env.devnet", root), "utf8")),
  ...(existsSync(local) ? parseEnv(readFileSync(local, "utf8")) : {}),
};
const result = spawnSync("bun", ["run", action, "--mode", "devnet", ...process.argv.slice(3)], {
  cwd: fileURLToPath(root),
  env: { ...process.env, ...profile },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
