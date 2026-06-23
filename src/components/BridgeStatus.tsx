import { useQuery } from "@tanstack/react-query";
import { ping } from "../lib/api";

// Tiny footer indicator that exercises the frontend ↔ Rust `invoke` bridge.
// Outside a Tauri window (e.g. plain `vite dev`) `invoke` is unavailable, so a
// failure here just means "not running in the desktop shell".
export function BridgeStatus() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["ping"],
    queryFn: ping,
  });

  const label = isLoading
    ? "connecting…"
    : isError
      ? "bridge unavailable"
      : data === "pong"
        ? "connected"
        : `unexpected: ${data}`;
  const ok = data === "pong";

  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500">
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          ok ? "bg-emerald-500" : isError ? "bg-rose-500" : "bg-amber-500"
        }`}
        aria-hidden
      />
      <span>Rust bridge: {label}</span>
    </div>
  );
}
