import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { type FitItem } from "../../lib/api";
import { sdeKeys } from "../../lib/queryKeys";

/**
 * Add modules projected **onto** this fit (webs/paints/damps/…) — incoming
 * effects from a notional attacker, modelled at all-V. Search-to-add plus a
 * removable list; the stats recompute with the projected effects applied (#178).
 */
export function ProjectedPanel({
  projected,
  nameOf,
  onAdd,
  onRemove,
}: {
  projected: FitItem[];
  nameOf: (id: number) => string;
  onAdd: (typeId: number) => void;
  onRemove: (idx: number) => void;
}) {
  const [q, setQ] = useState("");
  const results = useQuery({
    ...sdeKeys.search(q),
    enabled: q.trim().length >= 2,
  });
  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Projected onto this fit
      </div>
      {projected.length > 0 && (
        <ul className="mb-2 text-sm text-zinc-300">
          {projected.map((it, i) => (
            <li
              key={i}
              className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/70"
            >
              <button
                onClick={() => onRemove(i)}
                className="flex shrink-0 items-center rounded p-0.5 text-zinc-500 group-hover:text-red-400"
                title="Remove projection"
                aria-label={`Remove ${nameOf(it.typeId)}`}
              >
                <X size={14} />
              </button>
              <span className="truncate">{nameOf(it.typeId)}</span>
            </li>
          ))}
        </ul>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        placeholder="project a web, painter, damp…"
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
      />
      {q.trim().length >= 2 && (
        <ul className="mt-2 max-h-40 overflow-y-auto text-sm">
          {(results.data ?? []).slice(0, 20).map((r) => (
            <li key={r.id}>
              <button
                onClick={() => {
                  onAdd(r.id);
                  setQ("");
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800"
              >
                <span className="flex-1 truncate">{r.name}</span>
                <Plus size={14} className="shrink-0 text-zinc-500" />
              </button>
            </li>
          ))}
          {results.isFetched && (results.data?.length ?? 0) === 0 && (
            <li className="px-2 py-1 text-xs text-zinc-500">No matches.</li>
          )}
        </ul>
      )}
    </div>
  );
}
