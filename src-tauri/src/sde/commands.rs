//! Tauri command surface for the SDE service.
//!
//! Query commands open the database read-only per call (cheap), so they always
//! see the latest data after an update. Progress during an update is emitted on
//! the `sde://progress` event.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::types::{
    BlueprintMaterial, BlueprintProduct, ManufacturableBlueprint, TypeDetail, TypeInfo,
};
use super::{download_sde, Sde, SdePaths};

pub use crate::model::{id_names, IdName};

/// A named dogma attribute value.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttrPair {
    pub name: String,
    pub value: f64,
}

/// Installation state of the local SDE.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeStatus {
    pub installed: bool,
    pub path: String,
    pub size_bytes: Option<u64>,
    /// Whether this call actually (re)downloaded the database.
    pub updated: bool,
}

/// Resolve [`SdePaths`] for this app. Goes through [`crate::storage::app_data_dir`]
/// (the single call site for the raw Tauri path API) rather than calling
/// `app.path().app_data_dir()` directly.
fn paths(app: &AppHandle) -> Result<SdePaths, String> {
    Ok(SdePaths::new(crate::storage::app_data_dir(app)?))
}

fn status_of(paths: &SdePaths, updated: bool) -> SdeStatus {
    let size_bytes = std::fs::metadata(&paths.db).ok().map(|m| m.len());
    SdeStatus {
        installed: paths.is_installed(),
        path: paths.db.display().to_string(),
        size_bytes,
        updated,
    }
}

fn md5_path(paths: &SdePaths) -> std::path::PathBuf {
    paths.dir.join("sde.md5")
}

/// The md5 of the SDE we last downloaded (sidecar file), if any.
async fn read_local_md5(paths: &SdePaths) -> Option<String> {
    tokio::fs::read_to_string(md5_path(paths))
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Shared HTTP client for the small SDE metadata request (the md5 sidecar).
/// Built once and reused so repeated freshness checks (startup auto-refresh and
/// every manual update) don't each spin up a fresh connection pool.
fn metadata_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        crate::esi::http_client_builder()
            .build()
            .expect("failed to build SDE metadata HTTP client")
    })
}

