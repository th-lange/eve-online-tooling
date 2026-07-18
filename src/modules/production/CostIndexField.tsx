import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  productionSystemCostIndex,
  systemSearch,
  type SystemMatch,
} from "../../lib/api";
import { Combo } from "../../components/Combo";
import { Field } from "../../components/forms";

/** Cost-index % field with a build-system search that fills it from the live
 *  ESI per-system index. The number stays editable as a manual override. */
export function CostIndexField({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const [picked, setPicked] = useState<SystemMatch | null>(null);
  const idx = useQuery({
    queryKey: ["production", "costIndex", picked?.id],
    queryFn: () => productionSystemCostIndex(picked!.id),
    enabled: picked != null,
    staleTime: 60 * 60 * 1000,
  });
  // Fill the field from the live index when a system resolves.
  useEffect(() => {
    if (picked && typeof idx.data === "number") {
      onChange(Math.round(idx.data * 10000) / 100);
    }
  }, [idx.data, picked, onChange]);

  return (
    <Field label="Cost index %">
      <input
        type="number"
        value={value}
        min={0}
        step={0.1}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      />
      <div className="mt-1">
        <Combo
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
      {picked && !idx.isLoading && typeof idx.data === "number" && (
        <span className="text-[10px] text-emerald-500">
          {picked.name}: {(idx.data * 100).toFixed(2)}% (live)
        </span>
      )}
      {picked && !idx.isLoading && idx.data == null && (
        <span className="text-[10px] text-amber-500">
          No live index for {picked.name} — keeping your value
        </span>
      )}
    </Field>
  );
}
