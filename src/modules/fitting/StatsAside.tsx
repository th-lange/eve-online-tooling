import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { errorMessage, type FitPrice, type FitStats } from "../../lib/api";
import { formatDuration, formatInt, formatIsk } from "../../lib/format";
import { CapGauge, EwPanel, ResourceBar, TankResists } from "./components";

/**
 * The four numbers a fitter actually swaps modules to chase (#708): DPS, EHP,
 * capacitor stability and top speed, as a headline block instead of small
 * label/value stacks with the same weight as sensor strength. Capacitor is
 * colour-coded good/marginal/bad (stable & comfortable / stable & tight /
 * unstable) — the same three-state read as the resist table's colour scale.
 */
function Vitals({
  stats,
  jammedActive,
}: {
  stats: FitStats;
  jammedActive: boolean;
}) {
  const dps = jammedActive ? 0 : (stats.dps?.total ?? null);
  const ehp = stats.tank?.ehp ?? null;
  const cap = stats.capacitor ?? null;
  const speed = stats.navigation?.maxVelocity ?? null;

  const capTone: "good" | "warn" | "bad" | "neutral" = !cap
    ? "neutral"
    : !cap.stable
      ? "bad"
      : (cap.stablePct ?? 100) >= 50
        ? "good"
        : "warn";
  const capToneClass = {
    good: "text-emerald-400",
    warn: "text-amber-400",
    bad: "text-red-400",
    neutral: "text-zinc-100",
  }[capTone];

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <VitalStat
        label="DPS"
        value={dps == null ? "—" : dps.toFixed(0)}
        suffix={jammedActive ? "jammed (no lock)" : undefined}
        suffixClassName={jammedActive ? "text-amber-400" : undefined}
      />
      <VitalStat
        label="EHP"
        value={ehp == null ? "—" : formatInt(Math.round(ehp))}
      />
      <VitalStat
        label="Capacitor"
        value={
          cap == null
            ? "—"
            : cap.stable
              ? `${Math.max(0, Math.min(100, cap.stablePct ?? 100)).toFixed(0)}%`
              : formatDuration(cap.depletionSeconds ?? 0)
        }
        valueClassName={capToneClass}
        suffix={cap == null ? undefined : cap.stable ? "stable" : "to empty"}
      />
      <VitalStat
        label="Speed"
        value={speed == null ? "—" : `${Math.round(speed)} m/s`}
      />
    </div>
  );
}

function VitalStat({
  label,
  value,
  valueClassName = "text-zinc-100",
  suffix,
  suffixClassName = "text-zinc-500",
}: {
  label: string;
  value: string;
  valueClassName?: string;
  suffix?: string;
  suffixClassName?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div
        className={`text-xl font-semibold leading-tight tabular-nums ${valueClassName}`}
      >
        {value}
      </div>
      {suffix && (
        <div className={`truncate text-[10px] ${suffixClassName}`}>
          {suffix}
        </div>
      )}
    </div>
  );
}

/** Right-hand stats sidebar: a sticky vitals headline (DPS/EHP/cap/speed) over
 *  the detail stats (resources, DPS breakdown, EW, tank resists, navigation)
 *  and price — purely presentational, driven by the simulate/price queries
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

      <div className="mt-4 space-y-1">
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
