//! Route module — per-system activity overlay (jumps + ship/pod/npc kills in
//! the last hour), from CCP's hourly aggregates. K-space only: wormhole systems
//! are excluded from these ESI endpoints, so they never appear here.
//!
//! These feed the route map / neighbour view (#99/#101); on their own they are a
//! sortable "where's the action / where's the danger" system table.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::esi::EsiClient;
use crate::sde::{Sde, SdePaths};
use crate::storage;

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

/// Per-system jumps + kills over the last hour, enriched with SDE names. Cached
/// (~30 min) to match CCP's hourly refresh; `refresh = true` bypasses the cache.
#[tauri::command]
pub async fn system_activity(
    app: AppHandle,
    refresh: bool,
) -> Result<Vec<SystemActivity>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !refresh {
        if let Some(cached) = storage::cache_get::<Vec<SystemActivity>>(&dir, "system_activity") {
            return Ok(cached);
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
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    for row in activity.values_mut() {
        if let Some((name, security, region)) = info.get(&row.system_id) {
            row.name = name.clone();
            row.security = *security;
            row.region = region.clone();
        }
    }

    let mut rows: Vec<SystemActivity> = activity.into_values().collect();
    // Default ordering: busiest first (the UI re-sorts).
    rows.sort_by(|a, b| b.jumps.cmp(&a.jumps));

    let _ = storage::cache_put(&dir, "system_activity", &rows, ACTIVITY_TTL_SECS);
    Ok(rows)
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
