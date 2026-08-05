//! Local persistence: per-character refresh tokens in the OS keychain, and the
//! character roster as a JSON file in the app data dir.

use std::path::{Path, PathBuf};

use keyring::Entry;
use tauri::Manager;

use crate::model::Character;

/// Keychain service name (one keyed entry per character id).
pub(crate) const KEYCHAIN_SERVICE: &str = "com.thlange.eve-online-tooling";

fn entry(character_id: i64) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, &character_id.to_string()).map_err(|e| e.to_string())
}

/// Resolve the app data dir, mapping the lookup error to a `String` the way
/// every command does. The single call site for the `app.path().app_data_dir()`
/// plumbing that was otherwise copy-pasted across every command module.
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
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
    secret_entry(name)?
        .set_password(value)
        .map_err(|e| e.to_string())
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

/// Sentinel "active character" id meaning **all characters in the roster**.
/// Negative so it can never collide with a real EVE character id (always
/// positive). Persisted like any other active id; commands fan out on it.
pub const ALL_CHARACTERS: i64 = -1;

/// The active character id if one is bookmarked and still in the roster (or the
/// [`ALL_CHARACTERS`] sentinel when at least one character is logged in), else
/// the first roster character. The single source of truth for "which character"
/// every per-character command defaults to.
pub fn active_character(app_data_dir: &Path) -> Option<i64> {
    let roster = load_roster(app_data_dir);
    if let Some(id) = load_data::<i64>(app_data_dir, ACTIVE_CHARACTER_KEY) {
        if id == ALL_CHARACTERS && !roster.is_empty() {
            return Some(ALL_CHARACTERS);
        }
        if roster.iter().any(|c| c.character_id == id) {
            return Some(id);
        }
    }
    roster.into_iter().next().map(|c| c.character_id)
}

/// The character ids a per-character command should operate on: every roster
/// member when [`ALL_CHARACTERS`] is active, otherwise just the active one.
/// Empty when nobody is logged in. Aggregating commands loop this and merge.
pub fn target_characters(app_data_dir: &Path) -> Vec<i64> {
    match active_character(app_data_dir) {
        Some(ALL_CHARACTERS) => load_roster(app_data_dir)
            .into_iter()
            .map(|c| c.character_id)
            .collect(),
        Some(id) => vec![id],
        None => Vec::new(),
    }
}

/// A single concrete character for commands that can't aggregate (in-game
/// actions, "my location"): the active character, or the first roster member
/// when [`ALL_CHARACTERS`] is selected. `None` when nobody is logged in.
pub fn primary_character(app_data_dir: &Path) -> Option<i64> {
    match active_character(app_data_dir) {
        Some(ALL_CHARACTERS) => load_roster(app_data_dir)
            .into_iter()
            .next()
            .map(|c| c.character_id),
        other => other,
    }
}

/// [`primary_character`], or [`AppError::AuthRequired`] when nobody is logged
/// in — the single call site for the "require a primary character" guard that
/// was otherwise copy-pasted as a module-local `first_character`/`primary`
/// helper across every command module.
pub fn require_primary_character(app_data_dir: &Path) -> Result<i64, crate::model::AppError> {
    primary_character(app_data_dir).ok_or_else(crate::model::AppError::auth_required)
}

/// [`app_data_dir`] plus [`require_primary_character`] in one call — the shape
/// most commands actually want (they need the dir anyway to load/save
/// per-character state).
pub fn dir_and_primary_character(
    app: &tauri::AppHandle,
) -> Result<(PathBuf, i64), crate::model::AppError> {
    let dir = app_data_dir(app)?;
    let character_id = require_primary_character(&dir)?;
    Ok((dir, character_id))
}

/// Roster character id → name, for tagging aggregated ("all characters") rows
/// without an extra ESI lookup (names are already stored on the roster).
pub fn character_names(app_data_dir: &Path) -> std::collections::HashMap<i64, String> {
    load_roster(app_data_dir)
        .into_iter()
        .map(|c| (c.character_id, c.name))
        .collect()
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

fn cache_path(app_data_dir: &Path, key: &str) -> std::path::PathBuf {
    // Keys are caller-controlled identifiers; sanitize to a safe filename.
    app_data_dir
        .join("cache")
        .join(format!("{}.json", sanitize(key)))
}

/// Read a cached value, or `None` if absent, unreadable, or expired.
pub fn cache_get<T: DeserializeOwned>(app_data_dir: &Path, key: &str) -> Option<T> {
    let bytes = std::fs::read(cache_path(app_data_dir, key)).ok()?;
    let env: CacheEnvelope<T> = serde_json::from_slice(&bytes).ok()?;
    (env.expires >= crate::util::time::now_secs()).then_some(env.value)
}

/// Read a cached value even if expired, as long as it aged out no more than
/// `max_stale_secs` ago. For fallback paths that prefer slightly-stale data
/// over an error (e.g. a feed host briefly unreachable); use [`cache_get`]
/// everywhere freshness matters.
pub fn cache_get_stale<T: DeserializeOwned>(
    app_data_dir: &Path,
    key: &str,
    max_stale_secs: u64,
) -> Option<T> {
    let bytes = std::fs::read(cache_path(app_data_dir, key)).ok()?;
    let env: CacheEnvelope<T> = serde_json::from_slice(&bytes).ok()?;
    (env.expires.saturating_add(max_stale_secs) >= crate::util::time::now_secs())
        .then_some(env.value)
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
    let path = app_data_dir
        .join("data")
        .join(format!("{}.json", sanitize(name)));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

/// Path-safety filter for caller-controlled names: every on-disk filename
/// derived from a caller string (cache keys, data-document names) must go
/// through here, so a hardening change lands in one place.
fn sanitize(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
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
        expires: crate::util::time::now_secs() + ttl_secs,
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_get_stale_serves_recently_expired_entries() {
        let dir = std::env::temp_dir().join(format!("eve-stale-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = cache_path(&dir, "k");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // An entry that expired 100s ago: the strict read misses, the stale
        // read serves it while within the slack window and not beyond.
        let now = crate::util::time::now_secs();
        let env = CacheEnvelope {
            expires: now - 100,
            value: 7_i64,
        };
        std::fs::write(&path, serde_json::to_vec(&env).unwrap()).unwrap();
        assert_eq!(cache_get::<i64>(&dir, "k"), None);
        assert_eq!(cache_get_stale::<i64>(&dir, "k", 3600), Some(7));
        assert_eq!(cache_get_stale::<i64>(&dir, "k", 50), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_path_neutralizes_traversal_keys() {
        // Caller-controlled keys must never escape the cache dir: everything
        // but [A-Za-z0-9_-] becomes '_' via the shared sanitize() filter.
        let dir = Path::new("/base");
        let p = cache_path(dir, "../../etc/passwd");
        assert_eq!(p, Path::new("/base/cache/______etc_passwd.json"));
        assert_eq!(sanitize("a/b\\c:d"), "a_b_c_d");
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
