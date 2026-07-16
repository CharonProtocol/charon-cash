//! `pcash` — a command-line wallet for privacy-cash.
//!
//! Flow: `init` a shielded key once, `deposit` SOL into the pool, `scan` the indexer to recover
//! your notes, check `balance`, and `withdraw` to any address via a relayer (so the on-chain fee
//! payer is never linked to your funds).
//!
//! The shielded spending key never leaves this machine: proofs are generated locally, and scanning
//! trial-decrypts the indexer's feed here rather than asking the indexer "which notes are mine".

mod wallet;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use pc_client::{balance, build_sol_deposit, build_sol_withdraw, scan, Leaf};
use pc_core::MerkleTree;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_message::Message;
use solana_native_token::LAMPORTS_PER_SOL;
use solana_pubkey::Pubkey;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::collections::HashSet;
use std::str::FromStr;

use wallet::Wallet;

#[derive(Parser)]
#[command(name = "pcash", about = "Privacy Cash command-line wallet")]
struct Cli {
    /// Shielded wallet file (holds the spending key).
    #[arg(long, default_value = "pcash-wallet.json", global = true)]
    wallet: String,
    /// Indexer base URL (for scan / withdraw).
    #[arg(long, default_value = "http://localhost:8080", global = true)]
    indexer: String,
    /// Solana RPC URL (for deposit).
    #[arg(long, default_value = "https://api.devnet.solana.com", global = true)]
    rpc: String,
    /// Path to the circom proving key.
    #[arg(long, env = "PCASH_ZKEY", default_value = "artifacts/circuits/transaction2.zkey", global = true)]
    zkey: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create a new shielded wallet.
    Init,
    /// Deposit SOL into the shielded pool.
    Deposit {
        /// Amount in SOL.
        #[arg(long)]
        amount: f64,
        /// Fee-payer keypair (Solana CLI json).
        #[arg(long)]
        payer: String,
        /// The protocol fee recipient (defaults to the payer for a zero-fee deposit).
        #[arg(long)]
        fee_recipient: Option<String>,
    },
    /// Recover and list your notes from the indexer.
    Scan,
    /// Print your unspent shielded balance.
    Balance,
    /// Withdraw SOL to any address via a relayer.
    Withdraw {
        /// Amount in SOL to the recipient.
        #[arg(long)]
        amount: f64,
        /// Destination address (any pubkey; needs no funds and never signs).
        #[arg(long)]
        to: String,
        /// Relayer base URL.
        #[arg(long, default_value = "http://localhost:8081")]
        relayer: String,
    },
}

fn sol_to_lamports(sol: f64) -> u64 {
    (sol * LAMPORTS_PER_SOL as f64).round() as u64
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match &cli.command {
        Command::Init => cmd_init(&cli),
        Command::Deposit { amount, payer, fee_recipient } => {
            cmd_deposit(&cli, *amount, payer, fee_recipient.as_deref())
        }
        Command::Scan => cmd_scan(&cli),
        Command::Balance => cmd_balance(&cli),
        Command::Withdraw { amount, to, relayer } => cmd_withdraw(&cli, *amount, to, relayer),
    }
}

fn cmd_init(cli: &Cli) -> Result<()> {
    if std::path::Path::new(&cli.wallet).exists() {
        return Err(anyhow!("wallet {} already exists", cli.wallet));
    }
    let wallet = Wallet::generate();
    wallet.save(&cli.wallet)?;
    println!("created shielded wallet at {}", cli.wallet);
    Ok(())
}

/// Read the tree's current root straight from the on-chain account (authoritative for a deposit).
fn onchain_root(rpc: &RpcClient) -> Result<[u8; 32]> {
    let (tree, _) = pc_client::program::tree_account_pda();
    match rpc.get_account(&tree) {
        Ok(acct) => {
            // MerkleTreeAccount: max_deposit(8) next_index(4) root_index(1) bump(1) pad(2)
            // subtrees(832) root_history(100*32) authority(32).
            let root_index = acct.data[12] as usize;
            let off = 8 + 4 + 1 + 1 + 2 + 832 + root_index * 32;
            Ok(acct.data[off..off + 32].try_into().unwrap())
        }
        // Tree not initialized yet → the empty-tree root.
        Err(_) => Ok(MerkleTree::new().root_be32()),
    }
}

