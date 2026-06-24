//! Character module — skills, standings, and R&D research viewers.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{authed_get, resolve_names, AuthState};
use crate::sde::{Sde, SdePaths};
use crate::storage;

/// The first logged-in character id, or an error message if the roster is empty.
fn first_character(app: &AppHandle) -> Result<i64, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::load_roster(&dir)
        .into_iter()
        .next()
        .map(|c| c.character_id)
        .ok_or_else(|| "Log in a character first".to_string())
}

// --- Skills (#55) ---

#[derive(Deserialize)]
struct EsiSkills {
    skills: Vec<EsiSkill>,
    total_sp: i64,
    #[serde(default)]
    unallocated_sp: i64,
}
#[derive(Deserialize)]
struct EsiSkill {
    skill_id: i64,
    #[serde(default)]
    active_skill_level: i64,
}
#[derive(Deserialize)]
struct EsiQueueItem {
    skill_id: i64,
    finished_level: i64,
    finish_date: Option<String>,
    #[allow(dead_code)]
    queue_position: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsView {
    pub total_sp: i64,
    pub unallocated_sp: i64,
    pub trained_count: i64,
    pub queue: Vec<QueueRow>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueRow {
    pub skill_name: String,
    pub level: i64,
    pub finish_date: Option<String>,
}

#[tauri::command]
pub async fn character_skills(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<SkillsView, String> {
    let character_id = first_character(&app)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;

    let skills: EsiSkills = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/skills/"),
    )
    .await
    .map_err(|e| e.to_string())?;
    let queue: Vec<EsiQueueItem> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/skillqueue/"),
    )
    .await
    .map_err(|e| e.to_string())?;

    let name = |type_id: i64| {
        sde.type_info(type_id)
            .ok()
            .flatten()
            .map(|t| t.name)
            .unwrap_or_else(|| format!("Skill {type_id}"))
    };
    Ok(SkillsView {
        total_sp: skills.total_sp,
        unallocated_sp: skills.unallocated_sp,
        trained_count: skills.skills.iter().filter(|s| s.active_skill_level > 0).count() as i64,
        queue: queue
            .into_iter()
            .map(|q| QueueRow {
                skill_name: name(q.skill_id),
                level: q.finished_level,
                finish_date: q.finish_date,
            })
            .collect(),
    })
}

// --- Standings (#56) ---

#[derive(Deserialize)]
struct EsiStanding {
    from_id: i64,
    from_type: String,
    standing: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingRow {
    pub name: String,
    pub from_type: String,
    pub base: f64,
    pub effective: f64,
    pub skill: String,
}

/// Pirate factions → Criminal Connections applies on positive standings.
const CRIMINAL_FACTIONS: &[i64] = &[
    500010, // Guristas
    500011, // Angel Cartel
    500012, // Blood Raiders
    500019, // Sansha's Nation
    500020, // Serpentis
];

#[tauri::command]
pub async fn character_standings(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<StandingRow>, String> {
    let character_id = first_character(&app)?;
    let standings: Vec<EsiStanding> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/standings/"),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Social-skill levels for the effective-standing bonus.
    let skills: EsiSkills = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/skills/"),
    )
    .await
    .map_err(|e| e.to_string())?;
    let level = |skill_id: i64| {
        skills
            .skills
            .iter()
            .find(|s| s.skill_id == skill_id)
            .map(|s| s.active_skill_level)
            .unwrap_or(0)
    };
    let (connections, diplomacy, criminal) = (level(3359), level(3357), level(3361));

    let ids: Vec<i64> = standings.iter().map(|s| s.from_id).collect();
    let names = resolve_names(&auth_state, &ids).await;

    Ok(standings
        .into_iter()
        .map(|s| {
            // Effective = base + (10 − base) × 0.04 × level, skill by context.
            let (skill_name, lvl) = if s.standing < 0.0 {
                ("Diplomacy", diplomacy)
            } else if CRIMINAL_FACTIONS.contains(&s.from_id) {
                ("Criminal Connections", criminal)
            } else {
                ("Connections", connections)
            };
            let modifier = (10.0 - s.standing) * 0.04 * lvl as f64;
            StandingRow {
                name: names.get(&s.from_id).cloned().unwrap_or_else(|| format!("#{}", s.from_id)),
                from_type: s.from_type,
                base: s.standing,
                effective: s.standing + modifier,
                skill: format!("{skill_name} {lvl}"),
            }
        })
        .collect())
}

// --- Research agents (#57) ---

#[derive(Deserialize)]
struct EsiResearch {
    agent_id: i64,
    points_per_day: f64,
    remainder_points: f64,
    skill_type_id: i64,
    started_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRow {
    pub agent: String,
    pub skill: String,
    pub points_per_day: f64,
    pub current_points: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchView {
    pub rows: Vec<ResearchRow>,
    pub total_points: f64,
    pub points_per_day: f64,
}

#[tauri::command]
pub async fn character_research(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<ResearchView, String> {
    let character_id = first_character(&app)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;

    let agents: Vec<EsiResearch> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/agents_research/"),
    )
    .await
    .map_err(|e| e.to_string())?;

    let ids: Vec<i64> = agents.iter().map(|a| a.agent_id).collect();
    let names = resolve_names(&auth_state, &ids).await;
    let now = chrono_now_secs();

    let (mut total_points, mut points_per_day) = (0.0, 0.0);
    let rows = agents
        .into_iter()
        .map(|a| {
            // CurrentPoints = remainder + rate × days since started.
            let days = (now - parse_epoch(&a.started_at)).max(0.0) / 86_400.0;
            let current = a.remainder_points + a.points_per_day * days;
            total_points += current;
            points_per_day += a.points_per_day;
            ResearchRow {
                agent: names.get(&a.agent_id).cloned().unwrap_or_else(|| format!("#{}", a.agent_id)),
                skill: sde
                    .type_info(a.skill_type_id)
                    .ok()
                    .flatten()
                    .map(|t| t.name)
                    .unwrap_or_else(|| format!("Skill {}", a.skill_type_id)),
                points_per_day: a.points_per_day,
                current_points: current,
            }
        })
        .collect();
    Ok(ResearchView {
        rows,
        total_points,
        points_per_day,
    })
}

/// Seconds since the Unix epoch (no chrono dep — uses SystemTime).
fn chrono_now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// Parse an ESI RFC3339 timestamp (`2026-01-02T03:04:05Z`) to epoch seconds.
fn parse_epoch(s: &str) -> f64 {
    // Minimal parse: split date/time, compute days since epoch.
    let bytes = s.as_bytes();
    if s.len() < 19 || bytes.get(4) != Some(&b'-') {
        return chrono_now_secs();
    }
    let num = |a: usize, b: usize| s[a..b].parse::<i64>().unwrap_or(0);
    let (y, mo, d) = (num(0, 4), num(5, 7), num(8, 10));
    let (h, mi, se) = (num(11, 13), num(14, 16), num(17, 19));
    // Days from civil (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    (days * 86_400 + h * 3600 + mi * 60 + se) as f64
}
