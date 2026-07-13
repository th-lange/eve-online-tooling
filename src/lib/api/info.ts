import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Severity of an Info Panel entry. */
export type InfoKind = "alarm" | "message";

/** One entry in the Info Panel feed. */
export interface InfoEntry {
  /** Stable list key. */
  id: string;
  kind: InfoKind;
  text: string;
  /** Optional longer body — the output behind the headline (may be JSON). */
  detail: string | null;
  /** Who posted it, e.g. `script:my-script` or `plugin:pricing-model`. */
  source: string;
  /** Epoch seconds when posted. */
  at: number;
}

/** The Info Panel feed, newest first. */
export function infoList(): Promise<InfoEntry[]> {
  return invoke<InfoEntry[]>("info_list");
}

/** Empty the Info Panel feed. */
export function infoClear(): Promise<void> {
  return invoke<void>("info_clear");
}

/** Subscribe to live Info Panel entries (scripts emit these as they post). */
export function onInfoEntry(
  handler: (entry: InfoEntry) => void,
): Promise<UnlistenFn> {
  return listen<InfoEntry>("info://entry", (event) => handler(event.payload));
}
