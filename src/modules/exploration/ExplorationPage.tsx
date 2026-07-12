import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Shield, ShieldCheck, Skull, TrendingUp, X } from "lucide-react";
import { Page, PageHeader } from "../../components/page";

// A curated reference for EVE exploration content — combat anomalies and the
// scannable relic / data / DED / gas sites. This is static knowledge (site
// types, spawns, danger, loot and damage profiles aren't in ESI or the SDE), so
// it's a hand-maintained guide. Click a card for loot + damage-type detail.

type Sec = "High" | "Low" | "Null" | "WH";
type Danger = "safe" | "moderate" | "high";
type Dmg = "EM" | "Thermal" | "Kinetic" | "Explosive" | "Omni";
/** Which NPCs (if any) guard the site, driving the damage panel. */
type Combat = "faction" | "sleeper" | "none";

interface Site {
  name: string;
  sec: Sec[];
  danger: Danger;
  enemies: string;
  escalation: "None" | "Yes";
  escalationNote?: string;
  notes: string;
  combat: Combat;
  loot: string[];
  tips?: string[];
}

interface Group {
  title: string;
  blurb: string;
  scanned: boolean;
  sites: Site[];
}

/** Pirate-faction damage profiles: what to *deal* (their weakness) and *tank*
 *  (what they shoot), plus their signature EWAR. Applies to faction combat
 *  anomalies, DED complexes and faction combat sites. */
const FACTION_DAMAGE: {
  faction: string;
  deal: Dmg[];
  tank: Dmg[];
  ewar: string;
}[] = [
  {
    faction: "Angel Cartel",
    deal: ["Explosive"],
    tank: ["Explosive", "Kinetic"],
    ewar: "Webs & target painters (fast ships)",
  },
  {
    faction: "Blood Raiders",
    deal: ["EM", "Thermal"],
    tank: ["EM", "Thermal"],
    ewar: "Energy neutralizers — cap warfare",
  },
  {
    faction: "Guristas",
    deal: ["Kinetic"],
    tank: ["Kinetic", "Thermal"],
    ewar: "ECM — jamming",
  },
  {
    faction: "Sansha's Nation",
    deal: ["EM", "Thermal"],
    tank: ["EM", "Thermal"],
    ewar: "Tracking disruptors & neuts",
  },
  {
    faction: "Serpentis",
    deal: ["Kinetic", "Thermal"],
    tank: ["Thermal", "Kinetic"],
    ewar: "Sensor dampeners",
  },
];

const SLEEPER = {
  deal: ["Thermal", "Kinetic"] as Dmg[],
  tank: ["Omni"] as Dmg[],
  ewar: "Neut, web, target-paint & sensor damp — they also rep each other and switch targets",
};

