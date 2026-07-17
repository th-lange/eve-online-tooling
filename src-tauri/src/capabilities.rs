//! The capability registry — one definition per read/compute operation, shared
//! by every surface that exposes them: **scripts**, **plugins**, and the **MCP
//! bridge**. Each capability is a name + the permission a plugin must hold + a
//! JSON-in/JSON-out handler that reuses the shared services (so data is fetched
//! and cached once, in `market` / `sde` / `esi`).
//!
//! Handlers take a lightweight [`HostCtx`] (app data dir + a market service +
//! an auth state) rather than an `AppHandle`, so the surfaces that run off the
//! main thread (the MCP server, the plugin sandbox) can build one from what
//! they already hold. Trust differs by surface, enforced by the *caller*:
//! scripts and the MCP bridge are trusted (call [`invoke`] directly); the
//! plugin broker checks [`Capability::permission`] against the plugin's grants
//! first.

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use serde_json::{json, Value};

use crate::esi::{self, AuthState};
use crate::market::{default_region_id, resolve_location, MarketService};
use crate::plugins::manifest::Permission;
use crate::sde::{Sde, SdePaths};
use crate::storage;

const QUERY_MAX_LEN: usize = 200;
const SEARCH_LIMIT_MAX: i64 = 50;
const APPRAISE_MAX_ITEMS: usize = 500;

/// What a capability handler is allowed to touch. Borrows so any surface can
/// build one from its own (managed or transient) service handles.
pub struct HostCtx<'a> {
    pub app_data_dir: &'a Path,
    pub market: &'a MarketService,
    pub auth: &'a AuthState,
}

/// One argument a capability accepts (drives the MCP input schema + docs).
pub struct Param {
    pub name: &'static str,
    pub ty: &'static str,
    pub required: bool,
}

/// One registered operation.
pub struct Capability {
    pub name: &'static str,
    /// Permission a plugin must be granted to call this (scripts/MCP are trusted).
    pub permission: Permission,
    /// Whether the MCP bridge advertises it (auth-gated reads stay off the
    /// public bridge).
    pub mcp: bool,
    pub description: &'static str,
    pub params: &'static [Param],
    pub run: fn(&HostCtx, &Value) -> Result<Value, String>,
}

/// The full registry.
pub fn registry() -> &'static [Capability] {
    REGISTRY
}

/// Find a capability by name.
pub fn find(name: &str) -> Option<&'static Capability> {
    REGISTRY.iter().find(|c| c.name == name)
}

/// Run a capability by name (no permission check — the caller gates).
pub fn invoke(ctx: &HostCtx, name: &str, args: &Value) -> Result<Value, String> {
    let cap = find(name).ok_or_else(|| format!("unknown capability {name:?}"))?;
    (cap.run)(ctx, args)
}

/// A JSON-Schema object for a capability's arguments (for MCP `inputSchema`).
pub fn input_schema(cap: &Capability) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    for p in cap.params {
        properties.insert(p.name.to_string(), json!({ "type": p.ty }));
        if p.required {
            required.push(Value::String(p.name.to_string()));
        }
    }
    json!({ "type": "object", "properties": properties, "required": required })
}

static REGISTRY: &[Capability] = &[
    Capability {
        name: "market_price",
        permission: Permission::MarketRead,
        mcp: true,
        description: "Market price vectors (sell/buy percentile, adjusted, average) for a type, at a region (default The Forge / Jita).",
        params: &[
            Param { name: "typeId", ty: "integer", required: true },
            Param { name: "regionId", ty: "integer", required: false },
        ],
        run: cap_market_price,
    },
    Capability {
        name: "sde_type_info",
        permission: Permission::SdeRead,
        mcp: true,
        description: "Look up an item type by id: name, group, and packaged volume.",
        params: &[Param { name: "typeId", ty: "integer", required: true }],
        run: cap_sde_type_info,
    },
    Capability {
        name: "sde_search",
        permission: Permission::SdeRead,
        mcp: true,
        description: "Search EVE item types by name. Returns matching type ids + names.",
        params: &[
            Param { name: "query", ty: "string", required: true },
            Param { name: "limit", ty: "integer", required: false },
        ],
        run: cap_sde_search,
    },
    Capability {
        name: "appraise",
        permission: Permission::MarketRead,
        mcp: true,
        description: "Value a list of items at market: total buy/sell ISK and cargo volume.",
        params: &[
            Param { name: "items", ty: "array", required: true },
            Param { name: "regionId", ty: "integer", required: false },
        ],
        run: cap_appraise,
    },
    Capability {
        name: "route",
        permission: Permission::SdeRead,
        mcp: true,
        description: "Shortest stargate route between two solar systems (by name). Returns the jump count.",
        params: &[
            Param { name: "from", ty: "string", required: true },
            Param { name: "to", ty: "string", required: true },
        ],
        run: cap_route,
    },
    Capability {
        name: "assets",
        permission: Permission::AssetsRead,
        mcp: false,
        description: "The active character's personal assets.",
        params: &[],
        run: cap_assets,
    },
    Capability {
        name: "corp_assets",
        permission: Permission::AssetsRead,
        mcp: false,
        description: "The active character's corporation assets.",
        params: &[],
        run: cap_corp_assets,
    },
    Capability {
        name: "my_orders",
        permission: Permission::OrdersRead,
        mcp: false,
        description: "The active character's open market orders, flagged for undercut.",
        params: &[],
        run: cap_my_orders,
    },
];

