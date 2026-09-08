import { useQuery } from "@tanstack/react-query";
import { fittingAmmoTable, type Fit, type SkillSource } from "../../lib/api";
import { formatInt } from "../../lib/format";
import { km } from "./fitHelpers";

/**
 * DPS / range / tracking for every ammo in the cargo hold the fit's weapons can
 * load — a quick "which load for this range" comparison, best DPS first. Hidden
 * when there's nothing to compare (no chargeable weapons, or no loadable ammo in
 * the cargo). Runs its own simulate-per-ammo query off the current fit + skills.
 */
export function AmmoTable({
  fit,
  skillSource,
}: {
  fit: Fit;
  skillSource: SkillSource;
}) {
  const rows = useQuery({
    queryKey: ["fitting", "ammoTable", fit, skillSource],
    queryFn: () => fittingAmmoTable(fit, skillSource),
  });
  const data = rows.data ?? [];
  if (data.length === 0) return null;
  return (
    <div className="mt-3 space-y-1">
      <h3 className="text-xs uppercase tracking-wide text-zinc-500">
        Cargo ammo
      </h3>
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-left text-zinc-600">
            <th className="font-normal">Ammo</th>
            <th className="pl-2 text-right font-normal">DPS</th>
            <th className="pl-2 text-right font-normal">Optimal</th>
            <th className="pl-2 text-right font-normal">Falloff</th>
            <th className="pl-2 text-right font-normal">Tracking</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.typeId} className="text-zinc-300">
              <td className="truncate pr-2" title={r.name}>
                {r.name}
              </td>
              <td className="pl-2 text-right">{formatInt(r.dps)}</td>
              <td className="pl-2 text-right">{km(r.optimal)}</td>
              <td className="pl-2 text-right text-zinc-500">
                {r.falloff > 0 ? `+${km(r.falloff)}` : "—"}
              </td>
              <td className="pl-2 text-right text-zinc-500">
                {r.tracking > 0 ? r.tracking.toFixed(3) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
