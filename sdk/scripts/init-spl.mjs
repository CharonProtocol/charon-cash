import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "7nzEvHS6iyWApy1UMT8ewTiJjENP53o3gubhkcmSMfMp",
);

const connection = new Connection(RPC_URL, "confirmed");
const authority = Keypair.generate();

const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const usdtMint = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

const requestAirdrop = await connection.requestAirdrop(
  authority.publicKey,
  1 * LAMPORTS_PER_SOL,
);
await connection.confirmTransaction(requestAirdrop);

const [globalConfig] = PublicKey.findProgramAddressSync(
  [Buffer.from("global_config")],
  PROGRAM_ID,
);

const createInitSplIx = (mint) => {
  const [treeAccount, treeBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree"), mint.toBuffer()],
    PROGRAM_ID,
  );

  const maxDepositAmount = new BN("1000000000000"); // large limit
  const maxDepositBuffer = maxDepositAmount.toArrayLike(Buffer, "le", 8);

  const data = Buffer.concat([
    Buffer.from([1]), // Discriminator: InitializeTreeAccountForSplToken
    maxDepositBuffer, // max_deposit_amount
    Buffer.from([treeBump]), // tree_account_bump
    Buffer.alloc(7), // padding
  ]);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: treeAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: globalConfig, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
};

const transaction = new Transaction();
transaction.add(createInitSplIx(usdcMint));
transaction.add(createInitSplIx(usdtMint));

console.log("Sending init-spl transaction...");
try {
  const txSignature = await sendAndConfirmTransaction(connection, transaction, [
    authority,
  ]);
  console.log("Transaction successful:", txSignature);
} catch (e) {
  console.log(
    "Initialization might have failed (perhaps already initialized or mint doesn't exist locally).",
    e.message,
  );
}
