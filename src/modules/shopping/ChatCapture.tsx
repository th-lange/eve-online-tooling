import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { shoppingKeys } from "../../lib/queryKeys";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import { useEveLogDir } from "../../lib/useEveLogDir";
import {
  errorMessage,
  shoppingChatSync,
  type ShoppingList,
} from "../../lib/api";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { SHOPPING_CHAT_POLL_INTERVAL_MS } from "../../lib/refreshIntervals";

// --- Chat capture: listen to an EVE chat channel and collect linked items ---

export function ChatCapture({
  onSync,
  lists,
}: {
  onSync: () => Promise<unknown>;
  lists: ShoppingList[];
}) {
  const [channel, setChannel] = useState("");
  const [logsDir, setLogsDir, persistLogsDir] = useEveLogDir("chatlogs");
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("");
  const [total, setTotal] = useState(0);
  const { copied, copy } = useCopyToClipboard(1500);
  // True until the first poll of a session, so we skip pre-existing log content.
  const fromNow = useRef(false);

  // Where captured items go. Defaults to the built-in Chat list, which we always
  // offer even before it exists (it's created on first import). Persisted.
  const [targetId, setTargetId] = useState(
    () => localStorage.getItem(STORAGE_KEYS.shoppingChatTarget) ?? "chat",
  );
  const targetOptions = useMemo(() => {
    const opts = lists.map((l) => ({ id: l.id, name: l.name }));
    if (!opts.some((o) => o.id === "chat"))
      opts.unshift({ id: "chat", name: "Chat" });
    return opts;
  }, [lists]);
  // If the chosen list was deleted, fall back to Chat.
  useEffect(() => {
    if (!targetOptions.some((o) => o.id === targetId)) setTargetId("chat");
  }, [targetOptions, targetId]);
  // Read inside the poll without resubscribing the interval on every change.
  const targetRef = useRef(targetId);
  useEffect(() => {
    targetRef.current = targetId;
    localStorage.setItem(STORAGE_KEYS.shoppingChatTarget, targetId);
  }, [targetId]);

  // Poll the channel's log while listening — TanStack Query owns the
  // interval lifecycle (auto-cleanup on unmount/disable) instead of a raw
  // `setInterval`.
  const listenEnabled = listening && !!channel.trim() && !!logsDir.trim();
  const sync = useQuery({
    queryKey: shoppingKeys.chatSync(logsDir, channel.trim()),
    queryFn: () => {
      const first = fromNow.current;
      fromNow.current = false;
      return shoppingChatSync(
        logsDir,
        channel.trim(),
        first,
        targetRef.current,
      );
    },
    enabled: listenEnabled,
    refetchInterval: listenEnabled ? SHOPPING_CHAT_POLL_INTERVAL_MS : false,
  });
  useEffect(() => {
    const r = sync.data;
    if (!r) return;
    setStatus(
      r.found
        ? `listening to ${r.file}`
        : "waiting for the channel log (create the channel in EVE)…",
    );
    if (r.added.length) {
      setTotal((t) => t + r.added.length);
      void onSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.data]);
  useEffect(() => {
    if (sync.error) setStatus(errorMessage(sync.error));
  }, [sync.error]);

  function generate() {
    setChannel(`buy-${crypto.randomUUID().slice(0, 8)}`);
  }
  function toggle() {
    if (!listening) {
      persistLogsDir();
      setTotal(0);
      fromNow.current = true;
    }
    setListening((v) => !v);
  }

  return (
    <details className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40">
      <summary className="cursor-pointer px-4 py-2 text-sm text-zinc-300">
        Capture items from an EVE chat channel
      </summary>
      <div className="space-y-3 px-4 pb-4 text-sm">
        <p className="text-xs text-zinc-500">
          Point at any EVE chat channel and each item posted into it is added to
          the list you pick below (the{" "}
          <span className="text-zinc-300">Chat</span> list by default). Make a
          private channel for buy orders, or listen to a standing one like{" "}
          <span className="text-zinc-300">Corp</span>. Paste several items at
          once — <span className="text-zinc-300">one item per line</span>, with
          an optional quantity after the name (
          <span className="text-zinc-300">Tritanium 100</span>, Multibuy
          tab-format works too). Anything that isn't a known item name is
          ignored, and only messages after you press Start are captured. The
          same item re-posted by the same person within a few seconds is treated
          as a duplicate and skipped.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Channel name
            <div className="flex gap-1">
              <input
                value={channel}
                onChange={(e) => setChannel(e.currentTarget.value)}
                placeholder="channel name…"
                disabled={listening}
                className="w-56 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none disabled:opacity-60"
              />
              <button
                onClick={generate}
                disabled={listening}
                title="Generate a random channel name"
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Random
              </button>
              {(["Corp", "Alliance", "Fleet"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setChannel(c)}
                  disabled={listening}
                  title={`Listen to the ${c} channel`}
                  className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  {c}
                </button>
              ))}
              <button
                onClick={() => copy(channel)}
                disabled={!channel}
                title="Copy the channel name"
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Import to
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.currentTarget.value)}
              title="Which list captured items are added to"
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            >
              {targetOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={toggle}
            disabled={!channel.trim() || !logsDir.trim()}
            className={`rounded px-3 py-1.5 text-sm disabled:opacity-40 ${
              listening
                ? "bg-red-600/80 text-white hover:bg-red-600"
                : "bg-sky-600 text-white hover:bg-sky-500"
            }`}
          >
            {listening ? "Stop" : "Start listening"}
          </button>
        </div>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          EVE Chatlogs folder
          <input
            value={logsDir}
            onChange={(e) => setLogsDir(e.currentTarget.value)}
            placeholder="…/EVE/logs/Chatlogs"
            className="w-full max-w-xl rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </label>
        {listening && (
          <div className="text-xs text-zinc-500">
            <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400 align-middle" />
            {status || "starting…"} · {total} item
            {total === 1 ? "" : "s"} captured
          </div>
        )}
      </div>
    </details>
  );
}
