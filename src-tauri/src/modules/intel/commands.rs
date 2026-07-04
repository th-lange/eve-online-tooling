//! Intel commands: active incursions and faction-warfare warzone control.
//!
//! Both come from **public** ESI aggregates (`/incursions/`, `/fw/stats/`), so
//! no token is needed — the only auth touch is [`resolve_names`], which POSTs to
//! the public `/universe/names/` to turn system/constellation/faction ids into
//! names. Results are cached briefly on disk so flipping to the panel is instant
//! and we don't hammer ESI.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

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
) -> Result<Vec<IncursionRow>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(cached) = storage::cache_get::<Vec<IncursionRow>>(&dir, "intel_incursions") {
        return Ok(cached);
    }

    let raw: Vec<EsiIncursion> = EsiClient::new()
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
) -> Result<Vec<FwRow>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(cached) = storage::cache_get::<Vec<FwRow>>(&dir, "intel_fw_stats") {
        return Ok(cached);
    }

    let raw: Vec<EsiFwStat> = EsiClient::new()
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

#[cfg(test)]
mod tests {
    use super::warzone;

    #[test]
    fn maps_each_militia_to_its_warzone() {
        assert_eq!(warzone(500001), "Caldari–Gallente"); // Caldari State
        assert_eq!(warzone(500004), "Caldari–Gallente"); // Gallente Federation
        assert_eq!(warzone(500003), "Amarr–Minmatar"); // Amarr Empire
        assert_eq!(warzone(500002), "Amarr–Minmatar"); // Minmatar Republic
        assert_eq!(warzone(99), ""); // not a militia
    }
}
