//! WASM runtime host: loads plugin `.wasm` via Extism and dispatches calls
//! into it at runtime through one generic `plugin_invoke` command — the way
//! around `tauri::generate_handler!` being fixed at compile time.
//!
//! Each plugin is instantiated with exactly the host functions its granted
//! permissions entitle it to (see [`crate::plugins::broker`]) and nothing
//! else, under a memory cap and a per-call timeout (Extism epoch
//! interruption) so a runaway or memory-hungry plugin is terminated with an
//! error rather than hanging.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use extism::{Function, Manifest as ExtismManifest, Plugin, PluginBuilder, Wasm};
use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Manager as _, State};

use super::broker::{host_functions, BrokerCtx};
use super::manifest::Permission;
use super::PluginRegistry;
use crate::model::AppError;

/// Resource ceilings applied to every plugin instance.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Max linear-memory pages (1 page = 64 KiB). 1024 ≈ 64 MiB.
    pub max_pages: u32,
    /// Per-call wall-clock timeout; a call exceeding it is interrupted.
    pub timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_pages: 1024,
            timeout: Duration::from_secs(5),
        }
    }
}

/// Build a sandboxed Extism plugin from raw wasm bytes under `limits`, exposing
/// only `functions` (the broker-gated host functions this plugin was granted).
fn build_plugin(wasm: &[u8], limits: &Limits, functions: Vec<Function>) -> Result<Plugin, String> {
    let manifest = ExtismManifest::new([Wasm::data(wasm.to_vec())])
        .with_memory_max(limits.max_pages)
        .with_timeout(limits.timeout);
    PluginBuilder::new(manifest)
        .with_wasi(true)
        .with_functions(functions)
        .build()
        .map_err(|e| format!("failed to instantiate plugin: {e}"))
}

/// Runtime cache of instantiated plugins, keyed by plugin id. Lazy: a plugin is
/// built on first invocation and kept warm. Held in Tauri managed state.
#[derive(Default)]
pub struct PluginManager {
    loaded: Mutex<HashMap<String, Plugin>>,
    limits: Limits,
}

impl PluginManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Call `func` on plugin `id`, building it on first use with the host
    /// functions its `granted` permissions allow. Input/output are opaque bytes
    /// (the command layer speaks JSON). A failed call evicts the cached
    /// instance — an interrupted (timed-out) Extism instance can't be reused.
    fn invoke(
        &self,
        app_data_dir: &Path,
        id: &str,
        granted: &HashSet<Permission>,
        wasm_path: &Path,
        func: &str,
        args: &[u8],
    ) -> Result<Vec<u8>, String> {
        let mut loaded = self.loaded.lock();
        if !loaded.contains_key(id) {
            let bytes = std::fs::read(wasm_path)
                .map_err(|e| format!("cannot read plugin wasm {wasm_path:?}: {e}"))?;
            let ctx = Arc::new(BrokerCtx::new(app_data_dir.to_path_buf(), id.to_string()));
            let functions = host_functions(granted, ctx);
            loaded.insert(
                id.to_string(),
                build_plugin(&bytes, &self.limits, functions)?,
            );
        }
        let plugin = loaded.get_mut(id).expect("present: just inserted");
        let result = plugin
            .call::<&[u8], Vec<u8>>(func, args)
            .map_err(|e| e.to_string());
        if result.is_err() {
            loaded.remove(id); // discard a possibly-interrupted instance
        }
        result
    }
}

