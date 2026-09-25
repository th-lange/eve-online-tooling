import { commands, type OrderRow } from "./generated/orders";
import { unwrapCommand, type Fresh } from "./common";

export type { OrderRow };

/**
 * The logged-in character's open market orders with undercut detection,
 * wrapped with the server's real ESI cache deadline (#885).
 * Requires the `esi-markets.read_character_orders.v1` scope (re-login if added).
 */
export async function marketOrders(): Promise<Fresh<OrderRow[]>> {
  return unwrapCommand(await commands.ordersList());
}
