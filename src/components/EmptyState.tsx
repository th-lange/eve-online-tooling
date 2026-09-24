import type { ReactNode } from "react";

/**
 * A centred empty state: a headline plus a concrete next step (#837).
 * Shared version of the pattern Production pioneered in
 * `ProfitTable.tsx`'s local `EmptyState` — used by `QueryResult` and any
 * module that needs the same "nothing here, here's what to do" block
 * outside a query/mutation result (e.g. a post-filter empty list).
 */
export function EmptyState({
  title,
  hint,
}: {
  title: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded border border-dashed border-zinc-800 p-10 text-center">
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      {hint && (
        <div className="mx-auto mt-1 max-w-md text-xs text-zinc-500">
          {hint}
        </div>
      )}
    </div>
  );
}
