//! Tauri commands backing the Notes module.
//!
//! Every command takes `shared`: the configured shared (sync) folder, or
//! `None`/blank for none. The frontend owns that setting (it lives in
//! `localStorage`), so it is passed per call; [`store::resolve_root`] turns it
//! into the notes directory. File access runs on a blocking thread — a shared
//! drive can be a slow network mount and must not stall the UI.

use std::path::PathBuf;

use tauri::AppHandle;

use super::store;
use super::types::{NoteEntry, NoteKind, NoteTree, NotesLocation, SaveResult, SearchHit};
use crate::model::AppError;

/// Resolve the active notes root, then run `job` against it on a blocking thread.
async fn with_root<T, F>(app: &AppHandle, shared: Option<String>, job: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(PathBuf) -> Result<T, String> + Send + 'static,
{
    let app_data = crate::storage::app_data_dir(app)?;
    let root = store::resolve_root(&app_data, shared.as_deref());
    tokio::task::spawn_blocking(move || job(root))
        .await
        .map_err(|e| AppError::from(e.to_string()))?
        .map_err(AppError::from)
}

/// Where notes live now, and how many local notes aren't in the shared store.
#[tauri::command]
pub async fn notes_location(
    app: AppHandle,
    shared: Option<String>,
) -> Result<NotesLocation, AppError> {
    let app_data = crate::storage::app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let root = store::resolve_root(&app_data, shared.as_deref());
        let is_shared = shared.as_deref().is_some_and(|s| !s.trim().is_empty());
        NotesLocation {
            local_only: if is_shared {
                store::local_only(&app_data, &root)
            } else {
                0
            },
            root: root.display().to_string(),
            shared: is_shared,
        }
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))
}

/// Copy this device's local notes into the shared store (never overwrites).
/// Returns how many were copied.
#[tauri::command]
pub async fn notes_import_local(app: AppHandle, shared: String) -> Result<u32, AppError> {
    if shared.trim().is_empty() {
        return Err("No shared folder is configured".into());
    }
    let app_data = crate::storage::app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        store::import_local(&app_data, &store::shared_root(shared.trim()))
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
    .map_err(AppError::from)
}

/// Every folder and note (metadata only).
#[tauri::command]
pub async fn notes_tree(app: AppHandle, shared: Option<String>) -> Result<NoteTree, AppError> {
    with_root(&app, shared, |root| Ok(store::list(&root))).await
}

/// A note's text content.
#[tauri::command]
pub async fn notes_read(
    app: AppHandle,
    shared: Option<String>,
    path: String,
) -> Result<String, AppError> {
    with_root(&app, shared, move |root| store::read(&root, &path)).await
}

/// Create a note in `folder` (name de-duplicated with a numeric suffix).
#[tauri::command]
pub async fn notes_create(
    app: AppHandle,
    shared: Option<String>,
    folder: String,
    name: String,
    kind: NoteKind,
    content: String,
) -> Result<NoteEntry, AppError> {
    with_root(&app, shared, move |root| {
        store::create(&root, &folder, &name, kind, &content)
    })
    .await
}

/// Save a note's content. `expected_updated_at` guards against overwriting a
/// change made elsewhere; omit it to overwrite unconditionally.
#[tauri::command]
pub async fn notes_save(
    app: AppHandle,
    shared: Option<String>,
    path: String,
    content: String,
    expected_updated_at: Option<i64>,
) -> Result<SaveResult, AppError> {
    with_root(&app, shared, move |root| {
        store::save(&root, &path, &content, expected_updated_at)
    })
    .await
}

#[tauri::command]
pub async fn notes_rename(
    app: AppHandle,
    shared: Option<String>,
    path: String,
    name: String,
) -> Result<NoteEntry, AppError> {
    with_root(&app, shared, move |root| store::rename(&root, &path, &name)).await
}

#[tauri::command]
pub async fn notes_move(
    app: AppHandle,
    shared: Option<String>,
    path: String,
    folder: String,
) -> Result<NoteEntry, AppError> {
    with_root(&app, shared, move |root| {
        store::move_note(&root, &path, &folder)
    })
    .await
}

#[tauri::command]
pub async fn notes_delete(
    app: AppHandle,
    shared: Option<String>,
    path: String,
) -> Result<(), AppError> {
    with_root(&app, shared, move |root| store::delete(&root, &path)).await
}

/// Replace a note's tags (normalised server-side).
#[tauri::command]
pub async fn notes_set_tags(
    app: AppHandle,
    shared: Option<String>,
    path: String,
    tags: Vec<String>,
) -> Result<NoteEntry, AppError> {
    with_root(&app, shared, move |root| {
        store::set_tags(&root, &path, &tags)
    })
    .await
}

/// Create a folder; returns its relative path.
#[tauri::command]
pub async fn notes_create_folder(
    app: AppHandle,
    shared: Option<String>,
    parent: String,
    name: String,
) -> Result<String, AppError> {
    with_root(&app, shared, move |root| {
        store::create_folder(&root, &parent, &name)
    })
    .await
}

/// Rename a folder; returns its new relative path.
#[tauri::command]
pub async fn notes_rename_folder(
    app: AppHandle,
    shared: Option<String>,
    path: String,
    name: String,
) -> Result<String, AppError> {
    with_root(&app, shared, move |root| {
        store::rename_folder(&root, &path, &name)
    })
    .await
}

/// Move a folder under `parent`; returns its new relative path.
#[tauri::command]
pub async fn notes_move_folder(
    app: AppHandle,
    shared: Option<String>,
    path: String,
    parent: String,
) -> Result<String, AppError> {
    with_root(&app, shared, move |root| {
        store::move_folder(&root, &path, &parent)
    })
    .await
}

/// Delete a folder and everything in it.
#[tauri::command]
pub async fn notes_delete_folder(
    app: AppHandle,
    shared: Option<String>,
    path: String,
) -> Result<(), AppError> {
    with_root(&app, shared, move |root| store::delete_folder(&root, &path)).await
}

/// Full-text search over names, folders, tags and content.
#[tauri::command]
pub async fn notes_search(
    app: AppHandle,
    shared: Option<String>,
    query: String,
) -> Result<Vec<SearchHit>, AppError> {
    with_root(&app, shared, move |root| Ok(store::search(&root, &query))).await
}
