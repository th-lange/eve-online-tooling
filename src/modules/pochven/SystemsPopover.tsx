import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  SystemGraph,
  type SystemGraphEdge,
  type SystemGraphNode,
} from "../../components/SystemGraph";
import { pochvenMap, type ExitTarget } from "../../lib/api";
import {
  POCHVEN_INTERNAL_LINKS,
  POCHVEN_META,
  pochvenTriangle,
  systemsByClade,
  systemsByRole,
} from "./data";
import { SEC_HEX, secBand } from "../../lib/security";
import { CLADE_HEX, CLADE_KRAI, ROLE_HEX, systemVisual } from "./visual";
import { homeTriangleLayout } from "./graph";

/** Proximity 'Extraction' filament exit targets for one system — shared by
 *  the table's expanded row and the map's click popover. */
function ExitBadges({
  exits,
  isLoading,
}: {
  exits: ExitTarget[] | undefined;
  isLoading: boolean;
}) {
  if (exits == null) {
    return (
      <div className="mt-1 text-zinc-600">
        {isLoading ? "Loading…" : "No data."}
      </div>
    );
  }
  if (exits.length === 0) {
    return (
      <div className="mt-1 text-zinc-500">
        No k-space within 2.5 ly — use a Glorification &apos;Devana&apos;
        filament or a wormhole instead.
      </div>
    );
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {exits.map((e) => (
        <span
          key={e.name}
          className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs"
          title={`${e.region} · ${e.lightYears.toFixed(2)} ly`}
        >
          <span style={{ color: SEC_HEX[secBand(e.security)] }}>{e.name}</span>
          <span className="text-zinc-500"> {e.lightYears.toFixed(1)} ly</span>
        </span>
      ))}
    </div>
  );
}

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
  // id -> name, since real-map nodes are keyed by systemId while the
  // schematic-fallback nodes are keyed by name directly.
  const nameById = useMemo(
    () =>
      new Map(
        (topo.data?.systems ?? []).map((s) => [String(s.systemId), s.name]),
      ),
    [topo.data],
  );
  // Click-to-toggle map popover (#726): the same "which k-space systems can a
  // Proximity 'Extraction' filament land me in from here" the table's expanded
  // row already shows, surfaced directly on the map so you don't have to
  // scroll down and find the row.
  const nodeTooltip = useCallback(
    (id: string) => {
      const name = nameById.get(id) ?? id;
      const meta = POCHVEN_META[name];
      if (!meta) return undefined;
      return (
        <div className="w-64 rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-xs shadow-xl">
          <div className="font-medium text-zinc-100">{name}</div>
          <div className="text-[11px] text-zinc-500">
            {meta.clade} · {meta.role}
          </div>
          <div className="mt-2 text-[10px] uppercase tracking-wide text-zinc-500">
            Proximity &apos;Extraction&apos; filament — k-space within 2.5 ly
          </div>
          <ExitBadges
            exits={exitsByName.get(name)}
            isLoading={topo.isLoading}
          />
        </div>
      );
    },
    [nameById, exitsByName, topo.isLoading],
  );

  // Table rows: the 27 system names (from the static clade/role map) enriched
  // with the backend's band + spawn-region counts once loaded. The internal
  // C729 count is the system's degree in the static internal-link list — the
  // backend candidate dataset covers k-space exits only.
  const tableRows = useMemo(() => {
    const byName = new Map((topo.data?.systems ?? []).map((s) => [s.name, s]));
    return Object.keys(POCHVEN_META)
      .sort()
      .map((name) => ({
        name,
        bands: byName.get(name)?.bands,
        spawnRegions: byName.get(name)?.spawnRegions,
        internal: POCHVEN_INTERNAL_LINKS.filter(
          ([a, b]) => a === name || b === name,
        ).length,
      }));
  }, [topo.data]);

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
        const visual = systemVisual(s.name, s.bands);
        return {
          id: String(s.systemId),
          label: s.name,
          x: p.x,
          y: p.y,
          ...visual,
          kind: visual.kind ?? "unknown",
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
    const nodes: SystemGraphNode[] = Object.keys(POCHVEN_META).map((name) => {
      const visual = systemVisual(name);
      return {
        id: name,
        label: name,
        x: tri.pos[name]?.x,
        y: tri.pos[name]?.y,
        ...visual,
        kind: visual.kind ?? "unknown",
      };
    });
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
                      sub-label = k-space entries per band · click a system for
                      its Proximity Extraction exits
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
                  nodeTooltip={nodeTooltip}
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
                    {tableRows.map((s) => {
                      const c = s.bands;
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
                                    <span key={b} style={{ color: SEC_HEX[b] }}>
                                      {n} {b.replace("sec", "")}
                                    </span>
                                  ))}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-zinc-400">
                              {s.spawnRegions
                                ? [
                                    ...s.spawnRegions.map(
                                      (z) => `${z.region} (${z.count})`,
                                    ),
                                    ...(s.internal > 0
                                      ? [`internal (${s.internal})`]
                                      : []),
                                  ].join(" · ")
                                : "…"}
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
                                <ExitBadges
                                  exits={exitsByName.get(s.name)}
                                  isLoading={topo.isLoading}
                                />
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
