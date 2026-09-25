import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  ALL_CHARACTERS,
  activeCharacter,
  authCharacters,
  authLogin,
  authLogout,
  errorMessage,
  setActiveCharacter,
} from "../lib/api";

// Logged-in EVE characters. The active character (the default used by every
// per-character feature) is picked from a dropdown selector; Add opens the
// browser SSO flow, and ✕ removes the selected character (clearing its keychain
// entry).

// Switching/adding/removing a character changes which ESI identity every
// per-character query resolves against on the backend (it reads the
// bookmarked active character from its own storage, not from the query
// key), so a plain auth-state invalidation isn't enough — every
// per-character query root needs to be swept too, or the previous
// character's assets/orders/wallet/jobs/PI/notifications/skills keep
// rendering until their own staleTime happens to lapse. Structural fix:
// #887 also audited each of these queries to add the active character id
// into its own key so TanStack refetches automatically on switch; this
// sweep is the safety net for the rest (and for anything added later
// without a character id in its key).
const PER_CHARACTER_QUERY_ROOTS = [
  ["auth"], // characters, active
  ["owned"], // roster-wide Owned filter
  ["transactions"], // wallet transaction ledger
  ["orders"], // personal market orders
  ["notifications"],
  ["pi"], // PI colonies overview
  ["char"], // skills, standings, research, mining, fleet
  ["character"], // trade fees (broker/sales tax)
  ["industry"], // industry jobs
  ["esi"], // active character's current ship
];

export function Characters() {
  const qc = useQueryClient();
  const invalidate = () => {
    for (const queryKey of PER_CHARACTER_QUERY_ROOTS) {
      qc.invalidateQueries({ queryKey });
    }
  };

  const chars = useQuery({
    queryKey: ["auth", "characters"],
    queryFn: authCharacters,
  });
  const active = useQuery({
    queryKey: ["auth", "active"],
    queryFn: activeCharacter,
  });
  const login = useMutation({ mutationFn: authLogin, onSuccess: invalidate });
  const logout = useMutation({
    mutationFn: (id: number) => authLogout(id),
    onSuccess: invalidate,
  });
  const setActive = useMutation({
    mutationFn: (id: number) => setActiveCharacter(id),
    onSuccess: invalidate,
  });

  const activeId = active.data ?? chars.data?.[0]?.characterId ?? null;
  const hasChars = (chars.data?.length ?? 0) > 0;

  return (
    <div className="border-t border-zinc-800 px-3 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Character
        </span>
      </div>

      {hasChars ? (
        <div className="flex items-center gap-1">
          <select
            value={activeId ?? ""}
            onChange={(e) => setActive.mutate(Number(e.currentTarget.value))}
            title="Active character"
            aria-label="Active character"
            className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            {chars.data!.length > 1 && (
              <option value={ALL_CHARACTERS}>All characters</option>
            )}
            {chars.data!.map((c) => (
              <option key={c.characterId} value={c.characterId}>
                {c.name}
              </option>
            ))}
          </select>
          {activeId != null && activeId !== ALL_CHARACTERS && (
            <button
              onClick={() => logout.mutate(activeId)}
              className="flex shrink-0 items-center rounded p-1.5 text-zinc-400 hover:text-rose-400"
              title="Remove the selected character"
              aria-label="Remove the selected character"
            >
              <X size={14} />
            </button>
          )}
        </div>
      ) : (
        <p className="px-1 py-1 text-xs text-zinc-400">No characters yet.</p>
      )}

      <button
        onClick={() => login.mutate()}
        disabled={login.isPending}
        className="mt-2 w-full rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
      >
        {login.isPending ? "Waiting for login…" : "+ Add character"}
      </button>

      {login.isError && (
        <p className="mt-1 text-xs text-rose-400">
          Login failed: {errorMessage(login.error)}
        </p>
      )}
    </div>
  );
}
