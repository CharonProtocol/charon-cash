//! Transaction assembly.
//!
//! The relayer builds the `transact` instruction itself rather than accepting a
//! pre-signed transaction, because the fee payer is part of the signed message:
//! for the relayer to pay, it has to be the one compiling the message.

use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;

use crate::relayer::chain::{
    derive_ata, derive_spl_tree_account, derive_transact_pdas, ATA_PROGRAM_ID, TOKEN_PROGRAM_ID,
};

pub const DISC_TRANSACT: u8 = 2;
pub const DISC_TRANSACT_SPL: u8 = 3;
pub const DISC_SWAP: u8 = 7;
pub const DISC_WRAP_SOL: u8 = 8;

pub const COMPUTE_BUDGET_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("ComputeBudget111111111111111111111111111111");

/// The Groth16 proof plus public inputs, exactly as the program's `Proof` struct
/// expects them: 352 bytes of compressed points and big-endian field elements.
#[derive(Clone)]
pub struct ProofBytes {
    pub proof_a: [u8; 32],
    pub proof_b: [u8; 64],
    pub proof_c: [u8; 32],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

impl ProofBytes {
    fn serialize(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(352);
        out.extend_from_slice(&self.proof_a);
        out.extend_from_slice(&self.proof_b);
        out.extend_from_slice(&self.proof_c);
        out.extend_from_slice(&self.root);
        out.extend_from_slice(&self.public_amount);
        out.extend_from_slice(&self.ext_data_hash);
        out.extend_from_slice(&self.input_nullifiers[0]);
        out.extend_from_slice(&self.input_nullifiers[1]);
        out.extend_from_slice(&self.output_commitments[0]);
        out.extend_from_slice(&self.output_commitments[1]);
        out
    }
}

pub struct TransactIxParams<'a> {
    pub program_id: Pubkey,
    /// The account that signs and pays. For a relayed withdraw or transfer this is
    /// the relayer, which is the whole point: the user's wallet never appears.
    pub signer: Pubkey,
    pub proof: &'a ProofBytes,
    pub ext_amount: i64,
    pub fee: u64,
    pub encrypted_output1: &'a [u8],
    pub encrypted_output2: &'a [u8],
    pub recipient: Pubkey,
    pub fee_recipient: Pubkey,
    /// `Some` for SPL, `None` for native SOL.
    pub spl: Option<SplExtras>,
}

#[derive(Clone)]
pub struct SplExtras {
    pub mint: Pubkey,
    pub signer_token_account: Pubkey,
    pub recipient_token_account: Pubkey,
    pub fee_recipient_ata: Pubkey,
}

