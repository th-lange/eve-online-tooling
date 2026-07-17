//! Tauri commands backing the Scripts module: CRUD over the stored snippets and
//! a `scripts_run` that executes one (a stored script by id, or an ad-hoc
//! `code` + `language`) on a blocking thread and returns its [`ScriptRun`].

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::AppHandle;

use crate::model::AppError;

use super::engine::{self, Limits};
use super::host::{Host, HostCtx};
use super::store;
use super::types::{Language, Script, ScriptRun};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::storage::app_data_dir(app)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// Every stored script.
#[tauri::command]
pub fn scripts_list(app: AppHandle) -> Result<Vec<Script>, AppError> {
    Ok(store::load(&data_dir(&app)?))
}

/// The bundled example scripts offered in the editor.
#[tauri::command]
pub fn scripts_examples() -> Vec<super::examples::ExampleScript> {
    super::examples::examples()
}

/// Create or update a script (upsert by id), returning the full updated set.
/// A blank id means "new": one is minted from the name.
#[tauri::command]
pub fn scripts_save(app: AppHandle, script: Script) -> Result<Vec<Script>, AppError> {
    let dir = data_dir(&app)?;
    let mut scripts = store::load(&dir);
    let mut script = script;
    if script.id.trim().is_empty() {
        script.id = store::unique_id(&scripts, &script.name);
    }
    script.updated_at = now();
    match scripts.iter_mut().find(|s| s.id == script.id) {
        Some(existing) => *existing = script,
        None => scripts.push(script),
    }
    store::save(&dir, &scripts)?;
    Ok(scripts)
}

/// Delete a script (and its private key/value store), returning what remains.
#[tauri::command]
pub fn scripts_delete(app: AppHandle, id: String) -> Result<Vec<Script>, AppError> {
    let dir = data_dir(&app)?;
    let mut scripts = store::load(&dir);
    scripts.retain(|s| s.id != id);
    store::save(&dir, &scripts)?;
    store::clear_kv(&dir, &id);
    Ok(scripts)
}

/// Arguments for [`scripts_run`]: either a stored `id`, or ad-hoc `code` +
/// `language` (e.g. the editor's "Run" before a first save).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArgs {
    pub id: Option<String>,
    pub code: Option<String>,
    pub language: Option<Language>,
}

/// Run a snippet once and return its result, logs, and timing. Execution
/// happens on a blocking thread because the host API drives async services to
/// completion (`block_on`); it's bounded by [`Limits`] so it can't hang the app.
#[tauri::command]
pub async fn scripts_run(app: AppHandle, args: RunArgs) -> Result<ScriptRun, AppError> {
    let dir = data_dir(&app)?;

    let (script_id, language, code) = match args.id {
        Some(id) => {
            let script = store::load(&dir)
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| AppError::from(format!("no script {id:?}")))?;
            (script.id, script.language, script.code)
        }
        None => {
            let code = args
                .code
                .ok_or_else(|| AppError::from("scripts_run needs an id or code"))?;
            let language = args
                .language
                .ok_or_else(|| AppError::from("an ad-hoc run needs a language"))?;
            ("<adhoc>".to_string(), language, code)
        }
    };

    let host: Arc<dyn Host> = Arc::new(HostCtx::new(app.clone(), dir, script_id));
    let run =
        tokio::task::spawn_blocking(move || engine::run(host, language, &code, &Limits::default()))
            .await
            .map_err(|e| AppError::from(e.to_string()))?;

    Ok(run)
}
