//! Persisted "build lists" for Mass Production — a named, reusable set of
//! blueprint type ids plus any per-line build-run overrides (see
//! [`super::commands::BlueprintLine`]), so a frequently-repeated mass build
//! (e.g. a standing doctrine restock) can be saved once and replayed without
//! re-pasting every blueprint name.
//!
//! Mirrors the Shopping Lists module's single-JSON-document-per-feature
//! approach (`crate::lists::load_store`/`save_store`, themselves thin
//! wrappers around `crate::storage::load_data`/`save_data`): one
//! `massprod_build_lists` document holding every saved list; display names
//! are resolved from the SDE only when read out, so they stay correct across
//! SDE updates (same approach as `crate::lists`/`shopping`).

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::lists::{self, Identified};
use crate::sde::Sde;

/// Storage document name (a JSON file in `<app data>/data/`).
const STORE_KEY: &str = "massprod_build_lists";

// --- Stored shape -----------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Store {
    lists: Vec<StoredList>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredList {
    id: String,
    name: String,
    #[serde(default)]
    items: Vec<StoredLine>,
}

impl Identified for StoredList {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredLine {
    #[serde(rename = "typeId", alias = "type_id")]
    type_id: i64,
    /// Saved per-line build-run override — `None` replays as "use the
    /// mode's default", exactly like a fresh, un-overridden paste.
    #[serde(default)]
    build_runs: Option<i64>,
}

fn load(dir: &std::path::Path) -> Store {
    lists::load_store(dir, STORE_KEY)
}

fn save(dir: &std::path::Path, store: &Store) -> Result<(), String> {
    lists::save_store(dir, STORE_KEY, store)
}

// --- Resolved shape returned to the frontend --------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildListItem {
    pub type_id: i64,
    pub name: String,
    pub build_runs: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildList {
    pub id: String,
    pub name: String,
    pub items: Vec<BuildListItem>,
}

/// Resolve a stored list's item names from the SDE.
fn resolve(sde: &Sde, list: &StoredList) -> BuildList {
    let ids: Vec<i64> = list.items.iter().map(|e| e.type_id).collect();
    let names = sde.type_name_map(&ids).unwrap_or_default();
    let items = list
        .items
        .iter()
        .map(|e| BuildListItem {
            type_id: e.type_id,
            name: names.get(e.type_id),
            build_runs: e.build_runs,
        })
        .collect();
    BuildList {
        id: list.id.clone(),
        name: list.name.clone(),
        items,
    }
}

// --- Commands ---------------------------------------------------------------

/// Every saved build list (names resolved from the SDE).
#[tauri::command]
pub fn massprod_lists(app: AppHandle) -> Result<Vec<BuildList>, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let store = load(&dir);
    Ok(store.lists.iter().map(|l| resolve(&sde, l)).collect())
}

/// One line to save: a resolved blueprint type id plus its (optional)
/// build-run override — the frontend already has both from the current
/// plan, so saving needs no SDE re-resolution of names.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveListItem {
    pub type_id: i64,
    #[serde(default)]
    pub build_runs: Option<i64>,
}

/// Insert-or-overwrite a list by exact name into `store`, returning the
/// resulting `StoredList`. Pure core of `massprod_save_list`, split out so
/// the overwrite-vs-create-new-id decision is unit-testable without an
/// `AppHandle`. A name matching an existing list overwrites its items in
/// place (same id — the normal "load it, add/remove a few blueprints, save
/// again" loop), rather than creating a sibling "name-2". A genuinely new
/// name gets a fresh id: a slug of the name, de-duplicated with a numeric
/// suffix (same scheme as `shopping_create_list`).
fn upsert_list(store: &mut Store, name: String, items: Vec<StoredLine>) -> StoredList {
    if let Some(existing) = store.lists.iter_mut().find(|l| l.name == name) {
        existing.items = items;
        return existing.clone();
    }

    let base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() {
        "list".to_string()
    } else {
        base
    };
    let mut id = base.clone();
    let mut n = 2;
    while store.lists.iter().any(|l| l.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }

    let list = StoredList { id, name, items };
    store.lists.push(list.clone());
    list
}

