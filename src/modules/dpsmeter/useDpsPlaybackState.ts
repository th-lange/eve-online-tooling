import { useContext, useEffect, useRef, useState } from "react";
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
  errorMessage,
  onDpsDone,
  onDpsTick,
  type DpsExtractionPlan,
  type DpsLogFile,
  type DpsLogSummary,
  type DpsTick,
} from "../../lib/api";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { useEveLogDir } from "../../lib/useEveLogDir";
import { usePersistentState } from "../../lib/usePersistentState";
import {
  BUFFER,
  MINING_BUCKET_SECS,
  appendTick,
  type ChartLayout,
  type Mode,
} from "./dpsMeterShared";

/** Playback transport state + mutations: `dpsStart` / `dpsPause` /
 *  `dpsPlayback` / `dpsResume`, tick buffering while hidden, the scrub/
 *  region/loop lifecycle, and the space-bar shortcut. Derived per-tick stats
 *  (pilot classification, chart series, mining) live in
 *  {@link ../useDpsPlaybackDerived.useDpsPlaybackDerived}. */
export function useDpsPlaybackState() {
  const [dir, setDir, persistDir] = useEveLogDir("gamelogs");
  const [windowSecs, setWindowSecs] = useState(() =>
    Number(localStorage.getItem(STORAGE_KEYS.dpsWindowSecs) ?? 10),
  );
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
  const [ticks, setTicks] = useState<DpsTick[]>([]);
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

  const latest = ticks[ticks.length - 1];

  // The page stays mounted while backgrounded (ModuleHost), so without this it
  // would keep re-rendering ~2×/s off the tick feed while invisible. Track the
  // active flag in a ref so the single subscription reads the latest value
  // without resubscribing, and buffer ticks that arrive while hidden.
  const active = useContext(ModuleActiveContext);
  const activeRef = useRef(active);
  activeRef.current = active;
  const bufferedRef = useRef<DpsTick[]>([]);
  // Session peaks for the two primary readouts (reset on Start / Play).
  const peaksRef = useRef({ out: 0, in: 0 });
  // Mined volume per 15 s bucket (bucket start-epoch → m³), session-lifetime.
  // Accumulated in the tick subscription (not from the `ticks` state) so mining
  // history is not capped by the 2-min chart buffer and keeps counting while
  // the page is hidden. Reset on Start / Play.
  const miningRef = useRef<{
    buckets: Map<number, number>;
    lastAt: number | null;
  }>({
    buckets: new Map(),
    lastAt: null,
  });

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

  // Subscribe once; the feed survives navigation. Ticks only arrive while a
  // capture is running.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onDpsTick((t) => {
      const peaks = peaksRef.current;
      peaks.out = Math.max(peaks.out, t.dpsOut);
      peaks.in = Math.max(peaks.in, t.dpsIn);
      // Integrate the windowed mining rate into interval buckets: rate × the
      // gap since the previous tick (clamped — a stall must not book a huge
      // spurious volume into one bucket).
      const mining = miningRef.current;
      const dt =
        mining.lastAt == null
          ? 0
          : Math.min(Math.max(t.at - mining.lastAt, 0), 5);
      mining.lastAt = t.at;
      if (t.miningM3 > 0 && dt > 0) {
        const bucket =
          Math.floor(t.at / MINING_BUCKET_SECS) * MINING_BUCKET_SECS;
        mining.buckets.set(
          bucket,
          (mining.buckets.get(bucket) ?? 0) + t.miningM3 * dt,
        );
      }
      if (!activeRef.current) {
        // Hidden: accumulate without triggering a render; flushed on re-show.
        const buf = bufferedRef.current;
        buf.push(t);
        if (buf.length > BUFFER) buf.splice(0, buf.length - BUFFER);
        return;
      }
      setTicks((prev) => appendTick(prev, t));
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // Stable ref for loop: always holds the current playback params so the
  // done-handler can restart without capturing stale closure values.
  const loopParamsRef = useRef({
    file,
    speed,
    windowSecs,
    looping,
    region,
    extractionPlan,
  });
  loopParamsRef.current = {
    file,
    speed,
    windowSecs,
    looping,
    region,
    extractionPlan,
  };

  // When playback ends naturally, mark as stopped and auto-loop if enabled.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onDpsDone(() => {
      setRunning(false);
      const p = loopParamsRef.current;
      if (!p.looping) return;
      // Small pause so the final tick renders before the restart clears ticks.
      setTimeout(() => {
        setTicks([]);
        peaksRef.current = { out: 0, in: 0 };
        miningRef.current = { buckets: new Map(), lastAt: null };
        setSelectedPilot(null);
        setPaused(false);
        void dpsPlayback({
          file: p.file,
          speed: p.speed,
          windowSecs: p.windowSecs,
          // Loop within the selected fight region if one is set, else replay
          // the whole log. Both bounds are i64 in Rust — round them.
          seekTs: p.region ? Math.round(p.region.start) : undefined,
          stopTs: p.region ? Math.round(p.region.end) : undefined,
          extractionPlan: p.extractionPlan ?? undefined,
        })
          .then(() => setRunning(true))
          .catch((e) => setError(errorMessage(e)));
      }, 350);
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // On becoming visible again, flush whatever arrived while hidden in one update.
  useEffect(() => {
    if (!active || bufferedRef.current.length === 0) return;
    const buffered = bufferedRef.current;
    bufferedRef.current = [];
    setTicks((prev) => {
      const merged = prev.concat(buffered);
      return merged.length > BUFFER
        ? merged.slice(merged.length - BUFFER)
        : merged;
    });
  }, [active]);

  async function start(win = windowSecs) {
    setError(null);
    persistDir();
    localStorage.setItem(STORAGE_KEYS.dpsWindowSecs, String(win));
    peaksRef.current = { out: 0, in: 0 };
    miningRef.current = { buckets: new Map(), lastAt: null };
    setSelectedPilot(null);
    setPaused(false);
    setRegion(null);
    setSeekPos(null);
    pausedAtRef.current = null;
    try {
      await dpsStart({
        gamelogsDir: dir,
        windowSecs: win,
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
    if (mode === "playback" && latest) {
      pausedAtRef.current = latest.at;
      setSeekPos(latest.at);
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

  /** Replay the log. `seekTs` starts the virtual clock mid-file (the backend
   *  pre-warms the window so the readout isn't cold); `stopTs` ends playback
   *  at a fight region's boundary; `win` overrides the averaging window so a
   *  live window change can restart cleanly. */
  async function playback(seekTs?: number, stopTs?: number, win = windowSecs) {
    setError(null);
    setTicks([]);
    peaksRef.current = { out: 0, in: 0 };
    miningRef.current = { buckets: new Map(), lastAt: null };
    setSelectedPilot(null);
    setPaused(false);
    setSeekPos(null);
    try {
      await dpsPlayback({
        file,
        speed,
        windowSecs: win,
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

  /** Change the moving-average window. Applies live by restarting the current
   *  capture/playback (the window is baked into the backend loop). */
  function setWindow(win: number) {
    setWindowSecs(win);
    localStorage.setItem(STORAGE_KEYS.dpsWindowSecs, String(win));
    if (!running) return;
    if (mode === "live") void start(win);
    else void playback(latest?.at ?? region?.start, region?.end, win);
  }

  /** True pause: freeze the backend loop in place (the graph + window are kept
   *  intact). Resume continues from the exact same point — no re-seek, so the
   *  DPS doesn't jump. */
  async function pause() {
    pausedAtRef.current = latest?.at ?? null;
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
      .catch(() => {});
    const poll = setInterval(() => {
      void dpsLogStat(file)
        .then((n) => {
          if (!cancelled && n !== lastSize) {
            lastSize = n;
            void load();
          }
        })
        .catch(() => {});
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
    windowSecs,
    setWindow,
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
    ticks,
    mode,
    switchMode,
    logs,
    file,
    setFile,
    speed,
    setSpeed,
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
    latest,
    miningRef,
    peakOut: peaksRef.current.out,
    peakIn: peaksRef.current.in,
  };
}
