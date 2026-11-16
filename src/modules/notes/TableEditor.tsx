import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { detectDelimiter, pad, parseCsv, serializeCsv } from "./csv";

/** Grids above this many cells fall back to raw text — thousands of inputs
 *  make the DOM sluggish, and raw CSV is still fully editable. */
const MAX_GRID_CELLS = 4000;

/**
 * Editor for a CSV note: a spreadsheet-style grid (first row = header) or the
 * raw CSV text. The CSV string is the single source of truth — every grid edit
 * re-serializes it, keeping the file's own delimiter.
 */
export function TableEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const delimiter = useMemo(() => detectDelimiter(value), [value]);
  const rows = useMemo(
    () => pad(parseCsv(value, delimiter)),
    [value, delimiter],
  );
  const cols = rows[0].length;
  const tooBig = rows.length * cols > MAX_GRID_CELLS;
  const [mode, setMode] = useState<"grid" | "raw">("grid");
  const showRaw = mode === "raw" || tooBig;

  function commit(next: string[][]) {
    onChange(serializeCsv(next, delimiter));
  }

  function setCell(r: number, c: number, text: string) {
    commit(
      rows.map((row, ri) =>
        ri === r ? row.map((v, ci) => (ci === c ? text : v)) : row,
      ),
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <div
          role="tablist"
          aria-label="Table view"
          className="flex overflow-hidden rounded border border-zinc-700"
        >
          {(["grid", "raw"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={showRaw ? m === "raw" : m === "grid"}
              disabled={m === "grid" && tooBig}
              title={
                m === "grid" && tooBig
                  ? "Too large for the grid — edit as raw CSV"
                  : undefined
              }
              onClick={() => setMode(m)}
              className={`px-2 py-1 disabled:opacity-40 ${
                (showRaw ? m === "raw" : m === "grid")
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {m === "grid" ? "Grid" : "Raw CSV"}
            </button>
          ))}
        </div>
        {!showRaw && (
          <>
            <button
              type="button"
              onClick={() => commit([...rows, Array(cols).fill("")])}
              className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
            >
              <Plus size={12} /> Row
            </button>
            <button
              type="button"
              onClick={() => commit(rows.map((r) => [...r, ""]))}
              className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
            >
              <Plus size={12} /> Column
            </button>
          </>
        )}
        <span className="ml-auto text-zinc-500">
          {rows.length} row{rows.length === 1 ? "" : "s"} × {cols} column
          {cols === 1 ? "" : "s"}
        </span>
      </div>

      {showRaw ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          spellCheck={false}
          aria-label="Raw CSV"
          className="min-h-64 flex-1 resize-none rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-100 outline-none focus:border-indigo-500"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded border border-zinc-800">
          <table className="border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-zinc-900">
              <tr>
                <th className="w-8" />
                {rows[0].map((_, c) => (
                  <th key={c} className="p-0 text-left font-medium">
                    <div className="flex items-center">
                      <input
                        value={rows[0][c]}
                        aria-label={`Header ${c + 1}`}
                        onChange={(e) => setCell(0, c, e.currentTarget.value)}
                        className="w-36 bg-transparent px-2 py-1 font-semibold text-zinc-100 outline-none focus:bg-zinc-800"
                      />
                      {cols > 1 && (
                        <button
                          type="button"
                          aria-label={`Delete column ${c + 1}`}
                          title="Delete column"
                          onClick={() =>
                            commit(
                              rows.map((r) => r.filter((_, ci) => ci !== c)),
                            )
                          }
                          className="px-1 text-zinc-600 hover:text-rose-400"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, i) => {
                const r = i + 1;
                return (
                  <tr key={r} className="border-t border-zinc-800/70">
                    <td className="text-center">
                      <button
                        type="button"
                        aria-label={`Delete row ${r}`}
                        title="Delete row"
                        onClick={() => commit(rows.filter((_, ri) => ri !== r))}
                        className="text-zinc-600 hover:text-rose-400"
                      >
                        <X size={12} />
                      </button>
                    </td>
                    {row.map((cell, c) => (
                      <td key={c} className="p-0">
                        <input
                          value={cell}
                          aria-label={`Row ${r} column ${c + 1}`}
                          onChange={(e) => setCell(r, c, e.currentTarget.value)}
                          className="w-36 bg-transparent px-2 py-1 text-zinc-200 outline-none focus:bg-zinc-800"
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
