//! Assets module — load the roster's holdings once and derive both the flat
//! aggregated view and the nested location tree from the same data.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{
    corporation_id, fetch_assets, fetch_corp_assets, resolve_names, AuthState, RawAsset,
};
use crate::market::{default_region_id, resolve_location, MarketService, PriceModel};
use crate::storage;

/// Jita IV-4 in The Forge — the reference market all valuation prices against.
const JITA_STATION_ID: i64 = 60003760;

/// Player structures (citadels etc.) use ids at/above this.
const STRUCTURE_ID_MIN: i64 = 1_000_000_000_000;

/// Valuation basis for one type: the location-local weighted average when the
/// bulk path supplied one, else ESI's global average, else the Jita sell price
/// (realistic percentile, then order-book min) (#776).
fn basis_price(m: &PriceModel) -> Option<f64> {
    m.weighted_average
        .or(m.average_price)
        .or(m.sell_percentile)
        .or(m.sell_min)
}

/// One raw asset row plus the owner it belongs to.
struct RosterAssetRow {
    asset: RawAsset,
    owner: String,
    is_corp: bool,
}

/// Walk the active selection's roster, gathering each character's personal
/// assets plus their corp hangar — each corp fetched once, so alts in the same
/// corp don't double up. A character's or corp's asset fetch failing skips just
/// that owner; the rest of the roster is unaffected.
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

// --- Shared cache entry (item-level, not aggregated) ---

/// One raw ESI item with its owner, cached between command calls so a single
/// ESI fetch drives both the flat and tree representations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedRawAsset {
    item_id: i64,
    /// Direct parent id — another item_id when inside a container, else a
    /// station/structure id. Needed to re-nest the tree on every render.
    location_id: i64,
    type_id: i64,
    quantity: i64,
    owner: String,
    is_corp: bool,
}

// --- Flat view ---

/// One owned item type at one location, aggregated and valued.
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
    /// NPC station name or "Structure {id}" for player structures.
    pub station: String,
    /// Solar system the station sits in, if resolvable from SDE.
    pub solar_system: Option<String>,
}

// --- Tree view ---

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
    /// Owning character or corp (set on item nodes).
    pub owner: Option<String>,
    pub is_corp: bool,
    /// Classifiers for item nodes, for tree search.
    pub category: Option<String>,
    pub group: Option<String>,
    pub meta_group: Option<String>,
    pub children: Vec<AssetNode>,
}

// --- Combined payload ---

/// Both views derived from one ESI load: flat rows (aggregated by
/// type × owner × station) and the nested location tree.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsPayload {
    pub rows: Vec<AssetRow>,
    pub roots: Vec<AssetNode>,
    pub sell_total: f64,
    pub buy_total: f64,
    pub volume_total: f64,
}

// --- Tree internals (unchanged from original) ---

/// A flattened asset for nesting (ids only).
#[derive(Debug, Clone)]
struct FlatAsset {
    item_id: i64,
    location_id: i64,
    type_id: i64,
    quantity: i64,
    owner: String,
    is_corp: bool,
}

/// Bare nesting node before names/values are attached.
#[derive(Debug, PartialEq)]
struct TreeNode {
    id: i64,
    type_id: Option<i64>,
    quantity: i64,
    is_location: bool,
    owner: Option<String>,
    is_corp: bool,
    children: Vec<TreeNode>,
}

