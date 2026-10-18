//! Shared persisted type-id lists (blacklist / favorites) for feature modules.
//!
//! Each list is a JSON file of type ids in the app data dir, keyed by a
//! module-scoped name (e.g. `blacklist` for trading, `production_favorites` for
//! production) so different modules' lists never collide. This is the second
//! consumer (production joins trading), so the storage + name-resolution lives
//! here rather than being copied per module.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use crate::sde::Sde;
use crate::storage;

/// An item on a saved list, resolved to its display name.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    pub type_id: i64,
    pub name: String,
}

/// The contents of a saved list (`key` is the storage name), with names looked
/// up from the SDE. Unknown ids fall back to `Type <id>`.
pub fn get(sde: &Sde, dir: &Path, key: &str) -> Vec<ListItem> {
    storage::load_id_list(dir, key)
        .into_iter()
        .map(|type_id| ListItem {
            type_id,
            name: sde.type_name_or_id(type_id),
        })
        .collect()
}

/// Add (`add == true`) or remove a type from a saved list. Idempotent: the id is
/// removed first either way, so adding never duplicates.
pub fn set(dir: &Path, key: &str, type_id: i64, add: bool) -> Result<(), String> {
    let mut ids = storage::load_id_list(dir, key);
    ids.retain(|&x| x != type_id);
    if add {
        ids.push(type_id);
    }
    storage::save_id_list(dir, key, &ids)
}

/// [`get`] from an app handle: resolves the app data dir + SDE, then looks up
/// names. Feature modules validate the caller-supplied list name to a `key`
/// first (each module owns its valid names) and delegate here — the dir/SDE
/// plumbing was otherwise copy-pasted identically across every list module.
pub fn get_from_app(app: &AppHandle, key: &str) -> Result<Vec<ListItem>, String> {
    let (dir, sde) = crate::sde::dir_and_sde(app)?;
    Ok(get(&sde, &dir, key))
}

/// [`set`] from an app handle: resolves the app data dir and adds/removes the
/// type (no SDE needed). Companion to [`get_from_app`].
pub fn set_from_app(app: &AppHandle, key: &str, type_id: i64, add: bool) -> Result<(), String> {
    let dir = storage::app_data_dir(app)?;
    set(&dir, key, type_id, add)
}

/// Loads a module's blacklist and favorites lists as `HashSet`s, ready for
/// `.contains()` lookups during a scan. Companion to [`get`]/[`set`] for the
/// scan-time (rather than UI-display-time) consumer of these lists.
pub fn load_filter_sets(
    dir: &Path,
    blacklist_key: &str,
    favorites_key: &str,
) -> (HashSet<i64>, HashSet<i64>) {
    let blacklist = storage::load_id_list(dir, blacklist_key)
        .into_iter()
        .collect();
    let favorites = storage::load_id_list(dir, favorites_key)
        .into_iter()
        .collect();
    (blacklist, favorites)
}

// --- Slug ids -----------------------------------------------------------

/// Turn a user-supplied display `name` into a URL/filename-safe id: lowercase
/// the name, replace every non-alphanumeric character with `-`, then trim
/// leading/trailing `-`. If that leaves nothing (e.g. the name was all
/// symbols/whitespace), fall back to `fallback` as the base instead of an
/// empty string. Finally de-duplicate against `existing` by appending `-2`,
/// `-3`, ... until the id is unique — shared by every feature module that
/// lets a user name a new list/setup/entry (shopping lists, PI planner
/// setups, mass-production build lists) so the scheme only has one copy.
pub fn slug_id(name: &str, existing: &[String], fallback: &str) -> String {
    let base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() {
        fallback.to_string()
    } else {
        base
    };
    let mut id = base.clone();
    let mut n = 2;
    while existing.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

#[cfg(test)]
mod slug_id_tests {
    use super::slug_id;

    #[test]
    fn lowercases_and_dashes_non_alphanumerics() {
        assert_eq!(
            slug_id("Jita Industry!", &[], "list"),
            "jita-industry".to_string()
        );
    }

    #[test]
    fn trims_leading_and_trailing_dashes() {
        assert_eq!(
            slug_id("  -- Mining Ops -- ", &[], "list"),
            "mining-ops".to_string()
        );
    }

    #[test]
    fn falls_back_when_name_has_no_alphanumeric_characters() {
        assert_eq!(slug_id("!!!", &[], "list"), "list".to_string());
        assert_eq!(slug_id("", &[], "setup"), "setup".to_string());
    }

    #[test]
    fn appends_a_numeric_suffix_on_collision() {
        let existing = vec!["mining-ops".to_string()];
        assert_eq!(slug_id("Mining Ops", &existing, "list"), "mining-ops-2");
    }

    #[test]
    fn keeps_incrementing_the_suffix_past_multiple_collisions() {
        let existing = vec![
            "mining-ops".to_string(),
            "mining-ops-2".to_string(),
            "mining-ops-3".to_string(),
        ];
        assert_eq!(slug_id("Mining Ops", &existing, "list"), "mining-ops-4");
    }

    #[test]
    fn fallback_base_also_dedupes_on_repeated_symbol_only_names() {
        let existing = vec!["list".to_string()];
        assert_eq!(slug_id("###", &existing, "list"), "list-2");
    }
}
