//! snarkjs-compatible R1CS -> QAP witness map.
//!
//! Adapted from arkworks-rs/circom-compat `ark-circom` 0.6.0
//! `src/circom/qap.rs` (MIT OR Apache-2.0). Only change: rayon is used when
//! the `parallel` feature is on and plain iterators otherwise, so the
//! single-threaded wasm build has no rayon.
//!
//! The arkworks witness map computes H via (AB-C)/Z in the evaluation domain.
//! snarkjs instead precomputes the Lagrange form of the powers of tau in a
//! domain twice as large, and the witness map is the odd coefficients of
//! (AB-C) in that domain. That is HZ when computing the C proof element.

use ark_ff::PrimeField;
use ark_groth16::r1cs_to_qap::{evaluate_constraint, LibsnarkReduction, R1CSToQAP};
use ark_poly::EvaluationDomain;
use ark_relations::gr1cs::{ConstraintSystemRef, SynthesisError};
use ark_relations::utils::matrix::Matrix;
#[cfg(feature = "parallel")]
use rayon::prelude::*;

macro_rules! iter_mut {
    ($e:expr) => {{
        #[cfg(feature = "parallel")]
        let it = $e.par_iter_mut();
        #[cfg(not(feature = "parallel"))]
        let it = $e.iter_mut();
        it
    }};
}

pub struct CircomReduction;

impl R1CSToQAP for CircomReduction {
    #[allow(clippy::type_complexity)]
    fn instance_map_with_evaluation<F: PrimeField, D: EvaluationDomain<F>>(
        cs: ConstraintSystemRef<F>,
        t: &F,
    ) -> Result<(Vec<F>, Vec<F>, Vec<F>, F, usize, usize), SynthesisError> {
        LibsnarkReduction::instance_map_with_evaluation::<F, D>(cs, t)
    }

    fn witness_map_from_matrices<F: PrimeField, D: EvaluationDomain<F>>(
        matrices: &[Matrix<F>],
        num_inputs: usize,
        num_constraints: usize,
        full_assignment: &[F],
    ) -> Result<Vec<F>, SynthesisError> {
        let zero = F::zero();
        let domain =
            D::new(num_constraints + num_inputs).ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
        let domain_size = domain.size();

        let mut a = vec![zero; domain_size];
        let mut b = vec![zero; domain_size];

        iter_mut!(a[..num_constraints])
            .zip(&mut b[..num_constraints])
            .zip(&matrices[0])
            .zip(&matrices[1])
            .for_each(|(((a, b), at_i), bt_i)| {
                *a = evaluate_constraint(at_i, full_assignment);
                *b = evaluate_constraint(bt_i, full_assignment);
            });

        a[num_constraints..num_constraints + num_inputs]
            .clone_from_slice(&full_assignment[..num_inputs]);

        let mut c = vec![zero; domain_size];
        iter_mut!(c[..num_constraints])
            .zip(&a)
            .zip(&b)
            .for_each(|((c_i, &a), &b)| {
                *c_i = a * b;
            });

        domain.ifft_in_place(&mut a);
        domain.ifft_in_place(&mut b);

        let root_of_unity = D::new(2 * domain_size)
            .ok_or(SynthesisError::PolynomialDegreeTooLarge)?
            .element(1);
        D::distribute_powers_and_mul_by_const(&mut a, root_of_unity, F::one());
        D::distribute_powers_and_mul_by_const(&mut b, root_of_unity, F::one());

        domain.fft_in_place(&mut a);
        domain.fft_in_place(&mut b);

        let mut ab = domain.mul_polynomials_in_evaluation_domain(&a, &b);
        drop(a);
        drop(b);

        domain.ifft_in_place(&mut c);
        D::distribute_powers_and_mul_by_const(&mut c, root_of_unity, F::one());
        domain.fft_in_place(&mut c);

        iter_mut!(ab).zip(c).for_each(|(ab_i, c_i)| *ab_i -= &c_i);

        Ok(ab)
    }

    fn h_query_scalars<F: PrimeField, D: EvaluationDomain<F>>(
        max_power: usize,
        t: F,
        _: F,
        delta_inverse: F,
    ) -> Result<Vec<F>, SynthesisError> {
        // H has domain-1 powers and Z has domain powers, so HZ has 2*domain-1.
        let mut scalars: Vec<F> = (0..2 * max_power + 1)
            .map(|i| delta_inverse * t.pow([i as u64]))
            .collect();
        let domain = D::new(scalars.len()).ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
        domain.ifft_in_place(&mut scalars);
        Ok(scalars.into_iter().skip(1).step_by(2).collect())
    }
}
