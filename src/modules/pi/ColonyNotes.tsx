import { useState } from "react";
import { sdeSearchPiCommodities, type ColonyView } from "../../lib/api";
import { Combo } from "../../components/Combo";
import { Section } from "./Section";

/** Local, user-authored notes + a target-product list for one colony — not
 * from ESI, deleted automatically once the colony itself is gone (the
 * backend prunes orphaned rows against the live ESI colony list on every
 * fetch). Notes save on blur (not per-keystroke); target products save
 * immediately on add/remove, same as the lock-in buttons above. */
function ColonyNotes({
  colony,
  onSave,
}: {
  colony: ColonyView;
  onSave: (
    characterId: number,
    planetId: number,
    notes: string,
    targetProductTypeIds: number[],
  ) => void;
}) {
  // null = not editing → show the saved (server) notes.
  const [draft, setDraft] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ id: number; name: string } | null>(
    null,
  );

  function commitNotes() {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    if (next !== colony.notes) {
      onSave(
        colony.characterId,
        colony.planetId,
        next,
        colony.targetProducts.map((p) => p.typeId),
      );
    }
  }

  function addTarget(product: { id: number; name: string } | null) {
    if (
      !product ||
      colony.targetProducts.some((p) => p.typeId === product.id)
    ) {
      setPicked(null);
      return;
    }
    onSave(colony.characterId, colony.planetId, colony.notes, [
      ...colony.targetProducts.map((p) => p.typeId),
      product.id,
    ]);
    setPicked(null);
  }

  function removeTarget(typeId: number) {
    onSave(
      colony.characterId,
      colony.planetId,
      colony.notes,
      colony.targetProducts
        .filter((p) => p.typeId !== typeId)
        .map((p) => p.typeId),
    );
  }

  return (
    <Section title="Notes & target products">
      <div className="flex flex-wrap items-center gap-1.5">
        {colony.targetProducts.map((p) => (
          <span
            key={p.typeId}
            className="flex items-center gap-1 rounded border border-indigo-700 bg-indigo-950/30 px-1.5 py-0.5 text-xs text-indigo-300"
          >
            {p.name}
            <button
              onClick={() => removeTarget(p.typeId)}
              aria-label={`Remove ${p.name} from targets`}
              className="text-indigo-400 hover:text-indigo-100"
            >
              ×
            </button>
          </span>
        ))}
        <Combo
          value={picked}
          onPick={addTarget}
          search={sdeSearchPiCommodities}
          placeholder="Add target product…"
          width="w-44"
        />
      </div>
      <textarea
        value={draft ?? colony.notes}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commitNotes}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDraft(null);
        }}
        placeholder="What are you building here — and any sub-products for a later cycle…"
        rows={2}
        className="mt-2 w-full resize-y rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-500"
      />
    </Section>
  );
}

export { ColonyNotes };
