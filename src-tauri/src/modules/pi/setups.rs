//! Persisted "setups" for the PI Planner — a named, reusable set of planned
//! commodities, each with its own notes and (optional) solar
//! system/planet — so a recurring plan (e.g. a standing Robotics chain
//! across three colonies) can be saved once and reloaded without re-picking
//! every commodity and re-typing every note (#965).
//!
//! Mirrors Mass Production's "build lists" / Shopping Lists' single-JSON-
//! document-per-feature approach (`crate::lists::load_store`/`save_store`,
//! themselves thin wrappers around `crate::storage::load_data`/`save_data`):
//! one `pi_planner_setups` document holding every saved setup. Commodity
//! display names are resolved from the SDE only when read out (same as
//! `massprod::lists`), so they stay correct across SDE updates; notes and
//! the chosen system/planet are free-form/user-picked and have no SDE
//! source of truth to re-resolve against, so they're stored and returned
//! verbatim.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::lists::{self, Identified};
use crate::sde::Sde;

/// Storage document name (a JSON file in `<app data>/data/`).
const STORE_KEY: &str = "pi_planner_setups";

// --- Stored shape -----------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Store {
    setups: Vec<StoredSetup>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct StoredSetup {
    id: String,
    name: String,
    #[serde(default)]
    items: Vec<StoredItem>,
}

impl Identified for StoredSetup {
    fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredItem {
    type_id: i64,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    system_id: Option<i64>,
    #[serde(default)]
    system_name: Option<String>,
    #[serde(default)]
    planet_id: Option<i64>,
    #[serde(default)]
    planet_name: Option<String>,
    /// Material type ids within this item's own production chain that are
    /// marked "produced on another planned colony, ship it in instead" —
    /// matched against another item's `type_id` in the same setup at read
    /// time on the frontend (no SDE/cross-item resolution needed here,
    /// same free-form pass-through as notes/system/planet).
    #[serde(default)]
    imports: Vec<i64>,
    /// A user-chosen display name for this item, overriding the frontend's
    /// own "System · Planet · Product" default — `None` means "still using
    /// the auto-derived default", not "no name".
    #[serde(default)]
    label: Option<String>,
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
pub struct SetupItem {
    pub type_id: i64,
    pub name: String,
    pub notes: String,
    pub system_id: Option<i64>,
    pub system_name: Option<String>,
    pub planet_id: Option<i64>,
    pub planet_name: Option<String>,
    pub imports: Vec<i64>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerSetup {
    pub id: String,
    pub name: String,
    pub items: Vec<SetupItem>,
}

/// Resolve a stored setup's commodity names from the SDE.
fn resolve(sde: &Sde, setup: &StoredSetup) -> PlannerSetup {
    let ids: Vec<i64> = setup.items.iter().map(|e| e.type_id).collect();
    let names = sde.type_name_map(&ids).unwrap_or_default();
    let items = setup
        .items
        .iter()
        .map(|e| SetupItem {
            type_id: e.type_id,
            name: names.get(e.type_id),
            notes: e.notes.clone(),
            system_id: e.system_id,
            system_name: e.system_name.clone(),
            planet_id: e.planet_id,
            planet_name: e.planet_name.clone(),
            imports: e.imports.clone(),
            label: e.label.clone(),
        })
        .collect();
    PlannerSetup {
        id: setup.id.clone(),
        name: setup.name.clone(),
        items,
    }
}

// --- Commands ---------------------------------------------------------------

/// Every saved planner setup (commodity names resolved from the SDE).
#[tauri::command]
pub fn pi_planner_setups(app: AppHandle) -> Result<Vec<PlannerSetup>, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let store = load(&dir);
    Ok(store.setups.iter().map(|s| resolve(&sde, s)).collect())
}

/// One item to save: a picked commodity, its notes, and the (optional)
/// system/planet the user assigned it — the frontend already has all of
/// this from the current working plan, so saving needs no SDE lookups.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSetupItem {
    pub type_id: i64,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub system_id: Option<i64>,
    #[serde(default)]
    pub system_name: Option<String>,
    #[serde(default)]
    pub planet_id: Option<i64>,
    #[serde(default)]
    pub planet_name: Option<String>,
    #[serde(default)]
    pub imports: Vec<i64>,
    #[serde(default)]
    pub label: Option<String>,
}

/// Save the current planner picks under a name, returning the resolved
/// saved setup. The id is a slug of the name, de-duplicated with a numeric
/// suffix (same scheme as `shopping_create_list`/`massprod_save_list`).
/// Every saved setup is user-removable.
#[tauri::command]
pub fn pi_planner_setup_save(
    app: AppHandle,
    name: String,
    items: Vec<SaveSetupItem>,
) -> Result<PlannerSetup, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("setup name can't be empty".into());
    }
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let mut store = load(&dir);

    let existing: Vec<String> = store.setups.iter().map(|s| s.id.clone()).collect();
    let id = crate::lists::slug_id(&name, &existing, "setup");

    let setup = StoredSetup {
        id,
        name,
        items: items
            .into_iter()
            .map(|i| StoredItem {
                type_id: i.type_id,
                notes: i.notes,
                system_id: i.system_id,
                system_name: i.system_name,
                planet_id: i.planet_id,
                planet_name: i.planet_name,
                imports: i.imports,
                label: i.label,
            })
            .collect(),
    };
    store.setups.push(setup.clone());
    save(&dir, &store)?;
    Ok(resolve(&sde, &setup))
}

