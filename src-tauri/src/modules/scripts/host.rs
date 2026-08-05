//! The curated host API a script may call.
//!
//! Scripts are **trusted** (the user wrote them), so — unlike plugins — they get
//! a real API rather than a capability sandbox: read market prices and the SDE,
//! read the active character's assets, fire a desktop notification, keep a
//! private key/value store, and `log()`. There is deliberately **no** access to
//! the filesystem, keychain, or raw ESI tokens.
//!
//! Every method is synchronous so both engines can call it inline; the ones
//! that reach async services (`market`, ESI) drive them to completion with
//! [`tauri::async_runtime::block_on`], exactly like the MCP bridge does. Because
//! that blocks, a run is only ever executed on a blocking thread (see
//! [`super::commands::scripts_run`]).

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::esi::AuthState;
use crate::market::MarketService;

use super::store;

/// Most `log()` lines kept per run (a chatty loop can't grow unbounded).
const MAX_LOG_LINES: usize = 500;
/// Longest single `log()` line kept (longer lines are truncated).
const MAX_LOG_LINE_LEN: usize = 2000;
/// Largest sound file `play_sound` will load and hand to the webview.
const MAX_SOUND_BYTES: u64 = 25 * 1024 * 1024;

/// Payload of the `scripts://play-sound` event: a base64 data URL's parts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaySound {
    pub mime: String,
    pub data: String,
}

/// The curated API surface a script can call. Abstracted behind a trait so the
/// engines can be exercised in tests with a fake host (no Tauri `AppHandle`).
pub trait Host: Send + Sync {
    /// Append a line to this run's log.
    fn log(&self, line: String);
    /// Drain the accumulated log lines (called once the run finishes).
    fn take_logs(&self) -> Vec<String>;
    /// Fire a desktop notification.
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
    /// Multi-vector price model for a type at a region (default Jita), as JSON.
    fn market_price(&self, type_id: i64, region_id: Option<i64>) -> Result<Value, String>;
    /// A type's SDE info as JSON, or `null` if unknown.
    fn sde_type_info(&self, type_id: i64) -> Result<Value, String>;
    /// The active character's assets as a JSON array.
    fn assets(&self) -> Result<Value, String>;
    /// The character's corporation assets as a JSON array (empty without the
    /// role/scope).
    fn corp_assets(&self) -> Result<Value, String>;
    /// The logged-in character(s) open market orders as JSON, each flagged with
    /// `undercut` and the best competing price (`bestPrice`).
    fn my_orders(&self) -> Result<Value, String>;
    /// Read a value from this script's private store (`""` when unset).
    fn kv_get(&self, key: &str) -> Result<String, String>;
    /// Write a value to this script's private store.
    fn kv_set(&self, key: &str, value: &str) -> Result<(), String>;
    /// Play a local audio file through the app (async, fire-and-forget).
    fn play_sound(&self, path: &str) -> Result<(), String>;
    /// Post a high-severity alarm to the Info Panel, with an optional detail body.
    fn send_alarm(&self, text: &str, detail: Option<&str>) -> Result<(), String>;
    /// Post a plain text message to the Info Panel, with an optional detail body.
    fn write_message(&self, text: &str, detail: Option<&str>) -> Result<(), String>;
    /// Invoke any registry capability by name (the generic gateway — reaches
    /// every module read/compute op the registry offers).
    fn call(&self, name: &str, args: &Value) -> Result<Value, String>;
}

/// Everything a real (app-backed) script's host calls are allowed to touch,
/// shared (cheaply cloned) into each engine's bound functions.
#[derive(Clone)]
pub struct HostCtx {
    app: AppHandle,
    app_data_dir: PathBuf,
    script_id: String,
    logs: Arc<Mutex<Vec<String>>>,
}

impl HostCtx {
    pub fn new(app: AppHandle, app_data_dir: PathBuf, script_id: String) -> Self {
        Self {
            app,
            app_data_dir,
            script_id,
            logs: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Append to the Info Panel feed and emit the entry so the panel updates
    /// live (the store is the source of truth; the event is a nicety).
    fn post_info(
        &self,
        kind: crate::info::Kind,
        text: &str,
        detail: Option<&str>,
    ) -> Result<(), String> {
        let source = format!("script:{}", self.script_id);
        let entry = crate::info::push(&self.app_data_dir, kind, text, detail, &source);
        let _ = self.app.emit("info://entry", entry);
        Ok(())
    }

    /// Run a registry capability with the app's managed services (warm caches).
    fn cap(&self, name: &str, args: &serde_json::Value) -> Result<Value, String> {
        let market = self.app.state::<MarketService>();
        let auth = self.app.state::<AuthState>();
        let ctx = crate::capabilities::HostCtx {
            app_data_dir: &self.app_data_dir,
            market: &market,
            auth: Some(&auth),
        };
        crate::capabilities::invoke(&ctx, name, args)
    }
}

impl Host for HostCtx {
    fn log(&self, line: String) {
        let mut logs = self.logs.lock();
        if logs.len() >= MAX_LOG_LINES {
            return;
        }
        let mut line = line;
        // Char-boundary-safe: scripts log arbitrary unicode; a plain
        // `String::truncate` panics mid-character.
        crate::util::text::truncate_to_char_boundary(&mut line, MAX_LOG_LINE_LEN);
        logs.push(line);
    }

    fn take_logs(&self) -> Vec<String> {
        std::mem::take(&mut *self.logs.lock())
    }

    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }

    fn market_price(&self, type_id: i64, region_id: Option<i64>) -> Result<Value, String> {
        let mut args = serde_json::json!({ "typeId": type_id });
        if let Some(region) = region_id {
            args["regionId"] = serde_json::json!(region);
        }
        self.cap("market_price", &args)
    }

    fn sde_type_info(&self, type_id: i64) -> Result<Value, String> {
        self.cap("sde_type_info", &serde_json::json!({ "typeId": type_id }))
    }

    fn assets(&self) -> Result<Value, String> {
        self.cap("assets", &serde_json::Value::Null)
    }

    fn corp_assets(&self) -> Result<Value, String> {
        self.cap("corp_assets", &serde_json::Value::Null)
    }

    fn my_orders(&self) -> Result<Value, String> {
        self.cap("my_orders", &serde_json::Value::Null)
    }

    fn kv_get(&self, key: &str) -> Result<String, String> {
        store::kv_get(&self.app_data_dir, &self.script_id, key)
    }

    fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        store::kv_set(&self.app_data_dir, &self.script_id, key, value)
    }

    fn play_sound(&self, path: &str) -> Result<(), String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
        if meta.len() > MAX_SOUND_BYTES {
            return Err(format!("sound file too large (> {MAX_SOUND_BYTES} bytes)"));
        }
        let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        let mime = mime_for(path);
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        self.app
            .emit("scripts://play-sound", PlaySound { mime, data })
            .map_err(|e| e.to_string())
    }

    fn send_alarm(&self, text: &str, detail: Option<&str>) -> Result<(), String> {
        self.post_info(crate::info::Kind::Alarm, text, detail)
    }

    fn write_message(&self, text: &str, detail: Option<&str>) -> Result<(), String> {
        self.post_info(crate::info::Kind::Message, text, detail)
    }

    fn call(&self, name: &str, args: &Value) -> Result<Value, String> {
        self.cap(name, args)
    }
}

/// Guess an audio MIME type from a file extension (defaults to MPEG).
fn mime_for(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/aac",
        "webm" => "audio/webm",
        _ => "audio/mpeg",
    }
    .to_string()
}
