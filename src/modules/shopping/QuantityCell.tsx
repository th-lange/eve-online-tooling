import { useState } from "react";

// --- One row's quantity editor (commit on blur/Enter, not per keystroke) ---

/**
 * The quantity input used to be controlled by server state and persisted on
 * every keystroke: typing "2500" fired four invoke + full-list-refetch round
 * trips and saved the bogus intermediates 2, 25 and 250 along the way — and
 * clearing the field persisted 0 (`Number("")` is 0). Instead, keep a local
 * draft while editing and commit once on blur or Enter; an empty or
 * unparseable draft simply reverts to the saved quantity (#642).
 */
export function QuantityCell({
  name,
  quantity,
  onCommit,
}: {
  name: string;
  quantity: number;
  onCommit: (quantity: number) => void;
}) {
  // null = not editing → show the saved (server) quantity.
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft === null) return;
    setDraft(null);
    const q = Number(draft);
    // Empty or garbage input: revert to the saved value — never persist 0.
    if (draft.trim() === "" || !Number.isFinite(q)) return;
    const next = Math.max(1, Math.round(q));
    if (next !== quantity) onCommit(next);
  }

  return (
    <input
      type="number"
      min={1}
      value={draft ?? quantity}
      aria-label={`Quantity of ${name}`}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") setDraft(null);
      }}
      className="w-24 rounded bg-zinc-800 px-2 py-0.5 text-right text-zinc-100 outline-none"
    />
  );
}
