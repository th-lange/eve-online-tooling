//! Assets module — value the roster's holdings at a market (and where each
//! stack is worth the most).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{corporation_id, fetch_assets, fetch_corp_assets, resolve_names, AuthState};
use crate::market::{default_region_id, resolve_location, MarketService, PriceModel};
use crate::sde::{Sde, SdePaths};
use crate::storage;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsParams {
    #[serde(default = "default_region_id")]
    pub region_id: i64,
    #[serde(default)]
    pub station_id: Option<i64>,
    /// Value each stack at the best-paying hub instead of the chosen market.
    #[serde(default)]
    pub best_hub: bool,
}

/// One owned item type for one owner (a character, or a corporation hangar),
/// aggregated and valued.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRow {
    pub type_id: i64,
    pub name: String,
    pub quantity: i64,
    pub sell_price: Option<f64>,
    pub buy_price: Option<f64>,
    pub sell_value: f64,
    pub buy_value: f64,
    pub sell_hub: Option<String>,
    pub volume: f64,
    pub category: Option<String>,
    pub group: Option<String>,
    /// Character name, or the corporation name for corp-hangar stock.
    pub owner: String,
    pub is_corp: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsResult {
    pub rows: Vec<AssetRow>,
    pub sell_total: f64,
    pub buy_total: f64,
    pub volume_total: f64,
}

