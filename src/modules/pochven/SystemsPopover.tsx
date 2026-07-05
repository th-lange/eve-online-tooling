import { Fragment, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  SystemGraph,
  type SystemGraphEdge,
  type SystemGraphNode,
} from "../../components/SystemGraph";
import { pochvenMap } from "../../lib/api";
import {
  INTERNAL,
  POCHVEN_ENTRY_COUNTS,
  POCHVEN_META,
  POCHVEN_SYSTEMS,
  pochvenTriangle,
  systemsByClade,
  systemsByRole,
} from "./data";
import {
  BAND_HEX,
  CLADE_HEX,
  CLADE_KRAI,
  ROLE_HEX,
  systemVisual,
} from "./visual";
import { homeTriangleLayout } from "./graph";

// Centred popover: the 27 Pochven systems + their internal connections, coloured
// by the security you can enter each from (full colour = enterable from k-space,
// outline = internal-only).
export function PochvenSystemsPopover() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Real Pochven gate links from the SDE, laid out as a triangle whose corners
  // are the three clade home systems (Kino / Archee / Niarja). Every other
  // system is aligned on the straight line between the two homes it is gate-
  // nearest to, evenly spaced along that line. Falls back to a schematic
  // triangle while the SDE data loads.
  const topo = useQuery({
    queryKey: ["pochven", "map"],
    queryFn: pochvenMap,
    staleTime: 24 * 60 * 60_000,
    enabled: open,
  });

  // Which filaments drop you into each system (by its role / clade), and the
  // pool each one can land in. Click a row to expand.
  const byRole = useMemo(() => systemsByRole(), []);
  const byClade = useMemo(() => systemsByClade(), []);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Outbound 'Extraction' filament targets (k-space within 2.5 ly), per system.
  const exitsByName = useMemo(
    () =>
      new Map(
        (topo.data?.systems ?? []).map((s) => [s.name, s.exits] as const),
      ),
    [topo.data],
  );

  const { nodes, edges } = useMemo(() => {
    // Use the real SDE map only when it carries both systems and gate links;
    // otherwise keep the schematic triangle so the map never looks disconnected.
    if (topo.data && topo.data.systems.length && topo.data.edges.length) {
      const sys = topo.data.systems;
      // Homes at the triangle corners, everything else aligned on the edges
      // between its two nearest homes (see graph.ts).
      const posOf = homeTriangleLayout(sys, topo.data.edges);
      const nodes: SystemGraphNode[] = sys.map((s) => {
        const p = posOf.get(s.systemId) ?? { x: 0, y: 0 };
        return {
          id: String(s.systemId),
          label: s.name,
          x: p.x,
          y: p.y,
          ...systemVisual(s.name),
          kind: systemVisual(s.name).kind ?? "unknown",
        };
      });
      const edges: SystemGraphEdge[] = topo.data.edges.map(([a, b]) => ({
        source: String(a),
        target: String(b),
        variant: "stargate" as const,
      }));
      return { nodes, edges };
    }
    // Fallback schematic triangle (name-keyed) until the SDE map arrives.
    const tri = pochvenTriangle();
    const nodes: SystemGraphNode[] = POCHVEN_SYSTEMS.map((s) => ({
      id: s.name,
      label: s.name,
      x: tri.pos[s.name]?.x,
      y: tri.pos[s.name]?.y,
      ...systemVisual(s.name),
      kind: systemVisual(s.name).kind ?? "unknown",
    }));
    const edges: SystemGraphEdge[] = tri.edges.map(([a, b]) => ({
      source: a,
      target: b,
      variant: "wormhole" as const,
    }));
    return { nodes, edges };
  }, [topo.data]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-sm text-sky-400 hover:text-sky-300"
      >
        All 27 Pochven systems — map &amp; C729 spawn regions →
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            onClick={() => setOpen(false)}
          >
            <div className="absolute inset-0 bg-black/60" />
            <div
              role="dialog"
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 flex max-h-[88vh] w-[1040px] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
            >
              <div className="flex items-start justify-between gap-3 border-b border-zinc-800 p-3">
                <div>
                  <div className="text-sm font-medium text-zinc-200">
                    Pochven systems
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                    <span>
                      homes (Kino / Archee / Niarja) at the corners · others
                      aligned on the edges between them · drag to move, Reset
                      restores
                    </span>
                    {/* Role — the tile fill. */}
                    <span className="text-zinc-600">fill = role:</span>
                    {(["Home", "Border", "Internal"] as const).map((r) => (
                      <span key={r} className="flex items-center gap-1">
                        <span
                          className="h-2.5 w-2.5 rounded-sm"
                          style={{ backgroundColor: ROLE_HEX[r] }}
                        />
                        {r}
                      </span>
                    ))}
                    {/* Constellation — the outline ring. */}
                    <span className="text-zinc-600">ring = constellation:</span>
                    {(["Perun", "Svarog", "Veles"] as const).map((c) => (
                      <span key={c} className="flex items-center gap-1">
                        <span
                          className="h-2.5 w-2.5 rounded-sm border-2"
                          style={{ borderColor: CLADE_HEX[c] }}
                        />
                        {CLADE_KRAI[c]}
                      </span>
                    ))}
                    <span className="text-zinc-600">
                      sub-label = k-space entries per band
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="shrink-0 text-zinc-500 hover:text-zinc-200"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="overflow-auto p-3">
                <SystemGraph
                  nodes={nodes}
                  edges={edges}
                  height={480}
                  storageKey="pochven-systems-ref"
                  defaultMode="star"
                />
                <table className="mt-3 w-full border-collapse text-sm">
                  <thead className="bg-zinc-900 text-zinc-400">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">
                        System
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium">
                        Clade / role
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium">
                        Enter from
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium">
                        C729 spawn regions (candidate count)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {POCHVEN_SYSTEMS.map((s) => {
                      const c = POCHVEN_ENTRY_COUNTS[s.name];
                      const meta = POCHVEN_META[s.name];
                      const isOpen = expanded === s.name;
                      return (
                        <Fragment key={s.name}>
                          <tr
                            onClick={() => setExpanded(isOpen ? null : s.name)}
                            className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/40"
                          >
                            <td className="px-3 py-1.5 font-medium text-zinc-200">
                              <span className="mr-1 inline-block w-2 text-zinc-500">
                                {isOpen ? "▾" : "▸"}
                              </span>
                              {s.name}
                            </td>
                            <td className="px-3 py-1.5 text-zinc-500">
                              {meta ? `${meta.clade} · ${meta.role}` : "—"}
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="flex gap-2 tabular-nums">
                                {(
                                  [
                                    ["hisec", c?.hisec ?? 0],
                                    ["lowsec", c?.lowsec ?? 0],
                                    ["nullsec", c?.nullsec ?? 0],
                                  ] as const
                                )
                                  .filter(([, n]) => n > 0)
                                  .map(([b, n]) => (
                                    <span
                                      key={b}
                                      style={{ color: BAND_HEX[b] }}
                                    >
                                      {n} {b.replace("sec", "")}
                                    </span>
                                  ))}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-zinc-400">
                              {s.c729
                                .map((z) =>
                                  z.region === INTERNAL
                                    ? `internal (${z.count})`
                                    : `${z.region} (${z.count})`,
                                )
                                .join(" · ")}
                            </td>
                          </tr>
                          {isOpen && meta && (
                            <tr className="border-t border-zinc-800/60 bg-zinc-900/60">
                              <td colSpan={4} className="px-3 py-2">
                                <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                                  Inbound — filaments that drop you into{" "}
                                  {s.name}
                                </div>
                                <ul className="mt-1 space-y-1 text-xs text-zinc-400">
                                  <li>
                                    <span className="font-medium text-sky-300">
                                      System-type · {meta.role}
                                    </span>{" "}
                                    — random {meta.role} system (
                                    {byRole[meta.role].length}):{" "}
                                    <span className="text-zinc-500">
                                      {byRole[meta.role]
                                        .map((n) =>
                                          n === s.name ? `${n}★` : n,
                                        )
                                        .join(", ")}
                                    </span>
                                  </li>
                                  <li>
                                    <span className="font-medium text-violet-300">
                                      Cladistic · {meta.clade}
                                    </span>{" "}
                                    — random {meta.clade} system (
                                    {byClade[meta.clade].length}):{" "}
                                    <span className="text-zinc-500">
                                      {byClade[meta.clade]
                                        .map((n) =>
                                          n === s.name ? `${n}★` : n,
                                        )
                                        .join(", ")}
                                    </span>
                                  </li>
                                </ul>
                                <div className="mt-1 text-[11px] text-zinc-600">
                                  Filaments land you in a random system of that
                                  role / clade (★ = this one); a C729 wormhole
                                  is the only way to target a specific system.
                                </div>

                                {/* Outbound — Proximity 'Extraction' filament. */}
                                <div className="mt-2.5 text-[11px] uppercase tracking-wide text-zinc-500">
                                  Outbound — Proximity 'Extraction' filament
                                  (k-space within 2.5 ly)
                                </div>
                                {(() => {
                                  const exits = exitsByName.get(s.name);
                                  if (exits == null)
                                    return (
                                      <div className="mt-1 text-xs text-zinc-600">
                                        {topo.isLoading
                                          ? "Loading…"
                                          : "No data."}
                                      </div>
                                    );
                                  if (exits.length === 0)
                                    return (
                                      <div className="mt-1 text-xs text-zinc-500">
                                        No k-space within 2.5 ly — use a
                                        Glorification 'Devana' filament or a
                                        wormhole instead.
                                      </div>
                                    );
                                  return (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {exits.map((e) => (
                                        <span
                                          key={e.name}
                                          className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs"
                                          title={`${e.region} · ${e.lightYears.toFixed(2)} ly`}
                                        >
                                          <span
                                            style={{
                                              color:
                                                BAND_HEX[
                                                  e.security >= 0.45
                                                    ? "hisec"
                                                    : e.security > 0
                                                      ? "lowsec"
                                                      : "nullsec"
                                                ],
                                            }}
                                          >
                                            {e.name}
                                          </span>
                                          <span className="text-zinc-500">
                                            {" "}
                                            {e.lightYears.toFixed(1)} ly
                                          </span>
                                        </span>
                                      ))}
                                    </div>
                                  );
                                })()}
                                <div className="mt-1 text-[11px] text-zinc-600">
                                  Proximity 'Extraction' filaments drop you into
                                  k-space within 2.5 ly of here. A Glorification
                                  'Devana' filament instead drops you into one
                                  of the 28 Triglavian Minor Victory Systems at
                                  random (hi- or low-sec).
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
