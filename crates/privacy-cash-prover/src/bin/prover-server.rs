//! Local native prover helper: the browser app POSTs circuit-input JSON (the
//! exact string the wasm prover takes) to http://127.0.0.1:PORT/prove and gets
//! the same compressed proof JSON back — natively, ~3x faster per core than
//! wasm. Runs on the employer's own machine, so the witness never leaves it.
//!
//!   cargo run --release --bin prover-server
//!   env: PROVER_ZKEY / PROVER_GRAPH (default: the payroll app's public/ copies),
//!        PROVER_PORT (8790), PROVER_JOBS (concurrent proofs, default cores/2),
//!        PROVER_THREADS (rayon threads per proof, default cores/jobs),
//!        PROVER_ORIGINS (comma list of allowed page origins, default local dev)
//!
//! Pairing: the witness carries the employer's note spend keys, so the app
//! must never hand it to whatever happens to listen on this port. At startup
//! the server prints a random token (or takes PROVER_TOKEN); the user gives it
//! to the app once. Before every run the app sends a random nonce to
//! /health?nonce=..., and only sends inputs if the reply carries
//! HMAC-SHA256(token, nonce) — a port squatter can't produce it. And the
//! input itself travels AES-256-GCM encrypted under SHA-256("charon-prover-v1:"
//! + token): a squatter that relays the challenge to the real helper still
//! only ever sees ciphertext, and a request that doesn't decrypt is refused.
//!
//! Std-only HTTP/1.1 (one request per connection), bound to loopback.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use privacy_cash_prover::Prover;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Free job slots; each slot owns its own rayon pool so concurrent proofs
/// don't fight over one shared pool (one proof on 8 threads costs ~2.3
/// CPU-s vs 0.9 on one thread: small per-job pools finish more proofs).
struct Slots {
    free: Mutex<Vec<usize>>,
    cv: Condvar,
}

impl Slots {
    fn acquire(&self) -> usize {
        let mut free = self.free.lock().unwrap();
        loop {
            if let Some(i) = free.pop() {
                return i;
            }
            free = self.cv.wait(free).unwrap();
        }
    }
    fn release(&self, i: usize) {
        self.free.lock().unwrap().push(i);
        self.cv.notify_one();
    }
}

fn main() -> anyhow::Result<()> {
    let port: u16 = std::env::var("PROVER_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8790);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let jobs: usize = std::env::var("PROVER_JOBS").ok().and_then(|s| s.parse().ok()).unwrap_or((cores / 2).max(1));
    let threads: usize = std::env::var("PROVER_THREADS").ok().and_then(|s| s.parse().ok()).unwrap_or((cores / jobs).max(1));
    let pools: Arc<Vec<rayon::ThreadPool>> = Arc::new(
        (0..jobs)
            .map(|_| rayon::ThreadPoolBuilder::new().num_threads(threads).build())
            .collect::<Result<_, _>>()?,
    );
    let origins: Vec<String> = std::env::var("PROVER_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:5174,http://127.0.0.1:5174,http://localhost:5173".into())
        .split(',')
        .map(|s| s.trim().to_string())
        .collect();

    let token = std::env::var("PROVER_TOKEN").unwrap_or_else(|_| {
        let mut b = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut b);
        hex::encode(b)
    });
    let t = Instant::now();
    let app = concat!(env!("CARGO_MANIFEST_DIR"), "/../../payroll/public");
    let zkey = std::env::var("PROVER_ZKEY").unwrap_or_else(|_| format!("{app}/circuit/transaction2.zkey"));
    let graph = std::env::var("PROVER_GRAPH").unwrap_or_else(|_| format!("{app}/prover-wasm/transaction2.graph"));
    let prover = Arc::new(Prover::new(&std::fs::read(&zkey)?, &std::fs::read(&graph)?)?);
    let slots = Arc::new(Slots { free: Mutex::new((0..jobs).collect()), cv: Condvar::new() });
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    eprintln!(
        "prover-server on 127.0.0.1:{port}: {jobs} concurrent proofs x {threads} threads ({cores} cores), loaded in {} ms",
        t.elapsed().as_millis()
    );
    eprintln!("pairing token: {token}   (paste into the app: ?proverToken={token})");
    for conn in listener.incoming() {
        let Ok(conn) = conn else { continue };
        let (prover, slots, origins, pools) = (prover.clone(), slots.clone(), origins.clone(), pools.clone());
        let token = token.clone();
        std::thread::spawn(move || {
            if let Err(e) = handle(conn, &prover, &slots, &pools, &origins, jobs, &token) {
                eprintln!("request failed: {e:#}");
            }
        });
    }
    Ok(())
}

