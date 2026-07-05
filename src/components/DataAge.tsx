import { useEffect, useState } from "react";

/** Compact "X min/h/d ago" from a millisecond epoch timestamp. */
function agoMs(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Older than this and the label ambers to flag possibly-stale data. */
const STALE_MS = 10 * 60_000;

/**
 * A compact "Updated N ago" freshness label. Pass a query's `dataUpdatedAt`
 * (ms epoch) as `updatedAt`. It self-ticks every 30s and turns amber once the
 * data is older than ~10 minutes, so the user always knows how fresh the numbers
 * on screen are. Renders "Updating…" while a fetch is in flight, nothing before
 * the first load.
 */
export function DataAge({
  updatedAt,
  fetching,
}: {
  updatedAt?: number;
  fetching?: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (fetching) return <span className="text-xs text-zinc-500">Updating…</span>;
  if (!updatedAt) return null;

  const stale = Date.now() - updatedAt > STALE_MS;
  return (
    <span
      className={`text-xs ${stale ? "text-amber-400" : "text-zinc-500"}`}
      title={new Date(updatedAt).toLocaleString()}
    >
      Updated {agoMs(updatedAt)}
    </span>
  );
}
