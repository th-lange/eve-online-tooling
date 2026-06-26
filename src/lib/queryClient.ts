import { QueryClient } from "@tanstack/react-query";

// Shared TanStack Query client. ESI/SDE data has its own server-side cache
// timers (and the Rust client now revalidates with ETags), so re-fetching on
// every page mount is wasteful. A 60s default staleTime lets shared keys
// (sde/status, market/regions, auth/*) serve from cache when hopping between
// pages; queries that want fresher data call refetch() on a button, and a
// stale read is still cheap (a 304) thanks to the backend conditional cache.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    },
  },
});