/// Re-nest ESI's flat asset list into a forest.
fn build_asset_tree(assets: &[FlatAsset]) -> Vec<TreeNode> {
    let item_ids: HashSet<i64> = assets.iter().map(|a| a.item_id).collect();
    let mut children_of: HashMap<i64, Vec<&FlatAsset>> = HashMap::new();
    for a in assets {
        children_of.entry(a.location_id).or_default().push(a);
    }
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

/// Recursively name + value bare nodes, rolling value/volume up to each parent.
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
    out.sort_by(|a, b| {
        b.sell_value
            .partial_cmp(&a.sell_value)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    (out, total_value, total_volume)
}

// --- Single unified command ---

/// Load the roster's assets once — ESI fetch (or cache hit), price at Jita,
/// then derive both the flat aggregated rows and the nested location tree.
/// Switching between views is a pure UI toggle; no second network call.
#[tauri::command]
pub async fn assets_load(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
) -> Result<AssetsPayload, String> {
    let dir = storage::app_data_dir(&app)?;
    let sel = storage::active_character(&dir).unwrap_or(0);
    let cache_key = format!("assets_raw_v1_{sel}");

    // Item-level cache — from this we derive both the flat rows (aggregate by
    // type × owner × root location) and the tree (re-nest by location_id chain).
    let raw: Vec<CachedRawAsset> = match storage::cache_get(&dir, &cache_key) {
        Some(r) => r,
        None => {
            let roster = gather_roster_assets(&auth_state, &dir).await;
            let r: Vec<CachedRawAsset> = roster
                .into_iter()
                .map(|row| CachedRawAsset {
                    item_id: row.asset.item_id,
                    location_id: row.asset.location_id,
                    type_id: row.asset.type_id,
                    quantity: row.asset.quantity,
                    owner: row.owner,
                    is_corp: row.is_corp,
                })
                .collect();
            let _ = storage::cache_put(&dir, &cache_key, &r, 600);
            r
        }
    };

    if raw.is_empty() {
        return Ok(AssetsPayload {
            rows: Vec::new(),
            roots: Vec::new(),
            sell_total: 0.0,
            buy_total: 0.0,
            volume_total: 0.0,
        });
    }

    // ── Root-location resolution (needed for flat aggregation) ──────────────
    // Walk item_id → location_id chains until we reach a station/structure.
    let item_to_loc: HashMap<i64, i64> = raw
        .iter()
        .map(|r| (r.item_id, r.location_id))
        .collect();
    let item_ids: HashSet<i64> = item_to_loc.keys().copied().collect();
    let root_of = |start: i64| -> i64 {
        let mut loc = start;
        for _ in 0..20 {
            if !item_ids.contains(&loc) {
                break;
            }
            match item_to_loc.get(&loc) {
                Some(&parent) => loc = parent,
                None => break,
            }
        }
        loc
    };

    // ── Prices ──────────────────────────────────────────────────────────────
    let type_ids: Vec<i64> = raw
        .iter()
        .map(|r| r.type_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let location = resolve_location(default_region_id(), Some(JITA_STATION_ID));
    let price_map = market
        .price_map_at(location, &type_ids)
        .await
        .map_err(|e| e.to_string())?;

    // Basis prices as f64 for the tree rollup.
    let basis: HashMap<i64, f64> = type_ids
        .iter()
        .filter_map(|&tid| price_map.get(tid).and_then(basis_price).map(|p| (tid, p)))
        .collect();

    // ── SDE ─────────────────────────────────────────────────────────────────
    let item_meta = crate::sde::cached_item_meta(&dir)?;
    let system_names = crate::sde::cached_system_names(&dir)?;
    let sde = crate::sde::open_from_dir(&dir)?;
    let root_ids: Vec<i64> = raw
        .iter()
        .map(|r| root_of(r.location_id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let station_infos = sde.station_infos(&root_ids).map_err(|e| e.to_string())?;

    // Two closures that share the same station_infos / system_names refs:
    // one for the flat view (needs solar system too), one for the tree (name only).
    let loc_info = |id: i64| -> (String, Option<String>) {
        if let Some((name, sys_id)) = station_infos.get(&id) {
            (name.clone(), system_names.get(sys_id).cloned())
        } else if id >= STRUCTURE_ID_MIN {
            (format!("Structure {id}"), None)
        } else {
            (format!("Location {id}"), None)
        }
    };
    let loc_name = |id: i64| -> String { loc_info(id).0 };

    // ── Flat view: aggregate by (type_id, owner, root_location) ────────────
    let mut agg: HashMap<(i64, String, i64), (bool, i64)> = HashMap::new();
    for r in &raw {
        let root = root_of(r.location_id);
        agg.entry((r.type_id, r.owner.clone(), root))
            .or_insert((r.is_corp, 0))
            .1 += r.quantity;
    }

    let mut rows: Vec<AssetRow> = Vec::with_capacity(agg.len());
    let (mut sell_total, mut buy_total, mut volume_total) = (0.0, 0.0, 0.0);

    for ((type_id, owner, root_loc), (is_corp, quantity)) in agg {
        let model = price_map.get(type_id);
        let buy_price = model.and_then(|m| m.buy_percentile);
        let sell_price = model.and_then(basis_price);
        let (name, vol_each, category, group) = item_meta
            .get(&type_id)
            .map(|m| {
                (
                    m.name.clone(),
                    m.volume,
                    m.category.clone(),
                    m.group.clone(),
                )
            })
            .unwrap_or_else(|| (format!("Type {type_id}"), 0.0, None, None));
        let q = quantity as f64;
        let sell_value = sell_price.unwrap_or(0.0) * q;
        let buy_value = buy_price.unwrap_or(0.0) * q;
        let volume = vol_each * q;
        sell_total += sell_value;
        buy_total += buy_value;
        volume_total += volume;
        let (station, solar_system) = loc_info(root_loc);
        rows.push(AssetRow {
            type_id,
            name,
            quantity,
            sell_price,
            buy_price,
            sell_value,
            buy_value,
            volume,
            category,
            group,
            owner,
            is_corp,
            station,
            solar_system,
        });
    }
    rows.sort_by(|a, b| {
        b.sell_value
            .partial_cmp(&a.sell_value)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // ── Tree view: re-nest by location_id chain ──────────────────────────────
    let flat_assets: Vec<FlatAsset> = raw
        .iter()
        .map(|r| FlatAsset {
            item_id: r.item_id,
            location_id: r.location_id,
            type_id: r.type_id,
            quantity: r.quantity,
            owner: r.owner.clone(),
            is_corp: r.is_corp,
        })
        .collect();
    let bare = build_asset_tree(&flat_assets);
    let (roots, _, _) = value_nodes(bare, &basis, &item_meta, &loc_name);

    Ok(AssetsPayload {
        rows,
        roots,
        sell_total,
        buy_total,
        volume_total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nests_items_under_containers_under_stations() {
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
        assert_eq!(station.children.len(), 2);
        let ship = station.children.iter().find(|n| n.id == 1).unwrap();
        assert_eq!(ship.children.len(), 1);
        assert_eq!(ship.children[0].id, 2);
    }
}
