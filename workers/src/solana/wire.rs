//! Minimal Solana transaction wire codec (legacy + Versioned v0).
//!
//! Byte-exact with solana-sdk's serde (short-vec / compact-u16 lengths) so the
//! worker can build, sign, serialize and parse transactions without pulling
//! solana-sdk (which does not compile to wasm32-unknown-unknown).

use super::pubkey::Pubkey;
use super::sign::Keypair;

#[derive(Clone)]
pub struct AccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

impl AccountMeta {
    pub fn new(pubkey: Pubkey, is_signer: bool, is_writable: bool) -> Self {
        AccountMeta { pubkey, is_signer, is_writable }
    }

    pub fn new_readonly(pubkey: Pubkey, is_signer: bool) -> Self {
        AccountMeta { pubkey, is_signer, is_writable: false }
    }
}

#[derive(Clone)]
pub struct Instruction {
    pub program_id: Pubkey,
    pub accounts: Vec<AccountMeta>,
    pub data: Vec<u8>,
}

pub fn write_compact_u16(out: &mut Vec<u8>, mut n: u16) {
    loop {
        let mut byte = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(byte);
            break;
        }
        byte |= 0x80;
        out.push(byte);
    }
}

pub fn read_compact_u16(data: &[u8], off: &mut usize) -> Option<u16> {
    let mut result: u16 = 0;
    let mut shift = 0u32;
    loop {
        let byte = *data.get(*off)?;
        *off += 1;
        result |= ((byte & 0x7f) as u16) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift > 14 {
            return None;
        }
    }
}

struct Slot {
    key: Pubkey,
    signer: bool,
    writable: bool,
    dynamic: bool,
}

struct Compiled {
    static_keys: Vec<Pubkey>,
    num_required_signatures: u8,
    num_readonly_signed: u8,
    num_readonly_unsigned: u8,
    program_indexes: Vec<u16>,
    account_indexes: Vec<Vec<u16>>,
    dyn_writable: Vec<Pubkey>,
    dyn_readonly: Vec<Pubkey>,
}

/// Mirrors solana message compilation: keys in first-seen order, payer first,
/// split into signed-writable / signed-readonly / unsigned-writable /
/// unsigned-readonly classes (stable within each class). When `table` is
/// provided, keys found in the lookup table become v0 dynamic keys instead
/// (writable dynamics first, then readonly — matching runtime resolution).
fn compile(payer: &Pubkey, ixs: &[Instruction], table: Option<&[Pubkey]>) -> Compiled {
    let mut slots: Vec<Slot> = vec![Slot { key: *payer, signer: true, writable: true, dynamic: false }];

    let mut ensure = |slots: &mut Vec<Slot>, key: Pubkey, signer: bool, writable: bool| {
        if let Some(slot) = slots.iter_mut().find(|s| s.key == key) {
            slot.signer = slot.signer || signer;
            slot.writable = slot.writable || writable;
        } else {
            let dynamic = table.map(|t| t.iter().any(|k| *k == key)).unwrap_or(false);
            slots.push(Slot { key, signer, writable, dynamic });
        }
    };

    for ix in ixs {
        ensure(&mut slots, ix.program_id, false, false);
        for meta in &ix.accounts {
            ensure(&mut slots, meta.pubkey, meta.is_signer, meta.is_writable);
        }
    }

    // Solana's message header marks readonly-ness BY POSITION (last
    // num_readonly_unsigned keys are readonly), so static keys must be
    // stable-partitioned into the four header classes — not left in
    // first-seen order.
    let static_keys: Vec<Pubkey> = slots
        .iter()
        .filter(|s| !s.dynamic && s.signer && s.writable)
        .chain(slots.iter().filter(|s| !s.dynamic && s.signer && !s.writable))
        .chain(slots.iter().filter(|s| !s.dynamic && !s.signer && s.writable))
        .chain(slots.iter().filter(|s| !s.dynamic && !s.signer && !s.writable))
        .map(|s| s.key)
        .collect();
    let dyn_writable: Vec<Pubkey> = slots.iter().filter(|s| s.dynamic && s.writable).map(|s| s.key).collect();
    let dyn_readonly: Vec<Pubkey> = slots.iter().filter(|s| s.dynamic && !s.writable).map(|s| s.key).collect();

    let index_of = |key: &Pubkey| -> u16 {
        if let Some(i) = static_keys.iter().position(|k| *k == *key) {
            return i as u16;
        }
        let w = static_keys.len() as u16;
        if let Some(i) = dyn_writable.iter().position(|k| *k == *key) {
            return w + i as u16;
        }
        let base = w + dyn_writable.len() as u16;
        let i = dyn_readonly.iter().position(|k| *k == *key).expect("key classified");
        base + i as u16
    };

    let program_indexes = ixs.iter().map(|ix| index_of(&ix.program_id)).collect();
    let account_indexes = ixs
        .iter()
        .map(|ix| ix.accounts.iter().map(|m| index_of(&m.pubkey)).collect())
        .collect();

    let num_required_signatures = slots.iter().filter(|s| !s.dynamic && s.signer).count() as u8;
    let num_readonly_signed = slots.iter().filter(|s| !s.dynamic && s.signer && !s.writable).count() as u8;
    let num_readonly_unsigned = slots.iter().filter(|s| !s.dynamic && !s.signer && !s.writable).count() as u8;

    Compiled {
        static_keys,
        num_required_signatures,
        num_readonly_signed,
        num_readonly_unsigned,
        program_indexes,
        account_indexes,
        dyn_writable,
        dyn_readonly,
    }
}

