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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader, SeekFrom};

use super::aggregate::Window;
use super::overview::{parse_overview_export, ExtractionPlan};
use super::parser::{parse_line, parse_line_with_plan, EventKind, Lang};
use crate::model::AppError;
use crate::sde::{Sde, SdePaths};

/// How often the loop reads new bytes and emits a tick.
const POLL: Duration = Duration::from_millis(500);

/// Above this size, [`dps_playback`] refuses to load the log rather than risk
/// spiking memory by (file bytes + parsed-event overhead): replay genuinely
/// needs the whole file loaded and sorted in memory (unlike
/// [`dps_log_summary`], which streams the file line-by-line instead). ~50 MB
/// is generously above what a long real session's gamelog reaches (#816).
const MAX_PLAYBACK_LOG_BYTES: u64 = 50 * 1024 * 1024;

/// Shared run-state. The active loop runs while its generation == `generation`;
/// `dps_start`/`dps_playback`/`dps_stop` bump it. `paused` freezes the active
/// loop's virtual clock in place (true pause/continue) without tearing it down
/// — so resuming picks up the exact same moving-average window, no re-seek.
#[derive(Default)]
pub struct DpsState {
    generation: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
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
    /// Overview-export-derived pilot/ship extraction plan (#869); `None`
    /// keeps `extract_actor`'s default-format scan.
    #[serde(default)]
    pub extraction_plan: Option<ExtractionPlan>,
    /// Follow this character's newest gamelog instead of the raw newest
    /// file (#870) — resolved from each file's header, re-checked every
    /// poll tick so a new session log for the same character hot-swaps in
    /// and a livelier other character's file never wins. `None` keeps the
    /// unchanged newest-file behavior (single-boxer flow).
    #[serde(default)]
    pub character: Option<String>,
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
    /// Stop (and, if the UI re-issues, loop) at this epoch second instead of
    /// the file's end — set when playing a selected fight region.
    #[serde(default)]
    pub stop_ts: Option<i64>,
    /// Overview-export-derived pilot/ship extraction plan (#869); `None`
    /// keeps `extract_actor`'s default-format scan.
    #[serde(default)]
    pub extraction_plan: Option<ExtractionPlan>,
}

/// A gamelog file the UI can list (newest first) — used for status + playback.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub path: String,
    /// Epoch seconds of last modification.
    pub modified: u64,
    /// The character the header's localized `Listener:` line names (#870).
    /// `None` for a log whose header doesn't match any known phrase (a
    /// language without a sourced `Listener:` phrase yet, or a malformed
    /// header) — the file still lists and is still tailable directly, just
    /// not selectable via the character picker.
    pub character: Option<String>,
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
    // Fresh capture starts unpaused; the loop watches this flag to freeze.
    let paused = state.paused.clone();
    paused.store(false, Ordering::SeqCst);

    // SDE path (for ore → m³); resolved once. Mining lines need a volume lookup.
    let sde_db = crate::storage::app_data_dir(&app)
        .ok()
        .map(|d| SdePaths::new(d).db);

    tauri::async_runtime::spawn(async move {
        let mut win = Window::new(settings.window_secs);
        // Cache of ore name → m³ per unit, resolved lazily from the SDE.
        let mut ore_vol: HashMap<String, f64> = HashMap::new();
        // Cache of weapon/ammo/drone name → source type (SDE group).
        let mut weapon_kinds: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        // Start at the *current* end of the active log: only new combat counts,
        // never a replay of the whole session as one burst.
        let mut current = pick_newest_gamelog(&dir, settings.character.as_deref());
        let mut offset = current
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0);
        // Detected once when `current` is (re)assigned, not per line — a
        // localized client's header never changes mid-session (#868).
        let mut lang = match &current {
            Some(path) => detect_file_lang(path).await,
            None => Lang::En,
        };

        let mut ticker = tokio::time::interval(POLL);
        loop {
            ticker.tick().await;
            if generation.load(Ordering::SeqCst) != my_gen {
                break; // superseded by another start, or stopped.
            }
            if paused.load(Ordering::SeqCst) {
                continue; // frozen: don't read new lines or emit while paused.
            }

            // A new session creates a new file — switch to it, read from 0,
            // and re-detect its language. When a character is selected this
            // re-check is also the hot-swap: a livelier other character's
            // file (newer by mtime) never wins over this character's own
            // newest session log (#870).
            if let Some(newest) = pick_newest_gamelog(&dir, settings.character.as_deref()) {
                if current.as_deref() != Some(newest.as_path()) {
                    lang = detect_file_lang(&newest).await;
                    current = Some(newest);
                    offset = 0;
                }
            }

            if let Some(path) = &current {
                if let Some((text, next)) = read_appended(path, offset).await {
                    offset = next;
                    let mut batch: Vec<_> = text
                        .lines()
                        .flat_map(|l| {
                            parse_line_with_plan(l, lang, settings.extraction_plan.as_ref())
                        })
                        .collect();
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

            let mut tick = win.tick(crate::util::time::now_secs() as i64);
            attach_weapon_kinds(&mut tick, &mut weapon_kinds, sde_db.as_deref());
            let _ = app.emit("dps://tick", &tick);
        }
    });

    Ok(())
}

