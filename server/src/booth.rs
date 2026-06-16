//! Booth game logic: the PURE, deterministic core (no clock, no randomness).
//!
//! The three booths are server-authoritative minigames:
//!   - the riddle lantern (free, jade court): a fixed server-held set; a correct
//!     answer wins a prize and rotates the riddle. Answer matching is
//!     normalized (case/whitespace/punctuation-insensitive) with a small set of
//!     accepted spellings per riddle.
//!   - the gacha shrine (paid, crimson court): a DETERMINISTIC every-Nth-wins
//!     counter. No randomness (auditable, dodges the gambling vibe). The
//!     fortune line is chosen by the same counter.
//!   - the timing bell (paid, street): the pure part is the OFFSET-to-verdict
//!     judgement; the clock lives in `game.rs`. The pendulum swings with period
//!     `period_ms`; the sweet spot is the bottom of the swing. The seed only
//!     drives the client's *visual* starting phase; the server judges against
//!     elapsed wall-time, so a scripted client cannot pre-compute a win the
//!     server clock would not allow.
//!
//! Everything here is a pure function of explicit inputs (counter, seed,
//! elapsed-ms) so it unit-tests without a clock and never calls `Date`/random.

/// The riddle set. Each is `(prompt, accepted-answers)`. Answers are matched
/// after `normalize_answer`, so list lowercase, space-free canonical forms.
pub const RIDDLES: &[(&str, &[&str])] = &[
    (
        "I speak without a mouth and hear without ears. I have nobody, but I come alive with wind. What am I?",
        &["echo", "anecho"],
    ),
    (
        "The more of me you take, the more you leave behind. What am I?",
        &["footsteps", "footprints", "steps"],
    ),
    (
        "I am full of holes yet still hold water. What am I?",
        &["sponge", "asponge"],
    ),
    (
        "What has keys but opens no locks, space but no room, and you can enter but not go in?",
        &["keyboard", "akeyboard"],
    ),
    (
        "I have cities but no houses, mountains but no trees, water but no fish. What am I?",
        &["map", "amap"],
    ),
    (
        "The more you take away from me, the bigger I become. What am I?",
        &["hole", "ahole", "pit"],
    ),
    (
        "I am always coming but never arrive. What am I?",
        &["tomorrow"],
    ),
    (
        "What can travel around the world while staying in a corner?",
        &["stamp", "astamp", "postagestamp"],
    ),
];

/// Number of riddles in the rotation.
pub fn riddle_count() -> usize {
    RIDDLES.len()
}

/// The prompt for the riddle at `index` (wraps modulo the set size).
pub fn riddle_prompt(index: usize) -> &'static str {
    RIDDLES[index % RIDDLES.len()].0
}

/// Normalize an answer for matching: lowercase, drop everything that is not an
/// ASCII letter or digit (so "An Echo!", "echo", " ECHO " all match "echo").
pub fn normalize_answer(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Is `guess` a correct answer to the riddle at `index`?
pub fn riddle_is_correct(index: usize, guess: &str) -> bool {
    let g = normalize_answer(guess);
    if g.is_empty() {
        return false;
    }
    RIDDLES[index % RIDDLES.len()]
        .1
        .iter()
        .any(|&accepted| accepted == g)
}

/// The gacha fortune lines, indexed by the play counter (cosmetic only).
pub const FORTUNES: &[&str] = &[
    "The lanterns flicker — patience, traveler.",
    "A coin not won is a coin not lost.",
    "The shrine remembers every visitor.",
    "Fortune favors the eighth knock.",
    "Steam rises; so will your luck.",
    "The cat statue blinks. Almost.",
    "Three more bells until the tide turns.",
    "The incense curls toward the prize.",
];

/// Outcome of one gacha pull.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GachaOutcome {
    /// True iff this pull wins (the deterministic every-Nth rule).
    pub win: bool,
    /// A cosmetic fortune line.
    pub fortune: &'static str,
    /// 1-based position within the current N-cycle (1..=N), for the client to
    /// render a "pulls until the next win" hint without leaking the counter.
    pub pity: u64,
}

/// Deterministic gacha: the `count`-th pull (1-based) wins iff `count` is a
/// multiple of `n`. No randomness: the counter alone decides, so the whole
/// payout schedule is auditable. `n == 0` is treated as "never wins" (guards
/// against a misconfigured `BAZAAR_GACHA_N=0`).
pub fn gacha_outcome(count: u64, n: u64) -> GachaOutcome {
    let win = n != 0 && count.is_multiple_of(n);
    let fortune = FORTUNES[(count as usize).wrapping_sub(1) % FORTUNES.len()];
    let pity = if n == 0 { count } else { ((count - 1) % n) + 1 };
    GachaOutcome { win, fortune, pity }
}

