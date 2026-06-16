//! The revenue sink: durable persistence of every redeemed gate/play proof.
//!
//! Gate POSTs and paid plays drop their `fresh_proofs` on the floor today (the
//! handler reads `Extension<Redeemed>` for the amount only). That is lost
//! money: each `fresh_proofs` value is a spendable `cashuB…` bearer token the
//! operator now controls. This module appends ONE JSONL line per redemption to
//! `BAZAAR_REVENUE_SINK` and `flush()` + `sync_all()`s it to disk BEFORE the
//! handler grants the entitlement / returns the play result; a crash between
//! "grant" and "persist" would consume a pop with no record of the value.
//!
//! This is the bazaar's cousin of pops' own `pops-gateway::proofs_sink` (the
//! `skills/gate-a-service.md` "the sink is a WALLET" rule). The record shape is
//! the bazaar's: `{ts, gate, session, amount, unit, proofs}`. `gate` and
//! `session` name WHICH gate/play and WHOSE request earned it; `proofs` carries
//! the denormalized redeemed-proofs payload (the spendable bearer token plus
//! its keyset id and the presented token's receipt hash).
//!
//! SECURITY: the sink file is a WALLET. `proofs.fresh_proofs` is spendable
//! value; never log it, restrict file access, back the file up (losing it loses
//! the money). The record is the only place the value is kept.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use pops_core_verify::redeemer::Redeemed;
use serde::Serialize;

/// The denormalized redeemed-proofs payload as it lands in the sink line.
/// Mirrors `pops_core_verify::charge::RedeemedProofs` but owns its strings so
/// the record serializes without borrowing across the lock.
#[derive(Debug, Serialize)]
pub struct ProofsRecord {
    /// The fresh bearer proofs as a `cashuB…` token string. SPENDABLE VALUE:
    /// this is the operator's money; never log it or share it.
    pub fresh_proofs: String,
    /// Net value received: at least the gate/play price (excess presented value
    /// is retained by the verifier, so this MAY exceed the price).
    pub amount: u64,
    /// Unit of the redeemed value (`pop_<ts>`).
    pub unit: String,
    /// Keyset id (hex) the fresh proofs are signed under (for spending without
    /// re-fetching keysets, and for audit).
    pub active_keyset_id: String,
    /// SHA-256 (lowercase hex) of the EXACT presented `payload.token`:
    /// a stable, shareable settlement reference that exposes no secret.
    pub token_hash: String,
}

/// One persisted revenue record. `ts` is Unix seconds at persist time; `gate`
/// names the gate or play (e.g. `"spawn"`, `"court.jade"`, `"play.gacha"`);
/// `session` is the ws session that earned it; `amount`/`unit` echo the
/// validated value; `proofs` is the denormalized bearer payload.
#[derive(Debug, Serialize)]
pub struct RevenueRecord<'a> {
    /// Unix-seconds timestamp when the proofs were persisted.
    pub ts: u64,
    /// Which gate or play earned this value.
    pub gate: &'a str,
    /// The ws session that paid.
    pub session: &'a str,
    /// Net value received (>= the price).
    pub amount: u64,
    /// Unit of the redeemed value (`pop_<ts>`).
    pub unit: &'a str,
    /// The denormalized redeemed-proofs payload (spendable bearer value).
    pub proofs: ProofsRecord,
}

/// A failure to durably persist revenue. The caller treats this as
/// fatal-for-this-request (it must NOT grant the entitlement / return a
/// success) and emits the lost `token_hash` (never the proofs) as a last resort.
#[derive(Debug)]
pub struct SinkError {
    pub message: String,
}

impl std::fmt::Display for SinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "failed to persist revenue: {}", self.message)
    }
}

impl std::error::Error for SinkError {}

/// Append-only, fsync-on-every-write durable revenue sink.
///
/// Holds the open file under a [`Mutex`] so concurrent gated requests serialize
/// their appends (each line atomic, no interleaving). `append(true)` positions
/// every write at EOF.
#[derive(Debug)]
pub struct RevenueSink {
    path: PathBuf,
    file: Mutex<File>,
}

