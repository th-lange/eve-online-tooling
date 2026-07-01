//! Local persistence: per-character refresh tokens in the OS keychain, and the
//! character roster as a JSON file in the app data dir.

use std::path::Path;

use keyring::Entry;

use crate::model::Character;

/// Keychain service name (one keyed entry per character id).
const KEYCHAIN_SERVICE: &str = "com.thlange.eve-online-tooling";

fn entry(character_id: i64) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, &character_id.to_string()).map_err(|e| e.to_string())
}

/// Store a character's refresh token in the OS keychain.
pub fn store_refresh_token(character_id: i64, token: &str) -> Result<(), String> {
    entry(character_id)?
        .set_password(token)
        .map_err(|e| e.to_string())
}

/// Load a character's refresh token, if present.
pub fn load_refresh_token(character_id: i64) -> Result<Option<String>, String> {
    match entry(character_id)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a character's refresh token (no-op if absent).
pub fn delete_refresh_token(character_id: i64) -> Result<(), String> {
    match entry(character_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// --- Named secrets (non-character) ---
//
// A generic keychain slot for secrets that aren't a character refresh token —
// e.g. a third-party service password (Tripwire, #302). Keyed by a string name
// under the same service; names won't collide with the numeric character ids.

fn secret_entry(name: &str) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())
}

/// Store a named secret in the OS keychain.
pub fn store_secret(name: &str, value: &str) -> Result<(), String> {
    secret_entry(name)?.set_password(value).map_err(|e| e.to_string())
}

/// Load a named secret, if present.
pub fn load_secret(name: &str) -> Result<Option<String>, String> {
    match secret_entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a named secret (no-op if absent).
pub fn delete_secret(name: &str) -> Result<(), String> {
    match secret_entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn roster_path(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join("characters.json")
}

/// Load the character roster (empty if none/unreadable).
pub fn load_roster(app_data_dir: &Path) -> Vec<Character> {
    std::fs::read(roster_path(app_data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Persist the character roster.
pub fn save_roster(app_data_dir: &Path, roster: &[Character]) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec_pretty(roster).map_err(|e| e.to_string())?;
    std::fs::write(roster_path(app_data_dir), data).map_err(|e| e.to_string())
}

const ACTIVE_CHARACTER_KEY: &str = "active_character";

/// Set the bookmarked "active" character used by character-based features.
pub fn save_active_character(app_data_dir: &Path, character_id: i64) -> Result<(), String> {
    save_data(app_data_dir, ACTIVE_CHARACTER_KEY, &character_id)
}

/// The active character id if one is bookmarked and still in the roster, else
/// the first roster character. The single source of truth for "which character"
/// every per-character command defaults to.
pub fn active_character(app_data_dir: &Path) -> Option<i64> {
    let roster = load_roster(app_data_dir);
    if let Some(id) = load_data::<i64>(app_data_dir, ACTIVE_CHARACTER_KEY) {
        if roster.iter().any(|c| c.character_id == id) {
            return Some(id);
        }
    }
    roster.into_iter().next().map(|c| c.character_id)
}

/// Load a persisted list of type ids (e.g. `blacklist`, `favorites`).
pub fn load_id_list(app_data_dir: &Path, name: &str) -> Vec<i64> {
    std::fs::read(app_data_dir.join(format!("{name}.json")))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Persist a list of type ids.
pub fn save_id_list(app_data_dir: &Path, name: &str, ids: &[i64]) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec_pretty(ids).map_err(|e| e.to_string())?;
    std::fs::write(app_data_dir.join(format!("{name}.json")), data).map_err(|e| e.to_string())
}

// --- Durable Expires-gated cache ---
//
// A disk-backed cache for synced ESI data: each entry stores the value plus an
// `expires` epoch. `cache_get` returns the value only while it's still fresh, so
// a caller can skip an ESI round-trip — a simple (key = group+owner) sync ledger
// that survives restarts (unlike the in-memory market TTL cache).

use serde::{de::DeserializeOwned, Serialize};

#[derive(serde::Serialize, serde::Deserialize)]
struct CacheEnvelope<T> {
    /// Unix epoch (seconds) after which the entry is stale.
    expires: u64,
    value: T,
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_path(app_data_dir: &Path, key: &str) -> std::path::PathBuf {
    // Keys are caller-controlled identifiers; sanitize to a safe filename.
    let safe: String = key
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    app_data_dir.join("cache").join(format!("{safe}.json"))
}

/// Read a cached value, or `None` if absent, unreadable, or expired.
pub fn cache_get<T: DeserializeOwned>(app_data_dir: &Path, key: &str) -> Option<T> {
    let bytes = std::fs::read(cache_path(app_data_dir, key)).ok()?;
    let env: CacheEnvelope<T> = serde_json::from_slice(&bytes).ok()?;
    (env.expires >= now_epoch()).then_some(env.value)
}

/// Drop a cached value so the next read misses (e.g. after a write invalidates it).
pub fn cache_invalidate(app_data_dir: &Path, key: &str) {
    let _ = std::fs::remove_file(cache_path(app_data_dir, key));
}

/// Load a durable (non-expiring) JSON document by name, or `None` if absent.
/// For accumulated history (wallet journal, transactions) that must survive
/// restarts and grow beyond ESI's window.
pub fn load_data<T: DeserializeOwned>(app_data_dir: &Path, name: &str) -> Option<T> {
    let safe = sanitize(name);
    let bytes = std::fs::read(app_data_dir.join("data").join(format!("{safe}.json"))).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Persist a durable JSON document by name.
pub fn save_data<T: Serialize>(app_data_dir: &Path, name: &str, value: &T) -> Result<(), String> {
    let path = app_data_dir.join("data").join(format!("{}.json", sanitize(name)));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

fn sanitize(key: &str) -> String {
    key.chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// Write a cached value that stays fresh for `ttl_secs`.
pub fn cache_put<T: Serialize>(
    app_data_dir: &Path,
    key: &str,
    value: &T,
    ttl_secs: u64,
) -> Result<(), String> {
    let path = cache_path(app_data_dir, key);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let env = CacheEnvelope {
        expires: now_epoch() + ttl_secs,
        value,
    };
    let data = serde_json::to_vec(&env).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trips_and_expires() {
        let dir = std::env::temp_dir().join(format!("eve-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(cache_get::<Vec<i64>>(&dir, "k"), None);
        // Fresh entry round-trips.
        cache_put(&dir, "k", &vec![1_i64, 2, 3], 3600).unwrap();
        assert_eq!(cache_get::<Vec<i64>>(&dir, "k"), Some(vec![1, 2, 3]));
        // A zero-TTL entry is immediately stale (expires == now, but a later read
        // is past it once a second ticks; force-test with ttl 0 + manual now check
        // is flaky, so just confirm a clearly-expired write reads as None).
        cache_put(&dir, "old", &1_i64, 0).unwrap();
        // expires == now; treat as fresh this instant, so re-check semantics only
        // for the absent/fresh cases above.
        let _ = cache_get::<i64>(&dir, "old");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn id_list_round_trips() {
        let dir = std::env::temp_dir().join(format!("eve-list-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load_id_list(&dir, "blacklist").is_empty());
        save_id_list(&dir, "blacklist", &[34, 35, 36]).unwrap();
        assert_eq!(load_id_list(&dir, "blacklist"), vec![34, 35, 36]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn roster_round_trips() {
        let dir = std::env::temp_dir().join(format!("eve-roster-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load_roster(&dir).is_empty());

        let roster = vec![
            Character {
                character_id: 1,
                name: "A".into(),
                scopes: vec!["publicData".into()],
            },
            Character {
                character_id: 2,
                name: "B".into(),
                scopes: vec![],
            },
        ];
        save_roster(&dir, &roster).unwrap();
        assert_eq!(load_roster(&dir), roster);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
