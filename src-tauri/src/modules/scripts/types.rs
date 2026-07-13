//! Shared types for the Scripts module.
//!
//! A [`Script`] is a small, user-authored snippet — Rhai or JavaScript — that
//! is persisted verbatim and run on demand or on a timed loop (the loop lives
//! in the frontend). Running one yields a [`ScriptRun`].

use serde::{Deserialize, Serialize};

/// Which embedded engine runs a snippet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    /// Rhai — the Rust-native scripting language.
    Rhai,
    /// JavaScript — executed by the `boa` engine.
    Js,
}

/// One stored snippet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    /// Stable slug id; assigned from the name on first save if empty.
    #[serde(default)]
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// The engine this snippet targets.
    pub language: Language,
    /// The snippet source.
    #[serde(default)]
    pub code: String,
    /// Loop interval in **minutes**; `None` means "run manually only". The
    /// background scheduler re-runs the script every this-many minutes.
    #[serde(default)]
    pub interval_min: Option<u64>,
    /// Whether the timed loop is armed ("Run" state — only meaningful with
    /// `interval_min`). The Rust scheduler retriggers every enabled script.
    #[serde(default)]
    pub enabled: bool,
    /// Epoch seconds of the last save (bookkeeping / sort key).
    #[serde(default)]
    pub updated_at: u64,
}

/// The outcome of one execution: its return value, captured `log()` output,
/// and either success or a human-readable error — plus how long it took.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRun {
    /// True when the snippet ran to completion without throwing.
    pub ok: bool,
    /// The snippet's return value as JSON (`null` when it returned nothing).
    pub result: serde_json::Value,
    /// Lines emitted via the host `log()` function, in order.
    pub logs: Vec<String>,
    /// The failure message when `ok` is false, else `None`.
    pub error: Option<String>,
    /// Wall-clock duration of the run in milliseconds.
    pub duration_ms: u64,
}
