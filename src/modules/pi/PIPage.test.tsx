import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { extractionAdvice, runway, runwayThresholds } from "./balance";
import type { ChainNode, ColonyView, SdeStatus } from "../../lib/api";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { PIPage } from "./PIPage";

const PLASMOID = 1;
const WATER = 2;
const T2_ITEM = 3;

/** Colony where plasmoids (extracted P0) have piled up in storage while the
 * factory is starved of water (also extracted, but storage is empty and the
 * balance is running a deficit). */
function colony(overrides: Partial<ColonyView> = {}): ColonyView {
  return {
    characterId: 1,
    characterName: "Test Pilot",
    planetId: 1,
    systemId: 1,
    systemName: "Jita",
    planetType: "gas",
    upgradeLevel: 3,
    pinCount: 6,
    extractors: [
      {
        productTypeId: PLASMOID,
        product: "Plasmoids",
        qtyPerCycle: 1000,
        cycleTime: 3600,
        installTime: null,
        expiryTime: null,
      },
      {
        productTypeId: WATER,
        product: "Water",
        qtyPerCycle: 1000,
        cycleTime: 3600,
        installTime: null,
        expiryTime: null,
      },
    ],
    storage: [
      {
        name: "Storage Facility",
        usedVolume: 9500,
        capacity: 10000,
        contents: [
          { typeId: PLASMOID, name: "Plasmoids", amount: 9000, volume: 9000 },
          { typeId: WATER, name: "Water", amount: 0, volume: 0 },
        ],
      },
    ],
    balance: [
      // Plasmoids: extracted faster than the factory consumes -> net positive,
      // and it's already sitting on a huge stockpile.
      {
        typeId: PLASMOID,
        name: "Plasmoids",
        producedPerHour: 1000,
        consumedPerHour: 400,
        net: 600,
      },
      // Water: extracted, but the factory eats more than comes in and there's
      // zero buffer left.
      {
        typeId: WATER,
        name: "Water",
        producedPerHour: 200,
        consumedPerHour: 400,
        net: -200,
      },
      {
        typeId: T2_ITEM,
        name: "T2 Item",
        producedPerHour: 10,
        consumedPerHour: 0,
        net: 10,
      },
    ],
    produced: [],
    notes: "",
    targetProducts: [],
    needsAttention: false,
    ...overrides,
  };
}

describe("extractionAdvice", () => {
  it("ranks a near-empty, deficit input above the raw net-negative amount alone", () => {
    const { short } = extractionAdvice(colony());
    expect(short[0]?.typeId).toBe(WATER);
    expect(short[0]?.stock).toBe(0);
    expect(short[0]?.runwayHours).toBe(0);
  });

  it("flags an extracted commodity as banking once it's piled up in storage, even without consulting net alone", () => {
    const { over } = extractionAdvice(colony());
    const plasmoids = over.find((r) => r.typeId === PLASMOID);
    expect(plasmoids).toBeDefined();
    expect(plasmoids?.stock).toBe(9000);
  });

  it("still flags banking when net is roughly zero but the stockpile dominates storage", () => {
    const c = colony({
      balance: [
        {
          typeId: PLASMOID,
          name: "Plasmoids",
          producedPerHour: 400,
          consumedPerHour: 400,
          net: 0,
        },
      ],
    });
    const { over } = extractionAdvice(c);
    expect(over.map((r) => r.typeId)).toContain(PLASMOID);
  });

  it("does not flag a non-extracted product as something to ease off", () => {
    const { over } = extractionAdvice(colony());
    expect(over.map((r) => r.typeId)).not.toContain(T2_ITEM);
  });
});

