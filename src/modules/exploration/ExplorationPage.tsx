import { Shield, ShieldCheck, Skull, TrendingUp } from "lucide-react";

// A curated reference for EVE exploration content — combat anomalies and the
// scannable relic / data / DED / gas sites. This is static knowledge (site
// types, spawns, danger and escalations aren't in ESI or the SDE), so it's a
// hand-maintained guide rather than anything fetched.

type Sec = "High" | "Low" | "Null" | "WH";
type Danger = "safe" | "moderate" | "high";

interface Site {
  name: string;
  /** Security bands where this shows up. */
  sec: Sec[];
  danger: Danger;
  /** One-line "who's shooting at you". */
  enemies: string;
  escalation: "None" | "Yes";
  escalationNote?: string;
  /** How you run it / what you get. */
  notes: string;
}

interface Group {
  title: string;
  blurb: string;
  /** Whether these appear in the probe scanner without probes. */
  scanned: boolean;
  sites: Site[];
}

const GROUPS: Group[] = [
  {
    title: "Combat anomalies",
    blurb:
      "Pirate-faction combat sites that show in the probe scanner immediately — no scanning needed. Ratting / ISK farming.",
    scanned: false,
    sites: [
      {
        name: "Faction anomalies (Refuge → Sanctum/Haven)",
        sec: ["High", "Low", "Null"],
        danger: "moderate",
        enemies:
          "Pirate-faction rats, scaling with security & tier — highsec Refuges are trivial, nullsec Havens/Sanctums are the toughest.",
        escalation: "None",
        notes:
          "Faction (Angel / Blood / Guristas / Sansha / Serpentis) sets the damage & tank to bring. Bounties plus faction loot and tags.",
      },
      {
        name: "Sleeper anomalies (Perimeter / Frontier / Core)",
        sec: ["WH"],
        danger: "high",
        enemies:
          "Sleeper drones — neut, web, target-switch, hit hard. Scale sharply with wormhole class (C1 → C6).",
        escalation: "None",
        notes:
          "No bounties — blue-loot + salvage is the payout. No local chat, so keep d-scan up for hostiles the entire time.",
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
        notes:
          "“Ruined [Faction] … Site”. Null pays far more than highsec. A failed hack fires an alarm — bring a good analyzer + relic rigs.",
      },
      {
        name: "Relic sites (wormhole)",
        sec: ["WH"],
        danger: "high",
        enemies: "Sleeper-guarded — clear or avoid them to reach the cans.",
        escalation: "None",
        notes:
          "Higher value than k-space, but guarded and no local. Best in a cloaky / nullified explorer.",
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
        notes:
          "Highsec data is low-value; null/WH is better. Feeds invention (datacores/decryptors) and the odd faction BPC.",
      },
      {
        name: "Data sites (wormhole)",
        sec: ["WH"],
        danger: "high",
        enemies: "Sleeper-guarded, like wormhole relic sites.",
        escalation: "None",
        notes: "Sleeper-tech data alongside the usual datacores and BPCs.",
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
          "Often spawns as an escalation from a faction combat site; the DED loot room drops faction/deadspace modules and BPCs.",
        notes:
          "Acceleration-gated deadspace pockets — the ‘blue loot’ of combat: officer/faction/deadspace modules and BPCs.",
      },
      {
        name: "Unrated faction combat sites",
        sec: ["Low", "Null"],
        danger: "moderate",
        enemies:
          "Faction rats; the final commander spawn is the escalation trigger.",
        escalation: "Yes",
        escalationNote:
          "Killing the commander can start an expedition — a chain of follow-up sites (often nearby systems) with escalating loot.",
        notes:
          "The classic explorer/ratter escalation loop. Follow the expedition in your journal before it expires.",
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
        notes:
          "Booster/Mordu gas in k-space; wormhole Fullerene gas feeds Tech III. Mind the WH spawn timer.",
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

function SiteCard({ site }: { site: Site }) {
  const d = DANGER[site.danger];
  return (
    <div
      className={`rounded-lg border border-zinc-800 border-l-4 bg-zinc-900/40 p-3.5 ${d.accent}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-100">{site.name}</h3>
        {site.escalation === "Yes" && (
          <span
            title={site.escalationNote}
            className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/25"
          >
            <TrendingUp size={11} /> Escalates
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <SecBadges sec={site.sec} />
      </div>

      <div className={`mt-2.5 flex items-start gap-1.5 text-xs ${d.color}`}>
        <d.Icon size={14} className="mt-px shrink-0" />
        <span>{site.enemies}</span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-zinc-400">{site.notes}</p>
    </div>
  );
}

export function ExplorationPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <h1 className="text-2xl font-semibold text-zinc-100">
        Exploration sites
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-zinc-400">
        Combat anomalies and the scannable relic / data / DED / gas sites —
        where they spawn, whether they bite, and which ones escalate. Anomalies
        and signatures aren't in ESI (they're scanned in-game), so this is a
        static guide, not your live scan.
      </p>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400">
        <span className="flex items-center gap-1.5 text-emerald-400">
          <ShieldCheck size={13} /> Unguarded
        </span>
        <span className="flex items-center gap-1.5 text-amber-400">
          <Shield size={13} /> Rats / scaling
        </span>
        <span className="flex items-center gap-1.5 text-rose-400">
          <Skull size={13} /> Dangerous (Sleepers / heavy)
        </span>
        <span className="flex items-center gap-1.5 text-amber-300">
          <TrendingUp size={13} /> Escalates to an expedition
        </span>
        <span className="ml-auto flex gap-1">
          {(["High", "Low", "Null", "WH"] as Sec[]).map((s) => (
            <span
              key={s}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${SEC_STYLE[s]}`}
            >
              {s}
            </span>
          ))}
        </span>
      </div>

      {GROUPS.map((g) => (
        <section key={g.title} className="mt-7">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-semibold text-zinc-100">{g.title}</h2>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              {g.scanned ? "Scan with probes" : "No scanning"}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-xs text-zinc-500">{g.blurb}</p>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {g.sites.map((s) => (
              <SiteCard key={s.name} site={s} />
            ))}
          </div>
        </section>
      ))}

      <p className="mt-8 max-w-3xl text-xs text-zinc-600">
        Only DED-rated complexes and faction combat sites escalate — relic, data
        and plain combat anomalies never do. In wormhole space everything is
        Sleeper-guarded and there's no local, so treat every site as hostile.
      </p>
    </div>
  );
}
