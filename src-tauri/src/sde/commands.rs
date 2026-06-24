//! Tauri command surface for the SDE service.
//!
//! Query commands open the database read-only per call (cheap), so they always
//! see the latest data after an update. Progress during an update is emitted on
//! the `sde://progress` event.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::types::{
    BlueprintMaterial, BlueprintProduct, ManufacturableBlueprint, TypeDetail, TypeInfo,
};
use super::{download_sde, Sde, SdeError, SdePaths};

/// An (id, name) pair for the universe browser tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdName {
    pub id: i64,
    pub name: String,
}

fn id_names(pairs: Vec<(i64, String)>) -> Vec<IdName> {
    pairs.into_iter().map(|(id, name)| IdName { id, name }).collect()
}

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

fn paths(app: &AppHandle) -> Result<SdePaths, SdeError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| SdeError::Path(e.to_string()))?;
    Ok(SdePaths::new(dir))
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
fn read_local_md5(paths: &SdePaths) -> Option<String> {
    std::fs::read_to_string(md5_path(paths))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Fetch Fuzzwork's published md5 for the current SDE (small request). `None`
/// if it can't be fetched/parsed.
async fn fetch_remote_md5() -> Option<String> {
    let url = format!("{}.md5sum", super::SDE_URL);
    let client = reqwest::Client::builder()
        .user_agent(crate::esi::USER_AGENT)
        .build()
        .ok()?;
    let text = client
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

fn open(app: &AppHandle) -> Result<Sde, String> {
    let paths = paths(app).map_err(|e| e.to_string())?;
    Sde::open(&paths.db).map_err(|e| e.to_string())
}

/// Whether the SDE is installed locally, and where.
#[tauri::command]
pub fn sde_status(app: AppHandle) -> Result<SdeStatus, String> {
    let paths = paths(&app).map_err(|e| e.to_string())?;
    Ok(status_of(&paths, false))
}

/// Download/refresh the SDE, emitting `sde://progress` throughout.
///
/// When already installed and `force` is false, it only re-downloads if
/// Fuzzwork's published md5 differs from the one we stored — i.e. it updates
/// only when the data actually changed.
#[tauri::command]
pub async fn sde_update(app: AppHandle, force: bool) -> Result<SdeStatus, String> {
    let paths = paths(&app).map_err(|e| e.to_string())?;

    if paths.is_installed() && !force {
        let changed = match (read_local_md5(&paths), fetch_remote_md5().await) {
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
        let _ = std::fs::write(md5_path(&paths), remote);
    }
    Ok(status_of(&paths, true))
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

#[tauri::command]
pub fn sde_groups(app: AppHandle, category_id: i64, published_only: bool) -> Result<Vec<IdName>, String> {
    open(&app)?
        .universe_groups(category_id, published_only)
        .map(id_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sde_types(app: AppHandle, group_id: i64, published_only: bool) -> Result<Vec<IdName>, String> {
    open(&app)?
        .universe_types(group_id, published_only)
        .map(id_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sde_type_detail(app: AppHandle, type_id: i64) -> Result<Option<TypeDetail>, String> {
    open(&app)?.type_detail(type_id).map_err(|e| e.to_string())
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
