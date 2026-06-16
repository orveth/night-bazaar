//! Mint probe: read the SET of currently-valid `pop_<ts>` units from
//! `GET <mint>/v1/keysets`.
//!
//! Units rotate (CLTV-dated) and rotations OVERLAP: a new `pop_<ts>` unit
//! appears while the prior is still inside its credit window, so at any moment
//! more than one unit may legitimately swap. The server therefore tracks the
//! whole VALID SET, not a single unit:
//!
//!   * A keyset's unit is VALID iff its `final_expiry` is in the future. The
//!     `active` flag is NOT used: it lies. The mint keeps the just-retired
//!     keyset `active:true` until its `final_expiry` passes, and freshly minted
//!     keysets can read `active:false` (cdk-pop regenerates the active keyset on
//!     every restart). Selecting by `active` would gate on a DEAD unit. (Ground
//!     truth observed on the dev rig 2026-06-10: `pop_<old>` `active:true` with
//!     a past `final_expiry`, the live unit split across `active:true` and
//!     `active:false` keysets.)
//!   * The NEWEST unit (latest `final_expiry`) is the one a FRESH player should
//!     acquire; `/api/config` advertises it as the mint-into unit.
//!   * A held token in any unit still in the set passes; a unit whose
//!     `final_expiry` has passed drops out and its tokens are rejected (the
//!     player is told to mint the current unit).
//!
//! Refreshed periodically (the binary spawns a re-probe loop), so a unit enters
//! the set on rotation and drops the moment its `final_expiry` passes.

use anyhow::{anyhow, Context};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::time::Duration;

#[derive(Debug, Deserialize)]
struct KeysetsResponse {
    keysets: Vec<KeysetInfo>,
}

#[derive(Debug, Deserialize)]
struct KeysetInfo {
    #[allow(dead_code)]
    id: String,
    unit: String,
    #[allow(dead_code)]
    active: bool,
    #[serde(default)]
    final_expiry: Option<u64>,
}

/// One valid unit + the latest future `final_expiry` of any keyset carrying it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitInfo {
    pub unit: String,
    /// The unit's latest FUTURE keyset `final_expiry` (Unix seconds). Always
    /// `Some` for a unit in the valid set (a unit needs a future dated keyset to
    /// be valid at all; see [`pick_valid_units`]); the `Option` is kept so test
    /// fixtures and the type read naturally.
    pub final_expiry: Option<u64>,
}

/// The currently-valid `pop_<ts>` units and which one a fresh player mints into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidUnits {
    /// Every valid unit (each has a future `final_expiry`), sorted by
    /// `final_expiry` ascending (the soonest-to-die first).
    pub units: Vec<UnitInfo>,
    /// The unit a fresh player should acquire: the latest `final_expiry`.
    pub newest: String,
}

impl ValidUnits {
    /// The bare unit strings, for the `/api/config` accepted-units list.
    pub fn unit_strings(&self) -> Vec<String> {
        self.units.iter().map(|u| u.unit.clone()).collect()
    }

    /// Is `unit` currently accepted?
    pub fn contains(&self, unit: &str) -> bool {
        self.units.iter().any(|u| u.unit == unit)
    }
}

