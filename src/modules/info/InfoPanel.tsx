import { useContext, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronRight, MessageSquare, Trash2 } from "lucide-react";
import {
  infoList,
  infoClear,
  infoClearSource,
  onInfoEntry,
  type InfoEntry,
} from "../../lib/api";
import { Page, PageHeader, Centered } from "../../components/page";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import { useInfoAlerts } from "./infoContext";

const SUBTITLE =
  "Alarms and messages posted by your scripts and plugins (via send_alarm / write_message). Each source gets its own segment, newest first.";

/** Group entries (already newest-first) by `source`, preserving first-seen
 * (i.e. most-recently-active) source order. */
function groupBySource(rows: InfoEntry[]): [string, InfoEntry[]][] {
  const groups = new Map<string, InfoEntry[]>();
  for (const entry of rows) {
    const existing = groups.get(entry.source);
    if (existing) existing.push(entry);
    else groups.set(entry.source, [entry]);
  }
  return [...groups.entries()];
}

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

  const clearSource = useMutation({
    mutationFn: infoClearSource,
    onSuccess: (_void, source) =>
      qc.setQueryData<InfoEntry[]>(["info"], (prev) =>
        (prev ?? []).filter((e) => e.source !== source),
      ),
  });

  const rows = entries.data ?? [];
  const groups = groupBySource(rows);

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
              <Trash2 size={16} /> Clear all
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
        <ul className="mt-4 flex flex-col gap-2">
          {groups.map(([source, sourceEntries]) => (
            <SourceSegment
              key={source}
              source={source}
              entries={sourceEntries}
              onClear={() => clearSource.mutate(source)}
              clearing={
                clearSource.isPending && clearSource.variables === source
              }
            />
          ))}
        </ul>
      )}
    </Page>
  );
}

function SourceSegment({
  source,
  entries,
  onClear,
  clearing,
}: {
  source: string;
  entries: InfoEntry[];
  onClear: () => void;
  clearing: boolean;
}) {
  const [open, setOpen] = useState(true);
  const hasAlarm = entries.some((e) => e.kind === "alarm");
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/20">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-zinc-200"
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={`shrink-0 text-zinc-500 transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
          {hasAlarm && (
            <Bell size={14} aria-hidden className="shrink-0 text-red-400" />
          )}
          <span className="truncate">{source}</span>
          <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 text-[11px] text-zinc-400">
            {entries.length}
          </span>
        </button>
        <button
          onClick={onClear}
          disabled={clearing}
          title={`Clear ${source}`}
          aria-label={`Clear ${source}`}
          className="shrink-0 rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {open && (
        <ul className="flex flex-col gap-1.5 px-3 pb-3">
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </li>
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