/// Aggregate the roster's personal assets by type, value each at the chosen
/// market (or best hub), and total the net worth + cargo volume.
#[tauri::command]
pub async fn assets_value(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
    params: AssetsParams,
) -> Result<AssetsResult, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
    // Quantity per (type, owner) across the roster — personal hangars plus,
    // for each distinct corp represented in the roster, that corp's hangar
    // (fetched once per corp, not once per character in it, so multiple
    // roster alts in the same corp don't double-count its assets). Reuses the
    // durable roster-stock cache.
    let stock: HashMap<i64, HashMap<String, (bool, i64)>> =
        match storage::cache_get(&dir, "roster_stock_v2") {
            Some(s) => s,
            None => {
                let mut s: HashMap<i64, HashMap<String, (bool, i64)>> = HashMap::new();
                let mut seen_corps: HashSet<i64> = HashSet::new();
                for c in storage::load_roster(&dir) {
                    if let Ok(assets) = fetch_assets(&auth_state, c.character_id).await {
                        for a in assets {
                            let entry = s
                                .entry(a.type_id)
                                .or_default()
                                .entry(c.name.clone())
                                .or_insert((false, 0));
                            entry.1 += a.quantity;
                        }
                    }
                    let Ok(corp_id) = corporation_id(&auth_state, c.character_id).await else {
                        continue;
                    };
                    if !seen_corps.insert(corp_id) {
                        continue;
                    }
                    let Ok(corp_assets) =
                        fetch_corp_assets(&auth_state, c.character_id, corp_id).await
                    else {
                        continue;
                    };
                    if corp_assets.is_empty() {
                        continue;
                    }
                    let corp_name = resolve_names(&auth_state, &[corp_id])
                        .await
                        .get(&corp_id)
                        .cloned()
                        .unwrap_or_else(|| format!("Corporation #{corp_id}"));
                    for a in corp_assets {
                        let entry = s
                            .entry(a.type_id)
                            .or_default()
                            .entry(corp_name.clone())
                            .or_insert((true, 0));
                        entry.1 += a.quantity;
                    }
                }
                let _ = storage::cache_put(&dir, "roster_stock_v2", &s, 600);
                s
            }
        };
    if stock.is_empty() {
        return Ok(AssetsResult {
            rows: Vec::new(),
            sell_total: 0.0,
            buy_total: 0.0,
            volume_total: 0.0,
        });
    }

    let ids: Vec<i64> = stock.keys().copied().collect();
    let location = resolve_location(params.region_id, params.station_id);
    let prices: HashMap<i64, PriceModel> = market
        .price_models_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();
    let best = if params.best_hub {
        market
            .best_sell_hubs(&ids)
            .await
            .map_err(|e| e.to_string())?
    } else {
        HashMap::new()
    };
    let names = sde.market_items().map_err(|e| e.to_string())?;
    let name_vol: HashMap<i64, (String, f64)> = names
        .into_iter()
        .map(|m| (m.type_id, (m.name, m.volume.unwrap_or(0.0))))
        .collect();
    let categories = sde.category_names().map_err(|e| e.to_string())?;
    let groups = sde.group_names().map_err(|e| e.to_string())?;

    let (mut sell_total, mut buy_total, mut volume_total) = (0.0, 0.0, 0.0);
    let mut rows: Vec<AssetRow> = Vec::new();
    for (type_id, owners) in stock.into_iter() {
        let model = prices.get(&type_id);
        let buy_price = model.and_then(|m| m.buy_percentile);
        let (sell_price, sell_hub) = match best.get(&type_id) {
            Some(b) => (Some(b.price), Some(b.hub.clone())),
            None => (model.and_then(|m| m.sell_percentile), None),
        };
        let (name, vol_each) = name_vol
            .get(&type_id)
            .cloned()
            .unwrap_or_else(|| (format!("Type {type_id}"), 0.0));
        let category = categories.get(&type_id).cloned();
        let group = groups.get(&type_id).cloned();
        for (owner, (is_corp, quantity)) in owners {
            let q = quantity as f64;
            let sell_value = sell_price.unwrap_or(0.0) * q;
            let buy_value = buy_price.unwrap_or(0.0) * q;
            let volume = vol_each * q;
            sell_total += sell_value;
            buy_total += buy_value;
            volume_total += volume;
            rows.push(AssetRow {
                type_id,
                name: name.clone(),
                quantity,
                sell_price,
                buy_price,
                sell_value,
                buy_value,
                sell_hub: sell_hub.clone(),
                volume,
                category: category.clone(),
                group: group.clone(),
                owner,
                is_corp,
            });
        }
    }
    rows.sort_by(|a, b| {
        b.sell_value
            .partial_cmp(&a.sell_value)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(AssetsResult {
        rows,
        sell_total,
        buy_total,
        volume_total,
    })
}

// --- Location tree (#93) ---

/// Player structures (citadels etc.) use ids at/above this; they're not in the
/// SDE, so their names fall back to a generic label.
const STRUCTURE_ID_MIN: i64 = 1_000_000_000_000;

/// A flattened asset for nesting (ids only — pure layer).
#[derive(Debug, Clone)]
struct FlatAsset {
    item_id: i64,
    location_id: i64,
    type_id: i64,
    quantity: i64,
}

/// Bare nesting node (ids only) before names/values are attached.
#[derive(Debug, PartialEq)]
struct TreeNode {
    /// Root nodes carry a location id; leaf/container nodes carry an item id.
    id: i64,
    type_id: Option<i64>,
    quantity: i64,
    is_location: bool,
    children: Vec<TreeNode>,
}

/// Re-nest ESI's flat asset list into a forest: roots are the locations
/// (stations/structures) that aren't themselves assets; an asset whose
/// `location_id` is another asset's `item_id` nests under it. Pure (testable).
fn build_asset_tree(assets: &[FlatAsset]) -> Vec<TreeNode> {
    let item_ids: HashSet<i64> = assets.iter().map(|a| a.item_id).collect();
    let mut children_of: HashMap<i64, Vec<&FlatAsset>> = HashMap::new();
    for a in assets {
        children_of.entry(a.location_id).or_default().push(a);
    }
    // Root locations: location_ids that aren't an asset item id (and 0 = unknown).
    let mut roots: Vec<i64> = children_of
        .keys()
        .copied()
        .filter(|loc| *loc != 0 && !item_ids.contains(loc))
        .collect();
    roots.sort();

    fn build(parent: i64, children_of: &HashMap<i64, Vec<&FlatAsset>>) -> Vec<TreeNode> {
        let mut nodes: Vec<TreeNode> = children_of
            .get(&parent)
            .into_iter()
            .flatten()
            .map(|a| TreeNode {
                id: a.item_id,
                type_id: Some(a.type_id),
                quantity: a.quantity,
                is_location: false,
                children: if a.item_id != 0 {
                    build(a.item_id, children_of)
                } else {
                    Vec::new()
                },
            })
            .collect();
        nodes.sort_by_key(|a| a.id);
        nodes
    }

    roots
        .into_iter()
        .map(|loc| TreeNode {
            id: loc,
            type_id: None,
            quantity: 0,
            is_location: true,
            children: build(loc, &children_of),
        })
        .collect()
}

/// A valued, named node of the asset location tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetNode {
    pub id: i64,
    pub name: String,
    pub type_id: Option<i64>,
    pub quantity: i64,
    /// Rolled-up sell value of this node and everything under it.
    pub sell_value: f64,
    /// Rolled-up packaged volume.
    pub volume: f64,
    /// Best hub for a leaf stack (when "best hub" pricing is on), else null.
    pub best_hub: Option<String>,
    pub is_location: bool,
    pub children: Vec<AssetNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsTreeResult {
    pub roots: Vec<AssetNode>,
    pub sell_total: f64,
    pub volume_total: f64,
}

/// The roster's assets as a nested location tree (item → container → ship →
/// station/structure), each stack valued at the best-paying hub and rolled up.
#[tauri::command]
pub async fn assets_tree(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
) -> Result<AssetsTreeResult, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;

    // Gather every roster asset (item-level, for nesting).
    let mut assets: Vec<FlatAsset> = Vec::new();
    for c in storage::load_roster(&dir) {
        if let Ok(rows) = fetch_assets(&auth_state, c.character_id).await {
            for a in rows {
                assets.push(FlatAsset {
                    item_id: a.item_id,
                    location_id: a.location_id,
                    type_id: a.type_id,
                    quantity: a.quantity,
                });
            }
        }
    }
    if assets.is_empty() {
        return Ok(AssetsTreeResult {
            roots: Vec::new(),
            sell_total: 0.0,
            volume_total: 0.0,
        });
    }

    // Price every type at its best hub; names + packaged volume from the SDE.
    let type_ids: Vec<i64> = assets
        .iter()
        .map(|a| a.type_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let best = market
        .best_sell_hubs(&type_ids)
        .await
        .map_err(|e| e.to_string())?;
    let name_vol: HashMap<i64, (String, f64)> = sde
        .market_items()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, (m.name, m.volume.unwrap_or(0.0))))
        .collect();

    // Resolve root location names: NPC stations from SDE, systems from SDE,
    // structures by id fallback.
    let root_ids: Vec<i64> = {
        let item_ids: HashSet<i64> = assets.iter().map(|a| a.item_id).collect();
        assets
            .iter()
            .map(|a| a.location_id)
            .filter(|l| *l != 0 && !item_ids.contains(l))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect()
    };
    let stations = sde.station_names(&root_ids).map_err(|e| e.to_string())?;
    let systems = sde.system_names().map_err(|e| e.to_string())?;
    let loc_name = |id: i64| -> String {
        stations
            .get(&id)
            .or_else(|| systems.get(&id))
            .cloned()
            .unwrap_or_else(|| {
                if id >= STRUCTURE_ID_MIN {
                    format!("Structure {id}")
                } else {
                    format!("Location {id}")
                }
            })
    };

    // Flatten best-hub to (hub name, price) so the valuation layer needn't name
    // the market's internal type.
    let best_simple: HashMap<i64, (String, f64)> = best
        .into_iter()
        .map(|(id, b)| (id, (b.hub, b.price)))
        .collect();

    let bare = build_asset_tree(&assets);
    let (roots, sell_total, volume_total) = value_nodes(bare, &best_simple, &name_vol, &loc_name);
    Ok(AssetsTreeResult {
        roots,
        sell_total,
        volume_total,
    })
}