/// Pick the valid-unit set from a list of `(unit, final_expiry)` keyset rows,
/// judged against `now` (Unix seconds). Pure (no I/O) so it is unit-tested
/// directly.
///
/// Rules (matching the contract: "units whose `final_expiry` is in the FUTURE"):
///   * Only `pop_*` units are considered.
///   * A unit is VALID iff it has at least one keyset with a `final_expiry`
///     STRICTLY in the future. A keyset with NO `final_expiry` does NOT make a
///     unit valid: a `pop_<ts>` unit is inherently CLTV-dated, and the live
///     cdk-pop mint keeps serving an UNDATED keyset for a unit whose dated
///     keyset has already retired (observed on the dev rig: `pop_1781127717`
///     carries both a past-dated keyset AND an undated one, yet its tokens stop
///     swapping at the dated `final_expiry`). Treating undated as "valid
///     forever" would resurrect a dead unit, so undated keysets are ignored for
///     validity.
///   * Each valid unit carries the LATEST future `final_expiry` seen for it.
///   * `newest` is the unit with the latest `final_expiry` (the mint-into one).
///   * The `active` flag is deliberately ignored (it lies: a retired keyset
///     reads `active:true`; a live one can read `active:false`).
fn pick_valid_units(rows: &[(String, Option<u64>)], now: u64) -> Option<ValidUnits> {
    // Per unit, the latest FUTURE dated expiry (undated keysets contribute
    // nothing). A unit with no future dated keyset never enters the map.
    let mut best: BTreeMap<String, u64> = BTreeMap::new();
    for (unit, fe) in rows {
        if !unit.starts_with("pop_") {
            continue;
        }
        let Some(ts) = fe else { continue }; // undated → ignored for validity
        if *ts <= now {
            continue; // past → dead
        }
        best.entry(unit.clone())
            .and_modify(|cur| *cur = (*cur).max(*ts))
            .or_insert(*ts);
    }

    if best.is_empty() {
        return None;
    }

    // Soonest-to-die first.
    let mut units: Vec<UnitInfo> = best
        .into_iter()
        .map(|(unit, ts)| UnitInfo {
            unit,
            final_expiry: Some(ts),
        })
        .collect();
    units.sort_by_key(|u| u.final_expiry.unwrap_or(0));

    // Newest = the latest future expiry (last after the ascending sort).
    let newest = units
        .last()
        .expect("non-empty checked above")
        .unit
        .clone();

    Some(ValidUnits { units, newest })
}

