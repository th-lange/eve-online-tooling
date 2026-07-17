import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Puzzle } from "lucide-react";
import { pluginsList } from "../../lib/api";
import { modules, type ModuleDef } from "../registry";
import { PluginPage } from "./PluginPage";

/**
 * The **active** installed plugins that ship a UI (`manifest.ui`), surfaced as
 * nav modules. Activating a UI plugin on the Plugins page makes it appear in
 * the sidebar under "Plugins" and routable at `/<id>` (rendered by
 * `PluginPage`); deactivating removes it. Activation is the trust gate — an
 * inactive plugin renders nothing.
 *
 * A plugin id that collides with a built-in module id is dropped (built-ins
 * win), so a drop-in can never shadow a first-party page.
 */
export function usePluginModules(): ModuleDef[] {
  const { data } = useQuery({ queryKey: ["plugins"], queryFn: pluginsList });
  return useMemo(() => {
    const builtinIds = new Set(modules.map((m) => m.id));
    return (data ?? [])
      .filter(
        (p) => p.active && p.manifest.ui && !builtinIds.has(p.manifest.id),
      )
      .map((p): ModuleDef => ({
        id: p.manifest.id,
        title: p.manifest.name,
        description: `Third-party plugin UI (${p.manifest.id}).`,
        group: "plugins",
        icon: Puzzle,
        Component: () => (
          <PluginPage id={p.manifest.id} name={p.manifest.name} />
        ),
      }));
  }, [data]);
}
