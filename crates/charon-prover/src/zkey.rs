//! snarkjs `.zkey` (Groth16, BN254) -> arkworks `ProvingKey` + constraint matrices.
//!
//! Adapted from arkworks-rs/circom-compat `ark-circom` 0.6.0 `src/zkey.rs`
//! (MIT OR Apache-2.0). Differences: reads from a byte slice, no `byteorder`,
//! no Wasmer in the dependency tree, and returns `anyhow` errors instead of
//! panicking on a missing section.
//!
//! Sections: 1 header, 2 Groth header (n8q, q, n8r, r, nVars, nPub,
//! domainSize, alpha1, beta1, beta2, gamma2, delta1, delta2), 3 IC, 4 coeffs,
//! 5 A, 6 B1, 7 B2, 8 C (L), 9 H, 10 contributions.

use std::collections::HashMap;

use anyhow::{anyhow, ensure, Result};
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ff::{BigInteger256, PrimeField, Zero};
use ark_groth16::{ProvingKey, VerifyingKey};
use ark_relations::utils::matrix::Matrix;

/// The A and B matrices snarkjs stores in section 4 (C is implied by the
/// circom QAP reduction), plus the shape arkworks' prover needs.
#[derive(Debug, Clone)]
pub struct ConstraintMatrices {
    /// Public inputs + the constant `1`.
    pub num_instance_variables: usize,
    pub num_witness_variables: usize,
    pub num_constraints: usize,
    pub a: Matrix<Fr>,
    pub b: Matrix<Fr>,
}

/// Parses a snarkjs zkey held in memory.
pub fn read_zkey(bytes: &[u8]) -> Result<(ProvingKey<Bn254>, ConstraintMatrices)> {
    let file = BinFile::new(bytes)?;
    let header = file.groth_header()?;
    let pk = file.proving_key(&header)?;
    let matrices = file.matrices(&header)?;
    Ok((pk, matrices))
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn at(buf: &'a [u8], pos: usize) -> Self {
        Self { buf, pos }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let out = self
            .buf
            .get(self.pos..self.pos + n)
            .ok_or_else(|| anyhow!("zkey truncated at byte {}", self.pos))?;
        self.pos += n;
        Ok(out)
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn bigint(&mut self) -> Result<BigInteger256> {
        let b = self.take(32)?;
        let mut limbs = [0u64; 4];
        for (i, l) in limbs.iter_mut().enumerate() {
            *l = u64::from_le_bytes(b[i * 8..i * 8 + 8].try_into().unwrap());
        }
        Ok(BigInteger256::new(limbs))
    }

    /// Coefficients are stored as Montgomery(x) * R, so strip one R.
    fn fr(&mut self) -> Result<Fr> {
        let raw = self.bigint()?;
        Ok(Fr::new_unchecked(Fr::new_unchecked(raw).into_bigint()))
    }

    /// Points are stored in Montgomery form already.
    fn fq(&mut self) -> Result<Fq> {
        Ok(Fq::new_unchecked(self.bigint()?))
    }

    fn fq2(&mut self) -> Result<Fq2> {
        let c0 = self.fq()?;
        let c1 = self.fq()?;
        Ok(Fq2::new(c0, c1))
    }

    fn g1(&mut self) -> Result<G1Affine> {
        let x = self.fq()?;
        let y = self.fq()?;
        if x.is_zero() && y.is_zero() {
            return Ok(G1Affine::identity());
        }
        let p = G1Affine::new_unchecked(x, y);
        ensure!(p.is_on_curve(), "zkey G1 point is not on the curve");
        Ok(p)
    }

    fn g2(&mut self) -> Result<G2Affine> {
        let x = self.fq2()?;
        let y = self.fq2()?;
        if x.is_zero() && y.is_zero() {
            return Ok(G2Affine::identity());
        }
        let p = G2Affine::new_unchecked(x, y);
        ensure!(p.is_on_curve(), "zkey G2 point is not on the curve");
        Ok(p)
    }
}

struct HeaderGroth {
    n_vars: usize,
    n_public: usize,
    domain_size: usize,
    alpha_g1: G1Affine,
    beta_g1: G1Affine,
    beta_g2: G2Affine,
    gamma_g2: G2Affine,
    delta_g1: G1Affine,
    delta_g2: G2Affine,
}

struct BinFile<'a> {
    bytes: &'a [u8],
    sections: HashMap<u32, usize>,
}

