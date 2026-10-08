//! Fixed-window rate limiting, per caller and in aggregate.
//!
//! Relaying costs real lamports, so the cheapest possible rejection matters. This
//! runs before any RPC work or hashing: a flood costs us a hash-map lookup.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::relayer::error::{ErrorCode, RelayerError, RelayerResult};

const WINDOW: Duration = Duration::from_secs(60);
/// Forget idle callers so the map cannot grow without bound from spoofed traffic.
const SWEEP_AFTER: Duration = Duration::from_secs(600);

struct Window {
    count: u32,
    started: Instant,
    last_seen: Instant,
}

impl Window {
    fn new(now: Instant) -> Self {
        Self {
            count: 0,
            started: now,
            last_seen: now,
        }
    }

    fn hit(&mut self, now: Instant, limit: u32) -> bool {
        if now.duration_since(self.started) >= WINDOW {
            self.count = 0;
            self.started = now;
        }
        self.last_seen = now;
        if self.count >= limit {
            return false;
        }
        self.count += 1;
        true
    }
}

pub struct RateLimiter {
    per_ip_limit: u32,
    global_limit: u32,
    inner: Mutex<Inner>,
}

struct Inner {
    per_ip: HashMap<IpAddr, Window>,
    global: Window,
    last_sweep: Instant,
}

impl RateLimiter {
    pub fn new(per_ip_limit: u32, global_limit: u32) -> Self {
        let now = Instant::now();
        Self {
            per_ip_limit,
            global_limit,
            inner: Mutex::new(Inner {
                per_ip: HashMap::new(),
                global: Window::new(now),
                last_sweep: now,
            }),
        }
    }

    pub fn check(&self, ip: Option<IpAddr>) -> RelayerResult<()> {
        let now = Instant::now();
        let mut inner = self.inner.lock().unwrap();

        if now.duration_since(inner.last_sweep) >= SWEEP_AFTER {
            inner
                .per_ip
                .retain(|_, w| now.duration_since(w.last_seen) < SWEEP_AFTER);
            inner.last_sweep = now;
        }

        if !inner.global.hit(now, self.global_limit) {
            return Err(RelayerError::new(
                ErrorCode::RateLimited,
                "relayer is at its global request limit; retry shortly",
            ));
        }

        if let Some(ip) = ip {
            let window = inner.per_ip.entry(ip).or_insert_with(|| Window::new(now));
            if !window.hit(now, self.per_ip_limit) {
                return Err(RelayerError::new(
                    ErrorCode::RateLimited,
                    "too many requests from this address; retry shortly",
                ));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_ip_limit_is_enforced_independently() {
        let limiter = RateLimiter::new(2, 100);
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        let b: IpAddr = "10.0.0.2".parse().unwrap();

        assert!(limiter.check(Some(a)).is_ok());
        assert!(limiter.check(Some(a)).is_ok());
        assert!(limiter.check(Some(a)).is_err(), "third hit exceeds the cap");
        assert!(limiter.check(Some(b)).is_ok(), "other callers unaffected");
    }

    #[test]
    fn global_limit_applies_across_callers() {
        let limiter = RateLimiter::new(100, 2);
        assert!(limiter.check(Some("10.0.0.1".parse().unwrap())).is_ok());
        assert!(limiter.check(Some("10.0.0.2".parse().unwrap())).is_ok());
        assert!(limiter.check(Some("10.0.0.3".parse().unwrap())).is_err());
    }
}
