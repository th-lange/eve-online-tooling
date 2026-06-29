//! DPS meter — tail the active EVE gamelog and stream live per-second rates.
//!
//! `dps_start` spawns a background loop ([`tauri::async_runtime::spawn`], like
//! the SDE refresh in `lib.rs`) that seeks to the end of the newest gamelog,
//! then every ~500 ms reads whatever the EVE client appended, parses each combat
//! line ([`super::parser`]), feeds a rolling [`Window`], and `emit`s a
//! `dps://tick` (the same event pattern as `sde://progress`). The frontend
//! `listen`s and draws the graph.
//!
//! Lifecycle is a generation counter held in [`DpsState`]: each `dps_start`
//! bumps it and the loop runs only while its captured generation is current, so
//! a restart cleanly supersedes the old loop and `dps_stop` simply bumps it
//! again to end the current one. (This stop mechanism is the one piece with no
//! prior precedent in the codebase.)

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

use super::aggregate::Window;
use super::parser::parse_line;

/// How often the loop reads new bytes and emits a tick.
const POLL: Duration = Duration::from_millis(500);

/// Shared run-state. The active loop runs while its generation == `generation`;
/// `dps_start` and `dps_stop` both bump it.
#[derive(Default)]
pub struct DpsState {
    generation: Arc<AtomicU64>,
}

/// Settings passed from the UI to start a capture.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DpsSettings {
    /// The EVE `Gamelogs` folder (text-entered + persisted on the frontend).
    pub gamelogs_dir: String,
    /// Averaging window in seconds (PyEveLiveDPS-style moving average).
    #[serde(default = "default_window")]
    pub window_secs: u32,
}

fn default_window() -> u32 {
    10
}

/// A gamelog file the UI can list (newest first) — used for status + playback.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub path: String,
    /// Epoch seconds of last modification.
    pub modified: u64,
}

/// Start (or restart) tailing the newest gamelog in `settings.gamelogs_dir`.
/// Returns immediately; ticks arrive on the `dps://tick` event.
#[tauri::command]
pub async fn dps_start(
    app: AppHandle,
    state: State<'_, DpsState>,
    settings: DpsSettings,
) -> Result<(), String> {
    let dir = PathBuf::from(&settings.gamelogs_dir);
    if !dir.is_dir() {
        return Err(format!("not a folder: {}", settings.gamelogs_dir));
    }

    // Claim a generation; the previous loop (if any) sees a newer value and exits.
    let generation = state.generation.clone();
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;

    tauri::async_runtime::spawn(async move {
        let mut win = Window::new(settings.window_secs);
        // Start at the *current* end of the active log: only new combat counts,
        // never a replay of the whole session as one burst.
        let mut current = newest_gamelog(&dir);
        let mut offset = current
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0);

        let mut ticker = tokio::time::interval(POLL);
        loop {
            ticker.tick().await;
            if generation.load(Ordering::SeqCst) != my_gen {
                break; // superseded by another start, or stopped.
            }

            // A new session creates a new file — switch to it and read from 0.
            if let Some(newest) = newest_gamelog(&dir) {
                if current.as_deref() != Some(newest.as_path()) {
                    current = Some(newest);
                    offset = 0;
                }
            }

            if let Some(path) = &current {
                if let Some((text, next)) = read_appended(path, offset).await {
                    offset = next;
                    for line in text.lines() {
                        if let Some(ev) = parse_line(line) {
                            win.push(ev);
                        }
                    }
                }
            }

            let _ = app.emit("dps://tick", &win.tick(epoch_now()));
        }
    });

    Ok(())
}

/// Stop the active capture (bump the generation so the loop exits next tick).
#[tauri::command]
pub fn dps_stop(state: State<'_, DpsState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
}

/// List gamelog `*.txt` files in `gamelogs_dir`, newest first.
#[tauri::command]
pub fn dps_list_logs(gamelogs_dir: String) -> Result<Vec<LogFile>, String> {
    let dir = Path::new(&gamelogs_dir);
    if !dir.is_dir() {
        return Err(format!("not a folder: {gamelogs_dir}"));
    }
    let mut files: Vec<LogFile> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".txt")
        })
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let modified = meta
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_secs();
            Some(LogFile {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                modified,
            })
        })
        .collect();
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(files)
}

/// The newest `*.txt` in `dir` by mtime (the active gamelog). Mirrors
/// `localintel::local_log_names`'s newest-by-mtime selection.
fn newest_gamelog(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".txt")
        })
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .max_by_key(|(_, m)| *m)
        .map(|(p, _)| p)
}

/// Read bytes appended to `path` since `offset`. Returns the decoded text up to
/// the last complete line and the new offset (so a half-written final line is
/// re-read next time, never split). `None` if nothing new / unreadable.
async fn read_appended(path: &Path, offset: u64) -> Option<(String, u64)> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let len = file.metadata().await.ok()?.len();
    if len <= offset {
        return None; // nothing appended (or file truncated/rotated).
    }
    file.seek(SeekFrom::Start(offset)).await.ok()?;
    let mut buf = Vec::with_capacity((len - offset) as usize);
    file.read_to_end(&mut buf).await.ok()?;
    // Only consume through the last newline; keep any partial trailing line.
    let last_nl = buf.iter().rposition(|&b| b == b'\n')?;
    let consumed = last_nl + 1;
    let text = String::from_utf8_lossy(&buf[..consumed]).into_owned();
    Some((text, offset + consumed as u64))
}

fn epoch_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
