//! Static Data Export (SDE) service.
//!
//! The SDE is the offline source of truth for "what a blueprint produces and
//! what it costs in materials". On first run we download the Fuzzwork prebuilt
//! SQLite SDE (gzip), decompress it into the app data dir, and query it
//! read-only.
//!
//! - [`download_sde`] — fetch + decompress + verify + atomically swap into place
//! - [`Sde`]          — a read-only connection with typed query helpers
//! - [`commands`]     — the Tauri command surface (status / update / queries)
//!
//! Tracking: issue #2. The query helpers feed the production engine (issue #6).

pub mod commands;
mod db;
mod download;
mod error;
pub mod graph;
mod types;

#[cfg(test)]
pub(crate) use db::test_sde;
pub use db::{wormhole_class_label, Sde};
pub use download::download_sde;
pub use error::SdeError;
pub use types::{
    AttrMeta, BlueprintMaterial, BlueprintProduct, Decryptor, EffectMeta, ModifierInfo,
    PlanetSchematic, Recipe, ReprocessRecipe, ShipLayout, WormholeType,
};

use std::path::{Path, PathBuf};

use crate::storage;

/// Fuzzwork's prebuilt, gzip-compressed SQLite conversion of the SDE.
pub const SDE_URL: &str = "https://www.fuzzwork.co.uk/dump/latest-sqlite.db.gz";

/// Resolved on-disk locations for the SDE under the app data dir.
///
/// Downloads land on `*.part` siblings and are renamed into place only after
/// verification, so an interrupted update never corrupts a working database.
#[derive(Debug, Clone)]
pub struct SdePaths {
    pub dir: PathBuf,
    pub db: PathBuf,
    pub tmp_archive: PathBuf,
    pub tmp_db: PathBuf,
}

impl SdePaths {
    /// Build paths under `<app_data_dir>/sde/`.
    pub fn new(app_data_dir: PathBuf) -> Self {
        let dir = app_data_dir.join("sde");
        Self {
            db: dir.join("sde.sqlite"),
            tmp_archive: dir.join("sde.db.gz.part"),
            tmp_db: dir.join("sde.sqlite.part"),
            dir,
        }
    }

    pub fn is_installed(&self) -> bool {
        self.db.exists()
    }
}

/// Open the SDE for the app's data dir. The dir/SDE-open plumbing was
/// otherwise copy-pasted identically across every command module.
///
/// Design note (#556): several call sites (route/pochven/wormholes/intel/pi
/// planners, `capabilities.rs`) still load the *entire* `solar_system_info`
/// or `all_stargate_edges` map on every command invocation just to read one
/// or a handful of entries. Those maps are immutable between SDE swaps, so a
/// shared cache is feasible: a `OnceLock<RwLock<HashMap<...>>>` (or
/// tauri-managed state) keyed by the SDE's generation — e.g. the `db` file's
/// mtime/size, or a monotonic counter bumped by [`download_sde`] on a
/// successful swap — with the cache cleared/repopulated whenever that key
/// changes. Deferred out of #556's scope (which is the `market_current_location`
/// point-query fix); worth picking up if profiling shows the full-map loads
/// actually cost something in practice.
pub fn open_from_app(app: &tauri::AppHandle) -> Result<Sde, String> {
    let dir = storage::app_data_dir(app)?;
    open_from_dir(&dir)
}

/// Like [`open_from_app`], but for callers that already resolved the app data
/// dir (or have no `AppHandle` at all, e.g. the plugin broker). This is the
/// one place that knows "an app data dir + [`SdePaths`] = an openable SDE",
/// so call sites don't each rebuild that plumbing by hand.
pub fn open_from_dir(dir: &Path) -> Result<Sde, String> {
    Sde::open(&SdePaths::new(dir.to_path_buf()).db).map_err(|e| e.to_string())
}

/// Like [`open_from_app`], but also returns the resolved app data dir for
/// callers that need both (e.g. to load a store alongside the SDE lookups).
pub fn dir_and_sde(app: &tauri::AppHandle) -> Result<(PathBuf, Sde), String> {
    let dir = storage::app_data_dir(app)?;
    let sde = open_from_dir(&dir)?;
    Ok((dir, sde))
}