const GROUPS: Group[] = [
  {
    title: "Combat anomalies",
    blurb:
      "Pirate-faction combat sites that show in the probe scanner immediately — no scanning needed.",
    scanned: false,
    sites: [
      {
        name: "Faction anomalies (Refuge → Sanctum/Haven)",
        sec: ["High", "Low", "Null"],
        danger: "moderate",
        enemies:
          "Pirate-faction rats, scaling with security & tier — highsec Refuges are trivial, nullsec Havens/Sanctums are the toughest.",
        escalation: "None",
        combat: "faction",
        notes:
          "Faction sets the damage & tank to bring. Bounties plus faction loot and tags.",
        loot: [
          "Bounties (ISK) from every rat — the main income",
          "Meta / faction loot modules and pirate tags",
          "Occasional faction module or BPC from a commander spawn",
        ],
        tips: [
          "The system's resident pirate faction sets the damage profile (see below).",
          "Anomalies respawn elsewhere in the constellation after you clear them.",
        ],
      },
      {
        name: "Sleeper anomalies (Perimeter / Frontier / Core)",
        sec: ["WH"],
        danger: "high",
        enemies:
          "Sleeper drones — neut, web, target-switch, hit hard. Scale sharply with wormhole class (C1 → C6).",
        escalation: "None",
        combat: "sleeper",
        notes: "No bounties — blue-loot + salvage is the payout.",
        loot: [
          "Blue loot — Sleeper components sold to CONCORD at a fixed price",
          "Sleeper salvage → Tech III production",
          "Payout scales sharply with wormhole class",
        ],
        tips: [
          "No local chat — keep d-scan up for hostiles the entire time.",
          "Sleepers rep each other and switch targets; bring stable cap and enough DPS.",
        ],
      },
    ],
  },
  {
    title: "Relic sites",
    blurb:
      "Scannable signatures you hack with a Relic Analyzer. Loot is salvage for T2 components and rigs.",
    scanned: true,
    sites: [
      {
        name: "Relic sites (k-space)",
        sec: ["High", "Low", "Null"],
        danger: "safe",
        enemies:
          "Unguarded — no rats, hack freely. In low/null the real threat is other players hunting explorers.",
        escalation: "None",
        combat: "none",
        notes: "“Ruined [Faction] … Site”. Null pays far more than highsec.",
        loot: [
          "Salvage materials for T2 rigs & components",
          "Intact / malfunctioning / wrecked … parts (intact = most valuable)",
          "Null variants drop the pricier parts",
        ],
        tips: [
          "Relic Analyzer + relic rigs raise your hack strength.",
          "A failed hack fires an alarm and can wipe the can — watch the minigame.",
        ],
      },
      {
        name: "Relic sites (wormhole)",
        sec: ["WH"],
        danger: "high",
        enemies: "Sleeper-guarded — clear or avoid them to reach the cans.",
        escalation: "None",
        combat: "sleeper",
        notes: "Higher value than k-space, but guarded and no local.",
        loot: [
          "Same salvage families as k-space, weighted to the pricier intact parts",
        ],
        tips: [
          "Run in a cloaky / nullified explorer; no local means no warning.",
        ],
      },
    ],
  },
  {
    title: "Data sites",
    blurb:
      "Scannable signatures you hack with a Data Analyzer. Loot is datacores, decryptors, BPCs, SKINs and salvage.",
    scanned: true,
    sites: [
      {
        name: "Data sites (k-space)",
        sec: ["High", "Low", "Null"],
        danger: "safe",
        enemies:
          "Unguarded — no rats. Same PvP risk as relic sites in low/null.",
        escalation: "None",
        combat: "none",
        notes: "Highsec data is low-value; null/WH is better.",
        loot: [
          "Datacores & decryptors → invention",
          "BPCs, SKINs, R.A.M. / R.Db parts",
          "Occasional faction/officer BPC",
        ],
        tips: ["Data Analyzer + data rigs. Highsec is mostly newbie money."],
      },
      {
        name: "Data sites (wormhole)",
        sec: ["WH"],
        danger: "high",
        enemies: "Sleeper-guarded, like wormhole relic sites.",
        escalation: "None",
        combat: "sleeper",
        notes: "Sleeper-tech data alongside the usual datacores and BPCs.",
        loot: ["Sleeper-tech data components", "Datacores, decryptors, BPCs"],
      },
    ],
  },
  {
    title: "DED complexes & faction combat sites",
    blurb:
      "Scannable combat signatures, some DED-rated (1/10 → 10/10). This is where escalations come from.",
    scanned: true,
    sites: [
      {
        name: "DED-rated complexes (1/10 – 10/10)",
        sec: ["High", "Low", "Null"],
        danger: "moderate",
        enemies:
          "Combat scaling with the rating — 1/10 is soloable in a frigate, 10/10 is capital-grade. Higher ratings live in low/null.",
        escalation: "Yes",
        escalationNote:
          "Often spawns as an escalation from a faction combat site; the loot room drops faction/deadspace modules and BPCs.",
        combat: "faction",
        notes:
          "Acceleration-gated deadspace pockets — the ‘blue loot’ of combat.",
        loot: [
          "Faction, deadspace and (high-DED) officer modules",
          "Deadspace / faction BPCs",
          "Overseer's Effects & DED-only loot",
        ],
        tips: [
          "The DED rating is the difficulty — match your ship to it.",
          "Damage profile follows the faction running the complex (see below).",
        ],
      },
      {
        name: "Unrated faction combat sites",
        sec: ["Low", "Null"],
        danger: "moderate",
        enemies:
          "Faction rats; the final commander spawn is the escalation trigger.",
        escalation: "Yes",
        escalationNote:
          "Killing the commander can start an expedition — a chain of follow-up sites (often nearby) with escalating loot.",
        combat: "faction",
        notes: "The classic explorer/ratter escalation loop.",
        loot: [
          "Faction loot + tags",
          "The escalation itself is the prize — follow it for better loot",
        ],
        tips: [
          "Follow the expedition entry in your journal before it expires.",
          "Damage profile follows the faction (see below).",
        ],
      },
    ],
  },
  {
    title: "Gas sites",
    blurb:
      "Scannable Ladar signatures — gas clouds you harvest with gas-cloud harvesters (not hacked).",
    scanned: true,
    sites: [
      {
        name: "Gas sites",
        sec: ["Low", "Null", "WH"],
        danger: "moderate",
        enemies:
          "K-space clouds are usually unguarded; many wormhole gas sites spawn rats/Sleepers on a timer after you arrive.",
        escalation: "None",
        combat: "none",
        notes:
          "Booster/Mordu gas in k-space; wormhole Fullerene gas feeds Tech III.",
        loot: [
          "Fullerene gas (wormhole) → Tech III",
          "Booster gas — Cloud Ring / Mordu's (k-space)",
        ],
        tips: [
          "Use gas-cloud harvesters, not an analyzer.",
          "Wormhole gas sites spawn rats/Sleepers on a timer — align out before it fires.",
        ],
      },
    ],
  },
];