/// Delete a saved planner setup (no-op if already absent).
#[tauri::command]
pub fn pi_planner_setup_delete(app: AppHandle, id: String) -> Result<(), String> {
    let (dir, _sde) = crate::sde::dir_and_sde(&app)?;
    let mut store = load(&dir);
    lists::delete_by_id(&mut store.setups, &id);
    save(&dir, &store)
}

// --- Sync (#1128) ------------------------------------------------------
//
// Folder sync (`src/lib/sync/`) syncs the PI planner store's *raw* (stored,
// unresolved) shape, not `pi_planner_setups`' SDE-resolved one — a resolved
// setup is derivable from the stored one plus whatever SDE the receiving
// device has, so shipping the raw `StoredSetup` list keeps the synced
// payload small and SDE-version-agnostic.

/// The raw stored planner setups, serialized to JSON (`"[]"` when none) —
/// the sync payload for the `pi` module.
#[tauri::command]
pub fn pi_planner_setups_export(app: AppHandle) -> Result<String, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    export_json(&dir)
}

/// Overwrite the stored planner setups from a JSON array previously produced
/// by [`pi_planner_setups_export`]. Parses fully before writing anything, so
/// a malformed `content` never leaves a partial store on disk.
#[tauri::command]
pub fn pi_planner_setups_import(app: AppHandle, content: String) -> Result<(), String> {
    let dir = crate::storage::app_data_dir(&app)?;
    import_json(&dir, &content)
}

fn export_json(dir: &std::path::Path) -> Result<String, String> {
    let store = load(dir);
    serde_json::to_string(&store.setups).map_err(|e| e.to_string())
}