fn cmd_deposit(cli: &Cli, amount_sol: f64, payer_path: &str, fee_recipient: Option<&str>) -> Result<()> {
    let wallet = Wallet::load(&cli.wallet)?;
    let payer = wallet::read_keypair_file(payer_path)?;
    let rpc = RpcClient::new(cli.rpc.clone());

    let amount = sol_to_lamports(amount_sol);
    let fee_recipient = match fee_recipient {
        Some(s) => Pubkey::from_str(s).context("invalid --fee-recipient")?,
        None => payer.pubkey(),
    };
    let root = onchain_root(&rpc)?;

    let built = build_sol_deposit(
        &wallet.shielded,
        amount,
        0,
        payer.pubkey(),
        fee_recipient,
        payer.pubkey(),
        &root,
        &cli.zkey,
    )?;

    let ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
        built.instruction,
    ];
    let blockhash = rpc.get_latest_blockhash()?;
    let msg = Message::new(&ixs, Some(&payer.pubkey()));
    let tx = Transaction::new(&[&payer], msg, blockhash);
    let sig = rpc.send_and_confirm_transaction(&tx)?;
    println!("deposited {amount_sol} SOL — signature {sig}");
    println!("run `pcash scan` once the indexer has caught up to see your note");
    Ok(())
}

/// Pull the full scan feed (all leaves + all nullifiers) and match it locally.
fn fetch_and_scan(cli: &Cli) -> Result<Vec<pc_client::OwnedNote>> {
    let wallet = Wallet::load(&cli.wallet)?;
    let http = reqwest::blocking::Client::new();

    let leaves_json: serde_json::Value = http
        .get(format!("{}/tree/sol/leaves?from=0&to=100000", cli.indexer))
        .send()?
        .error_for_status()?
        .json()?;
    let mut leaves = Vec::new();
    for l in leaves_json["leaves"].as_array().cloned().unwrap_or_default() {
        leaves.push(Leaf {
            leaf_index: l["leaf_index"].as_u64().unwrap_or(0) as u32,
            commitment: hex32(l["commitment"].as_str().unwrap_or(""))?,
            encrypted_output: hex::decode(l["encrypted_output"].as_str().unwrap_or(""))?,
        });
    }

    let nulls_json: serde_json::Value = http
        .get(format!("{}/tree/sol/nullifiers?from_slot=0", cli.indexer))
        .send()?
        .error_for_status()?
        .json()?;
    let mut spent = HashSet::new();
    for n in nulls_json["nullifiers"].as_array().cloned().unwrap_or_default() {
        spent.insert(hex32(n.as_str().unwrap_or(""))?);
    }

    Ok(scan(&wallet.shielded, &leaves, &spent))
}

fn cmd_scan(cli: &Cli) -> Result<()> {
    let notes = fetch_and_scan(cli)?;
    for n in &notes {
        println!(
            "leaf {:>4}  {:>12} lamports  {}",
            n.utxo.index,
            n.utxo.amount,
            if n.spent { "spent" } else { "unspent" }
        );
    }
    println!("unspent balance: {} lamports", balance(&notes));
    Ok(())
}

fn cmd_balance(cli: &Cli) -> Result<()> {
    let notes = fetch_and_scan(cli)?;
    let bal = balance(&notes);
    println!("{} SOL ({} lamports)", bal as f64 / LAMPORTS_PER_SOL as f64, bal);
    Ok(())
}

