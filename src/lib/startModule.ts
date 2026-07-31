/** Which module "/" should redirect to on launch: the last-visited one when
 *  the registry still has it, else the first module. A stored id can name a
 *  module that was since removed/renamed (or a plugin that is no longer
 *  active) — redirecting there would leave the shell on a URL that matches no
 *  registry entry. Pure. */
export function resolveStartModule(
  stored: string | null,
  moduleIds: readonly string[],
  fallback: string,
): string {
  return stored != null && moduleIds.includes(stored) ? stored : fallback;
}