fn build_ix_data(params: &TransactIxParams<'_>, bump0: u8, bump1: u8) -> Vec<u8> {
    let disc = if params.spl.is_some() {
        DISC_TRANSACT_SPL
    } else {
        DISC_TRANSACT
    };
    let mut data = Vec::with_capacity(
        1 + 352 + 8 + 8 + 4 + params.encrypted_output1.len() + 4 + params.encrypted_output2.len() + 2,
    );
    data.push(disc);
    data.extend_from_slice(&params.proof.serialize());
    data.extend_from_slice(&params.ext_amount.to_le_bytes());
    data.extend_from_slice(&params.fee.to_le_bytes());
    data.extend_from_slice(&(params.encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(params.encrypted_output1);
    data.extend_from_slice(&(params.encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(params.encrypted_output2);
    data.push(bump0);
    data.push(bump1);
    data
}

/// Account order mirrors `process_transact` / `process_transact_spl` destructuring.
pub fn build_transact_instruction(params: &TransactIxParams<'_>) -> Instruction {
    let pdas = derive_transact_pdas(
        &params.program_id,
        &params.proof.input_nullifiers[0],
        &params.proof.input_nullifiers[1],
    );
    let data = build_ix_data(params, pdas.bump0, pdas.bump1);

    let accounts = match &params.spl {
        None => vec![
            AccountMeta::new(pdas.tree_account, false),
            AccountMeta::new(pdas.nullifier0, false),
            AccountMeta::new(pdas.nullifier1, false),
            AccountMeta::new_readonly(pdas.nullifier2, false),
            AccountMeta::new_readonly(pdas.nullifier3, false),
            AccountMeta::new(pdas.tree_token_account, false),
            AccountMeta::new_readonly(pdas.global_config, false),
            AccountMeta::new(params.recipient, false),
            AccountMeta::new(params.fee_recipient, false),
            AccountMeta::new(params.signer, true),
            AccountMeta::new_readonly(crate::relayer::chain::SYSTEM_PROGRAM_ID, false),
        ],
        Some(spl) => {
            let tree_account = derive_spl_tree_account(&params.program_id, &spl.mint);
            let tree_ata = derive_ata(&pdas.global_config, &spl.mint);
            vec![
                AccountMeta::new(tree_account, false),
                AccountMeta::new(pdas.nullifier0, false),
                AccountMeta::new(pdas.nullifier1, false),
                AccountMeta::new_readonly(pdas.nullifier2, false),
                AccountMeta::new_readonly(pdas.nullifier3, false),
                AccountMeta::new_readonly(pdas.global_config, false),
                AccountMeta::new(params.signer, true),
                AccountMeta::new_readonly(spl.mint, false),
                AccountMeta::new(spl.signer_token_account, false),
                AccountMeta::new_readonly(params.recipient, false),
                AccountMeta::new(spl.recipient_token_account, false),
                AccountMeta::new(tree_ata, false),
                AccountMeta::new(spl.fee_recipient_ata, false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new_readonly(ATA_PROGRAM_ID, false),
                AccountMeta::new_readonly(crate::relayer::chain::SYSTEM_PROGRAM_ID, false),
            ]
        }
    };

    Instruction {
        program_id: params.program_id,
        accounts,
        data,
    }
}

pub fn set_compute_unit_limit(units: u32) -> Instruction {
    let mut data = Vec::with_capacity(5);
    data.push(0x02);
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET_PROGRAM_ID,
        accounts: vec![],
        data,
    }
}

pub fn set_compute_unit_price(micro_lamports: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(0x03);
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET_PROGRAM_ID,
        accounts: vec![],
        data,
    }
}

/// Idempotent ATA creation, so a relayed withdrawal can pay a recipient who has no
/// token account yet. Instruction data `[1]` is `CreateIdempotent`.
pub fn create_ata_idempotent(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    let ata = derive_ata(owner, mint);
    Instruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(crate::relayer::chain::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: vec![1],
    }
}

/// SPL Token `SyncNative`, so the wSOL account's token amount catches up with the
/// lamports `wrap_sol` moved into it.
pub fn sync_native(account: &Pubkey) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*account, false)],
        data: vec![17],
    }
}

// ---------------- Swap (v1) ----------------

pub struct SwapAccounts {
    pub sol_tree_account: Pubkey,
    pub tree_token_account: Pubkey,
    pub global_config: Pubkey,
    pub out_tree_account: Pubkey,
    pub pool_wsol_account: Pubkey,
    pub pool_spl_account: Pubkey,
}

pub fn derive_swap_accounts(program_id: &Pubkey, spl_mint: &Pubkey) -> SwapAccounts {
    let (sol_tree_account, _) =
        Pubkey::find_program_address(&[crate::relayer::chain::TREE_ACCOUNT_SEED], program_id);
    let (tree_token_account, _) =
        Pubkey::find_program_address(&[crate::relayer::chain::TREE_TOKEN_ACCOUNT_SEED], program_id);
    let (global_config, _) =
        Pubkey::find_program_address(&[crate::relayer::chain::GLOBAL_CONFIG_SEED], program_id);
    let (out_tree_account, _) = Pubkey::find_program_address(
        &[crate::relayer::chain::TREE_ACCOUNT_SEED, spl_mint.as_ref()],
        program_id,
    );
    SwapAccounts {
        sol_tree_account,
        tree_token_account,
        global_config,
        out_tree_account,
        pool_wsol_account: derive_ata(&global_config, &crate::relayer::chain::NATIVE_MINT),
        pool_spl_account: derive_ata(&global_config, spl_mint),
    }
}

pub struct SwapIxParams<'a> {
    pub program_id: Pubkey,
    pub signer: Pubkey,
    pub proof_in: &'a ProofBytes,
    pub proof_out: &'a ProofBytes,
    pub ext_amount_in: i64,
    pub ext_amount_out: i64,
    pub encrypted_output_in1: &'a [u8],
    pub encrypted_output_in2: &'a [u8],
    pub encrypted_output_out1: &'a [u8],
    pub encrypted_output_out2: &'a [u8],
    /// `true` when shielded SOL is being swapped for an SPL token.
    pub sol_to_spl: bool,
    pub spl_mint: Pubkey,
    pub route_data: &'a [u8],
    pub route_accounts: &'a [(Pubkey, bool)],
}

fn length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