/// Fetch Fuzzwork's published md5 for the current SDE (small request). `None`
/// if it can't be fetched/parsed.
async fn fetch_remote_md5() -> Option<String> {
    let url = format!("{}.md5sum", super::SDE_URL);
    let text = metadata_client()
        .get(url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    text.split_whitespace().next().map(|s| s.to_string())
}

/// Open the SDE for this app — a local shorthand for the shared
/// [`super::open_from_app`] helper the query commands all use.
fn open(app: &AppHandle) -> Result<Sde, String> {
    super::open_from_app(app)
}

/// Whether the SDE is installed locally, and where.
#[tauri::command]
pub fn sde_status(app: AppHandle) -> Result<SdeStatus, String> {
    let paths = paths(&app)?;
    Ok(status_of(&paths, false))
}

/// Download/refresh the SDE, emitting `sde://progress` throughout.
///
/// When already installed and `force` is false, it only re-downloads if
/// Fuzzwork's published md5 differs from the one we stored — i.e. it updates
/// only when the data actually changed.
#[tauri::command]
pub async fn sde_update(app: AppHandle, force: bool) -> Result<SdeStatus, String> {
    let paths = paths(&app)?;

    if paths.is_installed() && !force {
        let changed = match (read_local_md5(&paths).await, fetch_remote_md5().await) {
            (Some(local), Some(remote)) => local != remote,
            // Can't determine (no stored md5 or fetch failed): don't surprise
            // the user with a multi-hundred-MB re-download.
            _ => false,
        };
        if !changed {
            return Ok(status_of(&paths, false));
        }
    }

    let app_for_events = app.clone();
    download_sde(&paths, move |progress| {
        let _ = app_for_events.emit("sde://progress", &progress);
    })
    .await
    .map_err(|e| e.to_string())?;

    // Record the md5 we just installed so future checks can short-circuit.
    if let Some(remote) = fetch_remote_md5().await {
        let _ = tokio::fs::write(md5_path(&paths), remote).await;
    }
    Ok(status_of(&paths, true))
}

/// Storage key for the last startup SDE freshness check (epoch secs).
const AUTOCHECK_KEY: &str = "sde_last_autocheck";
/// Don't auto-check more than once a day.
const AUTOCHECK_INTERVAL: u64 = 24 * 3600;

/// Best-effort daily SDE freshness check, run at startup. Only when the SDE is
/// already installed (first-time download stays a deliberate user action), and
/// at most once per day; re-downloads only if Fuzzwork's md5 changed. The SDE
/// updates ~daily with the game, so this keeps static data current without the
/// user clicking "Update". Silent on any failure.
pub async fn auto_refresh(app: &AppHandle) {
    let Ok(paths) = paths(app) else {
        return;
    };
    if !paths.is_installed() {
        return;
    }
    let now = crate::util::time::now_secs();
    if let Some(last) = crate::storage::load_data::<u64>(&paths.dir, AUTOCHECK_KEY) {
        if now.saturating_sub(last) < AUTOCHECK_INTERVAL {
            return;
        }
    }
    // Record the attempt up front so a slow/failed check doesn't retry every
    // launch within the day.
    let _ = crate::storage::save_data(&paths.dir, AUTOCHECK_KEY, &now);
    let _ = sde_update(app.clone(), false).await;
}

/// Manufacturing inputs for a blueprint.
#[tauri::command]
pub fn sde_blueprint_materials(
    app: AppHandle,
    blueprint_type_id: i64,
) -> Result<Vec<BlueprintMaterial>, String> {
    open(&app)?
        .blueprint_materials(blueprint_type_id)
        .map_err(|e| e.to_string())
}

/// What a blueprint manufactures.
#[tauri::command]
pub fn sde_blueprint_product(
    app: AppHandle,
    blueprint_type_id: i64,
) -> Result<Option<BlueprintProduct>, String> {
    open(&app)?
        .blueprint_product(blueprint_type_id)
        .map_err(|e| e.to_string())
}

/// Type name/group/volume for a type id.
#[tauri::command]
pub fn sde_type_info(app: AppHandle, type_id: i64) -> Result<Option<TypeInfo>, String> {
    open(&app)?.type_info(type_id).map_err(|e| e.to_string())
}

/// Every manufacturable blueprint.
#[tauri::command]
pub fn sde_manufacturable_blueprints(
    app: AppHandle,
) -> Result<Vec<ManufacturableBlueprint>, String> {
    open(&app)?
        .manufacturable_blueprints()
        .map_err(|e| e.to_string())
}

// --- Universe browser ---

#[tauri::command]
pub fn sde_categories(app: AppHandle) -> Result<Vec<IdName>, String> {
    open(&app)?
        .universe_categories()
        .map(id_names)
        .map_err(|e| e.to_string())
}

/// Categories that contain at least one marketable item — for the daytrading
/// category whitelist selector (a strict subset of `sde_categories`).
#[tauri::command]
pub fn sde_market_categories(app: AppHandle) -> Result<Vec<IdName>, String> {
    open(&app)?
        .market_categories()
        .map(id_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sde_groups(
    app: AppHandle,
    category_id: i64,
    published_only: bool,
) -> Result<Vec<IdName>, String> {
    open(&app)?
        .universe_groups(category_id, published_only)
        .map(id_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sde_types(
    app: AppHandle,
    group_id: i64,
    published_only: bool,
) -> Result<Vec<IdName>, String> {
    open(&app)?
        .universe_types(group_id, published_only)
        .map(id_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sde_type_detail(app: AppHandle, type_id: i64) -> Result<Option<TypeDetail>, String> {
    open(&app)?.type_detail(type_id).map_err(|e| e.to_string())
}

/// Search marketable types by name (for pickers).
#[tauri::command]
pub fn sde_search(app: AppHandle, query: String) -> Result<Vec<IdName>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    open(&app)?
        .search_types(&query, 25)
        .map(id_names)
        .map_err(|e| e.to_string())
}

/// Search published ships only (for the fitting hull picker).
#[tauri::command]
pub fn sde_search_ships(app: AppHandle, query: String) -> Result<Vec<IdName>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    open(&app)?
        .search_ships(&query, 25)
        .map(id_names)
        .map_err(|e| e.to_string())
}

/// A market-group node in the browse tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketGroupNode {
    pub id: i64,
    pub name: String,
    /// True when this group holds items directly (a leaf level).
    pub has_types: bool,
}

/// A leaf item with its meta-group label (Tech I/II, Faction, …).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketGroupItem {
    pub id: i64,
    pub name: String,
    pub meta_group: String,
}

/// One level of the market-group tree: child groups + leaf items.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarketGroupChildren {
    pub groups: Vec<MarketGroupNode>,
    pub items: Vec<MarketGroupItem>,
}

/// Children of a market group (or the top level when `parent_id` is null), for
/// the fitting browse-by-category picker (#266). Lazy-loaded per drill-down step.
#[tauri::command]
pub fn sde_market_group_children(
    app: AppHandle,
    parent_id: Option<i64>,
) -> Result<MarketGroupChildren, String> {
    let (groups, items) = open(&app)?
        .market_group_children(parent_id)
        .map_err(|e| e.to_string())?;
    Ok(MarketGroupChildren {
        groups: groups
            .into_iter()
            .map(|(id, name, has_types)| MarketGroupNode {
                id,
                name,
                has_types,
            })
            .collect(),
        items: items
            .into_iter()
            .map(|(id, name, meta_group)| MarketGroupItem {
                id,
                name,
                meta_group,
            })
            .collect(),
    })
}

/// Names for a set of type ids (bulk) — for showing fitted-item names.
#[tauri::command]
pub fn sde_type_names(app: AppHandle, type_ids: Vec<i64>) -> Result<Vec<IdName>, String> {
    open(&app)?
        .type_names(&type_ids)
        .map(id_names)
        .map_err(|e| e.to_string())
}

/// `(id, name, group)` for a set of type ids — for grouping fits by ship group.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeBrief {
    pub id: i64,
    pub name: String,
    pub group: String,
}

#[tauri::command]
pub fn sde_type_infos(app: AppHandle, type_ids: Vec<i64>) -> Result<Vec<TypeBrief>, String> {
    Ok(open(&app)?
        .type_infos(&type_ids)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, name, group)| TypeBrief { id, name, group })
        .collect())
}

#[tauri::command]
pub fn sde_type_attributes(app: AppHandle, type_id: i64) -> Result<Vec<AttrPair>, String> {
    let attrs = open(&app)?
        .type_attributes(type_id)
        .map_err(|e| e.to_string())?;
    Ok(attrs
        .into_iter()
        .map(|(name, value)| AttrPair { name, value })
        .collect())
}
