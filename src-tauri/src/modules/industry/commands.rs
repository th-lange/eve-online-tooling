//! Industry Jobs — the character's running and recently-delivered industry jobs
//! ("what's cooking"). Durably merged by job id so delivered jobs persist past
//! ESI's window (a foundation for industry-job cost basis in the profit tracker).
//!
//! Requires the `esi-industry.read_character_jobs.v1` scope (must be enabled on
//! the EVE app + a re-login before this returns data).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{authed_get, corporation_id, resolve_names, AuthState, ESI_BASE};
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
    /// "You" for personal jobs, "Corp" for corporation jobs.
    pub owner: String,
    pub character_id: i64,
    pub character_name: String,
}

/// Fetch corporation industry jobs (403/error → none: needs the scope + a corp
/// role). Not durably stored; display-only.
async fn fetch_corp_jobs(
    auth: &AuthState,
    character_id: i64,
    corporation_id: i64,
) -> Vec<StoredJob> {
    let Ok(token) = auth.access_token_for(character_id).await else {
        return Vec::new();
    };
    let url = format!(
        "{ESI_BASE}/latest/corporations/{corporation_id}/industry/jobs/?include_completed=true"
    );
    let Ok(resp) = auth.http().get(&url).bearer_auth(&token).send().await else {
        return Vec::new();
    };
    match resp.error_for_status() {
        Ok(r) => r.json::<Vec<StoredJob>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
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
        1 => Some("m"),             // manufacturing
        3 | 4 | 5 | 8 => Some("s"), // TE/ME research, copy, invention
        9 => Some("r"),             // reactions
        _ => None,
    }
}

