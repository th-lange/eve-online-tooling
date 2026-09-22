import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// --- DPS meter (live combat log) ---

/** A weapon/ammo/drone damage row. `kind` is the source type (the ammo/drone's
 *  SDE group, e.g. "Rocket", "Hybrid Charge", "Light Scout Drone"); `damage` is
 *  the ammo's dominant damage type(s) (e.g. "Kin", "EM/Th"). The log names only
 *  the ammo, so both come from the SDE. */
export interface WeaponRate {
  name: string;
  dps: number;
  kind?: string;
  damage?: string;
}

/** Counts of each hit-quality tier within the window (worst→best). Misses
 *  come from the separate miss lines; the rest from the quality suffix. */
export interface HitQuality {
  misses: number;
  glances: number;
  grazes: number;
  hits: number;
  penetrates: number;
  smashes: number;
  wrecks: number;
}

/** Per-pilot engagement row (damage dealt to / taken from). */
export interface PilotRate {
  name: string;
  dpsOut: number;
  dpsIn: number;
  /** Ship type string parsed from `(SHIP)` in the combat log, if present. */
  ship?: string;
  /** Per-source damage you dealt to them (outgoing), each with its dps. */
  weaponsOut?: WeaponRate[];
  /** Per-source damage they dealt to you (incoming; named only for players —
   *  EVE never names an NPC's weapon). */
  weaponsIn?: WeaponRate[];
  /** Hit-quality tally of your hits on them. */
  qualityOut?: HitQuality;
  /** Hit-quality tally of their hits on you. */
  qualityIn?: HitQuality;
  /** You are scrambling / pointing them within the window. */
  scramOut?: boolean;
  pointOut?: boolean;
  /** They are scrambling / pointing you within the window. */
  scramIn?: boolean;
  pointIn?: boolean;
}

export interface DpsTick {
  dpsOut: number;
  dpsIn: number;
  logiOut: number;
  logiIn: number;
  capTransferOut: number;
  capTransferIn: number;
  capWarfareOut: number;
  capWarfareIn: number;
  /** Mined volume per second (m³/s). */
  miningM3: number;
  /** High-quality outgoing hits within the window. */
  hitsOut: HitQuality;
  /** High-quality incoming hits within the window. */
  hitsIn: HitQuality;
  /** Top weapons by outgoing DPS. */
  byWeapon: WeaponRate[];
  /** Top counterparties by engaged DPS. */
  byPilot: PilotRate[];
  /** The averaging window, echoed for labelling. */
  windowSecs: number;
  /** Epoch seconds this tick was computed at. */
  at: number;
}

/** Settings to start a capture. */
export interface DpsSettings {
  /** The EVE `Gamelogs` folder. */
  gamelogsDir: string;
  /** Moving-average window in seconds. */
  windowSecs: number;
}

/** A gamelog file (for status / future playback). */
export interface DpsLogFile {
  name: string;
  path: string;
  /** Epoch seconds of last modification. */
  modified: number;
}

/** Settings for replaying a past gamelog. */
export interface DpsPlaybackSettings {
  /** Absolute path to the gamelog (from {@link dpsListLogs}). */
  file: string;
  /** Replay speed multiplier (1.0 = real time). */
  speed: number;
  windowSecs: number;
  /** Start the virtual clock here instead of the file's first event (epoch
   *  seconds) — set when scrubbing the timeline slider. */
  seekTs?: number;
  /** Stop (and, if re-issued, loop) at this epoch second instead of the
   *  file's end — set when playing a selected fight region. */
  stopTs?: number;
}

/** One time bucket's activity, normalized 0..1 against that category's
 *  busiest bucket in the log — for the playback timeline density strip. */
export interface DpsEventBucket {
  /** Bucket start, epoch seconds. */
  at: number;
  damageOut: number;
  damageIn: number;
  mining: number;
}

/** A log's time span + activity buckets (see {@link dpsLogSummary}). */
export interface DpsLogSummary {
  start: number;
  end: number;
  buckets: DpsEventBucket[];
}

/** Start (or restart) tailing the newest gamelog. Ticks arrive via {@link onDpsTick}. */
export function dpsStart(settings: DpsSettings): Promise<void> {
  return invoke<void>("dps_start", { settings });
}

/** Replay a past gamelog at `speed`×; ticks arrive via {@link onDpsTick}. */
export function dpsPlayback(settings: DpsPlaybackSettings): Promise<void> {
  return invoke<void>("dps_playback", { settings });
}

/** Stop the active capture. */
export function dpsStop(): Promise<void> {
  return invoke<void>("dps_stop");
}

/** Freeze the active playback in place (true pause). */
export function dpsPause(): Promise<void> {
  return invoke<void>("dps_pause");
}

/** Continue a paused playback from exactly where it froze. */
export function dpsResume(): Promise<void> {
  return invoke<void>("dps_resume");
}

/** List gamelog files in a folder, newest first. */
export function dpsListLogs(gamelogsDir: string): Promise<DpsLogFile[]> {
  return invoke<DpsLogFile[]>("dps_list_logs", { gamelogsDir });
}

/** Time span + activity-density buckets for a log file, for the playback
 *  timeline slider. */
export function dpsLogSummary(file: string): Promise<DpsLogSummary> {
  return invoke<DpsLogSummary>("dps_log_summary", { file });
}

/** Byte size of a gamelog file — a cheap growth probe. The playback overview
 *  polls this to rebuild its summary while the log is still being written. */
export function dpsLogStat(file: string): Promise<number> {
  return invoke<number>("dps_log_stat", { file });
}

/** Subscribe to live DPS ticks. */
export function onDpsTick(
  handler: (tick: DpsTick) => void,
): Promise<UnlistenFn> {
  return listen<DpsTick>("dps://tick", (event) => handler(event.payload));
}

/** Subscribe to natural playback-end notifications (loop support). */
export function onDpsDone(handler: () => void): Promise<UnlistenFn> {
  return listen<void>("dps://done", () => handler());
}
