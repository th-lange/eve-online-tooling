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
    // Quantity per (type, owner) for the active selection: a single character
    // (personal hangar + their corp's hangar) when one is picked, or every
    // roster member (each corp fetched once, so alts in the same corp don't
    // double-count) when "all characters" is active. Cached per selection.
    let sel = storage::active_character(&dir).unwrap_or(0);
    let cache_key = format!("assets_stock_{sel}");
    let stock: HashMap<i64, HashMap<String, (bool, i64)>> =
        match storage::cache_get(&dir, &cache_key) {
            Some(s) => s,
            None => {
                let names = storage::character_names(&dir);
                let mut s: HashMap<i64, HashMap<String, (bool, i64)>> = HashMap::new();
                let mut seen_corps: HashSet<i64> = HashSet::new();
                for cid in storage::target_characters(&dir) {
                    let cname = names
                        .get(&cid)
                        .cloned()
                        .unwrap_or_else(|| format!("Character #{cid}"));
                    if let Ok(assets) = fetch_assets(&auth_state, cid).await {
                        for a in assets {
                            let entry = s
                                .entry(a.type_id)
                                .or_default()
                                .entry(cname.clone())
                                .or_insert((false, 0));
                            entry.1 += a.quantity;
                        }
                    }
                    let Ok(corp_id) = corporation_id(&auth_state, cid).await else {
                        continue;
                    };
                    if !seen_corps.insert(corp_id) {
                        continue;
                    }
                    let Ok(corp_assets) = fetch_corp_assets(&auth_state, cid, corp_id).await
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
                let _ = storage::cache_put(&dir, &cache_key, &s, 600);
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

/// A flattened asset for nesting (ids only — pure layer), tagged with the
/// owner (character or corp name) it came from.
#[derive(Debug, Clone)]
struct FlatAsset {
    item_id: i64,
    location_id: i64,
    type_id: i64,
    quantity: i64,
    owner: String,
    is_corp: bool,
}

/// Bare nesting node (ids only) before names/values are attached.
#[derive(Debug, PartialEq)]
struct TreeNode {
    /// Root nodes carry a location id; leaf/container nodes carry an item id.
    id: i64,
    type_id: Option<i64>,
    quantity: i64,
    is_location: bool,
    /// The owning character or corporation (set on every non-location node).
    owner: Option<String>,
    is_corp: bool,
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
                owner: Some(a.owner.clone()),
                is_corp: a.is_corp,
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
            owner: None,
            is_corp: false,
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
    /// Owning character or corp (set on item nodes; used for the per-item
    /// owner badge and owner search — the tree is not grouped by owner).
    pub owner: Option<String>,
    pub is_corp: bool,
    /// Classifiers for item nodes, so the tree is searchable by them.
    pub category: Option<String>,
    pub group: Option<String>,
    pub meta_group: Option<String>,
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

    // Gather assets for the active selection (a single character, or the whole
    // roster when "all characters" is active), item-level for nesting, each
    // tagged with its owner: the character's personal hangar plus that
    // character's corp hangar (each corp fetched once — same 403-tolerant path
    // as assets_value).
    let names = storage::character_names(&dir);
    let mut assets: Vec<FlatAsset> = Vec::new();
    let mut seen_corps: HashSet<i64> = HashSet::new();
    for cid in storage::target_characters(&dir) {
        let cname = names
            .get(&cid)
            .cloned()
            .unwrap_or_else(|| format!("Character #{cid}"));
        if let Ok(rows) = fetch_assets(&auth_state, cid).await {
            for a in rows {
                assets.push(FlatAsset {
                    item_id: a.item_id,
                    location_id: a.location_id,
                    type_id: a.type_id,
                    quantity: a.quantity,
                    owner: cname.clone(),
                    is_corp: false,
                });
            }
        }
        let Ok(corp_id) = corporation_id(&auth_state, cid).await else {
            continue;
        };
        if !seen_corps.insert(corp_id) {
            continue;
        }
        let Ok(corp_rows) = fetch_corp_assets(&auth_state, cid, corp_id).await else {
            continue;
        };
        if corp_rows.is_empty() {
            continue;
        }
        let corp_name = resolve_names(&auth_state, &[corp_id])
            .await
            .get(&corp_id)
            .cloned()
            .unwrap_or_else(|| format!("Corporation #{corp_id}"));
        for a in corp_rows {
            assets.push(FlatAsset {
                item_id: a.item_id,
                location_id: a.location_id,
                type_id: a.type_id,
                quantity: a.quantity,
                owner: corp_name.clone(),
                is_corp: true,
            });
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
    let cls = Classifiers {
        categories: sde.category_names().map_err(|e| e.to_string())?,
        groups: sde.group_names().map_err(|e| e.to_string())?,
        metas: sde.meta_group_names().map_err(|e| e.to_string())?,
    };

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
    let (roots, sell_total, volume_total) =
        value_nodes(bare, &best_simple, &name_vol, &loc_name, &cls);
    Ok(AssetsTreeResult {
        roots,
        sell_total,
        volume_total,
    })
}

/// SDE classifiers used to make item nodes searchable (category / group /
/// meta group), keyed by type id.
struct Classifiers {
    categories: HashMap<i64, String>,
    groups: HashMap<i64, String>,
    metas: HashMap<i64, String>,
}

/// Recursively name + value bare nodes, rolling value/volume up to each parent.
/// Returns the valued nodes plus the total value/volume across them.
fn value_nodes(
    nodes: Vec<TreeNode>,
    best: &HashMap<i64, (String, f64)>,
    name_vol: &HashMap<i64, (String, f64)>,
    loc_name: &dyn Fn(i64) -> String,
    cls: &Classifiers,
) -> (Vec<AssetNode>, f64, f64) {
    let mut out = Vec::with_capacity(nodes.len());
    let (mut total_value, mut total_volume) = (0.0, 0.0);
    for n in nodes {
        let (children, child_value, child_volume) =
            value_nodes(n.children, best, name_vol, loc_name, cls);
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
        let tid = n.type_id.unwrap_or(0);
        out.push(AssetNode {
            id: n.id,
            name,
            type_id: n.type_id,
            quantity: n.quantity,
            sell_value: value,
            volume,
            best_hub,
            is_location: n.is_location,
            owner: n.owner.clone(),
            is_corp: n.is_corp,
            category: cls.categories.get(&tid).cloned(),
            group: cls.groups.get(&tid).cloned(),
            meta_group: cls.metas.get(&tid).cloned(),
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
        // Station 60000 holds Alice's ship (item 1); the ship holds a module
        // (item 2). A second stack (item 3) — Bob's — sits in the station.
        let assets = vec![
            FlatAsset {
                item_id: 1,
                location_id: 60000,
                type_id: 600,
                quantity: 1,
                owner: "Alice".into(),
                is_corp: false,
            },
            FlatAsset {
                item_id: 2,
                location_id: 1,
                type_id: 700,
                quantity: 5,
                owner: "Alice".into(),
                is_corp: false,
            },
            FlatAsset {
                item_id: 3,
                location_id: 60000,
                type_id: 34,
                quantity: 1000,
                owner: "Bob".into(),
                is_corp: false,
            },
        ];
        let roots = build_asset_tree(&assets);
        assert_eq!(roots.len(), 1);
        let station = &roots[0];
        assert_eq!(station.id, 60000);
        assert!(station.is_location);
        // Items nest directly under the location (no owner grouping); each
        // top-level item carries its owner tag for the per-item badge.
        assert_eq!(station.children.len(), 2); // ship + mineral stack
        let ship = station.children.iter().find(|n| n.id == 1).unwrap();
        assert_eq!(ship.owner.as_deref(), Some("Alice"));
        assert_eq!(ship.children.len(), 1); // the module inside
        assert_eq!(ship.children[0].id, 2);
        let stack = station.children.iter().find(|n| n.id == 3).unwrap();
        assert_eq!(stack.owner.as_deref(), Some("Bob"));
    }
}
