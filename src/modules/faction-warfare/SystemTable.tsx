import { useEffect, useMemo, useRef } from "react";
import { formatInt, sortRows } from "../../lib/format";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { usePersistentSort } from "../../lib/usePersistentSort";
import type { HotspotSystemCounts, FwSystemNode } from "../../lib/api";
import {
  perspectiveFor,
  relationshipFor,
  type Perspective,
} from "./factionPerspective";
import { trendTier, trendTooltip, TREND_ARROW } from "./vpTrend";
import {
  factionSignedDelta,
  formatVpDeltaPct,
  loginDelta,
  type VpLoginBaseline,
} from "./vpChange";
import {
  hotspotDescription,
  hotspotTotal,
  NO_HOTSPOT_ACTIVITY,
} from "./hotspots";
import type { Playstyle } from "./playstyle";
import {
  BATTLEFIELD_LABEL,
  BATTLEFIELD_RANK,
  BATTLEFIELD_STYLE,
  CONTEST_RANK,
  CONTEST_STYLE,
  FACTION_HEX,
  FARM_SCORE_COLUMN,
  FW_COLUMNS,
  FW_COLUMNS_PERSPECTIVE,
  FW_SORT_KEYS,
  HOTSPOT_COLUMN,
  PERSPECTIVE_RANK,
  RELATIONSHIP_HEX,
  type ActivePerspective,
  type FwSortKey,
} from "./fwConstants";
import { SystemNameCell } from "./SystemNameCell";

/** Text colour for a faction-signed VP% delta cell: green when it's
 *  progress for the selected militia, red when it's progress for the
 *  enemy, muted zinc when flat or not yet known. */
function vpDeltaClass(delta: number | null): string {
  if (delta == null || Math.abs(delta) < 0.0005) return "text-zinc-500";
  return delta > 0 ? "text-emerald-300" : "text-rose-300";
}

