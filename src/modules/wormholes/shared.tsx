import { Combo } from "../../components/Combo";
import { systemSearch, type SystemMatch } from "../../lib/api";

/** Thin wrapper around the shared Combo, kept for the wormhole panels'
 * `picked`/`onPick` naming and 40-wide sizing. */
export function SystemPicker({
  picked,
  onPick,
}: {
  picked: SystemMatch | null;
  onPick: (m: SystemMatch | null) => void;
}) {
  return (
    <Combo
      value={picked}
      onPick={onPick}
      search={systemSearch}
      placeholder="System…"
      width="w-40"
    />
  );
}
