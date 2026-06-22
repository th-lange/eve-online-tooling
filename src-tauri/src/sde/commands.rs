//! Tauri command surface for the SDE service.
//!
//! Query commands open the database read-only per call (cheap), so they always
//! see the latest data after an update. Progress during an update is emitted on
//! the `sde://progress` event.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::types::{BlueprintMaterial, BlueprintProduct, ManufacturableBlueprint, TypeInfo};
use super::{download_sde, Sde, SdeError, SdePaths};

/// Installation state of the local SDE.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeStatus {
    pub installed: bool,
    pub path: String,
    pub size_bytes: Option<u64>,
}

fn paths(app: &AppHandle) -> Result<SdePaths, SdeError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| SdeError::Path(e.to_string()))?;
    Ok(SdePaths::new(dir))
}

fn status_of(paths: &SdePaths) -> SdeStatus {
    let size_bytes = std::fs::metadata(&paths.db).ok().map(|m| m.len());
    SdeStatus {
        installed: paths.is_installed(),
        path: paths.db.display().to_string(),
        size_bytes,
    }
}

fn open(app: &AppHandle) -> Result<Sde, String> {
    let paths = paths(app).map_err(|e| e.to_string())?;
    Sde::open(&paths.db).map_err(|e| e.to_string())
}

/// Whether the SDE is installed locally, and where.
#[tauri::command]
pub fn sde_status(app: AppHandle) -> Result<SdeStatus, String> {
    let paths = paths(&app).map_err(|e| e.to_string())?;
    Ok(status_of(&paths))
}

/// Download/refresh the SDE. No-op if already installed unless `force` is set.
/// Emits `sde://progress` events throughout.
#[tauri::command]
pub async fn sde_update(app: AppHandle, force: bool) -> Result<SdeStatus, String> {
    let paths = paths(&app).map_err(|e| e.to_string())?;
    if paths.is_installed() && !force {
        return Ok(status_of(&paths));
    }
    let app_for_events = app.clone();
    download_sde(&paths, move |progress| {
        let _ = app_for_events.emit("sde://progress", &progress);
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(status_of(&paths))
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