/// Current wall-clock Unix seconds.
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Fetch `/v1/keysets` and compute the currently-valid `pop_<ts>` unit set.
/// Errors if the mint advertises NO valid `pop_<ts>` unit (the rig has not been
/// re-registered after a full rotation, or is unreachable).
pub async fn fetch_valid_pop_units(
    mint_url: &str,
    timeout: Duration,
) -> anyhow::Result<ValidUnits> {
    let url = format!("{}/v1/keysets", mint_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .context("building mint http client")?;
    let resp = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("GET {url}"))?;
    let body: KeysetsResponse = resp.json().await.context("parsing /v1/keysets")?;

    let rows: Vec<(String, Option<u64>)> = body
        .keysets
        .into_iter()
        .map(|k| (k.unit, k.final_expiry))
        .collect();

    pick_valid_units(&rows, now_unix()).ok_or_else(|| {
        anyhow!(
            "mint at {mint_url} advertises no VALID pop_<ts> keyset \
             (every pop unit's final_expiry has passed; has the rig been \
             re-registered with a fresh unit?)"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_781_700_000;

    fn row(unit: &str, fe: Option<u64>) -> (String, Option<u64>) {
        (unit.to_string(), fe)
    }

    #[test]
    fn ignores_active_flag_picks_by_future_expiry_real_devrig_shape() {
        // EXACTLY the dev-rig `/v1/keysets` shape observed live (active flags in
        // comments to make the trap explicit; the picker never reads them). The
        // retired unit pop_1781127717 carries an `active:true` keyset with a
        // PAST `final_expiry` AND a bare UNDATED keyset; the live unit
        // pop_1781713156 is split across future-dated keysets (one active:true,
        // one active:false) and an undated one. Ground truth (STATE.md): the
        // retired unit's tokens stop swapping at its past final_expiry, so it
        // MUST drop even though it still has a served (undated) keyset.
        let rows = vec![
            row("pop_1781127717", Some(1_781_120_517)), // active:true,  PAST expiry -> dead
            row("pop_1781713156", None),                // active:false, undated (ignored)
            row("pop_1781127717", None),                // active:false, undated (must NOT rescue)
            row("pop_1781713156", Some(1_781_705_956)), // active:false, future expiry
            row("pop_1781713156", Some(1_781_705_956)), // active:true,  future expiry
        ];
        let v = pick_valid_units(&rows, NOW).expect("a valid set");
        assert_eq!(
            v.unit_strings(),
            vec!["pop_1781713156".to_string()],
            "only the future-dated unit survives; the retired unit drops despite its undated keyset"
        );
        assert!(
            !v.contains("pop_1781127717"),
            "a unit with only a past dated keyset (+ an undated one) is DEAD"
        );
        assert_eq!(v.newest, "pop_1781713156");
    }

    #[test]
    fn dead_unit_dated_past_drops_live_unit_future_stays() {
        // Clean fixture: dead unit ONLY has a past dated keyset; live unit has
        // a future dated keyset. No no-expiry confusion.
        let rows = vec![
            row("pop_1781127717", Some(1_781_120_517)), // past → dead, drops
            row("pop_1781713156", Some(1_781_705_956)), // future → valid
        ];
        let v = pick_valid_units(&rows, NOW).expect("a valid set");
        assert_eq!(v.unit_strings(), vec!["pop_1781713156".to_string()]);
        assert_eq!(v.newest, "pop_1781713156");
        assert!(!v.contains("pop_1781127717"), "the dead unit must drop");
    }

    #[test]
    fn overlap_keeps_both_and_newest_is_latest_expiry() {
        // Rotation overlap: the prior unit is still inside its credit window
        // (future expiry) AND a newer unit exists with a later expiry. Both are
        // accepted; the later-expiry one is `newest`.
        let rows = vec![
            row("pop_1781713156", Some(1_781_705_956)), // valid, earlier
            row("pop_1782300000", Some(1_782_290_000)), // valid, later → newest
        ];
        let v = pick_valid_units(&rows, NOW).expect("a valid set");
        assert_eq!(
            v.unit_strings(),
            vec!["pop_1781713156".to_string(), "pop_1782300000".to_string()],
            "soonest-to-die first"
        );
        assert_eq!(v.newest, "pop_1782300000", "newest = latest final_expiry");
        assert!(v.contains("pop_1781713156"), "the older-but-valid unit stays");
    }

    #[test]
    fn picks_latest_expiry_per_unit_across_keysets() {
        // A unit advertised by two keysets with different expiries carries the
        // LATEST of them (a fresh keyset extends the unit's life).
        let rows = vec![
            row("pop_1782300000", Some(1_782_100_000)),
            row("pop_1782300000", Some(1_782_290_000)), // later → wins
        ];
        let v = pick_valid_units(&rows, NOW).expect("valid");
        assert_eq!(v.units.len(), 1);
        assert_eq!(v.units[0].final_expiry, Some(1_782_290_000));
    }

    #[test]
    fn all_expired_yields_none() {
        let rows = vec![
            row("pop_1781127717", Some(1_781_120_517)),
            row("pop_1781000000", Some(1_781_000_001)),
        ];
        assert!(
            pick_valid_units(&rows, NOW).is_none(),
            "no future unit → no valid set"
        );
    }

    #[test]
    fn non_pop_units_ignored() {
        let rows = vec![
            row("sat", Some(9_999_999_999)),
            row("usd", None),
            row("pop_1782300000", Some(1_782_290_000)),
        ];
        let v = pick_valid_units(&rows, NOW).expect("valid");
        assert_eq!(v.unit_strings(), vec!["pop_1782300000".to_string()]);
        assert_eq!(v.newest, "pop_1782300000");
    }

    #[test]
    fn undated_keyset_does_not_make_a_unit_valid() {
        // A `pop_<ts>` unit advertised ONLY by an undated keyset is NOT valid:
        // a pop unit is inherently CLTV-dated, and the live mint serves undated
        // keysets for retired units. Only the future-DATED unit survives.
        let rows = vec![
            row("pop_1782300000", Some(1_782_290_000)), // future-dated → valid
            row("pop_1782999999", None),                // undated only → NOT valid
        ];
        let v = pick_valid_units(&rows, NOW).expect("valid");
        assert_eq!(v.unit_strings(), vec!["pop_1782300000".to_string()]);
        assert!(!v.contains("pop_1782999999"), "an undated-only unit is not valid");
        assert_eq!(v.newest, "pop_1782300000");
    }

    #[test]
    fn all_undated_yields_none() {
        // If EVERY pop keyset is undated (no dated future expiry anywhere),
        // there is no valid set.
        let rows = vec![row("pop_1782300000", None), row("pop_1782999999", None)];
        assert!(pick_valid_units(&rows, NOW).is_none());
    }

    #[test]
    fn expiry_exactly_now_is_not_valid() {
        // `final_expiry > now` is strict: a keyset expiring exactly at `now` is
        // already dead.
        let rows = vec![row("pop_1781700000", Some(NOW))];
        assert!(pick_valid_units(&rows, NOW).is_none());
        // one second later is fine
        let rows2 = vec![row("pop_1781700001", Some(NOW + 1))];
        assert!(pick_valid_units(&rows2, NOW).is_some());
    }
}
