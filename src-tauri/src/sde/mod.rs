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
pub use db::{wormhole_class_label, Sde, SystemGeo};
pub use download::download_sde;
pub use error::SdeError;
pub use types::{
    AttrMeta, BlueprintMaterial, BlueprintProduct, Decryptor, EffectMeta, ItemMeta, ModifierInfo,
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
/// Design note (#556 → #720 → #758): the generation-keyed caches below
/// serve every remaining whole-table SDE call site — system info,
/// adjacency, positions, geo, system/group/category/meta-group names.
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

// --- Generation-keyed caches for the whole-universe / whole-catalogue SDE
// tables (#720, #758) ---
//
// These maps and name catalogues are immutable between SDE swaps but were
// reloaded from SQLite on every command invocation — hot on routing,
// pochven/FW map, PI/mining/fleet, and trading/production paths, several of
// which re-scanned ~50k-row `invTypes` joins per call. Each is cached
// process-wide, keyed by the database file's identity; a successful
// [`download_sde`] swap changes that identity and transparently invalidates
// every slot below.

/// System id → (name, security, region name).
pub type SystemInfoMap = std::collections::HashMap<i64, (String, f64, String)>;
/// Undirected stargate adjacency, system id → neighbouring system ids.
pub type AdjacencyMap = std::collections::HashMap<i64, Vec<i64>>;
/// Raw stargate edges `(from, to)` — the list form some callers filter
/// before building adjacency (e.g. a high-sec-only route).
pub type StargateEdges = Vec<(i64, i64)>;
/// Type id → full item metadata (name, volume, category, group, meta group).
pub type ItemMetaMap = std::collections::HashMap<i64, ItemMeta>;
/// Galactic map-plane coordinates `(x, z)` for every solar system.
pub type PositionsMap = std::collections::HashMap<i64, (f64, f64)>;
/// Full 3D galactic coordinates `(regionID, x, y, z)` per solar system.
pub type GeoMap = std::collections::HashMap<i64, SystemGeo>;
/// Type/system id → plain name (system names, group/category/meta-group
/// names — every id-keyed name lookup the generation cache serves).
pub type NameMap = std::collections::HashMap<i64, String>;
/// Effect id → static dogma effect metadata (category, modifier info, …).
pub type EffectMetaMap = std::collections::HashMap<i64, EffectMeta>;
/// Attribute id → its default value + stacking metadata.
pub type AttrDefaultsMap = std::collections::HashMap<i64, AttrMeta>;

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

/// The raw stargate edge list, served from the process-wide cache. Distinct
/// from [`cached_adjacency`]: callers that filter edges before building
/// adjacency (e.g. market's high-sec-only routing) need the flat list.
pub fn cached_stargate_edges(dir: &Path) -> Result<std::sync::Arc<StargateEdges>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<StargateEdges>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.all_stargate_edges().map_err(|e| e.to_string())?,
        ))
    })
}

/// The full item-metadata catalogue (every `invTypes` row, published or
/// not — see [`db::Sde::all_item_meta`]), served from the process-wide
/// cache. One shared, generation-keyed map: every caller — a character's
/// personal hangar, a corp's hangar, fitting, market, … — resolves names off
/// the *same* build, so a non-market type (e.g. a corp Office, typeID 27)
/// never falls back to `Type <id>` just because one caller's query happened
/// to filter to tradeable items only.
pub fn cached_item_meta(dir: &Path) -> Result<std::sync::Arc<ItemMetaMap>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<ItemMetaMap>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.all_item_meta().map_err(|e| e.to_string())?,
        ))
    })
}

/// Galactic map-plane positions for every solar system, served from the
/// process-wide cache. Backs the pochven/FW map layouts (#758).
pub fn cached_positions(dir: &Path) -> Result<std::sync::Arc<PositionsMap>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<PositionsMap>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.solar_system_positions().map_err(|e| e.to_string())?,
        ))
    })
}

/// Full 3D galactic coordinates for every solar system, served from the
/// process-wide cache. Backs true light-year distance filters (#758).
pub fn cached_geo(dir: &Path) -> Result<std::sync::Arc<GeoMap>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<GeoMap>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.solar_system_geo().map_err(|e| e.to_string())?,
        ))
    })
}

/// System id → name, served from the process-wide cache. Backs mining
/// ledger / fleet / hangar location labelling (#758).
pub fn cached_system_names(dir: &Path) -> Result<std::sync::Arc<NameMap>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<NameMap>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.system_names().map_err(|e| e.to_string())?,
        ))
    })
}

/// Type id → group name, served from the process-wide cache. The
/// `invTypes` ⋈ `invGroups` join is ~50k rows; trading/daytrading/production
/// all classify every row against it (#758).
pub fn cached_group_names(dir: &Path) -> Result<std::sync::Arc<NameMap>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<NameMap>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.group_names().map_err(|e| e.to_string())?,
        ))
    })
}

/// Type id → category name, served from the process-wide cache. See
/// [`cached_group_names`] — same join shape, same hot callers (#758).
pub fn cached_category_names(dir: &Path) -> Result<std::sync::Arc<NameMap>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<NameMap>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.category_names().map_err(|e| e.to_string())?,
        ))
    })
}

/// Type id → meta group name (Tech II, Faction, …), served from the
/// process-wide cache. See [`cached_group_names`] (#758).
pub fn cached_meta_group_names(dir: &Path) -> Result<std::sync::Arc<NameMap>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<NameMap>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.meta_group_names().map_err(|e| e.to_string())?,
        ))
    })
}

/// Static dogma effect metadata (every `dgmEffects` row, `modifierInfo` JSON
/// pre-parsed), served from the process-wide cache. Backs the fitting
/// module's dogma-context preload, which otherwise re-scanned and
/// re-parsed this table on every simulate/module-info/optimize call (#761).
pub fn cached_effect_meta(dir: &Path) -> Result<std::sync::Arc<EffectMetaMap>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<EffectMetaMap>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.effect_meta().map_err(|e| e.to_string())?,
        ))
    })
}

/// Static attribute default values + stacking metadata (every
/// `dgmAttributeTypes` row), served from the process-wide cache. See
/// [`cached_effect_meta`] (#761).
pub fn cached_attribute_defaults(dir: &Path) -> Result<std::sync::Arc<AttrDefaultsMap>, String> {
    static SLOT: std::sync::LazyLock<CacheSlot<AttrDefaultsMap>> =
        std::sync::LazyLock::new(|| std::sync::RwLock::new(None));
    let generation = generation(&SdePaths::new(dir.to_path_buf()).db)?;
    get_or_build(&SLOT, generation, || {
        let sde = open_from_dir(dir)?;
        Ok(std::sync::Arc::new(
            sde.attribute_defaults().map_err(|e| e.to_string())?,
        ))
    })
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
