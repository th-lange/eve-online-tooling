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

/** What a parsed combat line represents — mirrors Rust's `EventKind`. */
export type DpsEventKind =
  | "damageOut"
  | "damageIn"
  | "repOut"
  | "repIn"
  | "capTransferOut"
  | "capTransferIn"
  | "capWarfareOut"
  | "capWarfareIn"
  | "scramOut"
  | "scramIn"
  | "pointOut"
  | "pointIn"
  | "mining";

/** One parsed combat-log line, for a scrolling log view (as opposed to the
 *  aggregated 5 s {@link DpsBucket}s). `pilot`/`ship`/`weapon` are
 *  populated for damage lines, `None` otherwise. */
export interface DpsEvent {
  /** Epoch seconds, parsed from the gamelog's own timestamp. */
  ts: number;
  kind: DpsEventKind;
  /** Damage/repair/capacitor amount, or mined units — always positive. */
  amount: number;
  pilot: string | null;
  ship: string | null;
  weapon: string | null;
  /** Hit quality on damage lines ("Grazes" … "Wrecks"); `null` otherwise. */
  quality: string | null;
  /** Mined ore type name (mining lines only). */
  ore: string | null;
  /** Mined volume in m³ (mining only). */
  volume: number;
}

/** One finalized, epoch-aligned 5-second slice of combat activity (#983) —
 *  the fixed time grid the detail charts draw on. All amount fields are
 *  absolute sums over the bucket (hp, GJ, m³); per-second rates are
 *  `sum / (end - start)`, derived at render time. Idle time arrives as
 *  explicit all-zero buckets, so the grid has no holes. */
export interface DpsBucket {
  /** Inclusive start (unix seconds, a multiple of 5). */
  start: number;
  /** Exclusive end: `start + 5`. */
  end: number;
  damageOut: number;
  damageIn: number;
  repOut: number;
  repIn: number;
  capTransferOut: number;
  capTransferIn: number;
  capWarfareOut: number;
  capWarfareIn: number;
  miningM3: number;
  /** Hit-quality tally of your hits within the bucket (#984). */
  hitsOut: HitQuality;
  /** Hit-quality tally of hits on you within the bucket. */
  hitsIn: HitQuality;
  /** Outgoing damage by weapon/ammo/drone — the rolling tick's row shape
   *  (fields are per-second rates); all rows, sorted by rate desc. */
  byWeapon: WeaponRate[];
  /** Per-pilot engagement rows (rates + tackle flags); all rows, sorted. */
  byPilot: PilotRate[];
  /** The raw combat-log events this bucket aggregates (#1000) — the log view
   *  renders straight from these, so log segments ARE chart buckets. */
  events: DpsEvent[];
}

/** A ship-label field from an overview export (#869); `"other"` covers any
 *  label this app doesn't capture (faction, custom-pack extra slots, …) —
 *  its separators still occupy space in the parsed layout. */
export type DpsLabelField =
  "pilotName" | "shipType" | "shipName" | "corporation" | "alliance" | "other";

/** One enabled label in a user's overview export, in `shipLabelOrder`'s
 *  order: which field it is and the literal text EVE renders immediately
 *  before/after its value. */
export interface DpsPlanField {
  field: DpsLabelField;
  pre: string;
  post: string;
}

/** Ordered pilot/ship label layout parsed from a user's overview export
 *  (see {@link dpsParseOverviewExport}), stored alongside DPS settings and
 *  passed back into {@link dpsStart}/{@link dpsPlayback}. */
export interface DpsExtractionPlan {
  fields: DpsPlanField[];
}

/** Settings to start a capture. */
export interface DpsSettings {
  /** The EVE `Gamelogs` folder. */
  gamelogsDir: string;
  /** Overview-export-derived pilot/ship extraction plan (#869); omitted
   *  keeps the default `NAME[CORP](SHIP)` scan. */
  extractionPlan?: DpsExtractionPlan;
  /** Follow this character's newest gamelog instead of the raw newest file
   *  (#870); omitted keeps the unchanged newest-file behavior. */
  character?: string;
}

/** A gamelog file (for status / future playback). */
export interface DpsLogFile {
  name: string;
  path: string;
  /** Epoch seconds of last modification. */
  modified: number;
  /** The character named in the file's `Listener:` header, when recognised
   *  (#870); `undefined` for a log whose header doesn't map to a known
   *  phrase — the file still lists, it's just unattributed. */
  character?: string;
}

