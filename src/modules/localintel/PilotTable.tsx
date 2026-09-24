import { memo } from "react";
import type { LocalPilot, ZkillStats } from "../../lib/api";

/** Memoized: a busy Local paste is 500-2,000 rows x 6 cells; without memo()
 *  every keystroke in the paste textarea and every 30s poll tick re-diffed the
 *  whole table even though its data hadn't changed. Props are kept stable in
 *  the parent (state Maps/Sets, useCallback'd isWatched/onWatch). */
export const PilotTable = memo(function PilotTable({
  pilots,
  zkill,
  zkillLoading,
  isWatched,
  newIds,
  onWatch,
}: {
  pilots: LocalPilot[];
  zkill: Map<number, ZkillStats>;
  zkillLoading: boolean;
  isWatched: (p: LocalPilot) => boolean;
  newIds: Set<number>;
  onWatch: (id: number, name: string) => void;
}) {
  return (
    <div className="mt-3 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Pilot</th>
            <th className="px-3 py-1.5 text-left font-medium">Corporation</th>
            <th className="px-3 py-1.5 text-left font-medium">Alliance</th>
            <th className="px-3 py-1.5 text-right font-medium">Standing</th>
            <th className="px-3 py-1.5 text-right font-medium">
              Danger{zkillLoading ? " …" : ""}
            </th>
            <th className="px-3 py-1.5 text-right font-medium">Watch</th>
          </tr>
        </thead>
        <tbody>
          {pilots.map((p) => {
            const z = zkill.get(p.characterId);
            return (
              <tr
                key={p.characterId}
                className={`border-t border-zinc-800 hover:bg-zinc-800/40 ${
                  isWatched(p) ? "bg-amber-950/30" : ""
                }`}
              >
                <td className="px-3 py-1.5">
                  <span className={dot(p.threat)}>●</span>{" "}
                  <a
                    href={`https://zkillboard.com/character/${p.characterId}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-zinc-200 hover:text-indigo-300"
                  >
                    {p.name}
                  </a>
                  {newIds.has(p.characterId) && (
                    <span
                      className="ml-2 rounded bg-amber-500/20 px-1 text-[10px] font-medium text-amber-300"
                      title="Entered Local since your last scan"
                    >
                      NEW
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-zinc-400">
                  {p.corporation || "—"}
                </td>
                <td className="px-3 py-1.5 text-zinc-400">
                  {p.alliance ?? "—"}
                </td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${standingColor(p.threat)}`}
                >
                  {p.standing == null ? "—" : p.standing.toFixed(1)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {z ? (
                    <span
                      className={dangerColor(z.dangerRatio)}
                      title={`${z.shipsDestroyed} kills / ${z.shipsLost} losses${z.active ? " · recently active" : ""}`}
                    >
                      {z.dangerRatio}%{z.active ? " ⚡" : ""}
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right text-xs">
                  {p.allianceId != null && (
                    <button
                      onClick={() =>
                        onWatch(
                          p.allianceId!,
                          p.alliance ?? `Alliance ${p.allianceId}`,
                        )
                      }
                      className="mr-1 rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
                      title="Watch this alliance"
                    >
                      +alliance
                    </button>
                  )}
                  {p.corporationId !== 0 && (
                    <button
                      onClick={() =>
                        onWatch(
                          p.corporationId,
                          p.corporation || `Corp ${p.corporationId}`,
                        )
                      }
                      className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
                      title="Watch this corporation"
                    >
                      +corp
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {pilots.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                No pilots resolved.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
});

function dot(threat: string): string {
  if (threat === "red") return "text-rose-500";
  if (threat === "blue") return "text-sky-400";
  return "text-zinc-500";
}
function standingColor(threat: string): string {
  if (threat === "red") return "text-rose-400";
  if (threat === "blue") return "text-sky-400";
  return "text-zinc-400";
}
/** zKill danger ratio → color: high = dangerous (red), low = soft target. */
function dangerColor(danger: number): string {
  if (danger >= 75) return "text-rose-400";
  if (danger >= 40) return "text-amber-400";
  return "text-zinc-400";
}
