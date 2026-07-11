import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  errorMessage,
  isAuthRequired,
  notifications,
  notificationDismiss,
  notificationsReset,
  type NotifRow,
} from "../../lib/api";

const CATEGORY_STYLE: Record<string, string> = {
  War: "bg-rose-500/15 text-rose-300",
  Sovereignty: "bg-fuchsia-500/15 text-fuchsia-300",
  Structure: "bg-amber-500/15 text-amber-300",
  Industry: "bg-sky-500/15 text-sky-300",
  Wallet: "bg-emerald-500/15 text-emerald-300",
  Corp: "bg-violet-500/15 text-violet-300",
  Other: "bg-zinc-700/40 text-zinc-300",
};

// The character's in-game notification feed — war decs, structure attacks,
// industry/PI and wallet events — categorised, filterable, and dismissable.
export function NotificationsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: notifications,
    staleTime: 5 * 60_000,
  });
  const [cat, setCat] = useState<string>("All");

  const dismiss = useMutation({
    mutationFn: notificationDismiss,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const reset = useMutation({
    mutationFn: notificationsReset,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const n of q.data ?? []) seen.add(n.category);
    return ["All", ...[...seen].sort()];
  }, [q.data]);

  const rows = (q.data ?? []).filter(
    (n) => cat === "All" || n.category === cat,
  );
  const unread = (q.data ?? []).filter((n) => !n.isRead).length;
  const multiCharacter = new Set((q.data ?? []).map((n) => n.characterId)).size > 1;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">
            Notifications
            {unread > 0 && (
              <span className="ml-2 rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white align-middle">
                {unread} new
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Your in-game notification feed — war decs, structure attacks,
            industry and wallet events.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => reset.mutate()}
            disabled={reset.isPending}
            title="Un-hide every dismissed notification"
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Restore dismissed
          </button>
          <button
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {q.isFetching ? "Syncing…" : "Refresh"}
          </button>
        </div>
      </div>

      {q.isError &&
        (isAuthRequired(q.error) ? (
          <div className="mt-3 text-sm text-zinc-400">
            Log in a character first to view their notifications.
          </div>
        ) : (
          <div className="mt-3 text-sm text-rose-400">
            {errorMessage(q.error)} — check the notifications scope is enabled
            (a re-login may be needed to grant it).
          </div>
        ))}

      {q.data && q.data.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`rounded-full px-3 py-1 text-xs ${
                cat === c
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-2">
        {q.isLoading && <div className="text-sm text-zinc-500">Loading…</div>}
        {q.data && rows.length === 0 && !q.isLoading && (
          <div className="text-sm text-zinc-500">Nothing here.</div>
        )}
        {rows.map((n) => (
          <NotificationCard
            key={n.id}
            row={n}
            showCharacter={multiCharacter}
            onDismiss={() => dismiss.mutate(n.id)}
          />
        ))}
      </div>
    </div>
  );
}

function NotificationCard({
  row,
  showCharacter,
  onDismiss,
}: {
  row: NotifRow;
  showCharacter: boolean;
  onDismiss: () => void;
}) {
  const catClass = CATEGORY_STYLE[row.category] ?? CATEGORY_STYLE.Other;
  return (
    <div
      className={`group rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 ${
        row.isRead ? "" : "border-l-2 border-l-indigo-500"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${catClass}`}
            >
              {row.category}
            </span>
            <span className="truncate font-medium text-zinc-100">
              {row.title}
            </span>
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            {showCharacter && (
              <span className="text-zinc-400">{row.characterName} · </span>
            )}
            {row.sender} · {fmtTime(row.timestamp)}
          </div>
          {row.body.trim() !== "" && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                Details
              </summary>
              <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-2 text-[11px] leading-snug text-zinc-400">
                {row.body.trim()}
              </pre>
            </details>
          )}
        </div>
        <button
          onClick={onDismiss}
          title="Dismiss"
          aria-label={`Dismiss ${row.title}`}
          className="shrink-0 rounded p-1 text-zinc-500 opacity-0 hover:text-zinc-200 group-hover:opacity-100"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}

/** Compact relative time from an ISO-8601 timestamp. */
function fmtTime(iso: string): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}
