import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  errorMessage,
  sdeSearchShips,
  whJumpPlan,
  type IdName,
  type JumpPlan,
} from "../../lib/api";
import { Combo } from "../../components/Combo";
import { MASS, fmtMkg, massColor } from "./helpers";
import { Field } from "./shared";

/** Ship-mass jump planner: can this hull pass this hole, and how many crossings
 * remain? Physics come from the bundled SDE (offline). */
export function JumpPlanner() {
  const [ship, setShip] = useState<IdName | null>(null);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("fresh");
  const plan = useMutation({
    mutationFn: () => whJumpPlan(ship!.id, code.trim(), status),
  });
  const r: JumpPlan | undefined = plan.data;

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-sm font-semibold text-zinc-300">
          Jump planner
        </span>
        <Field label="Ship">
          <Combo
            value={ship}
            onPick={setShip}
            search={sdeSearchShips}
            placeholder="Ship…"
            width="w-40"
          />
        </Field>
        <Field label="WH type">
          <input
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
            placeholder="N766"
            className="w-24 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </Field>
        <Field label="Mass">
          <select
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
            className={`rounded bg-zinc-800 px-2 py-1 text-sm outline-none ${massColor(status)}`}
          >
            {MASS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <button
          onClick={() => plan.mutate()}
          disabled={!ship || code.trim() === "" || plan.isPending}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Plan jump
        </button>
      </div>

      {plan.isError && (
        <div className="mt-2 text-xs text-rose-400">
          {errorMessage(plan.error)}
        </div>
      )}

      {r && !r.found && (
        <div className="mt-2 text-sm text-zinc-400">{r.message}</div>
      )}

      {r && r.found && (
        <div className="mt-3 text-sm">
          {!r.passes ? (
            <div className="text-rose-400">
              ❌ <span className="text-zinc-200">{r.shipName}</span> (
              {fmtMkg(r.shipMass)}) exceeds{" "}
              <span className="text-zinc-200">{r.whCode}</span> max jump mass (
              {fmtMkg(r.maxJumpMass)}).
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div
                className={r.critRisk ? "text-amber-300" : "text-emerald-300"}
              >
                {r.critRisk ? "⚠️" : "✅"}{" "}
                <span className="text-zinc-200">{r.shipName}</span> passes{" "}
                <span className="text-zinc-200">{r.whCode}</span>
                <span className="text-zinc-500"> → {r.destClassLabel}</span> · ~
                <span className="text-zinc-100">{r.remainingCrossings}</span>{" "}
                crossing
                {r.remainingCrossings === 1 ? "" : "s"} left
                {r.critRisk && (
                  <span className="text-amber-300">
                    {" "}
                    · next jump risks critical
                  </span>
                )}
              </div>
              {/* Mass budget bar: green up to critical, amber for the last <10% band. */}
              <div className="flex h-2 w-64 overflow-hidden rounded bg-zinc-800">
                <div
                  className="bg-emerald-600"
                  style={{
                    width: `${Math.min(100, r.remainingCrossings === 0 ? 0 : (r.crossingsUntilCritical / r.remainingCrossings) * 100)}%`,
                  }}
                />
                <div className="flex-1 bg-amber-600" />
              </div>
              <div className="text-[11px] text-zinc-500">
                {r.crossingsUntilCritical} before critical · hole total{" "}
                {fmtMkg(r.maxStableMass)} · jump limit {fmtMkg(r.maxJumpMass)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
