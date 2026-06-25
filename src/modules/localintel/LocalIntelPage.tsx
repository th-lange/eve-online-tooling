import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { localScan, type LocalPilot, type LocalScanResult } from "../../lib/api";
import { formatInt } from "../../lib/format";

export function LocalIntelPage() {
  const [text, setText] = useState("");
  const scan = useMutation({ mutationFn: (t: string) => localScan(t) });
  const result = scan.data;

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

      {scan.isError && (
        <div className="mt-3 text-sm text-rose-400">Failed: {String(scan.error)}</div>
      )}

      {result && <Summary result={result} />}
      {result && <PilotTable pilots={result.pilots} />}
      {result && result.unresolved.length > 0 && (
        <div className="mt-2 text-xs text-zinc-500">
          Unresolved ({result.unresolved.length}): {result.unresolved.join(", ")}
        </div>
      )}
    </div>
  );
}

function Summary({ result }: { result: LocalScanResult }) {
  const total = result.pilots.length;
  return (
    <div className="mt-4 flex items-center gap-4 text-sm">
      <span className="text-zinc-300">{formatInt(total)} pilots</span>
      <span className="text-rose-400">{formatInt(result.reds)} red</span>
      <span className="text-zinc-400">{formatInt(result.neutrals)} neutral</span>
      <span className="text-sky-400">{formatInt(result.blues)} blue</span>
    </div>
  );
}

function PilotTable({ pilots }: { pilots: LocalPilot[] }) {
  return (
    <div className="mt-3 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Pilot</th>
            <th className="px-3 py-1.5 text-left font-medium">Corporation</th>
            <th className="px-3 py-1.5 text-left font-medium">Alliance</th>
            <th className="px-3 py-1.5 text-right font-medium">Standing</th>
          </tr>
        </thead>
        <tbody>
          {pilots.map((p) => (
            <tr key={p.characterId} className="border-t border-zinc-800 hover:bg-zinc-800/40">
              <td className="px-3 py-1.5">
                <span className={dot(p.threat)}>●</span>{" "}
                <span className="text-zinc-200">{p.name}</span>
              </td>
              <td className="px-3 py-1.5 text-zinc-400">{p.corporation || "—"}</td>
              <td className="px-3 py-1.5 text-zinc-400">{p.alliance ?? "—"}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums ${standingColor(p.threat)}`}>
                {p.standing == null ? "—" : p.standing.toFixed(1)}
              </td>
            </tr>
          ))}
          {pilots.length === 0 && (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
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
