import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  productionSystemCostIndex,
  systemSearch,
  type SystemMatch,
} from "../../lib/api";
import { Field } from "./components";

/** Cost-index % field with a build-system search that fills it from the live
 *  ESI per-system index. The number stays editable as a manual override. */
export function CostIndexField({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<SystemMatch | null>(null);
  const matches = useQuery({
    queryKey: ["production", "systemSearch", q],
    queryFn: () => systemSearch(q),
    enabled: q.trim().length >= 2 && !picked,
  });
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
      <div className="relative">
        <input
          value={picked ? picked.name : q}
          onChange={(e) => {
            setPicked(null);
            setQ(e.currentTarget.value);
          }}
          placeholder="↳ fill from a build system…"
          className="mt-1 w-full rounded bg-zinc-800/60 px-2 py-1 text-xs text-zinc-300 outline-none placeholder:text-zinc-500"
        />
        {!picked && (matches.data?.length ?? 0) > 0 && (
          <div className="absolute z-10 mt-0.5 max-h-40 w-full overflow-auto rounded border border-zinc-700 bg-zinc-900 text-xs shadow-lg">
            {matches.data!.slice(0, 8).map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setPicked(m);
                  setQ(m.name);
                }}
                className="block w-full px-2 py-1 text-left text-zinc-300 hover:bg-zinc-800"
              >
                {m.name}
              </button>
            ))}
          </div>
        )}
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
