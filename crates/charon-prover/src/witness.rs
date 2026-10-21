//! Witness generation from a circom-witnesscalc graph (`transaction2.graph`).
//!
//! Adapted from iden3/circom-witnesscalc (Apache-2.0 OR MIT), rev d48eb7c9:
//! `src/storage/proto_deserializer.rs` (file format), `src/graph.rs` and
//! `src/field.rs` (node semantics over `Uint<254, 4>`), `src/lib.rs`
//! (`init_inputs_from_v2`). Only the pieces needed to evaluate a
//! `wtns.graph.002` file for BN254 are kept; no mmap, no temp files, no
//! threads, so it builds for `wasm32-unknown-unknown`.

use std::collections::HashMap;

use anyhow::{anyhow, bail, ensure, Context, Result};
use ark_bn254::Fr;
use ark_ff::PrimeField;
use num_bigint::BigUint;
use ruint::{uint, Uint};

type U254 = Uint<254, 4>;

const MAGIC_002: &[u8] = b"wtns.graph.002";

const PRIME: U254 =
    uint!(21888242871839275222246405745257275088548364400416034343698204186575808495617_U254);
const HALF_PRIME: U254 =
    uint!(10944121435919637611123202872628637544274182200208017171849102093287904247808_U254);

#[derive(Clone, Copy, Debug)]
enum Uno {
    Neg,
    Id,
    Lnot,
    Bnot,
    Sqrt,
}

#[derive(Clone, Copy, Debug)]
enum Duo {
    Mul,
    Div,
    Add,
    Sub,
    Pow,
    Idiv,
    Mod,
    Eq,
    Neq,
    Lt,
    Gt,
    Leq,
    Geq,
    Land,
    Lor,
    Shl,
    Shr,
    Bor,
    Band,
    Bxor,
}

#[derive(Clone, Copy, Debug)]
enum Node {
    Input(u32),
    Constant(u32),
    Uno(Uno, u32),
    Duo(Duo, u32, u32),
    TernCond(u32, u32, u32),
}

struct InputSignal {
    name: String,
    offset: usize,
    len: usize,
}

/// A parsed witness graph. Parse once, evaluate per proof.
pub struct WitnessGraph {
    nodes: Vec<Node>,
    constants: Vec<U254>,
    witness_signals: Vec<u32>,
    inputs: Vec<InputSignal>,
    /// Size of the input buffer, including the leading constant `1`.
    input_buffer_len: usize,
}

impl WitnessGraph {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        ensure!(
            bytes.starts_with(MAGIC_002),
            "not a wtns.graph.002 file (rebuild with scripts/build-witness-graph.sh)"
        );
        ensure!(bytes.len() >= MAGIC_002.len() + 16, "graph file truncated");

        let mut idx = MAGIC_002.len();
        let nodes_num = u64::from_le_bytes(bytes[idx..idx + 8].try_into()?) as usize;
        idx += 8;

        let md_ptr = u64::from_le_bytes(bytes[bytes.len() - 8..].try_into()?) as usize;
        ensure!(
            md_ptr < bytes.len() - 8,
            "graph metadata pointer out of range"
        );

        let mut nodes = Vec::with_capacity(nodes_num);
        let mut constants = Vec::new();
        let mut constants_idx: HashMap<U254, usize> = HashMap::new();
        for _ in 0..nodes_num {
            let (len, n) = read_varint(&bytes[idx..])?;
            idx += n;
            let msg = bytes
                .get(idx..idx + len as usize)
                .ok_or_else(|| anyhow!("node message out of range"))?;
            idx += len as usize;
            decode_node(msg, &mut nodes, &mut constants, &mut constants_idx)?;
        }

        let (md_len, n) = read_varint(&bytes[md_ptr..])?;
        let md_start = md_ptr + n;
        let md = bytes
            .get(md_start..md_start + md_len as usize)
            .ok_or_else(|| anyhow!("graph metadata out of range"))?;
        let meta = decode_metadata(md)?;

        if let Some(prime) = meta.prime_le {
            let p = U254::try_from_le_slice(&prime)
                .ok_or_else(|| anyhow!("graph prime does not fit 254 bits"))?;
            ensure!(p == PRIME, "graph is not for the BN254 scalar field");
        }

