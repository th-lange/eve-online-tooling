//! DPS meter — a live combat meter modelled on PyEveLiveDPS.
//!
//! Tails EVE's per-session gamelog, parses each combat line into a typed event
//! ([`parser`]), folds events onto a fixed, epoch-aligned 5 s grid, and emits
//! the finalized [`bucket::DpsBucket`]s over the `dps://buckets` event for the
//! UI to chart (#982). EULA-safe: it only reads the logs the client already
//! writes (same source as `localintel`).
//!
//! - [`parser`] — pure combat-line → [`parser::DpsEvent`].
//! - [`aggregate`] — shared breakdown row types ([`aggregate::WeaponRate`],
//!   [`aggregate::PilotRate`], [`aggregate::HitQuality`]) the buckets carry.
//! - [`bucket`] — pure fixed-grid fold → epoch-aligned 5 s [`bucket::DpsBucket`]s
//!   (`dps://buckets`), the time axis every chart draws on (#983).
//! - [`overview`] — the fixed 1-minute segment grid for the playback timeline.
//! - [`commands`] — the Tauri command surface + the background tail loop.

pub mod aggregate;
pub mod bucket;
pub mod commands;
pub mod overview;
pub mod parser;

/// Register this module's managed state with the app.
pub fn init(app: &tauri::App) {
    use tauri::Manager;
    app.manage(commands::DpsState::default());
}
