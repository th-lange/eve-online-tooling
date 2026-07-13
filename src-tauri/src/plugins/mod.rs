//! Plugin support — discovery, activation state, and the logic-plugin call path.
//!
//! Plugins are installed by dropping a folder into `app_data_dir/plugins/<id>/`.
//! Installing is the trust decision; there is no per-permission consent prompt.
//! Instead every installed plugin is **inert until activated** from the Plugins
//! page, and the page shows exactly which capabilities each plugin declares so
//! the user sees what they're turning on. An active plugin runs with the
//! permissions its manifest declares; an inactive one can't be invoked at all.
//!
//! An invalid manifest is skipped (logged), never fatal, so one bad drop-in
//! can't stop the app from booting.

pub mod broker;
pub mod manager;
pub mod manifest;

pub use manager::PluginManager;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;

use crate::storage;
use manifest::Manifest;

/// Storage document holding the ids of activated plugins.
const ACTIVE_KEY: &str = "plugins_active";

/// One installed plugin as shown to the UI: its manifest metadata plus whether
/// it is currently activated.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub manifest: Manifest,
    pub active: bool,
}

/// The installed, valid plugins plus their activation state. Discovered once at
/// startup; activation toggles at runtime (persisted) so it takes effect
/// without a restart. Held in Tauri managed state.
#[derive(Debug)]
pub struct PluginRegistry {
    manifests: Vec<Manifest>,
    active: Mutex<HashSet<String>>,
    app_data_dir: PathBuf,
}

impl PluginRegistry {
    /// Discover + validate every plugin under `app_data_dir/plugins/`, and load
    /// the persisted set of activated ids (dropping any that no longer exist).
    /// A missing/empty plugins dir yields an empty registry (not an error).
    pub fn load(app_data_dir: &Path) -> Self {
        let manifests = discover(&app_data_dir.join("plugins"));
        let installed: HashSet<&str> = manifests.iter().map(|m| m.id.as_str()).collect();
        let active: HashSet<String> = storage::load_data::<Vec<String>>(app_data_dir, ACTIVE_KEY)
            .unwrap_or_default()
            .into_iter()
            .filter(|id| installed.contains(id.as_str()))
            .collect();
        Self {
            manifests,
            active: Mutex::new(active),
            app_data_dir: app_data_dir.to_path_buf(),
        }
    }

    /// Every installed plugin with its current activation state, id-sorted.
    pub fn list(&self) -> Vec<PluginEntry> {
        let active = self.active.lock();
        self.manifests
            .iter()
            .map(|m| PluginEntry {
                manifest: m.clone(),
                active: active.contains(&m.id),
            })
            .collect()
    }

    /// Whether plugin `id` is currently activated.
    pub fn is_active(&self, id: &str) -> bool {
        self.active.lock().contains(id)
    }

    /// The manifest for `id`, if installed.
    pub fn manifest(&self, id: &str) -> Option<Manifest> {
        self.manifests.iter().find(|m| m.id == id).cloned()
    }

    /// Activate or deactivate plugin `id`, persisting the new set. Errors if the
    /// id isn't installed.
    pub fn set_active(&self, id: &str, active: bool) -> Result<(), String> {
        if !self.manifests.iter().any(|m| m.id == id) {
            return Err(format!("unknown plugin {id:?}"));
        }
        let mut set = self.active.lock();
        if active {
            set.insert(id.to_string());
        } else {
            set.remove(id);
        }
        let ids: Vec<String> = {
            let mut v: Vec<String> = set.iter().cloned().collect();
            v.sort();
            v
        };
        storage::save_data(&self.app_data_dir, ACTIVE_KEY, &ids)
    }

    /// `(pluginId, tool)` for every MCP tool declared by a currently-active
    /// plugin. Drives the MCP bridge's plugin-contributed tool surface.
    pub fn active_mcp_tools(&self) -> Vec<(String, manifest::McpToolDef)> {
        let active = self.active.lock();
        self.manifests
            .iter()
            .filter(|m| active.contains(&m.id))
            .flat_map(|m| m.mcp_tools.iter().map(|t| (m.id.clone(), t.clone())))
            .collect()
    }
}

