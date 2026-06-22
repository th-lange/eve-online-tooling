import { QueryClient } from "@tanstack/react-query";

// Shared TanStack Query client. ESI/SDE data has its own server-side cache
// timers, so we keep retries off and don't refetch on focus by default;
// individual queries can opt into staleTime/refetch as needed.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});
