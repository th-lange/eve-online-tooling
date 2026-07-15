//! Reference logic plugin: a tiny "cargo efficiency" model.
//!
//! Given an item type id, it reads the item's name + packaged volume from the
//! host's SDE (via the `sde:read` capability), derives a deterministic score
//! (higher for denser-value, smaller items), and keeps a call counter in its
//! own isolated storage (`storage:own`). It never touches the filesystem,
//! network, or any character/ESI data — it can't: the host only hands it the
//! two host functions its manifest was granted.
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

/// What the plugin returns to the host (consumed by a page).
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
