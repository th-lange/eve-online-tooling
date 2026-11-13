// EVE limits order prices to 4 significant digits (Broker Relations change,
// 2020), so "one tick" is not a flat 0.01 ISK: it is 0.01 below 100 ISK and
// 10^(floor(log10(price)) − 3) above (1,234,000 → 1,000). Copying best ± 0.01
// gives a price the client rejects or snaps back to the competitor's (#1167).

const MIN_TICK = 0.01;

/** The price increment in force at `price` (the decade it sits in). */
export function tickSize(price: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return MIN_TICK;
  return Math.max(MIN_TICK, 10 ** (Math.floor(Math.log10(price)) - 3));
}

/** Trim float noise: a valid order price has at most 4 significant digits. */
function snap(price: number): number {
  return Number(price.toPrecision(4));
}

/** The next valid price above `price` (overbid a buy order). */
export function tickUp(price: number): number {
  return snap(price + tickSize(price));
}

/** The next valid price below `price` (undercut a sell order), never below 0.
 *  Uses the decade just under `price`, so 1000 → 999.9, not 999. */
export function tickDown(price: number): number {
  const lower = price - tickSize(price * (1 - 1e-9));
  return Math.max(snap(lower), 0);
}
