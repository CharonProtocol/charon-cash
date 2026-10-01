use rust_witness::transpile::transpile_wasm;

fn main() {
    transpile_wasm(concat!(env!("CARGO_MANIFEST_DIR"), "/../public/circuit/").to_string());
}
