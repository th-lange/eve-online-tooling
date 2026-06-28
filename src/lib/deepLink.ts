// A tiny pub-sub for cross-module "open this item over there" navigation. The
// command palette (and other modules) can hand an item type to Market Search
// without threading props through the router. Pages keep-alive in the Layout
// host, so we both fire an event (for an already-mounted page) and stash a
// pending value (for a page mounting for the first time on navigation).

export interface DeepLinkItem {
  id: number;
  name: string;
}

let pending: DeepLinkItem | null = null;
const subscribers = new Set<(item: DeepLinkItem) => void>();

/** Route an item type to Market Search and select it there. */
export function openItemInMarketSearch(item: DeepLinkItem): void {
  pending = item;
  for (const fn of subscribers) fn(item);
}

/** Subscribe to item-open requests (returns an unsubscribe fn). */
export function subscribeMarketSearchItem(
  fn: (item: DeepLinkItem) => void,
): () => void {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
}

/** Consume any item stashed before the page first mounted. */
export function takePendingMarketSearchItem(): DeepLinkItem | null {
  const p = pending;
  pending = null;
  return p;
}
