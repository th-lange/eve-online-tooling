import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { SlidersHorizontal, X } from "lucide-react";
import {
  errorMessage,
  fittingOptimize,
  type OptimizeMode,
  type OptimizeObjective,
} from "../../lib/api";
import { InlineError } from "../../components/InlineError";
import { Modal } from "../../components/Modal";
import { PrimaryButton } from "../../components/page";
import { useFitState } from "./useFitEditorContext";

/** Meta-group tiers the optimizer can draw from. */
const META_TIERS: [number, string][] = [
  [1, "T1"],
  [2, "T2"],
  [4, "Faction"],
  [6, "Deadspace"],
  [5, "Officer"],
];

/**
 * The optimizer's state machine (#710, #825) — objective/slots/meta/cap-
 * stable/budget knobs, the `fitting_optimize` mutation, and the "couldn't
 * meet a constraint" banner — plus the collapsed "Optimize…" trigger that
 * opens its settings. Reads/writes the fit through `FitEditorContext`;
 * `regionId` (the page's "Price at" selector) is the only thing it needs
 * from the caller, since the optimizer's ISK budget prices against it.
 */
export function OptimizePanel({ regionId }: { regionId: number }) {
  const { fit, setFit } = useFitState();
  const [objective, setObjective] = useState<OptimizeObjective>("tank");
  const [optimizeMode, setOptimizeMode] = useState<OptimizeMode>("all");
  const [capStable, setCapStable] = useState(false);
  // ISK budget cap as a string (millions); empty = no budget.
  const [maxCostM, setMaxCostM] = useState("");
  const [unmetConstraints, setUnmetConstraints] = useState<string[] | null>(
    null,
  );
  const [meta, setMeta] = useState<Record<number, boolean>>({
    1: true,
    2: true,
    4: false,
    6: false,
    5: false,
  });
  // `setFit` always runs the fit through `stackCargo`, which returns a new
  // object even for a no-op normalization — so we can't tell "optimize just
  // applied this fit" apart from "the user edited it" by reference alone.
  // Instead: mark the next fit-change as optimizer-caused, consume that mark
  // in the effect below, and only treat *further* changes as manual edits.
  const pendingOptimizeApplyRef = useRef(false);
  const lastOptimizedFitRef = useRef<typeof fit>(null);

  const optimize = useMutation({
    mutationFn: () => {
      const maxCost = maxCostM.trim() ? Number(maxCostM) * 1_000_000 : null;
      return fittingOptimize(
        fit!,
        objective,
        Object.entries(meta)
          .filter(([, on]) => on)
          .map(([id]) => Number(id)),
        optimizeMode,
        { capStable, maxCost, regionId },
      );
    },
    onSuccess: (res) => {
      pendingOptimizeApplyRef.current = true;
      setFit(res.fit);
      const unmet: string[] = [];
      if (capStable && !res.capStable) unmet.push("cap-stable");
      if (maxCostM.trim() && !res.withinBudget) unmet.push("ISK budget");
      setUnmetConstraints(unmet.length ? unmet : null);
    },
    onError: (e) => console.error("Optimize failed", e),
  });
  // Clear the unmet-constraint banner the moment the fit changes to
  // something other than what the optimizer just produced — i.e. the user
  // edited it manually (any of the setFit-backed actions in FitEditorContext).
  useEffect(() => {
    if (pendingOptimizeApplyRef.current) {
      // This change is the optimizer's own setFit call landing (post
      // stackCargo) — keep the banner and remember this fit as the one it
      // describes.
      pendingOptimizeApplyRef.current = false;
      lastOptimizedFitRef.current = fit;
      return;
    }
    if (fit !== lastOptimizedFitRef.current) {
      setUnmetConstraints(null);
    }
  }, [fit]);

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500">
          Fitting
        </h3>
        <OptimizeControl
          objective={objective}
          setObjective={setObjective}
          optimizeMode={optimizeMode}
          setOptimizeMode={setOptimizeMode}
          meta={meta}
          setMeta={setMeta}
          capStable={capStable}
          setCapStable={setCapStable}
          maxCostM={maxCostM}
          setMaxCostM={setMaxCostM}
          onOptimize={() => optimize.mutate()}
          pending={optimize.isPending}
        />
      </div>
      <InlineError
        message={
          optimize.isError
            ? `Optimize failed: ${errorMessage(optimize.error)}`
            : null
        }
      />
      {unmetConstraints && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded border border-amber-700/50 bg-amber-950/20 px-2 py-1">
          <InlineError
            message={`Optimizer couldn't meet ${unmetConstraints.join(" + ")} — showing the closest fit.`}
            className="text-xs text-amber-400"
          />
          <button
            onClick={() => setUnmetConstraints(null)}
            title="Dismiss"
            className="shrink-0 text-zinc-500 hover:text-zinc-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Optimizer controls (#710): collapsed behind an "Optimize…" button instead
 * of a permanently-visible dense strip. Running it applies immediately to the
 * loaded fit (visible in the slot grid behind the popover); any unmet
 * constraint is surfaced separately as a persistent banner (#825), not here.
 */
function OptimizeControl({
  objective,
  setObjective,
  optimizeMode,
  setOptimizeMode,
  meta,
  setMeta,
  capStable,
  setCapStable,
  maxCostM,
  setMaxCostM,
  onOptimize,
  pending,
}: {
  objective: OptimizeObjective;
  setObjective: (v: OptimizeObjective) => void;
  optimizeMode: OptimizeMode;
  setOptimizeMode: (v: OptimizeMode) => void;
  meta: Record<number, boolean>;
  setMeta: (
    fn: (m: Record<number, boolean>) => Record<number, boolean>,
  ) => void;
  capStable: boolean;
  setCapStable: (v: boolean) => void;
  maxCostM: string;
  setMaxCostM: (v: string) => void;
  onOptimize: () => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
          open
            ? "border-zinc-600 bg-zinc-800 text-zinc-200"
            : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
        }`}
      >
        <SlidersHorizontal size={13} />
        Optimize…
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        aria-label="Fitting optimizer settings"
        backdropClassName="fixed inset-0 z-10"
        portal={false}
        className="absolute right-0 z-20 mt-1 w-80 space-y-2 rounded border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-lg"
      >
        <label className="flex flex-col gap-1 text-zinc-400">
          Objective
          <select
            value={objective}
            onChange={(e) =>
              setObjective(e.currentTarget.value as OptimizeObjective)
            }
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
          >
            <option value="tank">Tank</option>
            <option value="damage">Damage</option>
            <option value="repair">Repair</option>
            <option value="yield">Yield (mining)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-zinc-400">
          Slots
          <select
            value={optimizeMode}
            onChange={(e) =>
              setOptimizeMode(e.currentTarget.value as OptimizeMode)
            }
            title="Rework all relevant slots, or only fill empty ones"
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
          >
            <option value="all">All modules</option>
            <option value="empty">Empty modules only</option>
          </select>
        </label>
        <div>
          <div className="mb-1 text-zinc-500">Meta groups</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {META_TIERS.map(([id, label]) => (
              <label key={id} className="flex items-center gap-1 text-zinc-400">
                <input
                  type="checkbox"
                  checked={!!meta[id]}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    setMeta((m) => ({ ...m, [id]: checked }));
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <label
          className="flex items-center gap-1 text-zinc-400"
          title="Keep the result capacitor-stable"
        >
          <input
            type="checkbox"
            checked={capStable}
            onChange={(e) => setCapStable(e.currentTarget.checked)}
          />
          Cap-stable
        </label>
        <label
          className="flex items-center gap-1 text-zinc-400"
          title="Cap total fit cost"
        >
          Max
          <input
            type="number"
            min={0}
            value={maxCostM}
            onChange={(e) => setMaxCostM(e.currentTarget.value)}
            placeholder="∞"
            className="w-16 rounded bg-zinc-800 px-1 py-0.5 text-zinc-100 outline-none"
          />
          M ISK
        </label>
        <PrimaryButton
          onClick={onOptimize}
          disabled={pending}
          pending={pending}
          pendingLabel="Optimizing…"
        >
          Optimize
        </PrimaryButton>
      </Modal>
    </div>
  );
}
