import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  sdeStatus,
  systemSearch,
  whAddConnection,
  whConnections,
  whDeleteConnection,
  whUpdateConnection,
  type ConnectionView,
  type SystemMatch,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";

const MASS = ["fresh", "reduced", "critical"];
const JUMP = ["s", "m", "l", "xl"];
const SCOPES = ["wormhole", "stargate", "jumpbridge"];

export function WormholesPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) return <SdeSetup onInstalled={() => status.refetch()} />;
  return <Workbench />;
}

function Workbench() {
  const qc = useQueryClient();
  const conns = useQuery({ queryKey: ["wh", "connections"], queryFn: whConnections });
  const set = (data: ConnectionView[]) => qc.setQueryData(["wh", "connections"], data);

  const [source, setSource] = useState<SystemMatch | null>(null);
  const [target, setTarget] = useState<SystemMatch | null>(null);
  const [scope, setScope] = useState("wormhole");
  const [srcSig, setSrcSig] = useState("");
  const [tgtSig, setTgtSig] = useState("");

  const add = useMutation({
    mutationFn: () =>
      whAddConnection({
        sourceSystemId: source!.id,
        targetSystemId: target!.id,
        scope,
        sourceSig: srcSig || null,
        targetSig: tgtSig || null,
      }),
    onSuccess: (data) => {
      set(data);
      setSource(null);
      setTarget(null);
      setSrcSig("");
      setTgtSig("");
    },
  });
  const update = useMutation({
    mutationFn: (v: {
      id: number;
      massStatus: string;
      jumpMass: string;
      eol: boolean;
      sourceSig: string | null;
      targetSig: string | null;
    }) => whUpdateConnection(v.id, v.massStatus, v.jumpMass, v.eol, v.sourceSig, v.targetSig),
    onSuccess: set,
  });
  const del = useMutation({ mutationFn: (id: number) => whDeleteConnection(id), onSuccess: set });

  const rows = conns.data ?? [];

  return (
    <div className="p-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-100">Wormholes</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Map your chain by hand — wormhole connections aren't in any API. Dead
          holes (past life / EOL) are pruned automatically.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded border border-zinc-800 bg-zinc-900 p-3">
        <Field label="From">
          <SystemPicker picked={source} onPick={setSource} />
        </Field>
        <Field label="To">
          <SystemPicker picked={target} onPick={setTarget} />
        </Field>
        <Field label="Scope">
          <select
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value)}
            className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From sig">
          <input
            value={srcSig}
            onChange={(e) => setSrcSig(e.currentTarget.value)}
            placeholder="ABC"
            className="w-20 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </Field>
        <Field label="To sig">
          <input
            value={tgtSig}
            onChange={(e) => setTgtSig(e.currentTarget.value)}
            placeholder="K162"
            className="w-20 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </Field>
        <button
          onClick={() => add.mutate()}
          disabled={!source || !target || add.isPending}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          Add connection
        </button>
      </div>

      <div className="mt-4 overflow-auto rounded border border-zinc-800">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Connection</th>
              <th className="px-3 py-1.5 text-left font-medium">Scope</th>
              <th className="px-3 py-1.5 text-left font-medium">Mass</th>
              <th className="px-3 py-1.5 text-left font-medium">Max ship</th>
              <th className="px-3 py-1.5 text-center font-medium">EOL</th>
              <th className="px-3 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.id}
                className={`border-t border-zinc-800 ${c.eol ? "bg-rose-950/20" : ""}`}
              >
                <td className="px-3 py-1.5">
                  <SystemTag name={c.sourceName} wspace={c.sourceWspace} sig={c.sourceSig} />
                  <span className="mx-1 text-zinc-600">↔</span>
                  <SystemTag name={c.targetName} wspace={c.targetWspace} sig={c.targetSig} />
                </td>
                <td className="px-3 py-1.5 text-zinc-400">{c.scope}</td>
                <td className="px-3 py-1.5">
                  {c.scope === "wormhole" ? (
                    <select
                      value={c.massStatus}
                      onChange={(e) =>
                        update.mutate({ ...editArgs(c), massStatus: e.currentTarget.value })
                      }
                      className={`rounded bg-zinc-800 px-1 py-0.5 text-xs outline-none ${massColor(c.massStatus)}`}
                    >
                      {MASS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  {c.scope === "wormhole" ? (
                    <select
                      value={c.jumpMass}
                      onChange={(e) =>
                        update.mutate({ ...editArgs(c), jumpMass: e.currentTarget.value })
                      }
                      className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-200 outline-none"
                    >
                      {JUMP.map((j) => (
                        <option key={j} value={j}>
                          {j.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-center">
                  {c.scope === "wormhole" && (
                    <input
                      type="checkbox"
                      checked={c.eol}
                      onChange={(e) => update.mutate({ ...editArgs(c), eol: e.currentTarget.checked })}
                    />
                  )}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button
                    onClick={() => del.mutate(c.id)}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  No connections — add one above as you scan your chain.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Current edit fields for a connection (so a single change keeps the rest). */
function editArgs(c: ConnectionView) {
  return {
    id: c.id,
    massStatus: c.massStatus,
    jumpMass: c.jumpMass,
    eol: c.eol,
    sourceSig: c.sourceSig,
    targetSig: c.targetSig,
  };
}

function SystemTag({
  name,
  wspace,
  sig,
}: {
  name: string;
  wspace: boolean;
  sig: string | null;
}) {
  return (
    <span className={wspace ? "text-purple-300" : "text-zinc-200"}>
      {name}
      {sig && <span className="ml-1 text-[10px] text-zinc-500">{sig}</span>}
    </span>
  );
}

function SystemPicker({
  picked,
  onPick,
}: {
  picked: SystemMatch | null;
  onPick: (m: SystemMatch | null) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useQuery({
    queryKey: ["wh", "systemSearch", query],
    queryFn: () => systemSearch(query),
    enabled: query.trim().length >= 2 && !picked,
  });
  return (
    <div className="relative">
      <input
        value={picked ? picked.name : query}
        onChange={(e) => {
          onPick(null);
          setQuery(e.currentTarget.value);
        }}
        placeholder="System…"
        className="w-40 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
      />
      {!picked && query.trim().length >= 2 && (matches.data?.length ?? 0) > 0 && (
        <div className="absolute z-10 mt-1 max-h-48 w-40 overflow-auto rounded border border-zinc-700 bg-zinc-900 shadow-lg">
          {matches.data!.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                onPick(m);
                setQuery("");
              }}
              className="block w-full px-2 py-1 text-left text-sm text-zinc-200 hover:bg-zinc-800"
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function massColor(m: string): string {
  if (m === "critical") return "text-rose-400";
  if (m === "reduced") return "text-amber-400";
  return "text-emerald-400";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      {children}
    </label>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="p-10 text-center text-sm text-zinc-500">{children}</div>;
}
