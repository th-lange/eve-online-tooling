import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authCharacters, authLogin, authLogout } from "../lib/api";

// Roster of logged-in EVE characters. Add opens the browser SSO flow; each
// character can be removed (which clears its keychain entry).
export function Characters() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["auth", "characters"] });
    qc.invalidateQueries({ queryKey: ["owned"] }); // refresh the Owned filter
  };

  const chars = useQuery({
    queryKey: ["auth", "characters"],
    queryFn: authCharacters,
  });
  const login = useMutation({ mutationFn: authLogin, onSuccess: invalidate });
  const logout = useMutation({
    mutationFn: (id: number) => authLogout(id),
    onSuccess: invalidate,
  });

  return (
    <div className="border-t border-zinc-800 px-3 py-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Characters
        </span>
      </div>

      <ul className="space-y-1">
        {chars.data?.map((c) => (
          <li
            key={c.characterId}
            className="group flex items-center justify-between rounded px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800/60"
          >
            <span className="truncate" title={c.name}>
              {c.name}
            </span>
            <button
              onClick={() => logout.mutate(c.characterId)}
              className="ml-2 text-zinc-600 opacity-0 hover:text-rose-400 group-hover:opacity-100"
              title="Remove character"
            >
              ✕
            </button>
          </li>
        ))}
        {chars.data && chars.data.length === 0 && (
          <li className="px-2 py-1 text-xs text-zinc-600">
            No characters yet.
          </li>
        )}
      </ul>

      <button
        onClick={() => login.mutate()}
        disabled={login.isPending}
        className="mt-2 w-full rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
      >
        {login.isPending ? "Waiting for login…" : "+ Add character"}
      </button>

      {login.isError && (
        <p className="mt-1 text-xs text-rose-400">
          Login failed: {String(login.error)}
        </p>
      )}
    </div>
  );
}
