import { type ChainNode } from "../../lib/api";
import { formatInt } from "../../lib/format";
import { type PlannerPick, TIER_BADGE_CLASS, pickLabel } from "./plannerTypes";

function PlanetBadges({
  planetTypes,
  tier,
}: {
  planetTypes: string[];
  tier: number;
}) {
  if (planetTypes.length === 0) {
    return (
      <span className="rounded bg-amber-900/40 px-2 py-1 text-xs text-amber-300">
        Needs imports — no single planet
      </span>
    );
  }
  const className = TIER_BADGE_CLASS[tier] ?? TIER_BADGE_CLASS[0];
  return (
    <div className="flex flex-wrap gap-1">
      {planetTypes.map((pt) => (
        <span
          key={pt}
          className={`rounded px-2 py-0.5 text-xs ${className}`}
          title={`P${tier} material`}
        >
          {pt}
        </span>
      ))}
    </div>
  );
}

/** A P1 node has exactly one child — the P0 raw resource it depends on;
 * inline it as "← <name> (P0)" instead of a nested bullet, per the
 * planner's design in #882. The P0's own `planetTypes` isn't rendered
 * separately — a P1's own set is already its P0 input's set (that's how
 * `intersect_planet_types` computes it bottom-up), so a second badge row
 * would just repeat the one above it.
 *
 * Multi-colony imports: if another pick in the same plan produces this
 * exact material (its `id` matches `node.typeId`), a toggle offers "import
 * this from <that colony> instead of building it here" — once marked, the
 * node's own sub-tree (its P0/intermediate inputs) is pruned from this
 * render, since it's already accounted for under the producing pick's own
 * chain and listing it twice would double it up. */
function ChainRow({
  node,
  depth,
  siblingPicks,
  imports,
  onToggleImport,
}: {
  node: ChainNode;
  depth: number;
  siblingPicks: PlannerPick[];
  imports: number[];
  onToggleImport: (typeId: number) => void;
}) {
  const p0 = node.tier === 1 ? node.children[0] : null;
  const isImported = imports.includes(node.typeId);
  const source = siblingPicks.find((sp) => sp.id === node.typeId);
  return (
    <div>
      <div
        className="flex flex-wrap items-center gap-2 py-0.5 text-sm"
        style={{ paddingLeft: `${depth * 1.25}rem` }}
      >
        <span className="text-zinc-600">├─</span>
        <span className="text-zinc-200">{node.name}</span>
        <span className="text-xs text-zinc-500">P{node.tier}</span>
        {node.qtyPerCycle > 0 && (
          <span className="text-xs text-zinc-400">
            {formatInt(node.qtyPerCycle)}/cycle
          </span>
        )}
        {isImported ? (
          <span className="rounded bg-indigo-950/60 px-2 py-0.5 text-xs text-indigo-300">
            Imported
            {source ? ` from ${pickLabel(source)}` : ""}
          </span>
        ) : (
          <>
            {p0 && (
              <span className="text-xs text-zinc-500">← {p0.name} (P0)</span>
            )}
            <PlanetBadges planetTypes={node.planetTypes} tier={node.tier} />
          </>
        )}
        {(source || isImported) && (
          <button
            type="button"
            onClick={() => onToggleImport(node.typeId)}
            title={
              isImported
                ? "Stop treating this as imported — build it in this chain again"
                : `Mark as imported from ${source ? pickLabel(source) : ""} instead of building it here`
            }
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              isImported
                ? "border-indigo-600 bg-indigo-900/40 text-indigo-300"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            {isImported
              ? "✓ Linked"
              : `⇄ Import from ${source ? pickLabel(source) : ""}`}
          </button>
        )}
      </div>
      {node.tier > 1 &&
        !isImported &&
        node.children.map((c) => (
          <ChainRow
            key={c.typeId}
            node={c}
            depth={depth + 1}
            siblingPicks={siblingPicks}
            imports={imports}
            onToggleImport={onToggleImport}
          />
        ))}
    </div>
  );
}

export { PlanetBadges, ChainRow };
