//! Reference logic plugin: a tiny "cargo efficiency" model.
//!
//! Given an item type id it reads the item's name + packaged volume from the
//! host's SDE (`sde:read`) and derives a volume-only density score
//! `round(1000 / volume)`, keeping a call counter in its own isolated storage
//! (`storage:own`). A separate `price` export adds a price-aware ISK-per-m³
//! figure via `market:read` — kept separate so the base score still works
//! without the market grant. It never touches the filesystem, network, or
//! character/ESI data directly — only the host functions it was granted.
//!
//! This is the Rust reference; a plugin may be written in any Extism-supported
//! language (Go, TypeScript, AssemblyScript, Zig, C).
#![no_main]

use extism_pdk::*;
use serde::{Deserialize, Serialize};

// Host functions the broker exposes, gated by this plugin's granted
// permissions. The namespace must be "extism:host/user".
#[host_fn("extism:host/user")]
extern "ExtismHost" {
    fn sde_type_info(type_id: String) -> String;
    fn storage_get(key: String) -> String;
    fn storage_set(key: String, value: String);
    fn host_call(name: String, args_json: String) -> String;
}

/// The subset of the host's SDE `TypeInfo` we care about (camelCase on the wire).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeInfo {
    name: String,
    volume: Option<f64>,
}

/// What `evaluate` returns to the host (consumed by a page).
#[derive(Serialize, ToBytes)]
#[encoding(Json)]
struct Evaluation {
    name: String,
    volume: f64,
    /// Deterministic cargo-efficiency score: `round(1000 / volume)`.
    score: i64,
    /// How many times this plugin has been evaluated (from its own storage).
    evaluations: u64,
}

#[plugin_fn]
pub unsafe fn evaluate(type_id: String) -> FnResult<Evaluation> {
    let info_json = sde_type_info(type_id)?;
    let info: Option<TypeInfo> = serde_json::from_str(&info_json)?;
    let info = info.ok_or_else(|| Error::msg("unknown type id"))?;

    let volume = info.volume.unwrap_or(0.0);
    let score = if volume > 0.0 {
        (1000.0 / volume).round() as i64
    } else {
        0
    };

    // Count evaluations in this plugin's own namespaced storage.
    let prev = storage_get("evaluations".to_string())?;
    let evaluations = prev.parse::<u64>().unwrap_or(0) + 1;
    storage_set("evaluations".to_string(), evaluations.to_string())?;

    Ok(Evaluation {
        name: info.name,
        volume,
        score,
        evaluations,
    })
}

/// Arguments for [`search`].
#[derive(Deserialize)]
struct SearchArgs {
    query: String,
}

/// Search item types by name via the host capability registry (needs the
/// `sde:read` capability, reached through the generic `host_call` gateway).
/// Returns `{ "results": [ { "typeId", "name" }, … ] }`, which the UI uses to
/// turn a typed name into a type id.
#[plugin_fn]
pub unsafe fn search(Json(args): Json<SearchArgs>) -> FnResult<Json<serde_json::Value>> {
    let call_args = serde_json::json!({ "query": args.query, "limit": 20 }).to_string();
    let out = host_call("sde_search".to_string(), call_args)?;
    let value: serde_json::Value = serde_json::from_str(&out)?;
    Ok(Json(value))
}

/// The subset of the host's market `PriceModel` we use: Jita sell-min.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Price {
    sell_min: Option<f64>,
}

/// Price-aware cargo efficiency for a type: its Jita sell price and the ISK of
/// value packed into each m³ (`price / volume`). Needs `market:read` (reached
/// through `host_call`) — a missing grant or absent market data surfaces as a
/// call error, so the UI layers this on top of `evaluate` as optional.
#[plugin_fn]
pub unsafe fn price(type_id: String) -> FnResult<Json<serde_json::Value>> {
    let id: i64 = type_id
        .trim()
        .parse()
        .map_err(|_| Error::msg("type id must be an integer"))?;

    // Packaged volume from the SDE, to turn a price into ISK/m³.
    let info_json = sde_type_info(type_id)?;
    let info: Option<TypeInfo> = serde_json::from_str(&info_json)?;
    let volume = info.and_then(|i| i.volume).unwrap_or(0.0);

    // Jita sell-min via the market_price capability (needs market:read).
    let args = serde_json::json!({ "typeId": id }).to_string();
    let out = host_call("market_price".to_string(), args)?;
    let model: Price = serde_json::from_str(&out)?;

    let isk_per_m3 = match model.sell_min {
        Some(p) if volume > 0.0 => Some((p / volume * 100.0).round() / 100.0),
        _ => None,
    };
    Ok(Json(serde_json::json!({
        "price": model.sell_min,
        "iskPerM3": isk_per_m3,
    })))
}