// --- handlers ---------------------------------------------------------------

fn open_sde(dir: &Path) -> Result<Sde, String> {
    Sde::open(&SdePaths::new(dir.to_path_buf()).db).map_err(|e| e.to_string())
}

fn req_i64(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("{key:?} (integer) is required"))
}

fn cap_market_price(ctx: &HostCtx, args: &Value) -> Result<Value, String> {
    let type_id = req_i64(args, "typeId")?;
    let region = args
        .get("regionId")
        .and_then(Value::as_i64)
        .unwrap_or_else(default_region_id);
    let location = resolve_location(region, None);
    let model = tauri::async_runtime::block_on(ctx.market.price_model(location, type_id))
        .map_err(|e| e.to_string())?;
    serde_json::to_value(model).map_err(|e| e.to_string())
}

fn cap_sde_type_info(ctx: &HostCtx, args: &Value) -> Result<Value, String> {
    let type_id = req_i64(args, "typeId")?;
    let sde = open_sde(ctx.app_data_dir)?;
    let info = sde.type_info(type_id).map_err(|e| e.to_string())?;
    serde_json::to_value(info).map_err(|e| e.to_string())
}

fn cap_sde_search(ctx: &HostCtx, args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or("\"query\" (string) is required")?;
    if query.trim().is_empty() || query.len() > QUERY_MAX_LEN {
        return Err("query must be 1..=200 chars".to_string());
    }
    let limit = args
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(SEARCH_LIMIT_MAX)
        .clamp(1, SEARCH_LIMIT_MAX);
    let sde = open_sde(ctx.app_data_dir)?;
    let hits = sde.search_types(query, limit).map_err(|e| e.to_string())?;
    let results: Vec<Value> = hits
        .into_iter()
        .map(|(type_id, name)| json!({ "typeId": type_id, "name": name }))
        .collect();
    Ok(json!({ "results": results }))
}

fn cap_appraise(ctx: &HostCtx, args: &Value) -> Result<Value, String> {
    let items = args
        .get("items")
        .and_then(Value::as_array)
        .ok_or("appraise requires an \"items\" array")?;
    if items.is_empty() || items.len() > APPRAISE_MAX_ITEMS {
        return Err("items must be 1..=500 entries".to_string());
    }
    let region_id = args
        .get("regionId")
        .and_then(Value::as_i64)
        .unwrap_or_else(default_region_id);
    let sde = open_sde(ctx.app_data_dir)?;

    struct Line {
        name: String,
        quantity: i64,
        type_id: Option<i64>,
        volume_each: f64,
    }
    let mut lines = Vec::with_capacity(items.len());
    for it in items {
        let name = it
            .get("name")
            .and_then(Value::as_str)
            .ok_or("each item needs a string \"name\"")?;
        let quantity = it
            .get("quantity")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(0);
        let lookup = sde.type_by_name(name.trim()).map_err(|e| e.to_string())?;
        lines.push(Line {
            name: name.to_string(),
            quantity,
            type_id: lookup.map(|(id, _)| id),
            volume_each: lookup.and_then(|(_, v)| v).unwrap_or(0.0),
        });
    }

    let ids: Vec<i64> = lines.iter().filter_map(|l| l.type_id).collect();
    let location = resolve_location(region_id, None);
    let prices = tauri::async_runtime::block_on(ctx.market.price_map_at(location, &ids))
        .map_err(|e| e.to_string())?;

    let (mut buy_total, mut sell_total, mut volume_total) = (0.0, 0.0, 0.0);
    let out_lines: Vec<Value> = lines
        .iter()
        .map(|l| {
            let model = l.type_id.and_then(|id| prices.get(id));
            let buy = model.and_then(|m| m.buy_percentile);
            let sell = model.and_then(|m| m.sell_percentile);
            let q = l.quantity as f64;
            buy_total += buy.unwrap_or(0.0) * q;
            sell_total += sell.unwrap_or(0.0) * q;
            volume_total += l.volume_each * q;
            json!({
                "name": l.name, "quantity": l.quantity, "typeId": l.type_id,
                "buyPrice": buy, "sellPrice": sell,
            })
        })
        .collect();

    Ok(json!({
        "buyTotal": buy_total, "sellTotal": sell_total, "volume": volume_total,
        "lines": out_lines,
    }))
}

