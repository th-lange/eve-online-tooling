import { listen } from "@tauri-apps/api/event";
import { logStore, type LogLevel } from "./logStore";

function args2msg(args: unknown[]): string {
  return args
    .map((a) =>
      a instanceof Error
        ? a.message
        : typeof a === "string"
          ? a
          : String(a),
    )
    .join(" ");
}

/**
 * Install global error interceptors. Call once before React mounts.
 * - Wraps console.error / console.warn so existing callers are unaffected.
 * - Installs window.onerror and window.onunhandledrejection.
 * - Subscribes to the Tauri `logs://entry` event for backend entries.
 */
export function initLogCapture(): void {
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    origError(...args);
    logStore.push({
      ts: Date.now(),
      level: "error",
      source: "frontend",
      target: "console",
      message: args2msg(args),
    });
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    logStore.push({
      ts: Date.now(),
      level: "warn",
      source: "frontend",
      target: "console",
      message: args2msg(args),
    });
  };

  window.onerror = (_msg, source, _line, _col, error) => {
    logStore.push({
      ts: Date.now(),
      level: "error",
      source: "frontend",
      target: source ?? "window",
      message: error?.message ?? String(_msg),
    });
    return false;
  };

  window.onunhandledrejection = (event) => {
    logStore.push({
      ts: Date.now(),
      level: "error",
      source: "frontend",
      target: "promise",
      message:
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason),
    });
  };

  // Receive backend WARN/ERROR records in real-time.
  listen<BackendEntry>("logs://entry", (event) => {
    const p = event.payload;
    logStore.push({
      ts: p.ts,
      level: p.level as LogLevel,
      source: "backend",
      target: p.target,
      message: p.message,
    });
  }).catch(origError);
}

interface BackendEntry {
  id: number;
  ts: number;
  level: string;
  target: string;
  message: string;
}
