import { useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import {
  fittingCompatibleCharges,
  type FleetBoost,
  type LinkType,
} from "../../lib/api";
import { fittingKeys, sdeKeys } from "../../lib/queryKeys";
import { useFitState, useFitStats } from "./useFitEditorContext";

/** Command-burst link choices by family (#1279). */
const LINK_GROUPS: { group: string; links: [LinkType, string][] }[] = [
  {
    group: "Shield",
    links: [
      ["shieldHarmonizing", "Harmonizing"],
      ["shieldActiveShielding", "Active Shielding"],
      ["shieldExtension", "Extension"],
      ["shieldAll", "All"],
    ],
  },
  {
    group: "Armor",
    links: [
      ["armorEnergizing", "Energizing"],
      ["armorRapidRepair", "Rapid Repair"],
      ["armorReinforcement", "Reinforcement"],
      ["armorAll", "All"],
    ],
  },
  {
    group: "Skirmish",
    links: [
      ["skirmishEvasiveManeuvers", "Evasive Maneuvers"],
      ["skirmishInterdictionManeuvers", "Interdiction Maneuvers"],
      ["skirmishRapidDeployment", "Rapid Deployment"],
      ["skirmishAll", "All"],
    ],
  },
  {
    group: "Information",
    links: [
      ["informationSensorOptimization", "Sensor Optimization"],
      ["informationElectronicSuperiority", "Electronic Superiority"],
      ["informationElectronicHardening", "Electronic Hardening"],
      ["informationAll", "All"],
    ],
  },
  {
    group: "Expedition",
    links: [
      ["expeditionStrength", "Strength"],
      ["expeditionReach", "Reach"],
      ["expeditionPinpointing", "Pinpointing"],
      ["expeditionAll", "All"],
    ],
  },
  {
    group: "Mining",
    links: [
      ["miningFieldEnhancement", "Field Enhancement"],
      ["miningOptimization", "Optimization"],
      ["miningPreservation", "Preservation"],
      ["miningEfficiency", "Efficiency"],
      ["miningAll", "All"],
    ],
  },
];

function linkLabel(link: LinkType): string {
  for (const g of LINK_GROUPS) {
    const hit = g.links.find(([id]) => id === link);
    if (hit) return `${g.group}: ${hit[1]}`;
  }
  return link;
}

function signed(v: number): string {
  const r = Math.round(v * 100) / 100;
  return `${r > 0 ? "+" : ""}${r}`;
}

/**
 * Fleet boosts (#705, #1279): command bursts the fit is "receiving" from a
 * fleet member — either a generic link (family + the booster's hull bonus and
 * mindlink) or a concrete burst module + charge. The engine turns each into
 * warfare buffs (strongest per buff ID wins) and applies them to the ship and
 * its modules; the "Applied" list shows the merged result it actually used.
 */
export function FleetBoostsPanel() {
  const {
    fleetBoosts: boosts,
    addFleetBoost: onAdd,
    removeFleetBoost: onRemove,
  } = useFitState();
  const { nameOf, stats } = useFitStats();
  const applied = stats.data?.fleetBuffsApplied ?? [];
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<"link" | "module">("link");
  const [link, setLink] = useState<LinkType>("skirmishRapidDeployment");
  const [strengthPct, setStrengthPct] = useState(0);
  const [mindlink, setMindlink] = useState(false);
  const [q, setQ] = useState("");
  // A module picked but not yet committed — offers a charge picker before it
  // lands in `boosts`.
  const [pickedModule, setPickedModule] = useState<{
    id: number;
    name: string;
  } | null>(null);

  const results = useQuery({
    ...sdeKeys.search(q),
    enabled: mode === "module" && pickedModule == null && q.trim().length >= 2,
  });
  const charges = useQuery({
    queryKey: fittingKeys.compatibleCharges(pickedModule?.id),
    queryFn: pickedModule
      ? () => fittingCompatibleCharges(pickedModule.id)
      : skipToken,
  });

  function reset() {
    setAdding(false);
    setQ("");
    setPickedModule(null);
  }
  function commit(chargeTypeId?: number) {
    if (!pickedModule) return;
    onAdd({
      kind: "module",
      moduleTypeId: pickedModule.id,
      chargeTypeId,
      strengthPct,
      mindlink,
    });
    reset();
  }
  function commitLink() {
    onAdd({ kind: "genericLink", linkType: link, strengthPct, mindlink });
    reset();
  }
  function describe(b: FleetBoost): string {
    const extras = [
      b.strengthPct > 0 ? `${b.strengthPct}%/lvl` : null,
      b.mindlink ? "mindlink" : null,
    ].filter(Boolean);
    const head =
      b.kind === "genericLink"
        ? linkLabel(b.linkType)
        : [
            nameOf(b.moduleTypeId),
            b.chargeTypeId != null && nameOf(b.chargeTypeId),
          ]
            .filter(Boolean)
            .join(" · ");
    return extras.length > 0 ? `${head} (${extras.join(", ")})` : head;
  }

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
        Fleet boosts
        <button
          onClick={() => (adding ? reset() : setAdding(true))}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 normal-case text-zinc-400 hover:text-zinc-200"
        >
          {adding ? <X size={12} /> : <Plus size={12} />}
          {adding ? "Cancel" : "Add"}
        </button>
      </div>

      {boosts.length > 0 && (
        <ul className="mb-2 text-xs text-zinc-300">
          {boosts.map((b, i) => (
            <li
              key={i}
              className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/70"
            >
              <button
                onClick={() => onRemove(i)}
                className="flex shrink-0 items-center rounded p-0.5 text-zinc-500 group-hover:text-red-400"
                title="Remove fleet boost"
                aria-label={`Remove ${describe(b)}`}
              >
                <Trash2 size={13} />
              </button>
              <span className="truncate">{describe(b)}</span>
            </li>
          ))}
        </ul>
      )}

      {applied.length > 0 && (
        <ul className="mb-2 space-y-0.5 text-xs text-zinc-400">
          {applied.map((a) => (
            <li key={a.buffId} className="flex justify-between gap-2">
              <span className="truncate">{a.label}</span>
              <span className="shrink-0 tabular-nums text-zinc-200">
                {signed(a.valuePct)}
                {a.buffId === 2468 ? "" : "%"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mb-2 space-y-2 text-xs">
          <div className="flex gap-1">
            {(["link", "module"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setPickedModule(null);
                }}
                className={`rounded px-2 py-0.5 ${
                  mode === m
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {m === "link" ? "Link" : "Module + charge"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-zinc-400">
            <label className="flex items-center gap-1">
              Ship bonus
              <input
                type="number"
                min={0}
                max={5}
                step={0.5}
                value={strengthPct}
                onChange={(e) =>
                  setStrengthPct(
                    Math.min(
                      5,
                      Math.max(0, Number(e.currentTarget.value) || 0),
                    ),
                  )
                }
                aria-label="Ship bonus %/lvl"
                className="w-14 rounded bg-zinc-800 px-1 py-0.5 text-zinc-100 outline-none"
              />
              %/lvl
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={mindlink}
                onChange={(e) => setMindlink(e.currentTarget.checked)}
              />
              Mindlink
            </label>
          </div>
          <div className="text-[10px] text-zinc-500">
            Command ship: 2–5 %, T3C: 2 %. Booster skills assumed at V.
          </div>
          {mode === "link" && (
            <div className="flex items-center gap-2">
              <select
                value={link}
                onChange={(e) => setLink(e.currentTarget.value as LinkType)}
                aria-label="Burst link"
                className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
              >
                {LINK_GROUPS.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.links.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                onClick={commitLink}
                className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800"
              >
                Add boost
              </button>
            </div>
          )}
        </div>
      )}

      {adding && mode === "module" && !pickedModule && (
        <>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="search a command burst module…"
            className="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          {q.trim().length >= 2 && (
            <ul className="mt-2 max-h-40 overflow-y-auto text-xs">
              {(results.data ?? []).slice(0, 20).map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setPickedModule({ id: r.id, name: r.name })}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800"
                  >
                    <span className="flex-1 truncate">{r.name}</span>
                    <Plus size={12} className="shrink-0 text-zinc-500" />
                  </button>
                </li>
              ))}
              {results.isFetched && (results.data?.length ?? 0) === 0 && (
                <li className="px-2 py-1 text-zinc-500">No matches.</li>
              )}
            </ul>
          )}
        </>
      )}

      {adding && mode === "module" && pickedModule && (
        <div className="space-y-1 text-xs">
          <div className="flex items-center justify-between text-zinc-300">
            <span className="truncate">{pickedModule.name}</span>
            <button
              onClick={() => setPickedModule(null)}
              className="shrink-0 text-zinc-500 hover:text-zinc-300"
              title="Back to search"
            >
              <X size={12} />
            </button>
          </div>
          {(charges.data?.length ?? 0) > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                Charge
              </div>
              <ul className="max-h-40 overflow-y-auto">
                {(charges.data ?? []).map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => commit(c.id)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800"
                    >
                      <span className="flex-1 truncate">{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            onClick={() => commit(undefined)}
            className="w-full rounded border border-zinc-700 px-2 py-1 text-left text-zinc-400 hover:bg-zinc-800"
          >
            No charge
          </button>
        </div>
      )}
    </div>
  );
}
