import { memo } from "react";
import type { DpsTick, PilotRate, WeaponRate } from "../../lib/api";
import { formatInt } from "../../lib/format";
import { QualityBar } from "./HitQualityIndicators";

/** Top weapons by outgoing DPS. Memoized: skips re-render when `rows` is
 *  unchanged (e.g. the page re-renders for an unrelated control change). */
const WeaponTable = memo(function WeaponTable({
  rows,
}: {
  rows: WeaponRate[];
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Damage by weapon
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No outgoing damage in the window.
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 text-zinc-200">
                  {r.name}
                  {r.kind ? (
                    <span className="text-zinc-500"> · {r.kind}</span>
                  ) : null}
                  {r.damage ? (
                    <span className="text-zinc-600"> [{r.damage}]</span>
                  ) : null}
                </td>
                <td className="py-1 text-right tabular-nums text-emerald-400">
                  {formatInt(Math.round(r.dps))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});

/** Per-source damage breakdown for a combatant row: one line per weapon/ammo/
 *  drone with its dps, source kind, and (where the SDE knows it) damage type. */
function WeaponLines({ weapons }: { weapons?: WeaponRate[] }) {
  if (!weapons || weapons.length === 0) return null;
  return (
    <div className="mt-0.5 space-y-px">
      {weapons.map((wpn) => (
        <div
          key={wpn.name}
          className="flex items-baseline justify-between gap-2 text-[10px] text-zinc-500"
        >
          <span className="truncate">
            {wpn.name}
            {wpn.kind ? ` · ${wpn.kind}` : ""}
            {wpn.damage ? (
              <span className="text-zinc-600"> [{wpn.damage}]</span>
            ) : null}
          </span>
          <span className="shrink-0 tabular-nums">
            {formatInt(Math.round(wpn.dps))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Tackle chips for a combatant row: scram (warp scrambler — stops warp and
 *  MWD) and point (warp disruptor) active within the window. Distinct warm
 *  colours so they stand apart from the cool quality ramp. */
export function TackleTags({
  scram,
  point,
}: {
  scram?: boolean;
  point?: boolean;
}) {
  if (!scram && !point) return null;
  return (
    <span className="ml-1 inline-flex gap-1 align-middle">
      {scram ? (
        <span
          className="rounded bg-rose-500/20 px-1 text-[9px] font-semibold uppercase tracking-wide text-rose-300"
          title="Warp scrambler active"
        >
          scram
        </span>
      ) : null}
      {point ? (
        <span
          className="rounded bg-amber-500/20 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-300"
          title="Warp disruptor (point) active"
        >
          point
        </span>
      ) : null}
    </span>
  );
}

/** Enemies you are shooting — ranked by outgoing DPS. Row dots carry the
 *  per-source colour used by the by-source charts and filter chips. */
const TargetsTable = memo(function TargetsTable({
  rows,
  colors,
}: {
  rows: PilotRate[];
  colors: Map<string, string>;
}) {
  const sorted = [...rows]
    .filter((r) => r.dpsOut > 0)
    .sort((a, b) => b.dpsOut - a.dpsOut);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Targets (dealt)
      </div>
      {sorted.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No outgoing damage in the window.
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 align-top text-zinc-200">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: colors.get(r.name) }}
                    />
                    {r.name}
                    <TackleTags scram={r.scramOut} point={r.pointOut} />
                  </span>
                  <WeaponLines weapons={r.weaponsOut} />
                  <QualityBar q={r.qualityOut} />
                </td>
                <td className="py-1 pl-2 text-right align-top tabular-nums text-emerald-400">
                  {formatInt(Math.round(r.dpsOut))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});

/** Enemies attacking you — ranked by incoming DPS. Row dots carry the
 *  per-source colour used by the by-source charts and filter chips. */
const AttackersTable = memo(function AttackersTable({
  rows,
  colors,
}: {
  rows: PilotRate[];
  colors: Map<string, string>;
}) {
  const sorted = [...rows]
    .filter((r) => r.dpsIn > 0)
    .sort((a, b) => b.dpsIn - a.dpsIn);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Attackers (taken)
      </div>
      {sorted.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No incoming damage in the window.
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 align-top text-zinc-200">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: colors.get(r.name) }}
                    />
                    {r.name}
                    <TackleTags scram={r.scramIn} point={r.pointIn} />
                  </span>
                  <WeaponLines weapons={r.weaponsIn} />
                  <QualityBar q={r.qualityIn} />
                </td>
                <td className="py-1 pl-2 text-right align-top tabular-nums text-rose-400">
                  {formatInt(Math.round(r.dpsIn))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});

/** Breakdowns: weapons you used · targets you shot · attackers on you.
 *  Shown once the latest tick has any tracked activity. */
export function FightBreakdown({
  latest,
  pilotRows,
  colors,
}: {
  latest: DpsTick | undefined;
  pilotRows: PilotRate[];
  colors: Map<string, string>;
}) {
  if (!latest || (latest.byWeapon.length === 0 && latest.byPilot.length === 0))
    return null;
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <WeaponTable rows={latest.byWeapon} />
      <TargetsTable rows={pilotRows} colors={colors} />
      <AttackersTable rows={pilotRows} colors={colors} />
    </div>
  );
}
