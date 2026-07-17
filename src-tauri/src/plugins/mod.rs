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
pub mod protocol;

pub use manager::PluginManager;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::State;

use crate::model::AppError;
use crate::storage;
use manifest::{id_is_safe, Manifest};

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
    manifests: Mutex<Vec<Manifest>>,
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
            manifests: Mutex::new(manifests),
            active: Mutex::new(active),
            app_data_dir: app_data_dir.to_path_buf(),
        }
    }

    /// Every installed plugin with its current activation state, id-sorted.
    pub fn list(&self) -> Vec<PluginEntry> {
        let manifests = self.manifests.lock();
        let active = self.active.lock();
        manifests
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
        self.manifests.lock().iter().find(|m| m.id == id).cloned()
    }

    /// Activate or deactivate plugin `id`, persisting the new set. Errors if the
    /// id isn't installed.
    pub fn set_active(&self, id: &str, active: bool) -> Result<(), String> {
        if !self.manifests.lock().iter().any(|m| m.id == id) {
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
        let manifests = self.manifests.lock();
        let active = self.active.lock();
        manifests
            .iter()
            .filter(|m| active.contains(&m.id))
            .flat_map(|m| m.mcp_tools.iter().map(|t| (m.id.clone(), t.clone())))
            .collect()
    }

    /// Re-scan `plugins/` at runtime (a folder was added or removed without a
    /// restart). Swaps in the freshly discovered manifests and prunes the active
    /// set to what's still installed, persisting it. Returns the ids that were
    /// active but have now vanished, so the caller can evict their instances.
    pub fn rescan(&self) -> Vec<String> {
        let fresh = discover(&self.app_data_dir.join("plugins"));
        let installed: HashSet<String> = fresh.iter().map(|m| m.id.clone()).collect();
        let mut manifests = self.manifests.lock();
        let mut active = self.active.lock();
        *manifests = fresh;
        let removed: Vec<String> = active
            .iter()
            .filter(|id| !installed.contains(*id))
            .cloned()
            .collect();
        for id in &removed {
            active.remove(id);
        }
        let ids: Vec<String> = {
            let mut v: Vec<String> = active.iter().cloned().collect();
            v.sort();
            v
        };
        let _ = storage::save_data(&self.app_data_dir, ACTIVE_KEY, &ids);
        removed
    }

    /// Absolute path of the folder plugins install into
    /// (`<app_data_dir>/plugins`), for showing the user where to drop them.
    pub fn plugins_dir(&self) -> PathBuf {
        self.app_data_dir.join("plugins")
    }

    /// Copy a plugin from `source` (a directory containing `plugin.json`)
    /// into `plugins_dir/<id>/`, replacing any existing install of the same
    /// id (an install is also an update/reinstall). Validates the manifest
    /// against the *destination* id before publishing it — a malformed drop
    /// never becomes visible, and a failed copy is cleaned up. Returns the
    /// installed id.
    pub fn install_dir(&self, source: &Path) -> Result<String, String> {
        let raw = std::fs::read_to_string(source.join("plugin.json"))
            .map_err(|e| format!("no plugin.json in {source:?}: {e}"))?;
        let id = raw_manifest_id(&raw)?;
        let dest = self.plugins_dir().join(&id);
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        copy_dir_all(source, &dest).map_err(|e| e.to_string())?;
        match Manifest::parse_and_validate(&raw, &id) {
            Ok(manifest) => {
                let mut manifests = self.manifests.lock();
                manifests.retain(|m| m.id != id);
                manifests.push(manifest);
                manifests.sort_by(|a, b| a.id.cmp(&b.id));
                Ok(id)
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dest);
                Err(e.to_string())
            }
        }
    }

    /// Extract a `.zip` at `zip_path` into a scratch dir under `plugins_dir`,
    /// then install it exactly like [`Self::install_dir`]. Accepts both a zip
    /// whose root *is* the plugin (has `plugin.json` at the top level) and
    /// one that wraps it one level deep in a single folder — the shape the
    /// release zips linked from `docs/plugins.md` ship as.
    pub fn install_zip(&self, zip_path: &Path) -> Result<String, String> {
        let staging = self
            .plugins_dir()
            .join(format!(".installing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&staging);
        let extracted = extract_zip(zip_path, &staging);
        let result = extracted.and_then(|()| {
            let source = if staging.join("plugin.json").exists() {
                staging.clone()
            } else {
                std::fs::read_dir(&staging)
                    .map_err(|e| e.to_string())?
                    .flatten()
                    .map(|d| d.path())
                    .filter(|p| p.is_dir())
                    .find(|d| d.join("plugin.json").exists())
                    .ok_or_else(|| {
                        "zip has no plugin.json at its root or one level deep".to_string()
                    })?
            };
            self.install_dir(&source)
        });
        let _ = std::fs::remove_dir_all(&staging);
        result
    }

    /// Uninstall plugin `id`: deactivate it, forget it, and delete its
    /// folder. Errors if it isn't installed. Deleting the folder is
    /// best-effort — the registry state is dropped either way, the same
    /// discipline `rescan` uses, so a filesystem the user is fighting can't
    /// wedge the app into thinking a removed plugin is still installed.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if !self.manifests.lock().iter().any(|m| m.id == id) {
            return Err(format!("unknown plugin {id:?}"));
        }
        self.manifests.lock().retain(|m| m.id != id);
        self.active.lock().remove(id);
        let ids: Vec<String> = {
            let set = self.active.lock();
            let mut v: Vec<String> = set.iter().cloned().collect();
            v.sort();
            v
        };
        storage::save_data(&self.app_data_dir, ACTIVE_KEY, &ids)?;
        let _ = std::fs::remove_dir_all(self.plugins_dir().join(id));
        Ok(())
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

/// The absolute path plugins install into, so the UI can show the user exactly
/// where to drop a plugin folder (the location differs per OS).
#[tauri::command]
pub fn plugins_dir(registry: State<'_, std::sync::Arc<PluginRegistry>>) -> String {
    registry.plugins_dir().to_string_lossy().into_owned()
}

/// On first run — before any `plugins/` folder exists — drop the bundled
/// example UI plugin in, so there's something to activate out of the box. Once
/// `plugins/` exists we never touch it again: deleting the example keeps it
/// gone, and we never fight a user's own plugins.
pub fn seed_example_plugin(app_data_dir: &Path) {
    let plugins = app_data_dir.join("plugins");
    if plugins.exists() {
        return;
    }
    let dir = plugins.join("hello-ui");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(
        dir.join("plugin.json"),
        include_str!("../../../examples/plugins/hello-ui/plugin.json"),
    );
    let _ = std::fs::write(
        dir.join("index.html"),
        include_str!("../../../examples/plugins/hello-ui/index.html"),
    );
}

/// Pull the bare `id` field out of a `plugin.json` without fully validating
/// it yet (full validation needs the destination directory name, which isn't
/// known until we pick one from this id). Just enough parsing to know where
/// to copy the plugin to.
fn raw_manifest_id(raw: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid plugin.json: {e}"))?;
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "plugin.json has no \"id\" string".to_string())?;
    if !id_is_safe(id) {
        return Err(format!("invalid plugin id {id:?}: use only [A-Za-z0-9_-]"));
    }
    Ok(id.to_string())
}

