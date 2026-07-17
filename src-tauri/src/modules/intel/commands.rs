//! Intel commands: active incursions and faction-warfare warzone control.
//!
//! Both come from **public** ESI aggregates (`/incursions/`, `/fw/stats/`), so
//! no token is needed — the only auth touch is [`resolve_names`], which POSTs to
//! the public `/universe/names/` to turn system/constellation/faction ids into
//! names. Results are cached briefly on disk so flipping to the panel is instant
//! and we don't hammer ESI.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{resolve_names, AuthState, EsiClient};
use crate::storage;

// ------------------------------------------------------------------ Incursions

/// Raw `/incursions/` entry (the fields we keep).
#[derive(Deserialize)]
struct EsiIncursion {
    constellation_id: i64,
    faction_id: i64,
    has_boss: bool,
    infested_solar_systems: Vec<i64>,
    influence: f64,
    staging_solar_system_id: i64,
    state: String,
}

/// One active incursion for display. `Deserialize` too, since rows round-trip
/// through the on-disk TTL cache.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncursionRow {
    pub staging: String,
    pub constellation: String,
    pub faction: String,
    /// Remaining influence, 0.0 (about to end) … 1.0 (freshly spawned).
    pub influence: f64,
    /// The Sansha mothership has spawned (final stage — best payouts).
    pub has_boss: bool,
    /// `established` | `mobilizing` | `withdrawing`.
    pub state: String,
    /// Number of infested systems in the constellation.
    pub systems: usize,
}

/// Active incursions, most-contested (highest remaining influence) first.
/// Cached ~5 min on disk.
#[tauri::command]
pub async fn intel_incursions(
    app: AppHandle,
    auth: State<'_, AuthState>,
    esi: State<'_, EsiClient>,
) -> Result<Vec<IncursionRow>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    if let Some(cached) = storage::cache_get::<Vec<IncursionRow>>(&dir, "intel_incursions") {
        return Ok(cached);
    }

    let raw: Vec<EsiIncursion> = esi
        .get_json("/latest/incursions/", &[])
        .await
        .map_err(|e| e.to_string())?;

    // Resolve every staging system, constellation and faction in one names call.
    let mut ids: Vec<i64> = Vec::with_capacity(raw.len() * 3);
    for i in &raw {
        ids.push(i.staging_solar_system_id);
        ids.push(i.constellation_id);
        ids.push(i.faction_id);
    }
    let names = resolve_names(&auth, &ids).await;
    let name = |id: i64| names.get(&id).cloned().unwrap_or_else(|| format!("#{id}"));

    let mut rows: Vec<IncursionRow> = raw
        .into_iter()
        .map(|i| IncursionRow {
            staging: name(i.staging_solar_system_id),
            constellation: name(i.constellation_id),
            faction: name(i.faction_id),
            influence: i.influence,
            has_boss: i.has_boss,
            state: i.state,
            systems: i.infested_solar_systems.len(),
        })
        .collect();
    rows.sort_by(|a, b| {
        b.influence
            .partial_cmp(&a.influence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let _ = storage::cache_put(&dir, "intel_incursions", &rows, 300);
    Ok(rows)
}

// ------------------------------------------------------------- Faction warfare

/// The two faction-warfare warzones, keyed by any of their two participant
/// faction ids. Pure so it's unit-tested without ESI.
pub fn warzone(faction_id: i64) -> &'static str {
    match faction_id {
        500001 | 500004 => "Caldari–Gallente", // Caldari State / Gallente Federation
        500002 | 500003 => "Amarr–Minmatar",   // Minmatar Republic / Amarr Empire
        _ => "",
    }
}

/// Raw `/fw/stats/` entry.
#[derive(Deserialize)]
struct EsiFwStat {
    faction_id: i64,
    #[serde(default)]
    pilots: i64,
    #[serde(default)]
    systems_controlled: i64,
    #[serde(default)]
    kills: EsiFwCounts,
    #[serde(default)]
    victory_points: EsiFwCounts,
}

/// The `yesterday / last_week / total` shape ESI uses for FW kills and VP.
#[derive(Deserialize, Default)]
struct EsiFwCounts {
    #[serde(default)]
    yesterday: i64,
    #[serde(default)]
    last_week: i64,
}

/// One militia's faction-warfare standing for display. `Deserialize` too, since
/// rows round-trip through the on-disk TTL cache.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FwRow {
    pub faction: String,
    /// Which warzone this militia fights in (groups the two sides together).
    pub warzone: String,
    pub pilots: i64,
    pub systems_controlled: i64,
    pub kills_yesterday: i64,
    pub kills_last_week: i64,
    pub vp_yesterday: i64,
    pub vp_last_week: i64,
}

