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

    // Signers and invoked program ids must stay in static keys: the runtime
    // resolves programs before loading lookup tables (and a signature can't
    // come from a table).
    let invoked: Vec<Pubkey> = ixs.iter().map(|ix| ix.program_id).collect();
    let mut ensure = |slots: &mut Vec<Slot>, key: Pubkey, signer: bool, writable: bool| {
        if let Some(slot) = slots.iter_mut().find(|s| s.key == key) {
            slot.signer = slot.signer || signer;
            slot.writable = slot.writable || writable;
        } else {
            let dynamic = !signer
                && !invoked.contains(&key)
                && table.map(|t| t.iter().any(|k| *k == key)).unwrap_or(false);
            slots.push(Slot { key, signer, writable, dynamic });
        }
    };

    for ix in ixs {
        ensure(&mut slots, ix.program_id, false, false);
        for meta in &ix.accounts {
            ensure(&mut slots, meta.pubkey, meta.is_signer, meta.is_writable);
        }
    }
    // A key first seen as an account meta may have been marked dynamic before
    // a later ix invoked it as its program.
    for slot in &mut slots {
        if invoked.contains(&slot.key) || slot.signer {
            slot.dynamic = false;
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
    /// SIMD-0385 v1 layout (sigs at tail, inline addresses, config mask).
    pub v1: bool,
    /// [num_required_signatures, num_readonly_signed, num_readonly_unsigned]
    pub header: [u8; 3],
    pub static_keys: Vec<Pubkey>,
    pub instructions: Vec<ParsedIx>,
    pub lookups: Vec<ParsedLookup>,
}

pub fn parse_tx(bytes: &[u8]) -> Result<ParsedTx, String> {
    // v1 transactions are their own envelope: [0x81][message][signatures at tail]
    if bytes.first() == Some(&0x81) {
        return parse_tx_v1(bytes);
    }
    parse_tx_v0_legacy(bytes)
}

/// v1 (SIMD-0385): message = [0x81][header 3][config_mask u32le][blockhash 32]
/// [num_instructions u8][num_addresses u8][addresses x32][config values in mask
/// order][instruction headers 4B + payloads]; signatures (header.0 x 64B) follow
/// the message. Config values: bits 0-1 priority fee u64le, bit 2 CU limit u32le,
/// bit 3 loaded-accounts-data-size u32le, bit 4 heap size u32le. No ALTs.
fn parse_tx_v1(bytes: &[u8]) -> Result<ParsedTx, String> {
    let mut off = 1usize; // version byte
    let header: [u8; 3] = bytes
        .get(off..off + 3)
        .and_then(|h| h.try_into().ok())
        .ok_or("tx too short: v1 header")?;
    off += 3;
    let mask = bytes
        .get(off..off + 4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .ok_or("tx too short: v1 config mask")?;
    off += 4;
    if mask & !0b1_1111 != 0 {
        return Err(format!("v1: unknown config mask bits 0x{mask:08x}"));
    }
    if mask & 0b11 != 0 && mask & 0b11 != 0b11 {
        return Err("v1: priority fee mask needs both low bits".into());
    }

    off += 32; // blockhash
    if off > bytes.len() {
        return Err("tx too short: v1 blockhash".into());
    }
    let ix_count = *bytes.get(off).ok_or("tx too short: v1 ix count")? as usize;
    off += 1;
    let addr_count = *bytes.get(off).ok_or("tx too short: v1 address count")? as usize;
    off += 1;
    if addr_count > 64 {
        return Err(format!("v1: too many addresses ({addr_count} > 64)"));
    }
    let mut static_keys = Vec::with_capacity(addr_count);
    for _ in 0..addr_count {
        let k = bytes.get(off..off + 32).ok_or("tx too short: v1 address")?;
        static_keys.push(Pubkey(k.try_into().unwrap()));
        off += 32;
    }
    // config values, in mask order
    for (bits, len) in [(0b11u32, 8usize), (0b100, 4), (0b1000, 4), (0b1_0000, 4)] {
        if mask & bits == bits {
            off += len;
        }
    }

    // instruction headers sit in ONE contiguous 4-byte-per-ix block, payloads follow
    struct V1IxHeader {
        program_id_index: u16,
        acct_count: usize,
        data_len: usize,
    }
    let mut headers = Vec::with_capacity(ix_count);
    for _ in 0..ix_count {
        let program_id_index = *bytes.get(off).ok_or("tx too short: v1 ix program index")? as u16;
        off += 1;
        let acct_count = *bytes.get(off).ok_or("tx too short: v1 ix accounts")? as usize;
        off += 1;
        let data_len = bytes
            .get(off..off + 2)
            .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
            .ok_or("tx too short: v1 ix data len")? as usize;
        off += 2;
        headers.push(V1IxHeader { program_id_index, acct_count, data_len });
    }
    let mut instructions = Vec::with_capacity(ix_count);
    for h in &headers {
        let accounts = bytes
            .get(off..off + h.acct_count)
            .ok_or("tx too short: v1 ix account list")?
            .to_vec();
        off += h.acct_count;
        let data = bytes
            .get(off..off + h.data_len)
            .ok_or("tx too short: v1 ix data")?
            .to_vec();
        off += h.data_len;
        instructions.push(ParsedIx {
            program_id_index: h.program_id_index,
            accounts,
            data,
        });
    }

    // signatures live at the tail, count = header.0, order = first N addresses
    let nsig = header[0] as usize;
    if bytes.len() < off + nsig * 64 {
        return Err("tx too short: v1 signatures".into());
    }
    let signatures = bytes[off..off + nsig * 64]
        .chunks(64)
        .map(|s| s.to_vec())
        .collect();

    Ok(ParsedTx {
        signatures,
        versioned: true,
        v1: true,
        header,
        static_keys,
        instructions,
        lookups: Vec::new(),
    })
}

fn parse_tx_v0_legacy(bytes: &[u8]) -> Result<ParsedTx, String> {
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

    Ok(ParsedTx { signatures, versioned, v1: false, header, static_keys, instructions, lookups })
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

    #[test]
    fn v1_tx_round_trip() {
        // hand-encode the layout proven against kit 8.2 + surfpool enable_tx_v1:
        // [0x81][header 3][mask u32le][blockhash 32][num_ix u8][num_addr u8]
        // [addrs][configs in mask order][ix headers 4B + payloads][sig tail]
        let payer = pk(1);
        let dest = pk(2);
        let prog = pk(9);
        let mut m = Vec::new();
        m.push(0x81u8);
        m.extend_from_slice(&[1, 0, 1]); // 1 sig, none readonly-signed, 1 readonly unsigned
        m.extend_from_slice(&0b1100u32.to_le_bytes()); // CU limit + loaded data size
        m.extend_from_slice(&[42u8; 32]); // blockhash
        m.push(2); // instructions
        m.push(3); // addresses
        m.extend_from_slice(&payer.0);
        m.extend_from_slice(&dest.0);
        m.extend_from_slice(&prog.0);
        m.extend_from_slice(&150_000u32.to_le_bytes());
        m.extend_from_slice(&(64u32 * 1024 * 1024).to_le_bytes());
        // ix headers sit in one contiguous block, payloads follow per ix
        m.extend_from_slice(&[2, 2]);
        m.extend_from_slice(&12u16.to_le_bytes());
        m.extend_from_slice(&[2, 3]);
        m.extend_from_slice(&0u16.to_le_bytes());
        m.extend_from_slice(&[0, 1]);
        m.extend_from_slice(&[9u8; 12]);
        m.extend_from_slice(&[0, 1, 2]);
        // signature tail
        m.extend_from_slice(&[7u8; 64]);

        let parsed = parse_tx(&m).unwrap();
        assert!(parsed.versioned);
        assert!(parsed.v1);
        assert_eq!(parsed.header, [1, 0, 1]);
        assert_eq!(parsed.signatures.len(), 1);
        assert_eq!(parsed.signatures[0], vec![7u8; 64]);
        assert_eq!(parsed.lookups.len(), 0);
        assert_eq!(parsed.static_keys.len(), 3);
        assert_eq!(parsed.instructions.len(), 2);
        assert_eq!(parsed.instructions[0].data, vec![9u8; 12]);
        assert_eq!(parsed.instructions[1].accounts, vec![0, 1, 2]);

        // resolve_keys must resolve through the inline address list with no tables
        let keys = resolve_keys(&parsed, &[]).unwrap();
        assert_eq!(keys[parsed.instructions[0].program_id_index as usize], prog);
        assert_eq!(keys[parsed.instructions[0].accounts[0] as usize], payer);
        assert_eq!(keys[parsed.instructions[1].accounts[2] as usize], prog);
    }
}
