import { useEffect, useState } from "react";
import { eveDefaultLogDir } from "./api";
import { STORAGE_KEYS } from "./storageKeys";

/**
 * Shared state for an EVE log folder path (Chatlogs or Gamelogs), used by
 * ShoppingPage's chat capture, LocalIntelPage, and DpsPage.
 *
 * Storage is a RAW STRING, not JSON — `STORAGE_KEYS.eveChatlogsDir` maps to
 * the legacy key `"eveLogsDir"`, whose existing values on disk are plain
 * unquoted paths. `usePersistentState` JSON-serializes on every change (see
 * its doc comment), which would both re-wrap the value in quotes and write on
 * every keystroke instead of on demand — either breaks that legacy value.
 * Don't swap this hook for `usePersistentState`.
 *
 * Persistence is explicit: nothing is written until `persist()` is called
 * (e.g. on submit / start / load), and the value is trimmed before it's
 * stored.
 *
 * Seed order on mount:
 *  - `"chatlogs"`: the saved chatlogs dir, else prefilled asynchronously from
 *    `eveDefaultLogDir("chatlogs")` once we have nothing.
 *  - `"gamelogs"`: the saved gamelogs dir, else the saved chatlogs dir with
 *    its trailing `Chatlogs` path segment swapped for `Gamelogs`, else
 *    prefilled asynchronously from `eveDefaultLogDir("gamelogs")` once we
 *    still have nothing.
 */
export function useEveLogDir(
  kind: "chatlogs" | "gamelogs",
): [string, (dir: string) => void, () => void] {
  const key =
    kind === "chatlogs"
      ? STORAGE_KEYS.eveChatlogsDir
      : STORAGE_KEYS.eveGamelogsDir;

  const [dir, setDir] = useState(() => {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    if (kind === "gamelogs") {
      const chat = localStorage.getItem(STORAGE_KEYS.eveChatlogsDir) ?? "";
      return chat ? chat.replace(/Chatlogs\/?$/i, "Gamelogs") : "";
    }
    return "";
  });

  // Prefill from the OS default when we still have nothing saved/derived.
  useEffect(() => {
    if (dir) return;
    eveDefaultLogDir(kind).then((d) => d && setDir(d));
  }, [dir, kind]);

  function persist() {
    localStorage.setItem(key, dir.trim());
  }

  return [dir, setDir, persist];
}