fn cmd_withdraw(cli: &Cli, amount_sol: f64, to: &str, relayer_url: &str) -> Result<()> {
    let wallet = Wallet::load(&cli.wallet)?;
    let recipient = Pubkey::from_str(to).context("invalid --to address")?;
    let r = sol_to_lamports(amount_sol);
    let fee = r * 25 / 10_000; // 0.25% withdrawal fee (the initialized rate)

    // Recover notes and rebuild the Merkle mirror from the indexer's ordered leaves.
    let http = reqwest::blocking::Client::new();
    let leaves_json: serde_json::Value = http
        .get(format!("{}/tree/sol/leaves?from=0&to=100000", cli.indexer))
        .send()?
        .error_for_status()?
        .json()?;
    let leaf_rows = leaves_json["leaves"].as_array().cloned().unwrap_or_default();

    let mut tree = MerkleTree::new();
    for l in &leaf_rows {
        tree.append_be32(&hex32(l["commitment"].as_str().unwrap_or(""))?);
    }

    let notes = fetch_and_scan(cli)?;
    let note = notes
        .iter()
        .find(|n| !n.spent && n.utxo.amount >= r + fee)
        .ok_or_else(|| anyhow!("no unspent note large enough for {r} + fee {fee}"))?
        .utxo;

    // The relayer is the fee recipient; the client must build the proof binding it. We ask the
    // relayer's health/identity... for the demo we use the recipient's owner? Instead the fee
    // recipient must match on-chain config; take it from the indexer's tree config is out of
    // scope, so require it explicitly via env for now.
    let fee_recipient = std::env::var("PCASH_FEE_RECIPIENT")
        .ok()
        .and_then(|s| Pubkey::from_str(&s).ok())
        .ok_or_else(|| anyhow!("set PCASH_FEE_RECIPIENT to the relayer's fee account"))?;

    // signer is the relayer; its pubkey doesn't affect the proof (not bound in extDataHash), so a
    // placeholder is fine — the relayer re-signs. Use the recipient as a stand-in payer key.
    let built = build_sol_withdraw(
        &wallet.shielded,
        &note,
        r,
        fee,
        recipient,
        fee_recipient,
        recipient, // signer placeholder; relayer substitutes its own key when submitting
        &tree,
        &cli.zkey,
    )?;

    // The built instruction already embeds the proof; unpack the fields the relayer expects.
    let (proof_hex, ext_amount, fee_v, enc1, enc2) = split_instruction(&built.instruction)?;
    let payload = serde_json::json!({
        "proof_a": proof_hex.0,
        "proof_b": proof_hex.1,
        "proof_c": proof_hex.2,
        "public_signals": proof_hex.3,
        "ext_amount": ext_amount,
        "fee": fee_v,
        "encrypted_output1": hex::encode(enc1),
        "encrypted_output2": hex::encode(enc2),
        "recipient": recipient.to_string(),
    });

    let resp: serde_json::Value = http
        .post(format!("{relayer_url}/relay"))
        .json(&payload)
        .send()?
        .error_for_status()?
        .json()?;
    println!("withdrawal relayed — signature {}", resp["signature"]);
    Ok(())
}

fn hex32(s: &str) -> Result<[u8; 32]> {
    hex::decode(s)?
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("expected 32 bytes"))
}

/// Re-read the proof, ext_amount/fee and encrypted outputs out of a built transact instruction, to
/// forward to the relayer. Layout mirrors `build_transact_ix_data`.
#[allow(clippy::type_complexity)]
fn split_instruction(
    ix: &solana_instruction::Instruction,
) -> Result<((String, String, String, Vec<String>), i64, u64, Vec<u8>, Vec<u8>)> {
    let d = &ix.data;
    let mut o = 1usize; // skip discriminator
    let proof_a = hex::encode(&d[o..o + 64]);
    o += 64;
    let proof_b = hex::encode(&d[o..o + 128]);
    o += 128;
    let proof_c = hex::encode(&d[o..o + 64]);
    o += 64;
    let mut signals = Vec::with_capacity(7);
    for _ in 0..7 {
        signals.push(hex::encode(&d[o..o + 32]));
        o += 32;
    }
    let ext_amount = i64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    o += 8;
    let fee = u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    o += 8;
    let len1 = u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) as usize;
    o += 4;
    let enc1 = d[o..o + len1].to_vec();
    o += len1;
    let len2 = u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) as usize;
    o += 4;
    let enc2 = d[o..o + len2].to_vec();

    Ok(((proof_a, proof_b, proof_c, signals), ext_amount, fee, enc1, enc2))
}
