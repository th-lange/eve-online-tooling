import type { UseMutationResult } from "@tanstack/react-query";
import { errorMessage, type FitPrice } from "../../lib/api";
import {
  DpsBreakdownPanel,
  EwPanel,
  FleetBoostsPanel,
  NavigationPanel,
  PricePanel,
  ResourcesPanel,
  TankResistsPanel,
  Vitals,
} from "./components";
import { useFitState, useFitStats } from "./useFitEditorContext";

/** Right-hand stats sidebar: a sticky vitals headline (DPS/EHP/cap/speed) over
 *  the detail stats (resources, DPS breakdown, EW, tank resists, navigation)
 *  and price — purely presentational, driven by the simulate query
 *  (`FitEditorContext`) and the page-level `price` mutation. Each detail
 *  section is its own panel component (`StatsPanels.tsx`); this is just the
 *  layout and loading/empty-state wrapper around them. */
export function StatsAside({
  price,
}: {
  price: UseMutationResult<FitPrice, Error, void, unknown>;
}) {
  const {
    skillLabel,
    jammed,
    setJammed,
    damageProfile,
    setDamageProfile,
    neutGjs,
    setNeutGjs,
    spoolPct,
    setSpoolPct,
    factorReload,
    setFactorReload,
  } = useFitState();
  const { stats, jammedActive } = useFitStats();
  const onJam = setJammed;
  const onDamageProfile = setDamageProfile;
  const onNeutGjs = setNeutGjs;
  return (
    <aside className="w-72 shrink-0 overflow-auto">
      {/* Sticky so the headline numbers stay visible while detail scrolls. */}
      <div className="sticky top-0 z-10 bg-zinc-950 pb-3">
        <div className="flex h-5 items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-200">Stats</h2>
          {stats.isFetching && (
            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
              Evaluating…
            </span>
          )}
        </div>
        {stats.data && (
          <div className="mt-2">
            <Vitals stats={stats.data} jammedActive={jammedActive} />
          </div>
        )}
      </div>

      {stats.isError && (
        <p className="text-xs text-red-400">
          Eval failed: {errorMessage(stats.error)}
        </p>
      )}
      {!stats.data && !stats.isFetching && !stats.isError && (
        <p className="text-xs text-zinc-500">Add modules to see stats.</p>
      )}
      <div
        className={
          stats.isFetching
            ? "space-y-4 opacity-50 transition-opacity"
            : "space-y-4"
        }
      >
        {stats.data && (
          <ResourcesPanel
            resources={stats.data.resources}
            capacitor={stats.data.capacitor}
            validation={stats.data.validation}
            neutGjs={neutGjs}
            onNeutGjs={onNeutGjs}
          />
        )}

        {stats.data?.dps && (
          <DpsBreakdownPanel
            skillLabel={skillLabel}
            dps={stats.data.dps}
            dpsSustained={stats.data.dpsSustained ?? undefined}
            appliedDps={stats.data.appliedDps}
            dpsRangeCurve={stats.data.dpsRangeCurve}
            jammedActive={jammedActive}
            isSpoolable={!!stats.data.isSpoolable}
            spoolPct={spoolPct}
            onSpoolPct={setSpoolPct}
            factorReload={factorReload}
            onFactorReload={setFactorReload}
          />
        )}

        {stats.data?.projectedEw && stats.data.projectedEw.length > 0 && (
          <EwPanel
            tags={stats.data.projectedEw}
            jammed={jammed}
            onJam={onJam}
          />
        )}

        {stats.data?.tank && (
          <TankResistsPanel
            skillLabel={skillLabel}
            tank={stats.data.tank}
            damageProfile={damageProfile}
            onDamageProfile={onDamageProfile}
          />
        )}

        {stats.data?.navigation && (
          <NavigationPanel
            navigation={stats.data.navigation}
            lockRange={stats.data.targeting?.lockRange}
          />
        )}
      </div>

      <PricePanel price={price} />

      <FleetBoostsPanel />
    </aside>
  );
}