/// Faction-warfare per-militia stats (pilots, systems held, kills, victory
/// points), most systems held first. Cached ~10 min on disk.
#[tauri::command]
pub async fn intel_fw_stats(
    app: AppHandle,
    auth: State<'_, AuthState>,
    esi: State<'_, EsiClient>,
) -> Result<Vec<FwRow>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    if let Some(cached) = storage::cache_get::<Vec<FwRow>>(&dir, "intel_fw_stats") {
        return Ok(cached);
    }

    let raw: Vec<EsiFwStat> = esi
        .get_json("/latest/fw/stats/", &[])
        .await
        .map_err(|e| e.to_string())?;
    let ids: Vec<i64> = raw.iter().map(|s| s.faction_id).collect();
    let names = resolve_names(&auth, &ids).await;

    let mut rows: Vec<FwRow> = raw
        .into_iter()
        .map(|s| FwRow {
            faction: names
                .get(&s.faction_id)
                .cloned()
                .unwrap_or_else(|| format!("#{}", s.faction_id)),
            warzone: warzone(s.faction_id).to_string(),
            pilots: s.pilots,
            systems_controlled: s.systems_controlled,
            kills_yesterday: s.kills.yesterday,
            kills_last_week: s.kills.last_week,
            vp_yesterday: s.victory_points.yesterday,
            vp_last_week: s.victory_points.last_week,
        })
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.systems_controlled));

    let _ = storage::cache_put(&dir, "intel_fw_stats", &rows, 600);
    Ok(rows)
}

// ------------------------------------------------------------- FW system map

/// The four militia factions → display name.
pub fn faction_name(id: i64) -> &'static str {
    match id {
        500001 => "Caldari State",
        500002 => "Minmatar Republic",
        500003 => "Amarr Empire",
        500004 => "Gallente Federation",
        _ => "Unknown",
    }
}

/// Raw `/fw/systems/` entry.
#[derive(Deserialize)]
struct EsiFwSystem {
    solar_system_id: i64,
    owner_faction_id: i64,
    occupier_faction_id: i64,
    contested: String,
    #[serde(default)]
    victory_points: i64,
    #[serde(default)]
    victory_points_threshold: i64,
}

/// Raw `/universe/system_kills/` entry.
#[derive(Deserialize)]
struct EsiKills {
    system_id: i64,
    #[serde(default)]
    ship_kills: i64,
    #[serde(default)]
    pod_kills: i64,
}

/// Raw `/universe/system_jumps/` entry.
#[derive(Deserialize)]
struct EsiJumps {
    system_id: i64,
    #[serde(default)]
    ship_jumps: i64,
}

/// One faction-warfare system for the map + table.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FwSystemNode {
    pub system_id: i64,
    pub name: String,
    pub region: String,
    pub warzone: String,
    /// Security status (FW space is lowsec, ~0.1–0.4).
    pub security: f64,
    pub owner: String,
    pub occupier: String,
    pub owner_id: i64,
    pub occupier_id: i64,
    /// "uncontested" | "contested" | "vulnerable" | "captured".
    pub contested: String,
    /// Capture progress 0..1 (victory points / threshold).
    pub vp_pct: f64,
    /// Ship + pod kills in the last hour.
    pub kills: i64,
    /// Jumps in the last hour (traffic proxy — ESI has no live player count).
    pub jumps: i64,
    /// Galactic map-plane coordinates (seed the star-map layout).
    pub x: f64,
    pub z: f64,
}

/// The faction-warfare map: systems + the stargate edges between them.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FwMap {
    pub nodes: Vec<FwSystemNode>,
    pub edges: Vec<[i64; 2]>,
}

