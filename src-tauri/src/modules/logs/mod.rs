//! In-memory rolling log of WARN/ERROR records from the Rust backend,
//! accessible via `logs_list` / `logs_clear` Tauri commands and pushed
//! live to the frontend as `logs://entry` events.

pub mod commands;
pub mod layer;

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

/// Max entries kept in memory (ring buffer).
pub const CAPACITY: usize = 500;

/// One captured log record.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: u64,
    /// Unix timestamp in milliseconds.
    pub ts: u64,
    /// "error" | "warn"
    pub level: &'static str,
    /// Rust module path (tracing target).
    pub target: String,
    pub message: String,
}

/// Shared state stored in Tauri app state.
pub struct LogStore {
    pub entries: Mutex<VecDeque<LogEntry>>,
    pub next_id: Mutex<u64>,
}

impl LogStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(VecDeque::with_capacity(CAPACITY)),
            next_id: Mutex::new(0),
        })
    }

    /// Append an entry, evicting the oldest when at capacity. Returns the
    /// entry so the caller can emit it as a Tauri event.
    pub fn push(&self, level: &'static str, target: &str, message: String) -> LogEntry {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let id = {
            let mut n = self.next_id.lock().unwrap_or_else(|e| e.into_inner());
            let id = *n;
            *n += 1;
            id
        };
        let entry = LogEntry {
            id,
            ts,
            level,
            target: target.to_owned(),
            message,
        };
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= CAPACITY {
            entries.pop_front();
        }
        entries.push_back(entry.clone());
        entry
    }
}