impl RevenueSink {
    /// Open (creating if absent) `path` for append. Fails loudly if the file
    /// cannot be opened; a sink we cannot write to means we would silently
    /// drop money, so the server must refuse to take payments without it.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, SinkError> {
        let path = path.into();
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| SinkError {
                message: format!("open {path:?} for append: {e}"),
            })?;
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Durably append one revenue record built from `redeemed`, then `flush` +
    /// `sync_all` so the value is on stable storage BEFORE the caller grants
    /// the entitlement or returns the play result.
    ///
    /// Returns `Ok(())` only once the bytes are fsynced.
    pub fn record(&self, gate: &str, session: &str, redeemed: &Redeemed) -> Result<(), SinkError> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let record = RevenueRecord {
            ts,
            gate,
            session,
            amount: redeemed.amount,
            unit: &redeemed.unit,
            proofs: ProofsRecord {
                fresh_proofs: redeemed.proofs.fresh_proofs.clone(),
                amount: redeemed.proofs.amount,
                unit: redeemed.proofs.unit.clone(),
                active_keyset_id: redeemed.proofs.active_keyset_id.clone(),
                token_hash: redeemed.proofs.token_hash.clone(),
            },
        };

        let mut line = serde_json::to_string(&record).map_err(|e| SinkError {
            message: format!("serialize record: {e}"),
        })?;
        line.push('\n');

        // One lock spans write -> flush -> fsync so a record is fully durable
        // before another request's append begins.
        let mut guard = self.file.lock().map_err(|_| SinkError {
            message: "revenue sink mutex poisoned".to_string(),
        })?;
        guard.write_all(line.as_bytes()).map_err(|e| SinkError {
            message: format!("write record: {e}"),
        })?;
        guard.flush().map_err(|e| SinkError {
            message: format!("flush record: {e}"),
        })?;
        guard.sync_all().map_err(|e| SinkError {
            message: format!("fsync record: {e}"),
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pops_core_verify::charge::RedeemedProofs;
    use std::io::Read;

    fn sample_redeemed(amount: u64) -> Redeemed {
        Redeemed {
            unit: "pop_1781713156".to_string(),
            amount,
            proofs: RedeemedProofs {
                fresh_proofs: "cashuBdeadbeef".to_string(),
                amount,
                unit: "pop_1781713156".to_string(),
                active_keyset_id: "0114c426".to_string(),
                token_hash: "a".repeat(64),
            },
            dleq_ok: true,
        }
    }

    #[test]
    fn record_appends_one_jsonl_line_with_the_bazaar_shape() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("revenue.jsonl");
        let sink = RevenueSink::open(&path).unwrap();

        sink.record("court.jade", "sess-1", &sample_redeemed(50))
            .unwrap();

        let mut contents = String::new();
        File::open(&path)
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 1, "exactly one record line");

        let v: serde_json::Value = serde_json::from_str(lines[0]).expect("valid JSON line");
        assert!(v["ts"].is_number());
        assert_eq!(v["gate"], "court.jade");
        assert_eq!(v["session"], "sess-1");
        assert_eq!(v["amount"], 50);
        assert_eq!(v["unit"], "pop_1781713156");
        // The denormalized proofs payload rides under `proofs`.
        assert_eq!(v["proofs"]["fresh_proofs"], "cashuBdeadbeef");
        assert_eq!(v["proofs"]["amount"], 50);
        assert_eq!(v["proofs"]["unit"], "pop_1781713156");
        assert_eq!(v["proofs"]["active_keyset_id"], "0114c426");
        assert_eq!(v["proofs"]["token_hash"], "a".repeat(64));
    }

    #[test]
    fn record_appends_not_truncates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("revenue.jsonl");
        let sink = RevenueSink::open(&path).unwrap();

        sink.record("spawn", "s", &sample_redeemed(10)).unwrap();
        sink.record("play.gacha", "s", &sample_redeemed(5)).unwrap();

        let mut contents = String::new();
        File::open(&path)
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2, "appends accumulate");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[1]).unwrap()["gate"],
            "play.gacha"
        );
    }

    #[test]
    fn record_survives_a_reopen_appending_after_existing_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("revenue.jsonl");
        {
            let sink = RevenueSink::open(&path).unwrap();
            sink.record("spawn", "s", &sample_redeemed(10)).unwrap();
        }
        // A fresh sink over the same path appends, never clobbers.
        let sink2 = RevenueSink::open(&path).unwrap();
        sink2.record("spawn", "s", &sample_redeemed(10)).unwrap();
        let mut contents = String::new();
        File::open(&path)
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert_eq!(contents.lines().count(), 2);
    }

    #[test]
    fn open_fails_on_nonexistent_parent() {
        let err = RevenueSink::open("/no/such/dir/x/revenue.jsonl")
            .expect_err("must fail on missing parent");
        assert!(err.to_string().contains("open"));
    }
}
