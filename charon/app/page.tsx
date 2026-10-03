import Image from "next/image";

import { Ambient } from "@/components/Ambient";
import { Lantern } from "@/components/Lantern";
import { MerkleArt } from "@/components/MerkleArt";
import { Reveal } from "@/components/Reveal";
import { WaitlistForm } from "@/components/WaitlistForm";

const facts = [
  { value: "26", label: "Poseidon tree levels" },
  { value: "7", label: "public signals checked" },
  { value: "100", label: "recent roots accepted" },
  { value: "0", label: "keys sent to a server" },
];

const features = [
  {
    title: "The key stays on your device",
    body: "Proofs are built in the browser. The witness, the blinding values, and the spend key are never posted to a server.",
  },
  {
    title: "The chain checks a proof, not the note",
    body: "The program verifies a Groth16 proof on BN254 against seven public signals. It never learns which leaf was spent.",
  },
  {
    title: "One prover, everywhere",
    body: "The browser and the program tests run the same Rust prover, so there is no second implementation to drift from the circuit.",
  },
  {
    title: "SOL and SPL, as notes",
    body: "Deposits become commitments in one tree. A nullifier spends each note once. Tokens use the same shape as SOL.",
  },
];

type Term = { t: string; code?: boolean; core?: boolean };

/**
 * Public names only: what the circuit and program are built from.
 * Rows widen then narrow so the block reads as an oval. `core` terms are the ones kept on small screens.
 */
const stack: Term[][] = [
  [{ t: "Solana" }, { t: "Groth16", core: true }, { t: "Anchor" }],
  [
    { t: "circom" },
    { t: "BN254", core: true },
    { t: "ext_data_hash", code: true, core: true },
    { t: "R1CS" },
    { t: "verifying key" },
  ],
  [
    { t: "ark-groth16", code: true },
    { t: "root", code: true },
    { t: "Poseidon", core: true },
    { t: "public_amount", code: true, core: true },
    { t: "mint_address", code: true },
    { t: "WASM" },
  ],
  [
    { t: "path_elements", code: true },
    { t: "height 26" },
    { t: "input_nullifier[2]", code: true, core: true },
    { t: "Merkle tree", core: true },
    { t: "output_commitment[2]", code: true, core: true },
    { t: "path_indices", code: true },
    { t: "ark-bn254", code: true },
  ],
  [
    { t: "UTXO notes" },
    { t: "root history ×100" },
    { t: "commitment", core: true },
    { t: "nullifier", core: true },
    { t: "2-in / 2-out" },
    { t: "SPL tokens" },
  ],
  [
    { t: "blinding" },
    { t: "keypair signature" },
    { t: "nullifier PDA", core: true },
    { t: "Rust prover", core: true },
    { t: "relayer" },
  ],
  [{ t: "encrypted outputs" }, { t: "in-browser proving", core: true }],
];

export default function Page() {
  return (
    <>
      <Ambient />
      <Reveal />

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="kicker">
              <span className="dot" /> Shielded notes on Solana
            </p>
            <h1>
              A private balance on a <em>public</em> chain.
            </h1>
            <p className="lede">
              Charon holds value in notes only you can spend. Your device builds the proof, the program checks it, and the key never leaves you.
            </p>
            <div className="hero-actions">
              <a className="btn" href="#list" data-join>
                <Lantern />
                Join the list
              </a>
              <a className="btn-ghost" href="#how">
                How it works
              </a>
            </div>
          </div>
          <div className="hero-art">
            <MerkleArt />
            <div className="halo" />
            <Image
              className="logo"
              src="/mark-lit.jpg"
              alt="The Charon mark: a hooded figure in a boat, lantern lit"
              width={1024}
              height={986}
              priority
              sizes="(max-width: 860px) 90vw, 520px"
            />
          </div>
        </section>

        <ul className="facts" data-reveal>
          {facts.map((f) => (
            <li key={f.label}>
              <strong>{f.value}</strong>
              <span>{f.label}</span>
            </li>
          ))}
        </ul>

        <section id="why" className="why" data-reveal>
          <div>
            <p className="kicker">Why it exists</p>
            <h2>A public chain remembers the whole path.</h2>
          </div>
          <div className="why-body">
            <p>
              On Solana, amounts, addresses, and timing sit in the open. Follow one payment and you can usually find the one before it. A wallet is not a balance. It is a history.
            </p>
            <p>
              Hiding that on a server does not fix it. Whoever builds the proof holds the spend key, and whoever holds the key can spend the note. <strong>Privacy is the machine the proof is made on.</strong>
            </p>
          </div>
        </section>

        <section id="how" className="how" data-reveal>
          <div className="how-head">
            <p className="kicker">How it works</p>
            <h2>A pool of notes. A proof at the crossing.</h2>
            <p className="how-sub">
              Deposit into a note. Spend it by proving you own a note in the tree that has not been spent, without showing which one.
            </p>
          </div>
          <div className="cards">
            {features.map((f, i) => (
              <article className="card" key={f.title} style={{ "--d": `${i * 70}ms` } as React.CSSProperties}>
                <span className="card-n">
                  <Lantern />0{i + 1}
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="list" className="list" data-reveal>
          <div className="list-copy">
            <p className="kicker">Early access</p>
            <h2>Take a place on the near shore.</h2>
            <p>
              Leave an address to hear when Charon opens. A withdrawal to a public address is still public; Charon hides the path that led to it.
            </p>
          </div>
          <WaitlistForm />
        </section>
      </main>

      <footer className="foot">
        <ul className="stack" aria-label="What Charon is built with">
          {stack.flatMap((row, r) => [
            ...row.map((s) => (
              <li
                key={s.t}
                className={[s.code && "code", !s.core && "extra"].filter(Boolean).join(" ") || undefined}
              >
                {s.t}
              </li>
            )),
            r < stack.length - 1 && <li key={`br${r}`} className="stack-br" aria-hidden="true" />,
          ])}
        </ul>
        <div className="foot-bar">
          <span>© 2026 Charon Protocol. All rights reserved.</span>
        </div>
      </footer>
    </>
  );
}
