import { memo } from "react";

/** Right-rail panel: player corporations in local with a negative (red) standing.
 *  Memoized: the parent re-renders on every textarea keystroke and poll tick;
 *  this panel's props (memoized corps list, stable onWatch) don't change then. */
export const HostileCorpsPanel = memo(function HostileCorpsPanel({
  corps,
  scanned,
  watchIds,
  onWatch,
}: {
  corps: { id: number; name: string; standing: number; count: number }[];
  scanned: boolean;
  watchIds: Set<number>;
  onWatch: (id: number, name: string) => void;
}) {
  return (
    <div className="border-b border-zinc-800 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-rose-400">
        Hostile corps
      </div>
      <div className="mb-2 text-[11px] text-zinc-500">
        player corps · red (standing &lt; 0)
      </div>
      {corps.length === 0 ? (
        <div className="text-xs text-zinc-600">
          {scanned ? "None in local." : "Scan to populate."}
        </div>
      ) : (
        <ul className="space-y-1">
          {corps.map((c) => (
            <li
              key={c.id}
              className="rounded border border-rose-900/40 bg-rose-950/20 px-2 py-1.5"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-sm text-zinc-200" title={c.name}>
                  {c.name}
                </span>
                <span className="shrink-0 tabular-nums text-xs text-rose-400">
                  {c.standing.toFixed(1)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[11px] text-zinc-500">
                <span>
                  {c.count} pilot{c.count === 1 ? "" : "s"} in local
                </span>
                {watchIds.has(c.id) ? (
                  <span className="text-amber-400">watched</span>
                ) : (
                  <button
                    onClick={() => onWatch(c.id, c.name)}
                    className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
                  >
                    +watch
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
