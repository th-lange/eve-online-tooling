import { useId } from "react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import type { SortDir } from "../lib/usePersistentSort";

/** Column metadata shared by the sortable tables. */
export interface SortColumn<K extends string> {
  key: K;
  label: string;
  numeric: boolean;
  /** One-sentence explanation shown as a tooltip + behind the info marker. */
  description: string;
}

/**
 * A clickable, sortable table header cell with a built-in description. The
 * description is both a native `title=` tooltip (on hover) and a small always
 * visible `ⓘ` marker, so the meaning is discoverable without hovering (#20).
 * Shared by the production and trading tables.
 */
export function SortHeaderCell<K extends string>({
  column,
  active,
  dir,
  onClick,
  demoted = false,
}: {
  column: SortColumn<K>;
  active: boolean;
  dir: SortDir;
  onClick: (key: K) => void;
  /** Render as a de-emphasised support column (smaller, muted, group rule). */
  demoted?: boolean;
}) {
  const descId = useId();
  return (
    <th
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`select-none px-3 py-2 font-medium ${
        column.numeric ? "text-right" : "text-left"
      } ${
        demoted
          ? "border-l border-zinc-800/60 text-xs text-zinc-500"
          : "text-zinc-300"
      }`}
    >
      <button
        type="button"
        onClick={() => onClick(column.key)}
        title={column.description}
        aria-describedby={descId}
        className={`inline-flex cursor-pointer items-center gap-1 font-medium hover:text-zinc-100 ${
          column.numeric ? "flex-row-reverse" : ""
        }`}
      >
        {column.label}
        <Info size={12} className="text-zinc-400" aria-hidden="true" />
        {active &&
          (dir === "asc" ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          ))}
      </button>
      <span id={descId} className="sr-only">
        {column.description}
      </span>
    </th>
  );
}
