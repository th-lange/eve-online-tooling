import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  whPasteSignatures,
  type ConnectionView,
  type Signature,
  type SignatureScan,
  type SystemMatch,
} from "../../lib/api";
import { Field, SystemPicker } from "./shared";

/** Paste a probe-scanner result for a system → signature list with the
 * added/removed diff; wormhole sigs already referenced by a connection's
 * endpoint sig are marked "linked". */
export function Signatures({
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
