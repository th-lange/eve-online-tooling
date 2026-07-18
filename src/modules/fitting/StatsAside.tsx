import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { errorMessage, type FitPrice, type FitStats } from "../../lib/api";
import { formatInt, formatIsk } from "../../lib/format";
import { CapGauge, EwPanel, ResourceBar, TankResists } from "./components";

/** Right-hand stats sidebar: fitting resources, DPS, tank, navigation, and
 *  price — purely presentational, driven by the simulate/price queries
 *  `useFitEditor`/the page-level `price` mutation own. */
export function StatsAside({
  stats,
  skillLabel,
  jammed,
  onJam,
  jammedActive,
  price,
}: {
  stats: UseQueryResult<FitStats, Error>;
  skillLabel: string;
  jammed: boolean;
  onJam: (jammed: boolean) => void;
  jammedActive: boolean;
  price: UseMutationResult<FitPrice, Error, void, unknown>;
}) {
  return (
    <aside className="w-72 shrink-0 space-y-4 overflow-auto">
      <div className="flex h-5 items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-200">Stats</h2>
        {stats.isFetching && (
          <span className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
            Evaluating…
          </span>
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
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-zinc-500">
              Fitting
            </h3>
            <ResourceBar
              label="CPU"
              used={stats.data.resources.cpuUsed}
              max={stats.data.resources.cpuOutput}
              unit="tf"
            />
            <ResourceBar
              label="Powergrid"
              used={stats.data.resources.powergridUsed}
              max={stats.data.resources.powergridOutput}
              unit="MW"
            />
            <ResourceBar
              label="Calibration"
              used={stats.data.resources.calibrationUsed}
              max={stats.data.resources.calibrationOutput}
              unit=""
            />
            {stats.data.capacitor && <CapGauge cap={stats.data.capacitor} />}
            {stats.data.validation.length > 0 && (
              <ul className="mt-2 space-y-1">
                {stats.data.validation.map((p, i) => (
                  <li key={i} className="text-xs text-red-400">
                    ⚠ {p.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {stats.data?.dps && (
          <div className="space-y-1">
            <h3 className="text-xs uppercase tracking-wide text-zinc-500">
              DPS ({skillLabel})
            </h3>
            {jammedActive ? (
              <div className="text-sm text-amber-400">
                Jammed — 0 applied (no lock)
              </div>
            ) : (
              <>
                <div className="text-sm text-zinc-300">
                  {stats.data.dps.total.toFixed(1)} dps
                </div>
                {stats.data.dps.total > 0 && (
                  <div className="text-xs text-zinc-500">
                    {stats.data.dps.turret > 0 &&
                      `turret ${stats.data.dps.turret.toFixed(1)} `}
                    {stats.data.dps.missile > 0 &&
                      `· missile ${stats.data.dps.missile.toFixed(1)} `}
                    {stats.data.dps.drone > 0 &&
                      `· drone ${stats.data.dps.drone.toFixed(1)}`}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {stats.data?.projectedEw && stats.data.projectedEw.length > 0 && (
          <EwPanel
            tags={stats.data.projectedEw}
            jammed={jammed}
            onJam={onJam}
          />
        )}

        {stats.data?.tank && (
          <div className="space-y-1">
            <h3 className="text-xs uppercase tracking-wide text-zinc-500">
              Tank ({skillLabel})
            </h3>
            <div className="text-sm text-zinc-300">
              {formatInt(Math.round(stats.data.tank.ehp))} EHP
            </div>
            {(stats.data.tank.shieldRepS > 0 ||
              stats.data.tank.armorRepS > 0 ||
              stats.data.tank.passiveShieldS > 0) && (
              <div className="flex flex-wrap gap-x-3 text-xs text-zinc-500">
                {stats.data.tank.shieldRepS > 0 && (
                  <span>
                    shield boost{" "}
                    <span className="tabular-nums text-sky-400">
                      {stats.data.tank.shieldRepS.toFixed(1)}/s
                    </span>
                  </span>
                )}
                {stats.data.tank.armorRepS > 0 && (
                  <span>
                    armor rep{" "}
                    <span className="tabular-nums text-amber-400">
                      {stats.data.tank.armorRepS.toFixed(1)}/s
                    </span>
                  </span>
                )}
                {stats.data.tank.passiveShieldS > 0 && (
                  <span>
                    passive shield{" "}
                    <span className="tabular-nums text-sky-300">
                      {stats.data.tank.passiveShieldS.toFixed(1)}/s
                    </span>
                  </span>
                )}
              </div>
            )}
            <TankResists tank={stats.data.tank} />
          </div>
        )}

        {stats.data?.navigation && (
          <div className="space-y-1">
            <h3 className="text-xs uppercase tracking-wide text-zinc-500">
              Navigation
            </h3>
            <div className="text-xs text-zinc-400">
              {Math.round(stats.data.navigation.maxVelocity)} m/s · align{" "}
              {stats.data.navigation.alignTime.toFixed(1)}s · sig{" "}
              {Math.round(stats.data.navigation.signatureRadius)}m
            </div>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-wide text-zinc-500">
            Price
          </h3>
          <button
            onClick={() => price.mutate()}
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {price.isPending ? "…" : "Price fit"}
          </button>
        </div>
        {price.data && (
          <div className="text-sm text-zinc-300">
            <div>Buy: {formatIsk(price.data.buyTotal)}</div>
            <div>Sell: {formatIsk(price.data.sellTotal)}</div>
          </div>
        )}
      </div>
    </aside>
  );
}
