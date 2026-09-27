import {
  AddressLookupTableProgram,
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

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "6MyU66azgzrp6eioGxmKrGZSxv7FB9nb1oXSrd1Qkwmn",
);
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";

// Create authority
const authority = Keypair.generate();

const connection = new Connection(RPC_URL, "confirmed");

// Fund authority
const requestAirdrop = await connection.requestAirdrop(
  authority.publicKey,
  100 * LAMPORTS_PER_SOL,
);

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

const { blockhash, lastValidBlockHeight } =
  await connection.getLatestBlockhash("confirmed");

const [createAltIx, lookupTableAddress] =
  AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot: await connection.getSlot("confirmed"),
  });

const extendAltIx = AddressLookupTableProgram.extendLookupTable({
  payer: authority.publicKey,
  authority: authority.publicKey,
  lookupTable: lookupTableAddress,
  addresses: [
    treeAccount,
    treeToken,
    globalConfig,
    new PublicKey("5kHwyJA15XjiHYxUTGif8NoH25h1dTxjqhscTnf4V1Ua"), // feeRecipient
    new PublicKey("6MyU66azgzrp6eioGxmKrGZSxv7FB9nb1oXSrd1Qkwmn"), // ProgramId
    SystemProgram.programId, // + save 31 bytes
  ],
});

const altTx = new Transaction().add(createAltIx, extendAltIx);

const altSignature = await sendAndConfirmTransaction(connection, altTx, [
  authority,
]);

console.log("ALT created:", lookupTableAddress.toBase58());
console.log("ALT transaction:", altSignature);
