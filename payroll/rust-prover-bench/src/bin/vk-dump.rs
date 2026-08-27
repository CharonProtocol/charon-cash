// Dumps a snarkjs zkey's groth16 verifying key as the byte-array Rust source
// the pinocchio program's Groth16Verifyingkey expects. Run against a KNOWN
// zkey first (production transaction2) and diff against utils.rs to confirm
// the byte convention before trusting a new circuit's output.

use std::env;
use std::fs::File;

use ark_bn254::{Fq2, G1Affine, G2Affine};
use ark_circom::read_zkey;
use ark_ec::AffineRepr;
use ark_ff::Field;

fn fp_dec_be<F: ark_ff::PrimeField>(f: &F) -> Vec<u8> {
    // arkworks stores field elements little-endian; the on-chain "_be"
    // syscalls want big-endian, so flip the 32-byte limb.
    use ark_ff::BigInteger;
    let mut b = f.into_bigint().to_bytes_le();
    b.reverse();
    b
}

fn g1(p: &G1Affine) -> Vec<u8> {
    let (x, y) = p.xy().expect("point at infinity");
    [fp_dec_be(&x), fp_dec_be(&y)].concat()
}

fn g2(p: &G2Affine, swap: bool) -> Vec<u8> {
    let (x, y) = p.xy().expect("point at infinity");
    let pair = |e: &Fq2| {
        if swap {
            [fp_dec_be(&e.c1), fp_dec_be(&e.c0)].concat()
        } else {
            [fp_dec_be(&e.c0), fp_dec_be(&e.c1)].concat()
        }
    };
    [pair(&x), pair(&y)].concat()
}

fn arr(name: &str, bytes: &[u8]) {
    let chunks: Vec<String> = bytes.chunks(16).map(|c| c.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(", ")).collect();
    println!("    pub {name}: [");
    for c in &chunks { println!("        {c},"); }
    println!("    ],");
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let zkey = args.get(1).expect("usage: vk-dump <circuit.zkey>");
    let swap = args.get(2).map(|s| s == "swap").unwrap_or(false);

    let mut f = File::open(zkey).unwrap();
    let (pk, _n) = read_zkey(&mut f).unwrap();
    let vk = pk.vk;

    println!("    nr_pubinputs: {},", vk.gamma_abc_g1.len() - 1);
    arr("vk_alpha_g1", &g1(&vk.alpha_g1.into()));
    arr("vk_beta_g2", &g2(&vk.beta_g2.into(), swap));
    arr("vk_gamme_g2", &g2(&vk.gamma_g2.into(), swap));
    arr("vk_delta_g2", &g2(&vk.delta_g2.into(), swap));
    println!("    vk_ic: &[");
    for ic in &vk.gamma_abc_g1 {
        let b = g1(&(*ic).into());
        let chunks: Vec<String> = b.chunks(16).map(|c| c.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ")).collect();
        println!("        [");
        for c in &chunks { println!("            {c},"); }
        println!("        ],");
    }
    println!("    ],");
}
