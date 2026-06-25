//! Industry Jobs — the character's running and recently-delivered industry jobs
//! ("what's cooking"). Durably merged by job id so delivered jobs persist past
//! ESI's window (a foundation for industry-job cost basis in the profit tracker).
//!
//! Requires the `esi-industry.read_character_jobs.v1` scope (must be enabled on
//! the EVE app + a re-login before this returns data).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{authed_get, resolve_names, AuthState};
use crate::sde::{Sde, SdePaths};
use crate::storage;

/// Raw ESI industry job (the fields we keep). Stored durably, merged by job id.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredJob {
    job_id: i64,
    activity_id: i64,
    blueprint_type_id: i64,
    #[serde(default)]
    product_type_id: Option<i64>,
    runs: i64,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    start_date: String,
    #[serde(default)]
    end_date: String,
    #[serde(default)]
    facility_id: Option<i64>,
    #[serde(default)]
    station_id: Option<i64>,
}

/// One industry job for display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRow {
    pub job_id: i64,
    pub activity: String,
    /// Product (or blueprint, when there's no distinct product) name.
    pub product: String,
    pub runs: i64,
    pub status: String,
    /// Install cost (job fee) in ISK, if reported.
    pub cost: Option<f64>,
    pub start_date: String,
    pub end_date: String,
    pub facility: String,
}

/// ESI industry activity id → label.
fn activity_name(id: i64) -> &'static str {
    match id {
        1 => "Manufacturing",
        3 => "TE Research",
        4 => "ME Research",
        5 => "Copying",
        8 => "Invention",
        9 => "Reactions",
        _ => "Other",
    }
}

/// The character's industry jobs (running + recently delivered), names resolved.
/// Durably accumulates delivered jobs across syncs.
#[tauri::command]
pub async fn industry_jobs(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<JobRow>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let character_id = storage::load_roster(&dir)
        .into_iter()
        .next()
        .map(|c| c.character_id)
        .ok_or_else(|| "Log in a character first".to_string())?;

    // include_completed so delivered jobs (the cost-basis source) come through.
    let incoming: Vec<StoredJob> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/industry/jobs/?include_completed=true"),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Merge into the durable store, keyed by job id (delivered jobs persist).
    let key = format!("industry_jobs_{character_id}");
    let stored: Vec<StoredJob> = storage::load_data(&dir, &key).unwrap_or_default();
    let mut seen: HashSet<i64> = stored.iter().map(|j| j.job_id).collect();
    let mut jobs = stored;
    for j in incoming {
        if seen.insert(j.job_id) {
            jobs.push(j);
        } else if let Some(existing) = jobs.iter_mut().find(|e| e.job_id == j.job_id) {
            // Refresh mutable fields (status/end_date) on a job we already track.
            *existing = j;
        }
    }
    let _ = storage::save_data(&dir, &key, &jobs);

    // Resolve names: product/blueprint via SDE, facility via /universe/names.
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;
    let facility_ids: Vec<i64> = jobs
        .iter()
        .filter_map(|j| j.facility_id.or(j.station_id))
        .collect();
    let facilities = resolve_names(&auth_state, &facility_ids).await;
    let type_name = |id: i64| {
        sde.type_info(id)
            .ok()
            .flatten()
            .map(|t| t.name)
            .unwrap_or_else(|| format!("Type {id}"))
    };

    let mut rows: Vec<JobRow> = jobs
        .into_iter()
        .map(|j| {
            let product = type_name(j.product_type_id.unwrap_or(j.blueprint_type_id));
            let facility = j
                .facility_id
                .or(j.station_id)
                .and_then(|id| facilities.get(&id).cloned())
                .unwrap_or_default();
            JobRow {
                job_id: j.job_id,
                activity: activity_name(j.activity_id).to_string(),
                product,
                runs: j.runs,
                status: j.status,
                cost: j.cost,
                start_date: j.start_date,
                end_date: j.end_date,
                facility,
            }
        })
        .collect();
    // Active jobs first, then most-recently-ending.
    rows.sort_by(|a, b| {
        let rank = |s: &str| if s == "active" || s == "ready" { 0 } else { 1 };
        rank(&a.status)
            .cmp(&rank(&b.status))
            .then_with(|| b.end_date.cmp(&a.end_date))
    });
    Ok(rows)
}
