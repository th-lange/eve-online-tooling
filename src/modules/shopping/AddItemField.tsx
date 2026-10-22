import { useMemo, useState } from "react";

import { parseItems, parseLine } from "../../lib/parseItems";
import { shoppingAddText } from "../../lib/api";

// --- Bulk add field (Multibuy-style paste; only adds known items) ---

export function AddItemField({
  listId,
  onAdded,
}: {
  listId: string;
  onAdded: () => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [unresolved, setUnresolved] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => parseItems(text), [text]);

  async function add() {
    const lines = text
      .split("\n")
      .map((raw) => ({ raw, parsed: parseLine(raw) }));
    const toAdd = lines.flatMap((l) => (l.parsed ? [l.parsed] : []));
    if (toAdd.length === 0 || busy) return;
    setBusy(true);
    try {
      const missed = await shoppingAddText(listId, toAdd);
      const missedSet = new Set(missed.map((m) => m.toLowerCase()));
      // Leave the rest: keep the original text of every line we didn't add —
      // unparseable lines, and parsed-but-unknown names (with their quantities).
      // Drop blanks and everything that landed.
      const remaining = lines
        .filter((l) => {
          if (!l.raw.trim()) return false;
          if (!l.parsed) return true;
          return missedSet.has(l.parsed.name.toLowerCase());
        })
        .map((l) => l.raw);
      setUnresolved(missed);
      setText(remaining.join("\n"));
      await onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setUnresolved(null);
        }}
        onKeyDown={(e) => {
          // Ctrl/⌘+Enter adds; plain Enter keeps making new lines.
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void add();
          }
        }}
        rows={5}
        placeholder={"Tritanium\t1000\nHobgoblin II\t5\nRifter"}
        className="w-full max-w-2xl resize-y rounded bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={() => void add()}
          disabled={parsed.length === 0 || busy}
          className="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          Add {parsed.length > 0 ? `${parsed.length} line(s)` : "items"}
        </button>
        <span className="text-xs text-zinc-500">
          Paste Multibuy or inventory (<code>name … qty</code>, extra columns
          ignored) · unmatched lines stay · Ctrl/⌘+Enter to add
        </span>
      </div>
      {unresolved && unresolved.length > 0 && (
        <p className="mt-2 text-xs text-amber-400">
          Couldn't find {unresolved.length} item(s) — left in the box to fix:{" "}
          {unresolved.join(", ")}
        </p>
      )}
    </div>
  );
}
