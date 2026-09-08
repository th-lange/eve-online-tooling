import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SlotGrid } from "./SlotGrid";
import type { AmmoRow, Fit, ModuleState } from "../../lib/api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve([])),
}));

const FIT: Fit = {
  id: "",
  name: "t",
  shipTypeId: 587,
  items: [
    { typeId: 28668, slot: "cargo", index: 0, state: "active", quantity: 100 },
  ],
};
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
  ammoStats?: Record<number, AmmoRow>,
  onFitAmmo?: (typeId: number) => void,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(
    <SlotGrid
      fit={FIT}
      layout={LAYOUT}
      nameOf={(id) => (id === 28668 ? "Barrage S" : String(id))}
      onRemove={() => {}}
      onAddToSlot={() => {}}
      onSetCharge={() => {}}
      onSetChargeForType={() => {}}
      onSetState={() => {}}
      onSetQuantity={() => {}}
      onSetActiveDrones={() => {}}
      rangeOf={new Map()}
      activatable={new Set()}
      ammoStats={ammoStats}
      onFitAmmo={onFitAmmo}
    />,
    { wrapper },
  );
}

describe("SlotGrid cargo ammo popover", () => {
  it("shows DPS / range / tracking for a cargo ammo with stats", () => {
    renderGrid(AMMO);
    expect(screen.getByText("On your turrets")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument(); // dps
    expect(screen.getByText("2.0 km")).toBeInTheDocument(); // optimal
    expect(screen.getByText("0.190")).toBeInTheDocument(); // tracking
  });

  it("renders the cargo item but no popover when it has no ammo stats", () => {
    renderGrid(undefined);
    expect(screen.getByText("Barrage S")).toBeInTheDocument();
    expect(screen.queryByText("On your turrets")).toBeNull();
  });

  it("asks to fit an ammo to all weapons on click", () => {
    const onFitAmmo = vi.fn();
    renderGrid(AMMO, onFitAmmo);
    fireEvent.click(screen.getByTitle(/fit this ammo/i));
    expect(onFitAmmo).toHaveBeenCalledWith(28668);
  });
});

describe("SlotGrid module state icon", () => {
  function renderHighModule(
    onSetState: (index: number, state: ModuleState) => void,
  ) {
    const fit: Fit = {
      id: "",
      name: "t",
      shipTypeId: 587,
      items: [
        { typeId: 500, slot: "high", index: 0, state: "active", quantity: 1 },
      ],
    };
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    return render(
      <SlotGrid
        fit={fit}
        layout={{
          highSlots: 1,
          midSlots: 0,
          lowSlots: 0,
          rigSlots: 0,
          modeSlots: 0,
        }}
        nameOf={(id) => String(id)}
        onRemove={() => {}}
        onAddToSlot={() => {}}
        onSetCharge={() => {}}
        onSetChargeForType={() => {}}
        onSetState={onSetState}
        onSetQuantity={() => {}}
        onSetActiveDrones={() => {}}
        rangeOf={new Map()}
        activatable={new Set([500])}
      />,
      { wrapper },
    );
  }

  it("shows the state and cycles active → overheated on click", () => {
    const onSetState = vi.fn();
    renderHighModule(onSetState);
    fireEvent.click(
      screen.getByRole("button", { name: /module state: active/i }),
    );
    expect(onSetState).toHaveBeenCalledWith(0, "overheated");
  });

  it("cycles backwards on shift-click", () => {
    const onSetState = vi.fn();
    renderHighModule(onSetState);
    fireEvent.click(
      screen.getByRole("button", { name: /module state: active/i }),
      { shiftKey: true },
    );
    expect(onSetState).toHaveBeenCalledWith(0, "offline");
  });
});
