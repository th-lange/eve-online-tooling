// Pure edge-building for the travel graph — a non-component file so it can be
// unit-tested and react-refresh hot-reloads the page components cleanly.

import type { SystemGraphEdge } from "../../components/SystemGraph";
import type { BreadcrumbEntry } from "../../lib/api";

/** Build the travel-graph edge list from the breadcrumb trail: one edge per
 * unordered system pair, so a leg re-travelled in the opposite direction
 * (A→B … B→A) doesn't double-draw. The first recorded traversal's styling
 * wins — it's the earliest honest observation of that link; later
 * re-crossings may have skipped polls and would only degrade it. */
export function buildTrailEdges(entries: BreadcrumbEntry[]): SystemGraphEdge[] {
  const seen = new Set<string>();
  const edges: SystemGraphEdge[] = [];
  for (let i = 1; i < entries.length; i++) {
    const a = entries[i - 1];
    const b = entries[i];
    if (a.systemId === b.systemId) continue;
    const key =
      a.systemId < b.systemId
        ? `${a.systemId}-${b.systemId}`
        : `${b.systemId}-${a.systemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A k-space↔w-space change can only be a wormhole; otherwise trust the
    // recorded gate distance: only a 1-gap leg is a real direct connection.
    const wormhole = a.wspace !== b.wspace || b.gapJumps === -1;
    const skipped = !wormhole && b.gapJumps > 1;
    edges.push({
      source: String(a.systemId),
      target: String(b.systemId),
      variant: wormhole ? "wormhole" : "stargate",
      dashed: wormhole ? a.wspace === b.wspace : skipped,
      label: skipped ? `${b.gapJumps} jumps` : undefined,
    });
  }
  return edges;
}
