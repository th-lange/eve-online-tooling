//! Extism guest for the capability-broker tests. It imports the broker's
//! `storage:own` host functions and exposes two exports that use them, so the
//! host can prove: a granted plugin can round-trip storage, an un-granted one
//! fails to even instantiate (the host fn is absent), and one plugin can't see
//! another's namespaced data.
#![no_main]

use extism_pdk::*;

#[host_fn("extism:host/user")]
extern "ExtismHost" {
    fn storage_get(key: String) -> String;
    fn storage_set(key: String, value: String);
}

/// Store `input` under a fixed key in this plugin's own storage.
#[plugin_fn]
pub unsafe fn kv_set(input: String) -> FnResult<String> {
    storage_set("shared".to_string(), input)?;
    Ok("ok".to_string())
}

/// Read back this plugin's stored value (empty string if unset).
#[plugin_fn]
pub unsafe fn kv_get(_input: String) -> FnResult<String> {
    Ok(storage_get("shared".to_string())?)
}
