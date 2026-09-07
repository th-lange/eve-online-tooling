//! Industry Jobs — the character's running and recently-delivered industry jobs
//! ("what's cooking"). Durably merged by job id so delivered jobs persist past
//! ESI's window (a foundation for industry-job cost basis in the profit tracker).
//!
//! Requires the `esi-industry.read_character_jobs.v1` scope (must be enabled on
//! the EVE app + a re-login before this returns data).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{
    authed_get, authed_get_paged_or_empty_on_403, character_skill_levels, corporation_id,
    resolve_names, AuthState,
};
use crate::sde::open_from_dir;
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

/// How long a delivered job is kept in the durable store after its
/// `end_date` before being pruned — generous enough to cover a typical
/// profit-tracker lookback while keeping the per-character store from
/// growing forever.
const JOB_RETENTION_SECS: u64 = 90 * 24 * 60 * 60;

/// Merge `incoming` jobs into `stored`, keyed by job id (an incoming job
/// overwrites the stored one so status/end_date stay current — O(1) per job
/// instead of a linear scan), then drop any job whose `end_date` is older
/// than [`JOB_RETENTION_SECS`]. Pure — no I/O — so the merge/pruning
/// behaviour is directly unit-testable. Jobs with an unparseable/empty
/// `end_date` (still running) are never pruned.
fn merge_jobs(stored: Vec<StoredJob>, incoming: Vec<StoredJob>, now: u64) -> Vec<StoredJob> {
    let mut by_id: BTreeMap<i64, StoredJob> = stored.into_iter().map(|j| (j.job_id, j)).collect();
    for j in incoming {
        by_id.insert(j.job_id, j);
    }
    let cutoff = now.saturating_sub(JOB_RETENTION_SECS);
    by_id
        .into_values()
        .filter(|j| {
            crate::util::time::parse_rfc3339_epoch(&j.end_date)
                .map(|end| end >= cutoff)
                .unwrap_or(true)
        })
        .collect()
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
    authed_get_paged_or_empty_on_403(
        auth,
        character_id,
        &format!("/latest/corporations/{corporation_id}/industry/jobs/?include_completed=true"),
    )
    .await
    .unwrap_or_default()
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

/// One character's job-slot pools, so a consumer can tell *which* character
/// has an idle line rather than only an aggregate used-vs-total.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSlots {
    pub character_id: i64,
    pub character_name: String,
    pub slots: Slots,
}

