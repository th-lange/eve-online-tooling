import { useCallback, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { infoList, type InfoEntry } from "../../lib/api";
import { InfoAlertsContext } from "./infoContext";

const SEEN_KEY = "eve.info.seenAlarmId";

/**
 * Tracks unseen **alarms** so the Info Panel nav entry can show a badge.
 * Mounted at the app root: it polls the feed (so plugin-posted alarms, which
 * don't emit an event, still count) and the runner's live event prepends keep
 * it current. "Seen" is the newest alarm id at the moment the panel was viewed,
 * persisted so it survives reloads.
 */
export function InfoAlertsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const feed = useQuery({
    queryKey: ["info"],
    queryFn: infoList,
    refetchInterval: 4000,
  });
  const [seenId, setSeenId] = useState<string | null>(() =>
    localStorage.getItem(SEEN_KEY),
  );

  const alarms = (feed.data ?? []).filter((e) => e.kind === "alarm"); // newest first
  const seenIdx = seenId ? alarms.findIndex((a) => a.id === seenId) : -1;
  // Entries newer than the last-seen alarm (all of them if it's unknown/absent).
  const unseen = seenIdx === -1 ? alarms.length : seenIdx;
  // Persists across "seen" — a red bell means the feed has *something*, the
  // numeric badge means there's something *new*.
  const hasEntries = (feed.data ?? []).length > 0;

  const markSeen = useCallback(() => {
    const data = qc.getQueryData<InfoEntry[]>(["info"]) ?? [];
    const newest = data.find((e) => e.kind === "alarm")?.id ?? null;
    setSeenId(newest);
    if (newest) localStorage.setItem(SEEN_KEY, newest);
    else localStorage.removeItem(SEEN_KEY);
  }, [qc]);

  return (
    <InfoAlertsContext.Provider value={{ unseen, hasEntries, markSeen }}>
      {children}
    </InfoAlertsContext.Provider>
  );
}
