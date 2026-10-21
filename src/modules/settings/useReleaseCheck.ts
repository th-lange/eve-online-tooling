import { useQuery } from "@tanstack/react-query";
import { releaseCheckLatest } from "../../lib/api/release";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { RELEASE_CHECK_STALE_TIME_MS } from "../../lib/refreshIntervals";
import { releaseCheckKeys } from "../../lib/queryKeys";

/**
 * Whether to check for a newer release on startup. Default **on** — this is
 * the one opt-out background network call the app makes (a single GET to
 * GitHub's public Releases API, no account/user data in the request); see
 * the "nothing phones home" note in the README for why that's called out
 * explicitly instead of just being silently on.
 */
export function useCheckForUpdatesEnabled() {
  return usePersistentState<boolean>(STORAGE_KEYS.checkForUpdates, true);
}

/**
 * Shared release-check query — same `queryKey` for the Settings page (status
 * line + manual "Check now") and the sidebar badge, so TanStack Query dedupes
 * them into one network call instead of mounting two. `enabled` only gates
 * the automatic on-mount fetch; `refetch()` still works with `enabled: false`
 * (the "Check now" button), the same "only when you press it" model as
 * Feedback's manual send.
 */
export function useReleaseCheck(enabled: boolean) {
  return useQuery({
    queryKey: releaseCheckKeys.all,
    queryFn: releaseCheckLatest,
    enabled,
    staleTime: RELEASE_CHECK_STALE_TIME_MS,
    retry: false,
  });
}
