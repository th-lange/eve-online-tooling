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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

use super::aggregate::Window;
use super::parser::{parse_line, EventKind};
use crate::sde::{Sde, SdePaths};

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

fn default_speed() -> f64 {
    1.0
}

/// Settings for replaying a past gamelog through the same tick pipeline.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSettings {
    /// Absolute path to the gamelog file (from `dps_list_logs`).
    pub file: String,
    /// Replay speed multiplier (1.0 = real time).
    #[serde(default = "default_speed")]
    pub speed: f64,
    #[serde(default = "default_window")]
    pub window_secs: u32,
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

    // SDE path (for ore → m³); resolved once. Mining lines need a volume lookup.
    let sde_db = crate::storage::app_data_dir(&app)
        .ok()
        .map(|d| SdePaths::new(d).db);

    tauri::async_runtime::spawn(async move {
        let mut win = Window::new(settings.window_secs);
        // Cache of ore name → m³ per unit, resolved lazily from the SDE.
        let mut ore_vol: HashMap<String, f64> = HashMap::new();
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
                    let mut batch: Vec<_> = text.lines().filter_map(parse_line).collect();
                    resolve_ore_volumes(&batch, &mut ore_vol, sde_db.as_deref());
                    for mut ev in batch.drain(..) {
                        if ev.kind == EventKind::Mining {
                            let per_unit = ev
                                .ore
                                .as_deref()
                                .and_then(|o| ore_vol.get(o))
                                .copied()
                                .unwrap_or(0.0);
                            ev.volume = ev.amount as f64 * per_unit;
                        }
                        win.push(ev);
                    }
                }
            }

            let _ = app.emit(
                "dps://tick",
                &win.tick(crate::util::time::now_secs() as i64),
            );
        }
    });

    Ok(())
}

/// Stop the active capture or playback (bump the generation so the loop exits).
#[tauri::command]
pub fn dps_stop(state: State<'_, DpsState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
}

/// Replay a past gamelog through the same tick pipeline at `speed`× real time.
/// Emits `dps://tick` exactly like a live capture, so the UI is identical.
#[tauri::command]
pub async fn dps_playback(
    app: AppHandle,
    state: State<'_, DpsState>,
    settings: PlaybackSettings,
) -> Result<(), String> {
    // Read + parse the whole log up front, in timestamp order.
    let bytes = tokio::fs::read(&settings.file)
        .await
        .map_err(|e| e.to_string())?;
    let mut events: Vec<_> = String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(parse_line)
        .collect();
    events.sort_by_key(|e| e.ts);
    if events.is_empty() {
        return Err("no combat lines in that log".into());
    }

    // Resolve mining volumes once (same path as the live loop).
    let sde_db = crate::storage::app_data_dir(&app)
        .ok()
        .map(|d| SdePaths::new(d).db);
    let mut ore_vol: HashMap<String, f64> = HashMap::new();
    resolve_ore_volumes(&events, &mut ore_vol, sde_db.as_deref());
    for ev in &mut events {
        if ev.kind == EventKind::Mining {
            let per_unit = ev
                .ore
                .as_deref()
                .and_then(|o| ore_vol.get(o))
                .copied()
                .unwrap_or(0.0);
            ev.volume = ev.amount as f64 * per_unit;
        }
    }

    let generation = state.generation.clone();
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
    let speed = settings.speed.max(0.1);
    let window_secs = settings.window_secs;

    tauri::async_runtime::spawn(async move {
        let mut win = Window::new(window_secs);
        let start = events.first().map(|e| e.ts).unwrap_or(0);
        let end = events.last().map(|e| e.ts).unwrap_or(0);
        // Virtual log clock; advances `step` log-seconds per real POLL tick.
        let mut vt = start as f64;
        let step = POLL.as_secs_f64() * speed;
        let mut idx = 0usize;

        let mut ticker = tokio::time::interval(POLL);
        loop {
            ticker.tick().await;
            if generation.load(Ordering::SeqCst) != my_gen {
                break; // stopped, or another start/playback superseded us.
            }
            vt += step;
            let now = vt as i64;
            while idx < events.len() && events[idx].ts <= now {
                win.push(events[idx].clone());
                idx += 1;
            }
            let _ = app.emit("dps://tick", &win.tick(now));
            // Run one extra window past the last event so it decays to zero.
            if now > end + window_secs as i64 {
                break;
            }
        }
    });

    Ok(())
}