        let inputs = decode_input_signal_info(&meta.input_signal_info)?;
        let min_offset = inputs.iter().map(|i| i.offset).min().unwrap_or(0);
        let total: usize = inputs.iter().map(|i| i.len).sum();
        let inputs = inputs
            .into_iter()
            .map(|i| InputSignal {
                offset: 1 + i.offset - min_offset,
                ..i
            })
            .collect();

        for node in &nodes {
            let refs: &[u32] = match node {
                Node::Uno(_, a) => &[*a],
                Node::Duo(_, a, b) => &[*a, *b],
                Node::TernCond(a, b, c) => &[*a, *b, *c],
                _ => &[],
            };
            ensure!(
                refs.iter().all(|&r| (r as usize) < nodes.len()),
                "graph node references out of range"
            );
        }
        ensure!(
            meta.witness_signals
                .iter()
                .all(|&s| (s as usize) < nodes.len()),
            "witness signal references out of range"
        );

        Ok(Self {
            nodes,
            constants,
            witness_signals: meta.witness_signals,
            inputs,
            input_buffer_len: 1 + total,
        })
    }

    /// Number of witness elements (equals the zkey's `nVars`).
    pub fn witness_len(&self) -> usize {
        self.witness_signals.len()
    }

    /// Evaluates the graph. `inputs` maps each circom input signal name to its
    /// row-major flattened values; every declared input must be present.
    pub fn calculate_witness(&self, inputs: &[(String, Vec<BigUint>)]) -> Result<Vec<Fr>> {
        let mut buf = vec![U254::ZERO; self.input_buffer_len];
        buf[0] = U254::from(1u64);
        let given: HashMap<&str, &Vec<BigUint>> =
            inputs.iter().map(|(k, v)| (k.as_str(), v)).collect();
        ensure!(
            given.len() == self.inputs.len(),
            "expected {} input signals, got {}",
            self.inputs.len(),
            given.len()
        );
        for sig in &self.inputs {
            let values = given
                .get(sig.name.as_str())
                .ok_or_else(|| anyhow!("missing input signal `{}`", sig.name))?;
            ensure!(
                values.len() == sig.len,
                "input signal `{}` has {} values, circuit expects {}",
                sig.name,
                values.len(),
                sig.len
            );
            for (k, v) in values.iter().enumerate() {
                buf[sig.offset + k] = biguint_to_field(v);
            }
        }

        let mut values: Vec<U254> = Vec::with_capacity(self.nodes.len());
        for node in &self.nodes {
            let v = match *node {
                Node::Input(i) => *buf
                    .get(i as usize)
                    .ok_or_else(|| anyhow!("graph input index {i} out of range"))?,
                Node::Constant(c) => self.constants[c as usize],
                Node::Uno(op, a) => eval_uno(op, values[a as usize]),
                Node::Duo(op, a, b) => eval_duo(op, values[a as usize], values[b as usize]),
                Node::TernCond(a, b, c) => {
                    if values[a as usize].is_zero() {
                        values[c as usize]
                    } else {
                        values[b as usize]
                    }
                }
            };
            values.push(v);
        }

        Ok(self
            .witness_signals
            .iter()
            .map(|&s| Fr::from_le_bytes_mod_order(&values[s as usize].to_le_bytes::<32>()))
            .collect())
    }
}

fn biguint_to_field(v: &BigUint) -> U254 {
    let p = BigUint::from_bytes_le(&PRIME.to_le_bytes::<32>());
    let r = v % p;
    U254::try_from_le_slice(&r.to_bytes_le()).expect("reduced value fits 254 bits")
}

// ---- node semantics (circom-witnesscalc src/field.rs, `Field<U254>`) ----

fn neg(a: U254) -> U254 {
    if a.is_zero() {
        U254::ZERO
    } else {
        PRIME - a
    }
}

fn from_bool(b: bool) -> U254 {
    if b {
        U254::from(1u64)
    } else {
        U254::ZERO
    }
}

