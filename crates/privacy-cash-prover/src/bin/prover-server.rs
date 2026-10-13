//! Local native prover helper: the browser app POSTs circuit-input JSON (the
//! exact string the wasm prover takes) to http://127.0.0.1:PORT/prove and gets
//! the same compressed proof JSON back — natively, ~3x faster per core than
//! wasm. Runs on the employer's own machine, so the witness never leaves it.
//!
//!   cargo run --release --bin prover-server
//!   env: PROVER_ZKEY / PROVER_GRAPH (default: the payroll app's public/ copies),
//!        PROVER_PORT (8790), PROVER_JOBS (concurrent proofs, default cores/2),
//!        PROVER_ORIGINS (comma list of allowed page origins, default local dev)
//!
//! Std-only HTTP/1.1 (one request per connection), bound to loopback.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use privacy_cash_prover::Prover;

struct Slots {
    free: Mutex<usize>,
    cv: Condvar,
}

impl Slots {
    fn acquire(&self) {
        let mut free = self.free.lock().unwrap();
        while *free == 0 {
            free = self.cv.wait(free).unwrap();
        }
        *free -= 1;
    }
    fn release(&self) {
        *self.free.lock().unwrap() += 1;
        self.cv.notify_one();
    }
}

fn main() -> anyhow::Result<()> {
    let port: u16 = std::env::var("PROVER_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8790);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let jobs: usize = std::env::var("PROVER_JOBS").ok().and_then(|s| s.parse().ok()).unwrap_or((cores / 2).max(1));
    let origins: Vec<String> = std::env::var("PROVER_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:5174,http://127.0.0.1:5174,http://localhost:5173".into())
        .split(',')
        .map(|s| s.trim().to_string())
        .collect();

    let t = Instant::now();
    let app = concat!(env!("CARGO_MANIFEST_DIR"), "/../../payroll/public");
    let zkey = std::env::var("PROVER_ZKEY").unwrap_or_else(|_| format!("{app}/circuit/transaction2.zkey"));
    let graph = std::env::var("PROVER_GRAPH").unwrap_or_else(|_| format!("{app}/prover-wasm/transaction2.graph"));
    let prover = Arc::new(Prover::new(&std::fs::read(&zkey)?, &std::fs::read(&graph)?)?);
    let slots = Arc::new(Slots { free: Mutex::new(jobs), cv: Condvar::new() });
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    eprintln!(
        "prover-server on 127.0.0.1:{port}: {jobs} concurrent proofs over {cores} cores, loaded in {} ms",
        t.elapsed().as_millis()
    );
    for conn in listener.incoming() {
        let Ok(conn) = conn else { continue };
        let (prover, slots, origins) = (prover.clone(), slots.clone(), origins.clone());
        let health = format!(r#"{{"ok":true,"jobs":{jobs}}}"#);
        std::thread::spawn(move || {
            if let Err(e) = handle(conn, &prover, &slots, &origins, &health) {
                eprintln!("request failed: {e:#}");
            }
        });
    }
    Ok(())
}

fn handle(mut conn: TcpStream, prover: &Prover, slots: &Slots, origins: &[String], health: &str) -> anyhow::Result<()> {
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
    match (method, path) {
        ("OPTIONS", _) => reply(&mut conn, "204 No Content", "")?,
        ("GET", "/health") => reply(&mut conn, "200 OK", health)?,
        ("POST", "/prove") => {
            if len > 1 << 20 {
                return Ok(reply(&mut conn, "413 Payload Too Large", r#"{"error":"input too large"}"#)?);
            }
            let mut body = vec![0u8; len];
            reader.read_exact(&mut body)?;
            slots.acquire();
            let t = Instant::now();
            let out = prover.prove_json(std::str::from_utf8(&body)?);
            slots.release();
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