fn handle(
    mut conn: TcpStream,
    prover: &Prover,
    slots: &Slots,
    pools: &[rayon::ThreadPool],
    origins: &[String],
    jobs: usize,
    token: &str,
) -> anyhow::Result<()> {
    let mut reader = BufReader::new(conn.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let (mut len, mut origin) = (0usize, String::new());
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" {
            break;
        }
        let lower = h.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        } else if lower.starts_with("origin:") {
            origin = h[7..].trim().to_string();
        }
    }
    let allowed = origins.iter().any(|o| o == "*" || *o == origin);
    let cors = if allowed && !origin.is_empty() {
        format!(
            "Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\n\
             Access-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Private-Network: true\r\n\
             Cross-Origin-Resource-Policy: cross-origin\r\nVary: Origin\r\n"
        )
    } else {
        String::new()
    };
    let reply = |conn: &mut TcpStream, status: &str, body: &str| -> std::io::Result<()> {
        write!(
            conn,
            "HTTP/1.1 {status}\r\n{cors}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    };
    if !origin.is_empty() && !allowed {
        return Ok(reply(&mut conn, "403 Forbidden", r#"{"error":"origin not allowed"}"#)?);
    }
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    match (method, route) {
        ("OPTIONS", _) => reply(&mut conn, "204 No Content", "")?,
        ("GET", "/health") => {
            let nonce = query.split('&').find_map(|kv| kv.strip_prefix("nonce=")).unwrap_or("");
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes())?;
            mac.update(nonce.as_bytes());
            let mac = hex::encode(mac.finalize().into_bytes());
            reply(&mut conn, "200 OK", &format!(r#"{{"ok":true,"jobs":{jobs},"mac":"{mac}"}}"#))?
        }
        ("POST", "/prove") => {

            if len > 1 << 20 {
                return Ok(reply(&mut conn, "413 Payload Too Large", r#"{"error":"input too large"}"#)?);
            }
            let mut body = vec![0u8; len];
            reader.read_exact(&mut body)?;
            let Some(input) = decrypt_input(&body, token) else {
                return Ok(reply(&mut conn, "401 Unauthorized", r#"{"error":"not paired: input did not decrypt"}"#)?);
            };
            let slot = slots.acquire();
            let t = Instant::now();
            let out = pools[slot].install(|| prover.prove_json(&input));
            slots.release(slot);
            match out.and_then(|r| Ok(serde_json::to_string(&r)?)) {
                Ok(json) => {
                    eprintln!("proved in {} ms", t.elapsed().as_millis());
                    reply(&mut conn, "200 OK", &json)?
                }
                Err(e) => reply(&mut conn, "422 Unprocessable Entity", &serde_json::json!({ "error": format!("{e:#}") }).to_string())?,
            }
        }
        _ => reply(&mut conn, "404 Not Found", r#"{"error":"not found"}"#)?,
    }
    Ok(())
}

/// `{"iv":hex12,"ct":hex}` sealed with AES-256-GCM under
/// SHA-256("charon-prover-v1:" + token) -> the circuit-input JSON.
fn decrypt_input(body: &[u8], token: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let iv = hex::decode(v.get("iv")?.as_str()?).ok()?;
    let ct = hex::decode(v.get("ct")?.as_str()?).ok()?;
    if iv.len() != 12 {
        return None;
    }
    let key = Sha256::digest(format!("charon-prover-v1:{token}").as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let plain = cipher.decrypt(Nonce::from_slice(&iv), ct.as_ref()).ok()?;
    String::from_utf8(plain).ok()
}
