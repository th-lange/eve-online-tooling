import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { authCharacters } from "../lib/api";
import { modules, type ModuleDef } from "./registry";
import { usePluginModules } from "./plugins/pluginModules";

/**
 * Every module the nav should offer right now: the built-ins, plus active UI
 * plugins, minus any module marked `requiresCharacter` while the roster is
 * empty.
 *
 * Both nav surfaces (the sidebar and the ⌘K palette) build from this, so a
 * gated module can't be reachable from one but not the other. The *route*
 * still exists either way — a module that gates itself is responsible for
 * saying so on its own page, which is what someone arriving by direct link or
 * a restored "last visited" needs to see.
 *
 * While the roster query is in flight the answer is "no character", so a gated
 * module appears a beat late rather than flashing up and disappearing for the
 * users it isn't meant for.
 */
export function useAvailableModules(): ModuleDef[] {
  const pluginModules = usePluginModules();
  const characters = useQuery({
    queryKey: ["auth", "characters"],
    queryFn: authCharacters,
  });
  const hasCharacter = (characters.data?.length ?? 0) > 0;
  return useMemo(
    () =>
      [...modules, ...pluginModules].filter(
        (m) => hasCharacter || !m.requiresCharacter,
      ),
    [pluginModules, hasCharacter],
  );
}
