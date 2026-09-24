import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import type { NeighbourNode } from "../../lib/api";
import { SEC_TEXT_CLASS, secBand } from "../../lib/security";

/**
 * Right-rail panel: recent ship/pod kills (CCP hourly, k-space) in systems
 * within N jumps of the active character's current location — "what's happening
 * around me" while watching Local. Empty in wormholes (no stargate graph / no
 * k-space kill data).
 */
export function NeighbourhoodPanel({
  here,
  nodes,
  depth,
  onDepth,
  loading,
  locError,
  onRefresh,
}: {
  here?: { systemId: number; name: string; security: number };
  nodes?: NeighbourNode[];
  depth: number;
  onDepth: (d: number) => void;
  loading: boolean;
  locError: boolean;
  onRefresh: () => void;
}) {
  const nearby = useMemo(
    () =>
      [...(nodes ?? [])]
        .filter((n) => n.distance > 0)
        .sort(
          (a, b) =>
            b.shipKills + b.podKills - (a.shipKills + a.podKills) ||
            a.distance - b.distance ||
            a.name.localeCompare(b.name),
        )
        .slice(0, 15),
    [nodes],
  );

  return (
    <div className="p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
          Neighbourhood
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh location + nearby activity"
          className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>
      <div className="mb-2 flex items-center gap-1 text-[11px] text-zinc-500">
        kills/hr · ≤
        {[1, 2, 3].map((d) => (
          <button
            key={d}
            onClick={() => onDepth(d)}
            className={`rounded px-1 ${
              depth === d
                ? "bg-zinc-700 text-zinc-100"
                : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {d}
          </button>
        ))}
        jumps
      </div>

      {locError || !here ? (
        <div className="text-xs text-zinc-600">
          Needs your in-game location (the{" "}
          <code>esi-location.read_location.v1</code> scope) — set an active
          character and re-login if just enabled.
        </div>
      ) : (
        <>
          <div className="mb-1 text-xs text-zinc-400">
            You:{" "}
            <a
              href={`https://zkillboard.com/system/${here.systemId}/`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-zinc-200 hover:text-indigo-300"
              title="Recent kills in this system on zKillboard"
            >
              {here.name}
              <ExternalLink size={10} className="opacity-60" />
            </a>{" "}
            <span
              className={`tabular-nums ${SEC_TEXT_CLASS[secBand(here.security)]}`}
            >
              {here.security.toFixed(1)}
            </span>
          </div>
          {nearby.length === 0 ? (
            <div className="text-xs text-zinc-600">
              {loading ? "Loading…" : "Quiet — no kills nearby this hour."}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {nearby.map((n) => (
                <li
                  key={n.systemId}
                  className="flex items-center justify-between gap-1 text-xs"
                >
                  <span
                    className="min-w-0 truncate text-zinc-300"
                    title={`${n.name} · ${n.region}`}
                  >
                    <span className={SEC_TEXT_CLASS[secBand(n.security)]}>
                      •
                    </span>{" "}
                    <a
                      href={`https://zkillboard.com/system/${n.systemId}/`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-indigo-300"
                    >
                      {n.name}
                    </a>{" "}
                    <span className="text-zinc-600">{n.distance}j</span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {n.podKills > 0 && (
                      <span className="text-rose-400" title="pod kills">
                        💀{n.podKills}{" "}
                      </span>
                    )}
                    {n.shipKills > 0 && (
                      <span className="text-amber-400" title="ship kills">
                        ⚔{n.shipKills}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
