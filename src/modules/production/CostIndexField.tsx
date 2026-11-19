import { useEffect, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import {
  productionSystemCostIndex,
  systemSearch,
  type CostIndices,
  type SystemMatch,
} from "../../lib/api";
import { productionKeys } from "../../lib/queryKeys";
import { Combo } from "../../components/Combo";
import { Field } from "../../components/forms";

/** The non-manufacturing indices the engine charges, as percentages; `null`
 *  for an activity the picked system doesn't list (it then falls back to the
 *  manufacturing index below). */
export interface ActivityIndexPcts {
  invention: number | null;
  copying: number | null;
  reaction: number | null;
}

const pct = (n: number | null) =>
  n == null ? null : Math.round(n * 10000) / 100;

/** Cost-index % field with a build-system search that fills it from the live
 *  ESI per-system index. The number stays editable as a manual override; a
 *  manual edit drops the per-activity indices, so every job is costed at the
 *  number you typed (#1274). */
export function CostIndexField({
  value,
  onChange,
  activityPcts,
  onActivityPctsChange,
}: {
  value: number;
  onChange: (n: number) => void;
  activityPcts: ActivityIndexPcts | null;
  onActivityPctsChange: (p: ActivityIndexPcts | null) => void;
}) {
  const [picked, setPicked] = useState<SystemMatch | null>(null);
  const idx = useQuery({
    queryKey: productionKeys.costIndex(picked?.id),
    queryFn: picked ? () => productionSystemCostIndex(picked.id) : skipToken,
    staleTime: 60 * 60 * 1000,
  });
  const live: CostIndices | null | undefined = idx.data;
  // Fill the field from the live indices when a system resolves.
  useEffect(() => {
    if (!picked || live == null) return;
    if (live.manufacturing != null) onChange(pct(live.manufacturing)!);
    onActivityPctsChange({
      invention: pct(live.invention),
      copying: pct(live.copying),
      reaction: pct(live.reaction),
    });
  }, [live, picked, onChange, onActivityPctsChange]);

  return (
    <Field label="Cost index %">
      <input
        type="number"
        value={value}
        min={0}
        step={0.1}
        onChange={(e) => {
          onChange(Number(e.currentTarget.value));
          onActivityPctsChange(null);
        }}
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      />
      <div className="mt-1">
        <Combo
          scope="systems"
          value={picked}
          onPick={setPicked}
          search={systemSearch}
          placeholder="↳ fill from a build system…"
          width="w-full"
          maxResults={8}
        />
      </div>
      {picked && idx.isLoading && (
        <span className="text-[10px] text-zinc-500">
          Loading {picked.name}…
        </span>
      )}
      {picked && !idx.isLoading && live?.manufacturing != null && (
        <span className="text-[10px] text-emerald-500">
          {picked.name}: {(live.manufacturing * 100).toFixed(2)}% (live)
        </span>
      )}
      {picked && !idx.isLoading && live == null && (
        <span className="text-[10px] text-amber-500">
          No live index for {picked.name} — keeping your value
        </span>
      )}
      {activityPcts && (
        <span
          className="mt-0.5 block text-[10px] text-zinc-500"
          title="Each activity is charged at its own system cost index. * = the system lists no index for that activity, so the manufacturing one above is used."
        >
          Invention {activityLabel(activityPcts.invention, value)} · Copying{" "}
          {activityLabel(activityPcts.copying, value)} · Reaction{" "}
          {activityLabel(activityPcts.reaction, value)}
        </span>
      )}
    </Field>
  );
}

/** An activity's own index, or the manufacturing one it falls back to. */
function activityLabel(indexPct: number | null, fallbackPct: number) {
  return indexPct == null
    ? `${fallbackPct.toFixed(2)}%*`
    : `${indexPct.toFixed(2)}%`;
}
