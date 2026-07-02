// Shared primitives + misc bridge helpers used across the api modules.
import { invoke } from "@tauri-apps/api/core";

/** Health-check the Rust bridge. Returns `"pong"`. */
export function ping(): Promise<string> {
  return invoke<string>("ping");
}

/** Best-guess default EVE log folder for prefilling the inputs, by OS. `kind` is
 *  `"chatlogs"` or `"gamelogs"`. Returns `null` when none can be guessed. */
export function eveDefaultLogDir(
  kind: "chatlogs" | "gamelogs",
): Promise<string | null> {
  return invoke<string | null>("eve_default_log_dir", { kind });
}

export type ListName = "blacklist" | "favorites";

export interface ListItem {
  typeId: number;
  name: string;
}

export interface IdName {
  id: number;
  name: string;
}
