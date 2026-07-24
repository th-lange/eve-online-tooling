//! zKillboard (`https://zkillboard.com`) — a free, no-auth community killboard
//! that aggregates every public killmail. It has no first-party client, so this
//! is the one place we speak its API instead of duplicating the fetch/parse/
//! cache machinery in every feature that wants danger signals or loss history.
//! Two feature modules use it: `localintel` (per-pilot danger stats for a
//! pasted Local list) and `pvp` (general pilot stats + reconstructed lost
//! fits), so it lives here as a shared service rather than inside either.
//!
//! zKill asks integrators for a descriptive User-Agent and modest concurrency;
//! we build every client with our contact UA and cap concurrent requests at
//! [`ZKILL_CONCURRENCY`]. Stats change slowly, so they're cached per-character
//! for [`ZKILL_TTL_SECS`] (~6h) — losses aren't cached here since callers cache
//! the killmails they fetch from ESI instead (killmails are immutable; the
//! loss *list* isn't worth caching on its own).

use std::path::Path;

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};

use crate::esi::fetch_json_url;
use crate::storage;

/// zKillboard etiquette: a descriptive UA (we have one) and low concurrency.
pub const ZKILL_CONCURRENCY: usize = 4;
/// Killboard stats change slowly — cache each character for 6h.
pub const ZKILL_TTL_SECS: u64 = 21_600;

fn stats_url(character_id: i64) -> String {
    format!("https://zkillboard.com/api/stats/characterID/{character_id}/")
}

fn losses_by_character_url(character_id: i64) -> String {
    format!("https://zkillboard.com/api/losses/characterID/{character_id}/")
}

fn losses_by_ship_type_url(type_id: i64) -> String {
    format!("https://zkillboard.com/api/losses/shipTypeID/{type_id}/")
}

/// Cache key for one character's raw stats document. Namespaced under
/// `zkill_stats_` (rather than the bare `zkill_`/`pvp_stats_` prefixes the two
/// call sites used before) so it can't collide with any other per-id zKill
/// cache entry (e.g. a future losses or killmail cache) now that both callers
/// share the same cache directory.
fn stats_cache_key(character_id: i64) -> String {
    format!("zkill_stats_{character_id}")
}

/// A zKill-etiquette HTTP client carrying our contact User-Agent (and the
/// shared connect/request timeouts, so a hung host can't stall a command).
fn client() -> Result<reqwest::Client, String> {
    crate::esi::http_client_builder()
        .build()
        .map_err(|e| e.to_string())
}

/// Raw zKill `/stats/` document (defensive: pilots with no kills omit fields).
/// A superset of every field either caller needs; callers project only what
/// they surface.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ZkillStatsRaw {
    #[serde(default)]
    pub danger_ratio: i64,
    #[serde(default)]
    pub gang_ratio: i64,
    #[serde(default)]
    pub ships_destroyed: i64,
    #[serde(default)]
    pub ships_lost: i64,
    #[serde(default)]
    pub isk_destroyed: f64,
    #[serde(default)]
    pub isk_lost: f64,
    #[serde(default)]
    pub solo_kills: i64,
    #[serde(default)]
    pub solo_losses: i64,
    /// Present (with counts) only for pilots with recent PvP.
    #[serde(default, rename = "activepvp")]
    activepvp: Option<serde_json::Value>,
    #[serde(default)]
    pub top_lists: Vec<TopListRaw>,
}

impl ZkillStatsRaw {
    /// True if there is PvP activity in the last months (recently active).
    /// `activepvp` is present (with kill counts) for active pilots.
    pub fn active(&self) -> bool {
        self.activepvp.is_some()
    }
}

