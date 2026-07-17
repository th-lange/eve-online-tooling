//! Character module — skills, standings, and R&D research viewers.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{
    authed_get, authed_get_paged_pub, character_skill_levels, resolve_names, AuthState,
};
use crate::market::{jita_location, MarketService};
use crate::model::AppError;
use crate::storage;

// --- Skills (#55) ---

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
) -> Result<SkillsView, AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    let sde = crate::sde::open_from_app(&app)?;

    let skills = character_skill_levels(&auth_state, character_id)
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
        trained_count: skills.trained_count() as i64,
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
) -> Result<Vec<StandingRow>, AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    let standings: Vec<EsiStanding> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/standings/"),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Social-skill levels for the effective-standing bonus.
    let skills = character_skill_levels(&auth_state, character_id)
        .await
        .map_err(|e| e.to_string())?;
    let level = |skill_id: i64| skills.level(skill_id);
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
                name: names
                    .get(&s.from_id)
                    .cloned()
                    .unwrap_or_else(|| format!("#{}", s.from_id)),
                from_type: s.from_type,
                base: s.standing,
                effective: s.standing + modifier,
                skill: format!("{skill_name} {lvl}"),
            }
        })
        .collect())
}

// --- Trade fees from skills + standings ---

/// Major trade hubs and their NPC station owners: (hub, region, owning faction,
/// owning corporation). Broker fee at a hub scales with standing toward these.
const TRADE_HUBS: &[(&str, &str, &str, &str)] = &[
    ("Jita", "The Forge", "Caldari State", "Caldari Navy"),
    ("Amarr", "Domain", "Amarr Empire", "Emperor Family"),
    (
        "Dodixie",
        "Sinq Laison",
        "Gallente Federation",
        "Federation Navy",
    ),
    ("Rens", "Heimatar", "Minmatar Republic", "Brutor Tribe"),
    (
        "Hek",
        "Metropolis",
        "Minmatar Republic",
        "Boundless Creation",
    ),
];

/// Sales/transaction tax %: 4.5% base, −11% per Accounting level. Pure.
fn sales_tax_pct(accounting: i64) -> f64 {
    (4.5 * (1.0 - 0.11 * accounting as f64)).max(0.0)
}

