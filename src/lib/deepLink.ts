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

// The same pattern for the Fitting module: hand it an EFT fit string (e.g. from
// the PVP tab's "Simulate" button) and it loads it. A string, not an item id.
let pendingFit: string | null = null;
const fitSubscribers = new Set<(eft: string) => void>();

/** Route an EFT fit to the Fitting module and load it there. */
export function openFitInFitting(eft: string): void {
  pendingFit = eft;
  for (const fn of fitSubscribers) fn(eft);
}

/** Subscribe to fit-open requests (returns an unsubscribe fn). */
export function subscribeFitImport(fn: (eft: string) => void): () => void {
  fitSubscribers.add(fn);
  return () => void fitSubscribers.delete(fn);
}

/** Consume any fit stashed before the Fitting page first mounted. */
export function takePendingFitImport(): string | null {
  const p = pendingFit;
  pendingFit = null;
  return p;
}

// Imperative route navigation for callers that live *outside* the router (e.g.
// the app-root reminders "due" modal): they can't use `useNavigate`, so they
// publish a route here and a tiny `NavBridge` mounted inside the Layout (which
// has router context) performs the navigation. A no-op if nothing is mounted.
const routeSubscribers = new Set<(route: string) => void>();

/** Navigate to `route` (e.g. "/pi") from anywhere, router context or not. */
export function goToRoute(route: string): void {
  for (const fn of routeSubscribers) fn(route);
}

/** Subscribe to route-navigation requests (returns an unsubscribe fn). */
export function subscribeRoute(fn: (route: string) => void): () => void {
  routeSubscribers.add(fn);
  return () => void routeSubscribers.delete(fn);
}

// Focus one PI colony after navigating to the PI module — same mount/already-
// mounted dual delivery as the market/fitting links above.
let pendingColony: number | null = null;
const colonySubscribers = new Set<(planetId: number) => void>();

/** Ask the PI module to scroll to + highlight the colony on `planetId`. */
export function openColonyInPi(planetId: number): void {
  pendingColony = planetId;
  for (const fn of colonySubscribers) fn(planetId);
}

/** Subscribe to PI colony-focus requests (returns an unsubscribe fn). */
export function subscribePiColony(fn: (planetId: number) => void): () => void {
  colonySubscribers.add(fn);
  return () => void colonySubscribers.delete(fn);
}

/** Consume any colony stashed before the PI page first mounted. */
export function takePendingPiColony(): number | null {
  const p = pendingColony;
  pendingColony = null;
  return p;
}
