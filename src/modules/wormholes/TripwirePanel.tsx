import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  errorMessage,
  whTripwireConnect,
  whTripwireDisconnect,
  whTripwireImport,
  whTripwireStatus,
  type ConnectionView,
  type TripwireStatus,
} from "../../lib/api";
import { Field } from "./shared";

/** Opt-in Tripwire import. Inert until connected: shows a connect form, then an
 * import + disconnect control. Credentials live in the OS keychain. */
export function TripwirePanel({
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
              {errorMessage(connect.error)}
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
              {errorMessage(importChain.error)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
