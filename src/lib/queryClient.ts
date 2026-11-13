import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { logStore } from "./logStore";
import { errorMessage } from "./api/common";

// Shared TanStack Query client. ESI/SDE data has its own server-side cache
// timers (and the Rust client now revalidates with ETags), so re-fetching on
// every page mount is wasteful. A 60s default staleTime lets shared keys
// (sde/status, market/regions, auth/*) serve from cache when hopping between
// pages; queries that want fresher data call refetch() on a button, and a
// stale read is still cheap (a 304) thanks to the backend conditional cache.
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError(error, query) {
      logStore.push({
        ts: Date.now(),
        level: "error",
        source: "frontend",
        target: `query:${String(query.queryKey[0] ?? "unknown")}`,
        message: errorMessage(error),
      });
    },
  }),
  // A failed mutation used to leave no trace at all unless its caller rendered
  // `mutation.error` (many don't) — log it so the Logs page can show it (#1196).
  mutationCache: new MutationCache({
    onError(error) {
      logStore.push({
        ts: Date.now(),
        level: "error",
        source: "frontend",
        target: "mutation",
        message: errorMessage(error),
      });
    },
  }),
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  },
});
