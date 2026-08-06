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
    /// Start the virtual clock here instead of the file's first event (epoch
    /// seconds; clamped to the file's span) — scrubbing via the timeline
    /// slider restarts playback with this set.
    #[serde(default)]
    pub seek_ts: Option<i64>,
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

/// How many buckets [`dps_log_summary`] splits a log's time span into for the
/// timeline density strip — enough resolution for a wide slider, independent
/// of how long the session ran.
const SUMMARY_BUCKETS: usize = 200;

/// One bucket's activity, normalized 0..1 against that category's busiest
/// bucket in the file (so the timeline reads as relative intensity, not
/// absolute numbers the UI has no scale for).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventBucket {
    /// Bucket start, epoch seconds.
    pub at: i64,
    pub damage_out: f32,
    pub damage_in: f32,
    pub mining: f32,
}

/// A log's time span + activity buckets, for the playback timeline slider.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSummary {
    pub start: i64,
    pub end: i64,
    pub buckets: Vec<EventBucket>,
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

/// Read + parse a whole gamelog file and resolve its mining volumes, sorted by
/// timestamp. Shared by [`dps_playback`] (replay) and [`dps_log_summary`]
/// (timeline density) so both see identical events for the same file.
async fn load_and_resolve_events(
    app: &AppHandle,
    file: &str,
) -> Result<Vec<super::parser::DpsEvent>, String> {
    let bytes = tokio::fs::read(file).await.map_err(|e| e.to_string())?;
    let mut events: Vec<_> = String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(parse_line)
        .collect();
    events.sort_by_key(|e| e.ts);
    if events.is_empty() {
        return Err("no combat lines in that log".into());
    }

    let sde_db = crate::storage::app_data_dir(app)
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
    Ok(events)
}

/// Resolve a scrub-to timestamp against `events`: clamp it into the file's
/// span, split events into "already past" (used to warm the window) vs "still
/// ahead" (the resume index the poll loop continues from), and collect the
/// trailing `window_secs` of history so the DPS readout isn't cold at the seek
/// point. `None` seeks to the start (nothing to warm). Pure — for unit testing
/// without spawning the playback loop; [`dps_playback`] is the thin wrapper.
fn seek_start(
    events: &[super::parser::DpsEvent],
    seek_ts: Option<i64>,
    window_secs: u32,
) -> (i64, usize, Vec<super::parser::DpsEvent>) {
    let start = events.first().map(|e| e.ts).unwrap_or(0);
    let end = events.last().map(|e| e.ts).unwrap_or(0);
    let seek = seek_ts.map(|t| t.clamp(start, end)).unwrap_or(start);
    let idx = events.partition_point(|e| e.ts <= seek);
    let warm_cutoff = seek - window_secs as i64;
    let warm = events[..idx]
        .iter()
        .filter(|e| e.ts >= warm_cutoff)
        .cloned()
        .collect();
    (seek, idx, warm)
}

