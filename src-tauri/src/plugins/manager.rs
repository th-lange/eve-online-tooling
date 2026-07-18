//! WASM runtime host: loads plugin `.wasm` via Extism and dispatches calls
//! into it at runtime through one generic `plugins_invoke` command — the way
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
use tauri::{AppHandle, State};

use super::broker::{host_functions, BrokerCtx};
use super::manifest::Permission;
use super::{PluginEntry, PluginRegistry};
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
/// only `functions` (the broker-gated host functions this plugin was granted)
/// and permitting outbound HTTP only to `allowed_hosts` (empty = no network).
fn build_plugin(
    wasm: &[u8],
    limits: &Limits,
    functions: Vec<Function>,
    allowed_hosts: &[String],
) -> Result<Plugin, String> {
    let mut manifest = ExtismManifest::new([Wasm::data(wasm.to_vec())])
        .with_memory_max(limits.max_pages)
        .with_timeout(limits.timeout);
    for host in allowed_hosts {
        manifest = manifest.with_allowed_host(host);
    }
    PluginBuilder::new(manifest)
        .with_wasi(true)
        .with_functions(functions)
        .build()
        .map_err(|e| format!("failed to instantiate plugin: {e}"))
}

/// Runtime cache of instantiated plugins, keyed by plugin id. Lazy: a plugin is
/// built on first invocation and kept warm. Held in Tauri managed state.
///
/// # Locking model
///
/// Two levels, so distinct plugins never serialize against each other:
///
/// - The **map mutex** guards only lookup/insert/remove of cache entries. It
///   is held for microseconds — never across a wasm call, a file read, or a
///   compile.
/// - Each entry is an `Arc<Mutex<Plugin>>` — the **per-plugin mutex**. An
///   Extism `Plugin` is a single instance and must not run two calls at once,
///   so calls to the *same* plugin still queue behind each other; calls to
///   *different* plugins proceed concurrently (UI command vs. MCP bridge vs.
///   another plugin's command).
///
/// Lock order is strictly map-then-plugin or plugin-then-map-briefly (the
/// error path), and no path ever locks a per-plugin mutex while holding the
/// map mutex, so the two levels cannot deadlock.
#[derive(Default)]
pub struct PluginManager {
    loaded: Mutex<HashMap<String, Arc<Mutex<Plugin>>>>,
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
    #[allow(clippy::too_many_arguments)]
    fn invoke(
        &self,
        app_data_dir: &Path,
        id: &str,
        granted: &HashSet<Permission>,
        allowed_hosts: &[String],
        wasm_path: &Path,
        func: &str,
        args: &[u8],
    ) -> Result<Vec<u8>, String> {
        // Grab the cached entry, or build one. The fs read + wasm compile of a
        // cold build happen *outside* the map lock so a slow first load of one
        // plugin doesn't stall every other plugin's lookup. If two threads
        // race to build the same plugin, `or_insert` keeps the first insert
        // and the loser's instance is simply dropped — wasteful but rare and
        // correct.
        let cached = self.loaded.lock().get(id).cloned();
        let entry = match cached {
            Some(entry) => entry,
            None => {
                let bytes = std::fs::read(wasm_path)
                    .map_err(|e| format!("cannot read plugin wasm {wasm_path:?}: {e}"))?;
                let ctx = Arc::new(BrokerCtx::new(app_data_dir.to_path_buf(), id.to_string()));
                let functions = host_functions(granted, ctx);
                let built = Arc::new(Mutex::new(build_plugin(
                    &bytes,
                    &self.limits,
                    functions,
                    allowed_hosts,
                )?));
                self.loaded
                    .lock()
                    .entry(id.to_string())
                    .or_insert(built)
                    .clone()
            }
        };
        // Only this plugin's own mutex is held across the call (bounded by the
        // Extism timeout); other plugins remain fully available meanwhile.
        let mut plugin = entry.lock();
        let result = plugin
            .call::<&[u8], Vec<u8>>(func, args)
            .map_err(|e| e.to_string());
        if result.is_err() {
            // Discard a possibly-interrupted instance — but only if the map
            // still holds *this* instance. A concurrent evict + rebuild (e.g.
            // a reinstall) must not have its fresh instance thrown away by our
            // stale failure.
            let mut loaded = self.loaded.lock();
            if loaded.get(id).is_some_and(|e| Arc::ptr_eq(e, &entry)) {
                loaded.remove(id);
            }
        }
        result
    }