describe("runway", () => {
  it("reports surplus for a net-positive balance (no countdown)", () => {
    const r = runway(0, 50);
    expect(r.label).toBe("▲ surplus");
    expect(r.tone).toContain("emerald");
  });

  it("reports steady at break-even (net ~ 0)", () => {
    expect(runway(1000, 0).label).toBe("steady");
  });

  it("calls a deficit with no stock empty and red", () => {
    const r = runway(0, -200);
    expect(r.label).toBe("empty");
    expect(r.tone).toContain("rose");
  });

  it("computes hours of stock left for a buffered deficit", () => {
    // 1600 units at -80/h = 20h left -> amber (< 24h, >= 6h).
    const r = runway(1600, -80);
    expect(r.label).toBe("20h");
    expect(r.tone).toContain("amber");
  });

  it("flags a near-empty deficit red (< 6h left)", () => {
    // 100 units at -50/h = 2h.
    const r = runway(100, -50);
    expect(r.label).toBe("2h");
    expect(r.tone).toContain("rose");
  });

  it("stays calm when well-buffered (>= 24h left)", () => {
    // 9000 units at -200/h = 45h -> 1d 21h, neutral tone.
    const r = runway(9000, -200);
    expect(r.label).toBe("1d 21h");
    expect(r.tone).toContain("zinc");
  });

  it("shows minutes under an hour and never rounds to zero", () => {
    // 10 units at -600/h = 0.0167h -> 1m (floor guarded to 1).
    expect(runway(10, -600).label).toBe("1m");
    // 300 units at -600/h = 0.5h -> 30m.
    expect(runway(300, -600).label).toBe("30m");
  });

  it("never renders 24h — rounds up into days", () => {
    // 23.7h worth of stock rounds to a clean 1d, not 24h.
    expect(runway(237, -10).label).toBe("1d");
  });
});

describe("runwayThresholds", () => {
  const NOW = Date.parse("2026-01-01T00:00:00Z");
  const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

  it("keys off the soonest future extractor expiry (red = that window, amber = 2×)", () => {
    const c = colony({
      extractors: [
        {
          productTypeId: 1,
          product: "A",
          qtyPerCycle: 0,
          cycleTime: 0,
          installTime: null,
          expiryTime: inHours(30),
        },
        {
          productTypeId: 2,
          product: "B",
          qtyPerCycle: 0,
          cycleTime: 0,
          installTime: null,
          expiryTime: inHours(10),
        },
      ],
    });
    expect(runwayThresholds(c, NOW)).toEqual({ redHours: 10, amberHours: 20 });
  });

  it("ignores already-expired programs, using the soonest still in the future", () => {
    const c = colony({
      extractors: [
        {
          productTypeId: 1,
          product: "A",
          qtyPerCycle: 0,
          cycleTime: 0,
          installTime: null,
          expiryTime: inHours(-5),
        },
        {
          productTypeId: 2,
          product: "B",
          qtyPerCycle: 0,
          cycleTime: 0,
          installTime: null,
          expiryTime: inHours(8),
        },
      ],
    });
    expect(runwayThresholds(c, NOW)).toEqual({ redHours: 8, amberHours: 16 });
  });

  it("falls back to fixed 6h/24h when no program has a future expiry", () => {
    // The default fixture's extractors have null expiry.
    expect(runwayThresholds(colony(), NOW)).toEqual({
      redHours: 6,
      amberHours: 24,
    });
  });

  it("drives runway urgency: the same 8h runway reads red under a 10h-expiry cadence but amber under fallback", () => {
    // 800 units at -100/h = 8h of stock.
    const cadence = { redHours: 10, amberHours: 20 };
    expect(runway(800, -100, cadence).tone).toContain("rose"); // 8h < 10h → red
    expect(runway(800, -100).tone).toContain("amber"); // 8h in fallback [6,24) → amber
  });
});

const SDE_INSTALLED: SdeStatus = {
  installed: true,
  path: "/tmp/sde.sqlite",
  sizeBytes: 1,
  updated: false,
};