/// Recursively name + value bare nodes, rolling value/volume up to each parent.
/// Returns the valued nodes plus the total value/volume across them.
fn value_nodes(
    nodes: Vec<TreeNode>,
    best: &HashMap<i64, (String, f64)>,
    name_vol: &HashMap<i64, (String, f64)>,
    loc_name: &dyn Fn(i64) -> String,
) -> (Vec<AssetNode>, f64, f64) {
    let mut out = Vec::with_capacity(nodes.len());
    let (mut total_value, mut total_volume) = (0.0, 0.0);
    for n in nodes {
        let (children, child_value, child_volume) =
            value_nodes(n.children, best, name_vol, loc_name);
        let (name, mut value, mut volume, best_hub) = if n.is_location {
            (loc_name(n.id), 0.0, 0.0, None)
        } else {
            let tid = n.type_id.unwrap_or(0);
            let (nm, vol_each) = name_vol
                .get(&tid)
                .cloned()
                .unwrap_or_else(|| (format!("Type {tid}"), 0.0));
            let b = best.get(&tid);
            let unit = b.map(|(_, p)| *p).unwrap_or(0.0);
            (
                nm,
                unit * n.quantity as f64,
                vol_each * n.quantity as f64,
                b.map(|(hub, _)| hub.clone()),
            )
        };
        value += child_value;
        volume += child_volume;
        total_value += value;
        total_volume += volume;
        out.push(AssetNode {
            id: n.id,
            name,
            type_id: n.type_id,
            quantity: n.quantity,
            sell_value: value,
            volume,
            best_hub,
            is_location: n.is_location,
            children,
        });
    }
    // Heaviest value first within each level.
    out.sort_by(|a, b| {
        b.sell_value
            .partial_cmp(&a.sell_value)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    (out, total_value, total_volume)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nests_items_under_containers_under_stations() {
        // Station 60000 holds a ship (item 1); the ship holds a module (item 2).
        // A second stack (item 3) sits directly in the station.
        let assets = vec![
            FlatAsset {
                item_id: 1,
                location_id: 60000,
                type_id: 600,
                quantity: 1,
            },
            FlatAsset {
                item_id: 2,
                location_id: 1,
                type_id: 700,
                quantity: 5,
            },
            FlatAsset {
                item_id: 3,
                location_id: 60000,
                type_id: 34,
                quantity: 1000,
            },
        ];
        let roots = build_asset_tree(&assets);
        assert_eq!(roots.len(), 1);
        let station = &roots[0];
        assert_eq!(station.id, 60000);
        assert!(station.is_location);
        assert_eq!(station.children.len(), 2); // ship + mineral stack
        let ship = station.children.iter().find(|n| n.id == 1).unwrap();
        assert_eq!(ship.children.len(), 1); // the module inside
        assert_eq!(ship.children[0].id, 2);
    }
}
