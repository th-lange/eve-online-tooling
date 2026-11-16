import { useContext, useEffect, useState } from "react";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import { STORAGE_KEYS } from "../../lib/storageKeys";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The configured shared (sync) folder, or `null` when sync isn't active. */
function readSharedFolder(): string | null {
  const folder = readJson<string>(STORAGE_KEYS.syncFolder, "").trim();
  const enabled = readJson<boolean>(STORAGE_KEYS.syncEnabled, false);
  return enabled && folder !== "" ? folder : null;
}

/**
 * The shared folder notes should live in, per Settings → Sync (`null` = keep
 * notes on this device). The host keeps visited pages mounted, so the setting
 * is re-read whenever this module comes back on screen — otherwise a change
 * made in Settings would only show up after a restart.
 */
export function useSharedFolder(): string | null {
  const active = useContext(ModuleActiveContext);
  const [shared, setShared] = useState<string | null>(readSharedFolder);
  useEffect(() => {
    if (active) setShared(readSharedFolder());
  }, [active]);
  return shared;
}
