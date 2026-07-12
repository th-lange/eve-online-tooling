//! Plugin support — discovery and manifest loading (Phase 1 foundation).
//!
//! This is the on-disk half of the plugin system: it finds plugins under
//! `app_data_dir/plugins/<id>/`, parses and validates each `plugin.json`, and
//! holds the valid ones in a [`PluginRegistry`] managed by Tauri. There is no
//! execution here — running WASM/UI, the capability broker, and consent are
//! separate tickets. A plugin with an invalid manifest is skipped (logged),
//! never fatal, so a single bad drop-in can't stop the app from booting.

pub mod broker;
pub mod manager;
pub mod manifest;

pub use manager::PluginManager;

use std::path::Path;

use serde::Serialize;
use tauri::State;

use manifest::{Manifest, Permission};

/// A discovered, validated plugin plus its grant state. Grants are stubbed
/// empty for now — the consent flow that populates them is a later ticket.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    /// The parsed manifest metadata.
    pub manifest: Manifest,
    /// Permissions the user has actually granted (stub: none yet).
    pub granted: Vec<Permission>,
}

/// The set of installed, valid plugins, resolved once at startup and held in
/// Tauri managed state for commands to read.
#[derive(Debug, Default)]
pub struct PluginRegistry {
    entries: Vec<PluginEntry>,
}

impl PluginRegistry {
    /// Discover and validate every plugin under `app_data_dir/plugins/`.
    /// A missing or empty plugins dir yields an empty registry (not an error).
    pub fn load(app_data_dir: &Path) -> Self {
        Self {
            entries: discover(&app_data_dir.join("plugins")),
        }
    }

    /// The validated plugins, in directory order.
    pub fn entries(&self) -> &[PluginEntry] {
        &self.entries
    }
}

/// Enumerate `<plugins_dir>/<id>/plugin.json`, parse + validate each against
/// its directory name, and collect the valid ones. Invalid manifests are
/// logged to stderr and skipped. Non-directory entries are ignored.
fn discover(plugins_dir: &Path) -> Vec<PluginEntry> {
    let Ok(read) = std::fs::read_dir(plugins_dir) else {
        return Vec::new(); // dir absent/unreadable -> no plugins
    };
    let mut entries = Vec::new();
    for dirent in read.flatten() {
        let dir = dirent.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(dir_id) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let raw = match std::fs::read_to_string(dir.join("plugin.json")) {
            Ok(raw) => raw,
            Err(_) => continue, // no manifest -> not a plugin
        };
        match Manifest::parse_and_validate(&raw, dir_id) {
            Ok(manifest) => entries.push(PluginEntry {
                manifest,
                granted: Vec::new(),
            }),
            Err(e) => eprintln!("plugins: skipping {dir_id:?}: {e}"),
        }
    }
    // Stable, deterministic order regardless of the OS dir-listing order.
    entries.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    entries
}

/// List installed plugins with their manifest metadata and grant state.
#[tauri::command]
pub fn plugins_list(registry: State<'_, PluginRegistry>) -> Vec<PluginEntry> {
    registry.entries().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// A unique temp dir for one test, cleaned up front.
    fn tmp(tag: &str) -> std::path::PathBuf {
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
        // Missing plugins dir.
        assert!(PluginRegistry::load(&root).entries().is_empty());
        // Present but empty plugins dir.
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        assert!(PluginRegistry::load(&root).entries().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discovers_valid_plugins_sorted() {
        let root = tmp("valid");
        write_plugin(&root, "zeta", &manifest_json("zeta"));
        write_plugin(&root, "alpha", &manifest_json("alpha"));
        let reg = PluginRegistry::load(&root);
        let ids: Vec<_> = reg
            .entries()
            .iter()
            .map(|e| e.manifest.id.as_str())
            .collect();
        assert_eq!(ids, vec!["alpha", "zeta"]);
        assert!(reg.entries()[0].granted.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_invalid_manifest_but_keeps_valid_ones() {
        let root = tmp("mixed");
        write_plugin(&root, "good", &manifest_json("good"));
        // id/dir mismatch -> invalid, skipped.
        write_plugin(&root, "bad", &manifest_json("not-bad"));
        // Not a plugin (no manifest) -> ignored.
        std::fs::create_dir_all(root.join("plugins").join("empty-dir")).unwrap();
        let reg = PluginRegistry::load(&root);
        let ids: Vec<_> = reg
            .entries()
            .iter()
            .map(|e| e.manifest.id.as_str())
            .collect();
        assert_eq!(ids, vec!["good"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