fn serialize_instructions(c: &Compiled, ixs: &[Instruction], out: &mut Vec<u8>) {
    write_compact_u16(out, ixs.len() as u16);
    for (i, ix) in ixs.iter().enumerate() {
        out.push(c.program_indexes[i] as u8);
        write_compact_u16(out, ix.accounts.len() as u16);
        for idx in &c.account_indexes[i] {
            out.push(*idx as u8);
        }
        write_compact_u16(out, ix.data.len() as u16);
        out.extend_from_slice(&ix.data);
    }
}

pub fn build_legacy_tx(
    payer: &Pubkey,
    ixs: &[Instruction],
    blockhash: &[u8; 32],
    kp: &Keypair,
) -> Vec<u8> {
    let c = compile(payer, ixs, None);
    let mut message = Vec::with_capacity(256);
    message.push(c.num_required_signatures);
    message.push(c.num_readonly_signed);
    message.push(c.num_readonly_unsigned);
    write_compact_u16(&mut message, c.static_keys.len() as u16);
    for k in &c.static_keys {
        message.extend_from_slice(k.as_ref());
    }
    message.extend_from_slice(blockhash);
    serialize_instructions(&c, ixs, &mut message);

    let sig = kp.sign(&message);
    let mut out = Vec::with_capacity(64 + message.len());
    write_compact_u16(&mut out, 1);
    out.extend_from_slice(&sig);
    out.extend_from_slice(&message);
    out
}

/// Versioned v0 message compiled against one Address Lookup Table.
/// Returns wire bytes (signatures + message).
pub fn build_v0_tx(
    payer: &Pubkey,
    ixs: &[Instruction],
    alt_key: &Pubkey,
    alt_addresses: &[Pubkey],
    blockhash: &[u8; 32],
    kp: &Keypair,
) -> Result<Vec<u8>, String> {
    if alt_addresses.len() > 256 {
        return Err("ALT has more than 256 addresses".into());
    }
    let c = compile(payer, ixs, Some(alt_addresses));

    let mut writable_indexes: Vec<u16> = Vec::new();
    for k in &c.dyn_writable {
        let idx = alt_addresses.iter().position(|a| a == k).ok_or("dynamic key missing from ALT")?;
        writable_indexes.push(idx as u16);
    }
    let mut readonly_indexes: Vec<u16> = Vec::new();
    for k in &c.dyn_readonly {
        let idx = alt_addresses.iter().position(|a| a == k).ok_or("dynamic key missing from ALT")?;
        readonly_indexes.push(idx as u16);
    }

    let mut message = Vec::with_capacity(1024);
    message.push(0x80); // version 0
    message.push(c.num_required_signatures);
    message.push(c.num_readonly_signed);
    message.push(c.num_readonly_unsigned);
    write_compact_u16(&mut message, c.static_keys.len() as u16);
    for k in &c.static_keys {
        message.extend_from_slice(k.as_ref());
    }
    message.extend_from_slice(blockhash);
    serialize_instructions(&c, ixs, &mut message);
    write_compact_u16(&mut message, 1);
    message.extend_from_slice(alt_key.as_ref());
    write_compact_u16(&mut message, writable_indexes.len() as u16);
    for idx in &writable_indexes {
        message.push(*idx as u8);
    }
    write_compact_u16(&mut message, readonly_indexes.len() as u16);
    for idx in &readonly_indexes {
        message.push(*idx as u8);
    }

    let sig = kp.sign(&message);
    let mut out = Vec::with_capacity(64 + message.len());
    write_compact_u16(&mut out, 1);
    out.extend_from_slice(&sig);
    out.extend_from_slice(&message);
    Ok(out)
}

