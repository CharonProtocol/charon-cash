use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::relayer::chain::{fetch_fee_rates, FeeRates};
use crate::relayer::config::RelayerConfig;
use crate::relayer::error::{ErrorCode, RelayerError, RelayerResult};
use crate::relayer::ratelimit::RateLimiter;
use crate::relayer::rpc::RpcClient;

const FEE_RATE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct RelayerState {
    pub config: Arc<RelayerConfig>,
    pub rpc: Arc<RpcClient>,
    pub limiter: Arc<RateLimiter>,
    pub metrics: Arc<Metrics>,
    in_flight: Arc<Mutex<HashSet<[u8; 32]>>>,
    fee_rates: Arc<Mutex<Option<(FeeRates, Instant)>>>,
}

impl RelayerState {
    pub fn new(config: RelayerConfig) -> Self {
        let rpc = RpcClient::new(config.rpc_url.clone());
        let limiter = RateLimiter::new(
            config.rate_limit_per_ip_per_min,
            config.rate_limit_global_per_min,
        );
        Self {
            config: Arc::new(config),
            rpc: Arc::new(rpc),
            limiter: Arc::new(limiter),
            metrics: Arc::new(Metrics::default()),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
            fee_rates: Arc::new(Mutex::new(None)),
        }
    }

    /// Fee rates from the `global_config` PDA, cached for a minute. Rates change
    /// only by an operator instruction, so a stale minute is harmless, and this
    /// keeps `/api/relayer/info` off the RPC hot path.
    pub async fn fee_rates(&self) -> RelayerResult<FeeRates> {
        if let Some((rates, fetched_at)) = *self.fee_rates.lock().unwrap() {
            if fetched_at.elapsed() < FEE_RATE_TTL {
                return Ok(rates);
            }
        }
        let rates = fetch_fee_rates(&self.rpc, &self.config.program_id).await?;
        *self.fee_rates.lock().unwrap() = Some((rates, Instant::now()));
        Ok(rates)
    }

    /// Claim both nullifiers for the duration of a relay attempt.
    ///
    /// Without this, two concurrent requests spending the same note would both pass
    /// the spent check, we would sign and pay for both, and exactly one would land.
    /// The guard releases on drop, so an early return or a panic cannot leak a claim.
    pub fn claim_nullifiers(&self, nullifiers: [[u8; 32]; 2]) -> RelayerResult<InFlightGuard> {
        let mut set = self.in_flight.lock().unwrap();
        if nullifiers.iter().any(|n| set.contains(n)) {
            return Err(RelayerError::new(
                ErrorCode::NullifierInFlight,
                "a transaction spending one of these notes is already being relayed; wait for it \
                 to settle before retrying",
            ));
        }
        for n in &nullifiers {
            set.insert(*n);
        }
        Ok(InFlightGuard {
            set: self.in_flight.clone(),
            nullifiers,
        })
    }
}

/// Releases an in-flight nullifier claim when dropped.
pub struct InFlightGuard {
    set: Arc<Mutex<HashSet<[u8; 32]>>>,
    nullifiers: [[u8; 32]; 2],
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.set.lock() {
            for n in &self.nullifiers {
                set.remove(n);
            }
        }
    }
}

/// Counters for the float. The signer fronts nullifier rent and is reimbursed the
/// fee in the same transaction, so `net_lamports` trending negative means traffic
/// is being relayed at a loss and the fee floor is mis-set.
#[derive(Default)]
pub struct Metrics {
    pub relayed: AtomicU64,
    pub refused: AtomicU64,
    pub failed: AtomicU64,
    pub net_lamports: AtomicI64,
    pub rent_paid_lamports: AtomicU64,
    pub fees_earned_lamports: AtomicU64,
}

impl Metrics {
    pub fn record_relayed(&self, fee: u64, rent: u64, tx_fee: u64) {
        self.relayed.fetch_add(1, Ordering::Relaxed);
        self.fees_earned_lamports.fetch_add(fee, Ordering::Relaxed);
        self.rent_paid_lamports.fetch_add(rent, Ordering::Relaxed);
        let net = fee as i64 - rent as i64 - tx_fee as i64;
        self.net_lamports.fetch_add(net, Ordering::Relaxed);
    }

    pub fn record_refused(&self) {
        self.refused.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_failed(&self) {
        self.failed.fetch_add(1, Ordering::Relaxed);
    }
}
