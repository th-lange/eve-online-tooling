use std::sync::Arc;
use tauri::State;

use super::{LogEntry, LogStore};

/// All captured backend log entries, oldest first.
#[tauri::command]
pub fn logs_list(store: State<'_, Arc<LogStore>>) -> Vec<LogEntry> {
    store
        .entries
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .cloned()
        .collect()
}

/// Clear all captured backend log entries.
#[tauri::command]
pub fn logs_clear(store: State<'_, Arc<LogStore>>) {
    store
        .entries
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
}
