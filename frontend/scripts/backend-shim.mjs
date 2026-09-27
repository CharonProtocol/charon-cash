// Minimal setup script: sends ONLY the program's `initialize` instruction
// (creates the SOL merkle tree / tree_token / global_config PDAs), then exits.
// No indexing, no relayer, no privacy-cash-sdk dependency — pure @solana/web3.js.
// Run: bun scripts/initialize.mjs   (or: node scripts/initialize.mjs)
import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

// ---- env config ----
const PROGRAM = new PublicKey(
  process.env.PROGRAM_ID ?? "6MyU66azgzrp6eioGxmKrGZSxv7FB9nb1oXSrd1Qkwmn",
);
const RPC =
  process.env.RPC_URL ?? process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
const idJson =
  process.env.ID_JSON ?? path.join(homedir(), ".config/solana/id.json");

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  Buffer.from(JSON.parse(readFileSync(idJson, "utf8"))),
);

// surfpool (mainnet-forking local validator) lazy-loads referenced accounts;
// if that upstream fetch is slow/offline it rejects with "Failed to fetch
// accounts from remote". Retry on that (and 429/timeout).
async function sendRawWithRetry(serialized, opts, attempts = 7) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await conn.sendRawTransaction(serialized, opts);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      if (
        /Failed to fetch accounts from remote|mainnet-beta|429|Too Many|timeout|error sending request/i.test(
          msg,
        )
      ) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function sendIx(ix) {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      ix,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await sendRawWithRetry(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 5,
  });
  try {
    await conn.confirmTransaction(sig, "confirmed");
  } catch {}
  const slot = await conn.getSlot("confirmed");
  return { signature: sig, slot, status: "confirmed" };
}

function buildInitializeSolIx() {
  const [treeAccount, tb] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree")],
    PROGRAM,
  );
  const [treeToken, ttb] = PublicKey.findProgramAddressSync(
    [Buffer.from("tree_token")],
    PROGRAM,
  );
  const [globalConfig, gb] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    PROGRAM,
  );
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: treeToken, isSigner: false, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0, tb, ttb, gb]),
  });
  return { ix, treeAccount };
}

const { ix, treeAccount } = buildInitializeSolIx();

const existing = await conn.getAccountInfo(treeAccount);
if (existing) {
  console.log(
    `already initialized — tree account ${treeAccount.toBase58()} exists.`,
  );
  process.exit(0);
}

console.log(`initializing SOL pool on ${RPC} (program ${PROGRAM.toBase58()})…`);
const result = await sendIx(ix);
console.log(`initialized. tree account: ${treeAccount.toBase58()}`);
console.log(result);