const SEC_STYLE: Record<Sec, string> = {
  High: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/20",
  Low: "bg-amber-500/15 text-amber-300 ring-amber-500/20",
  Null: "bg-rose-500/15 text-rose-300 ring-rose-500/20",
  WH: "bg-violet-500/15 text-violet-300 ring-violet-500/20",
};

const DANGER: Record<
  Danger,
  { color: string; accent: string; Icon: typeof Shield }
> = {
  safe: {
    color: "text-emerald-400",
    accent: "border-l-emerald-500/60",
    Icon: ShieldCheck,
  },
  moderate: {
    color: "text-amber-400",
    accent: "border-l-amber-500/60",
    Icon: Shield,
  },
  high: {
    color: "text-rose-400",
    accent: "border-l-rose-500/60",
    Icon: Skull,
  },
};

const DMG_STYLE: Record<Dmg, string> = {
  EM: "bg-sky-500/15 text-sky-300",
  Thermal: "bg-rose-500/15 text-rose-300",
  Kinetic: "bg-zinc-500/25 text-zinc-300",
  Explosive: "bg-amber-500/15 text-amber-300",
  Omni: "bg-violet-500/15 text-violet-300",
};

function DmgChips({ types }: { types: Dmg[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {types.map((t) => (
        <span
          key={t}
          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${DMG_STYLE[t]}`}
        >
          {t}
        </span>
      ))}
    </span>
  );
}

function SecBadges({ sec }: { sec: Sec[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {sec.map((s) => (
        <span
          key={s}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${SEC_STYLE[s]}`}
        >
          {s}
        </span>
      ))}
    </div>
  );
}