// Robotics-shaped chain: Plasma-only, exercising the nested tree + a P1
// node's inline "← <P0> (P0)" resource line.
const ROBOTICS_CHAIN: ChainNode = {
  typeId: 9848,
  name: "Robotics",
  tier: 3,
  qtyPerCycle: 0,
  planetTypes: ["Plasma"],
  children: [
    {
      typeId: 3689,
      name: "Mechanical Parts",
      tier: 2,
      qtyPerCycle: 10,
      planetTypes: ["Barren", "Plasma"],
      children: [
        {
          typeId: 2398,
          name: "Reactive Metals",
          tier: 1,
          qtyPerCycle: 40,
          planetTypes: ["Barren", "Gas", "Lava", "Plasma", "Storm"],
          children: [
            {
              typeId: 2267,
              name: "Base Metals",
              tier: 0,
              qtyPerCycle: 0,
              planetTypes: ["Barren", "Gas", "Lava", "Plasma", "Storm"],
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

// Nano-Factory-shaped chain: the P4 target has no single-planet option, and
// one of its P3 branches (Ukomi Superconductors) is itself empty too.
const NANO_FACTORY_CHAIN: ChainNode = {
  typeId: 2869,
  name: "Nano-Factory",
  tier: 4,
  qtyPerCycle: 0,
  planetTypes: [],
  children: [
    {
      typeId: 2360,
      name: "Industrial Explosives",
      tier: 3,
      qtyPerCycle: 6,
      planetTypes: ["Temperate"],
      children: [],
    },
    {
      typeId: 17136,
      name: "Ukomi Superconductors",
      tier: 3,
      qtyPerCycle: 6,
      planetTypes: [],
      children: [],
    },
  ],
};

describe("PIPage Planner tab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
  });

  it("searches via Combo and renders a single-planet badge with the nested chain tree", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_production_chain: () => ROBOTICS_CHAIN,
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));

    // Root badge: Plasma-only, single-planet (several rows also badge
    // "Plasma" since every node in this fixture includes it — scope to the
    // header row specifically).
    const header = (await screen.findByDisplayValue("Robotics")).closest(
      ".pr-6",
    ) as HTMLElement;
    expect(within(header).getByText("Plasma")).toBeInTheDocument();
    // Nested P2 row, and its P1 child inlining the P0 dependency instead of
    // a separate bullet.
    expect(screen.getByText("Mechanical Parts")).toBeInTheDocument();
    expect(screen.getByText("Reactive Metals")).toBeInTheDocument();
    expect(screen.getByText(/← Base Metals \(P0\)/)).toBeInTheDocument();
    expect(screen.getByText("40/cycle")).toBeInTheDocument();
    // The P0 leaf itself never gets its own name row — just a badge row.
    expect(screen.queryByText("Base Metals", { exact: true })).toBeNull();
  });

  it("does not duplicate a P1's planet-type badges in a separate P0 row", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_production_chain: () => ROBOTICS_CHAIN,
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));
    await screen.findByText("Mechanical Parts");

    // Storm/Gas/Lava only appear in Reactive Metals' (P1) own planetTypes —
    // its P0 child Base Metals has the identical set by construction (a
    // P1's planetTypes is already its P0 input's set), so it must not get a
    // second copy of the same badges on its own row.
    expect(screen.getAllByText("Storm")).toHaveLength(1);
    expect(screen.getAllByText("Gas")).toHaveLength(1);
    expect(screen.getAllByText("Lava")).toHaveLength(1);
  });

  it("colors planet-type badges by tier: T1 blue, T2 green, T3 yellow", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_production_chain: () => ROBOTICS_CHAIN,
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));

    // Root (Robotics) is P3 → yellow.
    const rootRow = (await screen.findByDisplayValue("Robotics")).closest(
      ".pr-6",
    ) as HTMLElement;
    expect(within(rootRow).getByText("Plasma").className).toContain(
      "bg-yellow-900/40",
    );
    // Mechanical Parts is P2 → green.
    const p2Row = (await screen.findByText("Mechanical Parts")).closest("div")!;
    expect(within(p2Row).getByText("Plasma").className).toContain(
      "bg-emerald-900/40",
    );
    // Reactive Metals is P1 → blue.
    const p1Row = (await screen.findByText("Reactive Metals")).closest("div")!;
    expect(within(p1Row).getByText("Plasma").className).toContain(
      "bg-sky-900/40",
    );
  });

  it("shows a 'needs imports' notice for a commodity with no single-planet option", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 2869, name: "Nano-Factory" }],
      pi_production_chain: () => NANO_FACTORY_CHAIN,
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "nano" },
    });
    fireEvent.click(
      await screen.findByText("Nano-Factory", {}, { timeout: 2000 }),
    );

    // Both the root (Nano-Factory) and the empty branch (Ukomi
    // Superconductors) flag "needs imports" — at least 2 instances.
    await waitFor(() =>
      expect(
        screen.getAllByText("Needs imports — no single planet").length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(screen.getByText("Ukomi Superconductors")).toBeInTheDocument();
  });

  it("remembers a planned commodity across a full remount", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_production_chain: () => ROBOTICS_CHAIN,
    });
    const first = renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));
    await screen.findByText("Mechanical Parts");

    // Simulate navigating away and back: unmount entirely (a fresh
    // QueryClient too, via a brand-new renderWithQuery call) rather than
    // just re-rendering, so this proves localStorage persistence and not a
    // React Query cache hit.
    first.unmount();
    renderWithQuery(<PIPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));

    expect(await screen.findByText("Mechanical Parts")).toBeInTheDocument();
  });

  it("tolerates a pick saved before the imports field existed, without crashing", async () => {
    // Simulates real stale localStorage from before #971: a pick stored
    // with no `imports` key at all.
    localStorage.setItem(
      "pi.plannerPicks",
      JSON.stringify([
        {
          id: 9848,
          name: "Robotics",
          notes: "",
          systemId: null,
          systemName: null,
          planetId: null,
          planetName: null,
        },
      ]),
    );
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      pi_production_chain: () => ROBOTICS_CHAIN,
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));

    expect(await screen.findByText("Mechanical Parts")).toBeInTheDocument();
  });

  it("Clear all removes every planned chain", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_production_chain: () => ROBOTICS_CHAIN,
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));
    await screen.findByText("Mechanical Parts");

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    expect(screen.queryByText("Mechanical Parts")).not.toBeInTheDocument();
    expect(screen.getByText(/pick a p1-p4 commodity/i)).toBeInTheDocument();
  });

  it("plans multiple commodities at once, each removable independently", async () => {
    const ALL = [
      { id: 9848, name: "Robotics" },
      { id: 2869, name: "Nano-Factory" },
    ];
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: (args) => {
        const { query } = args as { query: string };
        return ALL.filter((c) =>
          c.name.toLowerCase().includes(query.toLowerCase()),
        );
      },
      pi_production_chain: (args) => {
        const { typeId } = args as { typeId: number };
        return typeId === 9848 ? ROBOTICS_CHAIN : NANO_FACTORY_CHAIN;
      },
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    const search1 = screen.getByPlaceholderText(/search a p1-p4 commodity/i);

    fireEvent.change(search1, { target: { value: "robo" } });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));
    await screen.findByText("Mechanical Parts");

    // The Combo remounts (fresh key) after every add, so re-query it fresh
    // rather than reuse the now-detached input from before.
    const search2 = screen.getByPlaceholderText(/search a p1-p4 commodity/i);
    fireEvent.change(search2, { target: { value: "nano" } });
    fireEvent.click(
      await screen.findByText("Nano-Factory", {}, { timeout: 2000 }),
    );

    // Both chains render together — nothing was replaced.
    expect(
      await screen.findByText("Ukomi Superconductors"),
    ).toBeInTheDocument();
    expect(screen.getByText("Mechanical Parts")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Robotics from planner" }),
    );
    expect(screen.queryByText("Mechanical Parts")).not.toBeInTheDocument();
    expect(screen.getByText("Ukomi Superconductors")).toBeInTheDocument();
  });

  it("marks a chain material as imported from another planned colony, pruning its own sub-tree", async () => {
    const ALL = [
      { id: 9848, name: "Robotics" },
      { id: 3689, name: "Mechanical Parts" },
    ];
    const MECHANICAL_PARTS_CHAIN: ChainNode = {
      typeId: 3689,
      name: "Mechanical Parts",
      tier: 2,
      qtyPerCycle: 0,
      planetTypes: ["Barren", "Plasma"],
      children: [
        {
          typeId: 2398,
          name: "Reactive Metals",
          tier: 1,
          qtyPerCycle: 40,
          planetTypes: ["Barren", "Gas", "Lava", "Plasma", "Storm"],
          children: [
            {
              typeId: 2267,
              name: "Base Metals",
              tier: 0,
              qtyPerCycle: 0,
              planetTypes: ["Barren", "Gas", "Lava", "Plasma", "Storm"],
              children: [],
            },
          ],
        },
      ],
    };
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: (args) => {
        const { query } = args as { query: string };
        return ALL.filter((c) =>
          c.name.toLowerCase().includes(query.toLowerCase()),
        );
      },
      pi_production_chain: (args) => {
        const { typeId } = args as { typeId: number };
        return typeId === 9848 ? ROBOTICS_CHAIN : MECHANICAL_PARTS_CHAIN;
      },
      pi_planner_setup_save: () => ({
        id: "multi-colony",
        name: "Multi colony",
        items: [],
      }),
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    const search1 = screen.getByPlaceholderText(/search a p1-p4 commodity/i);
    fireEvent.change(search1, { target: { value: "robo" } });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));
    await screen.findByText("Reactive Metals");

    const search2 = screen.getByPlaceholderText(/search a p1-p4 commodity/i);
    fireEvent.change(search2, { target: { value: "mechanical" } });
    fireEvent.click(
      await screen.findByRole(
        "option",
        { name: "Mechanical Parts" },
        { timeout: 2000 },
      ),
    );

    const roboticsCard = screen
      .getByRole("button", { name: "Remove Robotics from planner" })
      .closest("div.relative") as HTMLElement;
    const mechPartsCard = (
      await screen.findByRole("button", {
        name: "Remove Mechanical Parts from planner",
      })
    ).closest("div.relative") as HTMLElement;

    // Robotics' own chain still shows Mechanical Parts' full sub-tree
    // until it's marked as imported.
    expect(
      within(roboticsCard).getByText("Reactive Metals"),
    ).toBeInTheDocument();

    fireEvent.click(
      within(roboticsCard).getByRole("button", {
        name: /Import from Mechanical Parts/,
      }),
    );

    // Pruned: the sub-tree under the now-imported node is gone from
    // Robotics' own render — it's already accounted for under the
    // producing pick's own chain.
    expect(
      within(roboticsCard).queryByText("Reactive Metals"),
    ).not.toBeInTheDocument();
    expect(within(roboticsCard).getByText(/Imported/)).toBeInTheDocument();

    // Reciprocal hint on the producing pick's own card.
    expect(within(mechPartsCard).getByText(/Exported to/)).toBeInTheDocument();

    // The link survives into a saved setup's payload.
    fireEvent.click(screen.getByRole("button", { name: /save setup/i }));
    fireEvent.change(screen.getByPlaceholderText(/^setup — /i), {
      target: { value: "Multi colony" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "pi_planner_setup_save",
        expect.objectContaining({
          name: "Multi colony",
          items: expect.arrayContaining([
            expect.objectContaining({ typeId: 9848, imports: [3689] }),
          ]),
        }),
      ),
    );
  });

  it("saves per-plan notes on blur", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_production_chain: () => ROBOTICS_CHAIN,
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));
    await screen.findByText("Mechanical Parts");

    const notes = screen.getByPlaceholderText(/notes — what you're building/i);
    fireEvent.change(notes, { target: { value: "build for hub restock" } });
    fireEvent.blur(notes);

    expect(notes).toHaveValue("build for hub restock");
  });

  it("assigns a solar system and planet to a plan", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_production_chain: () => ROBOTICS_CHAIN,
      route_system_search: () => [{ id: 30000142, name: "Jita" }],
      pi_planets_in_system: () => [
        { id: 40009077, name: "Jita I", planetType: "Barren" },
        { id: 40009082, name: "Jita IV", planetType: "Gas" },
      ],
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));
    await screen.findByText("Mechanical Parts");

    fireEvent.change(screen.getByPlaceholderText("Solar system…"), {
      target: { value: "jita" },
    });
    fireEvent.click(await screen.findByText("Jita", {}, { timeout: 2000 }));

    const planetSelect = await screen.findByLabelText("Planet");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pi_planets_in_system", {
        systemId: 30000142,
      }),
    );
    // Each option shows the planet's own type alongside its name.
    expect(
      await screen.findByRole("option", { name: "Jita IV (Gas)" }),
    ).toBeInTheDocument();

    fireEvent.change(planetSelect, { target: { value: "40009082" } });

    expect((planetSelect as HTMLSelectElement).value).toBe("40009082");
  });

  it("auto-names a pick from System · Planet · Product once assigned, and lets it be overridden", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_production_chain: () => ROBOTICS_CHAIN,
      route_system_search: () => [{ id: 30000142, name: "Jita" }],
      pi_planets_in_system: () => [
        { id: 40009082, name: "Jita IV", planetType: "Gas" },
      ],
      pi_planner_setup_save: () => ({
        id: "jita-robotics",
        name: "Jita Robotics",
        items: [],
      }),
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));

    // Before any system/planet is picked, the name is just the product.
    expect(await screen.findByDisplayValue("Robotics")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Solar system…"), {
      target: { value: "jita" },
    });
    fireEvent.click(await screen.findByText("Jita", {}, { timeout: 2000 }));
    const planetSelect = await screen.findByLabelText("Planet");
    await screen.findByRole("option", { name: "Jita IV (Gas)" });
    fireEvent.change(planetSelect, { target: { value: "40009082" } });

    // Once System + Planet are both set, the name auto-updates to the
    // "System · Planet · Product" default.
    const nameInput = await screen.findByDisplayValue(
      "Jita · Jita IV · Robotics",
    );

    // Still freely editable — typing over it stores a real override.
    fireEvent.change(nameInput, { target: { value: "Main Robotics line" } });
    fireEvent.blur(nameInput);

    expect(
      await screen.findByDisplayValue("Main Robotics line"),
    ).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("Jita · Jita IV · Robotics"),
    ).not.toBeInTheDocument();

    // The custom name survives into a saved setup's payload.
    fireEvent.click(screen.getByRole("button", { name: /save setup/i }));
    fireEvent.change(screen.getByPlaceholderText(/^setup — /i), {
      target: { value: "Jita Robotics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "pi_planner_setup_save",
        expect.objectContaining({
          name: "Jita Robotics",
          items: expect.arrayContaining([
            expect.objectContaining({
              typeId: 9848,
              label: "Main Robotics line",
            }),
          ]),
        }),
      ),
    );
  });

  it("saves the current picks as a named setup", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_production_chain: () => ROBOTICS_CHAIN,
      pi_planner_setup_save: () => ({
        id: "jita-industry",
        name: "Jita industry",
        items: [],
      }),
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.change(screen.getByPlaceholderText(/search a p1-p4 commodity/i), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));
    await screen.findByText("Mechanical Parts");

    fireEvent.click(screen.getByRole("button", { name: /save setup/i }));
    fireEvent.change(screen.getByPlaceholderText(/^setup — /i), {
      target: { value: "Jita industry" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "pi_planner_setup_save",
        expect.objectContaining({ name: "Jita industry" }),
      ),
    );
    expect(screen.getByText("Saved ✓")).toBeInTheDocument();
  });

  it("browses, loads and deletes a saved setup", async () => {
    const SAVED = {
      id: "jita-industry",
      name: "Jita industry",
      items: [
        {
          typeId: 9848,
          name: "Robotics",
          notes: "from a saved setup",
          systemId: 30000142,
          systemName: "Jita",
          planetId: 40009082,
          planetName: "Jita IV",
          imports: [],
        },
      ],
    };
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [],
      pi_locked_get: () => [],
      pi_planner_setups: () => [SAVED],
      pi_production_chain: () => ROBOTICS_CHAIN,
      pi_planets_in_system: () => [],
      pi_planner_setup_delete: () => undefined,
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Planner" }));
    fireEvent.click(screen.getByRole("button", { name: "Setups" }));

    expect(await screen.findByText("Jita industry")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Jita industry"));

    // Loading replaces the working plan with the setup's items.
    await screen.findByText("Mechanical Parts");
    expect(
      screen.getByText(/from a saved setup/i, { selector: "textarea" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Setups" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Jita industry" }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pi_planner_setup_delete", {
        id: "jita-industry",
      }),
    );
  });
});

