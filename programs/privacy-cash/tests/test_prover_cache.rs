use ark_bn254::Bn254;
use ark_bn254::Fr;
use std::sync::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;

static ZKEY_CACHE: once_cell::sync::Lazy<Mutex<HashMap<PathBuf, (ark_groth16::ProvingKey<Bn254>, ark_circom::index::NPIndex<Fr>)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn test() {
    let mut guard = ZKEY_CACHE.lock().unwrap();
    let (pk, np) = guard.get(&PathBuf::new()).unwrap();
    let _a = np.a.clone();
}
