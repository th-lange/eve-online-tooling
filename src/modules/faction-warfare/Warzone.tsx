import { useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  activeCharacter,
  authCharacters,
  intelFwHotspots,
  intelFwJumps,
  type FwJumpResult,
  type FwMap,
} from "../../lib/api";
import { authKeys, intelKeys } from "../../lib/queryKeys";
import {
  SystemGraph,
  type SystemGraphNode,
  type SystemGraphEdge,
} from "../../components/SystemGraph";
import { SearchFilterRow } from "../../components/forms";
import { usePersistentState } from "../../lib/usePersistentState";
import { FACTION_WARFARE_JUMP_DISTANCE_REFRESH_MS } from "../../lib/refreshIntervals";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import { relationshipFor } from "./factionPerspective";
import { trendTier, TREND_ARROW } from "./vpTrend";
import { type VpLoginBaseline } from "./vpChange";
import {
  computeFarmScores,
  PLAYSTYLE_OPTIONS,
  type Playstyle,
} from "./playstyle";
import { hotspotHeatBg, hotspotTotal, NO_HOTSPOT_ACTIVITY } from "./hotspots";
import {
  BASE_RGB,
  BATTLEFIELD_LABEL,
  CONTEST_RGB,
  CONTEST_RING,
  FACTION_HEX,
  FW_BATTLEFIELD_FILTERS,
  FW_FILTERS,
  FW_MAP_SIZES,
  FW_PROXIMITY_OPTIONS,
  MAP_SIZE_PX,
  RELATIONSHIP_HEX,
  type ActivePerspective,
  type FwBattlefieldFilter,
  type FwMapSize,
  type FwProximityRadius,
  type FwSystemFilter,
} from "./fwConstants";
import { spreadNoOverlap, tileBg, useFillHeight } from "./fwMapLayout";
import { SystemTable } from "./SystemTable";

