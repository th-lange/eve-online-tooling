//! Static Data Export (SDE) service.
//!
//! The SDE is the offline source of truth for "what a blueprint produces and
//! what it costs in materials". On first run we download the Fuzzwork prebuilt
//! SQLite SDE, decompress it into the app data dir, and query it read-only.
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

pub use db::Sde;
pub use download::download_sde;
pub use error::SdeError;

use std::path::PathBuf;

/// Fuzzwork's prebuilt, bz2-compressed SQLite conversion of the SDE.
pub const SDE_URL: &str = "https://www.fuzzwork.co.uk/dump/sqlite-latest.sqlite.bz2";

/// Resolved on-disk locations for the SDE under the app data dir.
///
/// Downloads land on `*.part` siblings and are renamed into place only after
/// verification, so an interrupted update never corrupts a working database.
#[derive(Debug, Clone)]
pub struct SdePaths {
    pub dir: PathBuf,
    pub db: PathBuf,
    pub tmp_bz2: PathBuf,
    pub tmp_db: PathBuf,
}

impl SdePaths {
    /// Build paths under `<app_data_dir>/sde/`.
    pub fn new(app_data_dir: PathBuf) -> Self {
        let dir = app_data_dir.join("sde");
        Self {
            db: dir.join("sde.sqlite"),
            tmp_bz2: dir.join("sde.sqlite.bz2.part"),
            tmp_db: dir.join("sde.sqlite.part"),
            dir,
        }
    }

    pub fn is_installed(&self) -> bool {
        self.db.exists()
    }
}
