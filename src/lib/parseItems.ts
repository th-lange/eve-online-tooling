// Liberal paste parsing for pasted item lists (shopping, appraisal, workbench
// import): turn assorted copy/paste formats (EVE Multibuy, inventory dumps
// with trailing columns, plain name lists) into `{ name, quantity }` items.
// Kept pure (no Tauri imports) so it's unit-tested.

/** A token that is purely a number (optional thousands separators and an `x`
 *  like "x100"/"100x") — used to split a line's name from its quantity. */
export function isNumberToken(t: string): boolean {
  return /^x?[\d.,]*\d[\d.,]*x?$/i.test(t);
}

/**
 * Split one pasted line into its item name and (optional) quantity token, or
 * `null` when there is no name. Shared by every paste parser so they agree.
 *
 * - **Tab-separated** (EVE Multibuy / inventory copy): the name is the first
 *   cell, the quantity the first numeric cell after it. A number inside the
 *   name ("Navy Cap Booster 400⇥20") is therefore never mistaken for the
 *   quantity.
 * - **Space-separated**: the quantity is the *last* token of the first run of
 *   numeric tokens, so "Navy Cap Booster 400 20" keeps its "400". A lone
 *   number is still taken as the quantity ("Tritanium 1000") — without a type
 *   list that is indistinguishable from "Cap Booster 800", so prefer tabs.
 *   A leading numeric token ("X5 Enduring Stasis Webifier 2") belongs to the
 *   name when a quantity follows later; otherwise the line is quantity-first
 *   and left unparsed.
 */
export function splitLine(
  raw: string,
): { name: string; qtyToken: string | null } | null {
  const line = raw.trim();
  if (!line) return null;

  if (line.includes("\t")) {
    const cells = line
      .split("\t")
      .map((c) => c.trim())
      .filter(Boolean);
    const name = cells[0];
    if (!name || isNumberToken(name)) return null;
    return { name, qtyToken: cells.slice(1).find(isNumberToken) ?? null };
  }

  const tokens = line.split(/ +/).filter(Boolean);
  const isNum = tokens.map(isNumberToken);
  // End (exclusive) of the numeric run that starts at `from`.
  const runEnd = (from: number) => {
    let e = from;
    while (e < tokens.length && isNum[e]) e++;
    return e;
  };
  let first = isNum.indexOf(true);
  if (first === -1) return { name: tokens.join(" "), qtyToken: null };
  if (first === 0) {
    // Leading number: part of the name only if a quantity follows later.
    const later = isNum.indexOf(true, runEnd(0));
    if (later === -1) return null;
    first = later;
  }
  const qtyIdx = runEnd(first) - 1;
  return { name: tokens.slice(0, qtyIdx).join(" "), qtyToken: tokens[qtyIdx] };
}

/**
 * Parse one liberally-formatted line into `{ name, quantity }`, or `null` when
 * there's no name (see [`splitLine`] for the rules). No number ⇒ quantity 1. A
 * quantity-first / number-only line ⇒ `null` (left).
 */
export function parseLine(
  raw: string,
): { name: string; quantity: number } | null {
  const parts = splitLine(raw);
  if (!parts) return null;
  let quantity = 1;
  if (parts.qtyToken) {
    const digits = parts.qtyToken.replace(/\D/g, "");
    if (digits) quantity = Math.max(1, Number(digits));
  }
  return { name: parts.name, quantity };
}

/** Every parseable line in a paste (one item each). */
export function parseItems(text: string): { name: string; quantity: number }[] {
  return text
    .split("\n")
    .map(parseLine)
    .filter((p): p is { name: string; quantity: number } => p !== null);
}