function SiteCard({
  site,
  onOpen,
}: {
  site: Site;
  onOpen: (site: Site) => void;
}) {
  const d = DANGER[site.danger];
  return (
    <button
      onClick={() => onOpen(site)}
      className={`rounded-lg border border-zinc-800 border-l-4 bg-zinc-900/40 p-3.5 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900/70 ${d.accent}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-100">{site.name}</h3>
        {site.escalation === "Yes" && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/25">
            <TrendingUp size={11} /> Escalates
          </span>
        )}
      </div>
      <div className="mt-2">
        <SecBadges sec={site.sec} />
      </div>
      <div className={`mt-2.5 flex items-start gap-1.5 text-xs ${d.color}`}>
        <d.Icon size={14} className="mt-px shrink-0" />
        <span>{site.enemies}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">{site.notes}</p>
      <span className="mt-2 block text-[10px] uppercase tracking-wide text-zinc-600">
        Click for loot &amp; damage →
      </span>
    </button>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
        {title}
      </div>
      {children}
    </div>
  );
}

function DamagePanel({ combat }: { combat: Combat }) {
  if (combat === "none") {
    return (
      <p className="text-sm text-zinc-400">
        No NPCs — the site is unguarded. The only threat is other players, so
        bring a cloak / nullified hull and watch the map in low/null.
      </p>
    );
  }
  if (combat === "sleeper") {
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="w-14 text-zinc-500">Deal</span>
          <DmgChips types={SLEEPER.deal} />
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="w-14 text-zinc-500">Tank</span>
          <DmgChips types={SLEEPER.tank} />
        </div>
        <p className="mt-2 text-zinc-400">{SLEEPER.ewar}</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900 text-left text-zinc-500">
          <tr>
            <th className="px-2 py-1 font-medium">Faction</th>
            <th className="px-2 py-1 font-medium">Deal</th>
            <th className="px-2 py-1 font-medium">Tank</th>
            <th className="px-2 py-1 font-medium">EWAR</th>
          </tr>
        </thead>
        <tbody>
          {FACTION_DAMAGE.map((f) => (
            <tr key={f.faction} className="border-t border-zinc-800 align-top">
              <td className="px-2 py-1.5 font-medium text-zinc-200">
                {f.faction}
              </td>
              <td className="px-2 py-1.5">
                <DmgChips types={f.deal} />
              </td>
              <td className="px-2 py-1.5">
                <DmgChips types={f.tank} />
              </td>
              <td className="px-2 py-1.5 text-zinc-400">{f.ewar}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SiteDetail({ site, onClose }: { site: Site; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = DANGER[site.danger];

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50" />
      <div
        role="dialog"
        onClick={(e) => e.stopPropagation()}
        className="relative z-10 max-h-[85vh] w-[560px] max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-zinc-100">
              {site.name}
            </h3>
            <div className="mt-1 flex items-center gap-2">
              <SecBadges sec={site.sec} />
              <span className={`flex items-center gap-1 text-xs ${d.color}`}>
                <d.Icon size={12} /> {site.enemies.split(/[—.]/)[0].trim()}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-500 hover:text-zinc-200"
          >
            <X size={15} />
          </button>
        </div>

        {site.escalation === "Yes" && site.escalationNote && (
          <div className="mt-3 flex items-start gap-1.5 rounded border border-amber-500/25 bg-amber-500/10 p-2 text-sm text-amber-200">
            <TrendingUp size={13} className="mt-px shrink-0" />
            <span>{site.escalationNote}</span>
          </div>
        )}

        <Section title="Loot">
          <ul className="list-disc space-y-0.5 pl-4 text-sm text-zinc-300">
            {site.loot.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Section>

        <Section
          title={site.combat === "none" ? "Threat" : "Damage — deal vs tank"}
        >
          <DamagePanel combat={site.combat} />
        </Section>

        {site.tips && site.tips.length > 0 && (
          <Section title="Tips">
            <ul className="list-disc space-y-0.5 pl-4 text-sm text-zinc-400">
              {site.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A legend tag that doubles as a hide/show toggle for matching cards. */
function FilterToggle({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={active ? "Show these sites" : "Hide these sites"}
      className={`flex items-center gap-1.5 rounded px-1 py-0.5 transition ${
        className ?? ""
      } ${active ? "line-through opacity-40" : "hover:opacity-80"}`}
    >
      {children}
    </button>
  );
}

export function ExplorationPage() {
  const [open, setOpen] = useState<Site | null>(null);
  // Exclusion filters, as tokens: `danger:<level>`, `sec:<Sec>`, `esc`. A card
  // is hidden if it matches any active token — clicking a legend tag toggles it.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (token: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  const visible = (s: Site) =>
    !hidden.has(`danger:${s.danger}`) &&
    !(hidden.has("esc") && s.escalation === "Yes") &&
    // Security is multi-valued: only hide when *all* of a card's spaces are
    // excluded — hiding Low+Null still shows a site that's also in Highsec.
    !s.sec.every((x) => hidden.has(`sec:${x}`));
  const anyVisible = GROUPS.some((g) => g.sites.some(visible));

  return (
    <Page>
      <PageHeader
        title="Exploration sites"
        subtitle="Combat anomalies and the scannable relic / data / DED / gas sites — where they spawn, whether they bite, and which ones escalate. Click any card for its loot and damage-to-deal-vs-tank. Signatures aren't in ESI (they're scanned in-game), so this is a static guide, not your live scan."
      />

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
        <span className="text-[10px] uppercase tracking-wide text-zinc-600">
          Click a tag to hide
        </span>
        <FilterToggle
          active={hidden.has("danger:safe")}
          onClick={() => toggle("danger:safe")}
          className="text-emerald-400"
        >
          <ShieldCheck size={13} /> Unguarded
        </FilterToggle>
        <FilterToggle
          active={hidden.has("danger:moderate")}
          onClick={() => toggle("danger:moderate")}
          className="text-amber-400"
        >
          <Shield size={13} /> Rats / scaling
        </FilterToggle>
        <FilterToggle
          active={hidden.has("danger:high")}
          onClick={() => toggle("danger:high")}
          className="text-rose-400"
        >
          <Skull size={13} /> Dangerous
        </FilterToggle>
        <FilterToggle
          active={hidden.has("esc")}
          onClick={() => toggle("esc")}
          className="text-amber-300"
        >
          <TrendingUp size={13} /> Escalates
        </FilterToggle>
        {hidden.size > 0 && (
          <button
            onClick={() => setHidden(new Set())}
            className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-800"
          >
            Reset
          </button>
        )}
        <span className="ml-auto flex gap-1">
          {(["High", "Low", "Null", "WH"] as Sec[]).map((s) => (
            <button
              key={s}
              onClick={() => toggle(`sec:${s}`)}
              title={`Hide ${s} sites`}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                SEC_STYLE[s]
              } ${
                hidden.has(`sec:${s}`)
                  ? "line-through opacity-40"
                  : "hover:opacity-80"
              }`}
            >
              {s}
            </button>
          ))}
        </span>
      </div>

      {!anyVisible && (
        <p className="mt-7 text-sm text-zinc-500">
          Every site is filtered out — clear a tag above (or Reset) to bring
          them back.
        </p>
      )}

      {GROUPS.map((g) => {
        const sites = g.sites.filter(visible);
        if (sites.length === 0) return null;
        return (
          <section key={g.title} className="mt-7">
            <div className="flex items-baseline gap-2">
              <h2 className="text-lg font-semibold text-zinc-100">{g.title}</h2>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                {g.scanned ? "Scan with probes" : "No scanning"}
              </span>
            </div>
            <p className="mt-1 max-w-3xl text-xs text-zinc-500">{g.blurb}</p>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {sites.map((s) => (
                <SiteCard key={s.name} site={s} onOpen={setOpen} />
              ))}
            </div>
          </section>
        );
      })}

      <p className="mt-8 max-w-3xl text-xs text-zinc-600">
        Only DED-rated complexes and faction combat sites escalate — relic, data
        and plain combat anomalies never do. In wormhole space everything is
        Sleeper-guarded and there's no local, so treat every site as hostile.
      </p>

      {open && <SiteDetail site={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}
