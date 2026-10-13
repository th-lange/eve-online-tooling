//! DPS meter — a live combat meter modelled on PyEveLiveDPS.
//!
//! Tails EVE's per-session gamelog, parses each combat line into a typed event
//! ([`parser`]), and emits a rolling per-second [`aggregate::DpsTick`] over the
//! `dps://tick` event for the UI to graph. EULA-safe: it only reads the logs the
//! client already writes (same source as `localintel`).
//!
//! - [`parser`] — pure combat-line → [`parser::DpsEvent`].
//! - [`aggregate`] — pure rolling-window → [`aggregate::DpsTick`].
//! - [`bucket`] — pure fixed-grid fold → epoch-aligned 5 s [`bucket::DpsBucket`]s
//!   (`dps://buckets`), the time axis the detail charts draw on (#983).
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
