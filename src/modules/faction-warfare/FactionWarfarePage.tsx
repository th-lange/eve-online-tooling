import { useContext, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  authCharacters,
  errorMessage,
  fwSystems,
  intelFwEnlistment,
  intelFwPersonalStats,
  intelFwStats,
} from "../../lib/api";
import { authKeys, intelKeys } from "../../lib/queryKeys";
import { formatEveDateTime, formatInt } from "../../lib/format";
import { Page, PageHeader } from "../../components/page";
import { usePersistentState } from "../../lib/usePersistentState";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import {
  enemyFaction,
  isMilitiaFaction,
  militiaIdByName,
  relationshipFor,
  warzoneForFaction,
  MILITIA_NAME,
} from "./factionPerspective";
import { updateLoginBaselines, type VpLoginBaseline } from "./vpChange";
import {
  FACTION_HEX_BY_NAME,
  MILITIA_PICKER_ORDER,
  RELATIONSHIP_HEX,
  type ActivePerspective,
  type MilitiaChoice,
} from "./fwConstants";
import { Warzone } from "./Warzone";

// Faction-warfare warzone view: pick a warzone, see the control map (systems
// coloured by who holds them) and a per-system table with contest state and
// last-hour activity. Public data, no login required.
export function FactionWarfarePage() {
  // Auto refresh (persisted, opt-in — zKill/ESI calls aren't free): while
  // on, re-polls every 60s and forces a fresh fetch on mount instead of
  // only refetching once staleTime lapses, for every FW query on the page
  // (militia stats, the warzone map, and — passed down to `Warzone` —
  // kill hotspots). Gated on ModuleActiveContext as well: ModuleHost keeps
  // visited pages mounted (hidden), so "while the page is open" must mean
  // "while it's the active view" — window-focus pausing alone doesn't
  // cover switching to another module inside the still-focused app.
  const active = useContext(ModuleActiveContext);
  const [autoRefresh, setAutoRefresh] = usePersistentState(
    "fw.autoRefresh",
    false,
  );
  const stats = useQuery({
    queryKey: intelKeys.fw,
    queryFn: intelFwStats,
    staleTime: 10 * 60_000,
    refetchInterval: active && autoRefresh ? 60_000 : false,
    refetchOnMount: autoRefresh ? "always" : true,
  });
  const map = useQuery({
    queryKey: intelKeys.fwSystems,
    queryFn: fwSystems,
    staleTime: 5 * 60_000,
    refetchInterval: active && autoRefresh ? 60_000 : false,
    refetchOnMount: autoRefresh ? "always" : true,
  });

  // "Since login" VP baseline: anchors every system's VP% the first time
  // this app session observes it (or re-anchors on an ownership flip), so
  // the Δ login column can show faction-signed progress since the session
  // started. Lives at this top level (not per-Warzone) so switching
  // warzones/perspectives never resets it.
  const [loginBaseline, setLoginBaseline] = useState<
    Map<number, VpLoginBaseline>
  >(new Map());
  useEffect(() => {
    if (!map.data) return;
    setLoginBaseline((prev) => updateLoginBaselines(prev, map.data.nodes));
  }, [map.data]);

  // Warzones present in the data, in a stable order.
  const warzones = useMemo(() => {
    const seen = new Set<string>();
    for (const n of map.data?.nodes ?? []) if (n.warzone) seen.add(n.warzone);
    return [...seen].sort();
  }, [map.data]);
  const [zone, setZone] = useState<string | null>(null);

  // Militia perspective (#901): `override` is only set once the user
  // explicitly picks something (including explicitly picking Observer);
  // until then, default to the active character's enlisted militia if any.
  const [override, setOverride] = usePersistentState<MilitiaChoice | null>(
    "fw.militia",
    null,
  );
  const characters = useQuery({
    queryKey: authKeys.characters,
    queryFn: authCharacters,
  });
  const hasCharacter = (characters.data?.length ?? 0) > 0;
  const enlistment = useQuery({
    queryKey: intelKeys.fwEnlistment,
    queryFn: intelFwEnlistment,
    enabled: hasCharacter,
    staleTime: 10 * 60_000,
  });
  const autoMilitia: MilitiaChoice =
    enlistment.data != null && isMilitiaFaction(enlistment.data)
      ? enlistment.data
      : "observer";
  const activeMilitia: MilitiaChoice = override ?? autoMilitia;
  const perspective: ActivePerspective = useMemo(
    () =>
      activeMilitia === "observer"
        ? null
        : {
            myFaction: activeMilitia,
            enemyFaction: enemyFaction(activeMilitia),
          },
    [activeMilitia],
  );

  // Personal FW stats card (#903): only fetched/shown once a militia is
  // actively selected — Observer mode has no "me" to report on.
  const personalStats = useQuery({
    queryKey: intelKeys.fwPersonalStats,
    queryFn: intelFwPersonalStats,
    enabled: hasCharacter && perspective != null,
    staleTime: 10 * 60_000,
  });

  // Warzone is derived from the militia once one is selected; Observer mode
  // keeps the manual toggle.
  const activeZone = perspective
    ? warzoneForFaction(perspective.myFaction)
    : (zone ?? warzones[0] ?? null);

  // Militia summary strip: reordered mine-first/enemy-adjacent once a
  // militia is selected; Observer mode keeps the existing unordered list.
  const orderedStats = useMemo(() => {
    const rows = stats.data ?? [];
    if (!perspective) return rows;
    const rank = (name: string) => {
      const id = militiaIdByName(name);
      if (id === perspective.myFaction) return 0;
      if (id === perspective.enemyFaction) return 1;
      return 2;
    };
    return [...rows].sort((a, b) => rank(a.faction) - rank(b.faction));
  }, [stats.data, perspective]);

  return (
    <Page>
      <PageHeader
        title="Faction warfare"
        subtitle="Warzone control map and per-system state. Public data, no login required."
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.currentTarget.checked)}
              />
              Auto refresh (1 min)
            </label>
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
        }
      />

      {/* Militia perspective picker (#901): Observer (today's neutral view)
          or one of the four militias. Picking a militia reframes the page
          around it — the warzone is derived, the summary strip reorders, and
          the table/map gain a friend/foe read. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-500">Perspective</span>
        <div className="flex overflow-hidden rounded border border-zinc-700 text-sm">
          <button
            onClick={() => setOverride("observer")}
            className={`px-3 py-1 ${
              activeMilitia === "observer"
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            Observer
          </button>
          {MILITIA_PICKER_ORDER.map((id) => (
            <button
              key={id}
              onClick={() => setOverride(id)}
              className={`px-3 py-1 ${
                activeMilitia === id
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {MILITIA_NAME[id]}
            </button>
          ))}
        </div>
        {!override && autoMilitia !== "observer" && (
          <span className="text-xs text-zinc-600">
            auto-detected from your enlisted character
          </span>
        )}
      </div>

      {/* Militia summary strip (systems held / pilots / 24h kills). */}
      {orderedStats.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {orderedStats.map((s, i) => {
            const id = militiaIdByName(s.faction);
            const hex = perspective
              ? RELATIONSHIP_HEX[
                  id != null
                    ? relationshipFor(id, perspective.myFaction)
                    : "cartel"
                ]
              : (FACTION_HEX_BY_NAME[s.faction] ?? "#3f3f46");
            return (
              <div
                key={i}
                className="rounded-lg border border-l-4 border-zinc-800 bg-zinc-900/50 p-3"
                style={{ borderLeftColor: hex }}
              >
                <div className="truncate text-xs text-zinc-400">
                  {s.faction}
                  {perspective && id === perspective.myFaction && (
                    <span className="ml-1 text-emerald-400">(you)</span>
                  )}
                  {perspective && id === perspective.enemyFaction && (
                    <span className="ml-1 text-rose-400">(enemy)</span>
                  )}
                </div>
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
            );
          })}
        </div>
      )}

      {/* Personal FW stats card (#903): only in the perspective view. */}
      {perspective && personalStats.data?.stats && (
        <div
          className="mt-4 rounded-lg border border-l-4 border-zinc-800 bg-zinc-900/50 p-3"
          style={{ borderLeftColor: RELATIONSHIP_HEX.friendly }}
        >
          <div className="text-xs text-zinc-400">
            Your record — {personalStats.data.stats.rankName}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-300">
            <span>
              {formatInt(personalStats.data.stats.killsYesterday)} kills
              yesterday · {formatInt(personalStats.data.stats.killsTotal)} total
            </span>
            <span>
              {formatInt(personalStats.data.stats.vpYesterday)} VP yesterday ·{" "}
              {formatInt(personalStats.data.stats.vpTotal)} total
            </span>
            <span>
              Enlisted{" "}
              {formatEveDateTime(personalStats.data.stats.enlistedOn).slice(
                0,
                10,
              )}
            </span>
          </div>
        </div>
      )}
      {perspective && personalStats.data?.missingScope && (
        <div className="mt-4 rounded border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
          Re-login to see your personal FW record — this character&apos;s token
          predates the read-fw-stats scope.
        </div>
      )}

      {/* Warzone selector — hidden once a militia is selected, since the
          warzone is then derived from it. */}
      {perspective ? (
        <div className="mt-5 flex items-center gap-2 text-xs text-zinc-500">
          <span>Warzone</span>
          <span className="rounded border border-zinc-700 px-3 py-1 text-zinc-300">
            {activeZone}
          </span>
          <span className="text-zinc-600">derived from your perspective</span>
        </div>
      ) : (
        warzones.length > 0 && (
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
        )
      )}

      {map.isLoading && (
        <div className="mt-5 text-sm text-zinc-500">Loading warzone map…</div>
      )}
      {map.isError && (
        <div className="mt-5 text-sm text-rose-400">
          {errorMessage(map.error)}
        </div>
      )}

      {map.data && activeZone && (
        <Warzone
          data={map.data}
          zone={activeZone}
          perspective={perspective}
          loginBaseline={loginBaseline}
          autoRefresh={autoRefresh}
        />
      )}
    </Page>
  );
}