/// Stop the active capture or playback (bump the generation so the loop exits).
#[tauri::command]
pub fn dps_stop(state: State<'_, DpsState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    // A stopped session is not "paused" — clear the flag so the next start/
    // playback isn't born frozen if it raced a lingering pause.
    state.paused.store(false, Ordering::SeqCst);
}

/// Freeze the active playback/capture loop in place (true pause): the virtual
/// clock and the moving-average window hold, so [`dps_resume`] continues from
/// the exact same point with no re-seek or window re-warm.
#[tauri::command]
pub fn dps_pause(state: State<'_, DpsState>) {
    state.paused.store(true, Ordering::SeqCst);
}

/// Un-freeze a paused loop; playback resumes exactly where it stopped.
#[tauri::command]
pub fn dps_resume(state: State<'_, DpsState>) {
    state.paused.store(false, Ordering::SeqCst);
}

/// Read + parse a whole gamelog file and resolve its mining volumes, sorted by
/// timestamp. Used by [`dps_playback`] only — replay genuinely needs a
/// globally ordered event vec, unlike [`dps_log_summary`], which streams the
/// file line-by-line instead of holding every parsed event in memory (#816).
/// Callers **must** bound the file size first (see [`MAX_PLAYBACK_LOG_BYTES`])
/// since this loads the whole file into memory before sorting it.
async fn load_and_resolve_events(
    app: &AppHandle,
    file: &str,
    plan: Option<&ExtractionPlan>,
) -> Result<Vec<super::parser::DpsEvent>, String> {
    let bytes = tokio::fs::read(file).await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let lang = super::parser::detect_lang(&text);
    let mut events: Vec<_> = text
        .lines()
        .flat_map(|l| parse_line_with_plan(l, lang, plan))
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
/// seek point. Rejects logs over [`MAX_PLAYBACK_LOG_BYTES`] instead of
/// silently loading + sorting an unbounded amount of memory (#816) — use
/// [`dps_log_summary`]'s streaming timeline for a rough look at huge logs.
#[tauri::command]
pub async fn dps_playback(
    app: AppHandle,
    state: State<'_, DpsState>,
    settings: PlaybackSettings,
) -> Result<(), String> {
    let size = tokio::fs::metadata(&settings.file)
        .await
        .map_err(|e| e.to_string())?
        .len();
    if size > MAX_PLAYBACK_LOG_BYTES {
        return Err(format!(
            "gamelog too large to replay ({} MB, limit {} MB) — playback needs \
             the whole file sorted in memory; use the summary timeline instead",
            size / (1024 * 1024),
            MAX_PLAYBACK_LOG_BYTES / (1024 * 1024),
        ));
    }
    let events =
        load_and_resolve_events(&app, &settings.file, settings.extraction_plan.as_ref()).await?;

    let generation = state.generation.clone();
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
    let paused = state.paused.clone();
    paused.store(false, Ordering::SeqCst);
    let speed = settings.speed.max(0.1);
    let window_secs = settings.window_secs;
    let seek_ts = settings.seek_ts;
    let stop_ts = settings.stop_ts;

    let (seek, idx, warm) = seek_start(&events, seek_ts, window_secs);
    // SDE path for resolving weapon/ammo/drone → source type, cached per name.
    let sde_db = crate::storage::app_data_dir(&app)
        .ok()
        .map(|d| SdePaths::new(d).db);

    tauri::async_runtime::spawn(async move {
        let mut win = Window::new(window_secs);
        let mut weapon_kinds: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
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
            if paused.load(Ordering::SeqCst) {
                continue; // frozen: hold the virtual clock so resume continues.
            }
            vt += step;
            let now = vt as i64;
            while idx < events.len() && events[idx].ts <= now {
                win.push(events[idx].clone());
                idx += 1;
            }
            let mut tick = win.tick(now);
            attach_weapon_kinds(&mut tick, &mut weapon_kinds, sde_db.as_deref());
            let _ = app.emit("dps://tick", &tick);
            // End: at the region's stop mark when playing a selection, else one
            // window past the last event so the rate decays to zero. Either way
            // emit `dps://done` so the UI can loop.
            let ended = match stop_ts {
                Some(s) => now >= s,
                None => now > end + window_secs as i64,
            };
            if ended {
                let _ = app.emit("dps://done", ());
                break;
            }
        }
    });

    Ok(())
}