/// Signed interpretation used by circom for shifts: values above p/2 are negative.
fn to_i64(v: U254) -> Option<i64> {
    let small = |x: U254| -> Option<i64> {
        let l = x.as_limbs();
        if l[1] == 0 && l[2] == 0 && l[3] == 0 && l[0] <= i64::MAX as u64 {
            Some(l[0] as i64)
        } else {
            None
        }
    };
    if v > HALF_PRIME {
        small(neg(v)).map(|x| -x)
    } else {
        small(v)
    }
}

fn shift(lhs: U254, by: i64, left: bool) -> U254 {
    let amount = by.unsigned_abs().min(512) as usize;
    let mut r = if (by >= 0) == left {
        lhs.wrapping_shl(amount)
    } else {
        lhs.wrapping_shr(amount)
    };
    if r > PRIME {
        r %= PRIME;
    }
    r
}

/// Signed comparison: `(lhs_neg, rhs_neg, unsigned result)`.
fn signed_cmp(a: U254, b: U254, unsigned: bool, if_a_neg: bool) -> U254 {
    let a_neg = HALF_PRIME < a;
    let b_neg = HALF_PRIME < b;
    if a_neg == b_neg {
        from_bool(unsigned)
    } else {
        from_bool(if a_neg { if_a_neg } else { !if_a_neg })
    }
}

fn eval_uno(op: Uno, a: U254) -> U254 {
    match op {
        Uno::Neg => neg(a),
        Uno::Id => a,
        Uno::Lnot => from_bool(a.is_zero()),
        Uno::Bnot => {
            // Mask is all 254 bits (prime bit length == type width).
            let r = !a;
            if r >= PRIME {
                r % PRIME
            } else {
                r
            }
        }
        Uno::Sqrt => sqrt(a),
    }
}

fn eval_duo(op: Duo, a: U254, b: U254) -> U254 {
    match op {
        Duo::Mul => a.mul_mod(b, PRIME),
        Duo::Div => {
            if b.is_zero() {
                U254::ZERO
            } else {
                a.mul_mod(b.inv_mod(PRIME).unwrap_or(U254::ZERO), PRIME)
            }
        }
        Duo::Add => a.add_mod(b, PRIME),
        Duo::Sub => a.add_mod(PRIME - b, PRIME),
        Duo::Pow => a.pow_mod(b, PRIME),
        Duo::Idiv => {
            if b.is_zero() {
                U254::ZERO
            } else {
                a / b
            }
        }
        Duo::Mod => {
            if b.is_zero() {
                U254::ZERO
            } else {
                a % b
            }
        }
        Duo::Eq => from_bool(a == b),
        Duo::Neq => from_bool(a != b),
        Duo::Lt => signed_cmp(a, b, a < b, true),
        Duo::Gt => signed_cmp(a, b, a > b, false),
        Duo::Leq => signed_cmp(a, b, a <= b, true),
        Duo::Geq => signed_cmp(a, b, a >= b, false),
        Duo::Land => from_bool(!a.is_zero() && !b.is_zero()),
        Duo::Lor => from_bool(!a.is_zero() || !b.is_zero()),
        Duo::Shl => to_i64(b).map_or(U254::ZERO, |r| shift(a, r, true)),
        Duo::Shr => to_i64(b).map_or(U254::ZERO, |r| shift(a, r, false)),
        Duo::Bor => {
            let r = a | b;
            if r >= PRIME {
                r % PRIME
            } else {
                r
            }
        }
        Duo::Band => a & b,
        Duo::Bxor => {
            let r = a ^ b;
            if r >= PRIME {
                r % PRIME
            } else {
                r
            }
        }
    }
}

