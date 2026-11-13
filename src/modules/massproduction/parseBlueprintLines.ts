// Liberal paste parsing + Multibuy-style export for Mass Production's
// blueprint list, with an explicit "how many to build" count per line. Kept
// pure (no Tauri imports) so it's unit-tested, mirroring `lib/parseItems.ts`.

import { splitLine } from "../../lib/parseItems";
import type { BlueprintLine } from "../../lib/api";

/**
 * Parse one liberally-formatted line into a name plus an optional explicit
 * build-run count, or `null` when there's no name. Same tokenizing rule as
 * the shared `parseLine` (see `splitLine`) — but unlike that parser, a missing number stays
 * `null` here rather than defaulting to 1: Mass Production needs to tell
 * "no number typed" (keep the mode's computed default — real Owned
 * ownership, or Hypothetical's rule-derived assumption) apart from
 * "typed 1" (build exactly one), which a silent default-to-1 would erase.
 */
export function parseBlueprintLine(
  raw: string,
): { name: string; buildRuns: number | null } | null {
  const parts = splitLine(raw);
  if (!parts) return null;
  const { name } = parts;
  let buildRuns: number | null = null;
  if (parts.qtyToken) {
    const digits = parts.qtyToken.replace(/\D/g, "");
    if (digits) buildRuns = Math.max(0, Number(digits));
  }
  return { name, buildRuns };
}

/** Every parseable line in a paste, as `BlueprintLine`s ready for
 *  `massprodPlan` — one per line, each carrying its explicit build-run
 *  count (or no override when the line had no number). */
export function parseBlueprintLines(text: string): BlueprintLine[] {
  return text
    .split("\n")
    .map(parseBlueprintLine)
    .filter((p): p is { name: string; buildRuns: number | null } => p !== null)
    .map((p) => ({ name: p.name, buildRuns: p.buildRuns }));
}

/**
 * Format blueprint lines as a Multibuy-style paste, one per line: "Name" for
 * a line with no run count, "Name\tRuns" for one that has it. This is the
 * exact format `parseBlueprintLines` reads back, so exporting a list and
 * re-pasting it reproduces the same build-run counts — or the same "use the
 * computed default" for lines that had none.
 */
export function exportBlueprintLines(
  lines: { name: string; runs: number | null }[],
): string {
  return lines
    .map((l) => (l.runs != null ? `${l.name}\t${l.runs}` : l.name))
    .join("\n");
}
