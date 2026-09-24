import { commands, type OrderRow } from "./generated/orders";
import { unwrapCommand } from "./common";

export type { OrderRow };

/**
 * The logged-in character's open market orders with undercut detection.
 * Requires the `esi-markets.read_character_orders.v1` scope (re-login if added).
 */
export async function marketOrders(): Promise<OrderRow[]> {
  return unwrapCommand(await commands.ordersList());
}
