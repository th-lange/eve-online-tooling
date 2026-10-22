import { useState } from "react";
import { Navigation } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, setWaypoint, type FwSystemNode } from "../../lib/api";
import { InlineError } from "../../components/InlineError";

/** System-name cell: Dotlan link + optional "set route" waypoint button. Owns
 *  its own inline-error state (#819/#820) since it's repeated per row — an
 *  openUrl/setWaypoint failure here shouldn't blow away the whole table with
 *  a blocking alert(), just note it next to the control that failed. */
export function SystemNameCell({
  s,
  hasCharacter,
}: {
  s: FwSystemNode;
  hasCharacter: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <td className="px-3 py-1.5">
      <div className="flex items-center gap-2">
        {/* System name → Dotlan for map + info (ESI can't open an
            in-game info window for solar systems, esi-issues#358). */}
        <button
          onClick={() =>
            void openUrl(`https://evemaps.dotlan.net/system/${s.name}`)
              .then(() => setError(null))
              .catch((e) => {
                console.error(`Failed to open ${s.name} on Dotlan`, e);
                setError(`Couldn't open Dotlan: ${errorMessage(e)}`);
              })
          }
          title={`Open ${s.name} on Dotlan`}
          className="font-medium text-zinc-100 hover:text-indigo-300"
        >
          {s.name}
        </button>
        {hasCharacter && (
          <div className="group relative">
            <button
              onClick={() =>
                setWaypoint(s.systemId)
                  .then(() => setError(null))
                  .catch((e) => {
                    console.error(`Failed to set destination ${s.name}`, e);
                    setError(`Couldn't set destination: ${errorMessage(e)}`);
                  })
              }
              className="text-zinc-600 hover:text-indigo-400"
            >
              <Navigation size={12} />
            </button>
            <span className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 ring-1 ring-zinc-700 group-hover:block">
              Set route
            </span>
          </div>
        )}
      </div>
      <InlineError message={error} className="mt-0.5 text-xs text-rose-400" />
    </td>
  );
}
