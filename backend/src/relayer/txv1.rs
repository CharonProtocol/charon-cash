//! SIMD-0385 "v1" wire transactions.
//!
//! Swaps do not fit a v0 transaction: two Groth16 proofs plus a Jupiter route can
//! exceed both the 1232-byte packet limit and the v0 account cap. v1 raises those
//! to 4096 bytes and 64 accounts and moves the compute budget into a header field
//! instead of separate instructions.
//!
//! This is a direct port of `sdk/src/tx-v1.ts`; the two must stay byte-identical
//! or signatures will not verify. Account ordering in particular follows the
//! TypeScript insertion order, which is why this uses an ordered vector rather
//! than a hash map.

use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;

pub const V1_PREFIX: u8 = 0x81;
pub const V1_MAX_SIZE: usize = 4096;
pub const V1_MAX_ACCOUNTS: usize = 64;

const CONFIG_CU_LIMIT: u32 = 1 << 2;
const CONFIG_LOADED_ACCOUNTS: u32 = 1 << 3;
const DEFAULT_LOADED_ACCOUNTS_LIMIT: u32 = 64 * 1024 * 1024;

#[derive(Clone, Copy)]
struct OrderedAccount {
    pubkey: Pubkey,
    is_signer: bool,
    is_writable: bool,
}

/// Collect every account a transaction touches, deduplicated, with permissions
/// merged upward, then sort into the four privilege classes the header describes.
fn order_accounts(fee_payer: &Pubkey, instructions: &[Instruction]) -> Vec<OrderedAccount> {
    let mut ordered: Vec<OrderedAccount> = Vec::new();

    let upsert = |ordered: &mut Vec<OrderedAccount>,
                      pubkey: Pubkey,
                      is_signer: bool,
                      is_writable: bool| {
        if let Some(existing) = ordered.iter_mut().find(|a| a.pubkey == pubkey) {
            existing.is_signer = existing.is_signer || is_signer;
            existing.is_writable = existing.is_writable || is_writable;
        } else {
            ordered.push(OrderedAccount {
                pubkey,
                is_signer,
                is_writable,
            });
        }
    };

    upsert(&mut ordered, *fee_payer, true, true);
    for ix in instructions {
        upsert(&mut ordered, ix.program_id, false, false);
        for meta in &ix.accounts {
            upsert(&mut ordered, meta.pubkey, meta.is_signer, meta.is_writable);
        }
    }

    let fee = *ordered
        .iter()
        .find(|a| a.pubkey == *fee_payer)
        .expect("fee payer was inserted first");

    let mut writable_signers = Vec::new();
    let mut readonly_signers = Vec::new();
    let mut writable_unsigned = Vec::new();
    let mut readonly_unsigned = Vec::new();
    for account in ordered.iter().filter(|a| a.pubkey != *fee_payer) {
        match (account.is_signer, account.is_writable) {
            (true, true) => writable_signers.push(*account),
            (true, false) => readonly_signers.push(*account),
            (false, true) => writable_unsigned.push(*account),
            (false, false) => readonly_unsigned.push(*account),
        }
    }

    let mut out = Vec::with_capacity(ordered.len());
    out.push(fee);
    out.extend(writable_signers);
    out.extend(readonly_signers);
    out.extend(writable_unsigned);
    out.extend(readonly_unsigned);
    out
}

pub struct CompileV1Params<'a> {
    pub fee_payer: Pubkey,
    pub blockhash: Pubkey,
    pub instructions: &'a [Instruction],
    pub compute_unit_limit: u32,
    pub loaded_accounts_data_size_limit: Option<u32>,
}