/// Enumerate `<plugins_dir>/<id>/plugin.json`, parse + validate each against
/// its directory name, and collect the valid manifests. Invalid manifests are
/// logged and skipped; non-directory entries ignored.
fn discover(plugins_dir: &Path) -> Vec<Manifest> {
    let Ok(read) = std::fs::read_dir(plugins_dir) else {
        return Vec::new(); // dir absent/unreadable -> no plugins
    };
    let mut manifests = Vec::new();
    for dirent in read.flatten() {
        let dir = dirent.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(dir_id) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(dir.join("plugin.json")) else {
            continue; // no manifest -> not a plugin
        };
        match Manifest::parse_and_validate(&raw, dir_id) {
            Ok(manifest) => manifests.push(manifest),
            Err(e) => eprintln!("plugins: skipping {dir_id:?}: {e}"),
        }
    }
    manifests.sort_by(|a, b| a.id.cmp(&b.id));
    manifests
}

/// List installed plugins with their manifest metadata and activation state.
#[tauri::command]
pub fn plugins_list(registry: State<'_, std::sync::Arc<PluginRegistry>>) -> Vec<PluginEntry> {
    registry.list()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eve-plugins-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn write_plugin(root: &Path, id: &str, plugin_json: &str) {
        let dir = root.join("plugins").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.json"), plugin_json).unwrap();
    }

    fn manifest_json(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"{id}","version":"1.0.0","minAppVersion":"0.33.0","wasm":"a.wasm","permissions":["market:read"]}}"#
        )
    }

    #[test]
    fn empty_or_missing_dir_yields_no_plugins() {
        let root = tmp("empty");
        assert!(PluginRegistry::load(&root).list().is_empty());
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        assert!(PluginRegistry::load(&root).list().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discovers_plugins_sorted_and_inactive_by_default() {
        let root = tmp("valid");
        write_plugin(&root, "zeta", &manifest_json("zeta"));
        write_plugin(&root, "alpha", &manifest_json("alpha"));
        let reg = PluginRegistry::load(&root);
        let list = reg.list();
        let ids: Vec<_> = list.iter().map(|e| e.manifest.id.as_str()).collect();
        assert_eq!(ids, vec!["alpha", "zeta"]);
        // A freshly discovered plugin is inert until explicitly activated.
        assert!(list.iter().all(|e| !e.active));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_invalid_manifest_but_keeps_valid_ones() {
        let root = tmp("mixed");
        write_plugin(&root, "good", &manifest_json("good"));
        write_plugin(&root, "bad", &manifest_json("not-bad")); // id/dir mismatch
        std::fs::create_dir_all(root.join("plugins").join("empty-dir")).unwrap();
        let reg = PluginRegistry::load(&root);
        let ids: Vec<_> = reg.list().iter().map(|e| e.manifest.id.clone()).collect();
        assert_eq!(ids, vec!["good".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn activation_persists_across_reloads() {
        let root = tmp("activate");
        write_plugin(&root, "acme", &manifest_json("acme"));
        let reg = PluginRegistry::load(&root);
        assert!(!reg.is_active("acme"));
        reg.set_active("acme", true).unwrap();
        assert!(reg.is_active("acme"));
        // A fresh registry over the same dir sees the persisted activation.
        let reloaded = PluginRegistry::load(&root);
        assert!(reloaded.is_active("acme"));
        // Deactivate persists too.
        reloaded.set_active("acme", false).unwrap();
        assert!(!PluginRegistry::load(&root).is_active("acme"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn set_active_rejects_unknown_plugin() {
        let root = tmp("unknown");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let reg = PluginRegistry::load(&root);
        assert!(reg.set_active("ghost", true).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stale_active_ids_are_dropped_on_load() {
        let root = tmp("stale");
        write_plugin(&root, "acme", &manifest_json("acme"));
        let reg = PluginRegistry::load(&root);
        reg.set_active("acme", true).unwrap();
        // Persist an extra id that isn't installed, then reload.
        storage::save_data(
            &root,
            ACTIVE_KEY,
            &vec!["acme".to_string(), "gone".to_string()],
        )
        .unwrap();
        let reloaded = PluginRegistry::load(&root);
        assert!(reloaded.is_active("acme"));
        assert!(!reloaded.is_active("gone"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
