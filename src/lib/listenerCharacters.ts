/** Names for the "any character" dropdowns (Recording → "Only for character",
 *  DPS meter → "Character"): gamelog `Listener:` names first (most recent
 *  activity, includes multi-boxed alts never logged into the app), then
 *  logged-in roster names the logs don't already cover. Deduped
 *  case-sensitively — EVE character names are canonical, and the consumers
 *  filter on the exact `Listener:` header string (#1047). */
export function mergeListenerCharacters(
  gamelogNames: readonly string[] | undefined,
  roster: readonly { name: string }[] | undefined,
): string[] {
  const merged = new Set(gamelogNames ?? []);
  for (const c of roster ?? []) merged.add(c.name);
  return [...merged];
}
