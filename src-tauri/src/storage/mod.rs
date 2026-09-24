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
    /// SDE database identity (`sde::generation_id`) this entry was computed
    /// against, for cache values derived from the SDE (#884: routes, maps,
    /// FW system topology). `None` for the (majority) of entries that don't
    /// depend on the SDE at all — those keep today's TTL-only behaviour.
    /// `#[serde(default)]` so pre-#884 cache files on disk (written without
    /// this field) still deserialize as `None` instead of failing to parse.
    #[serde(default)]
    sde_generation: Option<u64>,
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
    let env = read_envelope::<T>(app_data_dir, key)?;
    (env.expires >= crate::util::time::now_secs()).then_some(env.value)
}

/// Like [`cache_get`], but also misses when the entry was written against a
/// different SDE generation than `sde_generation` — an SDE update invalidates
/// the entry immediately instead of waiting out its TTL (#884). An entry
/// written with no generation tag (i.e. via [`cache_put`]) never matches and
/// always misses here; use [`cache_put_versioned`] to write one.
pub fn cache_get_versioned<T: DeserializeOwned>(
    app_data_dir: &Path,
    key: &str,
    sde_generation: u64,
) -> Option<T> {
    let env = read_envelope::<T>(app_data_dir, key)?;
    if env.sde_generation != Some(sde_generation) {
        return None;
    }
    (env.expires >= crate::util::time::now_secs()).then_some(env.value)
}

