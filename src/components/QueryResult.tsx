import type { ReactNode } from "react";
import { Centered } from "./page";
import { DataAge } from "./DataAge";
import { EmptyState } from "./EmptyState";
import { QueryErrorNotice } from "./QueryErrorNotice";

/**
 * Minimal shape `QueryResult` needs to pick the error/loading/empty/data
 * state. A TanStack `useQuery` result satisfies this directly. For a
 * `useMutation` result, build one by hand — its `isPending` already means
 * "no result yet", same as a query before its first fetch resolves:
 * `{ isError: m.isError, error: m.error, isPending: m.isPending, data: m.data }`.
 */
export interface QueryResultState<T> {
  isError: boolean;
  error: unknown;
  isPending: boolean;
  data: T | undefined;
}

/**
 * Shared loading → error → empty → data rendering for a query/mutation
 * result (#837). Priority:
 *   1. error — `QueryErrorNotice`, which branches on `isAuthRequired()` so
 *      missing-scope failures get a re-login hint instead of a raw string.
 *   2. loading — `pendingLabel` (in flight, or no result yet).
 *   3. empty — a standardized `EmptyState` (headline + next-step hint), also
 *      used for "never run yet" (mutation with no data and not pending).
 *   4. data — the `children` render prop, plus an optional `DataAge`
 *      freshness cue when `updatedAt` is given. Omit `updatedAt` when the
 *      page already surfaces its own `DataAge` next to a Refresh/Calculate
 *      button.
 */
export function QueryResult<T>({
  result,
  pendingLabel = "Loading…",
  loginMessage,
  scopeHint,
  isEmpty,
  emptyTitle = "Nothing here yet.",
  emptyHint,
  updatedAt,
  fetching,
  children,
}: {
  result: QueryResultState<T>;
  pendingLabel?: ReactNode;
  loginMessage?: string;
  scopeHint?: ReactNode;
  /** Data present but semantically empty (e.g. a zero-length row array). */
  isEmpty?: (data: T) => boolean;
  emptyTitle?: ReactNode;
  emptyHint?: ReactNode;
  updatedAt?: number;
  fetching?: boolean;
  children: (data: T) => ReactNode;
}) {
  if (result.isError) {
    return (
      <QueryErrorNotice
        error={result.error}
        loginMessage={loginMessage}
        scopeHint={scopeHint}
        className="p-6 text-sm"
      />
    );
  }
  if (result.isPending) {
    return <Centered>{pendingLabel}</Centered>;
  }
  if (result.data === undefined || isEmpty?.(result.data)) {
    return <EmptyState title={emptyTitle} hint={emptyHint} />;
  }
  return (
    <>
      {updatedAt != null && (
        <div className="mb-2 flex justify-end">
          <DataAge updatedAt={updatedAt} fetching={fetching} />
        </div>
      )}
      {children(result.data)}
    </>
  );
}