fn build_swap_ix_data(params: &SwapIxParams<'_>, jupiter_account_indices: &[u8]) -> Vec<u8> {
    let in_pdas = derive_transact_pdas(
        &params.program_id,
        &params.proof_in.input_nullifiers[0],
        &params.proof_in.input_nullifiers[1],
    );
    let out_pdas = derive_transact_pdas(
        &params.program_id,
        &params.proof_out.input_nullifiers[0],
        &params.proof_out.input_nullifiers[1],
    );

    let mut data = Vec::new();
    data.push(DISC_SWAP);
    data.extend_from_slice(&params.proof_in.serialize());
    data.extend_from_slice(&params.proof_out.serialize());
    data.extend_from_slice(&params.ext_amount_in.to_le_bytes());
    data.extend_from_slice(&params.ext_amount_out.to_le_bytes());
    data.extend_from_slice(&[
        in_pdas.bump0,
        in_pdas.bump1,
        out_pdas.bump0,
        out_pdas.bump1,
    ]);
    length_prefixed(&mut data, params.encrypted_output_in1);
    length_prefixed(&mut data, params.encrypted_output_in2);
    length_prefixed(&mut data, params.encrypted_output_out1);
    length_prefixed(&mut data, params.encrypted_output_out2);
    length_prefixed(&mut data, params.route_data);
    length_prefixed(&mut data, jupiter_account_indices);
    data
}

/// The Jupiter route's accounts are folded into the swap instruction's own account
/// list and referenced by index, with the high bit marking writability. Reusing
/// existing entries rather than appending duplicates is what keeps a route inside
/// the 64-account v1 cap.
pub fn build_swap_instruction(params: &SwapIxParams<'_>) -> Result<Instruction, String> {
    let swap = derive_swap_accounts(&params.program_id, &params.spl_mint);
    let in_pdas = derive_transact_pdas(
        &params.program_id,
        &params.proof_in.input_nullifiers[0],
        &params.proof_in.input_nullifiers[1],
    );
    let out_pdas = derive_transact_pdas(
        &params.program_id,
        &params.proof_out.input_nullifiers[0],
        &params.proof_out.input_nullifiers[1],
    );
    let (in_tree, out_tree) = if params.sol_to_spl {
        (swap.sol_tree_account, swap.out_tree_account)
    } else {
        (swap.out_tree_account, swap.sol_tree_account)
    };

    let mut keys = vec![
        AccountMeta::new(in_tree, false),
        AccountMeta::new(in_pdas.nullifier0, false),
        AccountMeta::new(in_pdas.nullifier1, false),
        AccountMeta::new_readonly(in_pdas.nullifier2, false),
        AccountMeta::new_readonly(in_pdas.nullifier3, false),
        AccountMeta::new(out_pdas.nullifier0, false),
        AccountMeta::new(out_pdas.nullifier1, false),
        AccountMeta::new_readonly(out_pdas.nullifier2, false),
        AccountMeta::new_readonly(out_pdas.nullifier3, false),
        AccountMeta::new(swap.tree_token_account, false),
        AccountMeta::new(out_tree, false),
        AccountMeta::new(swap.global_config, false),
        AccountMeta::new_readonly(crate::relayer::chain::NATIVE_MINT, false),
        AccountMeta::new(swap.pool_wsol_account, false),
        AccountMeta::new_readonly(params.spl_mint, false),
        AccountMeta::new(swap.pool_spl_account, false),
        AccountMeta::new(params.signer, true),
        AccountMeta::new_readonly(crate::relayer::chain::JUPITER_PROGRAM_ID, false),
        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        AccountMeta::new_readonly(ATA_PROGRAM_ID, false),
        AccountMeta::new_readonly(crate::relayer::chain::SYSTEM_PROGRAM_ID, false),
    ];

    let mut jupiter_account_indices: Vec<u8> = Vec::with_capacity(params.route_accounts.len());
    for (pubkey, is_writable) in params.route_accounts {
        let writable_bit = if *is_writable { 0x80 } else { 0 };
        if let Some(index) = keys.iter().position(|k| k.pubkey == *pubkey) {
            if *is_writable {
                keys[index].is_writable = true;
            }
            jupiter_account_indices.push(index as u8 | writable_bit);
            continue;
        }
        if keys.len() >= 64 {
            return Err("swap instruction keys exceed the entrypoint cap of 64".to_string());
        }
        jupiter_account_indices.push(keys.len() as u8 | writable_bit);
        keys.push(AccountMeta {
            pubkey: *pubkey,
            is_signer: false,
            is_writable: *is_writable,
        });
    }

    let data = build_swap_ix_data(params, &jupiter_account_indices);
    Ok(Instruction {
        program_id: params.program_id,
        accounts: keys,
        data,
    })
}