fn import_json(dir: &std::path::Path, content: &str) -> Result<(), String> {
    let setups: Vec<StoredSetup> =
        serde_json::from_str(content).map_err(|e| format!("invalid planner setups JSON: {e}"))?;
    save(dir, &Store { setups })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sde::test_sde;

    /// Pins the on-disk JSON shape of the `pi_planner_setups` store
    /// document. This is a fixed JSON literal written by a prior version of
    /// the app — it MUST keep parsing (so existing users' saved setups still
    /// load) and MUST serialize back to exactly the same shape (so a
    /// refactor of the in-memory types never silently changes the storage
    /// format).
    #[test]
    fn store_round_trips_through_its_on_disk_json_shape() {
        let json = r#"{
            "setups": [
                {
                    "id": "jita-industry",
                    "name": "Jita industry",
                    "items": [
                        {
                            "typeId": 9848,
                            "notes": "stage 2: Robotics run",
                            "systemId": 30000142,
                            "systemName": "Jita",
                            "planetId": 40009082,
                            "planetName": "Jita IV",
                            "imports": [9838],
                            "label": "Mechanical Parts factory"
                        },
                        {
                            "typeId": 999999,
                            "notes": "",
                            "systemId": null,
                            "systemName": null,
                            "planetId": null,
                            "planetName": null,
                            "imports": [],
                            "label": null
                        }
                    ]
                }
            ]
        }"#;

        let store: Store =
            serde_json::from_str(json).expect("existing on-disk shape must still parse");
        assert_eq!(store.setups[0].id, "jita-industry");
        assert_eq!(store.setups[0].items[0].type_id, 9848);
        assert_eq!(store.setups[0].items[0].notes, "stage 2: Robotics run");
        assert_eq!(store.setups[0].items[0].system_id, Some(30000142));
        assert_eq!(store.setups[0].items[0].imports, vec![9838]);
        assert_eq!(
            store.setups[0].items[0].label.as_deref(),
            Some("Mechanical Parts factory")
        );
        assert_eq!(store.setups[0].items[1].system_id, None);

        let round_tripped = serde_json::to_value(&store).unwrap();
        let original: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(
            round_tripped, original,
            "serialized shape must match the on-disk format exactly"
        );
    }

    fn fixture() -> Sde {
        test_sde(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL);
             INSERT INTO invTypes VALUES (9848, 1, 'Robotics', 0.01);",
        )
    }

    #[test]
    fn resolve_fills_in_sde_name_and_carries_notes_system_planet() {
        let sde = fixture();
        let setup = StoredSetup {
            id: "jita-industry".into(),
            name: "Jita industry".into(),
            items: vec![
                StoredItem {
                    type_id: 9848,
                    notes: "stage 2: Robotics run".into(),
                    system_id: Some(30000142),
                    system_name: Some("Jita".into()),
                    planet_id: Some(40009082),
                    planet_name: Some("Jita IV".into()),
                    imports: vec![],
                    label: None,
                },
                StoredItem {
                    type_id: 999999,
                    notes: String::new(),
                    system_id: None,
                    system_name: None,
                    planet_id: None,
                    planet_name: None,
                    imports: vec![],
                    label: None,
                },
            ],
        };

        let resolved = resolve(&sde, &setup);

        assert_eq!(resolved.items[0].name, "Robotics");
        assert_eq!(resolved.items[0].notes, "stage 2: Robotics run");
        assert_eq!(resolved.items[0].system_name.as_deref(), Some("Jita"));
        assert_eq!(resolved.items[0].planet_name.as_deref(), Some("Jita IV"));
        // Unknown type id (stale SDE) falls back to `TypeNameMap`'s own
        // "Type <id>" placeholder instead of erroring the whole setup out.
        assert_eq!(resolved.items[1].name, "Type 999999");
        assert_eq!(resolved.items[1].system_id, None);
    }

    #[test]
    fn resolve_carries_imported_material_type_ids_through_unchanged() {
        let sde = fixture();
        let setup = StoredSetup {
            id: "multi-colony".into(),
            name: "Multi colony".into(),
            items: vec![StoredItem {
                type_id: 9848,
                notes: String::new(),
                system_id: None,
                system_name: None,
                planet_id: None,
                planet_name: None,
                // Pretend 9838 (Mechanical Parts) is shipped in from
                // another colony in the same setup instead of being
                // produced locally.
                imports: vec![9838],
                label: None,
            }],
        };

        let resolved = resolve(&sde, &setup);

        assert_eq!(resolved.items[0].imports, vec![9838]);
    }

    #[test]
    fn resolve_carries_a_custom_label_through_unchanged() {
        let sde = fixture();
        let setup = StoredSetup {
            id: "multi-colony".into(),
            name: "Multi colony".into(),
            items: vec![StoredItem {
                type_id: 9848,
                notes: String::new(),
                system_id: None,
                system_name: None,
                planet_id: None,
                planet_name: None,
                imports: vec![],
                label: Some("Mechanical Parts factory".into()),
            }],
        };

        let resolved = resolve(&sde, &setup);

        assert_eq!(
            resolved.items[0].label.as_deref(),
            Some("Mechanical Parts factory")
        );
    }

    fn sync_test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "eve-pi-setups-sync-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn export_json_is_empty_array_when_nothing_saved() {
        let dir = sync_test_dir("empty");
        assert_eq!(export_json(&dir).unwrap(), "[]");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_then_import_round_trips_the_raw_store() {
        let dir = sync_test_dir("roundtrip");
        let setup = StoredSetup {
            id: "jita-industry".into(),
            name: "Jita industry".into(),
            items: vec![StoredItem {
                type_id: 9848,
                notes: "stage 2".into(),
                system_id: Some(30000142),
                system_name: Some("Jita".into()),
                planet_id: None,
                planet_name: None,
                imports: vec![9838],
                label: None,
            }],
        };
        save(
            &dir,
            &Store {
                setups: vec![setup],
            },
        )
        .unwrap();

        let exported = export_json(&dir).unwrap();

        // Importing into a fresh dir reproduces the same store.
        let other_dir = sync_test_dir("roundtrip-other");
        import_json(&other_dir, &exported).unwrap();
        assert_eq!(load(&other_dir).setups, load(&dir).setups);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other_dir);
    }

    #[test]
    fn import_json_rejects_invalid_json_without_writing() {
        let dir = sync_test_dir("invalid");
        let err = import_json(&dir, "not json").expect_err("invalid JSON must error");
        assert!(err.contains("invalid planner setups JSON"));
        // No partial write: the store still loads as empty.
        assert!(load(&dir).setups.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
