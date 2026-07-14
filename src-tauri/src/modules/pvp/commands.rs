//! PVP profiles — general zKillboard stats per pasted pilot (slice #532).

use std::collections::{HashMap, HashSet};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{resolve_character_ids, AuthState};
use crate::storage;

/// Cap on pasted names per lookup.
const NAME_CAP: usize = 128;
/// zKill etiquette: low concurrency behind our contact User-Agent.
const ZKILL_CONCURRENCY: usize = 4;
/// Killboard stats change slowly — cache each pilot for 6h.
const ZKILL_TTL_SECS: u64 = 21_600;

/// How many top hulls to surface per pilot (the UI shows the first 5 or 10).
const MAX_HULLS: usize = 10;

/// One hull the pilot uses, with how many kills they got in it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HullUsage {
    pub type_id: i64,
    pub name: String,
    pub kills: i64,
}

/// General PvP stats for one pilot, from zKillboard `/stats/`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PvpStats {
    pub character_id: i64,
    pub name: String,
    pub ships_destroyed: i64,
    pub ships_lost: i64,
    pub isk_destroyed: f64,
    pub isk_lost: f64,
    /// Kills made solo (vs in a gang).
    pub solo_kills: i64,
    pub solo_losses: i64,
    /// 0–100: share of engagements that were kills (higher = more dangerous).
    pub danger_ratio: i64,
    /// 0–100: share of kills made in a gang (vs solo).
    pub gang_ratio: i64,
    /// True when there's PvP activity in the last months (recently active).
    pub active: bool,
    /// The hulls the pilot flies most, by kills (from zKill `topLists`), up to
    /// `MAX_HULLS`, highest kills first. Per-hull *loss* counts aren't in the
    /// stats doc — they arrive with the loss killmails in a later slice.
    pub hulls: Vec<HullUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PvpProfilesResult {
    pub pilots: Vec<PvpStats>,
    /// Pasted names that didn't resolve to a character.
    pub unresolved: Vec<String>,
}

/// zKill `/stats/` document (defensive: pilots with no kills omit fields).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ZkillStatsRaw {
    #[serde(default)]
    ships_destroyed: i64,
    #[serde(default)]
    ships_lost: i64,
    #[serde(default)]
    isk_destroyed: f64,
    #[serde(default)]
    isk_lost: f64,
    #[serde(default)]
    solo_kills: i64,
    #[serde(default)]
    solo_losses: i64,
    #[serde(default)]
    danger_ratio: i64,
    #[serde(default)]
    gang_ratio: i64,
    /// Present (with counts) only for pilots with recent PvP.
    #[serde(default, rename = "activepvp")]
    activepvp: Option<serde_json::Value>,
    #[serde(default)]
    top_lists: Vec<TopListRaw>,
}

/// A row in a zKill `topLists` entry. Only the `shipType` list carries
/// `shipTypeID`/`shipName`; rows in the other lists leave them defaulted.
/// zKill uses `shipTypeID` (capital ID) and `shipName`, so the fields are
/// renamed explicitly rather than via `camelCase` (which yields `shipTypeId`).
#[derive(Deserialize, Default)]
struct ShipRow {
    #[serde(default, rename = "shipTypeID")]
    ship_type_id: i64,
    #[serde(default, rename = "shipName")]
    ship_name: String,
    #[serde(default)]
    kills: i64,
}

#[derive(Deserialize, Default)]
struct TopListRaw {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    values: Vec<ShipRow>,
}

/// Pasted names: one per line, trimmed, blanks dropped, deduped (order kept,
/// case-insensitive), capped.
fn parse_names(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| seen.insert(l.to_lowercase()))
        .take(NAME_CAP)
        .map(str::to_string)
        .collect()
}

/// Map one raw zKill stats doc onto our surface for `character_id`/`name`.
fn stats_from_raw(character_id: i64, name: String, r: ZkillStatsRaw) -> PvpStats {
    // The `shipType` top-list is the hulls the pilot flew to get kills, already
    // sorted by kills desc; take the top few.
    let hulls = r
        .top_lists
        .iter()
        .find(|t| t.kind == "shipType")
        .map(|t| {
            t.values
                .iter()
                .filter(|s| s.ship_type_id > 0)
                .take(MAX_HULLS)
                .map(|s| HullUsage {
                    type_id: s.ship_type_id,
                    name: s.ship_name.clone(),
                    kills: s.kills,
                })
                .collect()
        })
        .unwrap_or_default();
    PvpStats {
        character_id,
        name,
        ships_destroyed: r.ships_destroyed,
        ships_lost: r.ships_lost,
        isk_destroyed: r.isk_destroyed,
        isk_lost: r.isk_lost,
        solo_kills: r.solo_kills,
        solo_losses: r.solo_losses,
        danger_ratio: r.danger_ratio,
        gang_ratio: r.gang_ratio,
        active: r.activepvp.is_some(),
        hulls,
    }
}

