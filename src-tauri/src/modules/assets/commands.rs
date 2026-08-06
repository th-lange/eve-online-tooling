//! Assets module — value the roster's holdings against Jita (ESI's global
//! average price when available, else the Jita order book).

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::esi::{
    corporation_id, fetch_assets, fetch_corp_assets, resolve_names, AuthState, RawAsset,
};
use crate::market::{default_region_id, resolve_location, MarketService, PriceModel};
use crate::storage;

/// Jita IV-4 in The Forge — the reference market all valuation prices against.
const JITA_STATION_ID: i64 = 60003760;

/// Valuation basis for one type: the location-local weighted average when the
/// bulk path supplied one, else ESI's global average, else the Jita sell price
/// (realistic percentile, then order-book min) (#776).
fn basis_price(m: &PriceModel) -> Option<f64> {
    m.weighted_average
        .or(m.average_price)
        .or(m.sell_percentile)
        .or(m.sell_min)
}

/// One raw asset row plus the owner (character or corp name) it belongs to.
struct RosterAssetRow {
    asset: RawAsset,
    owner: String,
    is_corp: bool,
}

/// Walk the active selection's roster (a single character, or every roster
/// member when "all characters" is active), gathering each character's
/// personal assets plus their corp hangar — each corp fetched once, so alts
/// in the same corp don't double up (mirrors [`resolve_names`]'s corp-name
/// resolution). A character's or corp's asset fetch failing (missing
/// scope/role, network) skips just that owner; the rest of the roster is
/// unaffected. Shared by `assets_value` (per-type aggregation) and
/// `assets_tree` (item-level nesting) — same gathering walk, different
/// downstream shape.
async fn gather_roster_assets(
    auth_state: &AuthState,
    dir: &std::path::Path,
) -> Vec<RosterAssetRow> {
    let names = storage::character_names(dir);
    let mut out = Vec::new();
    let mut seen_corps: HashSet<i64> = HashSet::new();
    for cid in storage::target_characters(dir) {
        let cname = names
            .get(&cid)
            .cloned()
            .unwrap_or_else(|| format!("Character #{cid}"));
        if let Ok(assets) = fetch_assets(auth_state, cid).await {
            out.extend(assets.into_iter().map(|asset| RosterAssetRow {
                asset,
                owner: cname.clone(),
                is_corp: false,
            }));
        }
        let Ok(corp_id) = corporation_id(auth_state, cid).await else {
            continue;
        };
        if !seen_corps.insert(corp_id) {
            continue;
        }
        let Ok(corp_assets) = fetch_corp_assets(auth_state, cid, corp_id).await else {
            continue;
        };
        if corp_assets.is_empty() {
            continue;
        }
        let corp_name = resolve_names(auth_state, &[corp_id])
            .await
            .get(&corp_id)
            .cloned()
            .unwrap_or_else(|| format!("Corporation #{corp_id}"));
        out.extend(corp_assets.into_iter().map(|asset| RosterAssetRow {
            asset,
            owner: corp_name.clone(),
            is_corp: true,
        }));
    }
    out
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

/// Aggregate the roster's assets by type, value each against the Jita basis,
/// and total the net worth + cargo volume.
#[tauri::command]
pub async fn assets_value(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
) -> Result<AssetsResult, String> {
    let dir = storage::app_data_dir(&app)?;
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
                let mut s: HashMap<i64, HashMap<String, (bool, i64)>> = HashMap::new();
                for row in gather_roster_assets(&auth_state, &dir).await {
                    let entry = s
                        .entry(row.asset.type_id)
                        .or_default()
                        .entry(row.owner)
                        .or_insert((row.is_corp, 0));
                    entry.1 += row.asset.quantity;
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
    let location = resolve_location(default_region_id(), Some(JITA_STATION_ID));
    let prices = market
        .price_map_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?;
    let item_meta = crate::sde::cached_item_meta(&dir)?;

    let (mut sell_total, mut buy_total, mut volume_total) = (0.0, 0.0, 0.0);
    let mut rows: Vec<AssetRow> = Vec::new();
    for (type_id, owners) in stock.into_iter() {
        let model = prices.get(type_id);
        let buy_price = model.and_then(|m| m.buy_percentile);
        let sell_price = model.and_then(basis_price);
        let (name, vol_each, category, group) = match item_meta.get(&type_id) {
            Some(m) => (
                m.name.clone(),
                m.volume,
                m.category.clone(),
                m.group.clone(),
            ),
            None => (format!("Type {type_id}"), 0.0, None, None),
        };
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
/// station/structure), each stack valued against the Jita basis and rolled up.
#[tauri::command]
pub async fn assets_tree(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
) -> Result<AssetsTreeResult, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;

    // Gather assets for the active selection (a single character, or the
    // whole roster when "all characters" is active), item-level for nesting,
    // each tagged with its owner.
    let assets: Vec<FlatAsset> = gather_roster_assets(&auth_state, &dir)
        .await
        .into_iter()
        .map(|row| FlatAsset {
            item_id: row.asset.item_id,
            location_id: row.asset.location_id,
            type_id: row.asset.type_id,
            quantity: row.asset.quantity,
            owner: row.owner,
            is_corp: row.is_corp,
        })
        .collect();
    if assets.is_empty() {
        return Ok(AssetsTreeResult {
            roots: Vec::new(),
            sell_total: 0.0,
            volume_total: 0.0,
        });
    }

    // Price every type against the Jita basis (ESI average, else Jita sell).
    let type_ids: Vec<i64> = assets
        .iter()
        .map(|a| a.type_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let prices: HashMap<i64, f64> = market
        .price_models_at(
            resolve_location(default_region_id(), Some(JITA_STATION_ID)),
            &type_ids,
        )
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|m| basis_price(&m).map(|p| (m.type_id, p)))
        .collect();
    let item_meta = crate::sde::cached_item_meta(&dir)?;

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
    let systems = crate::sde::cached_system_names(&dir)?;
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

    let bare = build_asset_tree(&assets);
    let (roots, sell_total, volume_total) = value_nodes(bare, &prices, &item_meta, &loc_name);
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
    prices: &HashMap<i64, f64>,
    item_meta: &crate::sde::ItemMetaMap,
    loc_name: &dyn Fn(i64) -> String,
) -> (Vec<AssetNode>, f64, f64) {
    let mut out = Vec::with_capacity(nodes.len());
    let (mut total_value, mut total_volume) = (0.0, 0.0);
    for n in nodes {
        let (children, child_value, child_volume) =
            value_nodes(n.children, prices, item_meta, loc_name);
        let (name, mut value, mut volume) = if n.is_location {
            (loc_name(n.id), 0.0, 0.0)
        } else {
            let tid = n.type_id.unwrap_or(0);
            let (nm, vol_each) = item_meta
                .get(&tid)
                .map(|m| (m.name.clone(), m.volume))
                .unwrap_or_else(|| (format!("Type {tid}"), 0.0));
            let unit = prices.get(&tid).copied().unwrap_or(0.0);
            (nm, unit * n.quantity as f64, vol_each * n.quantity as f64)
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
            is_location: n.is_location,
            owner: n.owner.clone(),
            is_corp: n.is_corp,
            category: item_meta.get(&tid).and_then(|m| m.category.clone()),
            group: item_meta.get(&tid).and_then(|m| m.group.clone()),
            meta_group: item_meta.get(&tid).and_then(|m| m.meta_group.clone()),
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
