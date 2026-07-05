import { C729 } from "./data";
import { EntryFinder } from "./EntryFinder";
import { PochvenSystemsPopover } from "./SystemsPopover";
import { Logistics } from "./Logistics";
import { FilamentGuide } from "./FilamentGuide";

// Pochven "get me in" tools + reference (epic #417).
export function PochvenPage() {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold text-zinc-100">Pochven entry</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-400">
        Pochven has no gates to k-space — you get in via a <strong>C729</strong>{" "}
        wormhole or a filament. Enter your current system and it'll route you to
        the nearest C729 spawn candidate and list the systems to jump &amp;
        scan.
      </p>

      <EntryFinder />

      {/* C729 specs. */}
      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-400">
        <span className="font-semibold uppercase tracking-wide text-zinc-500">
          C729
        </span>
        <span>Spawn: {C729.spawnDistance}</span>
        <span>Max jump mass: {C729.maxJumpMass}</span>
        <span>Lifetime: {C729.lifetime}</span>
      </div>

      {/* Full reference — opens a centred map + table popover. */}
      <div className="mt-6">
        <PochvenSystemsPopover />
      </div>

      <Logistics />
      <FilamentGuide />

      <p className="mt-4 text-[11px] text-zinc-600">
        Entry data: Electus Matari Pochven entry manual. Hub distances computed
        live over the stargate graph.
      </p>
    </div>
  );
}