fn read_envelope<T: DeserializeOwned>(app_data_dir: &Path, key: &str) -> Option<CacheEnvelope<T>> {
    let bytes = std::fs::read(cache_path(app_data_dir, key)).ok()?;
    serde_json::from_slice(&bytes).ok()
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
    let env = read_envelope::<T>(app_data_dir, key)?;
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

/// Write a cached value that stays fresh for `ttl_secs`. Carries no SDE
/// generation tag — a plain TTL-only entry, as read by [`cache_get`]. Use
/// [`cache_put_versioned`] for values derived from the SDE.
pub fn cache_put<T: Serialize>(
    app_data_dir: &Path,
    key: &str,
    value: &T,
    ttl_secs: u64,
) -> Result<(), String> {
    write_envelope(app_data_dir, key, value, ttl_secs, None)
}

/// Write a cached value that stays fresh for `ttl_secs`, tagged with the SDE
/// generation (`sde::generation_id`) it was computed against (#884). A
/// subsequent [`cache_get_versioned`] call misses as soon as the SDE's
/// generation moves on, even if `ttl_secs` hasn't elapsed yet; the TTL still
/// applies as a secondary ceiling so the entry doesn't live forever should
/// the SDE never update.
pub fn cache_put_versioned<T: Serialize>(
    app_data_dir: &Path,
    key: &str,
    value: &T,
    ttl_secs: u64,
    sde_generation: u64,
) -> Result<(), String> {
    write_envelope(app_data_dir, key, value, ttl_secs, Some(sde_generation))
}

fn write_envelope<T: Serialize>(
    app_data_dir: &Path,
    key: &str,
    value: &T,
    ttl_secs: u64,
    sde_generation: Option<u64>,
) -> Result<(), String> {
    let path = cache_path(app_data_dir, key);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let env = CacheEnvelope {
        expires: crate::util::time::now_secs() + ttl_secs,
        sde_generation,
        value,
    };
    let data = serde_json::to_vec(&env).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

// --- Hash short-circuit for providers with no revalidation headers (#886) ---
//
// zKillboard's stats endpoint (and Fuzzwork's aggregates, though that one's
// cache is in-memory-only — see `market::cache::TtlCache`) send neither an
// `ETag` nor a `Last-Modified` we can trust (confirmed via `curl -I`;
// zKillboard's stats response is even marked `Cache-Control: no-store`), so
// there's no way to ask the server "did this change?" before paying for a
// full download. `cache_put_if_changed` still pays for the download (the TTL
// cadence below is unchanged) but skips rewriting the body to disk when the
// freshly-fetched value hashes the same as what's already cached — the
// common case for e.g. a pilot's kill stats, which drift slowly.

/// SHA-256 hex digest of `value`'s JSON encoding. Used only to detect
/// whether a re-fetched value actually changed, never for security purposes.
fn content_hash<T: Serialize>(value: &T) -> String {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

/// The [`cache_put_if_changed`]/[`cache_get_if_changed`] hash-marker key for
/// `key` — kept distinct from `key` itself so the (small) freshness marker
/// and the (potentially large) durable body never collide as cache keys.
fn hash_marker_key(key: &str) -> String {
    format!("{key}.hash")
}

/// Like [`cache_put`], but for providers with no `ETag`/`Last-Modified` to
/// revalidate against: skips rewriting the (durable, non-expiring) body when
/// `value` hashes the same as the last write, only pushing the freshness
/// deadline forward — exactly like [`cache_put`], so a call here always
/// renews the same `ttl_secs` cadence regardless of whether the body changed.
/// Returns whether the value actually changed, so callers can skip
/// signalling a refresh downstream when it didn't. Pair with
/// [`cache_get_if_changed`] to read it back.
pub fn cache_put_if_changed<T: Serialize>(
    app_data_dir: &Path,
    key: &str,
    value: &T,
    ttl_secs: u64,
) -> Result<bool, String> {
    let hash = content_hash(value);
    let marker_key = hash_marker_key(key);
    // Compare against the last-written hash regardless of how stale its own
    // marker has become — staleness only gates *whether a re-fetch is due*
    // (the caller's own `cache_get_if_changed` check), not whether the hash
    // is still meaningful for spotting an unchanged body.
    let previous = cache_get_stale::<String>(app_data_dir, &marker_key, u64::MAX);
    let changed = previous.as_deref() != Some(hash.as_str());
    if changed {
        save_data(app_data_dir, key, value)?;
    }
    cache_put(app_data_dir, &marker_key, &hash, ttl_secs)?;
    Ok(changed)
}

/// Read a value written by [`cache_put_if_changed`]: the durable body if its
/// freshness marker hasn't expired, `None` otherwise (stale or never
/// written) — mirrors [`cache_get`]'s "fresh or nothing" contract.
pub fn cache_get_if_changed<T: DeserializeOwned>(app_data_dir: &Path, key: &str) -> Option<T> {
    cache_get::<String>(app_data_dir, &hash_marker_key(key))?;
    load_data(app_data_dir, key)
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
    fn cache_put_if_changed_skips_body_rewrite_when_unchanged() {
        let dir = std::env::temp_dir().join(format!("eve-hash-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // First write: no previous hash, so it's reported as "changed" and
        // both the body and the marker land on disk.
        assert!(cache_put_if_changed(&dir, "k", &vec![1_i64, 2, 3], 3600).unwrap());
        assert_eq!(
            cache_get_if_changed::<Vec<i64>>(&dir, "k"),
            Some(vec![1, 2, 3])
        );

        // Same value again: hash matches, reported unchanged, but the TTL
        // marker still renews (cadence is unaffected).
        assert!(!cache_put_if_changed(&dir, "k", &vec![1_i64, 2, 3], 3600).unwrap());
        assert_eq!(
            cache_get_if_changed::<Vec<i64>>(&dir, "k"),
            Some(vec![1, 2, 3])
        );

        // A genuinely different value is reported as changed and overwrites
        // the durable body.
        assert!(cache_put_if_changed(&dir, "k", &vec![9_i64], 3600).unwrap());
        assert_eq!(cache_get_if_changed::<Vec<i64>>(&dir, "k"), Some(vec![9]));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_get_if_changed_misses_once_marker_expires() {
        let dir =
            std::env::temp_dir().join(format!("eve-hash-cache-expiry-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // A marker written with an already-elapsed TTL means the value is
        // due for a re-fetch, even though the durable body is still on disk.
        cache_put_if_changed(&dir, "k", &1_i64, 0).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert_eq!(cache_get_if_changed::<i64>(&dir, "k"), None);

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
            sde_generation: None,
            value: 7_i64,
        };
        std::fs::write(&path, serde_json::to_vec(&env).unwrap()).unwrap();
        assert_eq!(cache_get::<i64>(&dir, "k"), None);
        assert_eq!(cache_get_stale::<i64>(&dir, "k", 3600), Some(7));
        assert_eq!(cache_get_stale::<i64>(&dir, "k", 50), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_get_versioned_misses_on_generation_mismatch() {
        // #884: a cache entry written for SDE generation N must miss when read
        // back requesting N + 1, even though its TTL hasn't elapsed — an SDE
        // update invalidates it immediately instead of waiting out the TTL.
        let dir = std::env::temp_dir().join(format!("eve-versioned-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        cache_put_versioned(&dir, "k", &vec![1_i64, 2, 3], 3600, 1).unwrap();

        // Same generation → hit.
        assert_eq!(
            cache_get_versioned::<Vec<i64>>(&dir, "k", 1),
            Some(vec![1, 2, 3])
        );
        // Next generation → miss, forcing recompute, despite the fresh TTL.
        assert_eq!(cache_get_versioned::<Vec<i64>>(&dir, "k", 2), None);

        // An entry with no generation tag (plain cache_put) never matches a
        // versioned read.
        cache_put(&dir, "plain", &1_i64, 3600).unwrap();
        assert_eq!(cache_get_versioned::<i64>(&dir, "plain", 1), None);

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
