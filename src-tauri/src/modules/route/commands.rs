//! Route module — per-system activity overlay (jumps + ship/pod/npc kills in
//! the last hour), from CCP's hourly aggregates. K-space only: wormhole systems
//! are excluded from these ESI endpoints, so they never appear here.
//!
//! These feed the route map / neighbour view (#99/#101); on their own they are a
//! sortable "where's the action / where's the danger" system table.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::esi::EsiClient;
use crate::sde::{Sde, SdePaths};
use crate::storage;

/// Max neighbourhood BFS depth (jumps out from the centre).
const MAX_DEPTH: i64 = 3;

/// Cache TTL for the merged activity — CCP refreshes these hourly, so half an
/// hour keeps it fresh without hammering ESI on every view switch.
const ACTIVITY_TTL_SECS: u64 = 1800;

#[derive(Deserialize)]
struct EsiJumps {
    system_id: i64,
    ship_jumps: i64,
}

#[derive(Deserialize)]
struct EsiKills {
    system_id: i64,
    ship_kills: i64,
    pod_kills: i64,
    npc_kills: i64,
}

/// Last-hour activity for one solar system, joined with SDE name/security/region.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemActivity {
    pub system_id: i64,
    pub name: String,
    pub region: String,
    /// Raw SDE security status (−1.0 … 1.0).
    pub security: f64,
    pub jumps: i64,
    pub ship_kills: i64,
    pub pod_kills: i64,
    pub npc_kills: i64,
}

/// Merge the jumps + kills aggregates into a per-system map. Pure (no I/O) so it
/// can be unit-tested; a system appears if it has *either* jumps or kills.
fn merge_activity(jumps: &[EsiJumps], kills: &[EsiKills]) -> HashMap<i64, SystemActivity> {
    let mut map: HashMap<i64, SystemActivity> = HashMap::new();
    for j in jumps {
        let e = map.entry(j.system_id).or_default();
        e.system_id = j.system_id;
        e.jumps = j.ship_jumps;
    }
    for k in kills {
        let e = map.entry(k.system_id).or_default();
        e.system_id = k.system_id;
        e.ship_kills = k.ship_kills;
        e.pod_kills = k.pod_kills;
        e.npc_kills = k.npc_kills;
    }
    map
}

/// Build the system-id → activity map: serve the ~30-min cache, else fetch the
/// jumps + kills aggregates, enrich with SDE name/security/region, and cache.
/// Shared by the activity table and the neighbourhood view.
async fn activity_map(dir: &Path, refresh: bool) -> Result<HashMap<i64, SystemActivity>, String> {
    if !refresh {
        if let Some(cached) = storage::cache_get::<Vec<SystemActivity>>(dir, "system_activity") {
            return Ok(cached.into_iter().map(|r| (r.system_id, r)).collect());
        }
    }

    let esi = EsiClient::new();
    let jumps: Vec<EsiJumps> = esi
        .get_json("/latest/universe/system_jumps/", &[])
        .await
        .map_err(|e| e.to_string())?;
    let kills: Vec<EsiKills> = esi
        .get_json("/latest/universe/system_kills/", &[])
        .await
        .map_err(|e| e.to_string())?;

    let mut activity = merge_activity(&jumps, &kills);

    // Enrich with SDE name / security / region (k-space systems only).
    let sde = Sde::open(&SdePaths::new(dir.to_path_buf()).db).map_err(|e| e.to_string())?;
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    for row in activity.values_mut() {
        if let Some((name, security, region)) = info.get(&row.system_id) {
            row.name = name.clone();
            row.security = *security;
            row.region = region.clone();
        }
    }

    let rows: Vec<SystemActivity> = activity.values().cloned().collect();
    let _ = storage::cache_put(dir, "system_activity", &rows, ACTIVITY_TTL_SECS);
    Ok(activity)
}

/// Per-system jumps + kills over the last hour, enriched with SDE names. Cached
/// (~30 min) to match CCP's hourly refresh; `refresh = true` bypasses the cache.
#[tauri::command]
pub async fn system_activity(
    app: AppHandle,
    refresh: bool,
) -> Result<Vec<SystemActivity>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut rows: Vec<SystemActivity> = activity_map(&dir, refresh).await?.into_values().collect();
    // Default ordering: busiest first (the UI re-sorts).
    rows.sort_by(|a, b| b.jumps.cmp(&a.jumps));
    Ok(rows)
}

