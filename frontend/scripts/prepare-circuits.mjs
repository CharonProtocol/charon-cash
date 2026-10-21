// Copy the pinned proving artifacts into Vite's public directory on every build.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL(
  "../../programs/charon/artifacts/circuits/",
  import.meta.url,
);
const destination = new URL("../public/circuit/", import.meta.url);
const manifest = await readFile(new URL("SHA256SUMS", source), "utf8");
await mkdir(destination, { recursive: true });

for (const file of ["transaction2.zkey", "transaction2.graph"]) {
  const entry = manifest.split("\n").find((line) => line.endsWith(`/` + file));
  if (!entry) throw new Error(`No pinned checksum for ${file}`);
  const expected = entry.split(/\s+/)[0];
  const bytes = await readFile(new URL(file, source));
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error(`Checksum mismatch for ${file}`);
  }
  await writeFile(new URL(file, destination), bytes);
  console.log(`Prepared circuit/${file}`);
}
