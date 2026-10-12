import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { configureProver, prove, terminateProver } from "../../src/prover";
import { verifyArtifact } from "../../src/circuit-artifacts";

const root = new URL("../../", import.meta.url);
const repository = new URL("../", root);

async function fixture(name: string) {
  return JSON.parse(await readFile(new URL(
    `crates/privacy-cash-prover/tests/fixtures/${name}_circuit.json`, repository,
  ), "utf8"));
}

beforeAll(async () => {
  configureProver({
    inThread: true,
    wasm: await readFile(new URL("prover-wasm/privacy_cash_prover_bg.wasm", root)),
    loadArtifacts: async () => {
      const circuits = new URL("programs/privacy-cash/artifacts/circuits/", repository);
      const zkey = await readFile(new URL("transaction2.zkey", circuits));
      const graph = await readFile(new URL("transaction2.graph", circuits));
      await verifyArtifact("zkey", zkey);
      await verifyArtifact("graph", graph);
      return { zkey, graph };
    },
  });
});

afterAll(() => terminateProver());

for (const kind of ["deposit", "withdraw", "spl"]) {
  test(`WASM prover generates a compressed ${kind} proof`, async () => {
    const input = await fixture(kind);
    const result = await prove(input);
    expect(result.proofA).toHaveLength(32);
    expect(result.proofB).toHaveLength(64);
    expect(result.proofC).toHaveLength(32);
    expect(result.publicSignals).toHaveLength(7);
    expect(result.publicSignals[0]).toBe(input.root);
  }, 30_000);
}

test("WASM prover rejects an unsatisfied withdrawal witness", async () => {
  const input = await fixture("withdraw");
  await expect(prove({ ...input, root: "12345" })).rejects.toThrow("does not verify");
}, 30_000);
