//! Persistence for the Scripts module.
//!
//! All snippet definitions live in one durable JSON document (`scripts`), the
//! same `storage::save_data`/`load_data` mechanism the shopping lists use. Each
//! script also gets a private key/value store on disk under
//! `<app data>/scripts/<id>/kv/`, reachable only through the host API — a script
//! can't see another script's data.

use std::path::{Path, PathBuf};

use crate::storage;

use super::types::Script;

/// Storage document name (a JSON file in `<app data>/data/`).
const STORE_KEY: &str = "scripts";

/// Load every stored script (empty when none/unreadable).
pub fn load(dir: &Path) -> Vec<Script> {
    storage::load_data(dir, STORE_KEY).unwrap_or_default()
}

/// Persist the full script set.
pub fn save(dir: &Path, scripts: &[Script]) -> Result<(), String> {
    storage::save_data(dir, STORE_KEY, &scripts)
}

/// A filesystem-safe slug of a display name (`My Script!` -> `my-script`).
fn slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let s = out.trim_matches('-').to_string();
    if s.is_empty() {
        "script".to_string()
    } else {
        s
    }
}

/// A slug id for a new script, de-duplicated against the existing ids with a
/// numeric suffix (`my-script`, `my-script-2`, …).
pub fn unique_id(existing: &[Script], name: &str) -> String {
    let base = slug(name);
    if !existing.iter().any(|s| s.id == base) {
        return base;
    }
    for n in 2.. {
        let candidate = format!("{base}-{n}");
        if !existing.iter().any(|s| s.id == candidate) {
            return candidate;
        }
    }
    unreachable!("the counter is unbounded")
}

// --- Per-script private key/value store -------------------------------------

/// Sanitize an id/key to a single safe path component: alphanumerics plus
/// `_ - .`, rejecting empty or `..`-containing values so it can never escape
/// the script's own directory (same guard as the plugin broker).
fn safe_component(raw: &str) -> Option<String> {
    let s: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .collect();
    if s.is_empty() || s.contains("..") {
        None
    } else {
        Some(s)
    }
}

/// This script's KV directory: `<app data>/scripts/<id>/kv/`.
fn kv_dir(dir: &Path, script_id: &str) -> Option<PathBuf> {
    Some(
        dir.join("scripts")
            .join(safe_component(script_id)?)
            .join("kv"),
    )
}

/// Read a script's private value (`""` when unset).
pub fn kv_get(dir: &Path, script_id: &str, key: &str) -> Result<String, String> {
    let base = kv_dir(dir, script_id).ok_or("invalid script id")?;
    let key = safe_component(key).ok_or_else(|| format!("invalid storage key {key:?}"))?;
    Ok(std::fs::read_to_string(base.join(key)).unwrap_or_default())
}

/// Write a script's private value.
pub fn kv_set(dir: &Path, script_id: &str, key: &str, value: &str) -> Result<(), String> {
    let base = kv_dir(dir, script_id).ok_or("invalid script id")?;
    let key = safe_component(key).ok_or_else(|| format!("invalid storage key {key:?}"))?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    std::fs::write(base.join(key), value).map_err(|e| e.to_string())
}

/// Delete a script's private store (called when the script is removed).
pub fn clear_kv(dir: &Path, script_id: &str) {
    if let Some(id) = safe_component(script_id) {
        let _ = std::fs::remove_dir_all(dir.join("scripts").join(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::scripts::types::{Language, Script};

    fn script(id: &str) -> Script {
        Script {
            id: id.to_string(),
            name: id.to_string(),
            language: Language::Rhai,
            code: String::new(),
            interval_min: None,
            enabled: false,
            updated_at: 0,
        }
    }

    #[test]
    fn slug_is_filesystem_safe() {
        assert_eq!(slug("My Script!"), "my-script");
        assert_eq!(slug("  spaced  "), "spaced");
        assert_eq!(slug("***"), "script");
    }

    #[test]
    fn unique_id_dedupes_with_a_numeric_suffix() {
        let existing = vec![script("my-script"), script("my-script-2")];
        assert_eq!(unique_id(&existing, "My Script"), "my-script-3");
        assert_eq!(unique_id(&existing, "Fresh"), "fresh");
    }

    #[test]
    fn kv_roundtrips_and_rejects_escaping_keys() {
        let dir = std::env::temp_dir().join(format!("scripts-kv-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(kv_get(&dir, "s1", "count").unwrap(), "");
        kv_set(&dir, "s1", "count", "42").unwrap();
        assert_eq!(kv_get(&dir, "s1", "count").unwrap(), "42");
        // A different script can't see it.
        assert_eq!(kv_get(&dir, "s2", "count").unwrap(), "");
        // Path-escaping keys are refused.
        assert!(kv_set(&dir, "s1", "../evil", "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
