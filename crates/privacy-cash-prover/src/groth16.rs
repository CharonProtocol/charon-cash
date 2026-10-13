//! Groth16 proof assembly, adapted from ark-groth16 0.6 `prover.rs`
//! (MIT/Apache-2.0). The math is unchanged; the five multi-scalar
//! multiplications go through [`msm`], which splits the bases across the
//! current rayon pool. ark-ec's own `parallel` MSM builds a fresh OS-thread
//! pool on every call, which wasm threads cannot do (and which costs native
//! builds a thread spawn per MSM).

use std::sync::atomic::{AtomicBool, Ordering};

use ark_bn254::{Bn254, Fr};
use ark_ec::short_weierstrass::{Affine, Projective, SWCurveConfig};
use ark_ec::{CurveGroup, VariableBaseMSM};
use ark_ff::{PrimeField, Zero};
use ark_groth16::{r1cs_to_qap::R1CSToQAP, Proof, ProvingKey};
use ark_poly::GeneralEvaluationDomain;
use ark_relations::{gr1cs::SynthesisError, utils::matrix::Matrix};
use ark_std::ops::Mul;
#[cfg(feature = "parallel")]
use rayon::prelude::*;

use crate::reduction::CircomReduction;

/// A/B switch: true routes the MSMs through arkworks' Jacobian Pippenger
/// instead of the batch-affine one in [`crate::msm`].
static ARK_MSM: AtomicBool = AtomicBool::new(false);

pub fn set_ark_msm(on: bool) {
    ARK_MSM.store(on, Ordering::Relaxed);
}

/// `ProvingKey` + R1CS matrices + full assignment -> proof, with blinding `r`, `s`.
pub fn create_proof(
    pk: &ProvingKey<Bn254>,
    r: Fr,
    s: Fr,
    matrices: &[Matrix<Fr>],
    num_inputs: usize,
    num_constraints: usize,
    full_assignment: &[Fr],
) -> Result<Proof<Bn254>, SynthesisError> {
    let h = CircomReduction::witness_map_from_matrices::<Fr, GeneralEvaluationDomain<Fr>>(
        matrices,
        num_inputs,
        num_constraints,
        full_assignment,
    )?;
    let input_assignment = &full_assignment[1..num_inputs];
    let aux_assignment = &full_assignment[num_inputs..];
    let h_assignment = to_bigints(&h);
    drop(h);
    let h_acc = msm(&pk.h_query, &h_assignment);
    drop(h_assignment);

    let aux_assignment = to_bigints(aux_assignment);
    let l_aux_acc = msm(&pk.l_query, &aux_assignment);
    let r_s_delta_g1 = pk.delta_g1 * (r * s);

    let input_assignment = to_bigints(input_assignment);
    let assignment = [&input_assignment[..], &aux_assignment[..]].concat();
    drop(aux_assignment);

    let r_g1 = pk.delta_g1.mul(r);
    let g_a = calculate_coeff(r_g1, &pk.a_query, pk.vk.alpha_g1, &assignment);
    let s_g_a = g_a * s;

    let g1_b = if r.is_zero() {
        Projective::zero()
    } else {
        let s_g1 = pk.delta_g1.mul(s);
        calculate_coeff(s_g1, &pk.b_g1_query, pk.beta_g1, &assignment)
    };

    let s_g2 = pk.vk.delta_g2.mul(s);
    let g2_b = calculate_coeff(s_g2, &pk.b_g2_query, pk.vk.beta_g2, &assignment);
    let r_g1_b = g1_b * r;
    drop(assignment);

    let mut g_c = s_g_a;
    g_c += &r_g1_b;
    g_c -= &r_s_delta_g1;
    g_c += &l_aux_acc;
    g_c += &h_acc;

    Ok(Proof {
        a: g_a.into_affine(),
        b: g2_b.into_affine(),
        c: g_c.into_affine(),
    })
}

fn to_bigints<F: PrimeField>(xs: &[F]) -> Vec<F::BigInt> {
    #[cfg(feature = "parallel")]
    return xs.par_iter().map(|x| x.into_bigint()).collect();
    #[cfg(not(feature = "parallel"))]
    return xs.iter().map(|x| x.into_bigint()).collect();
}

fn calculate_coeff<P: SWCurveConfig>(
    initial: Projective<P>,
    query: &[Affine<P>],
    vk_param: Affine<P>,
    assignment: &[<P::ScalarField as PrimeField>::BigInt],
) -> Projective<P> {
    let mut res = initial;
    res += &query[0];
    res += &msm(&query[1..], assignment);
    res += &vk_param;
    res
}

/// Per-thread chunk MSMs, summed. Smaller chunks (for load balancing across
/// performance/efficiency cores) measured slower.
fn msm<P: SWCurveConfig>(
    bases: &[Affine<P>],
    scalars: &[<P::ScalarField as PrimeField>::BigInt],
) -> Projective<P> {
    let n = bases.len().min(scalars.len());
    let (bases, scalars) = (&bases[..n], &scalars[..n]);
    let one = |b: &[Affine<P>], s: &[<P::ScalarField as PrimeField>::BigInt]| {
        if ARK_MSM.load(Ordering::Relaxed) {
            Projective::<P>::msm_bigint(b, s)
        } else {
            crate::msm::msm(b, s)
        }
    };
    #[cfg(feature = "parallel")]
    {
        let threads = rayon::current_num_threads();
        if threads > 1 && n >= 1024 {
            let chunk = n.div_ceil(threads);
            return bases
                .par_chunks(chunk)
                .zip(scalars.par_chunks(chunk))
                .map(|(b, s)| one(b, s))
                .reduce(Projective::zero, |a, b| a + b);
        }
    }
    one(bases, scalars)
}
