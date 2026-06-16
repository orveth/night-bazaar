//! The committed golden vectors must equal a fresh regeneration — catches a
//! pops-core-verify wire change (or an accidental hand-edit) before the TS
//! suite mysteriously fails.

#[test]
fn committed_vectors_are_current() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../protocol/vectors/charge01-vectors.json"
    );
    let committed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect(
            "vectors file missing — run `cargo run --bin gen-vectors > ../protocol/vectors/charge01-vectors.json`",
        ))
        .expect("vectors file parses");
    let fresh = night_bazaar_server::vectors::generate();
    assert_eq!(
        committed, fresh,
        "golden vectors drifted from pops-core-verify's encoders — regenerate and re-run both suites"
    );
}
