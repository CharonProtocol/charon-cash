//! JNI surface used by the Android app (`cash.charon.prover.NativeProver`).

use std::sync::OnceLock;

use jni::objects::{JByteArray, JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;

use crate::Prover;

static PROVER: OnceLock<Prover> = OnceLock::new();

fn throw(env: &mut JNIEnv, msg: &str) {
    let _ = env.throw_new("java/lang/IllegalStateException", msg);
}

/// `load(zkey, graph)`: parses the circuit once per process; later calls are no-ops.
#[no_mangle]
pub extern "system" fn Java_cash_charon_prover_NativeProver_load<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    zkey: JByteArray<'l>,
    graph: JByteArray<'l>,
) {
    if PROVER.get().is_some() {
        return;
    }
    let loaded = env
        .convert_byte_array(&zkey)
        .and_then(|z| env.convert_byte_array(&graph).map(|g| (z, g)));
    let (zkey, graph) = match loaded {
        Ok(v) => v,
        Err(e) => return throw(&mut env, &format!("{e}")),
    };
    match Prover::new(&zkey, &graph) {
        Ok(p) => {
            let _ = PROVER.set(p);
        }
        Err(e) => throw(&mut env, &format!("{e:#}")),
    }
}

/// `prove(inputJson)`: circuit-input JSON in, `{proof_a, proof_b, proof_c, public_signals}` JSON out.
#[no_mangle]
pub extern "system" fn Java_cash_charon_prover_NativeProver_prove<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    input: JString<'l>,
) -> jstring {
    let Some(prover) = PROVER.get() else {
        throw(&mut env, "prover not loaded");
        return std::ptr::null_mut();
    };
    let input: String = match env.get_string(&input) {
        Ok(s) => s.into(),
        Err(e) => {
            throw(&mut env, &format!("{e}"));
            return std::ptr::null_mut();
        }
    };
    let out = prover
        .prove_json(&input)
        .and_then(|r| serde_json::to_string(&r).map_err(Into::into));
    match out.map(|s| env.new_string(s)) {
        Ok(Ok(s)) => s.into_raw(),
        Ok(Err(e)) => {
            throw(&mut env, &format!("{e}"));
            std::ptr::null_mut()
        }
        Err(e) => {
            throw(&mut env, &format!("{e:#}"));
            std::ptr::null_mut()
        }
    }
}
