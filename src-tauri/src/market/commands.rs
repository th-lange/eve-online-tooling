//! Tauri command surface for the market service.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{authed_get, AuthState};
use crate::sde::graph;
use crate::storage;

use super::markets::{regions, resolve_location, Region};
use super::service::MarketService;
use super::types::{Order, PriceModel};

pub use crate::model::{id_names, IdName};

/// One day of market history, for the history explorer (camelCase for the UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub date: String,
    pub average: f64,
    pub highest: f64,
    pub lowest: f64,
    pub volume: i64,
    pub order_count: i64,
}

/// Daily market history for a type in a region (ascending by date).
#[tauri::command]
pub async fn market_history(
    service: State<'_, MarketService>,
    region_id: i64,
    type_id: i64,
) -> Result<Vec<HistoryPoint>, String> {
    let days = service
        .history(region_id, type_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(days
        .into_iter()
        .map(|d| HistoryPoint {
            date: d.date,
            average: d.average,
            highest: d.highest,
            lowest: d.lowest,
            volume: d.volume,
            order_count: d.order_count,
        })
        .collect())
}

/// The selectable regions, each with its hub station.
#[tauri::command]
pub fn market_regions() -> Vec<Region> {
    regions()
}

/// Price model for a single type at a region (and optional station), via live
/// ESI orders + history.
#[tauri::command]
pub async fn market_price(
    service: State<'_, MarketService>,
    region_id: i64,
    station_id: Option<i64>,
    type_id: i64,
) -> Result<PriceModel, String> {
    let location = resolve_location(region_id, station_id);
    service
        .price_model(location, type_id)
        .await
        .map_err(|e| e.to_string())
}

// --- Market search (order list + jumps) ---

/// Every known-space region, for the region picker. Backed by the SDE, so it
/// covers all of k-space — not just the five trade hubs in [`regions`].
#[tauri::command]
pub fn market_all_regions(app: AppHandle) -> Result<Vec<IdName>, String> {
    let sde = crate::sde::open_from_app(&app)?;
    Ok(id_names(sde.market_regions().map_err(|e| e.to_string())?))
}

/// Search NPC stations by name (for the optional station filter). Capped.
#[tauri::command]
pub fn market_search_stations(app: AppHandle, query: String) -> Result<Vec<IdName>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let sde = crate::sde::open_from_app(&app)?;
    Ok(id_names(
        sde.search_stations(&query, 25).map_err(|e| e.to_string())?,
    ))
}

/// The logged-in character's current system + region, used to default the
/// search to "current region" and to anchor the jumps-to-station column.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentLocation {
    pub system_id: i64,
    pub system_name: String,
    pub security: f64,
    pub region_id: i64,
    pub region_name: String,
}

#[derive(serde::Deserialize)]
struct EsiLocation {
    solar_system_id: i64,
}

/// Resolve the active character's current location (system + region). Returns
/// `None` when nobody is logged in (or the location scope is missing) so the UI
/// can fall back to a default region and a pickable jumps origin.
#[tauri::command]
pub async fn market_current_location(
    app: AppHandle,
    auth: State<'_, AuthState>,
) -> Result<Option<CurrentLocation>, String> {
    let dir = storage::app_data_dir(&app)?;
    let Some(character_id) = storage::active_character(&dir) else {
        return Ok(None);
    };
    let loc: EsiLocation = match authed_get(
        &auth,
        character_id,
        &format!("/latest/characters/{character_id}/location/"),
    )
    .await
    {
        Ok(loc) => loc,
        // No scope / token trouble shouldn't break the page — just no default.
        Err(_) => return Ok(None),
    };

    let sde = crate::sde::open_from_app(&app)?;
    let Some(info) = sde
        .system_info(loc.solar_system_id)
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    Ok(Some(CurrentLocation {
        system_id: loc.solar_system_id,
        system_name: info.name,
        security: info.security,
        region_id: info.region_id,
        region_name: info.region_name,
    }))
}

/// Filters for a market-search order query. All location fields are optional;
/// precedence is station → system → region → everywhere (every k-space region).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SellOrdersParams {
    pub type_id: i64,
    pub region_id: Option<i64>,
    pub system_id: Option<i64>,
    pub station_id: Option<i64>,
    /// Where the jumps column is measured from. None → no jumps computed.
    pub origin_system_id: Option<i64>,
    /// Route only through high-sec (≥ 0.45) systems for the jumps count.
    #[serde(default)]
    pub high_sec_only: bool,
}

/// One sell order in the order list, enriched with location + jumps.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SellOrder {
    pub price: f64,
    pub volume_remain: i64,
    pub station_id: i64,
    pub station_name: String,
    pub system_id: i64,
    pub system_name: String,
    pub region_name: String,
    /// Raw SDE security of the system (−1.0 … 1.0).
    pub security: f64,
    /// Jumps from the origin system; null = no origin or unreachable.
    pub jumps: Option<i64>,
}

/// Cap on rows returned to the UI (cheapest first) — an "everywhere" scan can
/// turn up thousands of orders.
const MAX_ORDERS: usize = 500;

