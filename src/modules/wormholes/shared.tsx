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

/** Labelled form field wrapper used across the wormhole panels. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      {children}
    </label>
  );
}