/// Jobs + slot usage — the Industry Jobs command's response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsResult {
    pub jobs: Vec<JobRow>,
    /// Summed across every target character.
    pub slots: Slots,
    /// Per-character breakdown of the same slot pools, one entry per target
    /// character regardless of whether they have any jobs at all (so a
    /// character who has never run a job still shows up with `used: 0`).
    pub by_character: Vec<CharacterSlots>,
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
    auth: &AuthState,
    character_id: i64,
    character_name: &str,
) -> Result<(Vec<JobRow>, Slots), crate::model::AppError> {
    // include_completed so delivered jobs (the cost-basis source) come through.
    // The shared ESI client retries transient 5xx/timeouts (this endpoint 504s
    // under load) and backs off the error budget; a real 4xx (403 missing scope)
    // still fails fast.
    let incoming: Vec<StoredJob> = authed_get(
        auth,
        character_id,
        &format!("/latest/characters/{character_id}/industry/jobs/?include_completed=true"),
    )
    .await?;

    // Merge into the durable store, keyed by job id (delivered jobs persist
    // past ESI's window, but only up to `JOB_RETENTION_SECS`).
    let key = format!("industry_jobs_{character_id}");
    let stored: Vec<StoredJob> = storage::load_data(dir, &key).unwrap_or_default();
    let jobs = merge_jobs(stored, incoming, crate::util::time::now_secs());
    let _ = storage::save_data(dir, &key, &jobs);

    // Slot usage: max slots come from skills (1 base + each rank), used = jobs
    // occupying a slot now (active or finished-but-undelivered).
    let skills = character_skill_levels(auth, character_id)
        .await
        .unwrap_or_default();
    let level = |skill_id: i64| skills.level(skill_id);
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
    if let Ok(corp_id) = corporation_id(auth, character_id).await {
        let seen: HashSet<i64> = combined.iter().map(|(j, _)| j.job_id).collect();
        for j in fetch_corp_jobs(auth, character_id, corp_id).await {
            if !seen.contains(&j.job_id) {
                combined.push((j, "Corp"));
            }
        }
    }

    // Resolve names: product/blueprint via SDE, facility via /universe/names.
    // Opened here (not passed in) so no `!Sync` connection is held across an
    // earlier `.await`, which would make this future non-`Send`.
    let sde = open_from_dir(dir)?;
    let facility_ids: Vec<i64> = combined
        .iter()
        .filter_map(|(j, _)| j.facility_id.or(j.station_id))
        .collect();
    let facilities = resolve_names(auth, &facility_ids).await;

    let rows: Vec<JobRow> = combined
        .into_iter()
        .map(|(j, owner)| {
            let product = sde.type_name_or_id(j.product_type_id.unwrap_or(j.blueprint_type_id));
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
/// call), otherwise just the active one (errors propagate, as before). The
/// Append `incoming` rows that haven't been seen yet, by job id. Corporation
/// jobs are returned to every character in that corp, so aggregating a roster
/// without this lists each corp job once per member. Pure (testable).
fn append_new_jobs(rows: &mut Vec<JobRow>, seen: &mut HashSet<i64>, incoming: Vec<JobRow>) {
    rows.extend(incoming.into_iter().filter(|j| seen.insert(j.job_id)));
}

/// Tauri command's core, factored out so `capabilities::cap_industry_jobs` can
/// call it with a [`HostCtx`](crate::capabilities::HostCtx)-supplied dir/auth
/// instead of a Tauri `AppHandle`/`State`.
pub async fn industry_jobs_core(
    dir: &std::path::Path,
    auth: &AuthState,
    character_id: Option<i64>,
) -> Result<JobsResult, crate::model::AppError> {
    let roster = storage::load_roster(dir);

    // An explicit, valid roster id always means "just this character". Else
    // fan out over the active selection's target set: the whole roster when
    // ALL_CHARACTERS is active, otherwise just the active character.
    let (targets, aggregating): (Vec<i64>, bool) = match character_id {
        Some(id) if roster.iter().any(|c| c.character_id == id) => (vec![id], false),
        _ => {
            let targets = storage::target_characters(dir);
            if targets.is_empty() {
                return Err(crate::model::AppError::auth_required());
            }
            let aggregating = targets.len() > 1;
            (targets, aggregating)
        }
    };

    let names = storage::character_names(dir);

    let mut rows: Vec<JobRow> = Vec::new();
    // Corp jobs come back once per character in the corp, so aggregating a
    // roster would list them repeatedly; keep the first sighting of each job.
    let mut seen_jobs: HashSet<i64> = HashSet::new();
    let mut slots = Slots {
        manufacturing: Slot { used: 0, total: 0 },
        science: Slot { used: 0, total: 0 },
        reactions: Slot { used: 0, total: 0 },
    };
    let mut by_character: Vec<CharacterSlots> = Vec::new();
    for cid in targets {
        let name = names.get(&cid).cloned().unwrap_or_else(|| cid.to_string());
        match character_industry_jobs(dir, auth, cid, &name).await {
            Ok((r, s)) => {
                append_new_jobs(&mut rows, &mut seen_jobs, r);
                slots.manufacturing.used += s.manufacturing.used;
                slots.manufacturing.total += s.manufacturing.total;
                slots.science.used += s.science.used;
                slots.science.total += s.science.total;
                slots.reactions.used += s.reactions.used;
                slots.reactions.total += s.reactions.total;
                by_character.push(CharacterSlots {
                    character_id: cid,
                    character_name: name,
                    slots: s,
                });
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
    Ok(JobsResult {
        jobs: rows,
        slots,
        by_character,
    })
}

/// The character's industry jobs (running + recently delivered), names resolved.
#[tauri::command]
pub async fn industry_jobs(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    character_id: Option<i64>,
) -> Result<JobsResult, crate::model::AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    industry_jobs_core(&dir, &auth_state, character_id).await
}

/// One character's status for a single job-slot pool: idle (no active/ready
/// job holding a slot right now) or busy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineStatus {
    pub character_id: i64,
    pub character_name: String,
    pub idle: bool,
}

/// Per-character idle/busy status for each job-slot pool — a small,
/// purpose-shaped summary for consumers (scripts, plugins, MCP) that only
/// need "who's idle", not the full job list and slot totals `industry_jobs`
/// ships for the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineStatusResult {
    pub manufacturing: Vec<LineStatus>,
    pub invention: Vec<LineStatus>,
    pub reactions: Vec<LineStatus>,
}

/// Derive [`LineStatusResult`] from an already-fetched [`JobsResult`]. Pure —
/// no ESI, no I/O — so it's directly unit-testable. `manufacturing`/
/// `reactions` read straight off each character's slot usage (unambiguous:
/// one activity per pool); `invention` isn't slot-derivable (the "science"
/// pool also covers ME/TE research and copying), so it checks the job list
/// for an active/ready Invention job per character instead.
pub fn line_status(result: &JobsResult) -> LineStatusResult {
    let inventing: HashSet<i64> = result
        .jobs
        .iter()
        .filter(|j| j.activity == "Invention" && (j.status == "active" || j.status == "ready"))
        .map(|j| j.character_id)
        .collect();
    let status = |idle: bool, c: &CharacterSlots| LineStatus {
        character_id: c.character_id,
        character_name: c.character_name.clone(),
        idle,
    };
    LineStatusResult {
        manufacturing: result
            .by_character
            .iter()
            .map(|c| status(c.slots.manufacturing.used == 0, c))
            .collect(),
        invention: result
            .by_character
            .iter()
            .map(|c| status(!inventing.contains(&c.character_id), c))
            .collect(),
        reactions: result
            .by_character
            .iter()
            .map(|c| status(c.slots.reactions.used == 0, c))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::{append_new_jobs, compute_slots, line_status, merge_jobs, slot_pool};
    use super::{CharacterSlots, JobRow, JobsResult, Slot, Slots, StoredJob, JOB_RETENTION_SECS};
    use std::collections::HashSet;

    fn stored_job(job_id: i64, end_date: &str) -> StoredJob {
        StoredJob {
            job_id,
            activity_id: 1,
            blueprint_type_id: 1,
            product_type_id: None,
            runs: 1,
            cost: None,
            status: "active".to_string(),
            start_date: String::new(),
            end_date: end_date.to_string(),
            facility_id: None,
            station_id: None,
        }
    }

    #[test]
    fn corp_jobs_appear_once_across_same_corp_characters() {
        // Two roster characters in one corp: each returns its own personal job
        // plus the same shared corp job (id 900).
        let corp_job = |cid: i64| JobRow {
            job_id: 900,
            owner: "Corp".to_string(),
            ..job_row(cid, "Manufacturing", "active")
        };
        let personal = |cid: i64, id: i64| JobRow {
            job_id: id,
            ..job_row(cid, "Manufacturing", "active")
        };

        let mut rows: Vec<JobRow> = Vec::new();
        let mut seen: HashSet<i64> = HashSet::new();
        append_new_jobs(&mut rows, &mut seen, vec![personal(1, 1), corp_job(1)]);
        append_new_jobs(&mut rows, &mut seen, vec![personal(2, 2), corp_job(2)]);

        let ids: Vec<i64> = rows.iter().map(|r| r.job_id).collect();
        assert_eq!(ids, vec![1, 900, 2], "the shared corp job is listed once");
        // The first sighting wins, so the corp job keeps character 1's tagging.
        assert_eq!(rows[1].character_id, 1);
    }

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

    fn job_row(character_id: i64, activity: &str, status: &str) -> JobRow {
        JobRow {
            job_id: 1,
            activity: activity.to_string(),
            product: "Widget".to_string(),
            runs: 1,
            status: status.to_string(),
            cost: None,
            start_date: String::new(),
            end_date: String::new(),
            facility: String::new(),
            owner: "You".to_string(),
            character_id,
            character_name: format!("Char {character_id}"),
        }
    }

    fn character_slots(
        character_id: i64,
        manufacturing_used: i64,
        reactions_used: i64,
    ) -> CharacterSlots {
        CharacterSlots {
            character_id,
            character_name: format!("Char {character_id}"),
            slots: Slots {
                manufacturing: Slot {
                    used: manufacturing_used,
                    total: 1,
                },
                science: Slot { used: 0, total: 1 },
                reactions: Slot {
                    used: reactions_used,
                    total: 1,
                },
            },
        }
    }

    #[test]
    fn line_status_flags_manufacturing_and_reactions_from_slots_and_invention_from_jobs() {
        let result = JobsResult {
            jobs: vec![job_row(2, "Invention", "active")],
            slots: Slots {
                manufacturing: Slot { used: 1, total: 2 },
                science: Slot { used: 0, total: 2 },
                reactions: Slot { used: 0, total: 2 },
            },
            by_character: vec![character_slots(1, 0, 0), character_slots(2, 1, 0)],
        };
        let status = line_status(&result);

        let find = |v: &[super::LineStatus], id: i64| {
            v.iter().find(|s| s.character_id == id).unwrap().idle
        };
        assert!(find(&status.manufacturing, 1)); // char 1: 0 used -> idle
        assert!(!find(&status.manufacturing, 2)); // char 2: 1 used -> busy
        assert!(find(&status.invention, 1)); // char 1: no Invention job -> idle
        assert!(!find(&status.invention, 2)); // char 2: active Invention job -> busy
        assert!(find(&status.reactions, 1));
        assert!(find(&status.reactions, 2)); // reactions.used == 0 for both
    }

    #[test]
    fn merge_jobs_prunes_old_jobs_and_merges_by_id() {
        let now = 1_700_000_000u64; // arbitrary fixed "now" for determinism
        let old_end = crate::util::time::format_rfc3339(now - JOB_RETENTION_SECS - 3600);
        let recent_end = crate::util::time::format_rfc3339(now - 3600);

        let stored = vec![
            stored_job(1, &old_end),    // past the 90-day retention window
            stored_job(2, &recent_end), // within the window
        ];
        // Incoming re-delivers job 2 with an updated status and adds job 3.
        let incoming = vec![
            StoredJob {
                status: "delivered".to_string(),
                ..stored_job(2, &recent_end)
            },
            stored_job(3, &recent_end),
        ];

        let merged = merge_jobs(stored, incoming, now);
        let ids: Vec<i64> = merged.iter().map(|j| j.job_id).collect();
        assert_eq!(
            ids,
            vec![2, 3],
            "job 1 (past retention) is pruned; jobs 2/3 kept, merged by job id"
        );

        let job2 = merged.iter().find(|j| j.job_id == 2).unwrap();
        assert_eq!(
            job2.status, "delivered",
            "incoming overwrites the stored entry for the same job id"
        );
    }
}
