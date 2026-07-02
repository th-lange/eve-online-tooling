import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// --- DPS meter (live combat log) ---

/** Per-weapon outgoing DPS row. */
export interface WeaponRate {
  name: string;
  dps: number;
}

/** Per-pilot engagement row (damage dealt to / taken from). */
export interface PilotRate {
  name: string;
  dpsOut: number;
  dpsIn: number;
}

/** One live sample: per-second rates over the averaging window. */
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

/** List gamelog files in a folder, newest first. */
export function dpsListLogs(gamelogsDir: string): Promise<DpsLogFile[]> {
  return invoke<DpsLogFile[]>("dps_list_logs", { gamelogsDir });
}

/** Subscribe to live DPS ticks. */
export function onDpsTick(handler: (tick: DpsTick) => void): Promise<UnlistenFn> {
  return listen<DpsTick>("dps://tick", (event) => handler(event.payload));
}