/// Broker fee %: 3% base, −0.3%/Broker Relations level, −0.03%/point of faction
/// standing and −0.02%/point of corp standing (effective standings), floored at
/// 1%. Pure. (#broker)
fn broker_fee_pct(broker_relations: i64, faction_eff: f64, corp_eff: f64) -> f64 {
    (3.0 - 0.3 * broker_relations as f64 - 0.03 * faction_eff - 0.02 * corp_eff).max(1.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubFee {
    pub hub: String,
    pub region: String,
    pub broker_fee_pct: f64,
    /// Effective standing toward the owning faction / corp (post social skills).
    pub faction_standing: f64,
    pub corp_standing: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeFees {
    pub accounting: i64,
    pub broker_relations: i64,
    pub connections: i64,
    /// Sales tax % (same at every station — skill-only).
    pub sales_tax_pct: f64,
    pub hubs: Vec<HubFee>,
}

/// Broker fee (per major hub) and sales tax computed from the active character's
/// Accounting / Broker Relations skills and effective standings toward each
/// hub's owner. Used to pre-fill the fee inputs across the trading/build tools.
#[tauri::command]
pub async fn character_trade_fees(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<TradeFees, AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;

    let skills = character_skill_levels(&auth_state, character_id)
        .await
        .map_err(|e| e.to_string())?;
    let level = |id: i64| skills.level(id);
    let accounting = level(16622);
    let broker_relations = level(3446);
    let connections = level(3359);
    let diplomacy = level(3357);

    let standings: Vec<EsiStanding> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/standings/"),
    )
    .await
    .map_err(|e| e.to_string())?;
    let ids: Vec<i64> = standings.iter().map(|s| s.from_id).collect();
    let names = resolve_names(&auth_state, &ids).await;
    // Resolve owner name → base standing, so hubs can be matched by owner name.
    let mut by_name: HashMap<String, f64> = HashMap::new();
    for s in &standings {
        if let Some(n) = names.get(&s.from_id) {
            by_name.insert(n.clone(), s.standing);
        }
    }
    // Effective standing = base + (10 − base) × 0.04 × level (Connections for
    // positive, Diplomacy for negative) — same as the standings view.
    let eff = |base: f64| {
        let lvl = if base < 0.0 { diplomacy } else { connections };
        base + (10.0 - base) * 0.04 * lvl as f64
    };

    let hubs = TRADE_HUBS
        .iter()
        .map(|(hub, region, faction, corp)| {
            let f_eff = eff(by_name.get(*faction).copied().unwrap_or(0.0));
            let c_eff = eff(by_name.get(*corp).copied().unwrap_or(0.0));
            HubFee {
                hub: hub.to_string(),
                region: region.to_string(),
                broker_fee_pct: broker_fee_pct(broker_relations, f_eff, c_eff),
                faction_standing: f_eff,
                corp_standing: c_eff,
            }
        })
        .collect();

    Ok(TradeFees {
        accounting,
        broker_relations,
        connections,
        sales_tax_pct: sales_tax_pct(accounting),
        hubs,
    })
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
) -> Result<ResearchView, AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    let sde = crate::sde::open_from_app(&app)?;

    let agents: Vec<EsiResearch> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/agents_research/"),
    )
    .await
    .map_err(|e| e.to_string())?;

    let ids: Vec<i64> = agents.iter().map(|a| a.agent_id).collect();
    let names = resolve_names(&auth_state, &ids).await;
    let now = crate::util::time::now_secs() as f64;

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
                agent: names
                    .get(&a.agent_id)
                    .cloned()
                    .unwrap_or_else(|| format!("#{}", a.agent_id)),
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

// --- Mining ledger (#58) ---

#[derive(Deserialize)]
struct EsiMining {
    date: String,
    solar_system_id: i64,
    type_id: i64,
    quantity: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningRow {
    pub name: String,
    pub quantity: i64,
    pub value: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningView {
    pub units24h: i64,
    pub units7d: i64,
    pub units30d: i64,
    pub value24h: f64,
    pub value7d: f64,
    pub value30d: f64,
    /// Per-ore 30-day totals, valued at Jita buy.
    pub rows: Vec<MiningRow>,
    /// Most recent systems mined in (names).
    pub systems: Vec<String>,
}

#[tauri::command]
pub async fn character_mining(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
) -> Result<MiningView, AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    let sde = crate::sde::open_from_app(&app)?;

    let ledger: Vec<EsiMining> = authed_get_paged_pub(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/mining/"),
    )
    .await
    .map_err(|e| e.to_string())?;

    // Price the distinct ore types at Jita buy.
    let type_ids: Vec<i64> = {
        let mut s: std::collections::HashSet<i64> = std::collections::HashSet::new();
        for e in &ledger {
            s.insert(e.type_id);
        }
        s.into_iter().collect()
    };
    let prices: HashMap<i64, f64> = market
        .price_models_at(jita_location(), &type_ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|m| m.buy_percentile.map(|p| (m.type_id, p)))
        .collect();
    let systems = sde.system_names().map_err(|e| e.to_string())?;

    let now = crate::util::time::now_secs() as f64;
    let (d1, d7, d30) = (now - 86_400.0, now - 7.0 * 86_400.0, now - 30.0 * 86_400.0);
    let (mut u24, mut u7, mut u30) = (0i64, 0i64, 0i64);
    let (mut v24, mut v7, mut v30) = (0.0, 0.0, 0.0);
    let mut by_type: HashMap<i64, i64> = HashMap::new();
    let mut recent_systems: Vec<String> = Vec::new();
    let mut seen_sys: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for e in &ledger {
        let t = parse_epoch(&format!("{}T00:00:00Z", e.date));
        if t < d30 {
            continue;
        }
        let value = e.quantity as f64 * prices.get(&e.type_id).copied().unwrap_or(0.0);
        u30 += e.quantity;
        v30 += value;
        if t >= d7 {
            u7 += e.quantity;
            v7 += value;
        }
        if t >= d1 {
            u24 += e.quantity;
            v24 += value;
        }
        *by_type.entry(e.type_id).or_default() += e.quantity;
        if seen_sys.insert(e.solar_system_id) && recent_systems.len() < 8 {
            recent_systems.push(
                systems
                    .get(&e.solar_system_id)
                    .cloned()
                    .unwrap_or_else(|| format!("#{}", e.solar_system_id)),
            );
        }
    }
    let mut rows: Vec<MiningRow> = by_type
        .into_iter()
        .map(|(type_id, quantity)| MiningRow {
            name: sde.type_name_or_id(type_id),
            quantity,
            value: quantity as f64 * prices.get(&type_id).copied().unwrap_or(0.0),
        })
        .collect();
    rows.sort_by(|a, b| {
        b.value
            .partial_cmp(&a.value)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(MiningView {
        units24h: u24,
        units7d: u7,
        units30d: u30,
        value24h: v24,
        value7d: v7,
        value30d: v30,
        rows,
        systems: recent_systems,
    })
}

// --- Fleet (#59) ---

#[derive(Deserialize)]
struct EsiFleet {
    fleet_id: i64,
}
#[derive(Deserialize)]
struct EsiFleetMember {
    character_id: i64,
    ship_type_id: i64,
    solar_system_id: i64,
    #[serde(default)]
    role_name: String,
    #[serde(default)]
    join_time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMemberRow {
    pub name: String,
    pub ship: String,
    pub system: String,
    pub role: String,
    pub joined: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetView {
    pub in_fleet: bool,
    pub members: Vec<FleetMemberRow>,
}

#[tauri::command]
pub async fn character_fleet(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<FleetView, AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    let sde = crate::sde::open_from_app(&app)?;

    // Not in a fleet → ESI 404; treat as "no fleet" rather than an error.
    let fleet: EsiFleet = match authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/fleet/"),
    )
    .await
    {
        Ok(f) => f,
        Err(_) => {
            return Ok(FleetView {
                in_fleet: false,
                members: Vec::new(),
            })
        }
    };
    let members: Vec<EsiFleetMember> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/fleets/{}/members/", fleet.fleet_id),
    )
    .await
    .map_err(|e| e.to_string())?;

    let char_ids: Vec<i64> = members.iter().map(|m| m.character_id).collect();
    let names = resolve_names(&auth_state, &char_ids).await;
    let systems = sde.system_names().map_err(|e| e.to_string())?;

    let rows = members
        .into_iter()
        .map(|m| FleetMemberRow {
            name: names
                .get(&m.character_id)
                .cloned()
                .unwrap_or_else(|| format!("#{}", m.character_id)),
            ship: sde
                .type_info(m.ship_type_id)
                .ok()
                .flatten()
                .map(|t| t.name)
                .unwrap_or_else(|| format!("Ship {}", m.ship_type_id)),
            system: systems
                .get(&m.solar_system_id)
                .cloned()
                .unwrap_or_else(|| format!("#{}", m.solar_system_id)),
            role: m.role_name,
            joined: m.join_time,
        })
        .collect();
    Ok(FleetView {
        in_fleet: true,
        members: rows,
    })
}

/// Parse an ESI RFC3339 timestamp (`2026-01-02T03:04:05Z`) to epoch seconds.
/// Falls back to "now" on a parse failure so a bad/missing timestamp reads as
/// zero elapsed time rather than propagating an error into a display calc.
fn parse_epoch(s: &str) -> f64 {
    crate::util::time::parse_rfc3339_epoch(s)
        .unwrap_or_else(|_| crate::util::time::now_secs()) as f64
}

#[cfg(test)]
mod tests {
    use super::{broker_fee_pct, parse_epoch, sales_tax_pct};

    #[test]
    fn sales_tax_scales_with_accounting() {
        assert!((sales_tax_pct(0) - 4.5).abs() < 1e-9);
        assert!((sales_tax_pct(5) - 2.025).abs() < 1e-9);
    }

    #[test]
    fn broker_fee_scales_and_floors_at_one() {
        assert!((broker_fee_pct(0, 0.0, 0.0) - 3.0).abs() < 1e-9);
        // BR V, +5 faction, +2 corp → 3 − 1.5 − 0.15 − 0.04 = 1.31
        assert!((broker_fee_pct(5, 5.0, 2.0) - 1.31).abs() < 1e-9);
        // Maxed standings can't push it below the 1% floor.
        assert!((broker_fee_pct(5, 10.0, 10.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn parses_known_utc_timestamps() {
        assert_eq!(parse_epoch("1970-01-01T00:00:00Z"), 0.0);
        assert_eq!(parse_epoch("2000-01-01T00:00:00Z"), 946_684_800.0);
        // Leap day plus a time-of-day, exercising the civil-days algorithm.
        assert_eq!(parse_epoch("2024-02-29T12:34:56Z"), 1_709_210_096.0);
    }

    #[test]
    fn later_timestamps_compare_greater() {
        assert!(parse_epoch("2026-01-01T00:00:00Z") > parse_epoch("2025-12-31T23:59:59Z"));
    }

    #[test]
    fn malformed_input_falls_back_to_now_without_panicking() {
        // Wrong shape / too short → falls back to the current epoch (large +ve),
        // never a panic.
        assert!(parse_epoch("nope") > 1_000_000_000.0);
        assert!(parse_epoch("").abs() >= 0.0);
    }
}
