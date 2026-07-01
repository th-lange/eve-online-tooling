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
mod types;

pub use db::{wormhole_class_label, Sde};
pub use download::download_sde;
pub use error::SdeError;
pub use types::{
    BlueprintMaterial, BlueprintProduct, Decryptor, EffectMeta, ModifierInfo, PlanetSchematic,
    Recipe, ReprocessRecipe, ShipLayout, WormholeType,
};
// `AttrMeta` is reached through `attribute_defaults`'s return type today; it'll
// be re-exported when the stat calculators name it (#172).

use std::path::PathBuf;

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