fn cap_route(ctx: &HostCtx, args: &Value) -> Result<Value, String> {
    let from_name = args
        .get("from")
        .and_then(Value::as_str)
        .ok_or("route requires a \"from\" system name")?;
    let to_name = args
        .get("to")
        .and_then(Value::as_str)
        .ok_or("route requires a \"to\" system name")?;
    let sde = open_sde(ctx.app_data_dir)?;
    let from = resolve_system(&sde, from_name)?;
    let to = resolve_system(&sde, to_name)?;
    let edges = sde.all_stargate_edges().map_err(|e| e.to_string())?;
    let jumps = shortest_path(&edges, from.0, to.0);
    Ok(json!({
        "from": from.1, "to": to.1,
        "jumps": jumps, "reachable": jumps.is_some(),
    }))
}

fn cap_assets(ctx: &HostCtx, _args: &Value) -> Result<Value, String> {
    let character_id =
        storage::primary_character(ctx.app_data_dir).ok_or("no character logged in")?;
    let assets = tauri::async_runtime::block_on(esi::fetch_assets(ctx.auth, character_id))
        .map_err(|e| e.to_string())?;
    serde_json::to_value(assets).map_err(|e| e.to_string())
}

fn cap_corp_assets(ctx: &HostCtx, _args: &Value) -> Result<Value, String> {
    let character_id =
        storage::primary_character(ctx.app_data_dir).ok_or("no character logged in")?;
    let corporation_id =
        tauri::async_runtime::block_on(esi::corporation_id(ctx.auth, character_id))
            .map_err(|e| e.to_string())?;
    let assets = tauri::async_runtime::block_on(esi::fetch_corp_assets(
        ctx.auth,
        character_id,
        corporation_id,
    ))
    .map_err(|e| e.to_string())?;
    serde_json::to_value(assets).map_err(|e| e.to_string())
}

fn cap_my_orders(ctx: &HostCtx, _args: &Value) -> Result<Value, String> {
    let rows = tauri::async_runtime::block_on(crate::market::orders::collect_orders(
        ctx.app_data_dir,
        ctx.auth,
        ctx.market,
    ))
    .map_err(|e| e.to_string())?;
    serde_json::to_value(rows).map_err(|e| e.to_string())
}

/// Resolve a solar-system name to `(id, canonical name)`, requiring an exact
/// (case-insensitive) match so an ambiguous prefix never routes the wrong way.
fn resolve_system(sde: &Sde, name: &str) -> Result<(i64, String), String> {
    let hits = sde
        .search_systems(name.trim(), 25)
        .map_err(|e| e.to_string())?;
    hits.into_iter()
        .find(|(_, n)| n.eq_ignore_ascii_case(name.trim()))
        .ok_or_else(|| format!("unknown system: {name:?}"))
}

/// BFS shortest path (jump count) over an undirected stargate edge list.
/// `None` when unreachable. Pure — unit-tested.
fn shortest_path(edges: &[(i64, i64)], from: i64, to: i64) -> Option<i64> {
    if from == to {
        return Some(0);
    }
    let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();
    for &(a, b) in edges {
        adj.entry(a).or_default().push(b);
        adj.entry(b).or_default().push(a);
    }
    let mut dist: HashMap<i64, i64> = HashMap::from([(from, 0)]);
    let mut queue = VecDeque::from([from]);
    while let Some(system) = queue.pop_front() {
        let d = dist[&system];
        for &next in adj.get(&system).into_iter().flatten() {
            if dist.contains_key(&next) {
                continue;
            }
            if next == to {
                return Some(d + 1);
            }
            dist.insert(next, d + 1);
            queue.push_back(next);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_names_are_unique() {
        let mut names: Vec<&str> = REGISTRY.iter().map(|c| c.name).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count, "duplicate capability name");
    }

    #[test]
    fn unknown_capability_is_an_error() {
        assert!(find("nope").is_none());
    }

    #[test]
    fn permissions_and_mcp_exposure_are_declared() {
        // The plugin gate keys off these — pin the security-relevant mapping.
        assert_eq!(
            find("market_price").unwrap().permission,
            Permission::MarketRead
        );
        assert_eq!(
            find("my_orders").unwrap().permission,
            Permission::OrdersRead
        );
        assert_eq!(find("assets").unwrap().permission, Permission::AssetsRead);
        assert_eq!(
            find("corp_assets").unwrap().permission,
            Permission::AssetsRead
        );
        // Auth-gated reads stay off the public MCP bridge; public data is on it.
        assert!(!find("my_orders").unwrap().mcp);
        assert!(!find("assets").unwrap().mcp);
        assert!(find("market_price").unwrap().mcp);
        assert!(find("sde_search").unwrap().mcp);
    }

    #[test]
    fn input_schema_lists_required_params() {
        let cap = find("market_price").unwrap();
        let schema = input_schema(cap);
        assert_eq!(schema["properties"]["typeId"]["type"], "integer");
        assert_eq!(schema["required"], json!(["typeId"]));
    }

    #[test]
    fn shortest_path_bfs() {
        // 1-2-3-4 chain plus a 2-4 shortcut.
        let edges = [(1, 2), (2, 3), (3, 4), (2, 4)];
        assert_eq!(shortest_path(&edges, 1, 1), Some(0));
        assert_eq!(shortest_path(&edges, 1, 4), Some(2)); // 1-2-4
        assert_eq!(shortest_path(&edges, 1, 99), None);
    }
}