/// Replay a past gamelog through the same tick pipeline at `speed`× real time.
/// Emits `dps://tick` exactly like a live capture, so the UI is identical.
/// `settings.seek_ts` (set by dragging the timeline slider) starts the virtual
/// clock mid-file instead of at the first event; the window is pre-warmed with
/// the trailing `window_secs` of history so the DPS readout isn't cold at the
/// seek point.
#[tauri::command]
pub async fn dps_playback(
    app: AppHandle,
    state: State<'_, DpsState>,
    settings: PlaybackSettings,
) -> Result<(), String> {
    let events = load_and_resolve_events(&app, &settings.file).await?;

    let generation = state.generation.clone();
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
    let speed = settings.speed.max(0.1);
    let window_secs = settings.window_secs;
    let seek_ts = settings.seek_ts;

    let (seek, idx, warm) = seek_start(&events, seek_ts, window_secs);

    tauri::async_runtime::spawn(async move {
        let mut win = Window::new(window_secs);
        let end = events.last().map(|e| e.ts).unwrap_or(0);
        let mut idx = idx;
        // `push` order doesn't matter — `tick` only sums what's in the buffer.
        for ev in warm {
            win.push(ev);
        }

        // Virtual log clock; advances `step` log-seconds per real POLL tick.
        let mut vt = seek as f64;
        let step = POLL.as_secs_f64() * speed;

        let mut ticker = tokio::time::interval(POLL);
        loop {
            ticker.tick().await;
            if generation.load(Ordering::SeqCst) != my_gen {
                break; // stopped, or another start/playback/seek superseded us.
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

/// Bucket parsed events into [`SUMMARY_BUCKETS`] equal-width time slices across
/// their span, normalizing each category (out/in damage, mining) against its
/// own busiest bucket. Pure — no file IO — for unit testing; [`dps_log_summary`]
/// is the thin command wrapper.
fn bucket_events(events: &[super::parser::DpsEvent]) -> LogSummary {
    let start = events.first().map(|e| e.ts).unwrap_or(0);
    let end = events.last().map(|e| e.ts).unwrap_or(0);
    let span = (end - start).max(1) as f64;
    let bucket_secs = (span / SUMMARY_BUCKETS as f64).max(1.0);

    let mut raw = vec![(0.0f64, 0.0f64, 0.0f64); SUMMARY_BUCKETS];
    for ev in events {
        let idx = (((ev.ts - start) as f64 / bucket_secs) as usize).min(SUMMARY_BUCKETS - 1);
        let slot = &mut raw[idx];
        match ev.kind {
            EventKind::DamageOut => slot.0 += ev.amount as f64,
            EventKind::DamageIn => slot.1 += ev.amount as f64,
            EventKind::Mining => slot.2 += ev.volume,
            _ => {}
        }
    }
    let peak_out = raw.iter().map(|b| b.0).fold(0.0f64, f64::max).max(1.0);
    let peak_in = raw.iter().map(|b| b.1).fold(0.0f64, f64::max).max(1.0);
    let peak_mining = raw.iter().map(|b| b.2).fold(0.0f64, f64::max).max(1.0);

    let buckets = raw
        .iter()
        .enumerate()
        .map(|(i, &(out, inc, mining))| EventBucket {
            at: start + (i as f64 * bucket_secs) as i64,
            damage_out: (out / peak_out) as f32,
            damage_in: (inc / peak_in) as f32,
            mining: (mining / peak_mining) as f32,
        })
        .collect();

    LogSummary { start, end, buckets }
}

/// Time span + activity-density buckets for `file`, for the playback timeline
/// slider — lets the UI show roughly where combat/mining happened before
/// (or without) actually playing the log.
#[tauri::command]
pub async fn dps_log_summary(app: AppHandle, file: String) -> Result<LogSummary, String> {
    let events = load_and_resolve_events(&app, &file).await?;
    Ok(bucket_events(&events))
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

    /// A bare damage/mining event at `ts` — the fields `bucket_events` ignores
    /// (pilot/ship/weapon/quality/ore) don't matter for bucketing.
    fn ev(ts: i64, kind: EventKind, amount: i64, volume: f64) -> super::super::parser::DpsEvent {
        super::super::parser::DpsEvent {
            ts,
            kind,
            amount,
            pilot: None,
            ship: None,
            weapon: None,
            quality: None,
            ore: None,
            volume,
        }
    }

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

    #[test]
    fn bucket_events_normalizes_each_category_against_its_own_peak() {
        // 2000 s span / 200 buckets = 10 s/bucket: bucket 0 (ts 0-9), bucket
        // 50 (ts 500-509), bucket 100 (ts 1000-1009), bucket 150 (ts 1500-1509).
        let events = vec![
            ev(0, EventKind::DamageOut, 300, 0.0),
            ev(1000, EventKind::DamageOut, 100, 0.0), // 1/3 of the peak bucket
            ev(500, EventKind::DamageIn, 50, 0.0),
            ev(1500, EventKind::Mining, 0, 20.0),
            ev(1999, EventKind::DamageOut, 0, 0.0), // last event pins `end`
        ];
        let summary = bucket_events(&events);

        assert_eq!(summary.start, 0);
        assert_eq!(summary.end, 1999);
        assert_eq!(summary.buckets.len(), SUMMARY_BUCKETS);

        assert_eq!(summary.buckets[0].damage_out, 1.0); // the busiest out-bucket
        assert!((summary.buckets[100].damage_out - (100.0 / 300.0) as f32).abs() < 1e-6);
        assert_eq!(summary.buckets[50].damage_in, 1.0); // only in-bucket → its own peak
        assert_eq!(summary.buckets[150].mining, 1.0); // only mining bucket → its own peak

        // Categories don't bleed into buckets/slots they didn't occupy.
        assert_eq!(summary.buckets[0].damage_in, 0.0);
        assert_eq!(summary.buckets[0].mining, 0.0);
        assert_eq!(summary.buckets[50].damage_out, 0.0);
    }

    #[test]
    fn bucket_events_single_timestamp_does_not_panic() {
        // Every event at the same instant → zero span; must not divide by zero.
        let events = vec![ev(1000, EventKind::DamageOut, 50, 0.0)];
        let summary = bucket_events(&events);
        assert_eq!(summary.start, 1000);
        assert_eq!(summary.end, 1000);
        assert_eq!(summary.buckets[0].damage_out, 1.0);
    }

    #[test]
    fn seek_start_with_no_seek_resumes_from_the_first_event() {
        let events = vec![
            ev(0, EventKind::DamageOut, 10, 0.0),
            ev(30, EventKind::DamageOut, 20, 0.0),
        ];
        let (seek, idx, warm) = seek_start(&events, None, 10);
        assert_eq!(seek, 0);
        // The first event sits exactly at the seek point, so it's pre-warmed
        // (equivalent to the main loop picking it up on its very first tick —
        // vt starts at `seek` and only advances *after* the first poll).
        assert_eq!(idx, 1);
        assert_eq!(warm.len(), 1);
        assert_eq!(warm[0].ts, 0);
        // The second event is still ahead, for the main loop to pick up.
        assert_eq!(events[idx].ts, 30);
    }

    #[test]
    fn seek_start_clamps_out_of_range_targets_into_the_files_span() {
        let events = vec![
            ev(100, EventKind::DamageOut, 10, 0.0),
            ev(200, EventKind::DamageOut, 10, 0.0),
        ];
        let (before, ..) = seek_start(&events, Some(0), 10);
        assert_eq!(before, 100); // clamped up to the first event.
        let (after, ..) = seek_start(&events, Some(10_000), 10);
        assert_eq!(after, 200); // clamped down to the last event.
    }

    #[test]
    fn seek_start_warms_only_the_trailing_window_and_resumes_after_the_seek_point() {
        // Seek to ts=500 with a 10 s window: only the ts=495 event is inside
        // [490, 500] and gets pre-warmed; ts=100 is long past and dropped;
        // ts=600 is still ahead, so it stays for the main loop to pick up.
        let events = vec![
            ev(100, EventKind::DamageOut, 10, 0.0),
            ev(495, EventKind::DamageOut, 20, 0.0),
            ev(600, EventKind::DamageOut, 30, 0.0),
        ];
        let (seek, idx, warm) = seek_start(&events, Some(500), 10);
        assert_eq!(seek, 500);
        assert_eq!(idx, 2); // events[0..2] (ts 100, 495) are "past" the seek point.
        assert_eq!(warm.len(), 1);
        assert_eq!(warm[0].ts, 495);
        // The still-ahead event resumes from `idx`.
        assert_eq!(events[idx].ts, 600);
    }

    #[test]
    fn real_gamelog_text_parses_and_buckets_end_to_end() {
        // Exercises the same `text.lines().filter_map(parse_line)` step
        // `load_and_resolve_events` runs, then feeds the result straight into
        // `bucket_events` — the whole non-Tauri pipeline `dps_log_summary`
        // wraps, on realistic gamelog markup (not synthetic DpsEvent structs).
        let text = "\
[ 2026.08.01 12:00:00 ] (combat) <color=0xff..><b>300</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xff..>Target[X](Cruiser)</b> - Blaster - Hits
[ 2026.08.01 12:02:00 ] (combat) <color=0xff..><b>50</b> <color=0x77ffffff><font size=10>from</font> <b><color=0xff..>Enemy[Y](Frigate)</b> - Hits
[ 2026.08.01 12:03:20 ] (mining) <color=0xff..><b>34</b> units of <color=0xff..>Veldspar</color>
[ 2026.08.01 12:09:59 ] (combat) <color=0xff..><b>100</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xff..>Target[X](Cruiser)</b> - Blaster - Hits
not a combat line, ignored";
        let mut events: Vec<_> = text.lines().filter_map(parse_line).collect();
        events.sort_by_key(|e| e.ts);
        assert_eq!(events.len(), 4); // the chat-noise line is dropped.
        // `parse_line` leaves mining volume at 0.0 — only the SDE-backed
        // `resolve_ore_volumes` step in `load_and_resolve_events` fills it
        // in, which needs a live `AppHandle` this pure test doesn't have.
        // Mirror its effect (34 units × a made-up 0.1 m³/unit) so bucketing
        // sees a realistic nonzero mining amount, same as production.
        for ev in &mut events {
            if ev.kind == EventKind::Mining {
                ev.volume = ev.amount as f64 * 0.1;
            }
        }

        let summary = bucket_events(&events);
        assert_eq!(summary.start, events[0].ts);
        assert_eq!(summary.end, events[3].ts);
        // The 300-damage line is the sole DamageOut bucket → its own peak.
        assert!(summary.buckets.iter().any(|b| b.damage_out == 1.0));
        // The 100-damage line (1/3 the amount) sits in a later bucket.
        let out_values: Vec<f32> = summary
            .buckets
            .iter()
            .map(|b| b.damage_out)
            .filter(|&v| v > 0.0)
            .collect();
        assert_eq!(out_values.len(), 2);
        assert!(out_values.contains(&1.0));
        assert!((out_values.iter().cloned().fold(0.0, f32::max) - 1.0).abs() < 1e-6);
        // Damage-in and mining each land in exactly one bucket, at their peak.
        assert!(summary.buckets.iter().any(|b| b.damage_in == 1.0));
        assert!(summary.buckets.iter().any(|b| b.mining == 1.0));
    }
}