/// Recursively copy `source` into `dest` (which must not already exist).
fn copy_dir_all(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let to = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Extract every entry of the zip at `zip_path` under `dest`, rejecting any
/// entry whose path would escape `dest` (a malicious or malformed zip
/// otherwise writing outside the staging dir — "zip slip").
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name() else {
            return Err(format!("zip entry {:?} has an unsafe path", entry.name()));
        };
        let out = dest.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out_file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Install a plugin dropped onto the Plugins page: `path` is an absolute
/// path to either a plugin folder (containing `plugin.json`) or a `.zip` of
/// one. Returns the fresh installed list on success.
#[tauri::command]
pub fn plugins_install(
    registry: State<'_, std::sync::Arc<PluginRegistry>>,
    path: String,
) -> Result<Vec<PluginEntry>, AppError> {
    let source = Path::new(&path);
    let is_zip = source
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
    let result = if is_zip {
        registry.install_zip(source)
    } else if source.is_dir() {
        registry.install_dir(source)
    } else {
        Err(format!("{path:?} is neither a folder nor a .zip file"))
    };
    result.map_err(AppError::from)?;
    Ok(registry.list())
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

    #[test]
    fn rescan_picks_up_added_and_drops_removed() {
        let root = tmp("rescan");
        write_plugin(&root, "acme", &manifest_json("acme"));
        let reg = PluginRegistry::load(&root);
        reg.set_active("acme", true).unwrap();
        assert!(reg.is_active("acme"));

        // Add a second plugin, remove the first, then rescan at runtime.
        write_plugin(&root, "beta", &manifest_json("beta"));
        std::fs::remove_dir_all(root.join("plugins").join("acme")).unwrap();
        let removed = reg.rescan();

        // The vanished-but-active plugin is reported (so its instance is evicted).
        assert_eq!(removed, vec!["acme".to_string()]);
        // The list reflects the freshly discovered folders.
        let ids: Vec<_> = reg.list().iter().map(|e| e.manifest.id.clone()).collect();
        assert_eq!(ids, vec!["beta".to_string()]);
        // The removed plugin is deactivated, and the prune persisted — a fresh
        // load agrees.
        assert!(!reg.is_active("acme"));
        assert!(!PluginRegistry::load(&root).is_active("acme"));
        let _ = std::fs::remove_dir_all(&root);
    }

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        use std::io::Write as _;
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, content) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn install_dir_copies_and_publishes_under_the_manifest_id() {
        let root = tmp("install-dir");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        // The dropped source folder's own name is irrelevant — the manifest's
        // `id` decides where it lands.
        let source = root.join("dropped-folder-name");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("plugin.json"), manifest_json("acme")).unwrap();
        std::fs::write(source.join("a.wasm"), b"fake wasm").unwrap();

        let reg = PluginRegistry::load(&root);
        let id = reg.install_dir(&source).unwrap();
        assert_eq!(id, "acme");
        assert!(root.join("plugins/acme/plugin.json").exists());
        assert!(root.join("plugins/acme/a.wasm").exists());
        let ids: Vec<_> = reg.list().iter().map(|e| e.manifest.id.clone()).collect();
        assert_eq!(ids, vec!["acme".to_string()]);
        // A fresh load agrees — the copy is durable, not just in-memory.
        let ids: Vec<_> = PluginRegistry::load(&root)
            .list()
            .iter()
            .map(|e| e.manifest.id.clone())
            .collect();
        assert_eq!(ids, vec!["acme".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_dir_reinstall_replaces_the_previous_copy() {
        let root = tmp("install-reinstall");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let source = root.join("src");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("plugin.json"), manifest_json("acme")).unwrap();
        std::fs::write(source.join("old.wasm"), b"v1").unwrap();

        let reg = PluginRegistry::load(&root);
        reg.install_dir(&source).unwrap();
        assert!(root.join("plugins/acme/old.wasm").exists());

        // Reinstall with a different file set — the stale file must be gone.
        std::fs::remove_file(source.join("old.wasm")).unwrap();
        std::fs::write(source.join("new.wasm"), b"v2").unwrap();
        reg.install_dir(&source).unwrap();
        assert!(!root.join("plugins/acme/old.wasm").exists());
        assert!(root.join("plugins/acme/new.wasm").exists());
        // Still exactly one "acme" entry, not a duplicate.
        assert_eq!(
            reg.list()
                .iter()
                .filter(|e| e.manifest.id == "acme")
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_dir_rejects_a_malformed_manifest_and_cleans_up() {
        let root = tmp("install-bad");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let source = root.join("src");
        std::fs::create_dir_all(&source).unwrap();
        // No wasm and no ui -> NoEntryPoint.
        std::fs::write(
            source.join("plugin.json"),
            r#"{"id":"acme","name":"acme","version":"1.0.0","minAppVersion":"0.33.0","permissions":[]}"#,
        )
        .unwrap();

        let reg = PluginRegistry::load(&root);
        assert!(reg.install_dir(&source).is_err());
        assert!(reg.list().is_empty());
        // The copy was rolled back, not left behind as a ghost install.
        assert!(!root.join("plugins/acme").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_zip_at_root_and_one_level_deep_both_work() {
        let root = tmp("install-zip");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let reg = PluginRegistry::load(&root);

        // Zip whose entries are the plugin's own files at the archive root.
        let flat_zip = root.join("flat.zip");
        write_zip(
            &flat_zip,
            &[
                ("plugin.json", &manifest_json("flat-plugin")),
                ("a.wasm", "fake"),
            ],
        );
        let id = reg.install_zip(&flat_zip).unwrap();
        assert_eq!(id, "flat-plugin");
        assert!(root.join("plugins/flat-plugin/plugin.json").exists());

        // Zip that wraps the plugin one level deep — the release-zip shape.
        let nested_zip = root.join("nested.zip");
        write_zip(
            &nested_zip,
            &[
                ("nested-plugin/plugin.json", &manifest_json("nested-plugin")),
                ("nested-plugin/a.wasm", "fake"),
            ],
        );
        let id = reg.install_zip(&nested_zip).unwrap();
        assert_eq!(id, "nested-plugin");
        assert!(root.join("plugins/nested-plugin/plugin.json").exists());

        let ids: Vec<_> = reg.list().iter().map(|e| e.manifest.id.clone()).collect();
        assert_eq!(
            ids,
            vec!["flat-plugin".to_string(), "nested-plugin".to_string()]
        );
        // No leftover staging directory.
        assert!(std::fs::read_dir(root.join("plugins"))
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().starts_with(".installing-")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_zip_with_no_manifest_anywhere_is_rejected() {
        let root = tmp("install-zip-bad");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let zip_path = root.join("empty.zip");
        write_zip(&zip_path, &[("readme.txt", "not a plugin")]);
        let reg = PluginRegistry::load(&root);
        assert!(reg.install_zip(&zip_path).is_err());
        assert!(reg.list().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_deactivates_deletes_and_persists() {
        let root = tmp("remove");
        write_plugin(&root, "acme", &manifest_json("acme"));
        let reg = PluginRegistry::load(&root);
        reg.set_active("acme", true).unwrap();
        assert!(reg.is_active("acme"));

        reg.remove("acme").unwrap();
        assert!(reg.list().is_empty());
        assert!(!root.join("plugins/acme").exists());
        // Persisted: a fresh load also has nothing active/installed.
        let fresh = PluginRegistry::load(&root);
        assert!(fresh.list().is_empty());
        assert!(!fresh.is_active("acme"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_unknown_plugin_errors() {
        let root = tmp("remove-unknown");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let reg = PluginRegistry::load(&root);
        assert!(reg.remove("nope").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
