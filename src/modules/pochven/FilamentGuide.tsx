import { useMemo } from "react";
import { FILAMENTS, systemsByClade, systemsByRole } from "./data";

// Filament entry guide (#416): how filaments drop you into Pochven by role /
// clade, with fleet caps and requirements. Data-driven from the clade/role map.
export function FilamentGuide() {
  const byRole = useMemo(() => systemsByRole(), []);
  const byClade = useMemo(() => systemsByClade(), []);

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-zinc-100">Filaments</h2>
      <p className="mt-1 max-w-3xl text-sm text-zinc-400">
        Filaments jump a small fleet straight into Pochven — capped at{" "}
        <strong>1 / 5 / 15</strong> sub-caps (the number in the filament name).{" "}
        {FILAMENTS.note}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* By role — System-type filaments. */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-sm font-medium text-zinc-200">
            System-type filaments
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Drop into a random system of that role (any clade).
          </p>
          <div className="mt-3 space-y-2">
            {(["Home", "Border", "Internal"] as const).map((role) => (
              <div key={role} className="text-sm">
                <span className="inline-block w-20 font-medium text-zinc-300">
                  {role}
                </span>
                <span className="text-zinc-500">{byRole[role].join(", ")}</span>
              </div>
            ))}
          </div>
        </div>

        {/* By clade — Cladistic filaments. */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-sm font-medium text-zinc-200">
            Cladistic filaments
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Drop into a random system of that clade.
          </p>
          <div className="mt-3 space-y-2">
            {(["Perun", "Svarog", "Veles"] as const).map((clade) => (
              <div key={clade} className="text-sm">
                <span className="inline-block w-20 font-medium text-zinc-300">
                  {clade}
                </span>
                <span className="text-zinc-500">
                  {byClade[clade].join(", ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-400">
        <span className="font-semibold uppercase tracking-wide text-zinc-500">
          To activate a filament
        </span>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {FILAMENTS.requirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>

      {/* Getting back to known space. */}
      <h3 className="mt-6 text-sm font-semibold text-zinc-200">
        Getting back to known space
      </h3>
      <p className="mt-1 max-w-3xl text-xs text-zinc-400">
        {FILAMENTS.exit.intro}
      </p>
      <div className="mt-3 space-y-2">
        {FILAMENTS.exit.options.map((o) => (
          <div
            key={o.name}
            className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-2.5 text-sm"
          >
            <span className="font-medium text-zinc-200">{o.name}</span>
            <span className="text-zinc-500"> — {o.detail}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 max-w-3xl text-[11px] text-zinc-600">
        Want to land near a trade hub? The Logistics table above lists each
        Pochven system's C729 exit distance to Jita, Amarr, Dodixie, Rens and
        Hek.
      </p>
    </section>
  );
}