/// Normalize raw per-bucket `(damage_out, damage_in, mining)` sums into a
/// [`LogSummary`], each category against its own busiest bucket. Shared by
/// [`bucket_events`] (in-memory, used by its unit tests) and
/// [`stream_log_summary`] (the streaming path [`dps_log_summary`] actually
/// calls).
fn buckets_from_raw(
    start: i64,
    end: i64,
    bucket_secs: f64,
    raw: Vec<(f64, f64, f64)>,
) -> LogSummary {
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

    LogSummary {
        start,
        end,
        buckets,
    }
}

/// Bucket parsed events into [`SUMMARY_BUCKETS`] equal-width time slices
/// across their span. Pure — no file IO. Test-only: it exercises the shared
/// [`buckets_from_raw`] core against realistic in-memory `DpsEvent`s;
/// [`dps_log_summary`] itself calls the streaming [`stream_log_summary`]
/// instead, so production never holds the full event vec.
#[cfg(test)]
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
    buckets_from_raw(start, end, bucket_secs, raw)
}

/// First streaming pass over `file`: find the min/max event timestamp
/// without holding any parsed events — bucketing needs the file's full time
/// span up front to size `bucket_secs`, and gamelog lines are only
/// *near*-chronological, so we track the exact min/max rather than trusting
/// the first/last line (#816).
async fn scan_log_span(file: &str, lang: Lang) -> Result<(i64, i64), String> {
    let handle = tokio::fs::File::open(file)
        .await
        .map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(handle).lines();
    let mut span: Option<(i64, i64)> = None;
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        for ev in parse_line(&line, lang) {
            span = Some(match span {
                Some((start, end)) => (start.min(ev.ts), end.max(ev.ts)),
                None => (ev.ts, ev.ts),
            });
        }
    }
    span.ok_or_else(|| "no combat lines in that log".into())
}

