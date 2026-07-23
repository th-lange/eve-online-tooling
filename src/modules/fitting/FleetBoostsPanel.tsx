import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { fittingCompatibleCharges, type FleetBoost } from "../../lib/api";
import { sdeKeys } from "../../lib/queryKeys";

/**
 * Fleet boosts (#705): command-burst/fleet-link modules (+ optional charge)
 * the fit is "receiving" from a fleet member. Their `GangModifier` effects
 * flow through the normal resolve pipeline as an external outward-modifier
 * source — identical to a fitted module projecting onto the ship, just
 * sourced from a module the user picks here instead of the slot grid.
 * Renders nothing until the list has an entry or "Add" has been clicked.
 */
export function FleetBoostsPanel({
  boosts,
  onAdd,
  onRemove,
  nameOf,
}: {
  boosts: FleetBoost[];
  onAdd: (boost: FleetBoost) => void;
  onRemove: (index: number) => void;
  nameOf: (id: number) => string;
}) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  // A module picked but not yet committed — offers a charge picker (or "no
  // charge") before it lands in `boosts`.
  const [pickedModule, setPickedModule] = useState<{
    id: number;
    name: string;
  } | null>(null);

  const results = useQuery({
    ...sdeKeys.search(q),
    enabled: pickedModule == null && q.trim().length >= 2,
  });
  const charges = useQuery({
    queryKey: ["fitting", "compatible-charges", pickedModule?.id],
    queryFn: () => fittingCompatibleCharges(pickedModule!.id),
    enabled: pickedModule != null,
  });

  function reset() {
    setAdding(false);
    setQ("");
    setPickedModule(null);
  }
  function commit(chargeTypeId?: number) {
    if (!pickedModule) return;
    onAdd({ moduleTypeId: pickedModule.id, chargeTypeId });
    reset();
  }

  if (!adding && boosts.length === 0) return null;

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
        Fleet boosts
        <button
          onClick={() => (adding ? reset() : setAdding(true))}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 normal-case text-zinc-400 hover:text-zinc-200"
        >
          {adding ? <X size={12} /> : <Plus size={12} />}
          {adding ? "Cancel" : "Add"}
        </button>
      </div>

      {boosts.length > 0 && (
        <ul className="mb-2 text-xs text-zinc-300">
          {boosts.map((b, i) => (
            <li
              key={i}
              className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/70"
            >
              <button
                onClick={() => onRemove(i)}
                className="flex shrink-0 items-center rounded p-0.5 text-zinc-500 group-hover:text-red-400"
                title="Remove fleet boost"
                aria-label={`Remove ${nameOf(b.moduleTypeId)}`}
              >
                <Trash2 size={13} />
              </button>
              <span className="truncate">{nameOf(b.moduleTypeId)}</span>
              {b.chargeTypeId != null && (
                <span className="truncate text-zinc-500">
                  {nameOf(b.chargeTypeId)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && !pickedModule && (
        <>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="search a command burst module…"
            className="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          {q.trim().length >= 2 && (
            <ul className="mt-2 max-h-40 overflow-y-auto text-xs">
              {(results.data ?? []).slice(0, 20).map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setPickedModule({ id: r.id, name: r.name })}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800"
                  >
                    <span className="flex-1 truncate">{r.name}</span>
                    <Plus size={12} className="shrink-0 text-zinc-500" />
                  </button>
                </li>
              ))}
              {results.isFetched && (results.data?.length ?? 0) === 0 && (
                <li className="px-2 py-1 text-zinc-500">No matches.</li>
              )}
            </ul>
          )}
        </>
      )}

      {adding && pickedModule && (
        <div className="space-y-1 text-xs">
          <div className="flex items-center justify-between text-zinc-300">
            <span className="truncate">{pickedModule.name}</span>
            <button
              onClick={() => setPickedModule(null)}
              className="shrink-0 text-zinc-500 hover:text-zinc-300"
              title="Back to search"
            >
              <X size={12} />
            </button>
          </div>
          {(charges.data?.length ?? 0) > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                Charge
              </div>
              <ul className="max-h-40 overflow-y-auto">
                {charges.data!.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => commit(c.id)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800"
                    >
                      <span className="flex-1 truncate">{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            onClick={() => commit(undefined)}
            className="w-full rounded border border-zinc-700 px-2 py-1 text-left text-zinc-400 hover:bg-zinc-800"
          >
            No charge
          </button>
        </div>
      )}
    </div>
  );
}
