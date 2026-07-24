import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  whPasteSignatures,
  whSignatures,
  type ConnectionView,
  type Signature,
  type SignatureScan,
  type SystemMatch,
} from "../../lib/api";
import { Field } from "../../components/forms";
import { SystemPicker } from "./shared";

/** Stored signatures for the selected system (loaded on selection, so a
 * chain-node click shows previous scans immediately), plus the paste flow:
 * paste a probe-scanner result → updated list with the added/removed diff.
 * Wormhole sigs referenced by a connection's endpoint sig are marked "linked". */
export function Signatures({
  connections,
  system,
  setSystem,
  onDeleteConnection,
}: {
  connections: ConnectionView[];
  system: SystemMatch | null;
  setSystem: (m: SystemMatch | null) => void;
  onDeleteConnection: (id: number) => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  // The last paste's diff, remembered with its system so switching the
  // selection doesn't badge another system's signatures with a foreign diff.
  const [lastScan, setLastScan] = useState<{
    systemId: number;
    scan: SignatureScan;
  } | null>(null);

  const stored = useQuery({
    queryKey: ["wh", "signatures", system?.id ?? null],
    queryFn: () => whSignatures(system!.id),
    enabled: !!system,
  });
  const paste = useMutation({
    mutationFn: (force: boolean) => whPasteSignatures(system!.id, text, force),
    onSuccess: (scan) => {
      // A held-back destructive paste keeps the textarea so "Replace anyway"
      // can resend the same content with force.
      if (scan.needsConfirmation) return;
      setText("");
      setLastScan({ systemId: system!.id, scan });
      // The paste response *is* the new stored set — no refetch needed.
      qc.setQueryData(["wh", "signatures", system!.id], scan.signatures);
    },
  });

  const signatures: Signature[] = stored.data ?? [];
  const scan =
    system && lastScan?.systemId === system.id ? lastScan.scan : undefined;
  const pending = paste.data?.needsConfirmation ? paste.data : undefined;
  const affected = scan
    ? connections.filter((c) => scan.affectedConnectionIds.includes(c.id))
    : [];

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
          onClick={() => paste.mutate(false)}
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
      {system && (
        <div className="mt-2">
          {pending && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-amber-400">
              <span>
                This paste removes {pending.removed.length} of{" "}
                {signatures.length} stored signature(s) — a filtered or partial
                scanner copy? Nothing was changed.
              </span>
              <button
                onClick={() => paste.mutate(true)}
                className="rounded border border-amber-600 px-2 py-0.5 text-amber-300 hover:bg-amber-950/40"
              >
                Replace anyway
              </button>
            </div>
          )}
          {scan && (scan.added.length > 0 || scan.removed.length > 0) && (
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
            {signatures.map((s) => (
              <SigChip
                key={s.id}
                sig={s}
                fresh={scan?.added.includes(s.id) ?? false}
                linked={linkedSigs.has(s.id)}
              />
            ))}
            {signatures.length === 0 && !stored.isFetching && (
              <span className="text-xs text-zinc-500">
                {scan
                  ? "No signatures parsed."
                  : "No stored signatures for this system — paste a scan."}
              </span>
            )}
          </div>
          {affected.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {affected.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 text-xs text-amber-300"
                >
                  <span>
                    Sig gone — the {c.sourceName} ↔ {c.targetName} hole may have
                    collapsed.
                  </span>
                  <button
                    onClick={() => onDeleteConnection(c.id)}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
                  >
                    Delete connection
                  </button>
                </div>
              ))}
            </div>
          )}
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
