import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import {
  dpsListCharacters,
  dpsListLogs,
  dpsLogSummary,
  dpsLogStat,
  dpsParseOverviewExport,
  dpsPause,
  dpsPlayback,
  dpsResume,
  dpsStart,
  dpsStop,
  dpsSetPlaybackSpeed,
  errorMessage,
  onDpsBuckets,
  onDpsDone,
  onDpsEvents,
  type DpsBucket,
  type DpsEvent,
  type DpsExtractionPlan,
  type DpsLogFile,
  type DpsLogSummary,
} from "../../lib/api";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { useEveLogDir } from "../../lib/useEveLogDir";
import { usePersistentState } from "../../lib/usePersistentState";
import {
  LOG_BUFFER,
  appendBuckets,
  appendEvents,
  type ChartLayout,
  type Mode,
} from "./dpsMeterShared";

/** Playback transport state + mutations: `dpsStart` / `dpsPause` /
 *  `dpsPlayback` / `dpsResume`, bucket/event buffering while hidden, the
 *  scrub/region/loop lifecycle, and the space-bar shortcut. Derived
 *  per-bucket stats (pilot classification, chart series, readout rates,
 *  mining) live in {@link ../useDpsPlaybackDerived.useDpsPlaybackDerived}. */
export function useDpsPlaybackState() {
  const [dir, setDir, persistDir] = useEveLogDir("gamelogs");
  // Overview-export-derived pilot/ship extraction plan (#869): the export
  // file path is persisted (like the gamelogs folder); the parsed plan
  // itself is not — it's re-derived from the file on load/change so a
  // stale localStorage blob can never drift from the file on disk.
  const [overviewFile, setOverviewFile] = usePersistentState<string>(
    STORAGE_KEYS.dpsOverviewExportFile,
    "",
  );
  // Selected character to follow (#870): persisted like the gamelogs
  // folder/overview export. Empty string = no selection, the unchanged
  // newest-file behavior. `characters` is the last-fetched distinct-character
  // listing (last 24h) the dropdown renders from.
  const [character, setCharacter] = usePersistentState<string>(
    STORAGE_KEYS.dpsCharacter,
    "",
  );
  const [characters, setCharacters] = useState<string[]>([]);
  const [extractionPlan, setExtractionPlan] =
    useState<DpsExtractionPlan | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The raw `dps://events` stream, capped — only the live-edge ghost reads
  // it now (#1004): the log itself renders from the buckets' own events
  // (#1000), so log segments and chart buckets are the same data.
  const [pendingEvents, setPendingEvents] = useState<DpsEvent[]>([]);
  // Finalized 5 s buckets (#983) — the whole session, in order; the bucket
  // chart scrolls over these and every readout derives from them (#984).
  const [buckets, setBuckets] = useState<DpsBucket[]>([]);
  // The displayed combat log IS the buckets' own events (#1000) — one source,
  // so a log segment and a chart bucket can never drift apart.
  const logEvents = useMemo(() => buckets.flatMap((b) => b.events), [buckets]);
  const [mode, setMode] = useState<Mode>("live");
  const [logs, setLogs] = useState<DpsLogFile[]>([]);
  const [file, setFile] = useState("");
  const [speed, setSpeed] = useState(4);
  const [selectedPilot, setSelectedPilot] = useState<string | null>(null);
  // Timeline summary for the selected playback file — activity buckets for
  // the scrubber's density strip; null while loading/unavailable (no chart).
  const [summary, setSummary] = useState<DpsLogSummary | null>(null);
  // Chart arrangement + breakdown mode — persisted so the meter opens how you
  // left it.
  const [chartLayout, setChartLayout] = usePersistentState<ChartLayout>(
    STORAGE_KEYS.dpsChartLayout,
    "side",
  );
  const [bySource, setBySource] = usePersistentState<boolean>(
    STORAGE_KEYS.dpsChartBySource,
    false,
  );
  const [miningInterval, setMiningInterval] = usePersistentState<15 | 30>(
    STORAGE_KEYS.dpsMiningInterval,
    30,
  );
  // Playback: paused state + saved position for resume; looping restarts
  // playback automatically when it ends naturally.
  const [paused, setPaused] = useState(false);
  const pausedAtRef = useRef<number | null>(null);

  /** Set the playback speed. While a replay is running (even paused), push it
   *  to the backend so the running loop re-times live — no restart, position
   *  preserved. Live capture ignores speed. */
  function changeSpeed(next: number) {
    setSpeed(next);
    if (mode === "playback" && (running || paused)) {
      void dpsSetPlaybackSpeed(next).catch((e) => setError(errorMessage(e)));
    }
  }
  const [looping, setLooping] = usePersistentState<boolean>(
    STORAGE_KEYS.dpsLooping,
    false,
  );
  // Selected fight region (playback bounds + overview zoom); null = whole log.
  const [region, setRegion] = useState<{ start: number; end: number } | null>(
    null,
  );
  // Scrubber cursor: where a slider seek parked the playhead while stopped
  // (seeking no longer autoplays). Cleared once playback takes over.
  const [seekPos, setSeekPos] = useState<number | null>(null);

  // The playhead, as event time: the end of the newest finalized bucket.
  const lastBucket = buckets[buckets.length - 1];
  const lastBucketEnd = lastBucket?.end;

  // The page stays mounted while backgrounded (ModuleHost), so without this it
  // would keep re-rendering off the feeds while invisible. Track the active
  // flag in a ref so the subscriptions read the latest value without
  // resubscribing, and buffer what arrives while hidden.
  const active = useContext(ModuleActiveContext);
  const activeRef = useRef(active);
  activeRef.current = active;
  const bufferedEventsRef = useRef<DpsEvent[]>([]);
  const bufferedBucketsRef = useRef<DpsBucket[]>([]);

  /** Parse `overviewFile` (or the given path) into an extraction plan;
   *  clears the plan and surfaces the error on failure so a stale/garbled
   *  export never silently reverts to the default scan without saying why. */
  async function loadOverviewExport(path = overviewFile) {
    if (!path.trim()) {
      setExtractionPlan(null);
      setOverviewError(null);
      return;
    }
    try {
      const plan = await dpsParseOverviewExport(path);
      setExtractionPlan(plan);
      setOverviewError(null);
    } catch (e) {
      setExtractionPlan(null);
      setOverviewError(errorMessage(e));
    }
  }

  /** Refresh the distinct-character listing (last 24h) for `dir` — the
   *  character dropdown's source (#870). A folder with no logs, or that
   *  isn't set yet, just clears the list rather than surfacing an error;
   *  this runs opportunistically alongside the folder field, not as a
   *  user-triggered action. */
  async function refreshCharacters() {
    if (!dir.trim()) {
      setCharacters([]);
      return;
    }
    try {
      const list = await dpsListCharacters(dir);
      setCharacters(Array.isArray(list) ? list : []);
    } catch {
      setCharacters([]);
    }
  }

  // Fetch the character list once on mount (if a folder was already
  // persisted from last session) so the dropdown isn't empty until the next
  // folder-field blur.
  useEffect(() => {
    if (dir.trim()) void refreshCharacters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-derive the plan from whatever export path was persisted last session,
  // once, on mount — so a saved overview export keeps working across restarts
  // without the user re-picking it.
  useEffect(() => {
    if (overviewFile.trim()) void loadOverviewExport(overviewFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Combat-log view: the raw events each poll parsed, for a scrolling
  // line-by-line log alongside the rate graph. Buffered while the page is
  // hidden so it doesn't re-render in the background.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onDpsEvents((batch) => {
      if (cancelled) return;
      if (!activeRef.current) {
        const buf = bufferedEventsRef.current;
        buf.push(...batch);
        if (buf.length > LOG_BUFFER) buf.splice(0, buf.length - LOG_BUFFER);
        return;
      }
      setPendingEvents((prev) => appendEvents(prev, batch, LOG_BUFFER));
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Fixed-grid 5 s buckets (#983): the page's single data feed — charts,
  // readouts, peaks, tackle, and mining all derive from these (#984). Same
  // hidden-page buffering as events; no cap — the whole session is kept
  // (12 buckets/minute) so the chart can scroll over all of it.
  useEffect(() => {
    // `cancelled` guards the async-subscribe race: StrictMode/HMR re-runs
    // this effect, and cleanup can fire BEFORE `onDpsBuckets` resolves — a
    // bare `unlisten?.()` would then be a no-op and the old listener leaks,
    // duplicating every bucket (the half-width chart + doubled log lines).
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onDpsBuckets((batch) => {
      if (cancelled) return;
      if (!activeRef.current) {
        bufferedBucketsRef.current.push(...batch);
        return;
      }
      setBuckets((prev) => appendBuckets(prev, batch));
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Stable ref for loop: always holds the current playback params so the
  // done-handler can restart without capturing stale closure values.
  const loopParamsRef = useRef({
    file,
    speed,
    looping,
    region,
    extractionPlan,
  });
  loopParamsRef.current = {
    file,
    speed,
    looping,
    region,
    extractionPlan,
  };

  // When playback ends naturally, mark as stopped and auto-loop if enabled.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onDpsDone(() => {
      if (cancelled) return;
      setRunning(false);
      const p = loopParamsRef.current;
      if (!p.looping) return;
      // Small pause so the final bucket renders before the restart clears it.
      setTimeout(() => {
        setPendingEvents([]);
        setBuckets([]);
        bufferedBucketsRef.current = [];
        setSelectedPilot(null);
        setPaused(false);
        void dpsPlayback({
          file: p.file,
          speed: p.speed,
          // Loop within the selected fight region if one is set, else replay
          // the whole log. Both bounds are i64 in Rust — round them.
          seekTs: p.region ? Math.round(p.region.start) : undefined,
          stopTs: p.region ? Math.round(p.region.end) : undefined,
          extractionPlan: p.extractionPlan ?? undefined,
        })
          .then(() => setRunning(true))
          .catch((e) => setError(errorMessage(e)));
      }, 350);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // On becoming visible again, flush whatever arrived while hidden in one update.
  useEffect(() => {
    if (!active) return;
    if (bufferedEventsRef.current.length > 0) {
      const buffered = bufferedEventsRef.current;
      bufferedEventsRef.current = [];
      setPendingEvents((prev) => appendEvents(prev, buffered, LOG_BUFFER));
    }
    if (bufferedBucketsRef.current.length > 0) {
      const buffered = bufferedBucketsRef.current;
      bufferedBucketsRef.current = [];
      setBuckets((prev) => appendBuckets(prev, buffered));
    }
  }, [active]);

  async function start() {
    setError(null);
    persistDir();
    setSelectedPilot(null);
    setPaused(false);
    setRegion(null);
    setSeekPos(null);
    pausedAtRef.current = null;
    // Buckets are a time axis for the whole session — a fresh capture must
    // not chart-gap against the previous one's grid.
    setBuckets([]);
    bufferedBucketsRef.current = [];
    setPendingEvents([]);
    try {
      await dpsStart({
        gamelogsDir: dir,
        extractionPlan: extractionPlan ?? undefined,
        character: character || undefined,
      });
      setRunning(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function stop() {
    // Remember where playback stopped so Play / Space resumes there instead of
    // restarting from the beginning (live capture has no position to resume).
    if (mode === "playback" && lastBucketEnd != null) {
      pausedAtRef.current = lastBucketEnd;
      setSeekPos(lastBucketEnd);
    }
    await dpsStop();
    setRunning(false);
    setPaused(false);
  }

  // Load the gamelog list when switching to playback (or when the folder is set).
  async function refreshLogs() {
    setError(null);
    try {
      const list = await dpsListLogs(dir);
      setLogs(list);
      if (list.length > 0 && !file) setFile(list[0].path);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Replay the log. `seekTs` starts the virtual clock mid-file (the bucket
   *  grid anchors there — buckets are self-contained, nothing to pre-warm);
   *  `stopTs` ends playback at a fight region's boundary. */
  async function playback(seekTs?: number, stopTs?: number) {
    setError(null);
    setPendingEvents([]);
    setBuckets([]);
    bufferedBucketsRef.current = [];
    setSelectedPilot(null);
    setPaused(false);
    setSeekPos(null);
    try {
      await dpsPlayback({
        file,
        speed,
        // Both bounds are i64 in Rust — the region/scrubber emit fractional
        // timestamps, so round before crossing the bridge.
        seekTs: seekTs == null ? undefined : Math.round(seekTs),
        stopTs: stopTs == null ? undefined : Math.round(stopTs),
        extractionPlan: extractionPlan ?? undefined,
      });
      setRunning(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Play the current context: the selected fight region, else the whole log
   *  (resuming from a parked scrubber cursor if there is one). */
  function playCurrent() {
    const from = seekPos ?? pausedAtRef.current ?? region?.start;
    void playback(from ?? undefined, region?.end);
  }

  /** Drag-select a fight on the overview: zoom to it and play (loop, if on)
   *  within it. */
  function selectRegion(regionStart: number, regionEnd: number) {
    setRegion({ start: regionStart, end: regionEnd });
    void playback(regionStart, regionEnd);
  }

  /** Clear the region — overview back to the whole log. */
  function clearRegion() {
    setRegion(null);
  }

  /** Scrub to a time WITHOUT starting playback — stop the loop (if any) and
   *  park the playhead so Play (or Space) starts from there. Not a frozen
   *  pause: the loop is torn down, so this shows Play, not Resume. */
  function seekTo(ts: number) {
    setSeekPos(ts);
    pausedAtRef.current = ts;
    if (running) {
      void dpsStop();
      setRunning(false);
    }
    setPaused(false);
  }

  /** True pause: freeze the backend loop in place. Resume continues from the
   *  exact same point — no re-seek, so the grid doesn't jump. */
  async function pause() {
    pausedAtRef.current = lastBucketEnd ?? null;
    setPaused(true);
    try {
      await dpsPause();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Continue a paused replay exactly where it froze. */
  async function resume() {
    setPaused(false);
    try {
      await dpsResume();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Space-bar transport: resume if paused, else pause (playback) / stop
   *  (live) if running, else start (live) / play the current context. `paused`
   *  is checked first because a true-paused loop is still "running". */
  function toggleTransport() {
    if (paused) {
      void resume();
    } else if (running) {
      if (mode === "live") void stop();
      else void pause();
    } else if (mode === "live") {
      if (dir.trim()) void start();
    } else if (file) {
      playCurrent();
    }
  }
  // Keep a live ref so the once-registered key listener never goes stale.
  const toggleTransportRef = useRef(toggleTransport);
  toggleTransportRef.current = toggleTransport;

  // Space toggles start/stop while the meter is the visible module and focus
  // isn't in a text field (so typing a folder path still inserts spaces).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (!activeRef.current) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      )
        return;
      e.preventDefault();
      toggleTransportRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Load the selected file's activity summary for the timeline scrubber
  // whenever it changes; cleared outside playback mode or on failure (the
  // timeline just doesn't render — it's a bonus, not required to play).
  useEffect(() => {
    // A new file (or leaving playback) invalidates any selected fight region
    // and the parked resume position.
    setRegion(null);
    setSeekPos(null);
    pausedAtRef.current = null;
    if (mode !== "playback" || !file) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      dpsLogSummary(file)
        .then((s) => {
          if (!cancelled) setSummary(s);
        })
        .catch(() => {
          if (!cancelled) setSummary(null);
        });
    void load();
    // The selected log may still be the live session's gamelog, which keeps
    // growing. Poll its byte size every 30 s and rebuild the overview (its
    // span is first→last entry) whenever it changed, so the density strip and
    // playhead positions stay correct instead of showing a stale snapshot.
    let lastSize = -1;
    void dpsLogStat(file)
      .then((n) => {
        lastSize = n;
      })
      .catch((e) => setError(errorMessage(e)));
    const poll = setInterval(() => {
      void dpsLogStat(file)
        .then((n) => {
          if (!cancelled && n !== lastSize) {
            lastSize = n;
            void load();
          }
        })
        .catch((e) => setError(errorMessage(e)));
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [mode, file]);

  function switchMode(m: Mode) {
    setMode(m);
    if (m === "playback") void refreshLogs();
  }

  return {
    dir,
    setDir,
    overviewFile,
    setOverviewFile,
    character,
    setCharacter,
    characters,
    refreshCharacters,
    extractionPlan,
    overviewError,
    loadOverviewExport,
    running,
    error,
    logEvents,
    pendingEvents,
    buckets,
    lastBucketEnd,
    mode,
    switchMode,
    logs,
    file,
    setFile,
    speed,
    setSpeed: changeSpeed,
    selectedPilot,
    setSelectedPilot,
    summary,
    chartLayout,
    setChartLayout,
    bySource,
    setBySource,
    miningInterval,
    setMiningInterval,
    paused,
    looping,
    setLooping,
    region,
    seekPos,
    start,
    stop,
    refreshLogs,
    playCurrent,
    selectRegion,
    clearRegion,
    seekTo,
    pause,
    resume,
  };
}
