import {
  useMemo,
  useRef,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { logStore, type LogEntry } from "../../lib/logStore";
import { logsList, logsClear } from "../../lib/api";
import { LOGS_POLL_INTERVAL_MS } from "../../lib/refreshIntervals";

type Level = "all" | "error" | "warn";
type Source = "all" | "frontend" | "backend";

function fmt(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

const LEVEL_BADGE: Record<string, string> = {
  error: "bg-red-900/60 text-red-300",
  warn: "bg-amber-900/60 text-amber-300",
};

const SOURCE_BADGE: Record<string, string> = {
  frontend: "bg-sky-900/60 text-sky-300",
  backend: "bg-purple-900/60 text-purple-300",
};

export function LogsPage() {
  const qc = useQueryClient();
  const [levelFilter, setLevelFilter] = useState<Level>("all");
  const [sourceFilter, setSourceFilter] = useState<Source>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Frontend entries from the singleton store.
  const frontendEntries = useSyncExternalStore(
    logStore.subscribe,
    logStore.getSnapshot,
  );

  // Backend entries, polled while the page is mounted.
  const { data: backendRaw = [] } = useQuery({
    queryKey: ["logs_list"],
    queryFn: logsList,
    refetchInterval: LOGS_POLL_INTERVAL_MS,
  });

  // Merge and sort by timestamp.
  const all = useMemo<LogEntry[]>(() => {
    const be: LogEntry[] = backendRaw.map((e) => ({
      id: e.id * -1 - 1, // negative ids to avoid collision with frontend ids
      ts: e.ts,
      level: e.level as "error" | "warn",
      source: "backend" as const,
      target: e.target,
      message: e.message,
    }));
    // Frontend store already contains backend events received via Tauri
    // listener; exclude those to avoid duplicating backend entries.
    const fe = frontendEntries.filter((e) => e.source === "frontend");
    return [...fe, ...be].sort((a, b) => a.ts - b.ts);
  }, [frontendEntries, backendRaw]);

  const filtered = useMemo(
    () =>
      all.filter(
        (e) =>
          (levelFilter === "all" || e.level === levelFilter) &&
          (sourceFilter === "all" || e.source === sourceFilter),
      ),
    [all, levelFilter, sourceFilter],
  );

  // Auto-scroll to bottom when new entries arrive.
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [filtered.length, autoScroll]);

  async function handleClearAll() {
    logStore.clear();
    await logsClear();
    qc.setQueryData(["logs_list"], []);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-4 py-2">
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as Level)}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
        >
          <option value="all">All levels</option>
          <option value="error">Error</option>
          <option value="warn">Warn</option>
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as Source)}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
        >
          <option value="all">All sources</option>
          <option value="frontend">Frontend</option>
          <option value="backend">Backend</option>
        </select>
        <span className="text-xs text-zinc-500">{filtered.length} entries</span>
        <div className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="accent-indigo-500"
          />
          Auto-scroll
        </label>
        <button
          onClick={handleClearAll}
          className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          Clear all
        </button>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto font-mono text-xs">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-600">
            No entries.
          </div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {filtered.map((e) => (
                <LogRow key={`${e.source}-${e.id}`} entry={e} />
              ))}
            </tbody>
          </table>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function LogRow({ entry: e }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <tr
      onClick={() => setExpanded((v) => !v)}
      className="cursor-pointer border-b border-zinc-800/50 hover:bg-zinc-800/30"
    >
      <td className="w-20 whitespace-nowrap px-3 py-1 text-zinc-500">
        {fmt(e.ts)}
      </td>
      <td className="w-16 px-1 py-1">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
            LEVEL_BADGE[e.level] ?? ""
          }`}
        >
          {e.level}
        </span>
      </td>
      <td className="w-20 px-1 py-1">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
            SOURCE_BADGE[e.source] ?? ""
          }`}
        >
          {e.source}
        </span>
      </td>
      <td className="max-w-[180px] truncate px-2 py-1 text-zinc-500">
        {e.target.split("::").pop()}
      </td>
      <td className="px-2 py-1">
        {expanded ? (
          <pre className="whitespace-pre-wrap break-all text-zinc-300">
            {e.message}
          </pre>
        ) : (
          <span className="line-clamp-1 text-zinc-300">{e.message}</span>
        )}
      </td>
    </tr>
  );
}
