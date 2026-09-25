import type { DpsExtractionPlan } from "../../lib/api";

/** Optional overview-export file picker (#869): a user running a custom
 *  overview pack (Z-S, SaraShawa, …) points this at their exported overview
 *  YAML so pilot/ship attribution follows their actual label order and
 *  separators instead of assuming the stock `NAME[CORP](SHIP)` layout. Text
 *  path entry + a Load button, matching the gamelogs folder field above it —
 *  no native file dialog plugin in this app. Empty path (the default) leaves
 *  the meter's default-format scan untouched. */
export function OverviewExportPanel({
  path,
  onSetPath,
  plan,
  error,
  onLoad,
}: {
  path: string;
  onSetPath: (v: string) => void;
  plan: DpsExtractionPlan | null;
  error: string | null;
  onLoad: () => void;
}) {
  return (
    <label className="flex-1 min-w-[20rem]">
      <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
        Overview export (optional)
      </span>
      <div className="flex gap-1.5">
        <input
          value={path}
          onChange={(e) => onSetPath(e.currentTarget.value)}
          onBlur={onLoad}
          placeholder="…/Documents/EVE/Overview/custom.yaml"
          className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <button
          onClick={onLoad}
          disabled={!path.trim()}
          className="shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          Load
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-rose-400">{error}</p>}
      {!error && plan && (
        <p className="mt-1 text-xs text-zinc-500">
          {plan.fields.length > 0
            ? `Custom overview loaded — ${plan.fields.length} label${plan.fields.length === 1 ? "" : "s"} in play.`
            : "Overview loaded, but no labels are enabled — using the default layout."}
        </p>
      )}
    </label>
  );
}