/** Settings for replaying a past gamelog. */
export interface DpsPlaybackSettings {
  /** Absolute path to the gamelog (from {@link dpsListLogs}). */
  file: string;
  /** Replay speed multiplier (1.0 = real time). */
  speed: number;
  /** Start the virtual clock here instead of the file's first event (epoch
   *  seconds) — set when scrubbing the timeline slider. */
  seekTs?: number;
  /** Stop (and, if re-issued, loop) at this epoch second instead of the
   *  file's end — set when playing a selected fight region. */
  stopTs?: number;
  /** Overview-export-derived pilot/ship extraction plan (#869); omitted
   *  keeps the default `NAME[CORP](SHIP)` scan. */
  extractionPlan?: DpsExtractionPlan;
}

/** One fixed, epoch-aligned 1-minute overview segment with **absolute**
 *  sums (#985) — normalization for display happens at render time, at the
 *  active 10^x grouping level. Contiguous; idle minutes are zero segments. */
export interface DpsOverviewSegment {
  /** Segment start, epoch seconds (a multiple of 60). */
  start: number;
  damageOut: number;
  damageIn: number;
  /** Mined volume (m³). */
  mining: number;
}

/** A log's time span + its fixed 1-minute segments (see {@link dpsLogSummary}). */
export interface DpsLogSummary {
  start: number;
  end: number;
  /** Fixed 1-minute segments the overview renders and zooms on (#985). */
  segments: DpsOverviewSegment[];
}

/** Start (or restart) tailing the newest gamelog. Buckets arrive via {@link onDpsBuckets}. */
export function dpsStart(settings: DpsSettings): Promise<void> {
  return invoke<void>("dps_start", { settings });
}

/** Replay a past gamelog at `speed`×; buckets arrive via {@link onDpsBuckets}. */
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

/** Adjust the running replay's speed live (no restart; next ~500 ms tick). */
export function dpsSetPlaybackSpeed(speed: number): Promise<void> {
  return invoke<void>("dps_set_playback_speed", { speed });
}

/** List gamelog files in a folder, newest first. */
export function dpsListLogs(gamelogsDir: string): Promise<DpsLogFile[]> {
  return invoke<DpsLogFile[]>("dps_list_logs", { gamelogsDir });
}

/** Distinct characters seen in a gamelog modified within the last 24h
 *  (#870) — the character picker's dropdown source. */
export function dpsListCharacters(gamelogsDir: string): Promise<string[]> {
  return invoke<string[]>("dps_list_characters", { gamelogsDir });
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

/** Parse an overview export file (YAML, from the overview settings window's
 *  "Export Overview Settings" button) into an extraction plan (#869). */
export function dpsParseOverviewExport(
  path: string,
): Promise<DpsExtractionPlan> {
  return invoke<DpsExtractionPlan>("dps_parse_overview_export", { path });
}

/** Subscribe to raw combat-log events — one batch per poll, in the order
 *  they'll land in the next bucket, for a scrolling log view. */
export function onDpsEvents(
  handler: (events: DpsEvent[]) => void,
): Promise<UnlistenFn> {
  return listen<DpsEvent[]>("dps://events", (event) => handler(event.payload));
}

/** Subscribe to finalized 5 s buckets — one batch per poll (usually a single
 *  bucket, more after a seek or at high playback speed). */
export function onDpsBuckets(
  handler: (buckets: DpsBucket[]) => void,
): Promise<UnlistenFn> {
  return listen<DpsBucket[]>("dps://buckets", (event) =>
    handler(event.payload),
  );
}

/** `dps://source` payload: the gamelog the live capture currently follows,
 *  with the character its `Listener:` header names (null when the header
 *  isn't recognised). */
export interface DpsSource {
  path: string;
  character: string | null;
}

/** Subscribe to capture-source changes — emitted when the live capture picks
 *  its gamelog and on every hot-swap to a newer session log. The recording
 *  character filter keys off this. */
export function onDpsSource(
  handler: (source: DpsSource) => void,
): Promise<UnlistenFn> {
  return listen<DpsSource>("dps://source", (event) => handler(event.payload));
}

/** Subscribe to natural playback-end notifications (loop support). */
export function onDpsDone(handler: () => void): Promise<UnlistenFn> {
  return listen<void>("dps://done", () => handler());
}
