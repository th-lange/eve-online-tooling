import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  sdeSearchShips,
  whRoute,
  type IdName,
  type RouteResult,
  type SystemMatch,
} from "../../lib/api";
import { SEC_TEXT_CLASS, secBand } from "../../lib/security";
import { Combo } from "../../components/Combo";
import { Field } from "../../components/forms";
import { SystemPicker } from "./shared";

/** Route between two systems over stargates ∪ mapped wormhole connections.
 * An optional ship drops holes the hull can't pass (by jump-mass class) and
 * flags hops through mass-critical holes. */
export function Routing() {
  const [origin, setOrigin] = useState<SystemMatch | null>(null);
  const [dest, setDest] = useState<SystemMatch | null>(null);
  const [ship, setShip] = useState<IdName | null>(null);
  const [avoidEol, setAvoidEol] = useState(true);
  const route = useMutation({
    mutationFn: () => whRoute(origin!.id, dest!.id, avoidEol, ship?.id ?? null),
  });
  const r: RouteResult | undefined = route.data;

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-sm font-semibold text-zinc-300">Route</span>
        <Field label="From">
          <SystemPicker picked={origin} onPick={setOrigin} />
        </Field>
        <Field label="To">
          <SystemPicker picked={dest} onPick={setDest} />
        </Field>
        <Field label="Ship (optional)">
          <Combo
            value={ship}
            onPick={setShip}
            search={sdeSearchShips}
            placeholder="Any hull…"
            width="w-40"
          />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={avoidEol}
            onChange={(e) => setAvoidEol(e.currentTarget.checked)}
          />
          Avoid EOL holes
        </label>
        <button
          onClick={() => route.mutate()}
          disabled={!origin || !dest || route.isPending}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Find route
        </button>
      </div>
      {route.isError && (
        <div className="mt-2 text-sm text-rose-400">
          {route.error instanceof Error
            ? route.error.message
            : String(route.error)}
        </div>
      )}
      {r && !r.reachable && (
        <div className="mt-2 text-sm text-rose-400">
          No route found
          {ship
            ? " for this hull (try without a ship, or without \"avoid EOL\")."
            : ' (try without "avoid EOL").'}
        </div>
      )}
      {r && r.reachable && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-zinc-500">
            {r.jumps} jump{r.jumps === 1 ? "" : "s"}
            {r.hops.some((h) => h.critMass) && (
              <span className="ml-2 text-amber-400">
                ⚠ crosses a mass-critical hole
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {r.hops.map((h, i) => (
              <span
                key={`${h.systemId}-${i}`}
                className="flex items-center gap-1"
              >
                {i > 0 && (
                  <span
                    className={
                      h.via === "wormhole" ? "text-purple-400" : "text-zinc-600"
                    }
                  >
                    {h.via === "wormhole" ? "⤳" : "→"}
                  </span>
                )}
                <span
                  className={`rounded border px-2 py-0.5 text-xs ${
                    h.critMass
                      ? "border-amber-600 bg-amber-950/30"
                      : h.wspace
                        ? "border-purple-700 bg-purple-950/40"
                        : "border-zinc-700 bg-zinc-900"
                  }`}
                  title={h.critMass ? `${h.via} · mass critical` : h.via}
                >
                  {h.wspace ? (
                    <span className="text-purple-300">{h.name}</span>
                  ) : (
                    <>
                      <span className={SEC_TEXT_CLASS[secBand(h.security)]}>
                        {h.security.toFixed(1)}
                      </span>{" "}
                      <span className="text-zinc-200">{h.name}</span>
                    </>
                  )}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
