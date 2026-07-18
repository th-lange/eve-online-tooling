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
        let plugins_dir = app_data_dir.join("plugins");
        // A crash mid-install leaves its staging dir behind; clean those up
        // now, at boot, when no install can possibly be in flight.
        sweep_staging(&plugins_dir);
        let manifests = discover(&plugins_dir);
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

    /// Persist `set` as the activated-plugin ids under [`ACTIVE_KEY`], sorted
    /// so the stored document is deterministic regardless of `HashSet`
    /// iteration order. The one home of the "active set is persisted sorted"
    /// invariant — every mutation of the active set funnels through here.
    /// Callers decide what an `Err` means: `set_active`/`remove` propagate it,
    /// `rescan` deliberately ignores it (a failed persist must not stop the
    /// evicted-ids list from reaching the caller).
    fn persist_active(&self, set: &HashSet<String>) -> Result<(), String> {
        let mut ids: Vec<String> = set.iter().cloned().collect();
        ids.sort();
        storage::save_data(&self.app_data_dir, ACTIVE_KEY, &ids)
    }

    /// Activate or deactivate plugin `id`, persisting the new set. Errors if
    /// the id isn't installed, or (when activating) if the plugin's declared
    /// `minAppVersion` is newer than the running app — activation is the
    /// moment a plugin gets to run, so the compatibility gate must hold here
    /// even for a plugin that skipped `install_dir` (hand-copied + rescan).
    pub fn set_active(&self, id: &str, active: bool) -> Result<(), String> {
        {
            let manifests = self.manifests.lock();
            let manifest = manifests
                .iter()
                .find(|m| m.id == id)
                .ok_or_else(|| format!("unknown plugin {id:?}"))?;
            if active {
                check_min_app_version(manifest, &app_version())?;
            }
        }
        let mut set = self.active.lock();
        if active {
            set.insert(id.to_string());
        } else {
            set.remove(id);
        }
        self.persist_active(&set)
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
        let _ = self.persist_active(&active);
        removed
    }

    /// Absolute path of the folder plugins install into
    /// (`<app_data_dir>/plugins`), for showing the user where to drop them.
    pub fn plugins_dir(&self) -> PathBuf {
        self.app_data_dir.join("plugins")
    }

    /// Copy a plugin from `source` (a directory containing `plugin.json`)
    /// into `plugins_dir/<id>/`, replacing any existing install of the same
    /// id (an install is also an update/reinstall). The manifest is fully
    /// validated against the *destination* id **before** any disk mutation,
    /// and the files are copied into a staging dir that only replaces the
    /// destination once the copy has fully succeeded — so a malformed or
    /// half-copied replacement leaves an existing install of the same id
    /// untouched, on disk and in the registry. Returns the installed id.
    pub fn install_dir(&self, source: &Path) -> Result<String, String> {
        let raw = std::fs::read_to_string(source.join("plugin.json"))
            .map_err(|e| format!("no plugin.json in {source:?}: {e}"))?;
        let id = raw_manifest_id(&raw)?;
        // Validation needs nothing from the copy — reject a bad manifest
        // here, with zero disk mutation.
        let manifest = Manifest::parse_and_validate(&raw, &id).map_err(|e| e.to_string())?;
        // Refuse a plugin that declares it needs a newer app than this one —
        // better a clear "needs app >= X" at install time than an opaque
        // runtime failure after the user has already trusted it in.
        check_min_app_version(&manifest, &app_version())?;
        let dest = self.plugins_dir().join(&id);
        // Stage the copy next to the destination (same filesystem, so the
        // final `rename` is a cheap atomic swap-in). `id` is path-safe
        // ([A-Za-z0-9_-], checked above), and the leading dot keeps a
        // crash-orphaned staging dir from ever validating as a plugin at
        // discovery time (its dir name can't match a manifest id).
        let staging = self
            .plugins_dir()
            .join(format!(".replacing-{id}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&staging);
        let swapped = copy_dir_all(source, &staging)
            .map_err(|e| e.to_string())
            .and_then(|()| {
                // Only now — with a fully validated, fully copied replacement
                // in hand — is the previous install allowed to go away.
                if dest.exists() {
                    std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
                }
                std::fs::rename(&staging, &dest).map_err(|e| e.to_string())
            });
        if let Err(e) = swapped {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
        let mut manifests = self.manifests.lock();
        manifests.retain(|m| m.id != id);
        manifests.push(manifest);
        manifests.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(id)
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
        {
            let mut set = self.active.lock();
            set.remove(id);
            self.persist_active(&set)?;
        }
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
        // Dot-prefixed dirs are never plugins (a manifest id can't start with
        // a dot) — they're install staging dirs or hidden folders. Skip them
        // silently instead of logging a "skipping" error every boot.
        if dir_id.starts_with('.') {
            continue;
        }
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

/// The running app's version, baked in from `Cargo.toml` at compile time.
/// Panic-free in practice: the package version is always valid semver.
fn app_version() -> semver::Version {
    semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("CARGO_PKG_VERSION is valid semver")
}

/// Enforce the manifest's `minAppVersion` compatibility floor against the
/// running app version `app`. The manifest field is already known to be
/// valid semver (checked in `parse_and_validate`); a plugin requiring a
/// newer app is rejected with a message naming both versions, so the user
/// sees "needs app >= X, this is Y" instead of an opaque runtime failure.
fn check_min_app_version(manifest: &Manifest, app: &semver::Version) -> Result<(), String> {
    let min = semver::Version::parse(&manifest.min_app_version)
        .map_err(|e| format!("invalid minAppVersion {:?}: {e}", manifest.min_app_version))?;
    if *app < min {
        return Err(format!(
            "plugin {:?} needs app version {min} or newer, but this app is version {app}",
            manifest.id
        ));
    }
    Ok(())
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

/// Remove crash-orphaned install staging dirs (`.installing-*` /
/// `.replacing-*`) under `plugins_dir`. A crash mid-install leaves its
/// staging dir behind forever otherwise — and a flat-zip staging dir even
/// contains a `plugin.json`, which `discover` used to trip over on every
/// boot. Only call this when no install is in flight (i.e. at startup):
/// sweeping while an install runs would delete its live staging dir.
fn sweep_staging(plugins_dir: &Path) {
    let Ok(read) = std::fs::read_dir(plugins_dir) else {
        return; // dir absent/unreadable -> nothing to sweep
    };
    for dirent in read.flatten() {
        let name = dirent.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".installing-") || name.starts_with(".replacing-") {
            let _ = std::fs::remove_dir_all(dirent.path());
        }
    }
}

/// Ceiling on the *total decompressed* size of a plugin archive. Generous —
/// real plugin zips (a wasm module plus some UI assets) are a few MiB — but
/// it keeps a hostile zip bomb from filling the disk at install time, before
/// any trust decision has been made ("installed" is supposed to be inert).
const MAX_ZIP_TOTAL_BYTES: u64 = 256 * 1024 * 1024; // 256 MiB
/// Ceiling on the number of entries in a plugin archive — a plugin ships a
/// handful of files, not tens of thousands.
const MAX_ZIP_ENTRIES: usize = 4_096;

/// Extract every entry of the zip at `zip_path` under `dest`, rejecting any
/// entry whose path would escape `dest` (a malicious or malformed zip
/// otherwise writing outside the staging dir — "zip slip"), any archive with
/// more than [`MAX_ZIP_ENTRIES`] entries, and any archive that decompresses
/// past [`MAX_ZIP_TOTAL_BYTES`].
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    extract_zip_with_limits(zip_path, dest, MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_BYTES)
}

/// [`extract_zip`] with the entry-count and total-byte ceilings injectable,
/// so tests can exercise the limits without multi-hundred-MiB fixtures.
fn extract_zip_with_limits(
    zip_path: &Path,
    dest: &Path,
    max_entries: usize,
    max_total_bytes: u64,
) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if archive.len() > max_entries {
        return Err(format!(
            "zip has {} entries; a plugin archive may have at most {max_entries}",
            archive.len()
        ));
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    // Bytes of decompressed output still allowed. Decremented as entries are
    // written, so the cap holds across the whole archive, not per entry.
    let mut budget = max_total_bytes;
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
        // Cheap upfront reject on the *declared* size — but headers can lie,
        // so the metered copy below is what actually enforces the cap.
        if entry.size() > budget {
            return Err(format!(
                "zip decompresses past the {max_total_bytes}-byte plugin size limit"
            ));
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out_file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        // Read at most budget+1 bytes: writing budget+1 proves the entry's
        // real size exceeds the remaining allowance regardless of what its
        // header declared, without decompressing unboundedly first.
        let written = std::io::copy(
            &mut std::io::Read::take(&mut entry, budget + 1),
            &mut out_file,
        )
        .map_err(|e| e.to_string())?;
        if written > budget {
            return Err(format!(
                "zip decompresses past the {max_total_bytes}-byte plugin size limit"
            ));
        }
        budget -= written;
    }
    Ok(())
}

/// Shared implementation of [`plugins_install`]: install from a folder or a
/// `.zip`, then evict any cached WASM instance of the (re)installed id. The
/// eviction matters on *re*install — the manager keeps invoked plugins warm,
/// and a warm instance has the old wasm bytes and the old manifest's
/// permission grants baked in; dropping it makes the next invoke load the
/// artifact that is actually on disk now. Returns the installed id.
fn install_and_evict(
    registry: &PluginRegistry,
    manager: &PluginManager,
    path: &Path,
) -> Result<String, String> {
    let is_zip = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
    let id = if is_zip {
        registry.install_zip(path)?
    } else if path.is_dir() {
        registry.install_dir(path)?
    } else {
        return Err(format!("{path:?} is neither a folder nor a .zip file"));
    };
    manager.evict(&id);
    Ok(id)
}

/// Install a plugin dropped onto the Plugins page: `path` is an absolute
/// path to either a plugin folder (containing `plugin.json`) or a `.zip` of
/// one. Returns the fresh installed list on success.
///
/// Async, with the work on a blocking thread: extraction + recursive copy +
/// `remove_dir_all` are heavy filesystem operations, and running them inline
/// (in a sync command) would freeze the whole UI for the duration of a large
/// archive.
#[tauri::command]
pub async fn plugins_install(
    registry: State<'_, std::sync::Arc<PluginRegistry>>,
    manager: State<'_, std::sync::Arc<PluginManager>>,
    path: String,
) -> Result<Vec<PluginEntry>, AppError> {
    let registry = registry.inner().clone();
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<PluginEntry>, String> {
        install_and_evict(&registry, &manager, Path::new(&path))?;
        Ok(registry.list())
    })
    .await
    .map_err(|e| AppError::from(e.to_string()))?
    .map_err(AppError::from)
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
        // Rejected before any disk mutation — no ghost install, no staging.
        assert!(!root.join("plugins/acme").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_reinstall_leaves_the_previous_install_intact() {
        let root = tmp("reinstall-bad");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let source = root.join("src");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("plugin.json"), manifest_json("acme")).unwrap();
        std::fs::write(source.join("a.wasm"), b"v1").unwrap();
        let reg = PluginRegistry::load(&root);
        reg.install_dir(&source).unwrap();
        reg.set_active("acme", true).unwrap();

        // Try to replace it with a malformed manifest (no wasm and no ui ->
        // NoEntryPoint). The docs promise "nothing changes" on a rejected
        // drop — including when the id is already installed.
        let bad = root.join("bad-src");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(
            bad.join("plugin.json"),
            r#"{"id":"acme","name":"acme","version":"2.0.0","minAppVersion":"0.33.0","permissions":[]}"#,
        )
        .unwrap();
        assert!(reg.install_dir(&bad).is_err());

        // The previous good install survives on disk...
        assert!(root.join("plugins/acme/plugin.json").exists());
        assert!(root.join("plugins/acme/a.wasm").exists());
        // ...and in the registry: still listed, still active, still v1.
        let list = reg.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].manifest.version, "1.0.0");
        assert!(list[0].active);
        // No staging leftovers in the plugins dir.
        assert!(std::fs::read_dir(root.join("plugins"))
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().starts_with('.')));
        // A fresh load agrees — disk still has a working acme.
        let ids: Vec<_> = PluginRegistry::load(&root)
            .list()
            .iter()
            .map(|e| e.manifest.id.clone())
            .collect();
        assert_eq!(ids, vec!["acme".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reinstall_evicts_the_cached_wasm_instance() {
        let root = tmp("reinstall-evict");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let source = root.join("src");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("plugin.json"),
            r#"{"id":"swap","name":"swap","version":"1.0.0","minAppVersion":"0.33.0","wasm":"plugin.wasm","permissions":[]}"#,
        )
        .unwrap();
        let testdata = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins/testdata");
        std::fs::copy(testdata.join("echo.wasm"), source.join("plugin.wasm")).unwrap();

        let reg = PluginRegistry::load(&root);
        let mgr = PluginManager::new();
        install_and_evict(&reg, &mgr, &source).unwrap();
        reg.set_active("swap", true).unwrap();
        // First invoke builds the instance and keeps it warm.
        let out =
            manager::run_plugin(&reg, &mgr, &root, "swap", "echo", &serde_json::json!(1)).unwrap();
        assert_eq!(out, serde_json::json!(1));

        // Reinstall with a different artifact. Without the eviction the warm
        // echo instance would keep answering from the old bytes; with it the
        // next invoke loads the new wasm, which has no `echo` export.
        std::fs::copy(testdata.join("kv.wasm"), source.join("plugin.wasm")).unwrap();
        install_and_evict(&reg, &mgr, &source).unwrap();
        assert!(
            manager::run_plugin(&reg, &mgr, &root, "swap", "echo", &serde_json::json!(2)).is_err(),
            "stale cached instance still serving the old wasm"
        );
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
    fn extract_zip_rejects_an_archive_over_the_byte_cap() {
        let root = tmp("zip-byte-cap");
        std::fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("big.zip");
        // Two 40-byte entries against a 64-byte cap: the first fits, the
        // second pushes the *total* over — proving the cap spans the whole
        // archive rather than resetting per entry.
        let chunk = "x".repeat(40);
        write_zip(&zip_path, &[("a.txt", &chunk), ("b.txt", &chunk)]);
        let err = extract_zip_with_limits(&zip_path, &root.join("out"), 100, 64).unwrap_err();
        assert!(err.contains("size limit"), "unexpected error: {err}");
        // A cap that fits both entries succeeds.
        let _ = std::fs::remove_dir_all(root.join("out"));
        extract_zip_with_limits(&zip_path, &root.join("out"), 100, 80).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_zip_rejects_an_archive_over_the_entry_cap() {
        let root = tmp("zip-entry-cap");
        std::fs::create_dir_all(&root).unwrap();
        let zip_path = root.join("many.zip");
        write_zip(&zip_path, &[("a.txt", "a"), ("b.txt", "b"), ("c.txt", "c")]);
        let err = extract_zip_with_limits(&zip_path, &root.join("out"), 2, 1024).unwrap_err();
        assert!(err.contains("entries"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_sweeps_orphaned_staging_dirs_and_discover_skips_dot_dirs() {
        let root = tmp("sweep");
        write_plugin(&root, "acme", &manifest_json("acme"));
        // Simulate installs that crashed mid-flight in *other* processes:
        // their staging dirs (which even contain a plugin.json, in the
        // flat-zip shape) survive under plugins/.
        for stale in [".installing-99999", ".replacing-acme-99999"] {
            let dir = root.join("plugins").join(stale);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("plugin.json"), manifest_json("acme")).unwrap();
        }
        let reg = PluginRegistry::load(&root);
        // The orphans are gone from disk...
        assert!(!root.join("plugins/.installing-99999").exists());
        assert!(!root.join("plugins/.replacing-acme-99999").exists());
        // ...and only the real plugin was discovered.
        let ids: Vec<_> = reg.list().iter().map(|e| e.manifest.id.clone()).collect();
        assert_eq!(ids, vec!["acme".to_string()]);
        // A dot-dir that appears at runtime (e.g. an in-flight staging dir)
        // is silently ignored by discovery, not swept and not listed.
        let live = root.join("plugins").join(".installing-live");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::write(live.join("plugin.json"), manifest_json("acme")).unwrap();
        reg.rescan();
        assert!(
            live.exists(),
            "rescan must not sweep an in-flight staging dir"
        );
        let ids: Vec<_> = reg.list().iter().map(|e| e.manifest.id.clone()).collect();
        assert_eq!(ids, vec!["acme".to_string()]);
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

    /// Recursively collect every file under `root` whose name starts with
    /// `prefix` — proves a zip-slip payload never lands anywhere on disk,
    /// not just at the exact traversal target.
    fn find_files_starting_with(root: &Path, prefix: &str) -> Vec<PathBuf> {
        let mut hits = Vec::new();
        let Ok(entries) = std::fs::read_dir(root) else {
            return hits;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                hits.extend(find_files_starting_with(&path, prefix));
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(prefix))
            {
                hits.push(path);
            }
        }
        hits
    }

    /// `enclosed_name()` rejects any entry whose path climbs out of the
    /// staging dir with a parent-dir component — pin that a `../` traversal
    /// entry is rejected outright and nothing it names is ever written
    /// anywhere under the app data dir.
    #[test]
    fn install_zip_rejects_a_parent_dir_traversal_entry() {
        let root = tmp("zip-slip-parent");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let zip_path = root.join("evil.zip");
        write_zip(&zip_path, &[("../evil-parent-636.txt", "pwned")]);
        let reg = PluginRegistry::load(&root);
        let err = reg.install_zip(&zip_path).unwrap_err();
        assert!(err.contains("unsafe path"), "unexpected error: {err}");
        assert!(find_files_starting_with(&std::env::temp_dir(), "evil-parent-636").is_empty());
        // No leftover staging dir.
        assert!(std::fs::read_dir(root.join("plugins"))
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().starts_with(".installing-")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Same guard, but the traversal is buried under a normal-looking
    /// leading component (`nested/../../evil2.txt`) — `enclosed_name()`'s
    /// depth counter must still catch it going negative rather than only
    /// checking for a leading `..`.
    #[test]
    fn install_zip_rejects_a_nested_traversal_entry() {
        let root = tmp("zip-slip-nested");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let zip_path = root.join("evil-nested.zip");
        write_zip(&zip_path, &[("nested/../../evil-nested-636.txt", "pwned")]);
        let reg = PluginRegistry::load(&root);
        let err = reg.install_zip(&zip_path).unwrap_err();
        assert!(err.contains("unsafe path"), "unexpected error: {err}");
        assert!(find_files_starting_with(&std::env::temp_dir(), "evil-nested-636").is_empty());
        assert!(std::fs::read_dir(root.join("plugins"))
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().starts_with(".installing-")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Same guard against an absolute-path entry name. `zip::write` doesn't
    /// sanitize the name it's given (only `enclosed_name()` on the read side
    /// does), so a leading `/` round-trips into the archive unmodified and
    /// exercises the same `Component::RootDir => return None` branch as a
    /// real hostile archive built by a non-Rust tool would.
    #[test]
    fn install_zip_rejects_an_absolute_path_entry() {
        let root = tmp("zip-slip-abs");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let zip_path = root.join("evil-abs.zip");
        write_zip(&zip_path, &[("/evil-abs-636.txt", "pwned")]);
        let reg = PluginRegistry::load(&root);
        let err = reg.install_zip(&zip_path).unwrap_err();
        assert!(err.contains("unsafe path"), "unexpected error: {err}");
        assert!(find_files_starting_with(&std::env::temp_dir(), "evil-abs-636").is_empty());
        assert!(std::fs::read_dir(root.join("plugins"))
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().starts_with(".installing-")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A zip whose `plugin.json` is otherwise well-formed but which also
    /// carries one traversal entry must reject the *whole* install (not
    /// just skip the bad entry) and leave no orphan staging dir behind —
    /// `install_zip` always sweeps its staging dir on the way out, success
    /// or failure, but this pins that the failure path doesn't skip it.
    #[test]
    fn install_zip_rejects_the_whole_archive_when_one_entry_traverses() {
        let root = tmp("zip-slip-combo");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let zip_path = root.join("evil-combo.zip");
        write_zip(
            &zip_path,
            &[
                ("plugin.json", &manifest_json("combo")),
                ("a.wasm", "fake"),
                ("../evil-combo-636.txt", "pwned"),
            ],
        );
        let reg = PluginRegistry::load(&root);
        let err = reg.install_zip(&zip_path).unwrap_err();
        assert!(err.contains("unsafe path"), "unexpected error: {err}");
        // The well-formed plugin.json in the same archive didn't get a
        // partial install — nothing landed under plugins/combo at all.
        assert!(reg.list().is_empty());
        assert!(!root.join("plugins/combo").exists());
        assert!(find_files_starting_with(&std::env::temp_dir(), "evil-combo-636").is_empty());
        // No orphan staging dir left behind.
        assert!(std::fs::read_dir(root.join("plugins"))
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().starts_with(".installing-")));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A manifest identical to [`manifest_json`] but with a chosen
    /// `minAppVersion`.
    fn manifest_json_min_app(id: &str, min_app: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"{id}","version":"1.0.0","minAppVersion":"{min_app}","wasm":"a.wasm","permissions":[]}}"#
        )
    }

    #[test]
    fn min_app_version_check_rejects_newer_and_passes_equal_or_older() {
        let app = semver::Version::parse("0.44.0").unwrap();
        let manifest = |min: &str| {
            Manifest::parse_and_validate(&manifest_json_min_app("acme", min), "acme").unwrap()
        };
        // Requires a newer app -> rejected, naming both versions.
        let err = check_min_app_version(&manifest("99.0.0"), &app).unwrap_err();
        assert!(err.contains("99.0.0"), "missing required version: {err}");
        assert!(err.contains("0.44.0"), "missing app version: {err}");
        // Equal and older both pass.
        check_min_app_version(&manifest("0.44.0"), &app).unwrap();
        check_min_app_version(&manifest("0.33.0"), &app).unwrap();
    }

    #[test]
    fn install_rejects_a_plugin_requiring_a_newer_app() {
        let root = tmp("min-app-install");
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        let source = root.join("src");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("plugin.json"),
            manifest_json_min_app("future", "99.0.0"),
        )
        .unwrap();
        std::fs::write(source.join("a.wasm"), b"fake").unwrap();

        let reg = PluginRegistry::load(&root);
        let err = reg.install_dir(&source).unwrap_err();
        assert!(err.contains("99.0.0"), "unexpected error: {err}");
        assert!(
            err.contains(env!("CARGO_PKG_VERSION")),
            "error must name the running app version: {err}"
        );
        // Rejected before any disk mutation — nothing installed.
        assert!(reg.list().is_empty());
        assert!(!root.join("plugins/future").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn activation_rejects_a_plugin_requiring_a_newer_app() {
        let root = tmp("min-app-activate");
        // Hand-copied into plugins/ (bypassing install_dir), then discovered —
        // the activation gate has to catch it.
        write_plugin(&root, "future", &manifest_json_min_app("future", "99.0.0"));
        let reg = PluginRegistry::load(&root);
        assert_eq!(reg.list().len(), 1);
        let err = reg.set_active("future", true).unwrap_err();
        assert!(err.contains("99.0.0"), "unexpected error: {err}");
        assert!(!reg.is_active("future"));
        // Deactivating never needs the gate (turning a plugin *off* must
        // always work, even on an app it no longer supports).
        reg.set_active("future", false).unwrap();
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
