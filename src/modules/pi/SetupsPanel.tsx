import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Save, Trash2 } from "lucide-react";
import {
  errorMessage,
  piPlannerSetupDelete,
  piPlannerSetups,
  piPlannerSetupSave,
  type PlannerSetupItem,
} from "../../lib/api";
import { piKeys } from "../../lib/queryKeys";
import { InlineError } from "../../components/InlineError";
import { type PlannerPick } from "./plannerTypes";

/** "Setups ▾" — save the current picks (with their notes/system/planet)
 * under a name, or load/delete a previously saved one. Loading replaces
 * the whole working plan, same semantics as Mass Production's build-list
 * panel this mirrors. */
function SetupsPanel({
  picks,
  onLoad,
}: {
  picks: PlannerPick[];
  onLoad: (items: PlannerSetupItem[]) => void;
}) {
  const qc = useQueryClient();
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const setupsQuery = useQuery({
    queryKey: piKeys.setups,
    queryFn: piPlannerSetups,
    enabled: browseOpen,
  });

  const save = useMutation({
    mutationFn: (setupName: string) =>
      piPlannerSetupSave(
        setupName,
        picks.map((p) => ({
          typeId: p.id,
          notes: p.notes,
          systemId: p.systemId,
          systemName: p.systemName,
          planetId: p.planetId,
          planetName: p.planetName,
          imports: p.imports,
          label: p.label,
        })),
      ),
    onSuccess: () => {
      setSaveOpen(false);
      setName("");
      setSaveError(null);
      void qc.invalidateQueries({ queryKey: piKeys.setups });
    },
    onError: (e) => setSaveError(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => piPlannerSetupDelete(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: piKeys.setups }),
  });

  const canSave = picks.length > 0;

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setBrowseOpen((o) => !o);
            setSaveOpen(false);
          }}
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          <FolderOpen size={13} />
          Setups
        </button>
        {browseOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setBrowseOpen(false)}
            />
            <div className="absolute right-0 z-20 mt-1 w-72 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
              {setupsQuery.isLoading && (
                <div className="px-2 py-1 text-xs text-zinc-500">Loading…</div>
              )}
              {setupsQuery.data?.length === 0 && (
                <div className="px-2 py-1 text-xs text-zinc-500">
                  No saved setups yet.
                </div>
              )}
              {setupsQuery.data?.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-zinc-800"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onLoad(s.items);
                      setBrowseOpen(false);
                    }}
                    className="flex-1 truncate text-left text-xs text-zinc-200"
                    title={`Load "${s.name}" (${s.items.length} commodities)`}
                  >
                    {s.name}
                    <span className="ml-1.5 text-zinc-500">
                      ({s.items.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(s.id)}
                    aria-label={`Delete ${s.name}`}
                    title="Delete this setup"
                    className="shrink-0 text-zinc-500 hover:text-rose-400"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {canSave && (
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setSaveOpen((o) => !o);
              setBrowseOpen(false);
            }}
            className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <Save size={13} />
            {save.isSuccess && !saveOpen ? "Saved ✓" : "Save setup…"}
          </button>
          {saveOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setSaveOpen(false)}
              />
              <div className="absolute right-0 z-20 mt-1 w-64 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
                <input
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim())
                      save.mutate(name.trim());
                  }}
                  placeholder={`Setup — ${new Date().toLocaleDateString()}`}
                  autoFocus
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSaveOpen(false)}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => name.trim() && save.mutate(name.trim())}
                    disabled={name.trim().length === 0 || save.isPending}
                    className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {save.isPending ? "Saving…" : "Save"}
                  </button>
                </div>
                <InlineError
                  message={saveError}
                  className="mt-1 text-xs text-rose-400"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export { SetupsPanel };
