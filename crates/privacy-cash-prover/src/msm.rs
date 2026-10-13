//! Batch-affine Pippenger MSM for short-Weierstrass curves (G1 and G2).
//!
//! arkworks accumulates buckets in Jacobian coordinates: every point added to
//! a bucket costs a mixed addition (~11 field multiplications). Here buckets
//! stay affine and additions are queued; each flush adds a whole batch with
//! ONE field inversion (Montgomery's batch-inversion trick), so a bucket add
//! costs ~6 multiplications. The proving-key bases are affine already. A
//! bucket can only appear once per batch; a point whose bucket is already in
//! the batch goes to that bucket's projective overflow instead (a plain mixed
//! add — rare in full windows, and the whole story in the narrow top window,
//! where a retry queue went quadratic). Same-x pairs (doubling or P + -P)
//! fall back to projective math.
//!
//! Scalars use signed c-bit digits, so each window needs 2^(c-1) buckets.

use ark_ec::short_weierstrass::{Affine, Projective, SWCurveConfig};
use ark_ec::{AdditiveGroup, AffineRepr, CurveGroup};
use ark_ff::{BigInteger, Field, PrimeField, Zero};

type BigIntOf<P> = <<P as ark_ec::CurveConfig>::ScalarField as PrimeField>::BigInt;

/// Additions batched per field inversion (capped at an eighth of the bucket
/// count so random digits rarely collide inside a batch).
const BATCH: usize = 1024;

/// Scalars at or below this many bits go to arkworks, which sums 0/1 and
/// small scalars without windows; they would otherwise pile into a handful
/// of buckets and collide on every add.
const SMALL_BITS: u32 = 64;

/// Below this many full-width scalars batching doesn't pay for itself (an
/// 8-thread split of the 2^16 h-query, 8192 per chunk, measured slower).
const MIN_BATCH_AFFINE: usize = 16384;

/// Window size for `n` points: bit-length(n) - 4 (swept on an M1: G1 2^16
/// best at 13, G2 2^14 at 11 — wider windows lose more to the per-window
/// bucket sweep than they save in accumulation).
fn window_bits(n: usize) -> usize {
    ((usize::BITS - n.leading_zeros()) as usize).saturating_sub(4).clamp(3, 16)
}

/// Signed c-bit digits of every scalar, window-major: `out[w * n + i]`.
fn signed_digits<B: BigInteger>(scalars: &[B], c: usize, windows: usize) -> Vec<i32> {
    let n = scalars.len();
    let mut out = vec![0i32; windows * n];
    let radix = 1i64 << c;
    let half = radix >> 1;
    for (i, s) in scalars.iter().enumerate() {
        let limbs = s.as_ref();
        let mut carry = 0i64;
        for w in 0..windows {
            let bit = w * c;
            let limb = bit / 64;
            let off = bit % 64;
            let mut raw = if limb < limbs.len() { limbs[limb] >> off } else { 0 };
            if off + c > 64 && limb + 1 < limbs.len() {
                raw |= limbs[limb + 1] << (64 - off);
            }
            let mut d = (raw & (radix as u64 - 1)) as i64 + carry;
            carry = 0;
            if d >= half {
                d -= radix;
                carry = 1;
            }
            out[w * n + i] = d as i32;
        }
        debug_assert_eq!(carry, 0, "scalar wider than the digit windows");
    }
    out
}

/// One window's bucket accumulator with affine buckets and a pending batch.
struct Buckets<P: SWCurveConfig> {
    batch_cap: usize,
    buckets: Vec<Affine<P>>,
    busy: Vec<bool>,
    batch: Vec<(u32, Affine<P>)>,
    overflow: Vec<Projective<P>>,
    scratch: Vec<P::BaseField>,
}

impl<P: SWCurveConfig> Buckets<P> {
    fn new(count: usize) -> Self {
        Self {
            batch_cap: (count / 8).clamp(8, BATCH),
            buckets: vec![Affine::identity(); count],
            busy: vec![false; count],
            batch: Vec::with_capacity(BATCH),
            overflow: vec![Projective::zero(); count],
            scratch: Vec::with_capacity(BATCH),
        }
    }

