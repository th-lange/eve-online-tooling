import { commands, type OrderRow } from "./generated/orders";

export type { OrderRow };

/**
 * The logged-in character's open market orders with undercut detection.
 * Requires the `esi-markets.read_character_orders.v1` scope (re-login if added).
 */
export async function marketOrders(): Promise<OrderRow[]> {
  const result = await commands.ordersList();
  if (result.status === "error") {
    throw result.error;
  }
  return result.data;
}
