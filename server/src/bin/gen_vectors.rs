//! Print the charge-01 golden vectors to stdout. See `vectors.rs`.
//! `cargo run --bin gen-vectors > ../protocol/vectors/charge01-vectors.json`

fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&night_bazaar_server::vectors::generate())
            .expect("vectors serialize")
    );
}