/// Search solar systems by name (for the neighbourhood picker).
#[tauri::command]
pub fn system_search(app: AppHandle, query: String) -> Result<Vec<SystemMatch>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;
    Ok(sde
        .search_systems(&query, 20)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, name)| SystemMatch { id, name })
        .collect())
}

/// A node in the neighbourhood: a system + its distance (jumps) from the centre,
/// flattened with its last-hour activity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighbourNode {
    /// Jumps from the centre (0 = the centre system itself).
    pub distance: i64,
    #[serde(flatten)]
    pub activity: SystemActivity,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMatch {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Neighbourhood {
    pub center: i64,
    pub nodes: Vec<NeighbourNode>,
    /// Stargate edges `[a, b]` between systems in the neighbourhood (deduped).
    pub edges: Vec<[i64; 2]>,
}

/// The stargate neighbourhood around a system out to `depth` jumps, each node
/// carrying its last-hour jumps/kills heat. The "fog-of-war" view; until the
/// location scope lands (#99) the centre is chosen by search rather than auto.
#[tauri::command]
pub async fn system_neighbourhood(
    app: AppHandle,
    system_id: i64,
    depth: i64,
) -> Result<Neighbourhood, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let depth = depth.clamp(1, MAX_DEPTH);
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;

    // BFS over stargate edges, recording distance and deduped edges.
    let mut distance: HashMap<i64, i64> = HashMap::from([(system_id, 0)]);
    let mut frontier = vec![system_id];
    let mut edges: HashSet<(i64, i64)> = HashSet::new();
    for level in 1..=depth {
        let mut next = Vec::new();
        for (a, b) in sde.stargate_edges_from(&frontier).map_err(|e| e.to_string())? {
            edges.insert(if a <= b { (a, b) } else { (b, a) });
            if !distance.contains_key(&b) {
                distance.insert(b, level);
                next.push(b);
            }
        }
        frontier = next;
        if frontier.is_empty() {
            break;
        }
    }

    // Heat + names for every system in the neighbourhood.
    let activity = activity_map(&dir, false).await.unwrap_or_default();
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    let mut nodes: Vec<NeighbourNode> = distance
        .iter()
        .map(|(&sid, &dist)| {
            let mut act = activity.get(&sid).cloned().unwrap_or_default();
            act.system_id = sid;
            if act.name.is_empty() {
                if let Some((name, security, region)) = info.get(&sid) {
                    act.name = name.clone();
                    act.security = *security;
                    act.region = region.clone();
                }
            }
            NeighbourNode { distance: dist, activity: act }
        })
        .collect();
    // Centre first, then by distance, then busiest.
    nodes.sort_by(|a, b| {
        a.distance
            .cmp(&b.distance)
            .then_with(|| b.activity.jumps.cmp(&a.activity.jumps))
    });

    Ok(Neighbourhood {
        center: system_id,
        nodes,
        edges: edges.into_iter().map(|(a, b)| [a, b]).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_jumps_and_kills_by_system() {
        let jumps = [
            EsiJumps { system_id: 30000142, ship_jumps: 120 },
            EsiJumps { system_id: 30002187, ship_jumps: 5 },
        ];
        let kills = [
            EsiKills { system_id: 30000142, ship_kills: 3, pod_kills: 1, npc_kills: 50 },
            EsiKills { system_id: 30009999, ship_kills: 2, pod_kills: 0, npc_kills: 0 },
        ];
        let map = merge_activity(&jumps, &kills);

        // Jita: both jumps and kills merged onto one row.
        let jita = &map[&30000142];
        assert_eq!(jita.jumps, 120);
        assert_eq!(jita.ship_kills, 3);
        assert_eq!(jita.pod_kills, 1);
        assert_eq!(jita.npc_kills, 50);

        // Jumps-only system has zero kills; kills-only system has zero jumps.
        assert_eq!(map[&30002187].jumps, 5);
        assert_eq!(map[&30002187].ship_kills, 0);
        assert_eq!(map[&30009999].jumps, 0);
        assert_eq!(map[&30009999].ship_kills, 2);
        assert_eq!(map.len(), 3);
    }
}