/// Bell timing: the absolute angular distance, in MILLISECONDS, between the
/// press at `elapsed_ms` after the play started and the nearest bottom-of-swing
/// sweet spot, for a pendulum of period `period_ms`.
///
/// The pendulum crosses the bottom twice per full period (a half-period apart),
/// so the player's job is to ring as the bob passes center. We fold `elapsed`
/// into the half-period and take the distance to the nearer edge (0 or
/// half-period), i.e. the smaller of `phase` and `half - phase`.
pub fn bell_offset_ms(elapsed_ms: u64, period_ms: u64) -> u64 {
    if period_ms == 0 {
        return 0;
    }
    let half = period_ms / 2;
    if half == 0 {
        return 0;
    }
    let phase = elapsed_ms % half;
    phase.min(half - phase)
}

/// Did the bell press at `elapsed_ms` land within `tolerance_ms` of a sweet
/// spot? A press before the play even started (elapsed 0 is allowed; the
/// caller rejects negative/expired) that lands on a crossing still counts;
/// the server clock is the only authority.
pub fn bell_is_hit(elapsed_ms: u64, period_ms: u64, tolerance_ms: u64) -> bool {
    bell_offset_ms(elapsed_ms, period_ms) <= tolerance_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_normalize_and_match() {
        assert_eq!(normalize_answer("  An Echo! "), "anecho");
        assert!(riddle_is_correct(0, "echo"));
        assert!(riddle_is_correct(0, "An Echo!"));
        assert!(riddle_is_correct(0, "ECHO"));
        assert!(!riddle_is_correct(0, "wind"));
        // Empty / punctuation-only never matches.
        assert!(!riddle_is_correct(0, "   "));
        assert!(!riddle_is_correct(0, "!!!"));
    }

    #[test]
    fn riddle_index_wraps() {
        assert_eq!(riddle_prompt(0), RIDDLES[0].0);
        assert_eq!(riddle_prompt(riddle_count()), RIDDLES[0].0);
        assert_eq!(riddle_prompt(riddle_count() + 2), RIDDLES[2].0);
        // Every riddle has at least one accepted answer.
        for (i, (_, answers)) in RIDDLES.iter().enumerate() {
            assert!(!answers.is_empty(), "riddle {i} has no answer");
            for &a in *answers {
                assert_eq!(normalize_answer(a), a, "answer {a:?} not in canonical form");
                assert!(riddle_is_correct(i, a), "riddle {i} rejects its own answer {a:?}");
            }
        }
    }

    #[test]
    fn gacha_wins_every_nth_deterministically() {
        let n = 8;
        let wins: Vec<u64> = (1..=24).filter(|&c| gacha_outcome(c, n).win).collect();
        assert_eq!(wins, vec![8, 16, 24], "must win exactly on multiples of N");
        // Pity counts 1..=N then resets.
        assert_eq!(gacha_outcome(1, n).pity, 1);
        assert_eq!(gacha_outcome(7, n).pity, 7);
        assert_eq!(gacha_outcome(8, n).pity, 8);
        assert_eq!(gacha_outcome(9, n).pity, 1);
        // Fully deterministic: same count -> same outcome, every time.
        assert_eq!(gacha_outcome(8, n), gacha_outcome(8, n));
    }

    #[test]
    fn gacha_n_zero_never_wins() {
        for c in 1..=20 {
            assert!(!gacha_outcome(c, 0).win);
        }
    }

    #[test]
    fn bell_offset_is_zero_at_crossings_and_peaks_at_quarter() {
        let period = 2000; // half = 1000
        assert_eq!(bell_offset_ms(0, period), 0); // start = a crossing
        assert_eq!(bell_offset_ms(1000, period), 0); // half-period = next crossing
        assert_eq!(bell_offset_ms(2000, period), 0); // full period
        assert_eq!(bell_offset_ms(500, period), 500); // quarter = farthest
        assert_eq!(bell_offset_ms(250, period), 250);
        assert_eq!(bell_offset_ms(750, period), 250);
    }

    #[test]
    fn bell_hit_within_tolerance() {
        let period = 1800;
        let tol = 140;
        assert!(bell_is_hit(0, period, tol));
        assert!(bell_is_hit(120, period, tol)); // just after a crossing
        assert!(bell_is_hit(period / 2, period, tol)); // the other crossing
        assert!(!bell_is_hit(period / 4, period, tol)); // peak of swing -> miss
    }

    #[test]
    fn bell_degenerate_periods_do_not_panic() {
        assert_eq!(bell_offset_ms(123, 0), 0);
        assert_eq!(bell_offset_ms(123, 1), 0);
    }
}
