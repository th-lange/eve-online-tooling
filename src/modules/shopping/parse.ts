// Liberal paste parsing for shopping lists: turn assorted copy/paste formats
// (EVE Multibuy, inventory dumps with trailing columns, plain name lists) into
// `{ name, quantity }` items. Kept pure (no Tauri imports) so it's unit-tested.

/** A token that is purely a number (optional thousands separators and an `x`
 *  like "x100"/"100x") — used to split a line's name from its quantity. */
export function isNumberToken(t: string): boolean {
  return /^x?[\d.,]*\d[\d.,]*x?$/i.test(t);
}

/**
 * Parse one liberally-formatted line into `{ name, quantity }`, or `null` when
 * there's no name. The rule: the **name** is the leading run of non-numeric
 * tokens, the **quantity** is the first number after it, and everything else is
 * ignored. That covers EVE Multibuy (`Tritanium 1000`, `Tritanium⇥1000`) and
 * inventory/copy pastes with trailing columns (`Tritanium⇥1,000⇥Mineral⇥…`).
 * No number ⇒ quantity 1. A quantity-first / number-only line ⇒ `null` (left).
 */
export function parseLine(
  raw: string,
): { name: string; quantity: number } | null {
  const line = raw.trim();
  if (!line) return null;
  const tokens = line.split(/[\t ]+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && !isNumberToken(tokens[i])) i++;
  const name = tokens.slice(0, i).join(" ").trim();
  if (!name) return null;
  let quantity = 1;
  if (i < tokens.length) {
    const digits = tokens[i].replace(/\D/g, "");
    if (digits) quantity = Math.max(1, Number(digits));
  }
  return { name, quantity };
}

/** Every parseable line in a paste (one item each). */
export function parseItems(text: string): { name: string; quantity: number }[] {
  return text
    .split("\n")
    .map(parseLine)
    .filter((p): p is { name: string; quantity: number } => p !== null);
}
