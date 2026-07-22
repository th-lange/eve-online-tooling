import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { FittingPage } from "./FittingPage";
import type { Fit, FitStats, ShipLayout, TypeBrief } from "../../lib/api";

const SDE_OK = { installed: true, path: "/sde", sizeBytes: 1, updated: false };

const RIFTER_LAYOUT: ShipLayout = {
  typeId: 587,
  name: "Rifter",
  groupName: "Frigate",
  highSlots: 3,
  midSlots: 3,
  lowSlots: 4,
  rigSlots: 3,
  subsystemSlots: 0,
  turretHardpoints: 3,
  launcherHardpoints: 2,
  cpuOutput: 130,
  powergridOutput: 41,
  calibration: 400,
  droneBay: 0,
  droneBandwidth: 0,
};

const FIT: Fit = {
  id: "local-1",
  name: "Solo brawl",
  shipTypeId: 587,
  items: [
    {
      typeId: 2456,
      slot: "high",
      index: 0,
      state: "active",
      quantity: 1,
      chargeTypeId: null,
    },
    {
      typeId: 1978,
      slot: "mid",
      index: 0,
      state: "online",
      quantity: 1,
    },
    {
      typeId: 28668,
      slot: "cargo",
      index: 0,
      state: "online",
      quantity: 5,
    },
    {
      typeId: 2185,
      slot: "drone",
      index: 0,
      state: "active",
      quantity: 3,
    },
  ],
  projected: [],
};

const STATS: FitStats = {
  resources: {
    cpuUsed: 40,
    cpuOutput: 130,
    powergridUsed: 20,
    powergridOutput: 41,
    calibrationUsed: 0,
    calibrationOutput: 400,
  },
  validation: [],
  capacitor: {
    capacity: 375,
    rechargeSeconds: 157,
    peakRecharge: 5.9,
    drain: 2.1,
    stable: true,
    stablePct: 71,
    depletionSeconds: null,
    trajectory: [
      [0, 100],
      [60, 71],
    ],
  },
  tank: {
    shieldHp: 300,
    armorHp: 350,
    hullHp: 300,
    ehp: 1200,
    shieldResists: [0, 0, 0, 0],
    armorResists: [0.1, 0.2, 0.3, 0.4],
    hullResists: [0, 0, 0, 0],
    shieldRepS: 0,
    armorRepS: 0,
    passiveShieldS: 0,
  },
  dps: { turret: 45.5, missile: 0, drone: 0, total: 45.5 },
  navigation: {
    maxVelocity: 480,
    alignTime: 3.2,
    agility: 3.0,
    signatureRadius: 35,
  },
  layout: RIFTER_LAYOUT,
  targeting: {
    maxTargets: 4,
    lockRange: 30000,
    scanResolution: 800,
    sensorStrength: [0, 0, 20, 0],
  },
  price: null,
  weaponRanges: [],
  activatableTypes: [2456],
  projectedEw: [],
  droneActive: [null, null, null, 3],
};

const HULL_INFO: TypeBrief[] = [{ id: 587, name: "Rifter", group: "Frigate" }];

function renderFitting(fit: Fit = FIT, stats: FitStats = STATS) {
  mockInvoke({
    sde_status: () => SDE_OK,
    fitting_list_local: () => [fit],
    fitting_esi_list: () => [],
    sde_type_infos: () => HULL_INFO,
    fitting_ship_layout: () => RIFTER_LAYOUT,
    sde_type_names: () => [
      { id: 587, name: "Rifter" },
      { id: 2456, name: "125mm Gatling AutoCannon II" },
      { id: 1978, name: "5MN Microwarpdrive II" },
      { id: 28668, name: "Nanite Repair Paste" },
      { id: 2185, name: "Hobgoblin II" },
    ],
    fitting_simulate: () => stats,
    fitting_delete_local: () => undefined,
    fitting_import_eft: () => ({ ...fit, id: "", name: "Imported fit" }),
    fitting_optimize: () => ({ fit, capStable: true, withinBudget: true }),
    market_regions: () => [],
  });
  return renderWithQuery(<FittingPage />);
}