describe("PIPage Colonies tab — notes & target products", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
  });

  it("renders a colony's saved notes and target-product chips", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [
        colony({
          notes: "Building Robotics here for the T2 module run.",
          targetProducts: [{ typeId: 9848, name: "Robotics" }],
        }),
      ],
      pi_locked_get: () => [],
    });
    renderWithQuery(<PIPage />);

    expect(
      await screen.findByDisplayValue(
        "Building Robotics here for the T2 module run.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Robotics")).toBeInTheDocument();
  });

  it("saves notes on blur and merges the result without refetching", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [colony()],
      pi_locked_get: () => [],
      pi_colony_note_set: () => ({
        characterId: 1,
        planetId: 1,
        notes: "stage 1: extractors, stage 2: factories",
        targetProducts: [],
      }),
    });
    renderWithQuery(<PIPage />);

    const textarea = await screen.findByPlaceholderText(
      /what are you building here/i,
    );
    fireEvent.change(textarea, {
      target: { value: "stage 1: extractors, stage 2: factories" },
    });
    fireEvent.blur(textarea);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pi_colony_note_set", {
        characterId: 1,
        planetId: 1,
        notes: "stage 1: extractors, stage 2: factories",
        targetProductTypeIds: [],
      }),
    );
    expect(
      await screen.findByDisplayValue(
        "stage 1: extractors, stage 2: factories",
      ),
    ).toBeInTheDocument();
  });

  it("adds a target product via the picker", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [colony()],
      pi_locked_get: () => [],
      sde_search_pi_commodities: () => [{ id: 9848, name: "Robotics" }],
      pi_colony_note_set: () => ({
        characterId: 1,
        planetId: 1,
        notes: "",
        targetProducts: [{ typeId: 9848, name: "Robotics" }],
      }),
    });
    renderWithQuery(<PIPage />);

    await screen.findByText("Jita");
    fireEvent.change(screen.getByPlaceholderText("Add target product…"), {
      target: { value: "robo" },
    });
    fireEvent.click(await screen.findByText("Robotics", {}, { timeout: 2000 }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pi_colony_note_set", {
        characterId: 1,
        planetId: 1,
        notes: "",
        targetProductTypeIds: [9848],
      }),
    );
    expect(await screen.findByText("Robotics")).toBeInTheDocument();
  });

  it("removes a target product chip", async () => {
    mockInvoke({
      sde_status: () => SDE_INSTALLED,
      auth_active_character: () => null,
      pi_overview: () => [
        colony({ targetProducts: [{ typeId: 9848, name: "Robotics" }] }),
      ],
      pi_locked_get: () => [],
      pi_colony_note_set: () => ({
        characterId: 1,
        planetId: 1,
        notes: "",
        targetProducts: [],
      }),
    });
    renderWithQuery(<PIPage />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove Robotics from targets",
      }),
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("pi_colony_note_set", {
        characterId: 1,
        planetId: 1,
        notes: "",
        targetProductTypeIds: [],
      }),
    );
    expect(screen.queryByText("Robotics")).not.toBeInTheDocument();
  });
});