/// Save a build list (pasted blueprints + any per-line run overrides) under
/// a name, returning the resolved saved list. Every saved list is
/// user-removable; see [`upsert_list`] for the overwrite-vs-create rule.
#[tauri::command]
pub fn massprod_save_list(
    app: AppHandle,
    name: String,
    items: Vec<SaveListItem>,
) -> Result<BuildList, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("list name can't be empty".into());
    }
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let mut store = load(&dir);

    let stored_items: Vec<StoredLine> = items
        .into_iter()
        .map(|i| StoredLine {
            type_id: i.type_id,
            build_runs: i.build_runs,
        })
        .collect();

    let list = upsert_list(&mut store, name, stored_items);
    save(&dir, &store)?;
    Ok(resolve(&sde, &list))
}

/// Delete a saved build list (no-op if already absent).
#[tauri::command]
pub fn massprod_delete_list(app: AppHandle, id: String) -> Result<(), String> {
    let (dir, _sde) = crate::sde::dir_and_sde(&app)?;
    let mut store = load(&dir);
    lists::delete_by_id(&mut store.lists, &id);
    save(&dir, &store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sde::test_sde;

    fn fixture() -> Sde {
        test_sde(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL);
             INSERT INTO invTypes VALUES (1073, 1, '5MN Microwarpdrive II Blueprint', 0.01);",
        )
    }

    #[test]
    fn resolve_fills_in_sde_names_and_carries_build_runs() {
        let sde = fixture();
        let list = StoredList {
            id: "doctrine".into(),
            name: "Doctrine".into(),
            items: vec![
                StoredLine {
                    type_id: 1073,
                    build_runs: Some(5),
                },
                StoredLine {
                    type_id: 999999,
                    build_runs: None,
                },
            ],
        };

        let resolved = resolve(&sde, &list);

        assert_eq!(resolved.items[0].name, "5MN Microwarpdrive II Blueprint");
        assert_eq!(resolved.items[0].build_runs, Some(5));
        // Unknown type id (stale SDE) falls back to `TypeNameMap`'s own
        // "Type <id>" placeholder instead of erroring the whole list out.
        assert_eq!(resolved.items[1].name, "Type 999999");
        assert_eq!(resolved.items[1].build_runs, None);
    }

    #[test]
    fn upsert_list_overwrites_an_existing_list_with_the_same_name_in_place() {
        let mut store = Store {
            lists: vec![StoredList {
                id: "doctrine".into(),
                name: "Doctrine".into(),
                items: vec![StoredLine {
                    type_id: 1073,
                    build_runs: Some(5),
                }],
            }],
        };

        let saved = upsert_list(
            &mut store,
            "Doctrine".into(),
            vec![StoredLine {
                type_id: 999,
                build_runs: None,
            }],
        );

        // Same id — anything that referenced the old list by id (e.g. a
        // "Load" click mid-edit) still points at the updated one.
        assert_eq!(saved.id, "doctrine");
        assert_eq!(store.lists.len(), 1);
        assert_eq!(store.lists[0].items[0].type_id, 999);
    }

    #[test]
    fn upsert_list_de_duplicates_the_id_when_a_different_name_slugs_to_the_same_base() {
        let mut store = Store {
            lists: vec![StoredList {
                id: "doctrine".into(),
                // A different exact name that happens to slug to the same
                // base as the one being saved below — no exact-name match,
                // so this must hit the new-id path and collide.
                name: "Doctrine!".into(),
                items: vec![],
            }],
        };

        let saved = upsert_list(&mut store, "Doctrine?".into(), vec![]);

        assert_eq!(saved.id, "doctrine-2");
        assert_eq!(store.lists.len(), 2);
    }
}
