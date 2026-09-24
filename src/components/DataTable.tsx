import type { ReactNode } from "react";
import { SortHeaderCell, type SortColumn } from "./SortHeaderCell";
import type { SortDir } from "../lib/usePersistentSort";

export type { SortColumn };

const STICKY_HEAD =
  "sticky top-0 z-10 bg-zinc-900 text-zinc-400 shadow-[0_1px_0_0_theme(colors.zinc.800)]";
const STATIC_HEAD = "bg-zinc-900 text-zinc-400";
const DEFAULT_CONTAINER_CLASS = "overflow-auto rounded border border-zinc-800";

/**
 * The sortable-table shell shared by Production, Orders and Trading (#839):
 * a sticky, tooltip'd header built from a `SortColumn[]`, plus caller-owned
 * row rendering so each module keeps its own row markup (expand rows, icon
 * columns, etc.) without re-implementing the `<table>`/`<thead>` boilerplate.
 *
 * Sticky by default — set `sticky={false}` for the rare non-scrolling case.
 * When `rows` is empty, `emptyState` replaces the whole table (matching the
 * pattern Production pioneered) rather than rendering an empty `<tbody>`.
 */
export function DataTable<T, K extends string>({
  columns,
  sortKey,
  sortDir,
  onSort,
  rows,
  renderRow,
  leadingHeader,
  trailingHeader,
  demotedKeys,
  emptyState,
  className = DEFAULT_CONTAINER_CLASS,
  sticky = true,
}: {
  columns: SortColumn<K>[];
  sortKey: K;
  sortDir: SortDir;
  onSort: (key: K) => void;
  rows: T[];
  /** Renders one row (or a `Fragment` of rows) for a data item; owns its own `key`. */
  renderRow: (row: T) => ReactNode;
  /** Extra `<th>` cells before the sortable columns (e.g. expand/favorite icons). */
  leadingHeader?: ReactNode;
  /** Extra `<th>` cells after the sortable columns (e.g. Market, Undercut, Trend). */
  trailingHeader?: ReactNode;
  /** Column keys rendered as de-emphasised "support" columns (smaller, muted, group rule). */
  demotedKeys?: K[];
  /** Replaces the whole table with this node when `rows` is empty. */
  emptyState: ReactNode;
  /** Wrapper `<div>` className; defaults to the standard bordered/scrollable shell. */
  className?: string;
  /** Disable the sticky header for a non-scrolling table. */
  sticky?: boolean;
}) {
  if (rows.length === 0) return <>{emptyState}</>;

  return (
    <div className={className}>
      <table className="w-full border-collapse text-sm">
        <thead className={sticky ? STICKY_HEAD : STATIC_HEAD}>
          <tr>
            {leadingHeader}
            {columns.map((c) => (
              <SortHeaderCell
                key={c.key}
                column={c}
                active={sortKey === c.key}
                dir={sortDir}
                onClick={onSort}
                demoted={demotedKeys?.includes(c.key)}
              />
            ))}
            {trailingHeader}
          </tr>
        </thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table>
    </div>
  );
}