    /// Drop the cached instance for `id` (e.g. on deactivation), so a later
    /// activation rebuilds it fresh with its then-current grants.
    pub fn evict(&self, id: &str) {
        self.loaded.lock().remove(id);
    }
}

/// Core plugin dispatch, shared by the `plugins_invoke` command and the MCP
/// bridge. Runs `func` on an **active** plugin with a JSON argument, returning
/// its JSON result. Unknown/inactive/wasm-less plugin, a wasm path escaping the
/// plugin dir, a non-JSON result, or a resource-limit kill all return an error.
/// An inactive plugin is inert — refused before any code runs.
pub fn run_plugin(
    registry: &PluginRegistry,
    manager: &PluginManager,
    app_data_dir: &Path,
    plugin_id: &str,
    func: &str,
    args: &Value,
) -> Result<Value, String> {
    let manifest = registry
        .manifest(plugin_id)
        .ok_or_else(|| format!("unknown plugin {plugin_id:?}"))?;
    if !registry.is_active(plugin_id) {
        return Err(format!("plugin {plugin_id:?} is not active"));
    }
    let wasm_rel = manifest
        .wasm
        .as_deref()
        .ok_or_else(|| format!("plugin {plugin_id:?} has no wasm entry point"))?;
    // The wasm path is author-controlled; keep it inside the plugin's own dir.
    if wasm_rel.contains("..") || Path::new(wasm_rel).is_absolute() {
        return Err(format!(
            "plugin {plugin_id:?} wasm path {wasm_rel:?} must be relative to its dir"
        ));
    }
    // An active plugin is granted exactly the permissions it declared.
    let granted: HashSet<Permission> = manifest.permissions.iter().copied().collect();
    // Outbound HTTP is limited to the declared hosts, and only when net:fetch
    // was granted; otherwise no network at all.
    let allowed_hosts: &[String] = if granted.contains(&Permission::NetFetch) {
        &manifest.allowed_hosts
    } else {
        &[]
    };
    let wasm_path = app_data_dir.join("plugins").join(plugin_id).join(wasm_rel);
    let input = serde_json::to_vec(args).map_err(|e| e.to_string())?;
    let out = manager.invoke(
        app_data_dir,
        plugin_id,
        &granted,
        allowed_hosts,
        &wasm_path,
        func,
        &input,
    )?;
    serde_json::from_slice::<Value>(&out)
        .map_err(|e| format!("plugin {plugin_id:?} returned non-JSON: {e}"))
}

/// Invoke an exported function of an activated plugin — the runtime dispatch
/// point for logic plugins. Thin wrapper over [`run_plugin`].
///
/// # Threading model
///
/// The wasm call is deliberately pushed onto tokio's **blocking thread pool**
/// (`spawn_blocking`), following the `scripts_run` precedent, because plugin
/// execution is synchronous and can be slow in two independent ways:
///
/// 1. The guest itself may run up to the 5-second Extism timeout.
/// 2. The broker's `host_call` gateway (see [`crate::plugins::broker`]) is a
///    synchronous Extism host function — that contract is fixed by Extism —
///    and capability handlers inside it `block_on` real network futures
///    (ESI/Fuzzwork fetches with retry/backoff).
///
/// Run inline on a sync command, both of those parked the **main thread** and
/// froze the whole UI for the duration. On a blocking-pool worker, blocking is
/// exactly what the thread is for: `tauri::async_runtime::block_on` inside the
/// capability handlers is safe there (the thread is not an async runtime
/// worker, so re-entrant `block_on` panics can't occur), and it matches how
/// the same handlers already run from the MCP bridge (dedicated OS thread) and
/// from scripts (`spawn_blocking`).
#[tauri::command]
pub async fn plugins_invoke(
    app: AppHandle,
    registry: State<'_, Arc<PluginRegistry>>,
    manager: State<'_, Arc<PluginManager>>,
    plugin_id: String,
    r#fn: String,
    args: Value,
) -> Result<Value, AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    // Both are `Arc`-managed in Tauri state, so cloning into the closure is
    // a cheap refcount bump.
    let registry = registry.inner().clone();
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || {
        run_plugin(&registry, &manager, &dir, &plugin_id, &r#fn, &args).map_err(AppError::from)
    })
    .await
    // A JoinError means the blocking task panicked or was cancelled; surface
    // it as a normal command error instead of poisoning the caller.
    .map_err(|e| AppError::from(format!("plugin task failed: {e}")))?
}

