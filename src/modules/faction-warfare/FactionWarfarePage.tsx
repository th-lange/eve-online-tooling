import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fwSystems,
  intelFwStats,
  type FwMap,
  type FwSystemNode,
} from "../../lib/api";
import { formatInt } from "../../lib/format";
import {
  SystemGraph,
  type SystemGraphNode,
  type SystemGraphEdge,
} from "../../components/SystemGraph";

/** Militia faction id → accent hex, used for the map + legend. */
const FACTION_HEX: Record<number, string> = {
  500001: "#38bdf8", // Caldari State
  500002: "#fb7185", // Minmatar Republic
  500003: "#fbbf24", // Amarr Empire
  500004: "#34d399", // Gallente Federation
};

/** Same colours keyed by faction name (the militia summary has no id). */
const FACTION_HEX_BY_NAME: Record<string, string> = {
  "Caldari State": "#38bdf8",
  "Minmatar Republic": "#fb7185",
  "Amarr Empire": "#fbbf24",
  "Gallente Federation": "#34d399",
};

/** Contested-state chip styles. */
const CONTEST_STYLE: Record<string, string> = {
  uncontested: "bg-zinc-700/40 text-zinc-400",
  contested: "bg-amber-500/15 text-amber-300",
  vulnerable: "bg-rose-500/15 text-rose-300",
  captured: "bg-emerald-500/15 text-emerald-300",
};

/** Contested-state → outline-ring hex on the map (uncontested = no ring). */
const CONTEST_RING: Record<string, string | undefined> = {
  contested: "#fbbf24",
  vulnerable: "#fb7185",
  captured: "#34d399",
};

/** Solid tile-background base per contest state (uncontested = plain dark). */
const BASE_RGB: [number, number, number] = [24, 24, 27]; // zinc-900
const CONTEST_RGB: Record<string, [number, number, number]> = {
  contested: [92, 71, 14], // solid amber
  vulnerable: [96, 30, 48], // solid rose
  captured: [16, 78, 56], // solid emerald
};
/** Colour the background deepens toward as a system's kills rise. */
const HEAT_RGB: [number, number, number] = [200, 32, 32];

/**
 * A tile's solid background: the contest-state base, deepened toward red as the
 * system's kills approach the warzone's busiest. Quiet uncontested systems keep
 * the default (transparent) background.
 */
function tileBg(
  contested: string,
  kills: number,
  maxKills: number,
): string | undefined {
  const base = CONTEST_RGB[contested] ?? BASE_RGB;
  const t = Math.min(1, kills / Math.max(10, maxKills)) * 0.75;
  if (t <= 0) {
    return contested === "uncontested" ? undefined : `rgb(${base.join(",")})`;
  }
  const mix = base.map((c, i) => Math.round(c + (HEAT_RGB[i] - c) * t));
  return `rgb(${mix.join(",")})`;
}

/**
 * Snap coordinate-placed tiles onto a grid so none overlap: each tile takes its
 * nearest cell, and collisions spiral out to the closest free one. Keeps the
 * rough geography while guaranteeing clear spacing. Pure.
 */
function spreadNoOverlap(
  points: { id: string; x: number; y: number }[],
  cellW: number,
  cellH: number,
): Map<string, { x: number; y: number }> {
  const order = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
  const taken = new Set<string>();
  const out = new Map<string, { x: number; y: number }>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (const p of order) {
    let cx = Math.round(p.x / cellW);
    let cy = Math.round(p.y / cellH);
    if (taken.has(key(cx, cy))) {
      let done = false;
      for (let r = 1; r < 300 && !done; r++) {
        for (let dx = -r; dx <= r && !done; dx++) {
          for (let dy = -r; dy <= r && !done; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
            if (!taken.has(key(cx + dx, cy + dy))) {
              cx += dx;
              cy += dy;
              done = true;
            }
          }
        }
      }
    }
    taken.add(key(cx, cy));
    out.set(p.id, { x: cx * cellW, y: cy * cellH });
  }
  return out;
}

