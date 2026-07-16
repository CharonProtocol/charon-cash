//! Transpiles the circom witness calculator (`transaction2.wasm`) to native code at build time.
//!
//! `rust-witness` walks the given directory, converts every `.wasm` to C (via w2c2, which it
//! builds on first use), and compiles it in. The witness function is named after the file, so
//! `transaction2.wasm` is reached at runtime through `rust_witness::witness!(transaction2)`.
//!
//! This is why the crate needs no wasmer: witness generation runs as ordinary native code.

use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    // Workspace artifacts live two levels up from crates/pc-prover.
    let wasmdir = Path::new(&manifest).join("../../artifacts/circuits");
    let wasmdir = wasmdir
        .canonicalize()
        .unwrap_or_else(|_| panic!("artifacts dir not found at {}", wasmdir.display()));

    rust_witness::transpile::transpile_wasm(wasmdir.to_str().unwrap().to_string());
}