/// Invoke an exported function of an installed plugin with a JSON argument,
/// returning its JSON result. The single runtime dispatch point for logic
/// plugins. Unknown plugin/function, a plugin without a wasm entry point, a
/// non-JSON result, or a resource-limit termination all surface as `AppError`.
#[tauri::command]
pub fn plugin_invoke(
    app: AppHandle,
    registry: State<'_, PluginRegistry>,
    manager: State<'_, PluginManager>,
    plugin_id: String,
    r#fn: String,
    args: Value,
) -> Result<Value, AppError> {
    let entry = registry
        .entries()
        .iter()
        .find(|e| e.manifest.id == plugin_id)
        .ok_or_else(|| AppError::from(format!("unknown plugin {plugin_id:?}")))?;
    let wasm_rel =
        entry.manifest.wasm.as_deref().ok_or_else(|| {
            AppError::from(format!("plugin {plugin_id:?} has no wasm entry point"))
        })?;
    // The wasm path is author-controlled; keep it inside the plugin's own dir.
    if wasm_rel.contains("..") || Path::new(wasm_rel).is_absolute() {
        return Err(AppError::from(format!(
            "plugin {plugin_id:?} wasm path {wasm_rel:?} must be relative to its dir"
        )));
    }
    let granted: HashSet<Permission> = entry.granted.iter().copied().collect();
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let wasm_path = dir.join("plugins").join(&plugin_id).join(wasm_rel);

    let input = serde_json::to_vec(&args).map_err(|e| e.to_string())?;
    let out = manager.invoke(&dir, &plugin_id, &granted, &wasm_path, &r#fn, &input)?;
    let value = serde_json::from_slice::<Value>(&out)
        .map_err(|e| AppError::from(format!("plugin {plugin_id:?} returned non-JSON: {e}")))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ECHO_WASM: &[u8] = include_bytes!("testdata/echo.wasm");

    fn echo_path() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins/testdata/echo.wasm")
    }
    fn kv_path() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins/testdata/kv.wasm")
    }
    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("eve-mgr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }
    fn example_wasm() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../examples/plugins/pricing-model/pricing_model.wasm")
    }
    /// Write a minimal SDE db at `<dir>/sde/sde.sqlite` with one type (34 =
    /// Tritanium, volume 0.01) so `sde_type_info` has something to read.
    fn write_sde(dir: &Path) {
        let sde_dir = dir.join("sde");
        std::fs::create_dir_all(&sde_dir).unwrap();
        let conn = rusqlite::Connection::open(sde_dir.join("sde.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE invGroups(groupID INT, categoryID INT, groupName TEXT);
             CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL);
             INSERT INTO invGroups VALUES (18, 4, 'Mineral');
             INSERT INTO invTypes VALUES (34, 18, 'Tritanium', 0.01);",
        )
        .unwrap();
    }

    #[test]
    fn echo_round_trips_a_json_payload() {
        let mut plugin = build_plugin(ECHO_WASM, &Limits::default(), Vec::new()).unwrap();
        let out = plugin
            .call::<&[u8], Vec<u8>>("echo", br#"{"hello":"world","n":42}"#)
            .unwrap();
        let value: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(value, serde_json::json!({"hello": "world", "n": 42}));
    }

    #[test]
    fn timeout_terminates_a_runaway_plugin() {
        let limits = Limits {
            max_pages: 1024,
            timeout: Duration::from_millis(200),
        };
        let mut plugin = build_plugin(ECHO_WASM, &limits, Vec::new()).unwrap();
        assert!(plugin.call::<&[u8], Vec<u8>>("spin", b"{}").is_err());
    }

    #[test]
    fn manager_loads_caches_and_dispatches() {
        let manager = PluginManager::new();
        let dir = tmp("dispatch");
        let out = manager
            .invoke(
                &dir,
                "echo",
                &HashSet::new(),
                &echo_path(),
                "echo",
                br#"{"a":1}"#,
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&out).unwrap(),
            serde_json::json!({"a": 1})
        );
        // Second call reuses the cached instance.
        let out2 = manager
            .invoke(
                &dir,
                "echo",
                &HashSet::new(),
                &echo_path(),
                "echo",
                br#"{"a":2}"#,
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&out2).unwrap(),
            serde_json::json!({"a": 2})
        );
    }

    #[test]
    fn granted_plugin_can_use_its_storage() {
        let manager = PluginManager::new();
        let dir = tmp("granted");
        let granted = HashSet::from([Permission::StorageOwn]);
        manager
            .invoke(&dir, "acme", &granted, &kv_path(), "kv_set", br#""hello""#)
            .unwrap();
        let got = manager
            .invoke(&dir, "acme", &granted, &kv_path(), "kv_get", br#""""#)
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&got).unwrap(), "hello");
        // Persisted inside the plugin's own namespaced dir.
        assert!(dir.join("plugins/acme/kv/shared").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ungranted_plugin_fails_to_instantiate() {
        let manager = PluginManager::new();
        let dir = tmp("ungranted");
        // No StorageOwn grant -> storage host fns absent -> unresolved import.
        let err = manager
            .invoke(
                &dir,
                "acme",
                &HashSet::new(),
                &kv_path(),
                "kv_get",
                br#""""#,
            )
            .unwrap_err();
        assert!(!err.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn storage_is_namespaced_per_plugin() {
        let manager = PluginManager::new();
        let dir = tmp("namespace");
        let granted = HashSet::from([Permission::StorageOwn]);
        // Plugin A stores a value.
        manager
            .invoke(&dir, "a", &granted, &kv_path(), "kv_set", br#""from-a""#)
            .unwrap();
        // Plugin B reads its own (empty) storage — cannot see A's.
        let b = manager
            .invoke(&dir, "b", &granted, &kv_path(), "kv_get", br#""""#)
            .unwrap();
        assert!(b.is_empty(), "plugin B must not see plugin A's data");
        // A still sees its own value.
        let a = manager
            .invoke(&dir, "a", &granted, &kv_path(), "kv_get", br#""""#)
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&a).unwrap(), "from-a");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn example_plugin_reads_sde_and_counts_in_storage() {
        let manager = PluginManager::new();
        let dir = tmp("example");
        write_sde(&dir);
        let granted = HashSet::from([Permission::SdeRead, Permission::StorageOwn]);
        // Type id sent as a bare JSON number (what plugin_invoke serializes).
        let out = manager
            .invoke(
                &dir,
                "pricing-model",
                &granted,
                &example_wasm(),
                "evaluate",
                b"34",
            )
            .unwrap();
        let v: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["name"], "Tritanium");
        assert_eq!(v["score"].as_i64(), Some(100_000)); // round(1000 / 0.01)
        assert_eq!(v["evaluations"].as_u64(), Some(1));
        // Storage counter survives across calls.
        let out2 = manager
            .invoke(
                &dir,
                "pricing-model",
                &granted,
                &example_wasm(),
                "evaluate",
                b"34",
            )
            .unwrap();
        let v2: Value = serde_json::from_slice(&out2).unwrap();
        assert_eq!(v2["evaluations"].as_u64(), Some(2));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plugin_cannot_reach_an_ungranted_capability() {
        // The example imports sde_type_info; granting only storage:own leaves
        // that import unsatisfied, so it can't even instantiate — the sandbox +
        // broker deny reaching a service it wasn't granted.
        let manager = PluginManager::new();
        let dir = tmp("escape");
        write_sde(&dir);
        let storage_only = HashSet::from([Permission::StorageOwn]);
        let err = manager
            .invoke(
                &dir,
                "pricing-model",
                &storage_only,
                &example_wasm(),
                "evaluate",
                b"34",
            )
            .unwrap_err();
        assert!(!err.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