// Faction-warfare warzone view: pick a warzone, see the control map (systems
// coloured by who holds them) and a per-system table with contest state and
// last-hour activity. Public data, no login required.
export function FactionWarfarePage() {
  const stats = useQuery({
    queryKey: ["intel", "fw"],
    queryFn: intelFwStats,
    staleTime: 10 * 60_000,
  });
  const map = useQuery({
    queryKey: ["intel", "fwSystems"],
    queryFn: fwSystems,
    staleTime: 5 * 60_000,
  });

  // Warzones present in the data, in a stable order.
  const warzones = useMemo(() => {
    const seen = new Set<string>();
    for (const n of map.data?.nodes ?? []) if (n.warzone) seen.add(n.warzone);
    return [...seen].sort();
  }, [map.data]);
  const [zone, setZone] = useState<string | null>(null);
  const activeZone = zone ?? warzones[0] ?? null;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">
            Faction warfare
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Warzone control map and per-system state. Public data, no login
            required.
          </p>
        </div>
        <button
          onClick={() => {
            stats.refetch();
            map.refetch();
          }}
          disabled={map.isFetching}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {map.isFetching ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Militia summary strip (systems held / pilots / 24h kills). */}
      {stats.data && stats.data.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stats.data.map((s, i) => (
            <div
              key={i}
              className="rounded-lg border border-l-4 border-zinc-800 bg-zinc-900/50 p-3"
              style={{
                borderLeftColor: FACTION_HEX_BY_NAME[s.faction] ?? "#3f3f46",
              }}
            >
              <div className="truncate text-xs text-zinc-400">{s.faction}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-100">
                {formatInt(s.systemsControlled)}
                <span className="ml-1 text-xs font-normal text-zinc-500">
                  systems
                </span>
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {formatInt(s.pilots)} pilots · {formatInt(s.killsYesterday)}{" "}
                kills 24h
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Warzone selector. */}
      {warzones.length > 0 && (
        <div className="mt-5 flex items-center gap-2">
          <span className="text-xs text-zinc-500">Warzone</span>
          <div className="flex overflow-hidden rounded border border-zinc-700 text-sm">
            {warzones.map((w) => (
              <button
                key={w}
                onClick={() => setZone(w)}
                className={`px-3 py-1 ${
                  activeZone === w
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      )}

      {map.isLoading && (
        <div className="mt-5 text-sm text-zinc-500">Loading warzone map…</div>
      )}
      {map.isError && (
        <div className="mt-5 text-sm text-rose-400">{String(map.error)}</div>
      )}

      {map.data && activeZone && <Warzone data={map.data} zone={activeZone} />}
    </div>
  );
}

function Warzone({ data, zone }: { data: FwMap; zone: string }) {
  const systems = useMemo(
    () => data.nodes.filter((n) => n.warzone === zone),
    [data.nodes, zone],
  );
  const ids = useMemo(() => new Set(systems.map((s) => s.systemId)), [systems]);

  // Lay the tiles out as a top-down star map from real galactic X/Z coords
  // (x → horizontal, z → vertical, flipped so north is up), scaled to fit.
  const graphNodes: SystemGraphNode[] = useMemo(() => {
    if (systems.length === 0) return [];
    const xs = systems.map((s) => s.x);
    const zs = systems.map((s) => s.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const span = Math.max(maxX - minX, maxZ - minZ) || 1;
    const scale = 2800 / span;
    const maxKills = Math.max(1, ...systems.map((s) => s.kills));
    // Scale by real coords (x → horizontal, z → vertical, north up), then snap
    // to a grid so no two tiles overlap on first load.
    const placed = spreadNoOverlap(
      systems.map((n) => ({
        id: String(n.systemId),
        x: (n.x - minX) * scale,
        y: (maxZ - n.z) * scale,
      })),
      168,
      66,
    );
    return systems.map((n) => {
      const p = placed.get(String(n.systemId)) ?? { x: 0, y: 0 };
      return {
        id: String(n.systemId),
        label: n.name,
        kind: "lowsec" as const,
        sub: `${n.security.toFixed(1)}${
          n.contested !== "uncontested" ? ` · ${n.contested}` : ""
        }${n.kills > 0 ? ` · ${n.kills} kills` : ""}`,
        accent: FACTION_HEX[n.occupierId] ?? "#a1a1aa",
        ring: CONTEST_RING[n.contested],
        bg: tileBg(n.contested, n.kills, maxKills),
        x: p.x,
        y: p.y,
      };
    });
  }, [systems]);
  const graphEdges: SystemGraphEdge[] = data.edges
    .filter(([a, b]) => ids.has(a) && ids.has(b))
    .map(([a, b]) => ({
      source: String(a),
      target: String(b),
      variant: "stargate",
    }));

  // Colour legend for the factions present in this warzone.
  const factions = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of systems) m.set(s.occupierId, s.occupier);
    return [...m.entries()];
  }, [systems]);

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-400">
        <span>{systems.length} systems</span>
        {factions.map(([id, name]) => (
          <span key={id} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: FACTION_HEX[id] ?? "#a1a1aa" }}
            />
            {name}
          </span>
        ))}
        <span className="text-zinc-600">·</span>
        {(["contested", "vulnerable", "captured"] as const).map((c) => (
          <span key={c} className="flex items-center gap-1.5 capitalize">
            <span
              className="h-2.5 w-2.5 rounded-sm ring-2"
              style={{ boxShadow: `0 0 0 2px ${CONTEST_RING[c]}` }}
            />
            {c}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: "rgb(200,32,32)" }}
          />
          more kills
        </span>
        <span className="text-zinc-600">· star map — drag to arrange</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <SystemGraph
          nodes={graphNodes}
          edges={graphEdges}
          height={480}
          storageKey={`fw-map3-${zone}`}
        />
      </div>

      <SystemTable systems={systems} />
    </div>
  );
}

function SystemTable({ systems }: { systems: FwSystemNode[] }) {
  return (
    <div className="mt-4 overflow-auto rounded-lg border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">System</th>
            <th className="px-3 py-1.5 text-left font-medium">Region</th>
            <th className="px-3 py-1.5 text-left font-medium">Controlled by</th>
            <th className="px-3 py-1.5 text-left font-medium">State</th>
            <th className="px-3 py-1.5 text-right font-medium">Capture</th>
            <th className="px-3 py-1.5 text-right font-medium">Kills 1h</th>
            <th className="px-3 py-1.5 text-right font-medium">Jumps 1h</th>
          </tr>
        </thead>
        <tbody>
          {systems.map((s) => (
            <tr
              key={s.systemId}
              className="border-t border-zinc-800 text-zinc-300"
            >
              <td className="px-3 py-1.5 font-medium text-zinc-100">
                {s.name}
              </td>
              <td className="px-3 py-1.5 text-zinc-500">{s.region}</td>
              <td className="px-3 py-1.5">
                <span className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{
                      backgroundColor: FACTION_HEX[s.occupierId] ?? "#a1a1aa",
                    }}
                  />
                  {s.occupier}
                </span>
              </td>
              <td className="px-3 py-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                    CONTEST_STYLE[s.contested] ?? CONTEST_STYLE.uncontested
                  }`}
                >
                  {s.contested}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {s.contested === "uncontested"
                  ? "—"
                  : `${Math.round(s.vpPct * 100)}%`}
              </td>
              <td
                className={`px-3 py-1.5 text-right tabular-nums ${
                  s.kills > 0 ? "text-rose-300" : "text-zinc-600"
                }`}
              >
                {s.kills > 0 ? formatInt(s.kills) : "—"}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {s.jumps > 0 ? formatInt(s.jumps) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