async function loadTheFit() {
  const select = await screen.findByLabelText(/Fits \(/);
  await waitFor(() =>
    expect(select.querySelectorAll("option").length).toBeGreaterThan(1),
  );
  const option = [...select.querySelectorAll("option")].find((o) =>
    o.textContent?.includes("Solo brawl"),
  )!;
  fireEvent.change(select, { target: { value: option.value } });
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("FittingPage", () => {
  it("loads a fit and shows hull identity, vitals, and the banked slot rack", async () => {
    renderFitting();
    await loadTheFit();

    // Hull identity (#709): render + name + class, fit name as the heading.
    expect(await screen.findByText("Solo brawl")).toBeInTheDocument();
    expect(screen.getByText("Rifter · Frigate")).toBeInTheDocument();
    const render = screen.getByAltText("");
    expect(render).toHaveAttribute(
      "src",
      "https://images.evetech.net/types/587/render?size=64",
    );

    // Vitals headline (#708): DPS / EHP / Capacitor / Speed.
    expect(screen.getByText("DPS")).toBeInTheDocument();
    expect(screen.getByText("46")).toBeInTheDocument(); // 45.5 -> toFixed(0)
    expect(screen.getByText("1,200")).toBeInTheDocument(); // EHP
    expect(screen.getByText("71%")).toBeInTheDocument(); // stable cap %
    expect(screen.getByText("stable")).toBeInTheDocument();
    expect(screen.getByText("480 m/s")).toBeInTheDocument(); // speed

    // Banked slot rack with occupancy (#709): High/Mid occupied, Rig empty but shown.
    const highBank = screen.getByText("High").closest("div")!;
    expect(within(highBank).getByText("1/3")).toBeInTheDocument();
    const rigBank = screen.getByText("Rig").closest("div")!;
    expect(within(rigBank).getByText("0/3")).toBeInTheDocument();
    expect(screen.getByText("125mm Gatling AutoCannon II")).toBeInTheDocument();
  });

  it("collapses EFT import behind a button and imports on demand (#710)", async () => {
    renderFitting();
    await loadTheFit();
    await screen.findByText("Solo brawl");

    // Not visible until opened.
    expect(screen.queryByPlaceholderText(/paste an EFT fit/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Import EFT" }));
    const textarea = screen.getByPlaceholderText(/paste an EFT fit/);
    fireEvent.change(textarea, { target: { value: "[Rifter, test]" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fitting_import_eft", {
        text: "[Rifter, test]",
      }),
    );
  });

  it("collapses the optimizer behind a button and runs it on demand (#710)", async () => {
    renderFitting();
    await loadTheFit();
    await screen.findByText("Solo brawl");

    // The optimizer's controls aren't in the document until opened.
    expect(screen.queryByText("Objective")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Optimize…/ }));
    expect(screen.getByText("Objective")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Optimize" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "fitting_optimize",
        expect.objectContaining({ objective: "tank", mode: "all" }),
      ),
    );
  });

  it("guards Delete behind a confirm step (#711)", async () => {
    renderFitting();
    await loadTheFit();
    await screen.findByText("Solo brawl");

    const deleteButton = screen.getByRole("button", {
      name: "Delete this fit",
    });
    fireEvent.click(deleteButton);
    expect(screen.getByText("Delete for good?")).toBeInTheDocument();
    // Not called yet — only confirming deletes.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "fitting_delete_local",
      expect.anything(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fitting_delete_local", {
        id: "local-1",
      }),
    );
    // Deleting clears the editor back to the empty state.
    expect(
      await screen.findByText(/Pick a hull, load a saved\/in-game fit/),
    ).toBeInTheDocument();
  });

  it("groups Export EFT and Save to EVE under an overflow menu (#711)", async () => {
    renderFitting();
    await loadTheFit();
    await screen.findByText("Solo brawl");

    expect(screen.queryByText("Export EFT")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const menu = screen.getByText("Export EFT").closest("div")!;
    expect(within(menu).getByText("Save to EVE")).toBeInTheDocument();
  });

  it("edits an existing cargo stack's quantity in place", async () => {
    renderFitting();
    await loadTheFit();
    await screen.findByText("Nanite Repair Paste");

    // The redundant "x5" text suffix is suppressed in favor of the live stepper.
    expect(screen.queryByText(/Nanite Repair Paste x5/)).toBeNull();
    const row = within(screen.getByText("Nanite Repair Paste").closest("li")!);
    const qtyInput = row.getByRole("spinbutton", { name: "Quantity" });
    expect(qtyInput).toHaveValue(5);

    fireEvent.click(row.getByRole("button", { name: "Increase quantity" }));
    expect(qtyInput).toHaveValue(6);

    fireEvent.click(row.getByRole("button", { name: "Decrease quantity" }));
    fireEvent.click(row.getByRole("button", { name: "Decrease quantity" }));
    expect(qtyInput).toHaveValue(4);

    fireEvent.change(qtyInput, { target: { value: "50" } });
    expect(qtyInput).toHaveValue(50);

    // Decrementing never goes below 1, and the control is client-side only —
    // no backend round-trip for a plain quantity edit.
    fireEvent.change(qtyInput, { target: { value: "1" } });
    fireEvent.click(row.getByRole("button", { name: "Decrease quantity" }));
    expect(qtyInput).toHaveValue(1);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "fitting_set_quantity",
      expect.anything(),
    );
  });

  it("activates/deactivates a fitted drone stack via its stars (#712)", async () => {
    renderFitting();
    await loadTheFit();
    await screen.findByText("Hobgoblin II");

    const stars = screen.getAllByRole("button", {
      name: /Set active drones to/,
    });
    expect(stars).toHaveLength(3);

    invokeMock.mockClear();
    // All 3 are active (from stats.droneActive); clicking star 2 (<= current
    // active) decrements toward it, leaving 1 active.
    fireEvent.click(stars[1]);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "fitting_simulate",
        expect.objectContaining({
          fit: expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({ typeId: 2185, activeDrones: 1 }),
            ]),
          }),
        }),
      ),
    );
  });

  it("caps drone stars to the hull's bandwidth limit, not the fitted quantity or the 5-in-space max (#712)", async () => {
    const cappedFit: Fit = {
      ...FIT,
      items: FIT.items.map((it) =>
        it.typeId === 2185 ? { ...it, quantity: 5 } : it,
      ),
    };
    const cappedStats: FitStats = {
      ...STATS,
      droneActive: [null, null, null, 2],
      droneMaxActive: [null, null, null, 2],
    };
    renderFitting(cappedFit, cappedStats);
    await loadTheFit();
    await screen.findByText("Hobgoblin II");

    // 5 are fitted and 5-in-space would normally allow up to 5, but this
    // hull's drone bandwidth only supports 2 of this type — only 2 stars.
    const stars = screen.getAllByRole("button", {
      name: /Set active drones to/,
    });
    expect(stars).toHaveLength(2);
  });
});
