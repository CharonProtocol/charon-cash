//! Host round-trip: ark compressed (G1 32-limb swap, G2 full reverse) vs bn254
//! syscall decompress. This pins the exact compressed wire format the SDK must
//! emit; the `dump_compressed_vectors` test also writes ground-truth vectors
//! to /tmp for the TypeScript compressor to be tested against.

use ark_bn254::{G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField, UniformRand};
use ark_serialize::CanonicalSerialize;
use privacy_cash::groth16::{decompress_g1, decompress_g2};

fn fq_to_be_bytes_32(x: &ark_bn254::Fq) -> [u8; 32] {
    let le = x.into_bigint().to_bytes_le();
    let mut out = [0u8; 32];
    for (i, b) in le.iter().enumerate().take(32) {
        out[31 - i] = *b;
    }
    out
}

fn swap_limbs_32(bytes: &[u8]) -> Vec<u8> {
    bytes
        .chunks_exact(32)
        .flat_map(|chunk| chunk.iter().rev().copied())
        .collect()
}

fn serialize_g1_compressed(p: &G1Affine) -> [u8; 32] {
    let mut le = Vec::with_capacity(32);
    p.serialize_compressed(&mut le).unwrap();
    swap_limbs_32(&le).try_into().unwrap()
}

fn serialize_g2_compressed(p: &G2Affine) -> [u8; 64] {
    let mut le = Vec::with_capacity(64);
    p.serialize_compressed(&mut le).unwrap();
    le.into_iter().rev().collect::<Vec<_>>().try_into().unwrap()
}

fn serialize_g1_uncompressed_be(p: &G1Affine) -> [u8; 64] {
    let x = fq_to_be_bytes_32(&p.x);
    let y = fq_to_be_bytes_32(&p.y);
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&x);
    out[32..].copy_from_slice(&y);
    out
}

fn serialize_g2_uncompressed_be(p: &G2Affine) -> [u8; 128] {
    let x0 = fq_to_be_bytes_32(&p.x.c0);
    let x1 = fq_to_be_bytes_32(&p.x.c1);
    let y0 = fq_to_be_bytes_32(&p.y.c0);
    let y1 = fq_to_be_bytes_32(&p.y.c1);
    let mut out = [0u8; 128];
    out[..32].copy_from_slice(&x1);
    out[32..64].copy_from_slice(&x0);
    out[64..96].copy_from_slice(&y1);
    out[96..].copy_from_slice(&y0);
    out
}

#[test]
fn decompress_g1_generator_and_random() {
    let g = G1Affine::generator();
    let got = decompress_g1(&serialize_g1_compressed(&g)).unwrap();
    assert_eq!(got, serialize_g1_uncompressed_be(&g));

    let mut rng = ark_std::rand::thread_rng();
    for _ in 0..8 {
        let p = G1Affine::rand(&mut rng);
        if p.is_zero() {
            continue;
        }
        let got = decompress_g1(&serialize_g1_compressed(&p)).unwrap();
        assert_eq!(got, serialize_g1_uncompressed_be(&p));
    }
}

#[test]
fn decompress_g2_generator_and_random() {
    let g = G2Affine::generator();
    let compressed = serialize_g2_compressed(&g);
    let got = decompress_g2(&compressed).expect("g2 generator decompress");
    assert_eq!(got, serialize_g2_uncompressed_be(&g));

    let mut rng = ark_std::rand::thread_rng();
    for _ in 0..4 {
        let p = G2Affine::rand(&mut rng);
        if p.is_zero() {
            continue;
        }
        let got = decompress_g2(&serialize_g2_compressed(&p)).expect("g2 random decompress");
        assert_eq!(got, serialize_g2_uncompressed_be(&p));
    }
}

#[test]
fn compressed_g1_g2_sizes() {
    let g = G1Affine::generator();
    assert_eq!(serialize_g1_compressed(&g).len(), 32);
    let g2 = G2Affine::generator();
    assert_eq!(serialize_g2_compressed(&g2).len(), 64);
}

/// Writes /tmp/proof-vectors.json: pairs of (uncompressed BE, ark-compressed
/// BE) for G1 and G2, for the TypeScript compressor's unit test. Test-only
/// artifact; lives in /tmp by project convention.
#[test]
fn dump_compressed_vectors() {
    let mut rng = ark_std::rand::thread_rng();
    let mut g1 = Vec::new();
    let mut g2 = Vec::new();

    let gen = G1Affine::generator();
    g1.push((
        hex(&serialize_g1_uncompressed_be(&gen)),
        hex(&serialize_g1_compressed(&gen)),
    ));
    for _ in 0..5 {
        let p = G1Affine::rand(&mut rng);
        if p.is_zero() {
            continue;
        }
        g1.push((
            hex(&serialize_g1_uncompressed_be(&p)),
            hex(&serialize_g1_compressed(&p)),
        ));
    }

    let gen2 = G2Affine::generator();
    g2.push((
        hex(&serialize_g2_uncompressed_be(&gen2)),
        hex(&serialize_g2_compressed(&gen2)),
    ));
    for _ in 0..5 {
        let p = G2Affine::rand(&mut rng);
        if p.is_zero() {
            continue;
        }
        g2.push((
            hex(&serialize_g2_uncompressed_be(&p)),
            hex(&serialize_g2_compressed(&p)),
        ));
    }

    let json = format!(
        "{{\n  \"g1\": {},\n  \"g2\": {}\n}}\n",
        serde_json::to_string(&g1).unwrap(),
        serde_json::to_string(&g2).unwrap()
    );
    std::fs::write("/tmp/proof-vectors.json", json).expect("write vectors");
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
