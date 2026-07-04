import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  sdeSearchShips,
  sdeStatus,
  systemSearch,
  whAddConnection,
  whConnections,
  whDeleteConnection,
  whImportEvescout,
  whJumpPlan,
  whPasteSignatures,
  whRoute,
  whSystemReference,
  whTripwireConnect,
  whTripwireDisconnect,
  whTripwireImport,
  whTripwireStatus,
  whTypeReference,
  whUpdateConnection,
  type ConnectionView,
  type IdName,
  type JumpPlan,
  type RouteResult,
  type Signature,
  type SignatureScan,
  type SystemMatch,
  type TripwireStatus,
  type WormholeType,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { maxShipLabel, whTypeByCode } from "./whTypes";
import {
  SystemGraph,
  type SystemGraphEdge,
  type SystemGraphNode,
} from "../../components/SystemGraph";

const MASS = ["fresh", "reduced", "critical"];
const JUMP = ["s", "m", "l", "xl"];
const SCOPES = ["wormhole", "stargate", "jumpbridge"];

export function WormholesPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed)
    return <SdeSetup onInstalled={() => status.refetch()} />;
  return <Workbench />;
}

function Workbench() {
  const qc = useQueryClient();
  const conns = useQuery({
    queryKey: ["wh", "connections"],
    queryFn: whConnections,
  });
  const set = (data: ConnectionView[]) =>
    qc.setQueryData(["wh", "connections"], data);
  // WH type physics are constant per SDE — fetch once and reuse everywhere.
  const whTypes = useQuery({
    queryKey: ["wh", "typeReference"],
    queryFn: whTypeReference,
    staleTime: Infinity,
  });
  const types = whTypes.data ?? [];

  const [source, setSource] = useState<SystemMatch | null>(null);
  const [target, setTarget] = useState<SystemMatch | null>(null);
  // Selected system for the signature panel — a chain-graph node click sets it.
  const [sigSystem, setSigSystem] = useState<SystemMatch | null>(null);
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
    }) =>
      whUpdateConnection(
        v.id,
        v.massStatus,
        v.jumpMass,
        v.eol,
        v.sourceSig,
        v.targetSig,
      ),
    onSuccess: set,
  });
  const del = useMutation({
    mutationFn: (id: number) => whDeleteConnection(id),
    onSuccess: set,
  });
  const importEvescout = useMutation({
    mutationFn: whImportEvescout,
    onSuccess: set,
  });

  const rows = conns.data ?? [];
  const importedCount = rows.filter((c) => c.source === "evescout").length;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Wormholes</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Map your chain by hand, or import live Thera/Turnur holes from
            EVE-Scout. Dead holes (past life / EOL) are pruned automatically.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={() => importEvescout.mutate()}
            disabled={importEvescout.isPending}
            title="Fetch the live public Thera & Turnur connections from EVE-Scout"
            className="whitespace-nowrap rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-600 disabled:opacity-50"
          >
            {importEvescout.isPending ? "Importing…" : "Import Thera/Turnur"}
          </button>
          {importEvescout.isError ? (
            <span className="max-w-56 text-right text-[11px] text-rose-400">
              {String(importEvescout.error)}
            </span>
          ) : (
            <span className="text-[11px] text-zinc-500">
              {importedCount > 0
                ? `${importedCount} imported hole(s)`
                : "EVE-Scout · free, no login"}
            </span>
          )}
        </div>
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
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Add connection
        </button>
        <div className="flex w-full flex-wrap gap-4">
          <WhSigHint label="From sig" code={srcSig} types={types} />
          <WhSigHint label="To sig" code={tgtSig} types={types} />
        </div>
      </div>

      <TripwirePanel onImported={set} />

      <ChainGraph
        rows={rows}
        onSelectSystem={(id, name) => setSigSystem({ id, name })}
      />

      <Routing />

      <JumpPlanner />

      {sigSystem && <SystemReferencePanel system={sigSystem} />}

      <Signatures
        connections={rows}
        system={sigSystem}
        setSystem={setSigSystem}
      />

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
                  <SystemTag
                    name={c.sourceName}
                    wspace={c.sourceWspace}
                    sig={c.sourceSig}
                  />
                  <span className="mx-1 text-zinc-600">↔</span>
                  <SystemTag
                    name={c.targetName}
                    wspace={c.targetWspace}
                    sig={c.targetSig}
                  />
                  <SourceBadge source={c.source} />
                </td>
                <td className="px-3 py-1.5 text-zinc-400">{c.scope}</td>
                <td className="px-3 py-1.5">
                  {c.scope === "wormhole" ? (
                    <select
                      value={c.massStatus}
                      onChange={(e) =>
                        update.mutate({
                          ...editArgs(c),
                          massStatus: e.currentTarget.value,
                        })
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
                        update.mutate({
                          ...editArgs(c),
                          jumpMass: e.currentTarget.value,
                        })
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
                      onChange={(e) =>
                        update.mutate({
                          ...editArgs(c),
                          eol: e.currentTarget.checked,
                        })
                      }
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

      <WhTypeTable types={types} />
    </div>
  );
}

/** Paste a probe-scanner result for a system → signature list with the
 * added/removed diff; wormhole sigs already referenced by a connection's
 * endpoint sig are marked "linked". */
function Signatures({
  connections,
  system,
  setSystem,
}: {
  connections: ConnectionView[];
  system: SystemMatch | null;
  setSystem: (m: SystemMatch | null) => void;
}) {
  const [text, setText] = useState("");
  const paste = useMutation({
    mutationFn: () => whPasteSignatures(system!.id, text),
    onSuccess: () => setText(""),
  });
  const scan: SignatureScan | undefined = paste.data;

  // A sig is "linked" if its id is used as a connection endpoint sig.
  const linkedSigs = new Set(
    connections.flatMap(
      (c) => [c.sourceSig, c.targetSig].filter(Boolean) as string[],
    ),
  );

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-sm font-semibold text-zinc-300">Signatures</span>
        <Field label="System">
          <SystemPicker picked={system} onPick={setSystem} />
        </Field>
        <button
          onClick={() => paste.mutate()}
          disabled={!system || text.trim() === "" || paste.isPending}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Update signatures
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        placeholder="Paste the in-game probe-scanner result (select all in the scanner → copy)…"
        rows={3}
        className="mt-2 w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
      />
      {scan && (
        <div className="mt-2">
          {(scan.added.length > 0 || scan.removed.length > 0) && (
            <div className="mb-2 text-xs">
              {scan.added.length > 0 && (
                <span className="text-emerald-400">
                  +{scan.added.length} new{" "}
                </span>
              )}
              {scan.removed.length > 0 && (
                <span className="text-rose-400">
                  −{scan.removed.length} gone
                </span>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {scan.signatures.map((s) => (
              <SigChip
                key={s.id}
                sig={s}
                fresh={scan.added.includes(s.id)}
                linked={linkedSigs.has(s.id)}
              />
            ))}
            {scan.signatures.length === 0 && (
              <span className="text-xs text-zinc-500">
                No signatures parsed.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SigChip({
  sig,
  fresh,
  linked,
}: {
  sig: Signature;
  fresh: boolean;
  linked: boolean;
}) {
  const isWh = sig.sigType.toLowerCase() === "wormhole";
  return (
    <span
      className={`rounded border px-2 py-0.5 text-xs ${
        fresh
          ? "border-emerald-600"
          : isWh
            ? "border-purple-700"
            : "border-zinc-700"
      } bg-zinc-900`}
      title={`${sig.group}${sig.name ? " · " + sig.name : ""}`}
    >
      <span className="text-zinc-300">{sig.id}</span>
      {sig.sigType && (
        <span className={`ml-1 ${isWh ? "text-purple-300" : "text-zinc-500"}`}>
          {sig.sigType}
        </span>
      )}
      {isWh && linked && (
        <span className="ml-1 text-emerald-400" title="Linked to a connection">
          🔗
        </span>
      )}
    </span>
  );
}

/** Badge for an auto-imported connection's source (manual rows get none). */
function SourceBadge({ source }: { source: string }) {
  if (source === "evescout") {
    return (
      <span
        className="ml-2 rounded border border-teal-700 bg-teal-950/40 px-1.5 py-0.5 text-[10px] text-teal-300"
        title="Auto-imported from the EVE-Scout Thera/Turnur feed"
      >
        EVE-Scout
      </span>
    );
  }
  if (source === "tripwire") {
    return (
      <span
        className="ml-2 rounded border border-sky-700 bg-sky-950/40 px-1.5 py-0.5 text-[10px] text-sky-300"
        title="Imported from your Tripwire chain"
      >
        Tripwire
      </span>
    );
  }
  return null;
}

/** Opt-in Tripwire import. Inert until connected: shows a connect form, then an
 * import + disconnect control. Credentials live in the OS keychain. */
function TripwirePanel({
  onImported,
}: {
  onImported: (data: ConnectionView[]) => void;
}) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["wh", "tripwireStatus"],
    queryFn: whTripwireStatus,
  });
  const setStatus = (s: TripwireStatus) =>
    qc.setQueryData(["wh", "tripwireStatus"], s);

  const [baseUrl, setBaseUrl] = useState("https://tripwire.eve-apps.com");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mask, setMask] = useState("");

  const connect = useMutation({
    mutationFn: () =>
      whTripwireConnect(
        baseUrl.trim(),
        username.trim(),
        password,
        mask.trim() || null,
      ),
    onSuccess: (s) => {
      setStatus(s);
      setPassword("");
    },
  });
  const disconnect = useMutation({
    mutationFn: whTripwireDisconnect,
    onSuccess: setStatus,
  });
  const importChain = useMutation({
    mutationFn: whTripwireImport,
    onSuccess: onImported,
  });

  const s = status.data;
  if (!s) return null;

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-zinc-300">Tripwire</span>
        <span className="text-[11px] text-zinc-500">
          optional · import your collaborative chain (Basic Auth, stored in the
          OS keychain)
        </span>
      </div>

      {!s.configured ? (
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <Field label="Instance URL">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
              className="w-56 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            />
          </Field>
          <Field label="Username">
            <input
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              className="w-32 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              className="w-32 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            />
          </Field>
          <Field label="Mask (optional)">
            <input
              value={mask}
              onChange={(e) => setMask(e.currentTarget.value)}
              placeholder="personal"
              className="w-28 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </Field>
          <button
            onClick={() => connect.mutate()}
            disabled={!username.trim() || !password || connect.isPending}
            className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {connect.isPending ? "Connecting…" : "Connect"}
          </button>
          {connect.isError && (
            <span className="text-[11px] text-rose-400">
              {String(connect.error)}
            </span>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-xs text-zinc-400">
            Connected as <span className="text-zinc-200">{s.username}</span>
            <span className="text-zinc-600"> @ {s.baseUrl}</span>
            {s.mask ? (
              <span className="text-zinc-600"> · mask {s.mask}</span>
            ) : (
              <span className="text-zinc-600"> · personal mask</span>
            )}
          </span>
          <button
            onClick={() => importChain.mutate()}
            disabled={importChain.isPending}
            className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {importChain.isPending ? "Importing…" : "Import from Tripwire"}
          </button>
          <button
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Disconnect
          </button>
          {importChain.isError && (
            <span className="max-w-sm text-[11px] text-rose-400">
              {String(importChain.error)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Wormhole edge colour by mass status (fresh → reduced → critical). */
function massEdgeColor(mass: string): string {
  if (mass === "critical") return "#f43f5e";
  if (mass === "reduced") return "#f59e0b";
  return "#a855f7";
}

/** The two special EVE-Scout hub systems → a distinctive node colour. Thera is
 * the shattered wormhole hub; Turnur is its lowsec counterpart. */
const SPECIAL_HUBS: Record<string, string> = {
  Thera: "#2dd4bf", // teal
  Turnur: "#e879f9", // fuchsia
};

/** Interactive node-edge view of the mapped chain. Click a node to load its
 * signatures below. Complements the flat table (kept as the edit pane). */
function ChainGraph({
  rows,
  onSelectSystem,
}: {
  rows: ConnectionView[];
  onSelectSystem: (id: number, name: string) => void;
}) {
  const nodeMap = new Map<number, SystemGraphNode>();
  const addNode = (id: number, name: string, wspace: boolean) => {
    if (!nodeMap.has(id)) {
      const special = SPECIAL_HUBS[name];
      nodeMap.set(id, {
        id: String(id),
        label: name,
        kind: wspace ? "wspace" : "unknown",
        ...(special && { fill: special, sub: "EVE-Scout hub" }),
      });
    }
  };
  rows.forEach((c) => {
    addNode(c.sourceSystemId, c.sourceName, c.sourceWspace);
    addNode(c.targetSystemId, c.targetName, c.targetWspace);
  });
  const edges: SystemGraphEdge[] = rows.map((c) => ({
    source: String(c.sourceSystemId),
    target: String(c.targetSystemId),
    variant: c.scope === "wormhole" ? "wormhole" : "stargate",
    dashed: c.eol,
    color: c.scope === "wormhole" ? massEdgeColor(c.massStatus) : undefined,
    label:
      c.scope === "wormhole" && c.massStatus !== "fresh"
        ? c.massStatus
        : undefined,
  }));
  const nodes = [...nodeMap.values()];

  if (nodes.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center gap-3 text-[11px] uppercase tracking-wide text-zinc-500">
        <span>Chain map</span>
        <span className="normal-case tracking-normal text-zinc-600">
          click a system for its signatures · drag to rearrange (saved) · dashed
          = EOL · purple = wormhole ·{" "}
          <span style={{ color: SPECIAL_HUBS.Thera }}>teal = Thera</span> ·{" "}
          <span style={{ color: SPECIAL_HUBS.Turnur }}>pink = Turnur</span>
        </span>
      </div>
      <SystemGraph
        nodes={nodes}
        edges={edges}
        storageKey="wh-chain"
        onNodeClick={(id) => {
          const n = nodeMap.get(Number(id));
          if (n) onSelectSystem(Number(id), n.label);
        }}
      />
    </div>
  );
}

/** Format a mass in kg as millions-of-kg (the scale WH physics live at). */
function fmtMkg(kg: number): string {
  return `${(kg / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} Mkg`;
}

/** Ship-mass jump planner: can this hull pass this hole, and how many crossings
 * remain? Physics come from the bundled SDE (offline). */
function JumpPlanner() {
  const [ship, setShip] = useState<IdName | null>(null);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("fresh");
  const plan = useMutation({
    mutationFn: () => whJumpPlan(ship!.id, code.trim(), status),
  });
  const r: JumpPlan | undefined = plan.data;

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-sm font-semibold text-zinc-300">
          Jump planner
        </span>
        <Field label="Ship">
          <ShipPicker picked={ship} onPick={setShip} />
        </Field>
        <Field label="WH type">
          <input
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
            placeholder="N766"
            className="w-24 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </Field>
        <Field label="Mass">
          <select
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
            className={`rounded bg-zinc-800 px-2 py-1 text-sm outline-none ${massColor(status)}`}
          >
            {MASS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <button
          onClick={() => plan.mutate()}
          disabled={!ship || code.trim() === "" || plan.isPending}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Plan jump
        </button>
      </div>

      {plan.isError && (
        <div className="mt-2 text-xs text-rose-400">{String(plan.error)}</div>
      )}

      {r && !r.found && (
        <div className="mt-2 text-sm text-zinc-400">{r.message}</div>
      )}

      {r && r.found && (
        <div className="mt-3 text-sm">
          {!r.passes ? (
            <div className="text-rose-400">
              ❌ <span className="text-zinc-200">{r.shipName}</span> (
              {fmtMkg(r.shipMass)}) exceeds{" "}
              <span className="text-zinc-200">{r.whCode}</span> max jump mass (
              {fmtMkg(r.maxJumpMass)}).
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div
                className={r.critRisk ? "text-amber-300" : "text-emerald-300"}
              >
                {r.critRisk ? "⚠️" : "✅"}{" "}
                <span className="text-zinc-200">{r.shipName}</span> passes{" "}
                <span className="text-zinc-200">{r.whCode}</span>
                <span className="text-zinc-500"> → {r.destClassLabel}</span> · ~
                <span className="text-zinc-100">{r.remainingCrossings}</span>{" "}
                crossing
                {r.remainingCrossings === 1 ? "" : "s"} left
                {r.critRisk && (
                  <span className="text-amber-300">
                    {" "}
                    · next jump risks critical
                  </span>
                )}
              </div>
              {/* Mass budget bar: green up to critical, amber for the last <10% band. */}
              <div className="flex h-2 w-64 overflow-hidden rounded bg-zinc-800">
                <div
                  className="bg-emerald-600"
                  style={{
                    width: `${Math.min(100, r.remainingCrossings === 0 ? 0 : (r.crossingsUntilCritical / r.remainingCrossings) * 100)}%`,
                  }}
                />
                <div className="flex-1 bg-amber-600" />
              </div>
              <div className="text-[11px] text-zinc-500">
                {r.crossingsUntilCritical} before critical · hole total{" "}
                {fmtMkg(r.maxStableMass)} · jump limit {fmtMkg(r.maxJumpMass)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Ship search picker (mirrors SystemPicker, backed by the SDE ship search). */
function ShipPicker({
  picked,
  onPick,
}: {
  picked: IdName | null;
  onPick: (m: IdName | null) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useQuery({
    queryKey: ["wh", "shipSearch", query],
    queryFn: () => sdeSearchShips(query),
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
        placeholder="Ship…"
        className="w-40 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
      />
      {!picked &&
        query.trim().length >= 2 &&
        (matches.data?.length ?? 0) > 0 && (
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

/** Hours label from minutes. */
function fmtHours(min: number | null): string {
  return min == null ? "—" : `${(min / 60).toFixed(0)}h`;
}

/** Inline hint under a sig-code field: if it names a known wormhole type, show
 * its destination class, max ship, total mass and lifetime (K162 → exit). */
function WhSigHint({
  label,
  code,
  types,
}: {
  label: string;
  code: string;
  types: WormholeType[];
}) {
  const t = whTypeByCode(code, types);
  if (!t) return null;
  return (
    <span className="text-[11px] text-zinc-400">
      <span className="text-zinc-500">{label}:</span>{" "}
      <span className="text-teal-300">{t.code}</span>
      {" → "}
      {t.destClassLabel} · max {maxShipLabel(t.maxJumpMass)}
      {t.maxStableMass != null && <> · {fmtMkg(t.maxStableMass)} total</>}
      {t.maxStableTimeMin != null && <> · {fmtHours(t.maxStableTimeMin)}</>}
    </span>
  );
}

/** Class / effect / statics for a selected system (Anoik.is snapshot + SDE
 * physics). Renders only when the system is classified or in the snapshot. */
function SystemReferencePanel({ system }: { system: SystemMatch }) {
  const ref = useQuery({
    queryKey: ["wh", "systemRef", system.id],
    queryFn: () => whSystemReference(system.id),
    staleTime: Infinity,
  });
  const r = ref.data;
  if (!r || (!r.found && r.class == null)) return null;
  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-300">
          {system.name}
        </span>
        {r.classLabel && (
          <span className="rounded border border-purple-700 bg-purple-950/40 px-1.5 py-0.5 text-xs text-purple-200">
            {r.classLabel}
          </span>
        )}
        {r.effect && (
          <span className="rounded border border-amber-700 bg-amber-950/30 px-1.5 py-0.5 text-xs text-amber-200">
            {r.effect}
          </span>
        )}
        {!r.found && (
          <span className="text-[11px] text-zinc-500">
            not in statics snapshot
          </span>
        )}
      </div>
      {r.statics.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">
            Statics
          </div>
          <div className="flex flex-wrap gap-2">
            {r.statics.map((s) => (
              <span
                key={s.code}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs"
                title={`${s.code} → ${s.destClassLabel}${s.maxStableMass != null ? ` · ${fmtMkg(s.maxStableMass)} total` : ""}`}
              >
                <span className="text-teal-300">{s.code}</span>
                <span className="text-zinc-500"> → {s.destClassLabel}</span>
                <span className="text-zinc-500">
                  {" "}
                  · max {maxShipLabel(s.maxJumpMass)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Browsable wormhole-type reference (the offline whtype.info clone). */
function WhTypeTable({ types }: { types: WormholeType[] }) {
  const [open, setOpen] = useState(false);
  if (types.length === 0) return null;
  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium text-zinc-400 hover:text-zinc-200"
      >
        {open ? "▾" : "▸"} Wormhole types ({types.length})
      </button>
      {open && (
        <div className="mt-2 max-h-96 overflow-auto rounded border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Code</th>
                <th className="px-3 py-1.5 text-left font-medium">Dest</th>
                <th className="px-3 py-1.5 text-left font-medium">Max ship</th>
                <th className="px-3 py-1.5 text-right font-medium">Max jump</th>
                <th className="px-3 py-1.5 text-right font-medium">
                  Total mass
                </th>
                <th className="px-3 py-1.5 text-right font-medium">Life</th>
                <th className="px-3 py-1.5 text-right font-medium">Regen</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr
                  key={t.typeId}
                  className="border-t border-zinc-800 text-zinc-300"
                >
                  <td className="px-3 py-1 text-teal-300">{t.code}</td>
                  <td className="px-3 py-1 text-zinc-400">
                    {t.destClassLabel}
                  </td>
                  <td className="px-3 py-1 text-zinc-400">
                    {maxShipLabel(t.maxJumpMass)}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {t.maxJumpMass != null ? fmtMkg(t.maxJumpMass) : "—"}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {t.maxStableMass != null ? fmtMkg(t.maxStableMass) : "—"}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {fmtHours(t.maxStableTimeMin)}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">
                    {t.massRegen != null ? fmtMkg(t.massRegen) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Route between two systems over stargates ∪ mapped wormhole connections. */
function Routing() {
  const [origin, setOrigin] = useState<SystemMatch | null>(null);
  const [dest, setDest] = useState<SystemMatch | null>(null);
  const [avoidEol, setAvoidEol] = useState(true);
  const route = useMutation({
    mutationFn: () => whRoute(origin!.id, dest!.id, avoidEol),
  });
  const r: RouteResult | undefined = route.data;

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <span className="text-sm font-semibold text-zinc-300">Route</span>
        <Field label="From">
          <SystemPicker picked={origin} onPick={setOrigin} />
        </Field>
        <Field label="To">
          <SystemPicker picked={dest} onPick={setDest} />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={avoidEol}
            onChange={(e) => setAvoidEol(e.currentTarget.checked)}
          />
          Avoid EOL holes
        </label>
        <button
          onClick={() => route.mutate()}
          disabled={!origin || !dest || route.isPending}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Find route
        </button>
      </div>
      {r && !r.reachable && (
        <div className="mt-2 text-sm text-rose-400">
          No route found (try without "avoid EOL").
        </div>
      )}
      {r && r.reachable && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-zinc-500">
            {r.jumps} jump{r.jumps === 1 ? "" : "s"}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {r.hops.map((h, i) => (
              <span
                key={`${h.systemId}-${i}`}
                className="flex items-center gap-1"
              >
                {i > 0 && (
                  <span
                    className={
                      h.via === "wormhole" ? "text-purple-400" : "text-zinc-600"
                    }
                  >
                    {h.via === "wormhole" ? "⤳" : "→"}
                  </span>
                )}
                <span
                  className={`rounded border px-2 py-0.5 text-xs ${
                    h.wspace
                      ? "border-purple-700 bg-purple-950/40"
                      : "border-zinc-700 bg-zinc-900"
                  }`}
                  title={h.via}
                >
                  {h.wspace ? (
                    <span className="text-purple-300">{h.name}</span>
                  ) : (
                    <>
                      <span className={massColorSec(h.security)}>
                        {h.security.toFixed(1)}
                      </span>{" "}
                      <span className="text-zinc-200">{h.name}</span>
                    </>
                  )}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function massColorSec(sec: number): string {
  if (sec >= 0.5) return "text-emerald-400";
  if (sec > 0.0) return "text-amber-400";
  return "text-rose-400";
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
      {!picked &&
        query.trim().length >= 2 &&
        (matches.data?.length ?? 0) > 0 && (
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
  return (
    <div className="p-10 text-center text-sm text-zinc-500">{children}</div>
  );
}