export function Warzone({
  data,
  zone,
  perspective,
  loginBaseline,
  autoRefresh,
}: {
  data: FwMap;
  zone: string;
  perspective: ActivePerspective;
  loginBaseline: ReadonlyMap<number, VpLoginBaseline>;
  /** Page-level auto-refresh: drives the hotspots query's 60s refetch too,
   *  so "everything, including heat" updates together. */
  autoRefresh: boolean;
}) {
  const systems = useMemo(
    () => data.nodes.filter((n) => n.warzone === zone),
    [data.nodes, zone],
  );

  // Warzone-list filter (persisted): contested/uncontested/all.
  const [filter, setFilter] = usePersistentState<FwSystemFilter>(
    "fw.systemFilter",
    "all",
  );
  // Battlefield-class filter (persisted): frontlines/command post/all.
  const [battlefieldFilter, setBattlefieldFilter] =
    usePersistentState<FwBattlefieldFilter>("fw.battlefieldFilter", "all");

  // Map size preset (#897), persisted; "fill" tracks the viewport via the
  // resize-aware hook, the fixed presets are plain pixel heights.
  const [mapSize, setMapSize] = usePersistentState<FwMapSize>(
    "fw.mapSize",
    "m",
  );
  const [fillRef, fillHeight] = useFillHeight(mapSize === "fill", 320);
  const mapHeight = mapSize === "fill" ? fillHeight : MAP_SIZE_PX[mapSize];

  // Auth: needed for jump distances + waypoint button in the table.
  const characters = useQuery({
    queryKey: authKeys.characters,
    queryFn: authCharacters,
  });
  const hasCharacter = (characters.data?.length ?? 0) > 0;
  const activeChar = useQuery({
    queryKey: authKeys.active,
    queryFn: activeCharacter,
    enabled: hasCharacter,
  });
  // Jump distances from the active character's location to every system in
  // this warzone. Polled every 90 s so the map updates as the character
  // moves — but only while this module is the visible view (ModuleHost keeps
  // hidden pages mounted, and nobody needs jump counts they can't see).
  const moduleActive = useContext(ModuleActiveContext);
  const systemIds = useMemo(() => systems.map((s) => s.systemId), [systems]);
  const jumpResult = useQuery<FwJumpResult>({
    queryKey: intelKeys.fwJumps(systemIds),
    queryFn: () => intelFwJumps(systemIds),
    enabled: !!activeChar.data,
    staleTime: FACTION_WARFARE_JUMP_DISTANCE_REFRESH_MS,
    refetchInterval: moduleActive
      ? FACTION_WARFARE_JUMP_DISTANCE_REFRESH_MS
      : false,
  });
  const dist = useMemo(() => jumpResult.data?.jumps ?? {}, [jumpResult.data]);
  const characterSystemId = jumpResult.data?.characterSystemId ?? null;

  // Proximity filter (#898), persisted. "all" or no character → identical to
  // the unfiltered set; scopes both the table and the map together.
  const [radius, setRadius] = usePersistentState<FwProximityRadius>(
    "fw.proximityRadius",
    "all",
  );
  const visibleSystems = useMemo(() => {
    if (radius === "all" || !hasCharacter) return systems;
    const max = Number(radius);
    return systems.filter((s) => {
      const hops = dist[String(s.systemId)];
      return hops != null && hops <= max;
    });
  }, [systems, dist, radius, hasCharacter]);

  // Playstyle presets (#904), persisted. "all" keeps today's behaviour
  // (unfiltered, user-controlled sort). Plexing further filters to
  // frontline/command-ops and seeds a farm-score sort (see SystemTable) —
  // the header row stays fully sortable in either mode.
  const [playstyle, setPlaystyle] = usePersistentState<Playstyle>(
    "fw.playstyle",
    "all",
  );
  const playstyleSystems = useMemo(
    () =>
      playstyle === "plexing"
        ? visibleSystems.filter((s) => s.battlefield !== "rearguard")
        : visibleSystems,
    [visibleSystems, playstyle],
  );
  const farmScores = useMemo(
    () =>
      playstyle === "plexing"
        ? computeFarmScores(playstyleSystems, dist, hasCharacter)
        : {},
    [playstyleSystems, dist, hasCharacter, playstyle],
  );

  // Name filter: typing narrows both the table and the map to systems whose
  // name contains the query (case-insensitive substring), hiding the rest.
  // Persisted like the other view filters; applied upstream of the
  // contested-state "Show" split so it scopes both together.
  const [nameQuery, setNameQuery] = usePersistentState("fw.nameFilter", "");
  const nameFilteredSystems = useMemo(() => {
    const q = nameQuery.trim().toLowerCase();
    if (!q) return playstyleSystems;
    return playstyleSystems.filter((s) => s.name.toLowerCase().includes(q));
  }, [playstyleSystems, nameQuery]);

  // Kill hotspots (#905, now always-on by default): zKillboard
  // faction-scoped feeds bucketed into friendly/enemy/cartel per system
  // over the last ~6h, replacing the generic ESI kill-count tile heat
  // with the warzone's actual faction-scoped activity. Requires a militia
  // selection (Observer has no "friendly"/"enemy" to bucket against).
  // Refresh cadence follows the page-level `autoRefresh` toggle — same
  // lifecycle reasoning as the stats/map queries above it.
  const hotspots = useQuery({
    queryKey: intelKeys.fwHotspots(
      perspective?.myFaction,
      perspective?.enemyFaction,
    ),
    queryFn: () =>
      intelFwHotspots(perspective!.myFaction, perspective!.enemyFaction),
    enabled: !!perspective,
    staleTime: 5 * 60_000,
    refetchInterval: moduleActive && autoRefresh ? 60_000 : false,
    refetchOnMount: autoRefresh ? "always" : true,
  });
  const hotspotCounts = useMemo(
    () => new Map(hotspots.data?.systems.map((c) => [c.systemId, c]) ?? []),
    [hotspots.data],
  );
  const maxHotspotTotal = useMemo(
    () => Math.max(1, ...[...hotspotCounts.values()].map(hotspotTotal)),
    [hotspotCounts],
  );

  const ids = useMemo(
    () => new Set(nameFilteredSystems.map((s) => s.systemId)),
    [nameFilteredSystems],
  );

  const tableSystems = useMemo(() => {
    let result = nameFilteredSystems;
    if (filter !== "all") {
      result = result.filter((s) =>
        filter === "contested"
          ? s.contested !== "uncontested"
          : s.contested === "uncontested",
      );
    }
    if (battlefieldFilter !== "all") {
      result = result.filter((s) => s.battlefield === battlefieldFilter);
    }
    return result;
  }, [nameFilteredSystems, filter, battlefieldFilter]);

  // Lay the tiles out as a top-down star map from real galactic X/Z coords
  // (x → horizontal, z → vertical, flipped so north is up), scaled to fit.
  const graphNodes: SystemGraphNode[] = useMemo(() => {
    if (nameFilteredSystems.length === 0) return [];
    const xs = nameFilteredSystems.map((s) => s.x);
    const zs = nameFilteredSystems.map((s) => s.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const span = Math.max(maxX - minX, maxZ - minZ) || 1;
    const scale = 2800 / span;
    const maxKills = Math.max(1, ...nameFilteredSystems.map((s) => s.kills));
    // Scale by real coords (x → horizontal, z → vertical, north up), then snap
    // to a grid so no two tiles overlap on first load.
    const placed = spreadNoOverlap(
      nameFilteredSystems.map((n) => ({
        id: String(n.systemId),
        x: (n.x - minX) * scale,
        y: (maxZ - n.z) * scale,
      })),
      168,
      66,
    );
    // Detailed tiles (#902) render only while the proximity filter bounds
    // the view — full-warzone scope keeps today's compact single-line tile
    // unchanged, both for readability at that node count and to avoid any
    // perf regression there.
    const detailed = radius !== "all";
    return nameFilteredSystems.map((n) => {
      const p = placed.get(String(n.systemId)) ?? { x: 0, y: 0 };
      const hops = dist[String(n.systemId)];
      const isCurrent = n.systemId === characterSystemId;
      const trendArrow = (() => {
        const tier = trendTier(n.vpVelocity);
        return tier ? TREND_ARROW[tier] : undefined;
      })();
      return {
        id: String(n.systemId),
        label: n.name,
        kind: "lowsec" as const,
        sub: detailed
          ? `${n.security.toFixed(1)}${n.contested !== "uncontested" ? ` · ${n.contested}` : ""}${hops != null ? ` · ${isCurrent ? "here" : `${hops}j`}` : ""}`
          : `${n.security.toFixed(1)}${
              n.battlefield !== "rearguard"
                ? ` · ${BATTLEFIELD_LABEL[n.battlefield] ?? n.battlefield}`
                : ""
            }${n.contested !== "uncontested" ? ` · ${n.contested}` : ""}${
              trendArrow ? ` ${trendArrow}` : ""
            }${
              n.kills > 0 || n.npcKills > 0
                ? ` · ${n.kills} kills${n.npcKills > 0 ? ` (${n.npcKills} npc)` : ""}`
                : ""
            }${hops != null ? ` · ${isCurrent ? "here" : `${hops}j`}` : ""}`,
        detail: detailed
          ? {
              vpPct: n.vpPct,
              battlefieldLabel:
                n.battlefield !== "rearguard"
                  ? (BATTLEFIELD_LABEL[n.battlefield] ?? n.battlefield)
                  : undefined,
              kills: n.kills,
              npcKills: n.npcKills,
              trendArrow,
            }
          : undefined,
        accent: perspective
          ? RELATIONSHIP_HEX[
              relationshipFor(n.occupierId, perspective.myFaction)
            ]
          : (FACTION_HEX[n.occupierId] ?? "#a1a1aa"),
        ring: CONTEST_RING[n.contested],
        bg: perspective
          ? hotspotHeatBg(
              CONTEST_RGB[n.contested] ?? BASE_RGB,
              hotspotTotal(
                hotspotCounts.get(n.systemId) ?? NO_HOTSPOT_ACTIVITY,
              ),
              maxHotspotTotal,
            )
          : tileBg(n.contested, n.kills, maxKills),
        current: isCurrent,
        group: n.region,
        x: p.x,
        y: p.y,
      };
    });
  }, [
    nameFilteredSystems,
    dist,
    characterSystemId,
    perspective,
    radius,
    hotspotCounts,
    maxHotspotTotal,
  ]);
  const graphEdges: SystemGraphEdge[] = data.edges
    .filter(([a, b]) => ids.has(a) && ids.has(b))
    .map(([a, b]) => {
      const current =
        characterSystemId != null &&
        (a === characterSystemId || b === characterSystemId);
      return {
        source: String(a),
        target: String(b),
        variant: "stargate",
        // Highlight every jump out of the current system in green, so
        // "where can I go from here" reads at a glance on the map.
        color: current ? "#34d399" : undefined, // emerald-400
      };
    });

  // Colour legend for the factions present in this warzone.
  const factions = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of playstyleSystems) m.set(s.occupierId, s.occupier);
    return [...m.entries()];
  }, [playstyleSystems]);

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-500">Mode</span>
        <div className="flex overflow-hidden rounded border border-zinc-700 text-sm">
          {PLAYSTYLE_OPTIONS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPlaystyle(p.key)}
              title={p.description}
              className={`px-3 py-1 ${
                playstyle === p.key
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {(() => {
          const active = PLAYSTYLE_OPTIONS.find((p) => p.key === playstyle);
          return active?.description ? (
            <span className="text-xs text-zinc-600">{active.description}</span>
          ) : null;
        })()}
      </div>
      {perspective && hotspots.isLoading && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
          <span>Loading…</span>
        </div>
      )}
      <SearchFilterRow
        value={nameQuery}
        onChange={setNameQuery}
        placeholder="Filter by system name…"
        shown={nameFilteredSystems.length}
        total={playstyleSystems.length}
      />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-500">Show</span>
        <div className="flex overflow-hidden rounded border border-zinc-700 text-sm">
          {FW_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1 ${
                filter === f.key
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-zinc-500">Battlefield</span>
        <div className="flex overflow-hidden rounded border border-zinc-700 text-sm">
          {FW_BATTLEFIELD_FILTERS.map((b) => (
            <button
              key={b.key}
              onClick={() => setBattlefieldFilter(b.key)}
              className={`px-3 py-1 ${
                battlefieldFilter === b.key
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
        {hasCharacter && (
          <>
            <span className="text-xs text-zinc-500">Within</span>
            <div className="flex overflow-hidden rounded border border-zinc-700 text-sm">
              {FW_PROXIMITY_OPTIONS.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRadius(r.key)}
                  className={`px-3 py-1 ${
                    radius === r.key
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="text-xs text-zinc-600">
          {tableSystems.length} of {playstyleSystems.length} systems
        </span>
      </div>
      <SystemTable
        systems={tableSystems}
        dist={dist}
        hasCharacter={hasCharacter}
        perspective={perspective}
        playstyle={playstyle}
        farmScores={farmScores}
        showFarmScore={playstyle === "plexing"}
        loginBaseline={loginBaseline}
        hotspotCounts={hotspotCounts}
        showHotspots={perspective != null}
      />

      <div className="mt-4 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-400">
        <span>{playstyleSystems.length} systems</span>
        {perspective
          ? (["friendly", "hostile", "cartel"] as const).flatMap((rel) =>
              factions
                .filter(
                  ([id]) => relationshipFor(id, perspective.myFaction) === rel,
                )
                .map(([id, name]) => (
                  <span key={id} className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: RELATIONSHIP_HEX[rel] }}
                    />
                    <span className="capitalize text-zinc-500">{rel}:</span>{" "}
                    {name}
                  </span>
                )),
            )
          : factions.map(([id, name]) => (
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
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-zinc-600">Size</span>
          <span className="flex overflow-hidden rounded border border-zinc-700">
            {FW_MAP_SIZES.map((s) => (
              <button
                key={s.key}
                onClick={() => setMapSize(s.key)}
                className={`px-2 py-0.5 ${
                  mapSize === s.key
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                {s.label}
              </button>
            ))}
          </span>
        </span>
      </div>

      <div
        ref={fillRef}
        className="overflow-hidden rounded-lg border border-zinc-800"
      >
        <SystemGraph
          nodes={graphNodes}
          edges={graphEdges}
          rootId={
            characterSystemId != null ? String(characterSystemId) : undefined
          }
          height={mapHeight}
          storageKey={`fw-map3-${zone}`}
        />
      </div>
    </div>
  );
}