/// List gamelog `*.txt` files in `gamelogs_dir`, newest first.
#[tauri::command]
pub fn dps_list_logs(gamelogs_dir: String) -> Result<Vec<LogFile>, String> {
    let dir = Path::new(&gamelogs_dir);
    if !dir.is_dir() {
        return Err(format!("not a folder: {gamelogs_dir}"));
    }
    let mut files: Vec<LogFile> = crate::util::fs::list_files_by_mtime(dir, is_gamelog)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|(path, mtime)| {
            let modified = mtime.duration_since(UNIX_EPOCH).ok()?.as_secs();
            Some(LogFile {
                name: path.file_name()?.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                modified,
            })
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.modified));
    Ok(files)
}

/// Name predicate for gamelog files (fed lowercased names by `util::fs`).
fn is_gamelog(name: &str) -> bool {
    name.ends_with(".txt")
}

/// The newest `*.txt` in `dir` by mtime (the active gamelog).
fn newest_gamelog(dir: &Path) -> Option<PathBuf> {
    crate::util::fs::newest_file_by_mtime(dir, is_gamelog)
        .ok()
        .flatten()
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

/// Ensure every ore named in `batch` has its m³/unit cached, looking up any new
/// names in the SDE (`type_by_name` returns the type's volume). Sync — opens and
/// drops the connection here so it's never held across an `.await`. Unknown ores
/// (or a missing SDE) resolve to 0.0 so the meter still runs.
fn resolve_ore_volumes(
    batch: &[super::parser::DpsEvent],
    cache: &mut HashMap<String, f64>,
    sde_db: Option<&Path>,
) {
    let unknown: Vec<String> = batch
        .iter()
        .filter(|e| e.kind == EventKind::Mining)
        .filter_map(|e| e.ore.clone())
        .filter(|o| !cache.contains_key(o))
        .collect();
    if unknown.is_empty() {
        return;
    }
    let sde = sde_db.and_then(|p| Sde::open(p).ok());
    for ore in unknown {
        let vol = sde
            .as_ref()
            .and_then(|s| s.type_by_name(&ore).ok().flatten())
            .and_then(|(_, v)| v)
            .unwrap_or(0.0);
        cache.insert(ore, vol);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory under the OS temp dir, removed on drop.
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("eve-tooling-dpsmeter-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create tmp dir");
            TmpDir(dir)
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Create `name` in `dir` with a mtime `secs_ago` seconds in the past.
    fn touch(dir: &Path, name: &str, secs_ago: u64) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "").expect("create file");
        let mtime = std::time::SystemTime::now() - Duration::from_secs(secs_ago);
        let file = std::fs::File::open(&path).expect("open file");
        file.set_modified(mtime).expect("set mtime");
        path
    }

    #[tokio::test]
    async fn read_appended_reads_complete_lines_and_reoffsets() {
        let tmp = TmpDir::new("read-appended");
        let path = tmp.0.join("gamelog.txt");
        std::fs::write(&path, "line1\nline2\npartial").expect("write file");

        let (text, offset) = read_appended(&path, 0).await.expect("some appended text");
        assert_eq!(text, "line1\nline2\n");
        assert_eq!(offset, 12);

        // Nothing appended since `offset` yet.
        assert!(read_appended(&path, offset).await.is_none());

        // Complete the trailing partial line.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open for append");
        use std::io::Write;
        file.write_all(b"-done\n").expect("append");
        drop(file);

        let (text, offset) = read_appended(&path, offset)
            .await
            .expect("completed line appended");
        assert_eq!(text, "partial-done\n");
        assert_eq!(offset, 25);

        // Truncated file (offset now beyond EOF) is also a no-op.
        std::fs::write(&path, "short").expect("truncate file");
        assert!(read_appended(&path, offset).await.is_none());
    }

    #[test]
    fn newest_gamelog_picks_newest_txt_and_ignores_log() {
        let tmp = TmpDir::new("newest-gamelog");
        touch(&tmp.0, "old.txt", 30);
        let expected = touch(&tmp.0, "new.txt", 5);
        touch(&tmp.0, "notes.log", 1); // newest mtime, but wrong extension.

        let newest = newest_gamelog(&tmp.0).expect("some txt file");
        assert_eq!(newest, expected);
    }
}
