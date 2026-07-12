/**
 * Case-insensitive subsequence match — "stra" matches "Station Trading".
 * Shared by the command palette and any in-page search box that wants
 * typo/abbreviation-tolerant filtering instead of a strict substring match.
 */
export function fuzzy(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  let i = 0;
  for (const ch of needle.toLowerCase()) {
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}