/// Stream `file` line-by-line, bucketing activity into [`SUMMARY_BUCKETS`] on
/// the fly instead of loading every parsed event into a `Vec` — summaries
/// never need a globally sorted event vec, only per-bucket sums (#816). Two
/// passes over the file ([`scan_log_span`] for the time span, then this one
/// to bucket), both O(buckets) memory rather than O(file); [`dps_playback`]
/// is the one path that still needs the whole file in memory, for ordered
/// replay.
async fn stream_log_summary(app: &AppHandle, file: &str) -> Result<LogSummary, String> {
    let lang = detect_file_lang(Path::new(file)).await;
    let (start, end) = scan_log_span(file, lang).await?;
    let span = (end - start).max(1) as f64;
    let bucket_secs = (span / SUMMARY_BUCKETS as f64).max(1.0);

    // Ore volumes are resolved per-line against a small name→m³ cache backed
    // by one SDE connection held open for the whole pass, mirroring
    // `resolve_ore_volumes`'s batch lookup without needing the batch itself.
    let sde_db = crate::storage::app_data_dir(app)
        .ok()
        .map(|d| SdePaths::new(d).db);
    let sde = sde_db.as_deref().and_then(|p| Sde::open(p).ok());
    let mut ore_vol: HashMap<String, f64> = HashMap::new();

    let mut raw = vec![(0.0f64, 0.0f64, 0.0f64); SUMMARY_BUCKETS];
    let handle = tokio::fs::File::open(file)
        .await
        .map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(handle).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        for mut ev in parse_line(&line, lang) {
            if ev.kind == EventKind::Mining {
                let per_unit = match ev.ore.as_deref() {
                    Some(ore) => *ore_vol.entry(ore.to_string()).or_insert_with(|| {
                        sde.as_ref()
                            .and_then(|s| s.type_by_name(ore).ok().flatten())
                            .and_then(|(_, v)| v)
                            .unwrap_or(0.0)
                    }),
                    None => 0.0,
                };
                ev.volume = ev.amount as f64 * per_unit;
            }
            let idx = (((ev.ts - start) as f64 / bucket_secs) as usize).min(SUMMARY_BUCKETS - 1);
            let slot = &mut raw[idx];
            match ev.kind {
                EventKind::DamageOut => slot.0 += ev.amount as f64,
                EventKind::DamageIn => slot.1 += ev.amount as f64,
                EventKind::Mining => slot.2 += ev.volume,
                _ => {}
            }
        }
    }
    Ok(buckets_from_raw(start, end, bucket_secs, raw))
}

/// Time span + activity-density buckets for `file`, for the playback timeline
/// slider — lets the UI show roughly where combat/mining happened before
/// (or without) actually playing the log. Streams the file rather than
/// loading it whole (#816); memory is O(buckets), not O(file).
#[tauri::command]
pub async fn dps_log_summary(app: AppHandle, file: String) -> Result<LogSummary, AppError> {
    stream_log_summary(&app, &file)
        .await
        .map_err(AppError::from)
}

/// Byte size of a gamelog file — a cheap growth probe. The playback overview
/// polls this so it can rebuild its summary (span first→last entry + activity)
/// while the log is still being written, instead of showing a stale snapshot.
#[tauri::command]
pub fn dps_log_stat(file: String) -> Result<u64, String> {
    std::fs::metadata(&file)
        .map(|m| m.len())
        .map_err(|e| format!("{file}: {e}"))
}

/// List gamelog `*.txt` files in `gamelogs_dir`, newest first. Each file's
/// `character` is read from its header's localized `Listener:` line (#870,
/// building on #868's language detection) — `None` for a log whose header
/// doesn't map to a known phrase; the file still lists, it's just
/// unattributed (still tailable directly by picking it in playback).
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
            let character = super::parser::detect_character(&read_header_sync(&path));
            Some(LogFile {
                name: path.file_name()?.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                modified,
                character,
            })
        })
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.modified));
    Ok(files)
}

/// Distinct characters seen in a gamelog modified within the last 24h (PELD's
/// `CharacterDetector` window) — the character picker's dropdown source.
/// Ordered by most recent activity; logs with no recognised `Listener:`
/// header (see [`dps_list_logs`]) are skipped, not listed as unattributed.
#[tauri::command]
pub fn dps_list_characters(gamelogs_dir: String) -> Result<Vec<String>, String> {
    let cutoff = crate::util::time::now_secs().saturating_sub(24 * 3600);
    let mut seen = std::collections::HashSet::new();
    let mut characters = Vec::new();
    for log in dps_list_logs(gamelogs_dir)? {
        if log.modified < cutoff {
            continue;
        }
        if let Some(character) = log.character {
            if seen.insert(character.clone()) {
                characters.push(character);
            }
        }
    }
    Ok(characters)
}

