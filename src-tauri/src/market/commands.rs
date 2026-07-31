//! Tauri command surface for the market service.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{authed_get, AuthState};
use crate::sde::graph;
use crate::storage;

use super::aggregate::filter_outliers;
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
    /// Drop outlier orders (scam guard) before listing. Default on.
    #[serde(default = "default_true")]
    pub exclude_scams: bool,
}

fn default_true() -> bool {
    true
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

    // Resolve the region set + any narrower (system/station) filter, then fetch.
    let Scope {
        region_ids,
        system_filter,
        station_filter,
    } = resolve_scope(&sde, params.region_id, params.system_id, params.station_id)?;
    let fetched = fetch_region_orders(&service, region_ids, params.type_id).await;

    // Keep sell orders matching the (optional) station / system filter.
    let sells: Vec<Order> = fetched
        .into_iter()
        .filter(|o| !o.is_buy_order)
        .filter(|o| station_filter.is_none_or(|s| o.location_id == s))
        .filter(|o| system_filter.is_none_or(|s| o.system_id == s))
        .collect();
    // Scam guard: drop overpriced sell outliers within the scope
    // before ranking/truncating (on by default).
    let mut sells = if params.exclude_scams {
        filter_outliers(&sells)
    } else {
        sells
    };
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

/// A resolved market-scope selection: which regions to fetch, and the narrower
/// filters to apply afterward.
struct Scope {
    region_ids: Vec<i64>,
    system_filter: Option<i64>,
    station_filter: Option<i64>,
}

/// Resolve a market-scope selection into the region set to fetch plus the
/// narrower system/station filters to apply after fetching. Precedence:
/// station → system → region → everywhere (every k-space region). A station
/// also pins its system.
fn resolve_scope(
    sde: &crate::sde::Sde,
    region_id: Option<i64>,
    system_id: Option<i64>,
    station_id: Option<i64>,
) -> Result<Scope, String> {
    let mut system_filter = system_id;
    let region_ids = if let Some(station_id) = station_id {
        let (system_id, region_id) = sde
            .station_location(station_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Unknown station".to_string())?;
        system_filter = Some(system_id);
        vec![region_id]
    } else if let Some(system_id) = system_filter {
        let region_id = sde
            .system_region(system_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Unknown system".to_string())?;
        vec![region_id]
    } else if let Some(region_id) = region_id {
        vec![region_id]
    } else {
        sde.market_regions()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    };
    Ok(Scope {
        region_ids,
        system_filter,
        station_filter: station_id,
    })
}

/// Fetch every region's orders for a type concurrently, flattening into one
/// list. Per-region errors are swallowed so one bad region can't sink a scan.
async fn fetch_region_orders(
    service: &MarketService,
    region_ids: Vec<i64>,
    type_id: i64,
) -> Vec<Order> {
    use futures_util::stream::{self, StreamExt};
    const CONCURRENCY: usize = 16;
    stream::iter(region_ids)
        .map(|region_id| async move {
            service
                .region_orders(region_id, type_id)
                .await
                .unwrap_or_default()
        })
        .buffer_unordered(CONCURRENCY)
        .collect::<Vec<Vec<Order>>>()
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// One price level in the order book: total remaining units at that price.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthLevel {
    pub price: f64,
    pub volume: i64,
}

/// Aggregated order book for the depth chart: sell levels ascending by price,
/// buy levels descending. Cumulative curves are built on the client.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderBook {
    pub sell: Vec<DepthLevel>,
    pub buy: Vec<DepthLevel>,
}

/// Sum order volume into price levels, then sort. `ascending` for the sell side
/// (cheapest first), descending for the buy side (highest bid first).
fn depth_levels(orders: impl Iterator<Item = Order>, ascending: bool) -> Vec<DepthLevel> {
    let mut by_price: std::collections::BTreeMap<u64, i64> = std::collections::BTreeMap::new();
    for o in orders {
        // Bit-pattern key keeps f64 ordering for non-negative prices (all prices
        // are > 0), so the BTreeMap stays price-sorted.
        *by_price.entry(o.price.to_bits()).or_default() += o.volume_remain;
    }
    let mut levels: Vec<DepthLevel> = by_price
        .into_iter()
        .map(|(bits, volume)| DepthLevel {
            price: f64::from_bits(bits),
            volume,
        })
        .collect();
    if !ascending {
        levels.reverse();
    }
    levels
}

/// Aggregated buy + sell order book for a type across the chosen scope, for the
/// depth chart. Honours the same scope + scam-guard as [`market_sell_orders`].
#[tauri::command]
pub async fn market_order_book(
    app: AppHandle,
    service: State<'_, MarketService>,
    params: SellOrdersParams,
) -> Result<OrderBook, String> {
    let sde = crate::sde::open_from_app(&app)?;
    let Scope {
        region_ids,
        system_filter,
        station_filter,
    } = resolve_scope(&sde, params.region_id, params.system_id, params.station_id)?;
    let fetched = fetch_region_orders(&service, region_ids, params.type_id).await;
    let scoped: Vec<Order> = fetched
        .into_iter()
        .filter(|o| station_filter.is_none_or(|s| o.location_id == s))
        .filter(|o| system_filter.is_none_or(|s| o.system_id == s))
        .collect();
    let scoped = if params.exclude_scams {
        filter_outliers(&scoped)
    } else {
        scoped
    };
    Ok(OrderBook {
        sell: depth_levels(scoped.iter().filter(|o| !o.is_buy_order).cloned(), true),
        buy: depth_levels(scoped.iter().filter(|o| o.is_buy_order).cloned(), false),
    })
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
    // Edges incident to the origin always survive: a traveller starting in
    // low-sec can still reach the neighbouring high-sec systems (they're one
    // gate away), and dropping those would strand the search at the origin.
    let filtered: Vec<(i64, i64)> = if high_sec_only {
        edges
            .iter()
            .copied()
            .filter(|&(a, b)| (is_highsec(a) || a == origin) && (is_highsec(b) || b == origin))
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

    #[test]
    fn high_sec_only_still_leaves_a_low_sec_origin() {
        // Origin 3 is low-sec with high-sec neighbours 2 and 4: both are one
        // gate away and must be reachable, while the search must not transit
        // any *other* low-sec system.
        let mut info = info();
        info.insert(5, ("E".into(), 0.2, "R".into())); // another low-sec
        let edges = [(3, 2), (3, 4), (3, 5), (5, 1)];
        let dist = jump_distances(3, &edges, &info, true);
        assert_eq!(dist[&3], 0);
        assert_eq!(dist[&2], 1);
        assert_eq!(dist[&4], 1);
        // Low-sec 5 (and high-sec 1 behind it) stay unreachable.
        assert!(!dist.contains_key(&5));
        assert!(!dist.contains_key(&1));
    }

    fn order(price: f64, is_buy: bool, volume: i64) -> Order {
        Order {
            price,
            is_buy_order: is_buy,
            location_id: 0,
            volume_remain: volume,
            system_id: 0,
        }
    }

    #[test]
    fn depth_levels_aggregates_by_price_and_orders_each_side() {
        let sells = [
            order(10.0, false, 5),
            order(10.0, false, 3),
            order(12.0, false, 7),
        ];
        // Ascending, volumes summed per price level.
        let sell = depth_levels(sells.into_iter(), true);
        assert_eq!(sell.len(), 2);
        assert_eq!(sell[0].price, 10.0);
        assert_eq!(sell[0].volume, 8);
        assert_eq!(sell[1].price, 12.0);
        // Buy side descending (highest bid first).
        let buys = [order(8.0, true, 4), order(9.0, true, 6)];
        let buy = depth_levels(buys.into_iter(), false);
        assert_eq!(buy[0].price, 9.0);
        assert_eq!(buy[1].price, 8.0);
    }
}