/// Every faction-warfare system with its owner/occupier, contested state and
/// capture progress, plus last-hour kills and jumps, and the stargate edges
/// between the systems (for the warzone map). Public data, cached ~5 min.
#[tauri::command]
pub async fn intel_fw_systems(app: AppHandle, esi: State<'_, EsiClient>) -> Result<FwMap, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    if let Some(cached) = storage::cache_get::<FwMap>(&dir, "intel_fw_systems") {
        return Ok(cached);
    }

    let systems: Vec<EsiFwSystem> = esi
        .get_json("/latest/fw/systems/", &[])
        .await
        .map_err(|e| e.to_string())?;
    // Kills / jumps are best-effort — the map still renders without them.
    let kills: Vec<EsiKills> = esi
        .get_json("/latest/universe/system_kills/", &[])
        .await
        .unwrap_or_default();
    let jumps: Vec<EsiJumps> = esi
        .get_json("/latest/universe/system_jumps/", &[])
        .await
        .unwrap_or_default();
    let kill_map: HashMap<i64, i64> = kills
        .into_iter()
        .map(|k| (k.system_id, k.ship_kills + k.pod_kills))
        .collect();
    let jump_map: HashMap<i64, i64> = jumps
        .into_iter()
        .map(|j| (j.system_id, j.ship_jumps))
        .collect();

    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    let pos = sde.solar_system_positions().map_err(|e| e.to_string())?;

    let fw_ids: HashSet<i64> = systems.iter().map(|s| s.solar_system_id).collect();
    let ids_vec: Vec<i64> = fw_ids.iter().copied().collect();

    // Stargate edges within the FW system set (undirected, deduped).
    let mut edge_set: HashSet<(i64, i64)> = HashSet::new();
    for (a, b) in sde
        .stargate_edges_from(&ids_vec)
        .map_err(|e| e.to_string())?
    {
        if fw_ids.contains(&b) {
            edge_set.insert(if a <= b { (a, b) } else { (b, a) });
        }
    }
    let edges: Vec<[i64; 2]> = edge_set.into_iter().map(|(a, b)| [a, b]).collect();

    let mut nodes: Vec<FwSystemNode> = systems
        .into_iter()
        .map(|s| {
            let (name, security, region) = info
                .get(&s.solar_system_id)
                .map(|(n, sec, r)| (n.clone(), *sec, r.clone()))
                .unwrap_or_else(|| (format!("#{}", s.solar_system_id), 0.0, String::new()));
            let (x, z) = pos.get(&s.solar_system_id).copied().unwrap_or((0.0, 0.0));
            let vp_pct = if s.victory_points_threshold > 0 {
                s.victory_points as f64 / s.victory_points_threshold as f64
            } else {
                0.0
            };
            FwSystemNode {
                system_id: s.solar_system_id,
                name,
                region,
                warzone: warzone(s.owner_faction_id).to_string(),
                security,
                owner: faction_name(s.owner_faction_id).to_string(),
                occupier: faction_name(s.occupier_faction_id).to_string(),
                owner_id: s.owner_faction_id,
                occupier_id: s.occupier_faction_id,
                contested: s.contested,
                vp_pct,
                kills: kill_map.get(&s.solar_system_id).copied().unwrap_or(0),
                jumps: jump_map.get(&s.solar_system_id).copied().unwrap_or(0),
                x,
                z,
            }
        })
        .collect();
    // Most-contested first in the table (highest capture progress on top).
    nodes.sort_by(|a, b| {
        b.vp_pct
            .partial_cmp(&a.vp_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let map = FwMap { nodes, edges };
    let _ = storage::cache_put(&dir, "intel_fw_systems", &map, 300);
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::{faction_name, warzone};

    #[test]
    fn faction_name_maps_the_four_militias() {
        assert_eq!(faction_name(500001), "Caldari State");
        assert_eq!(faction_name(500004), "Gallente Federation");
        assert_eq!(faction_name(0), "Unknown");
    }

    #[test]
    fn maps_each_militia_to_its_warzone() {
        assert_eq!(warzone(500001), "Caldari–Gallente"); // Caldari State
        assert_eq!(warzone(500004), "Caldari–Gallente"); // Gallente Federation
        assert_eq!(warzone(500003), "Amarr–Minmatar"); // Amarr Empire
        assert_eq!(warzone(500002), "Amarr–Minmatar"); // Minmatar Republic
        assert_eq!(warzone(99), ""); // not a militia
    }
}