export function SystemTable({
  systems,
  dist,
  hasCharacter,
  perspective,
  playstyle,
  farmScores,
  showFarmScore,
  loginBaseline,
  hotspotCounts,
  showHotspots,
}: {
  systems: FwSystemNode[];
  /** Hop counts keyed by String(systemId), from the active character's location. */
  dist: Record<string, number>;
  hasCharacter: boolean;
  perspective: ActivePerspective;
  /** Entering Plexing mode seeds a farm-score-desc sort (below); the header
   *  row stays fully clickable/sortable afterwards, same as "all". */
  playstyle: Playstyle;
  /** Plexing-mode farm score per system id (#904); empty outside that mode. */
  farmScores: Record<number, number>;
  showFarmScore: boolean;
  /** "Since login" VP baseline, for the Δ login column. */
  loginBaseline: ReadonlyMap<number, VpLoginBaseline>;
  /** Faction-scoped kill activity per system id, from the hotspots query. */
  hotspotCounts: ReadonlyMap<number, HotspotSystemCounts>;
  /** Shown once a militia is selected (hotspots are always fetched then) —
   *  same gate the hotspots query itself uses, so the column never shows
   *  stale "—"s for data that was never fetched. */
  showHotspots: boolean;
}) {
  const { sortKey, sortDir, toggleSort, setSort } =
    usePersistentSort<FwSortKey>(
      "sort.fw-systems",
      FW_SORT_KEYS,
      "name",
      "asc",
      ["name", "region", "occupier"],
    );
  // Seed farm-score-desc whenever Plexing mode is (re-)entered — the user's
  // own clicks on the header row take over immediately after, exactly like
  // "all" (#904 originally force-pinned this sort; that override is gone).
  const prevPlaystyleRef = useRef<Playstyle | null>(null);
  useEffect(() => {
    if (playstyle === "plexing" && prevPlaystyleRef.current !== "plexing") {
      setSort("farmScore", "desc");
    }
    prevPlaystyleRef.current = playstyle;
  }, [playstyle, setSort]);
  const baseColumns = perspective ? FW_COLUMNS_PERSPECTIVE : FW_COLUMNS;
  let columns = baseColumns;
  if (showHotspots) columns = [...columns, HOTSPOT_COLUMN];
  if (showFarmScore) columns = [...columns, FARM_SCORE_COLUMN];

  // Augment rows with sort-friendly scalar fields, then sort.
  const rows = useMemo(() => {
    type AugRow = FwSystemNode & {
      contestedRank: number;
      hops: number | null;
      perspective: Perspective;
      perspectiveRank: number;
      battlefieldRank: number;
      farmScore: number;
      /** Faction-signed VP% change (positive = progress for the selected
       *  militia) — distinct from the raw, occupier-centric `vpDelta30m` on
       *  `FwSystemNode` itself. `null` outside perspective mode. */
      vpDelta30mSigned: number | null;
      vpDeltaLoginSigned: number | null;
      /** Faction-signed velocity, for the Trend arrow only (#950) — so an
       *  enemy-occupied system losing VP (good for you) shows ↑, not the
       *  raw-occupier ↓, matching the sign the Δ30m/Δ login columns already
       *  use right next to it. The tooltip's rate/ETA text stays on the raw
       *  `vpVelocity`: "hours to flip" is inherently about the occupier's
       *  own climb to 100%, not a perspective-relative quantity. `null`
       *  outside perspective mode, where there's no "mine vs theirs" to
       *  flip against. */
      vpVelocitySigned: number | null;
      hotspot: HotspotSystemCounts;
      hotspotActivity: number;
    };
    const augmented: AugRow[] = systems.map((s) => {
      const persp = perspective
        ? perspectiveFor(s.occupierId, s.contested, perspective.myFaction)
        : null;
      const hotspot = hotspotCounts.get(s.systemId) ?? {
        systemId: s.systemId,
        ...NO_HOTSPOT_ACTIVITY,
      };
      return {
        ...s,
        contestedRank: CONTEST_RANK[s.contested] ?? 0,
        hops: dist[String(s.systemId)] ?? null,
        perspective: persp,
        perspectiveRank: PERSPECTIVE_RANK[persp ?? "none"],
        battlefieldRank: BATTLEFIELD_RANK[s.battlefield] ?? 2,
        farmScore: farmScores[s.systemId] ?? 0,
        vpDelta30mSigned: perspective
          ? factionSignedDelta(
              s.vpDelta30m,
              s.occupierId,
              perspective.myFaction,
            )
          : null,
        vpDeltaLoginSigned: perspective
          ? factionSignedDelta(
              loginDelta(loginBaseline, s.systemId, s.vpPct),
              s.occupierId,
              perspective.myFaction,
            )
          : null,
        vpVelocitySigned: perspective
          ? factionSignedDelta(
              s.vpVelocity,
              s.occupierId,
              perspective.myFaction,
            )
          : null,
        hotspot,
        hotspotActivity: hotspotTotal(hotspot),
      };
    });
    return sortRows(augmented, sortKey, sortDir, {
      nullsLast:
        sortKey === "hops" ||
        sortKey === "vpVelocity" ||
        sortKey === "vpDelta30mSigned" ||
        sortKey === "vpDeltaLoginSigned",
    });
  }, [
    systems,
    dist,
    sortKey,
    sortDir,
    perspective,
    farmScores,
    loginBaseline,
    hotspotCounts,
  ]);

  return (
    <DataTable
      className="overflow-auto rounded-lg border border-zinc-800"
      columns={columns}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={toggleSort}
      rows={rows}
      emptyState={<EmptyState title="No systems match the current filters." />}
      renderRow={(s) => (
        <tr key={s.systemId} className="border-t border-zinc-800 text-zinc-300">
          <SystemNameCell s={s} hasCharacter={hasCharacter} />
          <td className="px-3 py-1.5 text-zinc-500">{s.region}</td>
          <td className="px-3 py-1.5">
            <span className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: perspective
                    ? RELATIONSHIP_HEX[
                        relationshipFor(s.occupierId, perspective.myFaction)
                      ]
                    : (FACTION_HEX[s.occupierId] ?? "#a1a1aa"),
                }}
              />
              {s.occupier}
            </span>
          </td>
          <td className="px-3 py-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                BATTLEFIELD_STYLE[s.battlefield] ?? BATTLEFIELD_STYLE.rearguard
              }`}
            >
              {BATTLEFIELD_LABEL[s.battlefield] ?? s.battlefield}
            </span>
          </td>
          {perspective && (
            <td className="px-3 py-1.5">
              {s.perspective ? (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                    s.perspective === "defend"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-rose-500/15 text-rose-300"
                  }`}
                >
                  {s.perspective}
                </span>
              ) : (
                <span className="text-zinc-600">—</span>
              )}
            </td>
          )}
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
            className="px-3 py-1.5 text-center tabular-nums text-zinc-400"
            title={trendTooltip(s.vpPct, s.vpVelocity)}
          >
            {(() => {
              const tier = trendTier(
                perspective ? s.vpVelocitySigned : s.vpVelocity,
              );
              return tier ? TREND_ARROW[tier] : "—";
            })()}
          </td>
          {perspective && (
            <td
              className={`px-3 py-1.5 text-right tabular-nums ${vpDeltaClass(s.vpDelta30mSigned)}`}
              title="VP% change in roughly the last 30 min, signed for your militia: positive is progress for you, negative is progress for the enemy"
            >
              {formatVpDeltaPct(s.vpDelta30mSigned)}
            </td>
          )}
          {perspective && (
            <td
              className={`px-3 py-1.5 text-right tabular-nums ${vpDeltaClass(s.vpDeltaLoginSigned)}`}
              title="VP% change since you opened this session, signed for your militia: positive is progress for you, negative is progress for the enemy"
            >
              {formatVpDeltaPct(s.vpDeltaLoginSigned)}
            </td>
          )}
          <td
            className={`px-3 py-1.5 text-right tabular-nums ${
              s.kills > 0 ? "text-rose-300" : "text-zinc-600"
            }`}
          >
            {s.kills > 0 ? formatInt(s.kills) : "—"}
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums text-zinc-500">
            {s.npcKills > 0 ? formatInt(s.npcKills) : "—"}
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
            {s.jumps > 0 ? formatInt(s.jumps) : "—"}
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
            {s.hops != null ? (s.hops === 0 ? "here" : formatInt(s.hops)) : "—"}
          </td>
          {showHotspots && (
            <td
              className="px-3 py-1.5 text-zinc-400"
              title={`${s.hotspot.friendlyLosses} friendly losses · ${s.hotspot.enemyLosses} enemy losses · ${s.hotspot.cartelActivity} cartel kills, last ~6h`}
            >
              {hotspotDescription(s.hotspot)}
            </td>
          )}
          {showFarmScore && (
            <td className="px-3 py-1.5 text-right tabular-nums text-emerald-300">
              {s.farmScore.toFixed(2)}
            </td>
          )}
        </tr>
      )}
    />
  );
}
