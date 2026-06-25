import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  localLogNames,
  localScan,
  localintelGetWatchlist,
  localintelSetWatchlist,
  localintelZkill,
  type LocalPilot,
  type LocalScanResult,
  type ZkillStats,
} from "../../lib/api";
import { formatInt } from "../../lib/format";

/** Best-effort desktop notification — requests permission, never throws. */
async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications unavailable — the in-app highlight still shows */
  }
}

export function LocalIntelPage() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [alertAnyRed, setAlertAnyRed] = useState(true);
  // EVE logs folder (Chatlogs); persisted. Used to prefill names from the
  // newest Local log — only pilots who chatted (logs lack the member list).
  const [logsDir, setLogsDir] = useState(() => localStorage.getItem("eveLogsDir") ?? "");
  const loadLog = useMutation({
    mutationFn: () => localLogNames(logsDir),
    onSuccess: (r) => {
      localStorage.setItem("eveLogsDir", logsDir);
      if (r.senders.length > 0) setText(r.senders.join("\n"));
    },
  });

  const watchlist = useQuery({
    queryKey: ["localintel", "watchlist"],
    queryFn: localintelGetWatchlist,
  });
  const watchIds = useMemo(
    () => new Set((watchlist.data ?? []).map((w) => w.id)),
    [watchlist.data],
  );

  const [zkill, setZkill] = useState<Map<number, ZkillStats>>(new Map());

  const zkillRun = useMutation({
    mutationFn: (ids: number[]) => localintelZkill(ids),
    onSuccess: (stats) => setZkill(new Map(stats.map((s) => [s.characterId, s]))),
  });

  const scan = useMutation({
    mutationFn: (t: string) => localScan(t),
    onSuccess: (res) => {
      setZkill(new Map());
      const ids = res.pilots.map((p) => p.characterId);
      if (ids.length > 0) zkillRun.mutate(ids);
      const watched = res.pilots.filter(
        (p) => watchIds.has(p.corporationId) || (p.allianceId != null && watchIds.has(p.allianceId)),
      );
      if (watched.length > 0) {
        notify(
          "⚠️ Watchlisted pilots in local",
          `${watched.length}: ${watched.slice(0, 5).map((p) => p.name).join(", ")}`,
        );
      } else if (alertAnyRed && res.reds > 0) {
        notify("⚠️ Reds in local", `${res.reds} hostile pilot(s)`);
      }
    },
  });

  const setWatch = useMutation({
    mutationFn: (v: { id: number; name: string; add: boolean }) =>
      localintelSetWatchlist(v.id, v.name, v.add),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["localintel", "watchlist"] }),
  });

  const result = scan.data;
  const isWatched = (p: LocalPilot) =>
    watchIds.has(p.corporationId) || (p.allianceId != null && watchIds.has(p.allianceId));

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Local Intel</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Select-all in the in-game Local member list, copy, and paste it here
            to classify every pilot by corp/alliance and your standing.
          </p>
        </div>
        <button
          onClick={() => scan.mutate(text)}
          disabled={scan.isPending || text.trim() === ""}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {scan.isPending ? "Scanning…" : "Scan local"}
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        placeholder="Paste the Local member list (one pilot name per line)…"
        rows={5}
        className="mt-4 w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <input
          value={logsDir}
          onChange={(e) => setLogsDir(e.currentTarget.value)}
          placeholder="EVE Chatlogs folder…"
          className="w-72 rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none placeholder:text-zinc-600"
          title="e.g. …/ProtonPrefix/drive_c/users/steamuser/Documents/EVE/logs/Chatlogs"
        />
        <button
          onClick={() => loadLog.mutate()}
          disabled={logsDir.trim() === "" || loadLog.isPending}
          className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          Load from latest Local log
        </button>
        {loadLog.isError && <span className="text-rose-400">{String(loadLog.error)}</span>}
        {loadLog.data && (
          <span className="text-zinc-500">
            {loadLog.data.senders.length > 0
              ? `${loadLog.data.senders.length} speaker(s) from ${loadLog.data.file}`
              : "no chat found (only pilots who spoke are logged)"}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-zinc-400">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={alertAnyRed}
            onChange={(e) => setAlertAnyRed(e.currentTarget.checked)}
          />
          Alert on any red
        </label>
        {(watchlist.data ?? []).length > 0 && (
          <span>
            Watching:{" "}
            {(watchlist.data ?? []).map((w) => (
              <button
                key={w.id}
                onClick={() => setWatch.mutate({ id: w.id, name: w.name, add: false })}
                title="Remove from watchlist"
                className="mr-1 rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-300 hover:bg-amber-900/70"
              >
                {w.name} ✕
              </button>
            ))}
          </span>
        )}
      </div>

      {scan.isError && (
        <div className="mt-3 text-sm text-rose-400">Failed: {String(scan.error)}</div>
      )}

      {result && <Summary result={result} />}
      {result && (
        <PilotTable
          pilots={result.pilots}
          zkill={zkill}
          zkillLoading={zkillRun.isPending}
          isWatched={isWatched}
          onWatch={(id, name) => setWatch.mutate({ id, name, add: true })}
        />
      )}
      {result && result.unresolved.length > 0 && (
        <div className="mt-2 text-xs text-zinc-500">
          Unresolved ({result.unresolved.length}): {result.unresolved.join(", ")}
        </div>
      )}
    </div>
  );
}

