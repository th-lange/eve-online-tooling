import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UseMutationResult } from "@tanstack/react-query";
import {
  CapGauge,
  PricePanel,
  TankResists,
  TankResistsPanel,
} from "./StatsPanels";
import type { CapStats, FitPrice, TankStats } from "../../lib/api";

function cap(overrides: Partial<CapStats>): CapStats {
  return {
    capacity: 5000,
    rechargeSeconds: 300,
    peakRecharge: 20,
    drain: 10,
    stable: true,
    stablePct: 80,
    depletionSeconds: null,
    trajectory: [],
    ...overrides,
  };
}

describe("CapGauge", () => {
  it("labels a stable cap with text, not just color", () => {
    render(<CapGauge cap={cap({ stable: true, stablePct: 62 })} />);
    expect(screen.getByText(/Stable/)).toBeInTheDocument();
    expect(screen.getByText(/62%/)).toBeInTheDocument();
  });

  it("labels a draining cap with the time-to-empty, not just color", () => {
    render(
      <CapGauge
        cap={cap({ stable: false, stablePct: null, depletionSeconds: 125 })}
      />,
    );
    expect(screen.getByText(/Empties in/)).toBeInTheDocument();
    expect(screen.queryByText(/Stable/)).not.toBeInTheDocument();
  });
});

function tank(overrides: Partial<TankStats>): TankStats {
  return {
    shieldHp: 5000,
    armorHp: 4000,
    hullHp: 3000,
    ehp: 12000,
    shieldResists: [0, 0.4, 0.5, 0.6],
    armorResists: [0.5, 0.45, 0.25, 0.1],
    hullResists: [0, 0, 0, 0],
    shieldRepS: 0,
    armorRepS: 0,
    shieldRepSSustained: 0,
    armorRepSSustained: 0,
    shieldRrm: 1,
    armorRrm: 1,
    hullRrm: 1,
    rahActive: false,
    passiveShieldS: 0,
    ...overrides,
  };
}

describe("TankResists", () => {
  it("shows the dedicated (effective) HP for a layer against a damage type on hover", () => {
    render(<TankResists tank={tank({})} />);

    // Shield vs Kinetic: 5000 hp / (1 - 0.5) = 10000 effective HP.
    expect(
      screen.getByTitle("Shield vs Kin: 10,000 effective HP (50% resisted)"),
    ).toBeInTheDocument();
    // Armor vs EM: 4000 hp / (1 - 0.5) = 8000 effective HP.
    expect(
      screen.getByTitle("Armor vs EM: 8,000 effective HP (50% resisted)"),
    ).toBeInTheDocument();
    // Hull has no resists — effective HP equals raw HP.
    expect(
      screen.getByTitle("Hull vs EM: 3,000 effective HP (0% resisted)"),
    ).toBeInTheDocument();
  });
});

describe("TankResistsPanel", () => {
  it("shows EHP broken out per damage type instead of an incoming-damage picker", () => {
    render(<TankResistsPanel skillLabel="all V" tank={tank({})} />);

    // No more "Incoming damage" selector.
    expect(screen.queryByText("Incoming damage")).not.toBeInTheDocument();

    // EHP by damage type: shield + armor + hull effective HP, each
    // assuming 100% of the damage is that one type.
    // EM:  5000/(1-0)   + 4000/(1-0.5)  + 3000/(1-0) = 16000
    // Th:  5000/(1-0.4) + 4000/(1-0.45) + 3000       = 18606
    // Kin: 5000/(1-0.5) + 4000/(1-0.25) + 3000       = 18333
    // Exp: 5000/(1-0.6) + 4000/(1-0.1)  + 3000       = 19944
    expect(screen.getByText("16,000")).toBeInTheDocument();
    expect(screen.getByText("18,606")).toBeInTheDocument();
    expect(screen.getByText("18,333")).toBeInTheDocument();
    expect(screen.getByText("19,944")).toBeInTheDocument();
  });

  it("renders the section in its own bordered box, like the Vitals headline", () => {
    render(<TankResistsPanel skillLabel="all V" tank={tank({})} />);
    const box = screen.getByText("Tank (all V)").closest("div");
    expect(box?.className).toContain("rounded-lg");
    expect(box?.className).toContain("border");
  });
});

function priceMutation(
  overrides: Partial<UseMutationResult<FitPrice, Error, void, unknown>>,
): UseMutationResult<FitPrice, Error, void, unknown> {
  return {
    data: undefined,
    error: null,
    isPending: false,
    isError: false,
    mutate: vi.fn(),
    ...overrides,
  } as unknown as UseMutationResult<FitPrice, Error, void, unknown>;
}

describe("PricePanel", () => {
  it("renders nothing extra when idle with no result yet", () => {
    render(<PricePanel price={priceMutation({})} />);
    expect(screen.queryByText(/Couldn't price fit/)).not.toBeInTheDocument();
  });

  it("surfaces the error instead of silently reverting to the idle button (#1101)", () => {
    render(
      <PricePanel
        price={priceMutation({
          isError: true,
          error: new Error("no market data for region"),
        })}
      />,
    );
    expect(
      screen.getByText(/Couldn't price fit:.*no market data for region/),
    ).toBeInTheDocument();
  });
});
