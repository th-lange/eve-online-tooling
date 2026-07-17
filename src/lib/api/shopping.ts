import { invoke } from "@tauri-apps/api/core";

/** One item on a shopping list, resolved to its display name. */
export interface ShoppingItem {
  typeId: number;
  name: string;
  quantity: number;
}

/** A named shopping list and its items. Built-in lists can't be removed. */
export interface ShoppingList {
  id: string;
  name: string;
  removable: boolean;
  items: ShoppingItem[];
}

/** Every shopping list with its items (the `default` + `production` lists are
 * always present). */
export function shoppingLists(): Promise<ShoppingList[]> {
  return invoke<ShoppingList[]>("shopping_lists");
}

/** Create a new list from a display name; returns the created list. */
export function shoppingCreateList(name: string): Promise<ShoppingList> {
  return invoke<ShoppingList>("shopping_create_list", { name });
}

/** Delete a list (rejects the built-in default/production lists). */
export function shoppingDeleteList(id: string): Promise<void> {
  return invoke<void>("shopping_delete_list", { id });
}

/** Add `quantity` (default 1) of a type to a list, accumulating if present. */
export function shoppingAddItem(
  id: string,
  typeId: number,
  quantity = 1,
): Promise<void> {
  return invoke<void>("shopping_add_item", { id, typeId, quantity });
}

/** Bulk-add Multibuy-style pasted lines (`name` or `name\tqty`). Names are
 * resolved against the SDE; the array of names that couldn't be resolved is
 * returned. */
export function shoppingAddText(
  id: string,
  items: { name: string; quantity: number }[],
): Promise<string[]> {
  return invoke<string[]>("shopping_add_text", { id, items });
}

/** Set an item's exact quantity; a quantity ≤ 0 removes it. */
export function shoppingSetQuantity(
  id: string,
  typeId: number,
  quantity: number,
): Promise<void> {
  return invoke<void>("shopping_set_quantity", { id, typeId, quantity });
}

/** Remove an item from a list. */
export function shoppingRemoveItem(id: string, typeId: number): Promise<void> {
  return invoke<void>("shopping_remove_item", { id, typeId });
}

/** Empty a list of all its items. */
export function shoppingClearList(id: string): Promise<void> {
  return invoke<void>("shopping_clear_list", { id });
}

/** Move an item between lists (whole entry unless `quantity` is given). */
export function shoppingMoveItem(
  fromId: string,
  toId: string,
  typeId: number,
  quantity?: number,
): Promise<void> {
  return invoke<void>("shopping_move_item", { fromId, toId, typeId, quantity });
}

/** Result of a chat-capture poll. */
export interface ChatSync {
  /** Item names newly added to the target list this poll. */
  added: string[];
  /** A label for what's being followed (a filename, or "N logs"). */
  file: string;
  /** Whether a matching chatlog file was found. */
  found: boolean;
}

/**
 * Follow an EVE chat channel's log and add linked/typed items to a target list.
 * `logsDir` is the EVE Chatlogs folder; `channel` is the channel name; `listId`
 * is where items land (defaults to the built-in `chat` list). Pass `fromNow` on
 * the first poll to mark existing log content as seen (so only new messages are
 * captured). Poll every few seconds while listening.
 */
export function shoppingChatSync(
  logsDir: string,
  channel: string,
  fromNow?: boolean,
  listId?: string,
): Promise<ChatSync> {
  return invoke<ChatSync>("shopping_chat_sync", {
    logsDir,
    channel,
    fromNow,
    listId,
  });
}