/// Activate or deactivate an installed plugin. Deactivating evicts any cached
/// instance so it stops running immediately.
#[tauri::command]
pub fn plugins_set_active(
    registry: State<'_, Arc<PluginRegistry>>,
    manager: State<'_, Arc<PluginManager>>,
    plugin_id: String,
    active: bool,
) -> Result<(), AppError> {
    registry
        .set_active(&plugin_id, active)
        .map_err(AppError::from)?;
    if !active {
        manager.evict(&plugin_id);
    }
    Ok(())
}

/// Re-scan the plugins folder at runtime so a plugin added or removed since
/// launch is picked up without restarting the app. Evicts the cached instance
/// of any plugin that vanished, then returns the fresh list.
#[tauri::command]
pub fn plugins_rescan(
    registry: State<'_, Arc<PluginRegistry>>,
    manager: State<'_, Arc<PluginManager>>,
) -> Vec<PluginEntry> {
    for id in registry.rescan() {
        manager.evict(&id);
    }
    registry.list()
}

/// Uninstall an installed plugin: evict its cached instance (if any),
/// deactivate it, remove it from the registry, and delete its folder on
/// disk. Returns the fresh installed list.
#[tauri::command]
pub fn plugins_remove(
    registry: State<'_, Arc<PluginRegistry>>,
    manager: State<'_, Arc<PluginManager>>,
    plugin_id: String,
) -> Result<Vec<PluginEntry>, AppError> {
    manager.evict(&plugin_id);
    registry.remove(&plugin_id).map_err(AppError::from)?;
    Ok(registry.list())
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
             CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL, published INT, marketGroupID INT);
             INSERT INTO invGroups VALUES (18, 4, 'Mineral');
             INSERT INTO invTypes VALUES (34, 18, 'Tritanium', 0.01, 1, 1);",
        )
        .unwrap();
    }

    #[test]
    fn echo_round_trips_a_json_payload() {
        let mut plugin = build_plugin(ECHO_WASM, &Limits::default(), Vec::new(), &[]).unwrap();
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
        let mut plugin = build_plugin(ECHO_WASM, &limits, Vec::new(), &[]).unwrap();
        assert!(plugin.call::<&[u8], Vec<u8>>("spin", b"{}").is_err());
    }

    #[test]
    fn builds_with_allowed_hosts() {
        // net:fetch plugins are built with an allowed-hosts list; building with
        // one set must succeed (no request is made at build time).
        let hosts = vec!["api.example.com".to_string()];
        assert!(build_plugin(ECHO_WASM, &Limits::default(), Vec::new(), &hosts).is_ok());
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
                &[],
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
                &[],
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
    fn evict_drops_the_warm_instance_so_the_next_invoke_reloads_from_disk() {
        let manager = PluginManager::new();
        let dir = tmp("evict-reload");
        std::fs::create_dir_all(&dir).unwrap();
        let wasm = dir.join("plugin.wasm");
        std::fs::copy(echo_path(), &wasm).unwrap();
        let call = |payload: &'static [u8]| {
            manager.invoke(&dir, "swap", &HashSet::new(), &[], &wasm, "echo", payload)
        };
        assert!(call(br#"{"a":1}"#).is_ok());
        // Replace the artifact on disk (what a reinstall does). The warm
        // instance still serves the OLD bytes — that's the cache semantics
        // an install must compensate for by evicting...
        std::fs::copy(kv_path(), &wasm).unwrap();
        assert!(call(br#"{"a":2}"#).is_ok());
        // ...and once evicted, the next invoke loads the new wasm from disk
        // (kv.wasm has no `echo` export, so the call now fails).
        manager.evict("swap");
        assert!(call(br#"{"a":3}"#).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_busy_plugin_does_not_block_a_different_plugin() {
        // Deterministic stand-in for "plugin A is mid-call": hold A's
        // per-plugin mutex from the test thread — exactly the lock an
        // in-flight `plugin.call` holds — then invoke a *different* plugin
        // from another thread. Under the old single manager-wide mutex this
        // would park B behind A (up to the 5s Extism timeout); with
        // per-plugin locking B must complete promptly.
        let manager = Arc::new(PluginManager::new());
        let dir = tmp("concurrent");
        manager
            .invoke(
                &dir,
                "a",
                &HashSet::new(),
                &[],
                &echo_path(),
                "echo",
                br#"{"warm":true}"#,
            )
            .unwrap();
        let a_entry = manager.loaded.lock().get("a").unwrap().clone();
        let a_guard = a_entry.lock(); // "a" is now busy
        let (tx, rx) = std::sync::mpsc::channel();
        let (m, d) = (manager.clone(), dir.clone());
        std::thread::spawn(move || {
            let r = m.invoke(
                &d,
                "b",
                &HashSet::new(),
                &[],
                &echo_path(),
                "echo",
                br#"{"who":"b"}"#,
            );
            let _ = tx.send(r);
        });
        let out = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("invoking plugin b must not wait for plugin a's in-flight call")
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&out).unwrap(),
            serde_json::json!({"who": "b"})
        );
        drop(a_guard);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn granted_plugin_can_use_its_storage() {
        let manager = PluginManager::new();
        let dir = tmp("granted");
        let granted = HashSet::from([Permission::StorageOwn]);
        manager
            .invoke(
                &dir,
                "acme",
                &granted,
                &[],
                &kv_path(),
                "kv_set",
                br#""hello""#,
            )
            .unwrap();
        let got = manager
            .invoke(&dir, "acme", &granted, &[], &kv_path(), "kv_get", br#""""#)
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
                &[],
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
            .invoke(
                &dir,
                "a",
                &granted,
                &[],
                &kv_path(),
                "kv_set",
                br#""from-a""#,
            )
            .unwrap();
        // Plugin B reads its own (empty) storage — cannot see A's.
        let b = manager
            .invoke(&dir, "b", &granted, &[], &kv_path(), "kv_get", br#""""#)
            .unwrap();
        assert!(b.is_empty(), "plugin B must not see plugin A's data");
        // A still sees its own value.
        let a = manager
            .invoke(&dir, "a", &granted, &[], &kv_path(), "kv_get", br#""""#)
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
        // Type id sent as a bare JSON number (what plugins_invoke serializes).
        let out = manager
            .invoke(
                &dir,
                "pricing-model",
                &granted,
                &[],
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
                &[],
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
    fn example_plugin_searches_types_by_name() {
        // The `search` export routes through the generic `host_call` gateway to
        // the `sde_search` capability (reached via sde:read), turning a typed
        // name into matching type ids for the UI's autocomplete.
        let manager = PluginManager::new();
        let dir = tmp("search");
        write_sde(&dir);
        let granted = HashSet::from([Permission::SdeRead, Permission::StorageOwn]);
        let out = manager
            .invoke(
                &dir,
                "pricing-model",
                &granted,
                &[],
                &example_wasm(),
                "search",
                br#"{"query":"trit"}"#,
            )
            .unwrap();
        let v: Value = serde_json::from_slice(&out).unwrap();
        let results = v["results"].as_array().expect("results array");
        assert!(
            results
                .iter()
                .any(|r| r["typeId"] == 34 && r["name"] == "Tritanium"),
            "search must resolve Tritanium: {v}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn example_plugin_price_requires_market_read() {
        // `price` calls market_price through host_call; without market:read the
        // gateway rejects it and the guest call errors — the UI layers price on
        // top of `evaluate` as optional exactly because of this.
        let manager = PluginManager::new();
        let dir = tmp("price");
        write_sde(&dir);
        let granted = HashSet::from([Permission::SdeRead, Permission::StorageOwn]);
        let result = manager.invoke(
            &dir,
            "pricing-model",
            &granted,
            &[],
            &example_wasm(),
            "price",
            b"34",
        );
        assert!(
            result.is_err(),
            "price without market:read must fail, got {result:?}"
        );
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
                &[],
                &example_wasm(),
                "evaluate",
                b"34",
            )
            .unwrap_err();
        assert!(!err.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