/// Assemble the three slot pools. `totals` is (manufacturing, science,
/// reactions) max slots (1 base + skill ranks); `jobs` is `(activity_id,
/// status)` per job — a job counts against a pool only while it still holds a
/// slot (status `"active"`, or finished-but-undelivered `"ready"`). Pure, so
/// the used-vs-available math is unit-tested without ESI.
fn compute_slots(totals: (i64, i64, i64), jobs: &[(i64, &str)]) -> Slots {
    let (mut used_m, mut used_s, mut used_r) = (0, 0, 0);
    for (activity_id, status) in jobs {
        if *status != "active" && *status != "ready" {
            continue;
        }
        match slot_pool(*activity_id) {
            Some("m") => used_m += 1,
            Some("s") => used_s += 1,
            Some("r") => used_r += 1,
            _ => {}
        }
    }
    Slots {
        manufacturing: Slot {
            used: used_m,
            total: totals.0,
        },
        science: Slot {
            used: used_s,
            total: totals.1,
        },
        reactions: Slot {
            used: used_r,
            total: totals.2,
        },
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

/// Fetch + durably merge one character's industry jobs, and their slot usage.
/// Rows are stamped with `character_id`/`character_name` so an aggregate view
/// can attribute each job. Pulled out of [`industry_jobs`] so it can be looped
/// per roster character when "All characters" is active.
async fn character_industry_jobs(
    dir: &std::path::Path,
    auth_state: &State<'_, AuthState>,
    character_id: i64,
    character_name: &str,
) -> Result<(Vec<JobRow>, Slots), crate::model::AppError> {
    // include_completed so delivered jobs (the cost-basis source) come through.
    // The shared ESI client retries transient 5xx/timeouts (this endpoint 504s
    // under load) and backs off the error budget; a real 4xx (403 missing scope)
    // still fails fast.
    let incoming: Vec<StoredJob> = authed_get(
        auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/industry/jobs/?include_completed=true"),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Merge into the durable store, keyed by job id (delivered jobs persist).
    let key = format!("industry_jobs_{character_id}");
    let stored: Vec<StoredJob> = storage::load_data(dir, &key).unwrap_or_default();
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
    let _ = storage::save_data(dir, &key, &jobs);

    // Slot usage: max slots come from skills (1 base + each rank), used = jobs
    // occupying a slot now (active or finished-but-undelivered).
    let skills: EsiSkills = authed_get(
        auth_state,
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
    let job_pools: Vec<(i64, &str)> = jobs
        .iter()
        .map(|j| (j.activity_id, j.status.as_str()))
        .collect();
    let slots = compute_slots((total_m, total_s, total_r), &job_pools);

    // Corp jobs (display-only; needs the corp scope + a corp role — else none).
    // Tag personal jobs "You" and corp jobs "Corp"; a job_id seen in both keeps
    // the personal one. Slots above stay character-only.
    let mut combined: Vec<(StoredJob, &'static str)> =
        jobs.into_iter().map(|j| (j, "You")).collect();
    if let Ok(corp_id) = corporation_id(auth_state, character_id).await {
        let seen: HashSet<i64> = combined.iter().map(|(j, _)| j.job_id).collect();
        for j in fetch_corp_jobs(auth_state, character_id, corp_id).await {
            if !seen.contains(&j.job_id) {
                combined.push((j, "Corp"));
            }
        }
    }

    // Resolve names: product/blueprint via SDE, facility via /universe/names.
    // Opened here (not passed in) so no `!Sync` connection is held across an
    // earlier `.await`, which would make this future non-`Send`.
    let sde = Sde::open(&SdePaths::new(dir.to_path_buf()).db).map_err(|e| e.to_string())?;
    let facility_ids: Vec<i64> = combined
        .iter()
        .filter_map(|(j, _)| j.facility_id.or(j.station_id))
        .collect();
    let facilities = resolve_names(auth_state, &facility_ids).await;
    let type_name = |id: i64| {
        sde.type_info(id)
            .ok()
            .flatten()
            .map(|t| t.name)
            .unwrap_or_else(|| format!("Type {id}"))
    };

    let rows: Vec<JobRow> = combined
        .into_iter()
        .map(|(j, owner)| {
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
                owner: owner.to_string(),
                character_id,
                character_name: character_name.to_string(),
            }
        })
        .collect();
    Ok((rows, slots))
}

/// The character's industry jobs (running + recently delivered), names resolved.
/// Durably accumulates delivered jobs across syncs. `character_id` selects which
/// roster character; `None` defaults to the active selection — every roster
/// character when "All characters" is active (rows tagged, slots summed; a
/// character whose ESI fetch fails is skipped rather than failing the whole
/// call), otherwise just the active one (errors propagate, as before).
#[tauri::command]
pub async fn industry_jobs(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    character_id: Option<i64>,
) -> Result<JobsResult, crate::model::AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    let roster = storage::load_roster(&dir);

    // An explicit, valid roster id always means "just this character". Else
    // fan out over the active selection's target set: the whole roster when
    // ALL_CHARACTERS is active, otherwise just the active character.
    let (targets, aggregating): (Vec<i64>, bool) = match character_id {
        Some(id) if roster.iter().any(|c| c.character_id == id) => (vec![id], false),
        _ => {
            let targets = storage::target_characters(&dir);
            if targets.is_empty() {
                return Err(crate::model::AppError::auth_required());
            }
            let aggregating = targets.len() > 1;
            (targets, aggregating)
        }
    };

    let names = storage::character_names(&dir);

    let mut rows: Vec<JobRow> = Vec::new();
    let mut slots = Slots {
        manufacturing: Slot { used: 0, total: 0 },
        science: Slot { used: 0, total: 0 },
        reactions: Slot { used: 0, total: 0 },
    };
    for cid in targets {
        let name = names.get(&cid).cloned().unwrap_or_else(|| cid.to_string());
        match character_industry_jobs(&dir, &auth_state, cid, &name).await {
            Ok((mut r, s)) => {
                rows.append(&mut r);
                slots.manufacturing.used += s.manufacturing.used;
                slots.manufacturing.total += s.manufacturing.total;
                slots.science.used += s.science.used;
                slots.science.total += s.science.total;
                slots.reactions.used += s.reactions.used;
                slots.reactions.total += s.reactions.total;
            }
            Err(e) => {
                if aggregating {
                    continue;
                }
                return Err(e);
            }
        }
    }

    // Active jobs first, then most-recently-ending.
    rows.sort_by(|a, b| {
        let rank = |s: &str| if s == "active" || s == "ready" { 0 } else { 1 };
        rank(&a.status)
            .cmp(&rank(&b.status))
            .then_with(|| b.end_date.cmp(&a.end_date))
    });
    Ok(JobsResult { jobs: rows, slots })
}

#[cfg(test)]
mod tests {
    use super::{compute_slots, slot_pool};

    #[test]
    fn slot_pool_maps_activities() {
        assert_eq!(slot_pool(1), Some("m")); // manufacturing
        assert_eq!(slot_pool(4), Some("s")); // ME research
        assert_eq!(slot_pool(8), Some("s")); // invention
        assert_eq!(slot_pool(9), Some("r")); // reactions
        assert_eq!(slot_pool(999), None);
    }

    #[test]
    fn counts_only_active_and_ready_jobs_per_pool() {
        let jobs = [
            (1, "active"),    // manufacturing, counts
            (1, "ready"),     // manufacturing, counts (finished, undelivered)
            (1, "delivered"), // done — frees the slot, doesn't count
            (4, "active"),    // science, counts
            (9, "active"),    // reactions, counts
            (9, "cancelled"), // doesn't count
        ];
        let slots = compute_slots((10, 5, 3), &jobs);
        assert_eq!(slots.manufacturing.used, 2);
        assert_eq!(slots.science.used, 1);
        assert_eq!(slots.reactions.used, 1);
    }

    #[test]
    fn totals_pass_through_unchanged() {
        let slots = compute_slots((11, 6, 4), &[]);
        assert_eq!(slots.manufacturing.total, 11);
        assert_eq!(slots.science.total, 6);
        assert_eq!(slots.reactions.total, 4);
        assert_eq!(slots.manufacturing.used, 0);
    }
}