/// Compile an unsigned v1 message. Signatures are appended afterwards, not
/// prefixed as in legacy and v0 transactions.
pub fn compile_v1_transaction(params: &CompileV1Params<'_>) -> Result<Vec<u8>, String> {
    let accounts = order_accounts(&params.fee_payer, params.instructions);
    if accounts.len() > V1_MAX_ACCOUNTS {
        return Err(format!(
            "v1 account cap exceeded ({} > {V1_MAX_ACCOUNTS}); constrain the Jupiter route's maxAccounts",
            accounts.len()
        ));
    }
    if params.instructions.len() > 64 {
        return Err("v1 instruction cap is 64".to_string());
    }

    let num_required_signatures = accounts.iter().filter(|a| a.is_signer).count() as u8;
    let num_readonly_signed = accounts
        .iter()
        .filter(|a| a.is_signer && !a.is_writable)
        .count() as u8;
    let num_readonly_unsigned = accounts
        .iter()
        .filter(|a| !a.is_signer && !a.is_writable)
        .count() as u8;

    let index_of = |pk: &Pubkey| -> Result<u8, String> {
        accounts
            .iter()
            .position(|a| a.pubkey == *pk)
            .map(|i| i as u8)
            .ok_or_else(|| format!("account {pk} missing from v1 message"))
    };

    let config_mask = CONFIG_CU_LIMIT | CONFIG_LOADED_ACCOUNTS;
    let loaded = params
        .loaded_accounts_data_size_limit
        .unwrap_or(DEFAULT_LOADED_ACCOUNTS_LIMIT);

    let mut headers: Vec<u8> = Vec::new();
    let mut payloads: Vec<u8> = Vec::new();
    for ix in params.instructions {
        let mut idxs = Vec::with_capacity(ix.accounts.len());
        for meta in &ix.accounts {
            idxs.push(index_of(&meta.pubkey)?);
        }
        headers.push(index_of(&ix.program_id)?);
        headers.push(idxs.len() as u8);
        headers.extend_from_slice(&(ix.data.len() as u16).to_le_bytes());

        payloads.extend_from_slice(&idxs);
        payloads.extend_from_slice(&ix.data);
    }

    let mut out: Vec<u8> = Vec::new();
    out.push(V1_PREFIX);
    out.push(num_required_signatures);
    out.push(num_readonly_signed);
    out.push(num_readonly_unsigned);
    out.extend_from_slice(&config_mask.to_le_bytes());
    out.extend_from_slice(params.blockhash.as_ref());
    out.push(params.instructions.len() as u8);
    out.push(accounts.len() as u8);
    for account in &accounts {
        out.extend_from_slice(account.pubkey.as_ref());
    }
    out.extend_from_slice(&params.compute_unit_limit.to_le_bytes());
    out.extend_from_slice(&loaded.to_le_bytes());
    out.extend_from_slice(&headers);
    out.extend_from_slice(&payloads);

    let signed_size = out.len() + num_required_signatures as usize * 64;
    if signed_size > V1_MAX_SIZE {
        return Err(format!(
            "v1 transaction too large ({signed_size} > {V1_MAX_SIZE})"
        ));
    }

    Ok(out)
}

/// Append ed25519 signatures to a compiled v1 message.
pub fn sign_v1_transaction(message: &[u8], signers: &[&Keypair]) -> Result<Vec<u8>, String> {
    if message.first() != Some(&V1_PREFIX) {
        return Err("not a v1 transaction message".to_string());
    }
    let num_required = *message.get(1).unwrap_or(&0) as usize;
    if signers.len() < num_required {
        return Err(format!(
            "need {num_required} signatures, got {}",
            signers.len()
        ));
    }

    let mut out = Vec::with_capacity(message.len() + num_required * 64);
    out.extend_from_slice(message);
    for signer in signers.iter().take(num_required) {
        let sig = signer.sign_message(message);
        out.extend_from_slice(sig.as_ref());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::instruction::AccountMeta;

    #[test]
    fn fee_payer_is_always_index_zero_and_a_signer() {
        let fee_payer = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let program = Pubkey::new_unique();
        let ix = Instruction {
            program_id: program,
            accounts: vec![AccountMeta::new(other, false)],
            data: vec![1, 2, 3],
        };
        let accounts = order_accounts(&fee_payer, &[ix]);
        assert_eq!(accounts[0].pubkey, fee_payer);
        assert!(accounts[0].is_signer && accounts[0].is_writable);
        assert_eq!(accounts.iter().filter(|a| a.is_signer).count(), 1);
    }

    /// A key that appears read-only in one instruction and writable in another has
    /// to end up writable, or the runtime rejects the write.
    #[test]
    fn permissions_merge_upward() {
        let fee_payer = Pubkey::new_unique();
        let shared = Pubkey::new_unique();
        let program = Pubkey::new_unique();
        let ixs = vec![
            Instruction {
                program_id: program,
                accounts: vec![AccountMeta::new_readonly(shared, false)],
                data: vec![],
            },
            Instruction {
                program_id: program,
                accounts: vec![AccountMeta::new(shared, false)],
                data: vec![],
            },
        ];
        let accounts = order_accounts(&fee_payer, &ixs);
        let entry = accounts.iter().find(|a| a.pubkey == shared).unwrap();
        assert!(entry.is_writable);
        assert_eq!(accounts.iter().filter(|a| a.pubkey == shared).count(), 1);
    }

    #[test]
    fn header_and_signature_layout() {
        let payer = Keypair::new();
        let program = Pubkey::new_unique();
        let ix = Instruction {
            program_id: program,
            accounts: vec![],
            data: vec![7],
        };
        let message = compile_v1_transaction(&CompileV1Params {
            fee_payer: payer.pubkey(),
            blockhash: Pubkey::new_unique(),
            instructions: &[ix],
            compute_unit_limit: 1_400_000,
            loaded_accounts_data_size_limit: None,
        })
        .unwrap();

        assert_eq!(message[0], V1_PREFIX);
        assert_eq!(message[1], 1, "only the fee payer signs");

        let signed = sign_v1_transaction(&message, &[&payer]).unwrap();
        assert_eq!(signed.len(), message.len() + 64);
        assert_eq!(&signed[..message.len()], &message[..]);
    }
}
