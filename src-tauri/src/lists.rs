//! Shared persisted type-id lists (blacklist / favorites) for feature modules.
//!
//! Each list is a JSON file of type ids in the app data dir, keyed by a
//! module-scoped name (e.g. `blacklist` for trading, `production_favorites` for
//! production) so different modules' lists never collide. This is the second
//! consumer (production joins trading), so the storage + name-resolution lives
//! here rather than being copied per module.

use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use crate::sde::Sde;
use crate::storage;

/// An item on a saved list, resolved to its display name.
#[derive(Debug, Clone, Serialize)]
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
        .map(|type_id| {
            let name = sde
                .type_info(type_id)
                .ok()
                .flatten()
                .map(|t| t.name)
                .unwrap_or_else(|| format!("Type {type_id}"));
            ListItem { type_id, name }
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
