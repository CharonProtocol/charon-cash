import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";

const PROGRAM_ID = new PublicKey(
  "A6jNiYjV9g7omJ4zHAyiDQtcRewobsko7gs9UjZ2pWRa",
);

// Create authority
const authority = Keypair.generate();

const connection = new Connection(RPC_URL, "confirmed");

// Fund authority
const requestAirdrop = await connection.requestAirdrop(
  authority.publicKey,
  100 * LAMPORTS_PER_SOL,
);
await connection.confirmTransaction(requestAirdrop);

// Derive PDAs
const [treeAccount, treeBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("merkle_tree")],
  PROGRAM_ID,
);

const [treeToken, treeTokenBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("tree_token")],
  PROGRAM_ID,
);

const [globalConfig, globalBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("global_config")],
  PROGRAM_ID,
);

const data = Buffer.concat(
  [
    Buffer.from([0]),
    Buffer.from([treeBump]),
    Buffer.from([treeTokenBump]),
    Buffer.from([globalBump]),
  ],
  4,
);

// Create instruction
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    {
      pubkey: treeAccount,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: treeToken,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: globalConfig,
      isSigner: false,
      isWritable: true,
    },
    {
      pubkey: authority.publicKey,
      isSigner: true,
      isWritable: true,
    },
    {
      pubkey: SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    },
  ],
  data: data,
});

// Create transaction
const transaction = new Transaction();

transaction.add(ix);

// Send
const txSignature = await sendAndConfirmTransaction(connection, transaction, [
  authority,
]);

console.log("Transaction successful:", txSignature);
console.log("Tree account:", treeAccount.toBase58());
console.log("Tree token:", treeToken.toBase58());
console.log("Global config:", globalConfig.toBase58());
