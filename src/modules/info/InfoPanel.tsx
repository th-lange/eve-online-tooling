import { useContext, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, MessageSquare, Trash2 } from "lucide-react";
import {
  infoList,
  infoClear,
  onInfoEntry,
  type InfoEntry,
} from "../../lib/api";
import { Page, PageHeader, Centered } from "../../components/page";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import { useInfoAlerts } from "./infoContext";

const SUBTITLE =
  "Alarms and messages posted by your scripts and plugins (via send_alarm / write_message). Newest first.";

export function InfoPanel() {
  const qc = useQueryClient();
  // Poll so plugin-posted entries (which don't emit an event) still surface.
  const entries = useQuery({
    queryKey: ["info"],
    queryFn: infoList,
    refetchInterval: 3000,
  });

  // Script-posted entries arrive live — prepend them for a snappy feel.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onInfoEntry((entry) => {
      qc.setQueryData<InfoEntry[]>(["info"], (prev) => [
        entry,
        ...(prev ?? []),
      ]);
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [qc]);

  // Clear the nav badge while this panel is the active view (it stays mounted
  // but hidden otherwise, so only mark seen when actually on screen).
  const active = useContext(ModuleActiveContext);
  const { markSeen } = useInfoAlerts();
  useEffect(() => {
    if (active) markSeen();
  }, [active, entries.data, markSeen]);

  const clear = useMutation({
    mutationFn: infoClear,
    onSuccess: () => qc.setQueryData<InfoEntry[]>(["info"], []),
  });

  const rows = entries.data ?? [];

  return (
    <Page>
      <PageHeader
        title="Info Panel"
        subtitle={SUBTITLE}
        actions={
          rows.length > 0 ? (
            <button
              onClick={() => clear.mutate()}
              disabled={clear.isPending}
              className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-50"
            >
              <Trash2 size={16} /> Clear
            </button>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <Centered>
          Nothing yet. Scripts and plugins post here with{" "}
          <code>send_alarm(text)</code> and <code>write_message(text)</code>.
        </Centered>
      ) : (
        <ul className="mt-4 flex flex-col gap-1.5">
          {rows.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </Page>
  );
}

function EntryRow({ entry }: { entry: InfoEntry }) {
  const alarm = entry.kind === "alarm";
  return (
    <li
      className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${
        alarm
          ? "border-red-900 bg-red-950/30"
          : "border-zinc-800 bg-zinc-900/40"
      }`}
    >
      <span
        className={`mt-0.5 shrink-0 ${alarm ? "text-red-400" : "text-zinc-500"}`}
      >
        {alarm ? <Bell size={16} /> : <MessageSquare size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={`whitespace-pre-wrap break-words text-sm ${
            alarm ? "text-red-200" : "text-zinc-200"
          }`}
        >
          {entry.text}
        </div>
        {entry.detail && (
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950/60 p-2 font-mono text-xs text-zinc-300">
            {entry.detail}
          </pre>
        )}
        <div className="mt-0.5 text-[11px] text-zinc-500">
          {entry.source} · {new Date(entry.at * 1000).toLocaleTimeString()}
        </div>
      </div>
    </li>
  );
}
