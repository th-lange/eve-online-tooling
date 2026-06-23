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
}: {
  column: SortColumn<K>;
  active: boolean;
  dir: SortDir;
  onClick: (key: K) => void;
}) {
  return (
    <th
      onClick={() => onClick(column.key)}
      title={column.description}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`cursor-pointer select-none px-3 py-2 font-medium ${
        column.numeric ? "text-right" : "text-left"
      } hover:text-zinc-200`}
    >
      {column.label}
      <span
        className="ml-0.5 align-super text-[9px] text-zinc-600"
        aria-hidden="true"
      >
        ⓘ
      </span>
      {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}
