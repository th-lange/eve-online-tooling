import { type ReactNode } from "react";
import type { ListItem } from "../lib/api/common";
import { AddToListButton } from "./AddToListButton";
import { Centered } from "./page";

export type ListTab = "opportunities" | "favorites" | "blacklist";

/** Segmented control for the opportunities/favorites/blacklist tabs, with counts. */
export function ListTabs({
  tab,
  onChange,
  counts,
}: {
  tab: ListTab;
  onChange: (t: ListTab) => void;
  counts: { favorites: number; blacklist: number };
}) {
  const tabs: { value: ListTab; label: string }[] = [
    { value: "opportunities", label: "Opportunities" },
    { value: "favorites", label: `Favorites (${counts.favorites})` },
    { value: "blacklist", label: `Blacklist (${counts.blacklist})` },
  ];
  return (
    <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={`rounded px-3 py-1.5 text-sm ${
            tab === t.value
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The favorites/blacklist tab body: a saved list's items with a per-module
 * detail line (render prop, since each workbench summarizes a row
 * differently) and a remove button.
 */
export function SavedListView<T>({
  items,
  rowsById,
  removeLabel,
  onRemove,
  detail,
}: {
  items: ListItem[];
  rowsById: Map<number, T>;
  removeLabel: string;
  onRemove: (typeId: number) => void;
  detail: (row: T) => ReactNode;
}) {
  if (items.length === 0) {
    return <Centered>Nothing here yet.</Centered>;
  }
  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {items.map((it) => {
            const r = rowsById.get(it.typeId);
            return (
              <tr key={it.typeId} className="border-t border-zinc-800">
                <td className="px-3 py-1.5 text-zinc-200">{it.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                  {r ? detail(r) : ""}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button
                    onClick={() => onRemove(it.typeId)}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {removeLabel}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The favorite/blacklist/add-to-list row-action cell used by the opportunity
 * tables. Always stops click propagation (harmless where the row itself has
 * no click handler; required where it does, e.g. reprocessing's expand row).
 */
export function RowActionsCell<
  T extends { typeId: number; favorite: boolean },
>({
  row,
  onFavorite,
  onBlacklist,
  showAddToList = false,
  className = "px-2",
}: {
  row: T;
  onFavorite: (r: T) => void;
  onBlacklist: (r: T) => void;
  showAddToList?: boolean;
  className?: string;
}) {
  return (
    <td className={className}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onFavorite(row);
        }}
        title="Favorite"
        className={
          row.favorite ? "text-amber-400" : "text-zinc-600 hover:text-amber-400"
        }
      >
        ★
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onBlacklist(row);
        }}
        title="Blacklist"
        className="ml-2 text-zinc-600 hover:text-rose-400"
      >
        ✕
      </button>
      {showAddToList && (
        <span className="ml-2">
          <AddToListButton
            typeId={row.typeId}
            label="+List"
            className="text-zinc-600 hover:text-emerald-400"
          />
        </span>
      )}
    </td>
  );
}
