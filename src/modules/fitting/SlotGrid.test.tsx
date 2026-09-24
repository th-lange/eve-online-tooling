import { useEffect, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { SlotGrid } from "./SlotGrid";
import { FitEditorProvider } from "./FitEditorContext";
import { useFitState } from "./useFitEditorContext";
import type { AmmoRow, Fit } from "../../lib/api";

/** Seeds `FitEditorContext` with a fit on mount — `SlotGrid` reads the fit,
 *  resolved layout, names and activatable set through the context now, so
 *  these tests drive it the same way `FittingPage.test.tsx` does (mocked
 *  `invoke` + a fit loaded into the provider) instead of passing it as a
 *  prop directly. */
function Seed({ fit, children }: { fit: Fit; children: ReactNode }) {
  const { setFit } = useFitState();
  useEffect(() => {
    setFit(fit);
  }, [fit, setFit]);
  return <>{children}</>;
}

const LAYOUT = {
  highSlots: 0,
  midSlots: 0,
  lowSlots: 0,
  rigSlots: 0,
  modeSlots: 0,
};
const AMMO: Record<number, AmmoRow> = {
  28668: {
    typeId: 28668,
    name: "Barrage S",
    dps: 150,
    optimal: 2000,
    falloff: 6000,
    tracking: 0.19,
  },
};

function renderGrid(
  fit: Fit,
  layout: typeof LAYOUT,
  opts: {
    ammoStats?: Record<number, AmmoRow>;
    onFitAmmo?: (typeId: number) => void;
    activatableTypes?: number[];
    names?: { id: number; name: string }[];
  } = {},
) {
  mockInvoke({
    fitting_ship_layout: () => layout,
    sde_type_names: () => opts.names ?? [],
    fitting_simulate: () => ({
      activatableTypes: opts.activatableTypes ?? [],
    }),
  });
  return renderWithQuery(
    <FitEditorProvider>
      <Seed fit={fit}>
        <SlotGrid
          onAddToSlot={() => undefined}
          ammoStats={opts.ammoStats}
          onFitAmmo={opts.onFitAmmo}
        />
      </Seed>
    </FitEditorProvider>,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("SlotGrid cargo ammo popover", () => {
  const FIT: Fit = {
    id: "",
    name: "t",
    shipTypeId: 587,
    items: [
      {
        typeId: 28668,
        slot: "cargo",
        index: 0,
        state: "active",
        quantity: 100,
      },
    ],
  };

  it("shows DPS / range / tracking for a cargo ammo with stats", async () => {
    renderGrid(FIT, LAYOUT, {
      ammoStats: AMMO,
      names: [{ id: 28668, name: "Barrage S" }],
    });
    expect(await screen.findByText("On your turrets")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument(); // dps
    expect(screen.getByText("2.0 km")).toBeInTheDocument(); // optimal
    expect(screen.getByText("0.190")).toBeInTheDocument(); // tracking
  });

  it("renders the cargo item but no popover when it has no ammo stats", async () => {
    renderGrid(FIT, LAYOUT, { names: [{ id: 28668, name: "Barrage S" }] });
    expect(await screen.findByText("Barrage S")).toBeInTheDocument();
    expect(screen.queryByText("On your turrets")).toBeNull();
  });

  it("asks to fit an ammo to all weapons on click", async () => {
    const onFitAmmo = vi.fn();
    renderGrid(FIT, LAYOUT, {
      ammoStats: AMMO,
      onFitAmmo,
      names: [{ id: 28668, name: "Barrage S" }],
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /fit to all weapons/i }),
    );
    expect(onFitAmmo).toHaveBeenCalledWith(28668);
  });
});

describe("SlotGrid module state icon", () => {
  const HIGH_MODULE_FIT: Fit = {
    id: "",
    name: "t",
    shipTypeId: 587,
    items: [
      { typeId: 500, slot: "high", index: 0, state: "active", quantity: 1 },
    ],
  };
  const HIGH_LAYOUT = {
    highSlots: 1,
    midSlots: 0,
    lowSlots: 0,
    rigSlots: 0,
    modeSlots: 0,
  };

  it("shows the state and cycles active → overheated on click", async () => {
    renderGrid(HIGH_MODULE_FIT, HIGH_LAYOUT, { activatableTypes: [500] });
    fireEvent.click(
      await screen.findByRole("button", { name: /module state: active/i }),
    );
    expect(
      await screen.findByRole("button", { name: /module state: overheated/i }),
    ).toBeInTheDocument();
  });

  it("cycles backwards on shift-click", async () => {
    renderGrid(HIGH_MODULE_FIT, HIGH_LAYOUT, { activatableTypes: [500] });
    fireEvent.click(
      await screen.findByRole("button", { name: /module state: active/i }),
      { shiftKey: true },
    );
    expect(
      await screen.findByRole("button", { name: /module state: offline/i }),
    ).toBeInTheDocument();
  });
});

describe("SlotGrid always shows drone + cargo banks", () => {
  it("renders empty Drones and Cargo banks", async () => {
    renderGrid({ id: "", name: "t", shipTypeId: 587, items: [] }, LAYOUT);
    expect(await screen.findByText("Drones")).toBeInTheDocument();
    expect(screen.getByText("Cargo")).toBeInTheDocument();
  });
});
