//! Industry Jobs — the character's running and recently-delivered industry jobs
//! ("what's cooking"). Durably merged by job id so delivered jobs persist past
//! ESI's window (a foundation for industry-job cost basis in the profit tracker).
//!
//! Requires the `esi-industry.read_character_jobs.v1` scope (must be enabled on
//! the EVE app + a re-login before this returns data).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{authed_get, resolve_names, AuthError, AuthState};
use crate::sde::{Sde, SdePaths};
use crate::storage;

/// Fetch the character's jobs, retrying transient ESI failures (5xx / timeouts —
/// the `include_completed` payload is heavy and ESI returns 504s under load).
/// Real errors (e.g. 403 missing scope) fail fast — they aren't retried.
async fn fetch_jobs_retrying(
    auth: &AuthState,
    character_id: i64,
    url: &str,
) -> Result<Vec<StoredJob>, String> {
    let mut attempt = 0u32;
    loop {
        match authed_get::<Vec<StoredJob>>(auth, character_id, url).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                // Retry on 5xx or a status-less error (timeout/connection); a
                // 4xx (403/401) is a real problem and returned immediately.
                let retryable = match &e {
                    AuthError::Http(he) => he.status().map(|s| s.is_server_error()).unwrap_or(true),
                    _ => false,
                };
                attempt += 1;
                if attempt >= 3 || !retryable {
                    return Err(e.to_string());
                }
                tokio::time::sleep(std::time::Duration::from_millis(700 * attempt as u64)).await;
            }
        }
    }
}

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

/// Industry job slots of one kind: how many are in use vs available.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub used: i64,
    pub total: i64,
}

/// The character's three job-slot pools.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slots {
    pub manufacturing: Slot,
    pub science: Slot,
    pub reactions: Slot,
}

/// Jobs + slot usage — the Industry Jobs command's response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsResult {
    pub jobs: Vec<JobRow>,
    pub slots: Slots,
}

#[derive(Deserialize, Default)]
struct EsiSkills {
    #[serde(default)]
    skills: Vec<EsiSkill>,
}
#[derive(Deserialize)]
struct EsiSkill {
    skill_id: i64,
    #[serde(default)]
    active_skill_level: i64,
}

/// Which slot pool an activity draws from: manufacturing / science / reactions.
fn slot_pool(activity_id: i64) -> Option<&'static str> {
    match activity_id {
        1 => Some("m"),              // manufacturing
        3 | 4 | 5 | 8 => Some("s"),  // TE/ME research, copy, invention
        9 => Some("r"),              // reactions
        _ => None,
    }
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
) -> Result<JobsResult, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let character_id = storage::load_roster(&dir)
        .into_iter()
        .next()
        .map(|c| c.character_id)
        .ok_or_else(|| "Log in a character first".to_string())?;

    // include_completed so delivered jobs (the cost-basis source) come through.
    // Retried on transient ESI 5xx/timeouts (this endpoint 504s under load).
    let incoming: Vec<StoredJob> = fetch_jobs_retrying(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/industry/jobs/?include_completed=true"),
    )
    .await?;

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

    // Slot usage: max slots come from skills (1 base + each rank), used = jobs
    // occupying a slot now (active or finished-but-undelivered).
    let skills: EsiSkills = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/skills/"),
    )
    .await
    .unwrap_or_default();
    let level = |skill_id: i64| {
        skills
            .skills
            .iter()
            .find(|s| s.skill_id == skill_id)
            .map(|s| s.active_skill_level)
            .unwrap_or(0)
    };
    // Mass Production / Adv (3387/24625), Laboratory Operation / Adv (3406/24624),
    // Mass Reactions / Adv (45748/45749) — 1 base slot + 1 per level.
    let (total_m, total_s, total_r) = (
        1 + level(3387) + level(24625),
        1 + level(3406) + level(24624),
        1 + level(45748) + level(45749),
    );
    let (mut used_m, mut used_s, mut used_r) = (0, 0, 0);
    for j in &jobs {
        if j.status != "active" && j.status != "ready" {
            continue;
        }
        match slot_pool(j.activity_id) {
            Some("m") => used_m += 1,
            Some("s") => used_s += 1,
            Some("r") => used_r += 1,
            _ => {}
        }
    }
    let slots = Slots {
        manufacturing: Slot { used: used_m, total: total_m },
        science: Slot { used: used_s, total: total_s },
        reactions: Slot { used: used_r, total: total_r },
    };

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
    Ok(JobsResult { jobs: rows, slots })
}
