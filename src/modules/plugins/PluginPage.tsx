import { PageHeader } from "../../components/page";
import { PluginHost } from "../../components/PluginHost";

/**
 * A UI plugin's page: standard page chrome (title + hide control) wrapping the
 * plugin's own sandboxed UI. The iframe, its opaque-origin isolation, and the
 * `postMessage` → `plugin_invoke` bridge all live in `PluginHost` (issue #501);
 * this just gives the plugin a titled home in the module area.
 */
export function PluginPage({ id, name }: { id: string; name: string }) {
  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader title={name} subtitle="Third-party plugin UI." />
      <PluginHost
        pluginId={id}
        className="mt-4 min-h-0 w-full flex-1 rounded-lg border border-zinc-800 bg-white"
      />
    </div>
  );
}