/// Parse a user's overview export (YAML, from the overview settings window's
/// "Export Overview Settings" button) into an [`ExtractionPlan`] (#869). The
/// frontend stores the returned plan alongside the rest of the DPS meter's
/// settings and passes it back into [`dps_start`]/[`dps_playback`].
#[tauri::command]
pub fn dps_parse_overview_export(path: String) -> Result<ExtractionPlan, String> {
    let yaml = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    parse_overview_export(&yaml)
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

/// [`newest_gamelog`] when `character` is `None` (unchanged single-boxer
/// behavior); otherwise [`newest_gamelog_for_character`] — the dispatch
/// [`dps_start`]'s loop re-runs every poll tick (#870).
fn pick_newest_gamelog(dir: &Path, character: Option<&str>) -> Option<PathBuf> {
    match character {
        Some(c) => newest_gamelog_for_character(dir, c),
        None => newest_gamelog(dir),
    }
}

/// The newest `*.txt` in `dir` whose header names `character`, by mtime
/// (#870). Scans newest-first and reads each header until one matches, so a
/// livelier other character's file — newer by mtime — never wins over this
/// character's own session: the multiboxing bug this issue fixes.
fn newest_gamelog_for_character(dir: &Path, character: &str) -> Option<PathBuf> {
    let mut files = crate::util::fs::list_files_by_mtime(dir, is_gamelog).ok()?;
    files.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));
    files
        .into_iter()
        .find(|(path, _)| {
            super::parser::detect_character(&read_header_sync(path)).as_deref() == Some(character)
        })
        .map(|(path, _)| path)
}

