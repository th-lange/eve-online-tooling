/**
 * Singleton in-memory log store for the frontend. Captures errors from
 * console intercepts, window error handlers, TanStack Query, and the Tauri
 * backend's `logs://entry` event (plus one initial `logs_list` backfill). Compatible with `useSyncExternalStore`.
 */

export type LogLevel = "error" | "warn";
export type LogSource = "frontend" | "backend";

export interface LogEntry {
  id: number;
  /** Unix timestamp in milliseconds. */
  ts: number;
  level: LogLevel;
  source: LogSource;
  /** Module path (backend) or component/hook label (frontend). */
  target: string;
  message: string;
  /** The backend `LogStore` id of a backend entry. The push event and the
   *  initial `logs_list` backfill can both deliver the same record; this is
   *  the dedup key. Absent on frontend entries. */
  backendId?: number;
}

const CAPACITY = 500;

let entries: LogEntry[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export const logStore = {
  push(entry: Omit<LogEntry, "id">): void {
    if (
      entry.backendId !== undefined &&
      entries.some((e) => e.backendId === entry.backendId)
    ) {
      return;
    }
    const id = nextId++;
    // Ring buffer: keep the most recent CAPACITY entries.
    const next = [...entries, { ...entry, id }];
    entries =
      next.length > CAPACITY ? next.slice(next.length - CAPACITY) : next;
    notify();
  },

  getSnapshot(): LogEntry[] {
    return entries;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  clear(): void {
    entries = [];
    notify();
  },
};
