import { useMemo, useState } from "react";
import { useQuery, type UseMutationResult } from "@tanstack/react-query";
import { BatteryCharging, BatteryWarning, ChevronDown } from "lucide-react";
import {
  fittingTargetProfiles,
  type CapStats,
  type DpsBreakdown,
  type EwTag,
  type FitPrice,
  type FitProblem,
  type FitStats,
  type NavStats,
  type NpcProfile,
  type ResourceUsage,
  type TankStats,
} from "../../lib/api";
import { formatDuration, formatInt, formatIsk } from "../../lib/format";
import { DAMAGE_TYPES, km, resistClass } from "./fitHelpers";
import {
  classifyArchetype,
  ARCHETYPE_LABEL,
  ARCHETYPE_CLASS,
} from "../../lib/shipArchetype";

/** Per-layer HP + EM/Th/Kin/Exp resistances for shield, armor and hull, plus
 *  each layer's remote-rep multiplier (RRM: how much a remote repair's raw
 *  GJ is amplified by that layer's resists against the selected profile).
 *  The armor row gets a "RAH" badge when a Reactive Armor Hardener's
 *  resist-shift was simulated — its resists are the shifted values, not the
 *  module's static baseline. */
export function TankResists({ tank }: { tank: TankStats }) {
  const layers = [
    {
      name: "Shield",
      hp: tank.shieldHp,
      r: tank.shieldResists,
      rrm: tank.shieldRrm,
    },
    {
      name: "Armor",
      hp: tank.armorHp,
      r: tank.armorResists,
      rrm: tank.armorRrm,
      rah: tank.rahActive,
    },
    { name: "Hull", hp: tank.hullHp, r: tank.hullResists, rrm: tank.hullRrm },
  ];
  return (
    <table className="w-full text-[11px] tabular-nums">
      <thead>
        <tr className="text-zinc-600">
          <th className="text-left font-normal" />
          <th className="pr-1 text-right font-normal">HP</th>
          {DAMAGE_TYPES.map((d) => (
            <th key={d} className="pl-1 text-right font-normal">
              {d}
            </th>
          ))}
          <th className="pl-2 text-right font-normal">RRM</th>
        </tr>
      </thead>
      <tbody>
        {layers.map((l) => (
          <tr key={l.name}>
            <td className="text-zinc-300">
              {l.name}
              {l.rah && (
                <span
                  className="ml-1 text-[9px] uppercase text-amber-500"
                  title="Reactive Armor Hardener resists shifted toward the selected damage profile"
                >
                  RAH
                </span>
              )}
            </td>
            <td className="pr-1 text-right text-zinc-400">
              {formatInt(Math.round(l.hp))}
            </td>
            {l.r.map((v, i) => (
              <td key={i} className={`pl-1 text-right ${resistClass(v)}`}>
                {Math.round(v * 100)}
              </td>
            ))}
            <td className="pl-2 text-right text-zinc-400">
              {l.rrm.toFixed(2)}×
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Capacitor gauge: a 0–100% fill when stable, or the time-to-empty when not. */
/**
 * EW projected onto the fit (#265): a presence badge per category — never a
 * magnitude. Web/paint/damp (whose effect is already in the stats) read solid;
 * unmodeled EW (tracking/guidance disruption, neut, nos) read muted. ECM is the
 * special case: a chance-to-jam, so it offers an opt-in "show jammed" toggle that
 * models the worst case (targeting disabled → 0 applied DPS) rather than a
 * passive effect.
 */
export function EwPanel({
  tags,
  jammed,
  onJam,
}: {
  tags: EwTag[];
  jammed: boolean;
  onJam: (v: boolean) => void;
}) {
  const hasEcm = tags.some((t) => t.jam);
  return (
    <div className="space-y-1">
      <h3 className="text-xs uppercase tracking-wide text-zinc-500">
        EW projected
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span
            key={t.category}
            title={
              t.modeled
                ? "Effect is applied in the stats above"
                : t.jam
                  ? "Chance-based jam — toggle below to view the jammed case"
                  : "Active — magnitude not modelled"
            }
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              t.jam
                ? "border border-amber-500/50 text-amber-300"
                : t.modeled
                  ? "bg-zinc-700 text-zinc-100"
                  : "border border-zinc-700 text-zinc-300"
            }`}
          >
            {t.label}
            {t.count > 1 ? ` ×${t.count}` : ""}
          </span>
        ))}
      </div>
      {hasEcm && (
        <label className="flex items-center gap-2 pt-0.5 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={jammed}
            onChange={(e) => onJam(e.currentTarget.checked)}
            className="accent-amber-500"
          />
          Show jammed (targeting disabled · 0 applied DPS)
        </label>
      )}
    </div>
  );
}

export function CapGauge({ cap }: { cap: CapStats }) {
  const color = cap.stable ? "#10b981" : "#ef4444";
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-zinc-400">Capacitor</span>
        {cap.stable ? (
          <span className="flex items-center gap-1 text-emerald-400">
            <BatteryCharging size={12} aria-hidden />
            Stable ·{" "}
            {Math.max(0, Math.min(100, cap.stablePct ?? 100)).toFixed(0)}%
          </span>
        ) : (
          <span className="flex items-center gap-1 text-red-400">
            <BatteryWarning size={12} aria-hidden />
            Empties in {formatDuration(cap.depletionSeconds ?? 0)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-x-2 text-[10px] text-zinc-500">
        <span>size {formatInt(cap.capacity)} GJ</span>
        <span>recharge {formatDuration(cap.rechargeSeconds)}</span>
        <span>peak {cap.peakRecharge.toFixed(1)} GJ/s</span>
      </div>
      {cap.trajectory.length > 1 ? (
        <CapChart trajectory={cap.trajectory} color={color} />
      ) : (
        <div className="mt-0.5 h-2 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full"
            style={{
              width: cap.stable
                ? `${Math.max(0, Math.min(100, cap.stablePct ?? 100))}%`
                : "100%",
              background: color,
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Cap-over-time curve (#265): inline SVG, full → settles or drains. The x-axis
 *  spans the sampled horizon; y is 0–100%. */
export function CapChart({
  trajectory,
  color,
}: {
  trajectory: [number, number][];
  color: string;
}) {
  const w = 240;
  const h = 56;
  const padY = 3;
  const tMax = trajectory[trajectory.length - 1][0] || 1;
  const x = (t: number) => (t / tMax) * w;
  const y = (pct: number) => padY + (1 - pct / 100) * (h - 2 * padY);
  const line = trajectory
    .map(([t, pct]) => `${x(t).toFixed(1)},${y(pct).toFixed(1)}`)
    .join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  const endSecs = trajectory[trajectory.length - 1][0];
  return (
    <div className="mt-1">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: h }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={w}
            y1={padY + f * (h - 2 * padY)}
            y2={padY + f * (h - 2 * padY)}
            stroke="#27272a"
            strokeWidth="0.75"
          />
        ))}
        <polygon points={area} fill={color} fillOpacity="0.12" stroke="none" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-600">
        <span>0s</span>
        <span>{formatDuration(endSecs)}</span>
      </div>
    </div>
  );
}

/** DPS-vs-range curve (#701): inline SVG, same pattern as [`CapChart`]. The
 *  x-axis spans 0 to the fit's max effective range (km); y is 0 to the peak
 *  applied DPS in the curve. */
export function DpsRangeCurve({ curve }: { curve: [number, number][] }) {
  const w = 240;
  const h = 56;
  const padY = 3;
  const distMax = curve[curve.length - 1][0] || 1;
  const dpsMax = Math.max(...curve.map(([, dps]) => dps), 1e-9);
  const x = (d: number) => (d / distMax) * w;
  const y = (dps: number) => padY + (1 - dps / dpsMax) * (h - 2 * padY);
  const line = curve
    .map(([d, dps]) => `${x(d).toFixed(1)},${y(dps).toFixed(1)}`)
    .join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  const color = "#f59e0b";
  return (
    <div className="mt-1">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: h }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={w}
            y1={padY + f * (h - 2 * padY)}
            y2={padY + f * (h - 2 * padY)}
            stroke="#27272a"
            strokeWidth="0.75"
          />
        ))}
        <polygon points={area} fill={color} fillOpacity="0.12" stroke="none" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-600">
        <span>0km</span>
        <span>{km(distMax)}</span>
      </div>
    </div>
  );
}

/** One overlaid line for `DpsRangeOverlayChart`: a labelled fit/ammo curve. */
export interface DpsRangeSeries {
  label: string;
  curve: [number, number][];
}

/** Overlay palette (#880): colour cycles alongside a distinct dash pattern per
 *  series so lines stay distinguishable in grayscale/for colourblind users,
 *  not colour alone (CLAUDE.md's color-signaling convention). Solid first
 *  (matches the single-curve `DpsRangeCurve`'s amber), then increasingly
 *  broken patterns. */
const OVERLAY_COLORS = [
  "#f59e0b",
  "#38bdf8",
  "#34d399",
  "#a78bfa",
  "#fb7185",
  "#facc15",
];
const OVERLAY_DASHES = [undefined, "6 3", "2 2", "8 2 2 2", "3 6", "1 3 4 3"];

/** Multi-fit DPS-vs-range overlay (#880): same axis/scale convention as
 *  [`DpsRangeCurve`], but N series sharing one x/y scale so crossovers
 *  (e.g. Void vs Null falloff) are directly readable. Series with fewer
 *  than 2 points (no target profile / no data) are dropped. */
export function DpsRangeOverlayChart({ series }: { series: DpsRangeSeries[] }) {
  const w = 480;
  const h = 140;
  const padY = 4;
  const valid = series
    .map((s, i) => ({
      ...s,
      color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
      dash: OVERLAY_DASHES[i % OVERLAY_DASHES.length],
    }))
    .filter((s) => s.curve.length > 1);
  if (valid.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        Set a target profile to see the DPS-vs-range overlay.
      </p>
    );
  }
  const distMax = Math.max(
    ...valid.map((s) => s.curve[s.curve.length - 1][0]),
    1,
  );
  const dpsMax = Math.max(
    ...valid.flatMap((s) => s.curve.map(([, dps]) => dps)),
    1e-9,
  );
  const x = (d: number) => (d / distMax) * w;
  const y = (dps: number) => padY + (1 - dps / dpsMax) * (h - 2 * padY);
  return (
    <div className="mt-1">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {valid.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <svg width="16" height="6" className="shrink-0">
              <line
                x1={0}
                x2={16}
                y1={3}
                y2={3}
                stroke={s.color}
                strokeWidth="2"
                strokeDasharray={s.dash}
              />
            </svg>
            <span className="text-zinc-300">{s.label}</span>
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: h }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={w}
            y1={padY + f * (h - 2 * padY)}
            y2={padY + f * (h - 2 * padY)}
            stroke="#27272a"
            strokeWidth="0.75"
          />
        ))}
        {valid.map((s) => (
          <polyline
            key={s.label}
            points={s.curve
              .map(([d, dps]) => `${x(d).toFixed(1)},${y(dps).toFixed(1)}`)
              .join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth="1.5"
            strokeDasharray={s.dash}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-600">
        <span>0km</span>
        <span>{km(distMax)}</span>
      </div>
    </div>
  );
}

export function ResourceBar({
  label,
  used,
  max,
  unit,
}: {
  label: string;
  used: number;
  max: number;
  unit: string;
}) {
  const frac = max > 0 ? Math.min(used / max, 1) : 0;
  const over = used > max + 1e-6;
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-400">
        <span>{label}</span>
        <span className={over ? "text-red-400" : ""}>
          {used.toFixed(1)} / {max.toFixed(0)} {unit}
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-zinc-800">
        <div
          className={`h-full ${over ? "bg-red-500" : "bg-emerald-500"}`}
          style={{ width: `${frac * 100}%` }}
        />
      </div>
    </div>
  );
}

/** Generic damage-profile presets for the tank panel's "incoming damage"
 *  picker: `[label, [em, therm, kin, exp]]`. Not fetched from the SDE — a
 *  fallback for "no specific enemy in mind". Real faction/content presets
 *  (#873) come from `fittingTargetProfiles`, grouped by faction alongside
 *  these under "Generic". */
const GENERIC_DAMAGE_PRESETS: [string, [number, number, number, number]][] = [
  ["Omni (even)", [0.25, 0.25, 0.25, 0.25]],
];

/**
 * The four numbers a fitter actually swaps modules to chase (#708): DPS, EHP,
 * capacitor stability and top speed, as a headline block instead of small
 * label/value stacks with the same weight as sensor strength. Capacitor is
 * colour-coded good/marginal/bad (stable & comfortable / stable & tight /
 * unstable) — the same three-state read as the resist table's colour scale.
 */
export function Vitals({
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
  const archetype = classifyArchetype(stats.weaponRanges ?? []);

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
      {archetype && (
        <div className="col-span-2 mt-0.5">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ARCHETYPE_CLASS[archetype]}`}
          >
            {ARCHETYPE_LABEL[archetype]}
          </span>
        </div>
      )}
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

/** Fitting-resource section: CPU/PG/calibration bars, capacitor gauge, the
 *  incoming-neut input feeding the cap simulation, and validation findings. */
export function ResourcesPanel({
  resources,
  capacitor,
  validation,
  neutGjs,
  onNeutGjs,
}: {
  resources: ResourceUsage;
  capacitor?: CapStats | null;
  validation: FitProblem[];
  neutGjs: number | undefined;
  onNeutGjs: (n: number | undefined) => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-zinc-500">Fitting</h3>
      <ResourceBar
        label="CPU"
        used={resources.cpuUsed}
        max={resources.cpuOutput}
        unit="tf"
      />
      <ResourceBar
        label="Powergrid"
        used={resources.powergridUsed}
        max={resources.powergridOutput}
        unit="MW"
      />
      <ResourceBar
        label="Calibration"
        used={resources.calibrationUsed}
        max={resources.calibrationOutput}
        unit=""
      />
      {capacitor && <CapGauge cap={capacitor} />}
      {capacitor && (
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">
            Incoming neut
          </div>
          <input
            type="number"
            min="0"
            step="1"
            placeholder="0 GJ/s"
            value={neutGjs ?? ""}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              onNeutGjs(v || undefined);
            }}
            className="w-20 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
          />
        </div>
      )}
      {validation.length > 0 && (
        <ul className="mt-2 space-y-1">
          {validation.map((p, i) => (
            <li key={i} className="text-xs text-red-400">
              ⚠ {p.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** DPS section: paper vs applied totals, per-weapon-kind split, and the
 *  DPS-vs-range curve when a target profile is set. */
export function DpsBreakdownPanel({
  skillLabel,
  dps,
  dpsSustained,
  appliedDps,
  dpsRangeCurve,
  jammedActive,
  isSpoolable = false,
  spoolPct,
  onSpoolPct,
  factorReload = false,
  onFactorReload,
}: {
  skillLabel: string;
  dps: DpsBreakdown;
  /** Sustained DPS (#871) — burst `dps` derated by clip depletion + reload
   *  pauses. Shown instead of burst when `factorReload` is on. */
  dpsSustained?: DpsBreakdown;
  appliedDps?: DpsBreakdown;
  dpsRangeCurve?: [number, number][];
  jammedActive: boolean;
  /** Whether the fit carries a Triglavian/spoolable weapon — shows the spool
   *  slider only then (#872). */
  isSpoolable?: boolean;
  spoolPct?: number;
  onSpoolPct?: (pct: number | undefined) => void;
  /** Reload-accounting toggle (#871): off shows infinite-ammo burst DPS
   *  (today's behavior); on shows `dpsSustained`. */
  factorReload?: boolean;
  onFactorReload?: (v: boolean) => void;
}) {
  const spoolPercent = Math.round((spoolPct ?? 1) * 100);
  const shown = factorReload && dpsSustained ? dpsSustained : dps;
  return (
    <div className="space-y-1">
      <h3 className="text-xs uppercase tracking-wide text-zinc-500">
        DPS ({skillLabel})
      </h3>
      {isSpoolable && onSpoolPct && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-zinc-500">
            <span>Spool-up</span>
            <span>{spoolPercent}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={spoolPercent}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              onSpoolPct(v === 100 ? undefined : v / 100);
            }}
            className="w-full"
            aria-label="Spool-up percentage"
          />
        </div>
      )}
      {onFactorReload && (
        <label className="flex items-center justify-between text-[10px] uppercase tracking-wide text-zinc-500">
          <span>Factor reload</span>
          <input
            type="checkbox"
            checked={factorReload}
            onChange={(e) => onFactorReload(e.currentTarget.checked)}
            aria-label="Factor reload"
          />
        </label>
      )}
      {jammedActive ? (
        <div className="text-sm text-amber-400">
          Jammed — 0 applied (no lock)
        </div>
      ) : (
        <>
          <div className="text-sm text-zinc-300">
            {shown.total.toFixed(0)} dps
            {factorReload && dpsSustained && (
              <span className="text-zinc-500"> (sustained)</span>
            )}
          </div>
          {shown.total > 0 && (
            <div className="text-xs text-zinc-500">
              {shown.turret > 0 && `turret ${shown.turret.toFixed(0)} `}
              {shown.missile > 0 && `· missile ${shown.missile.toFixed(0)} `}
              {shown.drone > 0 && `· drone ${shown.drone.toFixed(0)}`}
            </div>
          )}
          {factorReload && dpsSustained && (
            <div className="text-xs text-zinc-500">
              burst {dps.total.toFixed(0)} dps
            </div>
          )}
          {appliedDps && (
            <div className="text-xs text-zinc-500">
              applied:{" "}
              <span className="text-amber-400">
                {appliedDps.total.toFixed(0)} dps
              </span>{" "}
              (vs paper {dps.total.toFixed(0)} dps)
            </div>
          )}
          {dpsRangeCurve && dpsRangeCurve.length > 1 && (
            <DpsRangeCurve curve={dpsRangeCurve} />
          )}
        </>
      )}
    </div>
  );
}

/** One flattened, filterable/groupable damage-profile option. */
interface DamageOption {
  kind: string;
  label: string;
  profile: [number, number, number, number];
}

/** Tank section: incoming-damage-profile picker (#873: a searchable dropdown
 *  grouped by faction/content-type, sourced from the SDE-derived NPC library
 *  plus generic fallbacks — see `fittingTargetProfiles`), EHP headline,
 *  active reps, and the per-layer resist table. */
export function TankResistsPanel({
  skillLabel,
  tank,
  damageProfile,
  onDamageProfile,
}: {
  skillLabel: string;
  tank: TankStats;
  damageProfile: [number, number, number, number] | undefined;
  onDamageProfile: (p: [number, number, number, number] | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const library = useQuery({
    queryKey: ["fitting", "targetProfiles"],
    queryFn: fittingTargetProfiles,
  });
  const grouped = useMemo(() => {
    const options: DamageOption[] = [
      ...GENERIC_DAMAGE_PRESETS.map(([label, profile]) => ({
        kind: "Generic",
        label,
        profile,
      })),
      ...(library.data?.builtIn ?? []).map((p: NpcProfile) => ({
        kind: p.group,
        label: p.label,
        profile: p.damageProfile,
      })),
      ...(library.data?.custom ?? []).map((p: NpcProfile) => ({
        kind: "Custom",
        label: p.label,
        profile: p.damageProfile,
      })),
    ];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(needle) ||
            o.kind.toLowerCase().includes(needle),
        )
      : options;
    const byKind = new Map<string, DamageOption[]>();
    for (const o of filtered)
      byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);
    return [...byKind.entries()];
  }, [library.data, q]);
  const selectedLabel =
    [
      ...GENERIC_DAMAGE_PRESETS,
      ...(library.data?.builtIn ?? []).map(
        (p) => [p.label, p.damageProfile] as const,
      ),
      ...(library.data?.custom ?? []).map(
        (p) => [p.label, p.damageProfile] as const,
      ),
    ].find(
      ([, p]) =>
        damageProfile && JSON.stringify(p) === JSON.stringify(damageProfile),
    )?.[0] ?? (damageProfile ? "Custom values" : "Omni (even)");

  return (
    <div className="space-y-1">
      <h3 className="text-xs uppercase tracking-wide text-zinc-500">
        Tank ({skillLabel})
      </h3>
      <div className="relative space-y-0.5">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">
          Incoming damage
        </div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 hover:bg-zinc-700"
        >
          <span className="max-w-40 truncate">{selectedLabel}</span>
          <ChevronDown size={12} />
        </button>
        {open && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setOpen(false)}
            />
            <div className="absolute left-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 p-1 shadow-lg">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.currentTarget.value)}
                placeholder="filter (guristas, sleeper…)"
                className="mb-1 w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
              />
              {grouped.map(([kind, opts]) => (
                <div key={kind}>
                  <div className="mt-1 px-2 text-[10px] uppercase tracking-wide text-zinc-500">
                    {kind}
                  </div>
                  <ul>
                    {opts.map((o) => (
                      <li key={`${o.kind}-${o.label}`}>
                        <button
                          onClick={() => {
                            onDamageProfile(o.profile);
                            setOpen(false);
                          }}
                          className="block w-full truncate rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-800"
                        >
                          {o.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {library.isFetched && grouped.length === 0 && (
                <div className="px-2 py-1 text-xs text-zinc-500">
                  No matches.
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="text-sm text-zinc-300">
        {formatInt(Math.round(tank.ehp))} EHP
      </div>
      {(tank.shieldRepS > 0 ||
        tank.armorRepS > 0 ||
        tank.passiveShieldS > 0) && (
        <div className="flex flex-wrap gap-x-3 text-xs text-zinc-500">
          {tank.shieldRepS > 0 && (
            <span>
              shield boost{" "}
              <span className="tabular-nums text-sky-400">
                {tank.shieldRepS.toFixed(1)}/s
              </span>
              {tank.shieldRepSSustained < tank.shieldRepS - 0.05 && (
                <span className="text-zinc-600">
                  {" "}
                  (
                  <span className="tabular-nums text-sky-600">
                    {tank.shieldRepSSustained.toFixed(1)}/s
                  </span>{" "}
                  sustained)
                </span>
              )}
            </span>
          )}
          {tank.armorRepS > 0 && (
            <span>
              armor rep{" "}
              <span className="tabular-nums text-amber-400">
                {tank.armorRepS.toFixed(1)}/s
              </span>
              {tank.armorRepSSustained < tank.armorRepS - 0.05 && (
                <span className="text-zinc-600">
                  {" "}
                  (
                  <span className="tabular-nums text-amber-600">
                    {tank.armorRepSSustained.toFixed(1)}/s
                  </span>{" "}
                  sustained)
                </span>
              )}
            </span>
          )}
          {tank.passiveShieldS > 0 && (
            <span>
              passive shield{" "}
              <span className="tabular-nums text-sky-300">
                {tank.passiveShieldS.toFixed(1)}/s
              </span>
            </span>
          )}
        </div>
      )}
      <TankResists tank={tank} />
    </div>
  );
}

/** Navigation section: speed, align time, signature and (when known) lock
 *  range from the targeting stats. */
export function NavigationPanel({
  navigation,
  lockRange,
}: {
  navigation: NavStats;
  lockRange?: number;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs uppercase tracking-wide text-zinc-500">
        Navigation
      </h3>
      <div className="text-xs text-zinc-400">
        {Math.round(navigation.maxVelocity)} m/s · align{" "}
        {navigation.alignTime.toFixed(1)}s · sig{" "}
        {Math.round(navigation.signatureRadius)}m
        {lockRange ? ` · lock ${km(lockRange)}` : ""}
      </div>
    </div>
  );
}

/** Price section: an on-demand "Price fit" button plus the last buy/sell
 *  valuation, driven by the page-level price mutation. */
export function PricePanel({
  price,
}: {
  price: UseMutationResult<FitPrice, Error, void, unknown>;
}) {
  return (
    <div className="mt-4 space-y-1">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500">Price</h3>
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
  );
}
