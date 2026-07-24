import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  errorMessage,
  whAddConnection,
  whConnections,
  whDeleteConnection,
  whImportEvescout,
  whTypeReference,
  whUpdateConnection,
  type ConnectionView,
  type SystemMatch,
  type WormholeType,
} from "../../lib/api";
import { maxShipLabel, whTypeByCode } from "./whTypes";
import { ChainGraph } from "./ChainGraph";
import { JumpPlanner } from "./JumpPlanner";
import { SystemReferencePanel, WhTypeTable } from "./Reference";
import { Routing } from "./Routing";
import { Signatures } from "./Signatures";
import { TripwirePanel } from "./TripwirePanel";
import { Field } from "../../components/forms";
import { SystemPicker } from "./shared";
import { MASS, fmtHours, fmtMkg, massColor } from "./helpers";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { SdeGate } from "../../components/SdeGate";

const JUMP = ["s", "m", "l", "xl"];
const SCOPES = ["wormhole", "stargate", "jumpbridge"];

const TITLE = "Wormholes";
const SUBTITLE =
  "Map your chain by hand, or import live Thera/Turnur holes from EVE-Scout. Dead holes (past life / EOL) are pruned automatically.";

export function WormholesPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
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
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <>
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
                {errorMessage(importEvescout.error)}
              </span>
            ) : (
              <span className="text-[11px] text-zinc-500">
                {importedCount > 0
                  ? `${importedCount} imported hole(s)`
                  : "EVE-Scout · free, no login"}
              </span>
            )}
          </>
        }
      />

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
        <PrimaryButton
          onClick={() => add.mutate()}
          disabled={
            !source || !target || source.id === target.id || add.isPending
          }
        >
          Add connection
        </PrimaryButton>
        {add.isError && (
          <span className="text-[11px] text-rose-400">
            {errorMessage(add.error)}
          </span>
        )}
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
        onDeleteConnection={(id) => del.mutate(id)}
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
    </Page>
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
