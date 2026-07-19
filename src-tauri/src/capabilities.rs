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

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::esi::{self, AuthState};
use crate::market::{default_region_id, resolve_location, MarketService};
use crate::modules::appraisal;
use crate::modules::fitting::{self, Fit, FitStats};
use crate::modules::industry;
use crate::modules::pi;
use crate::modules::production;
use crate::modules::reprocessing;
use crate::plugins::manifest::Permission;
use crate::sde::{graph, open_from_dir, Sde};
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
    /// Whether the MCP bridge advertises it under the **dev tier** (compute
    /// engines: production profit, fitting stats, …) — a separate, higher-risk
    /// opt-in gated by a persisted toggle on top of `mcp`. Never set alongside
    /// an auth-gated `permission` (pinned by `mcp_never_reaches_auth_gated_data`).
    pub mcp_dev: bool,
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
        mcp_dev: false,
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
        mcp_dev: false,
        description: "Look up an item type by id: name, group, and packaged volume.",
        params: &[Param { name: "typeId", ty: "integer", required: true }],
        run: cap_sde_type_info,
    },
    Capability {
        name: "sde_search",
        permission: Permission::SdeRead,
        mcp: true,
        mcp_dev: false,
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
        mcp_dev: false,
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
        mcp_dev: false,
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
        mcp_dev: false,
        description: "The active character's personal assets.",
        params: &[],
        run: cap_assets,
    },
    Capability {
        name: "corp_assets",
        permission: Permission::AssetsRead,
        mcp: false,
        mcp_dev: false,
        description: "The active character's corporation assets.",
        params: &[],
        run: cap_corp_assets,
    },
    Capability {
        name: "my_orders",
        permission: Permission::OrdersRead,
        mcp: false,
        mcp_dev: false,
        description: "The active character's open market orders, flagged for undercut.",
        params: &[],
        run: cap_my_orders,
    },
    Capability {
        name: "pi_overview",
        permission: Permission::PiRead,
        mcp: false,
        mcp_dev: false,
        description: "Planetary Interaction colonies (extractor timers, storage, commodity balance) for every target character — the whole roster when \"All characters\" is the app's active selection, otherwise just the active one.",
        params: &[],
        run: cap_pi_overview,
    },
    Capability {
        name: "industry_jobs",
        permission: Permission::IndustryRead,
        mcp: false,
        mcp_dev: false,
        description: "Running + recently-delivered industry jobs and job-slot usage (manufacturing/science/reactions) for every target character — the whole roster when \"All characters\" is the app's active selection, otherwise just the active one.",
        params: &[],
        run: cap_industry_jobs,
    },
    Capability {
        name: "pi_idle_colonies",
        permission: Permission::PiRead,
        mcp: false,
        mcp_dev: false,
        description: "PI colonies flagged \"needs attention\" (an extraction program ended, or a commodity is in deficit), trimmed to character/system/planet only — a small summary of pi_overview for \"who's idle\" checks, not the full colony detail (extractors, storage, balance, produced items).",
        params: &[],
        run: cap_pi_idle_colonies,
    },
    Capability {
        name: "industry_line_status",
        permission: Permission::IndustryRead,
        mcp: false,
        mcp_dev: false,
        description: "Per-character idle/busy status for manufacturing, invention, and reactions — a small summary of industry_jobs for \"who's idle\" checks, not the full job list and slot totals.",
        params: &[],
        run: cap_industry_line_status,
    },
    Capability {
        name: "production_profit",
        permission: Permission::MarketRead,
        mcp: false,
        mcp_dev: true,
        description: "Build-vs-buy manufacturing profit for one blueprint: required material quantities (ME-adjusted), material cost, job fee, revenue and profit. Pure/deterministic given SDE facts + market prices — no owned-blueprint or character data.",
        params: &[
            Param { name: "blueprintTypeId", ty: "integer", required: true },
            Param { name: "runs", ty: "integer", required: false },
            Param { name: "me", ty: "integer", required: false },
            Param { name: "regionId", ty: "integer", required: false },
            Param { name: "systemCostIndex", ty: "number", required: false },
            Param { name: "facilityTax", ty: "number", required: false },
        ],
        run: cap_production_profit,
    },
    Capability {
        name: "fitting_stats",
        permission: Permission::SdeRead,
        mcp: false,
        mcp_dev: true,
        description: "Dogma stats (resources, validation, DPS, tank, capacitor) for a fit given as an EFT clipboard string. Skills are all-V; pure SDE/dogma computation, no character or ESI data.",
        params: &[Param { name: "eft", ty: "string", required: true }],
        run: cap_fitting_stats,
    },
    Capability {
        name: "reprocessing_yield",
        permission: Permission::MarketRead,
        mcp: false,
        mcp_dev: true,
        description: "Reprocess-vs-sell value for one item: per-unit refine output value at a given efficiency, vs its own sell price. Pure given SDE facts + market prices.",
        params: &[
            Param { name: "typeId", ty: "integer", required: true },
            Param { name: "regionId", ty: "integer", required: false },
            Param { name: "reprocessing", ty: "integer", required: false },
            Param { name: "reprocessingEfficiency", ty: "integer", required: false },
            Param { name: "oreProcessing", ty: "integer", required: false },
            Param { name: "implantPct", ty: "number", required: false },
            Param { name: "rigBonusPct", ty: "number", required: false },
            Param { name: "structureMult", ty: "number", required: false },
            Param { name: "securityMult", ty: "number", required: false },
        ],
        run: cap_reprocessing_yield,
    },
];

