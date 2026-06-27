import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  activeCharacter,
  authCharacters,
  authLogin,
  authLogout,
  setActiveCharacter,
} from "../lib/api";

// Logged-in EVE characters. The active character (the default used by every
// per-character feature) is picked from a dropdown selector; Add opens the
// browser SSO flow, and ✕ removes the selected character (clearing its keychain
// entry).
export function Characters() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["auth", "characters"] });
    qc.invalidateQueries({ queryKey: ["auth", "active"] });
    qc.invalidateQueries({ queryKey: ["owned"] }); // refresh the Owned filter
  };

  const chars = useQuery({
    queryKey: ["auth", "characters"],
    queryFn: authCharacters,
  });
  const active = useQuery({ queryKey: ["auth", "active"], queryFn: activeCharacter });
  const login = useMutation({ mutationFn: authLogin, onSuccess: invalidate });
  const logout = useMutation({
    mutationFn: (id: number) => authLogout(id),
    onSuccess: invalidate,
  });
  const setActive = useMutation({
    mutationFn: (id: number) => setActiveCharacter(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "active"] }),
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
            {chars.data!.map((c) => (
              <option key={c.characterId} value={c.characterId}>
                {c.name}
              </option>
            ))}
          </select>
          {activeId != null && (
            <button
              onClick={() => logout.mutate(activeId)}
              className="shrink-0 rounded px-1 text-zinc-600 hover:text-rose-400"
              title="Remove the selected character"
              aria-label="Remove the selected character"
            >
              ✕
            </button>
          )}
        </div>
      ) : (
        <p className="px-1 py-1 text-xs text-zinc-600">No characters yet.</p>
      )}

      <button
        onClick={() => login.mutate()}
        disabled={login.isPending}
        className="mt-2 w-full rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
      >
        {login.isPending ? "Waiting for login…" : "+ Add character"}
      </button>

      {login.isError && (
        <p className="mt-1 text-xs text-rose-400">Login failed: {String(login.error)}</p>
      )}
    </div>
  );
}
