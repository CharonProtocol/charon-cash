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
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

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

const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const usdtMint = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

const createAtaIfMintExists = async (mint, owner, allowOwnerOffCurve) => {
  const mintInfo = await connection.getAccountInfo(mint);
  if (mintInfo) {
    const ata = getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve);
    // Check if ATA already exists
    const ataInfo = await connection.getAccountInfo(ata);
    if (!ataInfo) {
      const ataIx = createAssociatedTokenAccountInstruction(
        authority.publicKey,
        ata,
        owner,
        mint,
      );
      transaction.add(ataIx);
      console.log(
        `Added instruction to create ATA for mint ${mint.toBase58()} and owner ${owner.toBase58()}`,
      );
    }
  }
};

await createAtaIfMintExists(usdcMint, globalConfig, true);
await createAtaIfMintExists(usdtMint, globalConfig, true);
const feeRecipient = new PublicKey(
  "5kHwyJA15XjiHYxUTGif8NoH25h1dTxjqhscTnf4V1Ua",
);
await createAtaIfMintExists(usdcMint, feeRecipient, true);
await createAtaIfMintExists(usdtMint, feeRecipient, true);

// Send
const txSignature = await sendAndConfirmTransaction(connection, transaction, [
  authority,
]);

console.log("Transaction successful:", txSignature);
console.log("Tree account:", treeAccount.toBase58());
console.log("Tree token:", treeToken.toBase58());
console.log("Global config:", globalConfig.toBase58());