// --- handlers ---------------------------------------------------------------

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
    let sde = open_from_dir(ctx.app_data_dir)?;
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
    let sde = open_from_dir(ctx.app_data_dir)?;
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
    let sde = open_from_dir(ctx.app_data_dir)?;

    // Parse the JSON items, then delegate resolution + pricing + valuation to
    // the appraisal module's pure core (same functions `appraisal_run` uses),
    // so the rules — trim before lookup, qty clamped to >= 0, missing price
    // counts as 0 — live in exactly one place. Only the JSON shape is adapted
    // here; the capability has no best-hub path (empty best map).
    let mut parsed = Vec::with_capacity(items.len());
    for it in items {
        let name = it
            .get("name")
            .and_then(Value::as_str)
            .ok_or("each item needs a string \"name\"")?;
        let quantity = it.get("quantity").and_then(Value::as_i64).unwrap_or(1);
        parsed.push(appraisal::AppraisalItem {
            name: name.to_string(),
            quantity,
        });
    }
    let resolved = appraisal::resolve_items(&sde, &parsed)?;

    let ids: Vec<i64> = resolved.iter().filter_map(|r| r.type_id).collect();
    let location = resolve_location(region_id, None);
    let prices = tauri::async_runtime::block_on(ctx.market.price_map_at(location, &ids))
        .map_err(|e| e.to_string())?;

    let result = appraisal::appraise(appraisal::price_items(resolved, &prices, &HashMap::new()));

    let out_lines: Vec<Value> = result
        .lines
        .iter()
        .map(|l| {
            json!({
                "name": l.name, "quantity": l.quantity, "typeId": l.type_id,
                "buyPrice": l.buy_price, "sellPrice": l.sell_price,
            })
        })
        .collect();

    Ok(json!({
        "buyTotal": result.buy_total, "sellTotal": result.sell_total,
        "volume": result.volume_total,
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
    let sde = open_from_dir(ctx.app_data_dir)?;
    let from = resolve_system(&sde, from_name)?;
    let to = resolve_system(&sde, to_name)?;
    let adj = sde.stargate_adjacency().map_err(|e| e.to_string())?;
    let jumps = shortest_path(&adj, from.0, to.0);
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

/// Colonies overview (extractor timers, storage, commodity balance) for
/// every target character. Touches `ctx.auth` (per-character ESI) — never
/// exposed on the MCP bridge.
fn cap_pi_overview(ctx: &HostCtx, _args: &Value) -> Result<Value, String> {
    let sde = open_from_dir(ctx.app_data_dir)?;
    let views = tauri::async_runtime::block_on(pi::commands::pi_overview_core(
        ctx.app_data_dir,
        sde,
        ctx.auth,
    ))
    .map_err(|e| e.to_string())?;
    serde_json::to_value(views).map_err(|e| e.to_string())
}

/// Running + recently-delivered industry jobs and job-slot usage for every
/// target character (`None` defaults to the app's active selection — the
/// whole roster when "All characters" is active). Touches `ctx.auth` — never
/// exposed on the MCP bridge.
fn cap_industry_jobs(ctx: &HostCtx, _args: &Value) -> Result<Value, String> {
    let result = tauri::async_runtime::block_on(industry::commands::industry_jobs_core(
        ctx.app_data_dir,
        ctx.auth,
        None,
    ))
    .map_err(|e| e.to_string())?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

/// PI colonies flagged "needs attention", trimmed to just enough to name
/// them — a small summary, not the full colony detail `pi_overview` ships.
fn cap_pi_idle_colonies(ctx: &HostCtx, _args: &Value) -> Result<Value, String> {
    let sde = open_from_dir(ctx.app_data_dir)?;
    let views = tauri::async_runtime::block_on(pi::commands::pi_overview_core(
        ctx.app_data_dir,
        sde,
        ctx.auth,
    ))
    .map_err(|e| e.to_string())?;
    serde_json::to_value(pi::commands::idle_colonies(&views)).map_err(|e| e.to_string())
}

/// Per-character idle/busy status for manufacturing/invention/reactions — a
/// small summary, not the full job list and slot totals `industry_jobs`
/// ships.
fn cap_industry_line_status(ctx: &HostCtx, _args: &Value) -> Result<Value, String> {
    let result = tauri::async_runtime::block_on(industry::commands::industry_jobs_core(
        ctx.app_data_dir,
        ctx.auth,
        None,
    ))
    .map_err(|e| e.to_string())?;
    serde_json::to_value(industry::commands::line_status(&result)).map_err(|e| e.to_string())
}

/// Dev-tier: build-vs-buy manufacturing profit for one blueprint (flat —
/// materials priced at market, no recursive sub-build resolution; that keeps
/// the result reproducible from the SDE + a price vector alone, per
/// CLAUDE.md's "Profit / EIV" formulas). Touches only SDE + market, never
/// `ctx.auth` — pinned by `mcp_never_reaches_auth_gated_data`.
fn cap_production_profit(ctx: &HostCtx, args: &Value) -> Result<Value, String> {
    let blueprint_type_id = req_i64(args, "blueprintTypeId")?;
    let runs = args.get("runs").and_then(Value::as_i64).unwrap_or(1).max(1);
    let me = args.get("me").and_then(Value::as_i64).unwrap_or(0).max(0);
    let region_id = args
        .get("regionId")
        .and_then(Value::as_i64)
        .unwrap_or_else(default_region_id);
    let system_cost_index = args
        .get("systemCostIndex")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let facility_tax = args
        .get("facilityTax")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let sde = open_from_dir(ctx.app_data_dir)?;
    let product = sde
        .blueprint_product(blueprint_type_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("blueprint {blueprint_type_id} has no manufacturing product"))?;
    let materials = sde
        .blueprint_materials(blueprint_type_id)
        .map_err(|e| e.to_string())?;
    let step = production::manufacturing_step(blueprint_type_id, &product, &materials);

    let mut ids: Vec<i64> = materials.iter().map(|m| m.material_type_id).collect();
    ids.push(product.product_type_id);
    let location = resolve_location(region_id, None);
    let prices = tauri::async_runtime::block_on(ctx.market.price_map_at(location, &ids))
        .map_err(|e| e.to_string())?;

    let config = production::ProfitConfig {
        system_cost_index,
        facility_tax,
        ..Default::default()
    };
    let breakdown = production::evaluate(&step, runs, me, prices.as_map(), &config);
    serde_json::to_value(breakdown).map_err(|e| e.to_string())
}

/// Dev-tier: dogma stats (resources, validation, DPS, tank, capacitor) for a
/// fit given as EFT text, at all-V skills. Touches only SDE — no ESI, no
/// `ctx.auth` — so the result is deterministic from the SDE alone.
fn cap_fitting_stats(ctx: &HostCtx, args: &Value) -> Result<Value, String> {
    let eft_text = args
        .get("eft")
        .and_then(Value::as_str)
        .ok_or("\"eft\" (string) is required")?;
    let sde = open_from_dir(ctx.app_data_dir)?;
    let fit: Fit = fitting::commands::import_eft_to_fit(&sde, eft_text)?;
    let stats: FitStats = fitting::simulate_fit(&sde, &fit, &|_skill_id| 5.0)?;
    serde_json::to_value(stats).map_err(|e| e.to_string())
}

/// Dev-tier: reprocess-vs-sell value for one item at a given refine
/// efficiency. Touches only SDE + market, never `ctx.auth`.
fn cap_reprocessing_yield(ctx: &HostCtx, args: &Value) -> Result<Value, String> {
    let type_id = req_i64(args, "typeId")?;
    let region_id = args
        .get("regionId")
        .and_then(Value::as_i64)
        .unwrap_or_else(default_region_id);
    let f64_arg =
        |key: &str, default: f64| args.get(key).and_then(Value::as_f64).unwrap_or(default);
    let i64_arg = |key: &str| args.get(key).and_then(Value::as_i64).unwrap_or(0);

    let sde = open_from_dir(ctx.app_data_dir)?;
    let recipe = sde
        .reprocess_recipe(type_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("type {type_id} has no reprocessing recipe"))?;

    let mut ids: Vec<i64> = recipe.outputs.iter().map(|o| o.material_type_id).collect();
    ids.push(type_id);
    let location = resolve_location(region_id, None);
    let prices = tauri::async_runtime::block_on(ctx.market.price_map_at(location, &ids))
        .map_err(|e| e.to_string())?;
    let sell = |tid: i64| prices.sell(tid);

    let efficiency = reprocessing::ore_efficiency(&reprocessing::EfficiencyConfig {
        reprocessing: i64_arg("reprocessing"),
        reprocessing_efficiency: i64_arg("reprocessingEfficiency"),
        ore_processing: i64_arg("oreProcessing"),
        implant_pct: f64_arg("implantPct", 0.0),
        rig_bonus_pct: f64_arg("rigBonusPct", 0.0),
        structure_mult: f64_arg("structureMult", 1.0),
        security_mult: f64_arg("securityMult", 1.0),
    });

    let row = reprocessing::evaluate(&recipe, efficiency, sell(type_id), sell, false)
        .ok_or("recipe has no portion size")?;
    serde_json::to_value(row).map_err(|e| e.to_string())
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

/// BFS shortest path (jump count) over an undirected stargate adjacency map.
/// `None` when unreachable.
fn shortest_path(adj: &HashMap<i64, Vec<i64>>, from: i64, to: i64) -> Option<i64> {
    graph::bfs(adj, from, None).0.get(&to).copied()
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
        assert_eq!(find("pi_overview").unwrap().permission, Permission::PiRead);
        assert_eq!(
            find("industry_jobs").unwrap().permission,
            Permission::IndustryRead
        );
        assert_eq!(
            find("pi_idle_colonies").unwrap().permission,
            Permission::PiRead
        );
        assert_eq!(
            find("industry_line_status").unwrap().permission,
            Permission::IndustryRead
        );
        // Auth-gated reads stay off the public MCP bridge; public data is on it.
        assert!(!find("my_orders").unwrap().mcp);
        assert!(!find("assets").unwrap().mcp);
        assert!(!find("pi_overview").unwrap().mcp);
        assert!(!find("industry_jobs").unwrap().mcp);
        assert!(!find("pi_idle_colonies").unwrap().mcp);
        assert!(!find("industry_line_status").unwrap().mcp);
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
    fn dev_tier_capabilities_are_declared() {
        // The two the issue requires, at minimum, exposed only via the dev
        // tier (never the public `mcp` tier), touching only market/SDE.
        for name in ["production_profit", "fitting_stats", "reprocessing_yield"] {
            let cap = find(name).unwrap_or_else(|| panic!("missing capability {name:?}"));
            assert!(cap.mcp_dev, "{name} should be dev-tier");
            assert!(!cap.mcp, "{name} must not be on the public MCP tier");
        }
    }

    /// The MCP bridge (public `mcp` or dev-tier `mcp_dev`) must never reach a
    /// capability gated on personal/auth data (`assets`, `corp_assets`,
    /// `my_orders` all use `AssetsRead`/`OrdersRead`). This is structural: a
    /// capability's `run` fn is handed a `HostCtx` that *does* carry `auth`
    /// (scripts/plugins need it), so the invariant lives here, not in
    /// `HostCtx`'s shape — flip `mcp_dev`/`mcp` on an auth-gated capability
    /// and this test fails.
    #[test]
    fn mcp_never_reaches_auth_gated_data() {
        let auth_gated = |p: Permission| {
            matches!(
                p,
                Permission::AssetsRead
                    | Permission::OrdersRead
                    | Permission::PiRead
                    | Permission::IndustryRead
            )
        };
        for cap in registry() {
            if cap.mcp || cap.mcp_dev {
                assert!(
                    !auth_gated(cap.permission),
                    "{:?} is MCP-reachable (mcp={}, mcp_dev={}) but gated on {:?}",
                    cap.name,
                    cap.mcp,
                    cap.mcp_dev,
                    cap.permission
                );
            }
        }
    }

    /// Golden-fact regression pin for `docs/testing-mcp.md`'s production-profit
    /// section: the Rifter blueprint's ME-adjusted required material
    /// quantities, straight from `required_quantity`'s documented formula
    /// (`max(runs, ceil(base_qty * runs * (1 - ME/100)))`) — price-independent,
    /// so no market/network involved. Gated on a real SDE (skipped otherwise,
    /// same convention as `fitting::commands::tests`).
    #[test]
    fn golden_production_profit_required_quantities() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            eprintln!(
                "golden_production_profit_required_quantities: EVE_SDE_PATH unset — skipping"
            );
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        // Rifter blueprint (691), base (ME 0) materials per run — pinned in
        // docs/testing-mcp.md against the live SDE at doc-writing time.
        let materials = sde
            .blueprint_materials(691)
            .map_err(|e| e.to_string())
            .unwrap();
        let base: HashMap<i64, i64> = materials
            .iter()
            .map(|m| (m.material_type_id, m.quantity))
            .collect();
        assert_eq!(base.get(&34), Some(&32_000)); // Tritanium
        assert_eq!(base.get(&35), Some(&6_000)); // Pyerite
        assert_eq!(base.get(&36), Some(&2_500)); // Mexallon
        assert_eq!(base.get(&37), Some(&500)); // Isogen

        // ME 10, 1 run: ceil(base * 0.9).
        assert_eq!(production::required_quantity(32_000, 1, 10, 1.0), 28_800);
        assert_eq!(production::required_quantity(6_000, 1, 10, 1.0), 5_400);
        assert_eq!(production::required_quantity(2_500, 1, 10, 1.0), 2_250);
        assert_eq!(production::required_quantity(500, 1, 10, 1.0), 450);
    }

    /// Golden-fact regression pin for `docs/testing-mcp.md`'s fitting-stats
    /// section: an empty Rifter's slot layout and CPU/PG output are the raw
    /// hull attributes (no modules to trigger skill/rig modifiers). Gated on a
    /// real SDE.
    #[test]
    fn golden_fitting_stats_rifter_layout() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            eprintln!("golden_fitting_stats_rifter_layout: EVE_SDE_PATH unset — skipping");
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        let fit = fitting::commands::import_eft_to_fit(&sde, "[Rifter, Golden Test]").unwrap();
        let stats = fitting::simulate_fit(&sde, &fit, &|_| 5.0).unwrap();
        let layout = stats.layout.expect("dogma engine should resolve a layout");
        assert_eq!(layout.high_slots, 3);
        assert_eq!(layout.mid_slots, 3);
        assert_eq!(layout.low_slots, 4);
        assert_eq!(layout.cpu_output, 130.0);
        assert_eq!(layout.powergrid_output, 41.0);
    }
}
