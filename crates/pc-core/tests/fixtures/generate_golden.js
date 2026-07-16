// Emits a golden fixture (commitments, nullifiers, proof bytes, public signals) as JSON,
// for the exact deposit inputs in generate_rust_proof_fixture.js. Used to validate the Rust
// pc-core (Poseidon/commitment/nullifier) and pc-prover (byte-exact proof).
const { WasmFactory } = require('@lightprotocol/hasher.rs');
const snarkjs = require('snarkjs');
const path = require('path');
const fs = require('fs');

const CIRCUITS = '/home/pankaj/turbine/pinochhio/privacy-cash-orignal/artifacts/circuits';

function be32(dec) {
  let h = BigInt(dec).toString(16).padStart(64, '0');
  const out = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

async function main() {
  const lightWasm = await WasmFactory.getInstance();
  const P = (arr) => lightWasm.poseidonHashString(arr.map(String));
  const mint = '1';

  const ins = [
    { priv: '11111', blinding: '222' },
    { priv: '33333', blinding: '444' },
  ].map((u) => {
    const pub = P([u.priv]);
    const commitment = P(['0', pub, u.blinding, mint]);
    const sig = P([u.priv, commitment, '0']);
    const nullifier = P([commitment, '0', sig]);
    return { ...u, pub, commitment, nullifier };
  });

  const outs = [
    { amount: '100', priv: '55555', blinding: '666' },
    { amount: '0', priv: '77777', blinding: '888' },
  ].map((u) => {
    const pub = P([u.priv]);
    const commitment = P([u.amount, pub, u.blinding, mint]);
    return { ...u, pub, commitment };
  });

  const input = {
    root: '42',
    publicAmount: '100',
    extDataHash: '12345',
    mintAddress: mint,
    inputNullifier: ins.map((u) => u.nullifier),
    inAmount: ['0', '0'],
    inPrivateKey: ins.map((u) => u.priv),
    inBlinding: ins.map((u) => u.blinding),
    inPathIndices: ['0', '0'],
    inPathElements: [Array(26).fill('0'), Array(26).fill('0')],
    outputCommitment: outs.map((u) => u.commitment),
    outAmount: outs.map((u) => u.amount),
    outPubkey: outs.map((u) => u.pub),
    outBlinding: outs.map((u) => u.blinding),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    path.join(CIRCUITS, 'transaction2.wasm'),
    path.join(CIRCUITS, 'transaction2.zkey')
  );

  const vkey = JSON.parse(fs.readFileSync(path.join(CIRCUITS, 'verifyingkey2.json')));
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!ok) throw new Error('snarkjs verification failed');

  // Wire format per prover.ts (uncompressed): A/C = be(x)||be(y) (un-negated); B = c1-before-c0.
  const proofA = [...be32(proof.pi_a[0]), ...be32(proof.pi_a[1])];
  const proofB = [
    ...be32(proof.pi_b[0][1]), ...be32(proof.pi_b[0][0]),
    ...be32(proof.pi_b[1][1]), ...be32(proof.pi_b[1][0]),
  ];
  const proofC = [...be32(proof.pi_c[0]), ...be32(proof.pi_c[1])];

  const out = {
    // decimal field values (for pc-core Poseidon parity)
    pubkeys: { in: ins.map((u) => u.pub), out: outs.map((u) => u.pub) },
    commitments_dec: {
      in: ins.map((u) => u.commitment),
      out: outs.map((u) => u.commitment),
    },
    nullifiers_dec: ins.map((u) => u.nullifier),
    // big-endian bytes (for on-chain / pc-prover parity)
    commitments_be32: outs.map((u) => be32(u.commitment)),
    nullifiers_be32: ins.map((u) => be32(u.nullifier)),
    publicSignals,
    publicSignals_be32: publicSignals.map(be32),
    proofA, proofB, proofC,
  };
  fs.writeFileSync('golden.json', JSON.stringify(out, null, 2));
  console.log('wrote golden.json; snarkjs verify OK');
  console.log('nullifier0 dec =', ins[0].nullifier);
  console.log('commitment0(out) dec =', outs[0].commitment);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
