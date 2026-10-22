import { type HypotheticalConfig } from "../../lib/api";
import { Field } from "../../components/forms";

/** Settings row for Hypothetical mode's configurable knobs (#893): the T1
 * assumed run count, and both ME overrides. Hidden entirely in Owned mode,
 * where none of these apply. */
export function HypotheticalSettingsRow({
  config,
  onChange,
}: {
  config: HypotheticalConfig;
  onChange: (c: HypotheticalConfig) => void;
}) {
  function set<K extends keyof HypotheticalConfig>(key: K, value: number) {
    onChange({ ...config, [key]: Math.max(0, Math.round(value)) });
  }

  return (
    <div className="flex flex-wrap items-end gap-4 rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <Field
        label="T1 assumed runs"
        title="Default run count for a T1 (and special-edition) blueprint pasted with no per-row override"
      >
        <input
          type="number"
          min={1}
          step={1}
          value={config.t1Runs}
          onChange={(e) => set("t1Runs", Number(e.currentTarget.value))}
          className="w-20 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
        />
      </Field>
      <Field
        label="T1 assumed ME"
        title="Assumed material efficiency for T1 blueprints — default ME10, the max level researchable on a player-owned BPO"
      >
        <input
          type="number"
          min={0}
          max={10}
          step={1}
          value={config.t1Me}
          onChange={(e) => set("t1Me", Number(e.currentTarget.value))}
          className="w-20 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
        />
      </Field>
      <Field
        label="T2 assumed ME"
        title="Assumed material efficiency for T2 blueprints — default ME2, a freshly invented BPC with no decryptor"
      >
        <input
          type="number"
          min={0}
          max={10}
          step={1}
          value={config.t2Me}
          onChange={(e) => set("t2Me", Number(e.currentTarget.value))}
          className="w-20 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
        />
      </Field>
      <div className="text-xs text-zinc-500">
        T2 runs always come from each blueprint's own SDE run cap (
        <code>maxProductionLimit</code>) unless overridden per row below.
        Faction/Officer/Deadspace items always assume ME0, flagged below.
      </div>
    </div>
  );
}
