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

export type ListModule =
  "trading" | "daytrading" | "reprocessing" | "production";

/** Contents of a saved list (blacklist/favorites), with names. */
export function getList(
  module: ListModule,
  list: ListName,
): Promise<ListItem[]> {
  return invoke<ListItem[]>(`${module}_get_list`, { list });
}

/** Add/remove a type (or blueprint type, for production) from a saved list. */
export function setList(
  module: ListModule,
  list: ListName,
  typeId: number,
  add: boolean,
): Promise<void> {
  return invoke<void>(`${module}_set_list`, { list, typeId, add });
}

export interface ListItem {
  typeId: number;
  name: string;
}

export interface IdName {
  id: number;
  name: string;
}

/**
 * Structured command error mirroring the Rust `AppError` (#337). Commands that
 * have migrated reject with this shape; others still reject with a plain string,
 * so use the helpers below rather than reading fields directly.
 */
export interface AppError {
  kind: "authRequired" | "message";
  message: string;
}

function isAppError(e: unknown): e is AppError {
  return (
    !!e &&
    typeof e === "object" &&
    typeof (e as AppError).kind === "string" &&
    typeof (e as AppError).message === "string"
  );
}

/** True when the failure is "no character logged in / scope not granted". */
export function isAuthRequired(e: unknown): boolean {
  return isAppError(e) && e.kind === "authRequired";
}

/** A human-readable message for any command rejection (structured or string). */
export function errorMessage(e: unknown): string {
  return isAppError(e) ? e.message : String(e);
}