#[derive(Debug)]
pub struct ParsedIx {
    pub program_id_index: u16,
    pub accounts: Vec<u8>,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct ParsedLookup {
    pub account_key: Pubkey,
    pub writable_indexes: Vec<u16>,
    pub readonly_indexes: Vec<u16>,
}

#[derive(Debug)]
pub struct ParsedTx {
    pub signatures: Vec<Vec<u8>>,
    /// 0 = legacy, 1+ = versioned (message uses the v0 layout).
    pub versioned: bool,
    /// [num_required_signatures, num_readonly_signed, num_readonly_unsigned]
    pub header: [u8; 3],
    pub static_keys: Vec<Pubkey>,
    pub instructions: Vec<ParsedIx>,
    pub lookups: Vec<ParsedLookup>,
}

pub fn parse_tx(bytes: &[u8]) -> Result<ParsedTx, String> {
    let mut off = 0usize;
    let sig_count = read_compact_u16(bytes, &mut off).ok_or("tx too short: signature count")? as usize;
    let mut signatures = Vec::with_capacity(sig_count);
    for _ in 0..sig_count {
        let s = bytes.get(off..off + 64).ok_or("tx too short: signature body")?;
        signatures.push(s.to_vec());
        off += 64;
    }

    let first = *bytes.get(off).ok_or("tx too short: message header")?;
    let versioned = first & 0x80 != 0;
    if versioned {
        let _version = first & 0x7f;
        off += 1;
    }
    // header (3 bytes): num_required_signatures, num_readonly_signed, num_readonly_unsigned
    let header: [u8; 3] = bytes
        .get(off..off + 3)
        .and_then(|h| h.try_into().ok())
        .ok_or("tx too short: header")?;
    off += 3;

    let key_count = read_compact_u16(bytes, &mut off).ok_or("tx too short: key count")? as usize;
    let mut static_keys = Vec::with_capacity(key_count);
    for _ in 0..key_count {
        let k = bytes.get(off..off + 32).ok_or("tx too short: static keys")?;
        static_keys.push(Pubkey(k.try_into().unwrap()));
        off += 32;
    }

    let blockhash = bytes.get(off..off + 32).ok_or("tx too short: blockhash")?;
    if blockhash.len() != 32 {
        return Err("tx too short: blockhash".into());
    }
    off += 32;

    let ix_count = read_compact_u16(bytes, &mut off).ok_or("tx too short: ix count")? as usize;
    let mut instructions = Vec::with_capacity(ix_count);
    for _ in 0..ix_count {
        let program_id_index = *bytes.get(off).ok_or("tx too short: ix program index")? as u16;
        off += 1;
        let acct_count = read_compact_u16(bytes, &mut off).ok_or("tx too short: ix accounts")? as usize;
        let accounts = bytes
            .get(off..off + acct_count)
            .ok_or("tx too short: ix account list")?
            .to_vec();
        off += acct_count;
        let data_len = read_compact_u16(bytes, &mut off).ok_or("tx too short: ix data len")? as usize;
        let data = bytes.get(off..off + data_len).ok_or("tx too short: ix data")?.to_vec();
        off += data_len;
        instructions.push(ParsedIx { program_id_index, accounts, data });
    }

    let mut lookups = Vec::new();
    if versioned {
        let lookup_count = read_compact_u16(bytes, &mut off).ok_or("tx too short: lookup count")? as usize;
        for _ in 0..lookup_count {
            let k = bytes.get(off..off + 32).ok_or("tx too short: lookup key")?;
            let account_key = Pubkey(k.try_into().unwrap());
            off += 32;
            let mut read_u8s = |off: &mut usize| -> Result<Vec<u16>, String> {
                let n = read_compact_u16(bytes, off).ok_or("tx too short: lookup idx count")? as usize;
                let mut v = Vec::with_capacity(n);
                for _ in 0..n {
                    let b = *bytes.get(*off).ok_or("tx too short: lookup idx")?;
                    v.push(b as u16);
                    *off += 1;
                }
                Ok(v)
            };
            let writable_indexes = read_u8s(&mut off)?;
            let readonly_indexes = read_u8s(&mut off)?;
            lookups.push(ParsedLookup { account_key, writable_indexes, readonly_indexes });
        }
    }

    Ok(ParsedTx { signatures, versioned, header, static_keys, instructions, lookups })
}

/// Resolve the full account-key list: static keys, then all lookup-table
/// writable addresses (in lookup order), then all readonly addresses. An
/// instruction account index indexes into this list.
pub fn resolve_keys(tx: &ParsedTx, tables: &[Vec<Pubkey>]) -> Result<Vec<Pubkey>, String> {
    if tables.len() != tx.lookups.len() {
        return Err(format!(
            "tx references {} lookup tables, {} provided",
            tx.lookups.len(),
            tables.len()
        ));
    }
    let mut keys = tx.static_keys.clone();
    for (lookup, table) in tx.lookups.iter().zip(tables) {
        for idx in &lookup.writable_indexes {
            let k = table.get(*idx as usize).ok_or("lookup index out of range")?;
            keys.push(*k);
        }
    }
    for (lookup, table) in tx.lookups.iter().zip(tables) {
        for idx in &lookup.readonly_indexes {
            let k = table.get(*idx as usize).ok_or("lookup index out of range")?;
            keys.push(*k);
        }
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(n: u8) -> Pubkey {
        Pubkey([n; 32])
    }

    #[test]
    fn compact_u16_round_trip() {
        let cases = [0u16, 1, 0x7f, 0x80, 0x3fff, 0x4000, 65535];
        for &c in &cases {
            let mut buf = Vec::new();
            write_compact_u16(&mut buf, c);
            let mut off = 0;
            assert_eq!(read_compact_u16(&buf, &mut off), Some(c));
            assert_eq!(off, buf.len());
        }
    }

    #[test]
    fn legacy_tx_round_trip() {
        let payer = pk(1);
        let ixs = vec![
            Instruction { program_id: pk(9), accounts: vec![AccountMeta::new(pk(2), false, true)], data: vec![2, 3, 4] },
            Instruction { program_id: pk(8), accounts: vec![], data: vec![] },
        ];
        let kp = Keypair::from_seed([7u8; 32]);
        let blockhash = [42u8; 32];
        let wire = build_legacy_tx(&payer, &ixs, &blockhash, &kp);

        let parsed = parse_tx(&wire).unwrap();
        assert!(!parsed.versioned);
        assert_eq!(parsed.signatures.len(), 1);
        assert_eq!(parsed.static_keys[0], payer);
        assert_eq!(parsed.instructions.len(), 2);
        assert_eq!(parsed.instructions[0].data, vec![2, 3, 4]);

        let keys = resolve_keys(&parsed, &[]).unwrap();
        let prog0 = keys[parsed.instructions[0].program_id_index as usize];
        assert_eq!(prog0, pk(9));
        let acct0 = keys[parsed.instructions[0].accounts[0] as usize];
        assert_eq!(acct0, pk(2));
    }

    #[test]
    fn v0_tx_round_trip() {
        let payer = pk(1);
        let table = vec![pk(9), pk(2), pk(3), pk(4), pk(5), pk(6), pk(7)];
        let ixs = vec![Instruction {
            program_id: pk(9),
            accounts: vec![
                AccountMeta::new(pk(2), false, true),
                AccountMeta::new(pk(3), false, true),
                AccountMeta::new_readonly(pk(4), false),
                AccountMeta::new(pk(1), true, true),
            ],
            data: vec![1, 2, 3, 4, 5],
        }];
        let kp = Keypair::from_seed([9u8; 32]);
        let blockhash = [7u8; 32];
        let wire = build_v0_tx(&payer, &ixs, &pk(77), &table, &blockhash, &kp).unwrap();

        let parsed = parse_tx(&wire).unwrap();
        assert!(parsed.versioned);
        assert_eq!(parsed.lookups.len(), 1);
        assert_eq!(parsed.lookups[0].account_key, pk(77));
        // payer + any non-table keys stay static; table keys are dynamic
        assert!(parsed.static_keys.contains(&payer));

        let keys = resolve_keys(&parsed, &[table]).unwrap();
        assert_eq!(keys[parsed.instructions[0].program_id_index as usize], pk(9));
        assert_eq!(keys[parsed.instructions[0].accounts[0] as usize], pk(2));
        assert_eq!(keys[parsed.instructions[0].accounts[2] as usize], pk(4));
        // payer resolved through static keys
        assert_eq!(keys[parsed.instructions[0].accounts[3] as usize], payer);
    }
}
