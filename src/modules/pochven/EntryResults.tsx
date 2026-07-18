import { useMemo, useState } from "react";
import {
  SystemGraph,
  type SystemGraphEdge,
  type SystemGraphNode,
} from "../../components/SystemGraph";
import type { EntrySearch as EntrySearchResult } from "../../lib/api";
import { SEC_HEX, secBand } from "../../lib/security";
import { ZkillSystemLink } from "../../components/ZkillLink";
import { buildScanTree, computeGreenEdges, edgeKey, keptSets } from "./graph";

export function EntryResults({ data }: { data: EntrySearchResult }) {
  const originId = data.map.nodes.find((n) => n.origin)?.systemId ?? 0;
  const storeKey = `pochven.visited.${originId}`;
  const [visited, setVisited] = useState<Set<number>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey) ?? "[]");
      return new Set<number>(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  });
  const toggleVisited = (id: number) =>
    setVisited((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(storeKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  const clearVisited = () => {
    try {
      localStorage.removeItem(storeKey);
    } catch {
      /* ignore */
    }
    setVisited(new Set());
  };

  // Root the scan map at the origin so, for each edge, we know which candidates
  // lie beyond it (its subtree) — that drives the route colours (see graph.ts).
  const { parent, subtreeCands, candIds } = useMemo(() => {
    const candIds = new Set(
      data.map.nodes.filter((n) => n.candidate).map((n) => n.systemId),
    );
    return { ...buildScanTree(data.map.edges, originId, candIds), candIds };
  }, [data.map.edges, data.map.nodes, originId]);

  const [selected, setSelected] = useState<number[]>([]);

  // Target Pochven systems the user has narrowed to (empty = all of interest).
  const [interest, setInterest] = useState<Set<string>>(new Set());
  const toggleInterest = (name: string) =>
    setInterest((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // Candidate systemId → the Pochven systems its C729 leads into.
  const candLeads = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const n of data.map.nodes)
      if (n.candidate) m.set(n.systemId, n.leadsTo);
    return m;
  }, [data.map.nodes]);

  // Candidates "of interest": all, or only those leading to a picked target.
  const activeCandIds = useMemo(() => {
    const s = new Set<number>();
    for (const [id, leads] of candLeads)
      if (interest.size === 0 || leads.some((t) => interest.has(t))) s.add(id);
    return s;
  }, [candLeads, interest]);

  // Which map nodes/edges to actually draw: the routes from the origin to the
  // active candidates only (so narrowing the targets prunes the map).
  const kept = useMemo(
    () => keptSets(activeCandIds, parent, originId),
    [activeCandIds, parent, originId],
  );

  // Active candidates in scan (visit) order.
  const orderedCands = useMemo(
    () =>
      data.map.nodes
        .filter((n) => n.candidate && activeCandIds.has(n.systemId))
        .sort((a, b) => a.order - b.order)
        .map((n) => n.systemId),
    [data.map.nodes, activeCandIds],
  );

  // Number the unticked active candidates in scan order (what to visit next);
  // ticked ones show a check instead.
  const order = useMemo(() => {
    const m = new Map<number, number>();
    let n = 0;
    for (const id of orderedCands) if (!visited.has(id)) m.set(id, ++n);
    return m;
  }, [orderedCands, visited]);

  // Candidate rows to list: all, or only those leading to a picked target.
  const visibleCandidates = useMemo(
    () =>
      data.candidates.filter(
        (c) => interest.size === 0 || c.leadsTo.some((t) => interest.has(t)),
      ),
    [data.candidates, interest],
  );

  // The green route = the *next* jump(s) to make — or, with a candidate
  // selected, its previous- and next-jump legs (see graph.ts).
  const greenEdges = useMemo(
    () =>
      computeGreenEdges({
        parent,
        originId,
        orderedCands,
        visited,
        selected,
        candIds,
      }),
    [selected, candIds, orderedCands, visited, parent, originId],
  );

  const graphNodes: SystemGraphNode[] = data.map.nodes
    .filter((node) => kept.nodes.has(node.systemId))
    .map((node) => {
      const done = node.candidate && visited.has(node.systemId);
      const num = order.get(node.systemId);
      const prefix = node.origin
        ? "⌂ "
        : node.candidate
          ? done
            ? "✓ "
            : num != null
              ? `${num} `
              : ""
          : "";
      return {
        id: String(node.systemId),
        label: `${prefix}${node.name}`,
        kind:
          node.kind === "hisec" ||
          node.kind === "lowsec" ||
          node.kind === "nullsec"
            ? node.kind
            : "unknown",
        sub: node.candidate ? `→ ${node.leadsTo.join(" / ")}` : undefined,
        current: node.origin,
        accent: done ? "#34d399" : undefined,
      };
    });
  // Route colouring: green = the next jump(s) to make (or the selected system's
  // prev/next legs); hidden = the branch beyond is fully ticked; grey = a
  // pending route that isn't the immediate next hop.
  const graphEdges: SystemGraphEdge[] = data.map.edges.flatMap(([a, b]) => {
    const key = edgeKey(a, b);
    // Only draw edges on a route to an active (of-interest) candidate.
    if (!kept.edges.has(key)) return [];
    const isGreen = greenEdges.has(key);
    // The deeper endpoint owns the subtree this edge leads into.
    const child = parent.get(b) === a ? b : a;
    const served = subtreeCands.get(child) ?? new Set<number>();
    const stillNeeded = [...served].some(
      (c) => activeCandIds.has(c) && !visited.has(c),
    );
    if (!isGreen && !stillNeeded) return [];
    return [
      {
        source: String(a),
        target: String(b),
        variant: "stargate" as const,
        color: isGreen ? "#34d399" : "#52525b",
      },
    ];
  });

  if (data.candidates.length === 0)
    return (
      <div className="mt-4 text-sm text-zinc-400">
        No C729 candidates within {data.maxJumps} jumps — raise the max, move
        closer, or use a filament.
      </div>
    );

  return (
    <div className="mt-4 space-y-4">
      {/* Reachable Pochven target systems (via the in-range candidates). */}
      {data.targets.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">
              Pochven systems reachable within {data.maxJumps} jumps (
              {data.targets.length}) — click to focus
            </div>
            {interest.size > 0 && (
              <button
                onClick={() => setInterest(new Set())}
                className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                title="Show all reachable systems again"
              >
                Reset ({interest.size})
              </button>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {data.targets.map((t) => {
              const on = interest.has(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleInterest(t)}
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    on
                      ? "bg-sky-600 text-white"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {data.route.length > 1 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">
            Route to the nearest candidate ({data.route.length - 1} jumps)
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-sm">
            {data.route.map((s, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-zinc-600">→</span>}
                <span
                  className={
                    i === data.route.length - 1
                      ? "font-medium text-sky-300"
                      : "text-zinc-300"
                  }
                >
                  {s}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Scan map: grey = travel-through, coloured = candidate (numbered by what
          to scan next; ✓ once you've clicked it as searched). Route edges are
          green (still to reach), red (selected route) or hidden (branch done). */}
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-x-3 text-xs text-zinc-500">
          <span className="text-zinc-300">Scan map</span>
          <span>numbers = scan order · click a system to tick it ✓</span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-emerald-400" /> next
            jump(s)
          </span>
          <span>select a system → its prev/next legs</span>
          <span className="text-zinc-600">ticked routes hidden</span>
          {visited.size > 0 && (
            <button
              onClick={clearVisited}
              className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
              title="Clear all ✓ ticks"
            >
              Reset ticks ({visited.size})
            </button>
          )}
        </div>
        <SystemGraph
          nodes={graphNodes}
          edges={graphEdges}
          rootId={String(originId)}
          height={420}
          storageKey={`pochven-map-${originId}`}
          defaultMode="tree"
          onNodeClick={(id) => toggleVisited(Number(id))}
          onSelectionChange={(ids) =>
            setSelected((prev) => {
              // Bail (keep the same reference) when the selection is unchanged —
              // React Flow re-fires this on every internal node update, and a
              // fresh array each time would loop render → rebuild → re-fire.
              const next = ids.map(Number);
              return prev.length === next.length &&
                prev.every((v, i) => v === next[i])
                ? prev
                : next;
            })
          }
        />
      </div>

      <details>
        <summary className="cursor-pointer text-sm text-zinc-300 hover:text-zinc-100">
          Systems to jump &amp; scan ({visibleCandidates.length})
        </summary>
        <div className="mt-2 overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">#</th>
                <th className="px-3 py-1.5 text-left font-medium">System</th>
                <th className="px-3 py-1.5 text-left font-medium">Region</th>
                <th className="px-3 py-1.5 text-right font-medium">Sec</th>
                <th className="px-3 py-1.5 text-right font-medium">Jumps</th>
                <th className="px-3 py-1.5 text-right font-medium">Kills 1h</th>
                <th className="px-3 py-1.5 text-left font-medium">
                  C729 leads to
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleCandidates.map((c) => {
                const node = data.map.nodes.find((n) => n.name === c.system);
                const id = node?.systemId;
                const done = id != null && visited.has(id);
                const band = secBand(c.security);
                return (
                  <tr
                    key={c.system}
                    onClick={() => id != null && toggleVisited(id)}
                    className="cursor-pointer border-t border-zinc-800 text-zinc-300 hover:bg-zinc-800/40"
                  >
                    <td className="px-3 py-1.5 tabular-nums text-zinc-500">
                      {done ? "✓" : (id != null && order.get(id)) || "·"}
                    </td>
                    <td className="px-3 py-1.5 font-medium text-zinc-200">
                      {c.system}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-500">{c.region}</td>
                    <td
                      className="px-3 py-1.5 text-right tabular-nums"
                      style={{ color: SEC_HEX[band] }}
                    >
                      {c.security.toFixed(1)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {c.jumps}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        c.kills > 0 ? "text-rose-300" : "text-zinc-600"
                      }`}
                    >
                      {id != null ? (
                        <ZkillSystemLink systemId={id}>
                          {c.kills > 0 ? c.kills : "—"}
                        </ZkillSystemLink>
                      ) : c.kills > 0 ? (
                        c.kills
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-400">
                      {c.leadsTo.join(", ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
