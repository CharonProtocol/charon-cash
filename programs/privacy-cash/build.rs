fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    #[cfg(feature = "experimental-poseidon2")]
    {
        use solana_poseidon2::{horizen, FieldElement};
        // Compute once on the host, never spend on-chain CUs constructing empty roots.
        let mut zeros = [[0u8; 32]; 41];
        for i in 1..zeros.len() {
            let previous = FieldElement::from_bytes_be(&zeros[i - 1]).unwrap();
            zeros[i] = horizen::compress(previous, previous).to_bytes_be();
        }
        let path = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        std::fs::write(
            path.join("poseidon2_zeros.rs"),
            format!("const ZEROS: [[u8; 32]; 41] = {:?};", zeros),
        )
        .unwrap();
    }
}