/// A row in a zKill `topLists` entry. Only the `shipType` list carries
/// `shipTypeID`/`shipName`; rows in the other lists leave them defaulted.
/// zKill uses `shipTypeID` (capital ID) and `shipName`, so the fields are
/// renamed explicitly rather than via `camelCase` (which yields `shipTypeId`).
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ShipRow {
    #[serde(default, rename = "shipTypeID")]
    pub ship_type_id: i64,
    #[serde(default, rename = "shipName")]
    pub ship_name: String,
    #[serde(default)]
    pub kills: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct TopListRaw {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub values: Vec<ShipRow>,
}

/// Fetch zKill `/stats/` for each character id, serving cache hits first (TTL
/// [`ZKILL_TTL_SECS`]) and fetching the misses concurrently (capped at
/// [`ZKILL_CONCURRENCY`]) behind our contact User-Agent. A per-character fetch
/// failure simply omits that id from the result — callers treat a missing id
/// as "no data" (skip the pilot, or fall back to a default projection) rather
/// than failing the whole batch. Order is not preserved; callers re-key by id.
pub async fn stats_for_characters(
    dir: &Path,
    character_ids: &[i64],
) -> Result<Vec<(i64, ZkillStatsRaw)>, String> {
    // Serve cache hits first; only fetch the misses.
    let mut out: Vec<(i64, ZkillStatsRaw)> = Vec::new();
    let mut to_fetch: Vec<i64> = Vec::new();
    for &id in character_ids {
        match storage::cache_get::<ZkillStatsRaw>(dir, &stats_cache_key(id)) {
            Some(s) => out.push((id, s)),
            None => to_fetch.push(id),
        }
    }

    let http = client()?;
    let fetched: Vec<(i64, ZkillStatsRaw)> = stream::iter(to_fetch)
        .map(|id| {
            let http = http.clone();
            async move {
                let raw: Option<ZkillStatsRaw> = fetch_json_url(&http, &stats_url(id)).await;
                raw.map(|r| (id, r))
            }
        })
        .buffer_unordered(ZKILL_CONCURRENCY)
        .filter_map(|x| async move { x })
        .collect()
        .await;

    for (id, raw) in &fetched {
        let _ = storage::cache_put(dir, &stats_cache_key(*id), raw, ZKILL_TTL_SECS);
    }
    out.extend(fetched);
    Ok(out)
}

/// A zKill loss-list entry: a killmail id + the hash needed to fetch the full
/// killmail from public ESI.
#[derive(Debug, Clone, Deserialize)]
pub struct ZkillLossRef {
    pub killmail_id: i64,
    pub zkb: ZkillZkb,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ZkillZkb {
    pub hash: String,
}

async fn fetch_losses(url: String) -> Vec<ZkillLossRef> {
    let Ok(http) = client() else {
        return Vec::new();
    };
    fetch_json_url(&http, &url).await.unwrap_or_default()
}

/// Recent losses for one character, newest first. Killmails themselves aren't
/// fetched here — callers pull each one from public ESI (and cache it, since
/// killmails are immutable) using the returned id/hash pairs.
pub async fn losses_for_character(character_id: i64) -> Vec<ZkillLossRef> {
    fetch_losses(losses_by_character_url(character_id)).await
}

/// Recent community losses of one ship type, newest first.
pub async fn losses_for_ship_type(type_id: i64) -> Vec<ZkillLossRef> {
    fetch_losses(losses_by_ship_type_url(type_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_raw_maps_camelcase_fields_and_activepvp_sets_active() {
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
        assert_eq!(raw.ships_destroyed, 120);
        assert_eq!(raw.ships_lost, 8);
        assert_eq!(raw.isk_destroyed, 5.0e10);
        assert_eq!(raw.isk_lost, 2.0e9);
        assert_eq!(raw.solo_kills, 30);
        assert_eq!(raw.solo_losses, 2);
        assert_eq!(raw.danger_ratio, 88);
        assert_eq!(raw.gang_ratio, 40);
        assert!(raw.active());
    }

    #[test]
    fn stats_raw_missing_fields_default_and_no_activepvp_is_inactive() {
        // A character with no PvP: zKill omits the fields entirely.
        let raw: ZkillStatsRaw = serde_json::from_str("{}").unwrap();
        assert_eq!(raw.ships_destroyed, 0);
        assert_eq!(raw.danger_ratio, 0);
        assert!(!raw.active());
    }

    #[test]
    fn stats_raw_parses_ship_type_top_list() {
        let raw: ZkillStatsRaw = serde_json::from_str(
            r#"{
                "topLists": [
                    { "type": "shipType", "values": [
                        { "shipTypeID": 587, "shipName": "Rifter", "kills": 50 }
                    ] }
                ]
            }"#,
        )
        .unwrap();
        let ship_type = raw.top_lists.iter().find(|t| t.kind == "shipType").unwrap();
        assert_eq!(ship_type.values[0].ship_type_id, 587);
        assert_eq!(ship_type.values[0].ship_name, "Rifter");
        assert_eq!(ship_type.values[0].kills, 50);
    }
}