/// Tonelli-Shanks; returns the root <= p/2, or 0 for non-residues.
fn sqrt(a: U254) -> U254 {
    if a.is_zero() {
        return U254::ZERO;
    }
    let one = U254::from(1u64);
    let mut q = PRIME - one;
    let mut s = 0usize;
    while (q & one).is_zero() {
        q >>= 1;
        s += 1;
    }
    let legendre_exp = (PRIME - one) >> 1;
    if a.pow_mod(legendre_exp, PRIME) != one {
        return U254::ZERO;
    }
    let mut z = U254::from(2u64);
    while z.pow_mod(legendre_exp, PRIME) == one {
        z = z.add_mod(one, PRIME);
    }
    let mut m = s;
    let mut c = z.pow_mod(q, PRIME);
    let mut t = a.pow_mod(q, PRIME);
    let mut r = a.pow_mod((q + one) >> 1, PRIME);
    while t != one {
        let mut t2i = t;
        let mut i = 0usize;
        while t2i != one {
            t2i = t2i.mul_mod(t2i, PRIME);
            i += 1;
            if i == m {
                return U254::ZERO;
            }
        }
        let mut b = c;
        for _ in 0..(m - i - 1) {
            b = b.mul_mod(b, PRIME);
        }
        c = b.mul_mod(b, PRIME);
        t = t.mul_mod(c, PRIME);
        r = r.mul_mod(b, PRIME);
        m = i;
    }
    if r > HALF_PRIME {
        neg(r)
    } else {
        r
    }
}

// ---- protobuf decoding (messages.proto) ----

fn read_varint(bytes: &[u8]) -> Result<(u64, usize)> {
    let mut v = 0u64;
    for (i, b) in bytes.iter().enumerate().take(10) {
        v |= ((b & 0x7f) as u64) << (7 * i);
        if b & 0x80 == 0 {
            return Ok((v, i + 1));
        }
    }
    bail!("invalid or truncated varint")
}

enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

/// Iterates `(field_number, value)` over a protobuf message body.
fn fields(mut bytes: &[u8]) -> impl Iterator<Item = Result<(u64, Field<'_>)>> {
    std::iter::from_fn(move || {
        if bytes.is_empty() {
            return None;
        }
        let step = (|| -> Result<(u64, Field<'_>, usize)> {
            let (tag, n) = read_varint(bytes)?;
            let rest = &bytes[n..];
            match tag & 7 {
                0 => {
                    let (v, m) = read_varint(rest)?;
                    Ok((tag >> 3, Field::Varint(v), n + m))
                }
                2 => {
                    let (len, m) = read_varint(rest)?;
                    let body = rest
                        .get(m..m + len as usize)
                        .ok_or_else(|| anyhow!("protobuf field out of range"))?;
                    Ok((tag >> 3, Field::Bytes(body), n + m + len as usize))
                }
                w => bail!("unsupported protobuf wire type {w}"),
            }
        })();
        Some(match step {
            Ok((num, field, used)) => {
                bytes = &bytes[used..];
                Ok((num, field))
            }
            Err(e) => {
                bytes = &[];
                Err(e)
            }
        })
    })
}

/// Varint fields 1..=4 of an op/input message, defaulting to 0 (proto3).
fn varint_fields(bytes: &[u8]) -> Result<[u64; 4]> {
    let mut out = [0u64; 4];
    for f in fields(bytes) {
        match f? {
            (n @ 1..=4, Field::Varint(v)) => out[n as usize - 1] = v,
            (n, _) => bail!("unexpected field {n} in graph node"),
        }
    }
    Ok(out)
}

fn idx(v: u64) -> Result<u32> {
    u32::try_from(v).map_err(|_| anyhow!("graph node index too large"))
}