/// Sell orders for a type across the chosen scope, cheapest first, each row
/// carrying its station/system/region and jumps from the origin system. Honours
/// the high-sec-only routing toggle.
#[tauri::command]
pub async fn market_sell_orders(
    app: AppHandle,
    service: State<'_, MarketService>,
    params: SellOrdersParams,
) -> Result<Vec<SellOrder>, String> {
    let sde = crate::sde::open_from_app(&app)?;

    // Resolve the region set + any narrower (system/station) filter.
    let mut system_filter: Option<i64> = params.system_id;
    let station_filter: Option<i64> = params.station_id;
    let region_ids: Vec<i64> = if let Some(station_id) = station_filter {
        let (system_id, region_id) = sde
            .station_location(station_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Unknown station".to_string())?;
        // A station pins its system too (for filtering structure-free results).
        system_filter = Some(system_id);
        vec![region_id]
    } else if let Some(system_id) = system_filter {
        let region_id = sde
            .system_region(system_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Unknown system".to_string())?;
        vec![region_id]
    } else if let Some(region_id) = params.region_id {
        vec![region_id]
    } else {
        sde.market_regions()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    };

    // Fetch each region's orders concurrently; swallow per-region errors so one
    // bad region can't sink an everywhere scan.
    use futures_util::stream::{self, StreamExt};
    const CONCURRENCY: usize = 16;
    let fetched: Vec<Order> = stream::iter(region_ids)
        .map(|region_id| {
            let service = &service;
            let type_id = params.type_id;
            async move {
                service
                    .region_orders(region_id, type_id)
                    .await
                    .unwrap_or_default()
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect::<Vec<Vec<Order>>>()
        .await
        .into_iter()
        .flatten()
        .collect();

    // Keep sell orders matching the (optional) station / system filter.
    let mut sells: Vec<Order> = fetched
        .into_iter()
        .filter(|o| !o.is_buy_order)
        .filter(|o| station_filter.is_none_or(|s| o.location_id == s))
        .filter(|o| system_filter.is_none_or(|s| o.system_id == s))
        .collect();
    sells.sort_by(|a, b| a.price.total_cmp(&b.price));
    sells.truncate(MAX_ORDERS);

    // Jumps from the origin system over the stargate graph (optionally hi-sec).
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    let distances = match params.origin_system_id {
        Some(origin) => {
            let edges = sde.all_stargate_edges().map_err(|e| e.to_string())?;
            jump_distances(origin, &edges, &info, params.high_sec_only)
        }
        None => HashMap::new(),
    };

    // NPC station names in bulk; structures (not in the SDE) fall back to a label.
    let station_ids: Vec<i64> = sells.iter().map(|o| o.location_id).collect();
    let names = sde.station_names(&station_ids).map_err(|e| e.to_string())?;

    let rows = sells
        .into_iter()
        .map(|o| {
            let (system_name, security, region_name) = info
                .get(&o.system_id)
                .cloned()
                .unwrap_or_else(|| (String::new(), 0.0, String::new()));
            let station_name = names.get(&o.location_id).cloned().unwrap_or_else(|| {
                if system_name.is_empty() {
                    format!("Structure {}", o.location_id)
                } else {
                    format!("{system_name} — structure")
                }
            });
            SellOrder {
                price: o.price,
                volume_remain: o.volume_remain,
                station_id: o.location_id,
                station_name,
                system_id: o.system_id,
                system_name,
                region_name,
                security,
                jumps: params
                    .origin_system_id
                    .map(|_| distances.get(&o.system_id).copied())
                    .unwrap_or(None),
            }
        })
        .collect();
    Ok(rows)
}

/// Breadth-first jumps from `origin` to every reachable system over the stargate
/// graph. When `high_sec_only` is set, only systems with security ≥ 0.45 (i.e.
/// rounding to 0.5+) are traversable — the origin itself is always seeded so a
/// low-sec start can still reach high-sec neighbours' counts of 0.
fn jump_distances(
    origin: i64,
    edges: &[(i64, i64)],
    info: &HashMap<i64, (String, f64, String)>,
    high_sec_only: bool,
) -> HashMap<i64, i64> {
    let is_highsec = |sid: i64| info.get(&sid).map(|i| i.1 >= 0.45).unwrap_or(false);

    // Optionally restrict to high-sec-endpoint edges before building adjacency.
    let filtered: Vec<(i64, i64)> = if high_sec_only {
        edges
            .iter()
            .copied()
            .filter(|&(a, b)| is_highsec(a) && is_highsec(b))
            .collect()
    } else {
        edges.to_vec()
    };
    let adj = graph::undirected_adjacency(&filtered);
    graph::bfs(&adj, origin, None).0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> HashMap<i64, (String, f64, String)> {
        // 1: 0.9, 2: 0.5, 3: 0.1 (low), 4: 0.6 — a low-sec system breaks the chain.
        [
            (1, ("A".into(), 0.9, "R".into())),
            (2, ("B".into(), 0.5, "R".into())),
            (3, ("C".into(), 0.1, "R".into())),
            (4, ("D".into(), 0.6, "R".into())),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn shortest_path_counts_every_jump() {
        let edges = [(1, 2), (2, 3), (3, 4)];
        let dist = jump_distances(1, &edges, &info(), false);
        assert_eq!(dist[&1], 0);
        assert_eq!(dist[&2], 1);
        assert_eq!(dist[&3], 2);
        assert_eq!(dist[&4], 3);
    }

    #[test]
    fn high_sec_only_stops_at_low_sec() {
        let edges = [(1, 2), (2, 3), (3, 4)];
        let dist = jump_distances(1, &edges, &info(), true);
        // Reachable through high-sec only: 1 and 2; 3 is low-sec, so 3 and the
        // high-sec 4 behind it are unreachable.
        assert_eq!(dist[&1], 0);
        assert_eq!(dist[&2], 1);
        assert!(!dist.contains_key(&3));
        assert!(!dist.contains_key(&4));
    }
}
