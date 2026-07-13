import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Which embedded engine runs a snippet. */
export type ScriptLanguage = "rhai" | "js";

/** A stored snippet. */
export interface Script {
  /** Stable slug id (blank when creating — the backend mints one). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** The engine this snippet targets. */
  language: ScriptLanguage;
  /** The snippet source. */
  code: string;
  /** Loop interval in **minutes**; `null` means "run manually only". */
  intervalMin: number | null;
  /** Whether the timed loop is armed ("Run" state; needs `intervalMinutes`). */
  enabled: boolean;
  /** Epoch seconds of the last save. */
  updatedAt: number;
}

/** The outcome of one execution. */
export interface ScriptRun {
  /** True when the snippet ran to completion without throwing. */
  ok: boolean;
  /** The snippet's return value (`null` when it returned nothing). */
  result: unknown;
  /** Lines emitted via the host `log()` function, in order. */
  logs: string[];
  /** The failure message when `ok` is false, else `null`. */
  error: string | null;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
}

/** Every stored script. */
export function scriptsList(): Promise<Script[]> {
  return invoke<Script[]>("scripts_list");
}

/** Create or update a script (upsert by id); returns the full updated set. */
export function scriptsSave(script: Script): Promise<Script[]> {
  return invoke<Script[]>("scripts_save", { script });
}

/** Delete a script (and its private store); returns what remains. */
export function scriptsDelete(id: string): Promise<Script[]> {
  return invoke<Script[]>("scripts_delete", { id });
}

/** A selectable example template shown in the editor. */
export interface ExampleScript {
  id: string;
  name: string;
  language: ScriptLanguage;
  code: string;
}

/** The bundled example scripts. */
export function scriptsExamples(): Promise<ExampleScript[]> {
  return invoke<ExampleScript[]>("scripts_examples");
}

/** Run a snippet once — a stored one by `id`, or ad-hoc `code` + `language`. */
export function scriptsRun(args: {
  id?: string;
  code?: string;
  language?: ScriptLanguage;
}): Promise<ScriptRun> {
  return invoke<ScriptRun>("scripts_run", { args });
}

/** A sound a script asked to play, as base64 data-URL parts. */
export interface PlaySoundEvent {
  mime: string;
  data: string;
}

/** Subscribe to sounds scripts request via `play_sound(path)`. */
export function onScriptSound(
  handler: (event: PlaySoundEvent) => void,
): Promise<UnlistenFn> {
  return listen<PlaySoundEvent>("scripts://play-sound", (event) =>
    handler(event.payload),
  );
}

/** A completed scheduled run, emitted by the Rust loop. */
export interface ScriptRunEvent {
  id: string;
  run: ScriptRun;
}

/** Subscribe to scheduled-run results from the background loop. */
export function onScriptRun(
  handler: (event: ScriptRunEvent) => void,
): Promise<UnlistenFn> {
  return listen<ScriptRunEvent>("scripts://run", (event) =>
    handler(event.payload),
  );
}
