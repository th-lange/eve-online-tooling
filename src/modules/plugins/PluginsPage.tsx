import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Play,
  Radio,
  RefreshCw,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import {
  errorMessage,
  pluginsList,
  pluginsRescan,
  pluginsDir,
  pluginsInstall,
  pluginsRemove,
  pluginSetActive,
  mcpStatus,
  mcpStart,
  mcpStop,
  mcpConfig,
  mcpSetPort,
  mcpSetAutostart,
  mcpSetDevTier,
  scriptsList,
  PERMISSION_LABELS,
  type PluginEntry,
  type ScriptLanguage,
} from "../../lib/api";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import { Page, PageHeader, Centered } from "../../components/page";
import { useScriptRuns } from "../scripts/runnerContext";

const SUBTITLE =
  "Installed plugins are inert until you activate them. Each shows the capabilities it declares — activate only what you trust.";

const LANGUAGE_LABEL: Record<ScriptLanguage, string> = {
  rhai: "Rhai",
  js: "JavaScript",
};

export function PluginsPage() {
  const plugins = useQuery({ queryKey: ["plugins"], queryFn: pluginsList });
  const qc = useQueryClient();
  const dir = useQuery({ queryKey: ["plugins", "dir"], queryFn: pluginsDir });
  const rescan = useMutation({
    mutationFn: pluginsRescan,
    onSuccess: (list) => qc.setQueryData(["plugins"], list),
  });
  const [isDragOver, setIsDragOver] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const install = useMutation({
    mutationFn: pluginsInstall,
    onSuccess: (list) => {
      qc.setQueryData(["plugins"], list);
      setInstallError(null);
    },
    onError: (err) => setInstallError(errorMessage(err)),
  });

  // Native OS drag-and-drop: dropped paths (a plugin folder or a .zip) are
  // installed in order. HTML5 drag events don't fire alongside this — Tauri
  // intercepts the drop at the webview level and hands us real filesystem
  // paths instead of browser File objects.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const { payload } = event;
      if (payload.type === "enter" || payload.type === "over") {
        setIsDragOver(true);
      } else if (payload.type === "leave") {
        setIsDragOver(false);
      } else if (payload.type === "drop") {
        setIsDragOver(false);
        for (const path of payload.paths) {
          install.mutate(path);
        }
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- install.mutate identity is stable across renders (react-query)
  }, []);

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
            Couldn't read plugins: {errorMessage(plugins.error)}
          </span>
        </Centered>
      </Page>
    );
  }

  const entries = plugins.data ?? [];
  return (
    <Page>
      <PageHeader
        title="Plugins"
        subtitle={SUBTITLE}
        actions={
          <button
            onClick={() => rescan.mutate()}
            disabled={rescan.isPending}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            <RefreshCw
              size={13}
              className={rescan.isPending ? "animate-spin" : ""}
            />
            Rescan
          </button>
        }
      />
      <McpBridgeCard />
      <RunningScriptsCard />
      <div
        className={`mt-4 flex items-start gap-2 rounded-lg border p-3 text-xs transition-colors ${
          isDragOver
            ? "border-indigo-500 bg-indigo-950/40 text-indigo-200"
            : "border-zinc-800 bg-zinc-900/40 text-zinc-400"
        }`}
      >
        {isDragOver ? (
          <Upload size={14} className="mt-0.5 shrink-0 text-indigo-300" />
        ) : (
          <FolderOpen size={14} className="mt-0.5 shrink-0 text-zinc-500" />
        )}
        <span>
          {isDragOver ? (
            "Drop to install…"
          ) : (
            <>
              Drag a plugin folder or a <code>.zip</code> anywhere onto this
              window to install it — or copy it manually into{" "}
              {dir.data ? (
                <code className="text-zinc-300">{dir.data}</code>
              ) : (
                "the plugins folder"
              )}{" "}
              and click <strong className="text-zinc-300">Rescan</strong>.
            </>
          )}
        </span>
      </div>
      {install.isPending && (
        <div className="mt-3 text-xs text-zinc-500">Installing…</div>
      )}
      {installError && (
        <div className="mt-3 rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-300">
          Couldn't install: {installError}
        </div>
      )}
      {entries.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-200">
          Plugins are third-party code. Activating one grants it exactly the
          capabilities listed on its card — which can include reading your
          market data, assets and market orders. Only activate plugins you
          trust.
        </div>
      )}
      {entries.length === 0 ? (
        <Centered>
          No plugins installed yet. Drag a plugin folder or zip onto this window
          to install it.
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
  const [confirmRemove, setConfirmRemove] = useState(false);
  const toggle = useMutation({
    mutationFn: (next: boolean) => pluginSetActive(manifest.id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plugins"] }),
  });
  const remove = useMutation({
    mutationFn: () => pluginsRemove(manifest.id),
    onSuccess: (list) => qc.setQueryData(["plugins"], list),
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
        {manifest.allowedHosts && manifest.allowedHosts.length > 0 ? (
          <div className="mt-1.5 text-xs text-zinc-500">
            Network:{" "}
            <span className="text-zinc-400">
              {manifest.allowedHosts.join(", ")}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <button
          onClick={() => toggle.mutate(!active)}
          disabled={toggle.isPending}
          className={`rounded px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
            active
              ? "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              : "bg-indigo-600 text-white hover:bg-indigo-500"
          }`}
        >
          {active ? "Deactivate" : "Activate"}
        </button>
        {confirmRemove ? (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-500">Remove for good?</span>
            <button
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="rounded border border-rose-800 px-2 py-0.5 text-xs text-rose-300 hover:bg-rose-950 disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmRemove(false)}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmRemove(true)}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-rose-300"
          >
            <Trash2 size={12} />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

/** Collapsible list of scripts whose timed loop is currently armed (from the
 *  Scripts module) — a quick "what's running in the background" check
 *  alongside plugins and the MCP bridge, the app's other always-on
 *  extension points. Collapsed by default; the count in the header stays
 *  visible either way. */
function RunningScriptsCard() {
  const scriptsQ = useQuery({ queryKey: ["scripts"], queryFn: scriptsList });
  const runs = useScriptRuns();
  const [open, setOpen] = useState(false);
  const running = (scriptsQ.data ?? []).filter(
    (s) => s.enabled && s.intervalMin != null,
  );

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2"
      >
        {open ? (
          <ChevronDown size={14} className="text-zinc-500" />
        ) : (
          <ChevronRight size={14} className="text-zinc-500" />
        )}
        <Terminal
          size={15}
          className={running.length > 0 ? "text-emerald-400" : "text-zinc-500"}
        />
        <span className="font-medium text-zinc-100">Running scripts</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
            running.length > 0
              ? "bg-emerald-950 text-emerald-300"
              : "bg-zinc-800 text-zinc-400"
          }`}
        >
          {running.length}
        </span>
      </button>
      {open ? (
        running.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">
            No script has an armed loop. Arm one from{" "}
            <Link to="/scripts" className="text-indigo-400 hover:underline">
              Scripts
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5">
            {running.map((s) => {
              const lastRun = runs[s.id];
              return (
                <li key={s.id}>
                  <Link
                    to="/scripts"
                    className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-sm transition hover:bg-zinc-800/60"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Play size={12} className="shrink-0 text-emerald-400" />
                      <span className="truncate text-zinc-100">{s.name}</span>
                      <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                        {LANGUAGE_LABEL[s.language]}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-zinc-500">
                      every {s.intervalMin}m
                      {lastRun ? (
                        <span
                          className={
                            lastRun.run.ok ? "text-emerald-400" : "text-red-400"
                          }
                        >
                          {" "}
                          • last {lastRun.run.ok ? "ok" : "error"}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** Built-in MCP bridge: a localhost, read-only MCP endpoint for external AI
 *  agents. Off by default; while active it shows the URL + token to copy into
 *  an MCP client. */
function McpBridgeCard() {
  const qc = useQueryClient();
  const { copied, copy } = useCopyToClipboard();
  const status = useQuery({ queryKey: ["mcp"], queryFn: mcpStatus });
  const config = useQuery({ queryKey: ["mcp", "config"], queryFn: mcpConfig });
  const [portInput, setPortInput] = useState("");
  const toggle = useMutation({
    mutationFn: (next: boolean) => (next ? mcpStart() : mcpStop()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp"] }),
  });
  const setPort = useMutation({
    mutationFn: (port: number) => mcpSetPort(port),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp"] }),
  });
  const setAutostart = useMutation({
    mutationFn: (autostart: boolean) => mcpSetAutostart(autostart),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp", "config"] }),
  });
  const setDevTier = useMutation({
    mutationFn: (devTier: boolean) => mcpSetDevTier(devTier),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp", "config"] }),
  });
  const data = status.data;
  const running = data?.running ?? false;
  const configuredPort = config.data?.port ?? 0;
  // Seed the input from the saved port; blank / 0 means "auto".
  const portValue =
    portInput !== "" ? portInput : configuredPort ? String(configuredPort) : "";

  const snippet = data?.url
    ? JSON.stringify(
        {
          mcpServers: {
            "eve-online-tooling": {
              url: data.url,
              headers: { Authorization: `Bearer ${data.token ?? ""}` },
            },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Radio
              size={15}
              className={running ? "text-emerald-400" : "text-zinc-500"}
            />
            <span className="font-medium text-zinc-100">MCP bridge</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                running
                  ? "bg-emerald-950 text-emerald-300"
                  : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {running ? "Active" : "Inactive"}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-xs text-zinc-500">
            Built-in. Serves a read-only, localhost MCP endpoint (item data +
            market prices) to an external AI agent. No character or account data
            is exposed. Off by default.
          </p>
        </div>
        <button
          onClick={() => toggle.mutate(!running)}
          disabled={toggle.isPending}
          className={`shrink-0 rounded px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
            running
              ? "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              : "bg-indigo-600 text-white hover:bg-indigo-500"
          }`}
        >
          {running ? "Deactivate" : "Activate"}
        </button>
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={config.data?.autostart ?? false}
          disabled={setAutostart.isPending}
          onChange={(e) => setAutostart.mutate(e.currentTarget.checked)}
          className="rounded border-zinc-700 bg-zinc-800"
        />
        Start MCP bridge on launch
        <span className="text-zinc-500">
          — also writes a discovery file (URL + token) to the app data directory
          so a local agent can self-configure without copying anything by hand.
        </span>
      </label>

      <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={config.data?.devTier ?? false}
          disabled={setDevTier.isPending}
          onChange={(e) => setDevTier.mutate(e.currentTarget.checked)}
          className="rounded border-zinc-700 bg-zinc-800"
        />
        Expose compute engines to MCP
        <span className="text-zinc-500">
          — adds dev-tier tools (production profit, fitting stats, …) for an
          agent to verify the app's calculations. Still read-only and auth-free;
          off by default.
        </span>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-500">Port</span>
        <input
          type="number"
          value={portValue}
          placeholder="auto"
          onChange={(e) => setPortInput(e.currentTarget.value)}
          className="w-24 rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <button
          onClick={() => setPort.mutate(Number(portValue) || 0)}
          disabled={setPort.isPending}
          className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          Set
        </button>
        <span className="text-zinc-500">
          0 / blank = auto. Changing it restarts a running bridge.
        </span>
      </div>

      {running && data?.url && (
        <div className="mt-3 flex flex-col gap-2 border-t border-zinc-800 pt-3">
          <ConnRow
            label="URL"
            value={data.url}
            onCopy={() => copy(data.url ?? "", "url")}
            copied={copied === "url"}
          />
          <ConnRow
            label="Token"
            value={data.token ?? ""}
            onCopy={() => copy(data.token ?? "", "token")}
            copied={copied === "token"}
          />
          <div className="mt-1">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-zinc-500">
                MCP client config — paste into your agent
              </span>
              <button
                onClick={() => copy(snippet, "snippet")}
                className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                {copied === "snippet" ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="overflow-auto rounded bg-zinc-800 p-2 text-[11px] leading-relaxed text-zinc-300">
              {snippet}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ConnRow({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 shrink-0 text-zinc-500">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-zinc-800 px-2 py-1 text-zinc-300">
        {value}
      </code>
      <button
        onClick={onCopy}
        className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