    fn reset(&mut self) {
        self.buckets.iter_mut().for_each(|b| *b = Affine::identity());
        self.overflow.iter_mut().for_each(|b| *b = Projective::zero());
    }

    #[inline]
    fn add(&mut self, b: u32, p: Affine<P>) {
        let bi = b as usize;
        if self.busy[bi] {
            self.overflow[bi] += &p;
            return;
        }
        if self.buckets[bi].is_zero() {
            self.buckets[bi] = p;
            return;
        }
        self.busy[bi] = true;
        self.batch.push((b, p));
        if self.batch.len() >= self.batch_cap {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        // Prefix products of the denominators (x_p - x_q); same-x pairs are
        // resolved in projective coordinates and marked with a zero slot.
        self.scratch.clear();
        let mut acc = P::BaseField::ONE;
        for &(b, p) in &self.batch {
            let q = &self.buckets[b as usize];
            let den = p.x - q.x;
            if den.is_zero() {
                self.scratch.push(P::BaseField::ZERO);
                continue;
            }
            self.scratch.push(acc);
            acc *= den;
        }
        let mut inv = acc.inverse().expect("product of non-zero denominators");
        for k in (0..self.batch.len()).rev() {
            let (b, p) = self.batch[k];
            let bi = b as usize;
            let q = self.buckets[bi];
            let den = p.x - q.x;
            if den.is_zero() {
                self.buckets[bi] = (Projective::from(q) + p).into_affine();
                continue;
            }
            let den_inv = inv * self.scratch[k];
            inv *= den;
            let lambda = (p.y - q.y) * den_inv;
            let x3 = lambda.square() - q.x - p.x;
            let y3 = lambda * (q.x - x3) - q.y;
            self.buckets[bi] = Affine::new_unchecked(x3, y3);
        }
        for &(b, _) in &self.batch {
            self.busy[b as usize] = false;
        }
        self.batch.clear();
    }

    /// Σ (i + 1) · bucket[i] via the running-sum sweep.
    fn sum(&self) -> Projective<P> {
        let mut running = Projective::<P>::zero();
        let mut total = Projective::<P>::zero();
        for (b, o) in self.buckets.iter().zip(&self.overflow).rev() {
            if !b.is_zero() {
                running += b;
            }
            running += o;
            total += &running;
        }
        total
    }
}

/// Σ scalars[i] · bases[i]: full-width scalars through the batch-affine
/// Pippenger, small ones through arkworks.
pub fn msm<P: SWCurveConfig>(bases: &[Affine<P>], scalars: &[BigIntOf<P>]) -> Projective<P> {
    let n = bases.len().min(scalars.len());
    let (mut big_b, mut big_s, mut small_b, mut small_s) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for i in 0..n {
        if scalars[i].is_zero() || bases[i].is_zero() {
            continue;
        }
        if scalars[i].num_bits() > SMALL_BITS {
            big_b.push(bases[i]);
            big_s.push(scalars[i]);
        } else {
            small_b.push(bases[i]);
            small_s.push(scalars[i]);
        }
    }
    if big_b.len() < MIN_BATCH_AFFINE {
        small_b.append(&mut big_b);
        small_s.append(&mut big_s);
    }
    let small = if small_b.is_empty() {
        Projective::zero()
    } else {
        <Projective<P> as ark_ec::VariableBaseMSM>::msm_bigint(&small_b, &small_s)
    };
    small + msm_batch_affine(&big_b, &big_s)
}

/// Batch-affine Pippenger over every (base, scalar) pair.
pub fn msm_batch_affine<P: SWCurveConfig>(bases: &[Affine<P>], scalars: &[BigIntOf<P>]) -> Projective<P> {
    let n = bases.len().min(scalars.len());
    let (bases, scalars) = (&bases[..n], &scalars[..n]);
    if n == 0 {
        return Projective::zero();
    }
    let c = window_bits(n);
    let bits = <P::ScalarField as PrimeField>::MODULUS_BIT_SIZE as usize;
    let windows = bits / c + 1;
    let digits = signed_digits(scalars, c, windows);

    let mut acc = Buckets::<P>::new(1 << (c - 1));
    let mut result = Projective::<P>::zero();
    for w in (0..windows).rev() {
        for _ in 0..c {
            result.double_in_place();
        }
        let row = &digits[w * n..(w + 1) * n];
        let mut any = false;
        for (i, &d) in row.iter().enumerate() {
            if d == 0 || bases[i].is_zero() {
                continue;
            }
            any = true;
            if d > 0 {
                acc.add((d - 1) as u32, bases[i]);
            } else {
                acc.add((-d - 1) as u32, -bases[i]);
            }
        }
        if any {
            acc.flush();
            result += acc.sum();
            acc.reset();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_bn254::{Fr, G1Affine, G1Projective, G2Affine, G2Projective};
    use ark_ec::VariableBaseMSM;
    use ark_ff::UniformRand;
    use ark_std::test_rng;

    fn check_g1(bases: &[G1Affine], scalars: &[Fr]) {
        let big: Vec<_> = scalars.iter().map(|s| s.into_bigint()).collect();
        let want = G1Projective::msm(bases, scalars).unwrap().into_affine();
        assert_eq!(msm(bases, &big).into_affine(), want);
        assert_eq!(msm_batch_affine(bases, &big).into_affine(), want);
    }

    fn check_g2(bases: &[G2Affine], scalars: &[Fr]) {
        let big: Vec<_> = scalars.iter().map(|s| s.into_bigint()).collect();
        let want = G2Projective::msm(bases, scalars).unwrap().into_affine();
        assert_eq!(msm(bases, &big).into_affine(), want);
        assert_eq!(msm_batch_affine(bases, &big).into_affine(), want);
    }

    fn mixed_scalars(n: usize) -> Vec<Fr> {
        let mut rng = test_rng();
        (0..n)
            .map(|i| match i % 7 {
                0 => Fr::zero(),
                1 => Fr::from(1u64),
                2 => -Fr::from(1u64),
                3 => Fr::from((i * 977) as u64),
                4 => -Fr::from((i * 31) as u64),
                _ => Fr::rand(&mut rng),
            })
            .collect()
    }

    #[test]
    fn g1_matches_arkworks_with_edge_cases() {
        let mut rng = test_rng();
        for n in [1usize, 2, 7, 33, 300, 5000, 20000] {
            let mut bases: Vec<G1Affine> = (0..n).map(|_| G1Affine::rand(&mut rng)).collect();
            if n > 3 {
                bases[1] = G1Affine::identity();
                bases[2] = bases[0]; // same point twice: forces the doubling path
                bases[3] = -bases[0]; // P + -P inside one bucket
            }
            check_g1(&bases, &mixed_scalars(n));
        }
    }

    #[test]
    fn g1_same_bucket_collisions() {
        let mut rng = test_rng();
        let n = 4000;
        let bases: Vec<G1Affine> = (0..n).map(|_| G1Affine::rand(&mut rng)).collect();
        let scalars = vec![Fr::from(5u64); n];
        check_g1(&bases, &scalars);
        let mut rng = test_rng();
        let one = G1Affine::rand(&mut rng);
        let same = vec![one; 3000];
        check_g1(&same, &vec![Fr::from(3u64); 3000]);
    }

    #[test]
    fn g2_matches_arkworks() {
        let mut rng = test_rng();
        let n = 700;
        let mut bases: Vec<G2Affine> = (0..n).map(|_| G2Affine::rand(&mut rng)).collect();
        bases[5] = G2Affine::identity();
        bases[6] = bases[7];
        check_g2(&bases, &mixed_scalars(n));
    }
}
