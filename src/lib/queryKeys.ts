// Shared TanStack Query keys that more than one component invalidates/reads.
// Kept out of component files so react-refresh can hot-reload those cleanly.

/** Key for the shopping lists; shared so "add to list" buttons can invalidate
 *  the Shopping page from anywhere. */
export const SHOPPING_LISTS_KEY = ["shopping", "lists"] as const;