/// Read the first few KB of `path`, synchronously — enough to cover the
/// localized `Listener:` header line (and any login-collision divider
/// blocks stacked ahead of it, see [`super::parser::detect_character`]).
/// [`dps_list_logs`] and [`newest_gamelog_for_character`] both run on sync
/// command/loop paths, unlike [`detect_file_lang`]'s async equivalent.
fn read_header_sync(path: &Path) -> String {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut buf = vec![0u8; 4096];
    let n = file.read(&mut buf).unwrap_or(0);
    buf.truncate(n);
    String::from_utf8_lossy(&buf).into_owned()
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

/// Detect `path`'s client language from its header block (#868) — reads
/// only the first few KB, never the whole (potentially huge, still-growing)
/// file, since the localized `Listener:` phrase always sits on line 3.
/// Falls back to [`Lang::En`] if the file can't be opened/read.
async fn detect_file_lang(path: &Path) -> Lang {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return Lang::En;
    };
    let mut buf = vec![0u8; 4096];
    let n = file.read(&mut buf).await.unwrap_or(0);
    buf.truncate(n);
    super::parser::detect_lang(&String::from_utf8_lossy(&buf))
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

/// Fill each weapon/ammo/drone's source `kind` (SDE group, e.g. "Rocket") and
/// `damage` type (from the ammo's SDE damage attributes) on a tick — the
/// combat log names only the ammo, not the weapon module or the damage type.
/// Caches name → (kind, damage) so each name is looked up once; unknown names
/// or a missing SDE leave both `None`.
#[allow(clippy::type_complexity)]
fn attach_weapon_kinds(
    tick: &mut super::aggregate::DpsTick,
    cache: &mut HashMap<String, (Option<String>, Option<String>)>,
    sde_db: Option<&Path>,
) {
    let mut unknown: Vec<String> = Vec::new();
    let mut consider = |name: &str| {
        if !cache.contains_key(name) && !unknown.iter().any(|u| u == name) {
            unknown.push(name.to_string());
        }
    };
    for wr in &tick.by_weapon {
        consider(&wr.name);
    }
    for p in &tick.by_pilot {
        for wr in p.weapons_out.iter().chain(&p.weapons_in) {
            consider(&wr.name);
        }
    }
    if !unknown.is_empty() {
        let sde = sde_db.and_then(|p| Sde::open(p).ok());
        for name in unknown {
            let kind = sde
                .as_ref()
                .and_then(|s| s.weapon_group(&name).ok().flatten());
            let damage = sde
                .as_ref()
                .and_then(|s| s.damage_type(&name).ok().flatten());
            cache.insert(name, (kind, damage));
        }
    }
    let apply = |wr: &mut super::aggregate::WeaponRate| {
        if let Some((kind, damage)) = cache.get(&wr.name) {
            wr.kind = kind.clone();
            wr.damage = damage.clone();
        }
    };
    for wr in &mut tick.by_weapon {
        apply(wr);
    }
    for p in &mut tick.by_pilot {
        for wr in p.weapons_out.iter_mut().chain(p.weapons_in.iter_mut()) {
            apply(wr);
        }
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

    /// Create `name` in `dir` with a `Listener: <character>` gamelog header
    /// and a mtime `secs_ago` seconds in the past — a fixture file
    /// [`detect_character`](super::super::parser::detect_character) resolves
    /// to `character` (#870).
    fn touch_with_header(dir: &Path, name: &str, secs_ago: u64, character: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(
            &path,
            format!("Gamelog\r\nListener: {character}\r\nSession Started: 2026.06.25 12:00:00\r\n"),
        )
        .expect("create file");
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

    // --- #870: header-based character mapping ------------------------------

    #[test]
    fn newest_gamelog_for_character_ignores_a_newer_files_from_other_characters() {
        // The multiboxing bug this issue fixes: Bob's file is newer by
        // mtime, but selecting Alice must never follow it.
        let tmp = TmpDir::new("newest-for-character");
        let alice = touch_with_header(&tmp.0, "alice.txt", 30, "Alice");
        let bob = touch_with_header(&tmp.0, "bob.txt", 5, "Bob");

        assert_eq!(
            newest_gamelog_for_character(&tmp.0, "Alice").expect("alice log"),
            alice
        );
        assert_eq!(
            newest_gamelog_for_character(&tmp.0, "Bob").expect("bob log"),
            bob
        );
        assert!(newest_gamelog_for_character(&tmp.0, "Carol").is_none());
    }

    #[test]
    fn newest_gamelog_for_character_hot_swaps_to_a_new_session_log() {
        // A relog (or daily downtime) starts a new session file for the same
        // character — the newest one for that character must win.
        let tmp = TmpDir::new("hot-swap");
        touch_with_header(&tmp.0, "alice-old.txt", 30, "Alice");
        let newer = touch_with_header(&tmp.0, "alice-new.txt", 1, "Alice");

        assert_eq!(
            newest_gamelog_for_character(&tmp.0, "Alice").expect("alice log"),
            newer
        );
    }

    #[test]
    fn pick_newest_gamelog_with_no_character_matches_plain_newest_gamelog() {
        let tmp = TmpDir::new("pick-newest-unset");
        touch_with_header(&tmp.0, "alice.txt", 30, "Alice");
        let newer = touch_with_header(&tmp.0, "bob.txt", 5, "Bob");

        assert_eq!(pick_newest_gamelog(&tmp.0, None).unwrap(), newer);
        assert_eq!(
            pick_newest_gamelog(&tmp.0, Some("Alice")).unwrap(),
            tmp.0.join("alice.txt")
        );
    }

    #[test]
    fn dps_list_logs_reads_each_files_character_from_its_header() {
        let tmp = TmpDir::new("list-logs-character");
        touch_with_header(&tmp.0, "alice.txt", 30, "Alice");
        touch(&tmp.0, "unattributed.txt", 20); // no header at all.

        let logs = dps_list_logs(tmp.0.to_string_lossy().into_owned()).expect("list logs");
        assert_eq!(logs.len(), 2);
        let alice = logs.iter().find(|l| l.name == "alice.txt").unwrap();
        assert_eq!(alice.character.as_deref(), Some("Alice"));
        let unattributed = logs.iter().find(|l| l.name == "unattributed.txt").unwrap();
        assert_eq!(unattributed.character, None);
    }

    #[test]
    fn dps_list_characters_dedupes_and_skips_stale_and_unattributed_logs() {
        let tmp = TmpDir::new("list-characters");
        // Two sessions for Alice within 24h — only one "Alice" in the result.
        touch_with_header(&tmp.0, "alice-1.txt", 60 * 60, "Alice");
        touch_with_header(&tmp.0, "alice-2.txt", 60, "Alice");
        touch_with_header(&tmp.0, "bob.txt", 30, "Bob");
        // Older than 24h — excluded even though it has a character.
        touch_with_header(&tmp.0, "carol-stale.txt", 25 * 60 * 60, "Carol");
        // No recognised header — excluded, never shown as "unattributed".
        touch(&tmp.0, "unattributed.txt", 10);

        let mut characters =
            dps_list_characters(tmp.0.to_string_lossy().into_owned()).expect("list characters");
        characters.sort();
        assert_eq!(characters, vec!["Alice".to_string(), "Bob".to_string()]);
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
        // Exercises the same `text.lines().flat_map(parse_line)` step
        // `load_and_resolve_events` runs, then feeds the result straight into
        // `bucket_events` — the whole non-Tauri pipeline `dps_log_summary`
        // wraps, on realistic gamelog markup (not synthetic DpsEvent structs).
        let text = "\
[ 2026.08.01 12:00:00 ] (combat) <color=0xff..><b>300</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xff..>Target[X](Cruiser)</b> - Blaster - Hits
[ 2026.08.01 12:02:00 ] (combat) <color=0xff..><b>50</b> <color=0x77ffffff><font size=10>from</font> <b><color=0xff..>Enemy[Y](Frigate)</b> - Hits
[ 2026.08.01 12:03:20 ] (mining) <color=0xff..><b>34</b> units of <color=0xff..>Veldspar</color>
[ 2026.08.01 12:09:59 ] (combat) <color=0xff..><b>100</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xff..>Target[X](Cruiser)</b> - Blaster - Hits
not a combat line, ignored";
        let mut events: Vec<_> = text.lines().flat_map(|l| parse_line(l, Lang::En)).collect();
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

    #[tokio::test]
    async fn scan_log_span_finds_exact_min_max_despite_local_disorder() {
        // #816: `stream_log_summary` needs the *exact* time span before it
        // can size buckets, and gamelog lines are only near-chronological —
        // this line order deliberately isn't sorted (12:05 arrives before
        // 12:02) to prove `scan_log_span` tracks true min/max, not just the
        // first/last line's timestamp.
        let tmp = TmpDir::new("scan-log-span");
        let path = tmp.0.join("gamelog.txt");
        let text = "\
[ 2026.08.01 12:00:00 ] (combat) <color=0xff..><b>300</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xff..>Target[X](Cruiser)</b> - Blaster - Hits
[ 2026.08.01 12:05:00 ] (combat) <color=0xff..><b>100</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xff..>Target[X](Cruiser)</b> - Blaster - Hits
[ 2026.08.01 12:02:00 ] (combat) <color=0xff..><b>50</b> <color=0x77ffffff><font size=10>from</font> <b><color=0xff..>Enemy[Y](Frigate)</b> - Hits
not a combat line, ignored";
        std::fs::write(&path, text).expect("write gamelog");

        let (start, end) = scan_log_span(path.to_str().expect("utf8 path"), Lang::En)
            .await
            .expect("file has combat lines");
        assert_eq!(end - start, 300); // 12:00:00 .. 12:05:00 (5 minutes)
    }

    #[tokio::test]
    async fn scan_log_span_errors_on_a_log_with_no_combat_lines() {
        let tmp = TmpDir::new("scan-log-span-empty");
        let path = tmp.0.join("gamelog.txt");
        std::fs::write(&path, "just some chat, no combat lines here\n").expect("write gamelog");

        assert!(scan_log_span(path.to_str().expect("utf8 path"), Lang::En)
            .await
            .is_err());
    }
}
