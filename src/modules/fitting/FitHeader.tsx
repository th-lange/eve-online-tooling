import { useState } from "react";
import { MoreVertical, Trash2 } from "lucide-react";
import { PrimaryButton } from "../../components/page";

/** Hull render from EVE's public image server (CSP-allowed in tauri.conf.json). */
function hullRenderUrl(typeId: number, size: 32 | 64 | 128 = 64): string {
  return `https://images.evetech.net/types/${typeId}/render?size=${size}`;
}

/**
 * Fit identity + primary actions (#709, #711): the hull render, name and
 * class anchor the editor instead of a plain text heading. Save reads as the
 * one primary action; Export EFT and Save to EVE move into an overflow menu;
 * Delete requires an explicit confirm so it can't be fat-fingered next to Save.
 */
export function FitHeader({
  shipTypeId,
  hullName,
  groupName,
  fitName,
  onSave,
  savePending,
  onExportEft,
  onPushEsi,
  pushEsiPending,
  pushEsiSuccess,
  onDelete,
  canDelete,
}: {
  shipTypeId: number;
  hullName: string;
  groupName: string;
  fitName: string;
  onSave: () => void;
  savePending: boolean;
  onExportEft: () => void;
  onPushEsi: () => void;
  pushEsiPending: boolean;
  pushEsiSuccess: boolean;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="mb-3 flex items-center gap-3">
      <img
        src={hullRenderUrl(shipTypeId)}
        alt=""
        width={48}
        height={48}
        loading="lazy"
        className="h-12 w-12 shrink-0 rounded bg-zinc-900 object-contain"
      />
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-medium text-zinc-200">{fitName}</h2>
        <div className="truncate text-xs text-zinc-500">
          {hullName}
          {groupName ? ` · ${groupName}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <PrimaryButton
          onClick={onSave}
          pending={savePending}
          pendingLabel="Saving…"
        >
          Save
        </PrimaryButton>
        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            title="More actions"
            aria-label="More actions"
            className={`rounded border p-1.5 transition ${
              menuOpen
                ? "border-zinc-600 bg-zinc-800 text-zinc-200"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 z-20 mt-1 w-44 rounded border border-zinc-700 bg-zinc-900 p-1 shadow-lg">
                <button
                  onClick={() => {
                    onExportEft();
                    setMenuOpen(false);
                  }}
                  className="block w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800"
                >
                  Export EFT
                </button>
                <button
                  onClick={() => {
                    onPushEsi();
                    setMenuOpen(false);
                  }}
                  disabled={pushEsiPending}
                  title="Save this fit to your in-game fittings (ESI)"
                  className="block w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  {pushEsiPending
                    ? "Saving…"
                    : pushEsiSuccess
                      ? "Saved to EVE ✓"
                      : "Save to EVE"}
                </button>
              </div>
            </>
          )}
        </div>
        {canDelete &&
          (confirmDelete ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-500">Delete for good?</span>
              <button
                onClick={onDelete}
                className="rounded border border-rose-800 px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-950"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              title="Delete this fit"
              aria-label="Delete this fit"
              className="rounded border border-zinc-700 p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-rose-400"
            >
              <Trash2 size={16} />
            </button>
          ))}
      </div>
    </div>
  );
}