fn decode_node(
    msg: &[u8],
    nodes: &mut Vec<Node>,
    constants: &mut Vec<U254>,
    constants_idx: &mut HashMap<U254, usize>,
) -> Result<()> {
    let mut it = fields(msg);
    let (kind, body) = match it.next().ok_or_else(|| anyhow!("empty graph node"))?? {
        (k, Field::Bytes(b)) => (k, b),
        (k, _) => bail!("graph node field {k} is not a message"),
    };
    ensure!(it.next().is_none(), "graph node has more than one variant");

    let node = match kind {
        1 => Node::Input(idx(varint_fields(body)?[0])?),
        2 => {
            let mut le: &[u8] = &[];
            for f in fields(body) {
                if let (1, Field::Bytes(big)) = f? {
                    for g in fields(big) {
                        if let (1, Field::Bytes(v)) = g? {
                            le = v;
                        }
                    }
                }
            }
            let mut v = if le.is_empty() {
                U254::ZERO
            } else {
                U254::try_from_le_slice(le)
                    .ok_or_else(|| anyhow!("graph constant does not fit 254 bits"))?
            };
            if v > PRIME {
                v %= PRIME;
            }
            // Mirrors `Nodes::const_node_idx_from_value`: a repeated constant
            // does not create a node, which shifts later indices.
            if constants_idx.contains_key(&v) {
                return Ok(());
            }
            constants.push(v);
            nodes.push(Node::Constant(idx(constants.len() as u64 - 1)?));
            constants_idx.insert(v, nodes.len() - 1);
            return Ok(());
        }
        3 => {
            let [op, a, ..] = varint_fields(body)?;
            let op = match op {
                0 => Uno::Neg,
                1 => Uno::Id,
                2 => Uno::Lnot,
                3 => Uno::Bnot,
                4 => Uno::Sqrt,
                o => bail!("unknown unary op {o}"),
            };
            Node::Uno(op, idx(a)?)
        }
        4 => {
            let [op, a, b, _] = varint_fields(body)?;
            use Duo::*;
            let op = [
                Mul, Div, Add, Sub, Pow, Idiv, Mod, Eq, Neq, Lt, Gt, Leq, Geq, Land, Lor, Shl, Shr,
                Bor, Band, Bxor,
            ]
            .get(op as usize)
            .copied()
            .ok_or_else(|| anyhow!("unknown binary op {op}"))?;
            Node::Duo(op, idx(a)?, idx(b)?)
        }
        5 => {
            let [op, a, b, c] = varint_fields(body)?;
            ensure!(op == 0, "unknown ternary op {op}");
            Node::TernCond(idx(a)?, idx(b)?, idx(c)?)
        }
        k => bail!("unknown graph node kind {k}"),
    };
    nodes.push(node);
    Ok(())
}

struct Metadata {
    witness_signals: Vec<u32>,
    prime_le: Option<Vec<u8>>,
    input_signal_info: Vec<u8>,
}

fn decode_metadata(md: &[u8]) -> Result<Metadata> {
    let mut out = Metadata {
        witness_signals: Vec::new(),
        prime_le: None,
        input_signal_info: Vec::new(),
    };
    for f in fields(md) {
        match f? {
            (1, Field::Varint(v)) => out.witness_signals.push(idx(v)?),
            (1, Field::Bytes(packed)) => {
                let mut p = packed;
                while !p.is_empty() {
                    let (v, n) = read_varint(p)?;
                    out.witness_signals.push(idx(v)?);
                    p = &p[n..];
                }
            }
            (3, Field::Bytes(big)) => {
                for g in fields(big) {
                    if let (1, Field::Bytes(v)) = g? {
                        out.prime_le = Some(v.to_vec());
                    }
                }
            }
            (5, Field::Bytes(info)) => out.input_signal_info = info.to_vec(),
            _ => {}
        }
    }
    ensure!(
        !out.witness_signals.is_empty(),
        "graph has no witness signals"
    );
    Ok(out)
}

/// `storage::deserialize_input_infos`; bus-typed inputs are rejected.
fn decode_input_signal_info(data: &[u8]) -> Result<Vec<InputSignal>> {
    let mut pos = 0usize;
    let u32_at = |pos: &mut usize| -> Result<usize> {
        let b = data
            .get(*pos..*pos + 4)
            .ok_or_else(|| anyhow!("input signal info truncated"))?;
        *pos += 4;
        Ok(u32::from_le_bytes(b.try_into().unwrap()) as usize)
    };
    let count = u32_at(&mut pos)?;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let name_len = u32_at(&mut pos)?;
        let name = std::str::from_utf8(
            data.get(pos..pos + name_len)
                .ok_or_else(|| anyhow!("input signal name truncated"))?,
        )
        .context("input signal name is not UTF-8")?
        .to_string();
        pos += name_len;
        let offset = u32_at(&mut pos)?;
        let dims = u32_at(&mut pos)?;
        let mut len = 1usize;
        for _ in 0..dims {
            len *= u32_at(&mut pos)?;
        }
        let has_type = *data
            .get(pos)
            .ok_or_else(|| anyhow!("input signal info truncated"))?;
        pos += 1;
        ensure!(has_type == 0, "bus-typed input `{name}` is not supported");
        out.push(InputSignal { name, offset, len });
    }
    Ok(out)
}
