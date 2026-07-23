import { type CapStats, type EwTag, type TankStats } from "../../lib/api";
import { formatDuration, formatInt } from "../../lib/format";
import { DAMAGE_TYPES, km, resistClass } from "./fitHelpers";

/** Per-layer HP + EM/Th/Kin/Exp resistances for shield, armor and hull. */
export function TankResists({ tank }: { tank: TankStats }) {
  const layers = [
    { name: "Shield", hp: tank.shieldHp, r: tank.shieldResists },
    { name: "Armor", hp: tank.armorHp, r: tank.armorResists },
    { name: "Hull", hp: tank.hullHp, r: tank.hullResists },
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
        </tr>
      </thead>
      <tbody>
        {layers.map((l) => (
          <tr key={l.name}>
            <td className="text-zinc-300">{l.name}</td>
            <td className="pr-1 text-right text-zinc-400">
              {formatInt(Math.round(l.hp))}
            </td>
            {l.r.map((v, i) => (
              <td key={i} className={`pl-1 text-right ${resistClass(v)}`}>
                {Math.round(v * 100)}
              </td>
            ))}
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
          <span className="text-emerald-400">
            stable ·{" "}
            {Math.max(0, Math.min(100, cap.stablePct ?? 100)).toFixed(0)}%
          </span>
        ) : (
          <span className="text-red-400">
            empties in {formatDuration(cap.depletionSeconds ?? 0)}
          </span>
        )}
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