/// Moves lamports from the tree's token account into the pool's wSOL account. A
/// lamport move only — `SyncNative` has to be a separate later instruction so it is
/// not a CPI in the same instruction as `set_lamports`.
pub fn build_wrap_sol_instruction(program_id: &Pubkey, signer: &Pubkey, amount: u64) -> Instruction {
    let (tree_token_account, _) =
        Pubkey::find_program_address(&[crate::relayer::chain::TREE_TOKEN_ACCOUNT_SEED], program_id);
    let (global_config, _) =
        Pubkey::find_program_address(&[crate::relayer::chain::GLOBAL_CONFIG_SEED], program_id);
    let pool_wsol_account = derive_ata(&global_config, &crate::relayer::chain::NATIVE_MINT);

    let mut data = Vec::with_capacity(9);
    data.push(DISC_WRAP_SOL);
    data.extend_from_slice(&amount.to_le_bytes());

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(tree_token_account, false),
            AccountMeta::new(pool_wsol_account, false),
            AccountMeta::new_readonly(crate::relayer::chain::NATIVE_MINT, false),
            AccountMeta::new(*signer, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(crate::relayer::chain::SYSTEM_PROGRAM_ID, false),
        ],
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_proof() -> ProofBytes {
        ProofBytes {
            proof_a: [1u8; 32],
            proof_b: [2u8; 64],
            proof_c: [3u8; 32],
            root: [4u8; 32],
            public_amount: [5u8; 32],
            ext_data_hash: [6u8; 32],
            input_nullifiers: [[7u8; 32], [8u8; 32]],
            output_commitments: [[9u8; 32], [10u8; 32]],
        }
    }

    #[test]
    fn proof_serializes_to_the_programs_352_bytes() {
        assert_eq!(dummy_proof().serialize().len(), 352);
    }

    #[test]
    fn transact_ix_data_is_discriminator_proof_then_ext_data() {
        let proof = dummy_proof();
        let params = TransactIxParams {
            program_id: Pubkey::new_unique(),
            signer: Pubkey::new_unique(),
            proof: &proof,
            ext_amount: -1_000,
            fee: 25,
            encrypted_output1: &[0xaa; 4],
            encrypted_output2: &[0xbb; 6],
            recipient: Pubkey::new_unique(),
            fee_recipient: Pubkey::new_unique(),
            spl: None,
        };
        let data = build_ix_data(&params, 254, 253);

        assert_eq!(data[0], DISC_TRANSACT);
        assert_eq!(&data[1..353], &proof.serialize()[..]);
        assert_eq!(&data[353..361], &(-1_000i64).to_le_bytes());
        assert_eq!(&data[361..369], &25u64.to_le_bytes());
        assert_eq!(&data[369..373], &4u32.to_le_bytes());
        assert_eq!(data[data.len() - 2..], [254, 253]);
    }

    /// A route account that is already one of the swap instruction's own accounts
    /// must be referenced by its existing index, and be upgraded to writable.
    #[test]
    fn route_accounts_are_deduplicated_against_the_base_keys() {
        let program_id = Pubkey::new_unique();
        let spl_mint = Pubkey::new_unique();
        let swap = derive_swap_accounts(&program_id, &spl_mint);
        let extra = Pubkey::new_unique();
        let proof_in = dummy_proof();
        let proof_out = dummy_proof();

        let ix = build_swap_instruction(&SwapIxParams {
            program_id,
            signer: Pubkey::new_unique(),
            proof_in: &proof_in,
            proof_out: &proof_out,
            ext_amount_in: -100,
            ext_amount_out: 90,
            encrypted_output_in1: &[],
            encrypted_output_in2: &[],
            encrypted_output_out1: &[],
            encrypted_output_out2: &[],
            sol_to_spl: true,
            spl_mint,
            route_data: &[1, 2, 3],
            // The wSOL pool is already account index 13; `extra` is new.
            route_accounts: &[(swap.pool_wsol_account, true), (extra, false)],
        })
        .unwrap();

        assert_eq!(
            ix.accounts.iter().filter(|a| a.pubkey == swap.pool_wsol_account).count(),
            1,
            "existing account must be reused, not duplicated"
        );
        assert_eq!(ix.accounts.last().unwrap().pubkey, extra);
    }
}
