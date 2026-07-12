/**
 * Case-insensitive subsequence match — "stra" matches "Station Trading".
 * Shared by the command palette and any in-page search box that wants
 * typo/abbreviation-tolerant filtering instead of a strict substring match.
 */
export function fuzzy(haystack: string, needle: string): boolean {
  return subsequence(haystack.toLowerCase(), needle.toLowerCase());
}

/**
 * The subsequence test on already-lowercased strings. Hot filter loops
 * (large asset lists) precompute each row's lowercased haystack once and
 * lowercase the needle once, then call this per row — avoiding the
 * per-call `toLowerCase()` allocations `fuzzy` would otherwise repeat.
 */
export function subsequence(
  lowerHaystack: string,
  lowerNeedle: string,
): boolean {
  if (!lowerNeedle) return true;
  let i = 0;
  for (let k = 0; k < lowerNeedle.length; k++) {
    i = lowerHaystack.indexOf(lowerNeedle[k], i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}
