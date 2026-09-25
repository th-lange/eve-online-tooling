import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
  beforeEach(() => invokeMock.mockReset());

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

    // Root badge: Plasma-only, single-planet.
    expect(await screen.findByText("Plasma")).toBeInTheDocument();
    // Nested P2 row, and its P1 child inlining the P0 dependency instead of
    // a separate bullet.
    expect(screen.getByText("Mechanical Parts")).toBeInTheDocument();
    expect(screen.getByText("Reactive Metals")).toBeInTheDocument();
    expect(screen.getByText(/← Base Metals \(P0\)/)).toBeInTheDocument();
    expect(screen.getByText("40/cycle")).toBeInTheDocument();
    // The P0 leaf itself never gets its own bullet row.
    expect(screen.queryByText("Base Metals", { exact: true })).toBeNull();
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

    await waitFor(() =>
      expect(
        screen.getByText("Needs imports — no single planet"),
      ).toBeInTheDocument(),
    );
    // The empty branch inside the tree also flags itself.
    expect(screen.getByText("Ukomi Superconductors")).toBeInTheDocument();
    expect(screen.getAllByText("needs imports").length).toBeGreaterThan(0);
  });
});
