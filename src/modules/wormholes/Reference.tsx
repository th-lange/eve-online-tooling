import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  whSystemReference,
  type SystemMatch,
  type WormholeType,
} from "../../lib/api";
import { fmtHours, fmtMkg } from "./helpers";
import { maxShipLabel } from "./whTypes";

/** Class / effect / statics for a selected system (Anoik.is snapshot + SDE
 * physics). Renders only when the system is classified or in the snapshot. */
export function SystemReferencePanel({ system }: { system: SystemMatch }) {
  const ref = useQuery({
    queryKey: ["wh", "systemRef", system.id],
    queryFn: () => whSystemReference(system.id),
    staleTime: Infinity,
  });
  const r = ref.data;
  if (!r || (!r.found && r.class == null)) return null;
  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-300">
          {system.name}
        </span>
        {r.classLabel && (
          <span className="rounded border border-purple-700 bg-purple-950/40 px-1.5 py-0.5 text-xs text-purple-200">
            {r.classLabel}
          </span>
        )}
        {r.effect && (
          <span className="rounded border border-amber-700 bg-amber-950/30 px-1.5 py-0.5 text-xs text-amber-200">
            {r.effect}
          </span>
        )}
        {!r.found && (
          <span className="text-[11px] text-zinc-500">
            not in statics snapshot
          </span>
        )}
      </div>
      {r.statics.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">
            Statics
          </div>
          <div className="flex flex-wrap gap-2">
            {r.statics.map((s) => (
              <span
                key={s.code}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs"
                title={`${s.code} → ${s.destClassLabel}${s.maxStableMass != null ? ` · ${fmtMkg(s.maxStableMass)} total` : ""}`}
              >
                <span className="text-teal-300">{s.code}</span>
                <span className="text-zinc-500"> → {s.destClassLabel}</span>
                <span className="text-zinc-500">
                  {" "}
                  · max {maxShipLabel(s.maxJumpMass)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Browsable wormhole-type reference (the offline whtype.info clone). */
export function WhTypeTable({ types }: { types: WormholeType[] }) {
  const [open, setOpen] = useState(false);
  if (types.length === 0) return null;
  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium text-zinc-400 hover:text-zinc-200"
      >
        {open ? "▾" : "▸"} Wormhole types ({types.length})
      </button>
      {open && (
        <div className="mt-2 max-h-96 overflow-auto rounded border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Code</th>
                <th className="px-3 py-1.5 text-left font-medium">Dest</th>
                <th className="px-3 py-1.5 text-left font-medium">Max ship</th>
                <th className="px-3 py-1.5 text-right font-medium">Max jump</th>
                <th className="px-3 py-1.5 text-right font-medium">
                  Total mass
                </th>
                <th className="px-3 py-1.5 text-right font-medium">Life</th>
                <th className="px-3 py-1.5 text-right font-medium">Regen</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr
                  key={t.typeId}
                  className="border-t border-zinc-800 text-zinc-300"
                >
                  <td className="px-3 py-1 text-teal-300">{t.code}</td>
                  <td className="px-3 py-1 text-zinc-400">
                    {t.destClassLabel}
                  </td>
                  <td className="px-3 py-1 text-zinc-400">
                    {maxShipLabel(t.maxJumpMass)}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {t.maxJumpMass != null ? fmtMkg(t.maxJumpMass) : "—"}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {t.maxStableMass != null ? fmtMkg(t.maxStableMass) : "—"}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {fmtHours(t.maxStableTimeMin)}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {t.massRegen != null ? fmtMkg(t.massRegen) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
