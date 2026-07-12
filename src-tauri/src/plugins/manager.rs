//! WASM runtime host: loads plugin `.wasm` via Extism and dispatches calls
//! into it at runtime through one generic `plugin_invoke` command — the way
//! around `tauri::generate_handler!` being fixed at compile time.
//!
//! This ticket wires the plumbing only. A plugin runs sandboxed with **no**
//! host functions, so even a plugin that was granted nothing still executes —
//! it just can't reach any host service. Capability enforcement (host
//! functions gated by granted permissions) is a separate ticket.
//!
//! Every instance is capped: a memory ceiling and a per-call timeout (Extism's
//! epoch interruption) so a runaway or memory-hungry plugin is terminated with
//! an error rather than hanging or exhausting the app.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use extism::{Manifest as ExtismManifest, Plugin, PluginBuilder, Wasm};
use serde_json::Value;
use tauri::{AppHandle, Manager as _, State};

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

/// Build a sandboxed Extism plugin from raw wasm bytes under `limits`.
fn build_plugin(wasm: &[u8], limits: &Limits) -> Result<Plugin, String> {
    let manifest = ExtismManifest::new([Wasm::data(wasm.to_vec())])
        .with_memory_max(limits.max_pages)
        .with_timeout(limits.timeout);
    PluginBuilder::new(manifest)
        .with_wasi(true)
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

    /// Call `func` on the plugin `id`, loading it from `wasm_path` on first use.
    /// Input/output are opaque bytes (the command layer speaks JSON). A failed
    /// call evicts the cached instance — an interrupted (timed-out) Extism
    /// instance can't be reused, so the next call rebuilds it fresh.
    fn call_raw(
        &self,
        wasm_path: &Path,
        id: &str,
        func: &str,
        args: &[u8],
    ) -> Result<Vec<u8>, String> {
        let mut loaded = self
            .loaded
            .lock()
            .map_err(|_| "plugin manager lock poisoned".to_string())?;
        if !loaded.contains_key(id) {
            let bytes = std::fs::read(wasm_path)
                .map_err(|e| format!("cannot read plugin wasm {wasm_path:?}: {e}"))?;
            loaded.insert(id.to_string(), build_plugin(&bytes, &self.limits)?);
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
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let wasm_path = dir.join("plugins").join(&plugin_id).join(wasm_rel);

    let input = serde_json::to_vec(&args).map_err(|e| e.to_string())?;
    let out = manager.call_raw(&wasm_path, &plugin_id, &r#fn, &input)?;
    let value = serde_json::from_slice::<Value>(&out)
        .map_err(|e| AppError::from(format!("plugin {plugin_id:?} returned non-JSON: {e}")))?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const ECHO_WASM: &[u8] = include_bytes!("testdata/echo.wasm");

    fn testdata_wasm() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins/testdata/echo.wasm")
    }

    #[test]
    fn echo_round_trips_a_json_payload() {
        let mut plugin = build_plugin(ECHO_WASM, &Limits::default()).unwrap();
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
        let mut plugin = build_plugin(ECHO_WASM, &limits).unwrap();
        // `spin` loops forever; epoch interruption must kill it -> Err, no hang.
        let result = plugin.call::<&[u8], Vec<u8>>("spin", b"{}");
        assert!(result.is_err());
    }

    #[test]
    fn manager_loads_caches_and_dispatches() {
        let manager = PluginManager::new();
        let path = testdata_wasm();
        let out = manager
            .call_raw(&path, "echo-fixture", "echo", br#"{"a":1}"#)
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&out).unwrap(),
            serde_json::json!({"a": 1})
        );
        // Second call reuses the cached instance.
        let out2 = manager
            .call_raw(&path, "echo-fixture", "echo", br#"{"a":2}"#)
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&out2).unwrap(),
            serde_json::json!({"a": 2})
        );
    }

    #[test]
    fn unknown_function_is_an_error_not_a_panic() {
        let manager = PluginManager::new();
        let result = manager.call_raw(&testdata_wasm(), "echo-fixture", "nope", b"{}");
        assert!(result.is_err());
    }
}
