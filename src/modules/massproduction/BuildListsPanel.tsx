import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCopy, FolderOpen, Save, Trash2 } from "lucide-react";

import {
  errorMessage,
  massprodDeleteList,
  massprodLists,
  massprodSaveList,
  type BuildList,
  type MassProductionPlan,
} from "../../lib/api";
import { massprodKeys } from "../../lib/queryKeys";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import { InlineError } from "../../components/InlineError";
import { exportBlueprintLines } from "./parseBlueprintLines";

/** "Build lists ▾" — save the current matched blueprints (with their build-
 * run overrides) under a name, or load/delete a previously saved one.
 * Separate from Shopping Lists: a build list is the *input* (blueprints +
 * how many to build), not the computed materials. */
export function BuildListsPanel({
  plan,
  overrides,
  onLoad,
}: {
  plan: MassProductionPlan | null;
  overrides: Record<number, number>;
  onLoad: (list: BuildList) => void;
}) {
  const qc = useQueryClient();
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const { copied: copiedList, copy: copyList } = useCopyToClipboard(1500);

  const listsQuery = useQuery({
    queryKey: massprodKeys.lists,
    queryFn: massprodLists,
    enabled: browseOpen,
  });

  const save = useMutation({
    mutationFn: (listName: string) =>
      massprodSaveList(
        listName,
        (plan?.matchedBlueprints ?? []).map((b) => ({
          typeId: b.typeId,
          buildRuns: overrides[b.typeId] ?? null,
        })),
      ),
    onSuccess: () => {
      setSaveOpen(false);
      setName("");
      setSaveError(null);
      void qc.invalidateQueries({ queryKey: massprodKeys.lists });
    },
    onError: (e) => setSaveError(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => massprodDeleteList(id),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: massprodKeys.lists }),
  });

  const canSave = plan != null && plan.matchedBlueprints.length > 0;

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <button
          onClick={() => {
            setBrowseOpen((o) => !o);
            setSaveOpen(false);
          }}
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          <FolderOpen size={13} />
          Build lists
        </button>
        {browseOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setBrowseOpen(false)}
            />
            <div className="absolute left-0 z-20 mt-1 w-72 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
              {listsQuery.isLoading && (
                <div className="px-2 py-1 text-xs text-zinc-500">Loading…</div>
              )}
              {listsQuery.data?.length === 0 && (
                <div className="px-2 py-1 text-xs text-zinc-500">
                  No saved build lists yet.
                </div>
              )}
              {listsQuery.data?.map((list) => (
                <div
                  key={list.id}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-zinc-800"
                >
                  <button
                    onClick={() => {
                      onLoad(list);
                      setBrowseOpen(false);
                    }}
                    className="flex-1 truncate text-left text-xs text-zinc-200"
                    title={`Load "${list.name}" (${list.items.length} blueprints)`}
                  >
                    {list.name}
                    <span className="ml-1.5 text-zinc-500">
                      ({list.items.length})
                    </span>
                  </button>
                  <button
                    onClick={() =>
                      copyList(
                        exportBlueprintLines(
                          list.items.map((i) => ({
                            name: i.name,
                            runs: i.buildRuns,
                          })),
                        ),
                        list.id,
                      )
                    }
                    aria-label={`Copy ${list.name}`}
                    title="Copy this list as a Multibuy-style paste (Name, or Name␉Runs if it has a saved build-run)"
                    className="shrink-0 text-zinc-500 hover:text-indigo-400"
                  >
                    {copiedList === list.id ? (
                      <Check size={13} />
                    ) : (
                      <ClipboardCopy size={13} />
                    )}
                  </button>
                  <button
                    onClick={() => remove.mutate(list.id)}
                    aria-label={`Delete ${list.name}`}
                    title="Delete this build list"
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
            onClick={() => {
              setSaveOpen((o) => !o);
              setBrowseOpen(false);
            }}
            className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <Save size={13} />
            {save.isSuccess && !saveOpen ? "Saved ✓" : "Save build list…"}
          </button>
          {saveOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setSaveOpen(false)}
              />
              <div className="absolute left-0 z-20 mt-1 w-64 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
                <input
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim())
                      save.mutate(name.trim());
                  }}
                  placeholder={`Build list — ${new Date().toLocaleDateString()}`}
                  autoFocus
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => setSaveOpen(false)}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                  <button
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
