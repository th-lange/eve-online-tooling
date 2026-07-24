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
/// Design note (#556 → #720): the generation-keyed caches below
/// ([`cached_system_info`] / [`cached_adjacency`]) now serve the route and
/// wormholes hot paths. Remaining full-map call sites (pochven/pi/intel
/// planners, `capabilities.rs`) can switch to them as they're touched.
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

// --- Generation-keyed caches for the two big whole-universe maps (#720) ---
//
// These maps are immutable between SDE swaps but were reloaded from SQLite on
// every command invocation — hot on the route/wormholes paths, where location
// polling re-read ~5k system rows and the full jump table every 30s. Each map
// is cached process-wide, keyed by the database file's identity; a successful
// [`download_sde`] swap changes that identity and transparently invalidates.
// Other full-map call sites (pochven/pi/intel planners, capabilities) can
// adopt these getters as they're touched.

/// System id → (name, security, region name).
pub type SystemInfoMap = std::collections::HashMap<i64, (String, f64, String)>;
/// Undirected stargate adjacency, system id → neighbouring system ids.
pub type AdjacencyMap = std::collections::HashMap<i64, Vec<i64>>;

/// Identity of the SDE database file: (mtime seconds, byte size). Changes
/// exactly when a new database is swapped into place.
type Generation = (u64, u64);

/// One cached map slot: the generation it was built for + the shared value.
type CacheSlot<T> = std::sync::RwLock<Option<(Generation, std::sync::Arc<T>)>>;

fn generation(db: &Path) -> Result<Generation, String> {
    let meta = std::fs::metadata(db).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    Ok((mtime, meta.len()))
}

/// Serve `slot`'s value while its generation matches; (re)build otherwise.
/// Pure over its inputs (testable without an SDE on disk).
fn get_or_build<T: Clone>(
    slot: &std::sync::RwLock<Option<(Generation, T)>>,
    generation: Generation,
    build: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if let Some((g, v)) = slot.read().expect("sde cache lock").as_ref() {
        if *g == generation {
            return Ok(v.clone());
        }
    }
    let v = build()?;
    *slot.write().expect("sde cache lock") = Some((generation, v.clone()));
    Ok(v)
}

/// The full system-info map, served from the process-wide cache.
pub fn cached_system_info(dir: &Path) -> Result<std::sync::Arc<SystemInfoMap>, String> {
    static SLOT: std::sync::OnceLock<CacheSlot<SystemInfoMap>> = std::sync::OnceLock::new();
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(
        SLOT.get_or_init(|| std::sync::RwLock::new(None)),
        generation,
        || {
            let sde = open_from_dir(dir)?;
            Ok(std::sync::Arc::new(
                sde.solar_system_info().map_err(|e| e.to_string())?,
            ))
        },
    )
}

/// The full stargate adjacency, served from the process-wide cache.
pub fn cached_adjacency(dir: &Path) -> Result<std::sync::Arc<AdjacencyMap>, String> {
    static SLOT: std::sync::OnceLock<CacheSlot<AdjacencyMap>> = std::sync::OnceLock::new();
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(
        SLOT.get_or_init(|| std::sync::RwLock::new(None)),
        generation,
        || {
            let sde = open_from_dir(dir)?;
            Ok(std::sync::Arc::new(
                sde.stargate_adjacency().map_err(|e| e.to_string())?,
            ))
        },
    )
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn get_or_build_serves_cache_until_the_generation_changes() {
        let slot = std::sync::RwLock::new(None);
        let mut builds = 0;

        let v = get_or_build(&slot, (1, 10), || {
            builds += 1;
            Ok::<_, String>(42)
        })
        .unwrap();
        assert_eq!(v, 42);

        // Same generation → cached value, no rebuild.
        let v = get_or_build(&slot, (1, 10), || {
            builds += 1;
            Ok(7)
        })
        .unwrap();
        assert_eq!(v, 42);
        assert_eq!(builds, 1);

        // A swapped database (new generation) rebuilds.
        let v = get_or_build(&slot, (2, 10), || {
            builds += 1;
            Ok(7)
        })
        .unwrap();
        assert_eq!(v, 7);
        assert_eq!(builds, 2);
    }
}