function Summary({ result }: { result: LocalScanResult }) {
  return (
    <div className="mt-4 flex items-center gap-4 text-sm">
      <span className="text-zinc-300">{formatInt(result.pilots.length)} pilots</span>
      <span className="text-rose-400">{formatInt(result.reds)} red</span>
      <span className="text-zinc-400">{formatInt(result.neutrals)} neutral</span>
      <span className="text-sky-400">{formatInt(result.blues)} blue</span>
    </div>
  );
}

function PilotTable({
  pilots,
  zkill,
  zkillLoading,
  isWatched,
  onWatch,
}: {
  pilots: LocalPilot[];
  zkill: Map<number, ZkillStats>;
  zkillLoading: boolean;
  isWatched: (p: LocalPilot) => boolean;
  onWatch: (id: number, name: string) => void;
}) {
  return (
    <div className="mt-3 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Pilot</th>
            <th className="px-3 py-1.5 text-left font-medium">Corporation</th>
            <th className="px-3 py-1.5 text-left font-medium">Alliance</th>
            <th className="px-3 py-1.5 text-right font-medium">Standing</th>
            <th className="px-3 py-1.5 text-right font-medium">
              Danger{zkillLoading ? " …" : ""}
            </th>
            <th className="px-3 py-1.5 text-right font-medium">Watch</th>
          </tr>
        </thead>
        <tbody>
          {pilots.map((p) => {
            const z = zkill.get(p.characterId);
            return (
            <tr
              key={p.characterId}
              className={`border-t border-zinc-800 hover:bg-zinc-800/40 ${
                isWatched(p) ? "bg-amber-950/30" : ""
              }`}
            >
              <td className="px-3 py-1.5">
                <span className={dot(p.threat)}>●</span>{" "}
                <span className="text-zinc-200">{p.name}</span>
              </td>
              <td className="px-3 py-1.5 text-zinc-400">{p.corporation || "—"}</td>
              <td className="px-3 py-1.5 text-zinc-400">{p.alliance ?? "—"}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums ${standingColor(p.threat)}`}>
                {p.standing == null ? "—" : p.standing.toFixed(1)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {z ? (
                  <span className={dangerColor(z.dangerRatio)} title={`${z.shipsDestroyed} kills / ${z.shipsLost} losses${z.active ? " · recently active" : ""}`}>
                    {z.dangerRatio}%{z.active ? " ⚡" : ""}
                  </span>
                ) : (
                  <span className="text-zinc-600">—</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right text-xs">
                {p.allianceId != null && (
                  <button
                    onClick={() => onWatch(p.allianceId!, p.alliance ?? `Alliance ${p.allianceId}`)}
                    className="mr-1 rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
                    title="Watch this alliance"
                  >
                    +alliance
                  </button>
                )}
                {p.corporationId !== 0 && (
                  <button
                    onClick={() => onWatch(p.corporationId, p.corporation || `Corp ${p.corporationId}`)}
                    className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
                    title="Watch this corporation"
                  >
                    +corp
                  </button>
                )}
              </td>
            </tr>
            );
          })}
          {pilots.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                No pilots resolved.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function dot(threat: string): string {
  if (threat === "red") return "text-rose-500";
  if (threat === "blue") return "text-sky-400";
  return "text-zinc-500";
}
function standingColor(threat: string): string {
  if (threat === "red") return "text-rose-400";
  if (threat === "blue") return "text-sky-400";
  return "text-zinc-400";
}
/** zKill danger ratio → color: high = dangerous (red), low = soft target. */
function dangerColor(danger: number): string {
  if (danger >= 75) return "text-rose-400";
  if (danger >= 40) return "text-amber-400";
  return "text-zinc-400";
}
