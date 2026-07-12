import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  pluginsList,
  pluginSetActive,
  PERMISSION_LABELS,
  type PluginEntry,
} from "../../lib/api";
import { Page, PageHeader, Centered } from "../../components/page";

const SUBTITLE =
  "Installed plugins are inert until you activate them. Each shows the capabilities it declares — activate only what you trust.";

export function PluginsPage() {
  const plugins = useQuery({ queryKey: ["plugins"], queryFn: pluginsList });

  if (plugins.isLoading) {
    return (
      <Page>
        <PageHeader title="Plugins" subtitle={SUBTITLE} />
        <Centered>Scanning plugins…</Centered>
      </Page>
    );
  }
  if (plugins.isError) {
    return (
      <Page>
        <PageHeader title="Plugins" subtitle={SUBTITLE} />
        <Centered>
          <span className="text-rose-400">
            Couldn't read plugins: {String(plugins.error)}
          </span>
        </Centered>
      </Page>
    );
  }

  const entries = plugins.data ?? [];
  return (
    <Page>
      <PageHeader title="Plugins" subtitle={SUBTITLE} />
      {entries.length === 0 ? (
        <Centered>
          No plugins installed. Drop a plugin folder into the app's{" "}
          <code>plugins/</code> directory, then reopen this page.
        </Centered>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {entries.map((e) => (
            <PluginCard key={e.manifest.id} entry={e} />
          ))}
        </div>
      )}
    </Page>
  );
}

function PluginCard({ entry }: { entry: PluginEntry }) {
  const qc = useQueryClient();
  const { manifest, active } = entry;
  const toggle = useMutation({
    mutationFn: (next: boolean) => pluginSetActive(manifest.id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plugins"] }),
  });

  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-100">{manifest.name}</span>
          <span className="text-xs text-zinc-500">v{manifest.version}</span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
              active
                ? "bg-emerald-950 text-emerald-300"
                : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {active ? "Active" : "Inactive"}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">{manifest.id}</div>
        {manifest.permissions.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {manifest.permissions.map((p) => (
              <li
                key={p}
                title={p}
                className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
              >
                {PERMISSION_LABELS[p] ?? p}
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-2 text-xs text-zinc-500">
            Requests no capabilities.
          </div>
        )}
      </div>
      <button
        onClick={() => toggle.mutate(!active)}
        disabled={toggle.isPending}
        className={`shrink-0 rounded px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
          active
            ? "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            : "bg-indigo-600 text-white hover:bg-indigo-500"
        }`}
      >
        {active ? "Deactivate" : "Activate"}
      </button>
    </div>
  );
}