impl<'a> BinFile<'a> {
    fn new(bytes: &'a [u8]) -> Result<Self> {
        let mut r = Reader::at(bytes, 0);
        ensure!(r.take(4)? == b"zkey", "not a snarkjs zkey file");
        let _version = r.u32()?;
        let num_sections = r.u32()?;
        let mut sections = HashMap::new();
        for _ in 0..num_sections {
            let id = r.u32()?;
            let len = r.u64()? as usize;
            sections.entry(id).or_insert(r.pos);
            r.take(len)?;
        }
        Ok(Self { bytes, sections })
    }

    fn section(&self, id: u32) -> Result<Reader<'a>> {
        let pos = *self
            .sections
            .get(&id)
            .ok_or_else(|| anyhow!("zkey is missing section {id}"))?;
        Ok(Reader::at(self.bytes, pos))
    }

    fn groth_header(&self) -> Result<HeaderGroth> {
        let mut r = self.section(1)?;
        ensure!(r.u32()? == 1, "zkey is not a Groth16 key");

        let mut r = self.section(2)?;
        let n8q = r.u32()?;
        let _q = r.bigint()?;
        let n8r = r.u32()?;
        let _r = r.bigint()?;
        ensure!(n8q == 32 && n8r == 32, "zkey is not for BN254");
        let n_vars = r.u32()? as usize;
        let n_public = r.u32()? as usize;
        let domain_size = r.u32()? as usize;
        Ok(HeaderGroth {
            n_vars,
            n_public,
            domain_size,
            alpha_g1: r.g1()?,
            beta_g1: r.g1()?,
            beta_g2: r.g2()?,
            gamma_g2: r.g2()?,
            delta_g1: r.g1()?,
            delta_g2: r.g2()?,
        })
    }

    fn g1_section(&self, id: u32, n: usize) -> Result<Vec<G1Affine>> {
        let mut r = self.section(id)?;
        (0..n).map(|_| r.g1()).collect()
    }

    fn g2_section(&self, id: u32, n: usize) -> Result<Vec<G2Affine>> {
        let mut r = self.section(id)?;
        (0..n).map(|_| r.g2()).collect()
    }

    fn proving_key(&self, h: &HeaderGroth) -> Result<ProvingKey<Bn254>> {
        let vk = VerifyingKey::<Bn254> {
            alpha_g1: h.alpha_g1,
            beta_g2: h.beta_g2,
            gamma_g2: h.gamma_g2,
            delta_g2: h.delta_g2,
            gamma_abc_g1: self.g1_section(3, h.n_public + 1)?,
        };
        Ok(ProvingKey::<Bn254> {
            vk,
            beta_g1: h.beta_g1,
            delta_g1: h.delta_g1,
            a_query: self.g1_section(5, h.n_vars)?,
            b_g1_query: self.g1_section(6, h.n_vars)?,
            b_g2_query: self.g2_section(7, h.n_vars)?,
            l_query: self.g1_section(8, h.n_vars - h.n_public - 1)?,
            h_query: self.g1_section(9, h.domain_size)?,
        })
    }

    fn matrices(&self, h: &HeaderGroth) -> Result<ConstraintMatrices> {
        let mut r = self.section(4)?;
        let num_coeffs = r.u32()?;
        let mut m: [Matrix<Fr>; 2] = [vec![vec![]; h.domain_size], vec![vec![]; h.domain_size]];
        let mut max_constraint = 0usize;
        for _ in 0..num_coeffs {
            let matrix = r.u32()? as usize;
            let constraint = r.u32()? as usize;
            let signal = r.u32()? as usize;
            let value = r.fr()?;
            ensure!(
                matrix < 2 && constraint < h.domain_size,
                "zkey coefficient out of range"
            );
            max_constraint = max_constraint.max(constraint);
            m[matrix][constraint].push((value, signal));
        }
        // snarkjs appends one constraint per public input; arkworks adds them back.
        let num_constraints = max_constraint - h.n_public;
        let [mut a, mut b] = m;
        a.truncate(num_constraints);
        b.truncate(num_constraints);
        Ok(ConstraintMatrices {
            num_instance_variables: h.n_public + 1,
            num_witness_variables: h.n_vars - h.n_public,
            num_constraints,
            a,
            b,
        })
    }
}
