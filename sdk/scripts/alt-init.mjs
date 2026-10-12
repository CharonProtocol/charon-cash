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
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "7nzEvHS6iyWApy1UMT8ewTiJjENP53o3gubhkcmSMfMp",
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

const feeRecipient = new PublicKey(
  process.env.FEE_RECIPIENT || "5kHwyJA15XjiHYxUTGif8NoH25h1dTxjqhscTnf4V1Ua",
);

const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const usdtMint = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

const [treeAccountUSDC] = PublicKey.findProgramAddressSync(
  [Buffer.from("merkle_tree"), usdcMint.toBuffer()],
  PROGRAM_ID,
);
const [treeAccountUSDT] = PublicKey.findProgramAddressSync(
  [Buffer.from("merkle_tree"), usdtMint.toBuffer()],
  PROGRAM_ID,
);
const computeBudgetProgram = new PublicKey(
  "ComputeBudget111111111111111111111111111111",
);

const addresses = [
  treeAccount,
  treeToken,
  globalConfig,
  feeRecipient,
  PROGRAM_ID, // ProgramId
  SystemProgram.programId, // + save 31 bytes
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  usdcMint,
  usdtMint,
  getAssociatedTokenAddressSync(usdcMint, globalConfig, true),
  getAssociatedTokenAddressSync(usdtMint, globalConfig, true),
  getAssociatedTokenAddressSync(usdcMint, feeRecipient),
  getAssociatedTokenAddressSync(usdtMint, feeRecipient),
  treeAccountUSDC,
  treeAccountUSDT,
  computeBudgetProgram,
];

if (process.env.RELAYER_ADDRESS) {
  const relayerAddress = new PublicKey(process.env.RELAYER_ADDRESS);
  addresses.push(
    relayerAddress,
    getAssociatedTokenAddressSync(usdcMint, relayerAddress),
    getAssociatedTokenAddressSync(usdtMint, relayerAddress)
  );
}

const extendAltIx = AddressLookupTableProgram.extendLookupTable({
  payer: authority.publicKey,
  authority: authority.publicKey,
  lookupTable: lookupTableAddress,
  addresses,
});

const altTx = new Transaction().add(createAltIx, extendAltIx);

const altSignature = await sendAndConfirmTransaction(connection, altTx, [
  authority,
]);

console.log("ALT created:", lookupTableAddress.toBase58());
console.log("ALT transaction:", altSignature);
