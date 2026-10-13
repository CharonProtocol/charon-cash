//! Batch-affine vs arkworks MSM on random full-width scalars.
//!   cargo run --release --example msm_bench --no-default-features   # one thread
use std::time::Instant;

use ark_bn254::{Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::{CurveGroup, VariableBaseMSM};
use ark_ff::{PrimeField, UniformRand};
use privacy_cash_prover::msm::msm_batch_affine;

fn main() {
    let mut rng = ark_std::test_rng();
    for n in [4096usize, 16384, 65536] {
        let bases: Vec<G1Affine> = (0..n).map(|_| G1Projective::rand(&mut rng).into_affine()).collect();
        let scalars: Vec<_> = (0..n).map(|_| Fr::rand(&mut rng).into_bigint()).collect();
        let t = Instant::now();
        let a = G1Projective::msm_bigint(&bases, &scalars);
        let ta = t.elapsed();
        let t = Instant::now();
        let b = msm_batch_affine(&bases, &scalars);
        let tb = t.elapsed();
        assert_eq!(a.into_affine(), b.into_affine());
        println!("G1 n={n:<6} ark {:>7.1}ms  batch-affine {:>7.1}ms", ta.as_secs_f64() * 1e3, tb.as_secs_f64() * 1e3);
    }
    let n = 16384;
    let bases: Vec<G2Affine> = (0..n).map(|_| G2Projective::rand(&mut rng).into_affine()).collect();
    let scalars: Vec<_> = (0..n).map(|_| Fr::rand(&mut rng).into_bigint()).collect();
    let t = Instant::now();
    let a = G2Projective::msm_bigint(&bases, &scalars);
    let ta = t.elapsed();
    let t = Instant::now();
    let b = msm_batch_affine(&bases, &scalars);
    let tb = t.elapsed();
    assert_eq!(a.into_affine(), b.into_affine());
    println!("G2 n={n:<6} ark {:>7.1}ms  batch-affine {:>7.1}ms", ta.as_secs_f64() * 1e3, tb.as_secs_f64() * 1e3);
}