/// Paste pilot names → resolve → per-pilot general zKill stats. Results keep the
/// pasted order; a per-pilot zKill failure drops only that pilot. Stats are
/// cached ~6h; names that don't resolve come back in `unresolved`.
#[tauri::command]
pub async fn pvp_profiles(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    text: String,
) -> Result<PvpProfilesResult, String> {
    let names = parse_names(&text);
    if names.is_empty() {
        return Ok(PvpProfilesResult {
            pilots: Vec::new(),
            unresolved: Vec::new(),
        });
    }
    let http = auth_state.http();
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let lower = |n: &str| n.to_lowercase();

    let id_cache = resolve_character_ids(&http, Some(&dir), &names).await;

    // Resolved (id, name) in pasted order, deduped by id; plus the misses.
    let mut seen = HashSet::new();
    let resolved: Vec<(i64, String)> = names
        .iter()
        .filter_map(|n| id_cache.get(&lower(n)).map(|&id| (id, n.clone())))
        .filter(|(id, _)| seen.insert(*id))
        .collect();
    let unresolved: Vec<String> = names
        .iter()
        .filter(|n| !id_cache.contains_key(&lower(n)))
        .cloned()
        .collect();

    let name_by_id: HashMap<i64, String> =
        resolved.iter().map(|(id, n)| (*id, n.clone())).collect();

    // Cache hits first; the rest fetched concurrently, low concurrency.
    let mut by_id: HashMap<i64, PvpStats> = HashMap::new();
    let mut to_fetch: Vec<i64> = Vec::new();
    for (id, name) in &resolved {
        match storage::cache_get::<PvpStats>(&dir, &format!("pvp_stats_{id}")) {
            Some(mut s) => {
                s.name = name.clone();
                by_id.insert(*id, s);
            }
            None => to_fetch.push(*id),
        }
    }

    let client = http.clone();
    let fetched: Vec<PvpStats> = stream::iter(to_fetch)
        .map(|id| {
            let client = client.clone();
            let name = name_by_id.get(&id).cloned().unwrap_or_default();
            async move {
                let url = format!("https://zkillboard.com/api/stats/characterID/{id}/");
                let raw: Option<ZkillStatsRaw> =
                    async { client.get(&url).send().await.ok()?.json().await.ok() }.await;
                raw.map(|r| stats_from_raw(id, name, r))
            }
        })
        .buffer_unordered(ZKILL_CONCURRENCY)
        .filter_map(|x| async move { x })
        .collect()
        .await;

    for s in &fetched {
        let _ = storage::cache_put(
            &dir,
            &format!("pvp_stats_{}", s.character_id),
            s,
            ZKILL_TTL_SECS,
        );
        by_id.insert(s.character_id, s.clone());
    }

    // Reassemble in pasted order (dropping pilots whose zKill fetch failed).
    let pilots: Vec<PvpStats> = resolved
        .iter()
        .filter_map(|(id, _)| by_id.get(id).cloned())
        .collect();

    Ok(PvpProfilesResult { pilots, unresolved })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_names_trims_dedupes_and_caps() {
        let names = parse_names("  Alice \n\nBob\nalice\n Bob \n");
        // Case-insensitive dedup, order preserved, blanks dropped.
        assert_eq!(names, vec!["Alice".to_string(), "Bob".to_string()]);
    }

    #[test]
    fn raw_stats_map_to_surface_and_activepvp_sets_active() {
        let raw: ZkillStatsRaw = serde_json::from_str(
            r#"{
                "shipsDestroyed": 120, "shipsLost": 8,
                "iskDestroyed": 5.0e10, "iskLost": 2.0e9,
                "soloKills": 30, "soloLosses": 2,
                "dangerRatio": 88, "gangRatio": 40,
                "activepvp": { "ships": { "count": 3 } }
            }"#,
        )
        .unwrap();
        let s = stats_from_raw(42, "Hunter".into(), raw);
        assert_eq!(s.character_id, 42);
        assert_eq!(s.ships_destroyed, 120);
        assert_eq!(s.solo_kills, 30);
        assert_eq!(s.danger_ratio, 88);
        assert!(s.active);
    }

    #[test]
    fn missing_fields_default_and_no_activepvp_is_inactive() {
        // A pilot with no PvP: zKill omits the fields entirely.
        let raw: ZkillStatsRaw = serde_json::from_str("{}").unwrap();
        let s = stats_from_raw(7, "Carebear".into(), raw);
        assert_eq!(s.ships_destroyed, 0);
        assert_eq!(s.isk_destroyed, 0.0);
        assert!(!s.active);
    }

    #[test]
    fn top_ship_list_becomes_flown_hulls_capped_and_ordered() {
        // zKill returns the shipType top-list already sorted by kills desc,
        // alongside other lists we ignore. Rows without a shipTypeID are skipped.
        let raw: ZkillStatsRaw = serde_json::from_str(
            r#"{
                "topLists": [
                    { "type": "solarSystem", "values": [ { "solarSystemID": 1, "kills": 99 } ] },
                    { "type": "shipType", "values": [
                        { "shipTypeID": 670, "shipName": "Capsule", "kills": 50 },
                        { "shipTypeID": 11567, "shipName": "Avatar", "kills": 20 },
                        { "shipName": "Ghost", "kills": 5 }
                    ] }
                ]
            }"#,
        )
        .unwrap();
        let s = stats_from_raw(1, "Ace".into(), raw);
        // The zero-typeId row is dropped; order preserved.
        assert_eq!(s.hulls.len(), 2);
        assert_eq!(s.hulls[0].type_id, 670);
        assert_eq!(s.hulls[0].name, "Capsule");
        assert_eq!(s.hulls[0].kills, 50);
        assert_eq!(s.hulls[1].name, "Avatar");
    }

    #[test]
    fn no_top_lists_yields_no_hulls() {
        let raw: ZkillStatsRaw = serde_json::from_str("{}").unwrap();
        assert!(stats_from_raw(1, "x".into(), raw).hulls.is_empty());
    }
}
