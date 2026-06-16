//! The prize vault: pre-stocked `cashuB…` token strings, keyed by chest id.
//!
//! Tokens at rest are BEARER cash; keep the vault small, restrict file
//! access, never log token contents. A claim pops the chest's first token and
//! atomically rewrites the file (tmp + rename), so a crash mid-claim never
//! duplicates a payout.
//!
//! Schema (Phase 1a): a JSON object mapping chest id -> array of tokens:
//!   { "chest.jade": ["cashuB…"], "chest.rooftop": [] }
//! The Phase-0 format (a bare JSON array) is still READ, interpreted as
//! `chest.jade`'s stock; the file is never rewritten just for the schema, so
//! a legacy vault's token bytes survive untouched until a claim actually
//! debits it. Chests absent from the map are simply empty.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("vault has nothing for {chest} (restock {path})")]
    Empty { chest: String, path: PathBuf },
    #[error("vault io: {0}")]
    Io(#[from] io::Error),
    #[error("vault file is neither a chest-id map nor a legacy token array: {0}")]
    Malformed(String),
}

/// The chest id the legacy (bare-array) format maps to.
pub const LEGACY_CHEST: &str = "chest.jade";

#[derive(Debug, Clone)]
pub struct Vault {
    path: PathBuf,
}

impl Vault {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Read the whole vault as chest-id -> tokens. Accepts both schemas:
    /// a JSON object (current) or a bare JSON array (Phase 0, = chest.jade).
    fn read_map(&self) -> Result<BTreeMap<String, Vec<String>>, VaultError> {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new());
            }
            Err(e) => return Err(e.into()),
        };
        if let Ok(map) = serde_json::from_str::<BTreeMap<String, Vec<String>>>(&raw) {
            return Ok(map);
        }
        match serde_json::from_str::<Vec<String>>(&raw) {
            Ok(tokens) => {
                let mut map = BTreeMap::new();
                if !tokens.is_empty() {
                    map.insert(LEGACY_CHEST.to_string(), tokens);
                }
                Ok(map)
            }
            Err(e) => Err(VaultError::Malformed(e.to_string())),
        }
    }

    /// Total tokens stocked across all chests (0 when the file is absent).
    pub fn stock(&self) -> Result<usize, VaultError> {
        Ok(self.read_map()?.values().map(Vec::len).sum())
    }

    /// Tokens stocked for one chest (0 when absent; empty chests render as
    /// already-looted).
    pub fn stock_for(&self, chest: &str) -> Result<usize, VaultError> {
        Ok(self
            .read_map()?
            .get(chest)
            .map(Vec::len)
            .unwrap_or(0))
    }

    /// Pop one token for `chest`: remove it from the file (atomic tmp+rename)
    /// and return it. The caller hands it to exactly one claimer while
    /// holding the game lock, so claims cannot race. The rewrite uses the
    /// map schema; untouched chests' token strings pass through verbatim
    /// (cashuB tokens are plain base64url, so re-serialization is identical).
    pub fn pop(&self, chest: &str) -> Result<String, VaultError> {
        let mut map = self.read_map()?;
        let tokens = map.get_mut(chest).filter(|t| !t.is_empty()).ok_or_else(|| {
            VaultError::Empty {
                chest: chest.to_string(),
                path: self.path.clone(),
            }
        })?;
        let token = tokens.remove(0);
        let serialized =
            serde_json::to_string_pretty(&map).expect("BTreeMap<String, Vec<String>> serializes");
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serialized)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_with_raw(raw: &str) -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tokens.json");
        std::fs::write(&path, raw).unwrap();
        (dir, Vault::new(path))
    }

    #[test]
    fn map_schema_pops_per_chest_and_persists() {
        let (_dir, vault) = vault_with_raw(
            r#"{"chest.jade": ["cashuBjadeone", "cashuBjadetwo"], "chest.alley": ["cashuBalley"]}"#,
        );
        assert_eq!(vault.stock().unwrap(), 3);
        assert_eq!(vault.stock_for("chest.jade").unwrap(), 2);
        assert_eq!(vault.stock_for("chest.alley").unwrap(), 1);
        assert_eq!(vault.stock_for("chest.rooftop").unwrap(), 0);

        assert_eq!(vault.pop("chest.jade").unwrap(), "cashuBjadeone");
        // A fresh handle sees the popped state (persisted), other chests intact.
        let again = Vault::new(vault.path().to_path_buf());
        assert_eq!(again.stock_for("chest.jade").unwrap(), 1);
        assert_eq!(again.pop("chest.alley").unwrap(), "cashuBalley");
        assert!(matches!(
            again.pop("chest.alley"),
            Err(VaultError::Empty { .. })
        ));
        assert_eq!(again.pop("chest.jade").unwrap(), "cashuBjadetwo");
    }

    #[test]
    fn legacy_array_reads_as_chest_jade_without_rewriting_the_file() {
        let raw = "[\"cashuBlegacyjadetoken\"]";
        let (_dir, vault) = vault_with_raw(raw);
        // Reads interpret the legacy array as chest.jade…
        assert_eq!(vault.stock().unwrap(), 1);
        assert_eq!(vault.stock_for("chest.jade").unwrap(), 1);
        assert_eq!(vault.stock_for("chest.rooftop").unwrap(), 0);
        // …and reading NEVER rewrites the file (byte-exact preservation).
        assert_eq!(std::fs::read_to_string(vault.path()).unwrap(), raw);
        // A pop debits chest.jade and upgrades the schema; the token handed
        // out is the exact legacy string.
        assert_eq!(vault.pop("chest.jade").unwrap(), "cashuBlegacyjadetoken");
        let rewritten = std::fs::read_to_string(vault.path()).unwrap();
        assert!(rewritten.trim_start().starts_with('{'), "schema upgraded on pop");
    }

    #[test]
    fn legacy_token_bytes_survive_an_unrelated_pop() {
        // The jade token must pass through a rewrite VERBATIM when some other
        // chest is claimed first.
        let jade = "cashuBo2F0gaJhaUgArSaMTR9YJmFwgaNhYQhhc3hAZGVhZGJlZWY";
        let (_dir, vault) = vault_with_raw(&format!(
            r#"{{"chest.alley": ["cashuBalley"], "chest.jade": ["{jade}"]}}"#
        ));
        vault.pop("chest.alley").unwrap();
        let rewritten = std::fs::read_to_string(vault.path()).unwrap();
        assert!(rewritten.contains(jade), "jade token must survive byte-exact");
        assert_eq!(vault.pop("chest.jade").unwrap(), jade);
    }

    #[test]
    fn empty_array_legacy_file_is_just_empty() {
        let (_dir, vault) = vault_with_raw("[]");
        assert_eq!(vault.stock().unwrap(), 0);
        assert!(matches!(
            vault.pop("chest.jade"),
            Err(VaultError::Empty { .. })
        ));
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().join("absent.json"));
        assert_eq!(vault.stock().unwrap(), 0);
        assert_eq!(vault.stock_for("chest.jade").unwrap(), 0);
        assert!(matches!(
            vault.pop("chest.jade"),
            Err(VaultError::Empty { .. })
        ));
    }

    #[test]
    fn malformed_file_is_an_error() {
        let (_dir, vault) = vault_with_raw("{\"not\": 42}");
        assert!(matches!(vault.pop("chest.jade"), Err(VaultError::Malformed(_))));
        let (_dir2, vault2) = vault_with_raw("\"just a string\"");
        assert!(matches!(vault2.stock(), Err(VaultError::Malformed(_))));
    }
}
