import { invoke } from "@tauri-apps/api/core";

/** One captured backend log record (matches the Rust LogEntry). */
export interface BackendLogEntry {
  id: number;
  /** Unix timestamp in milliseconds. */
  ts: number;
  /** "error" | "warn" */
  level: string;
  /** Rust module path. */
  target: string;
  message: string;
}

/** All captured backend log entries, oldest first. */
export function logsList(): Promise<BackendLogEntry[]> {
  return invoke<BackendLogEntry[]>("logs_list");
}

/** Clear all backend log entries. */
export function logsClear(): Promise<void> {
  return invoke<void>("logs_clear");
}
