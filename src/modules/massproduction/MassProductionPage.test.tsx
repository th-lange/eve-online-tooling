import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { MassProductionPlan } from "../../lib/api";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";

import { MassProductionPage } from "./MassProductionPage";
import { AssetsPage } from "../assets/AssetsPage";

const SDE_OK = { installed: true, path: "/sde", sizeBytes: 1, updated: false };

const PLAN: MassProductionPlan = {
  unresolvedNames: ["Not A Real Blueprint"],
  matchedBlueprints: [
    {
      name: "5MN Microwarpdrive II Blueprint",
      typeId: 1073,
      ownedCopies: 30,
      totalRuns: 300,
      assumed: null,
      tier: "Tech II",
    },
  ],
  groups: [
    {
      categoryName: "Mineral",
      items: [{ typeId: 11399, name: "Morphite", quantity: 5010 }],
    },
  ],
};

const HYPOTHETICAL_PLAN: MassProductionPlan = {
  unresolvedNames: [],
  matchedBlueprints: [
    {
      name: "Republic Fleet Gyrostabilizer Blueprint",
      typeId: 2000,
      ownedCopies: 0,
      totalRuns: 1,
      assumed: { runs: 1, materialEfficiency: 0, specialEdition: true },
      tier: "Faction",
    },
  ],
  groups: [
    {
      categoryName: "Mineral",
      items: [{ typeId: 34, name: "Tritanium", quantity: 100 }],
    },
  ],
};

const MWD_PLAN: MassProductionPlan = {
  unresolvedNames: [],
  matchedBlueprints: [
    {
      name: "5MN Microwarpdrive II Blueprint",
      typeId: 1073,
      ownedCopies: 30,
      totalRuns: 300,
      assumed: null,
      tier: "Tech II",
    },
  ],
  groups: [
    {
      categoryName: "Mineral",
      items: [{ typeId: 11399, name: "Morphite", quantity: 5010 }],
    },
  ],
};

async function pasteAndImport(text: string) {
  fireEvent.click(
    await screen.findByRole("button", { name: "Paste blueprint names" }),
  );
  const textarea = screen.getByPlaceholderText(/paste blueprint names/);
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("MassProductionPage", () => {
  it("surfaces unresolved names and renders grouped materials", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => PLAN,
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport(
      "5MN Microwarpdrive II Blueprint\nNot A Real Blueprint",
    );

    expect(await screen.findByText(/Not A Real Blueprint/)).toBeInTheDocument();
    expect(
      screen.getByText("5MN Microwarpdrive II Blueprint"),
    ).toBeInTheDocument();
    expect(screen.getByText("Mineral")).toBeInTheDocument();
    expect(screen.getByText("Morphite")).toBeInTheDocument();

    expect(invokeMock).toHaveBeenCalledWith("massprod_plan", {
      lines: [
        { name: "5MN Microwarpdrive II Blueprint", buildRuns: null },
        { name: "Not A Real Blueprint", buildRuns: null },
      ],
      mode: "owned",
      hypotheticalConfig: { t1Runs: 1, t1Me: 10, t2Me: 2 },
    });
  });

  it("switches to Hypothetical mode, sends the config, and flags special-edition items", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => HYPOTHETICAL_PLAN,
    });
    renderWithQuery(<MassProductionPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Hypothetical" }),
    );
    // The settings row only shows up in Hypothetical mode.
    expect(screen.getByText("T1 assumed runs")).toBeInTheDocument();

    await pasteAndImport("Republic Fleet Gyrostabilizer Blueprint");

    expect(
      await screen.findByText("Republic Fleet Gyrostabilizer Blueprint"),
    ).toBeInTheDocument();
    expect(screen.getByText("Special edition · ME0")).toBeInTheDocument();

    expect(invokeMock).toHaveBeenCalledWith("massprod_plan", {
      lines: [
        { name: "Republic Fleet Gyrostabilizer Blueprint", buildRuns: null },
      ],
      mode: "hypothetical",
      hypotheticalConfig: { t1Runs: 1, t1Me: 10, t2Me: 2 },
    });
  });

  it("saves a group as a new shopping list", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => PLAN,
      shopping_create_list: () => ({
        id: "morphite-run",
        name: "Morphite run",
        removable: true,
        items: [],
      }),
      shopping_add_item: () => undefined,
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport("5MN Microwarpdrive II Blueprint");
    await screen.findByText("Mineral");

    fireEvent.click(
      screen.getByRole("button", { name: "Save as new shopping list…" }),
    );
    const nameInput = screen.getByPlaceholderText(/Mineral/);
    fireEvent.change(nameInput, { target: { value: "Morphite run" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("shopping_create_list", {
        name: "Morphite run",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("shopping_add_item", {
        id: "morphite-run",
        typeId: 11399,
        quantity: 5010,
      }),
    );
    expect(await screen.findByText("Saved ✓")).toBeInTheDocument();
  });

  it("subtracts owned stock at a picked location, showing only what's still needed", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => PLAN,
      assets_load: () => ({
        rows: [
          {
            typeId: 11399,
            name: "Morphite",
            quantity: 5000,
            sellPrice: 1000,
            buyPrice: 900,
            sellValue: 5_000_000,
            buyValue: 4_500_000,
            volume: 5000,
            category: "Material",
            group: "Mineral",
            owner: "Alt One",
            isCorp: false,
            locationId: 60003760,
            station: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
            solarSystem: "Jita",
          },
        ],
        roots: [],
        sellTotal: 5_000_000,
        buyTotal: 4_500_000,
        volumeTotal: 5000,
      }),
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport("5MN Microwarpdrive II Blueprint");
    await screen.findByText("Mineral");
    expect(screen.getByText("5,010")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load owned stock" }));
    await screen.findByRole("button", { name: "Reload stock" });

    fireEvent.change(
      screen.getByTitle(
        "Subtract what the roster already has stocked at a location",
      ),
      {
        target: {
          value: "60003760",
        },
      },
    );

    // The table shows the full accounting: need 5,010, have 5,000, buy 10.
    expect(await screen.findByText("10")).toBeInTheDocument();
    expect(screen.getByText("5,010")).toBeInTheDocument();
    expect(screen.getByText("5,000")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "To buy" }),
    ).toBeInTheDocument();
  });

  it("keeps a fully covered material listed at 0 to buy instead of dropping it", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => PLAN,
      assets_load: () => ({
        rows: [
          {
            typeId: 11399,
            name: "Morphite",
            quantity: 6000,
            sellPrice: 1000,
            buyPrice: 900,
            sellValue: 6_000_000,
            buyValue: 5_400_000,
            volume: 6000,
            category: "Material",
            group: "Mineral",
            owner: "Alt One",
            isCorp: false,
            locationId: 60003760,
            station: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
            solarSystem: "Jita",
          },
        ],
        roots: [],
        sellTotal: 6_000_000,
        buyTotal: 5_400_000,
        volumeTotal: 6000,
      }),
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport("5MN Microwarpdrive II Blueprint");
    await screen.findByText("Mineral");
    fireEvent.click(screen.getByRole("button", { name: "Load owned stock" }));
    await screen.findByRole("button", { name: "Reload stock" });
    fireEvent.change(
      screen.getByTitle(
        "Subtract what the roster already has stocked at a location",
      ),
      { target: { value: "60003760" } },
    );

    expect(await screen.findByText("6,000")).toBeInTheDocument();
    expect(screen.getByText("5,010")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("loads stock in the background with a wait signal when the location picker is focused", async () => {
    const { promise: assetsPromise, resolve: resolveAssets } =
      Promise.withResolvers<unknown>();
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => PLAN,
      assets_load: () => assetsPromise,
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport("5MN Microwarpdrive II Blueprint");
    await screen.findByText("Mineral");

    const select = screen.getByTitle(
      "Subtract what the roster already has stocked at a location",
    ) as HTMLSelectElement;
    expect(invokeMock).not.toHaveBeenCalledWith("assets_load");

    fireEvent.focus(select);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("assets_load"));
    expect(select.options[0].textContent).toBe("Loading stock…");
    expect(
      screen.getByRole("button", { name: "Loading stock…" }),
    ).toBeInTheDocument();

    resolveAssets({
      rows: [
        {
          typeId: 11399,
          name: "Morphite",
          quantity: 5000,
          sellPrice: 1000,
          buyPrice: 900,
          sellValue: 5_000_000,
          buyValue: 4_500_000,
          volume: 5000,
          category: "Material",
          group: "Mineral",
          owner: "Alt One",
          isCorp: false,
          locationId: 60003760,
          station: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
          solarSystem: "Jita",
        },
      ],
      roots: [],
      sellTotal: 5_000_000,
      buyTotal: 4_500_000,
      volumeTotal: 5000,
    });

    await screen.findByRole("option", {
      name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    });
    expect(select.options[0].textContent).toBe("All locations — full quantity");
    expect(
      screen.queryByRole("button", { name: "Loading stock…" }),
    ).not.toBeInTheDocument();
  });

  it("sees locations the Assets page already loaded, without a separate fetch", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => PLAN,
      auth_characters: () => [],
      auth_active_character: () => null,
      assets_load: () => ({
        rows: [
          {
            typeId: 11399,
            name: "Morphite",
            quantity: 5000,
            sellPrice: 1000,
            buyPrice: 900,
            sellValue: 5_000_000,
            buyValue: 4_500_000,
            volume: 5000,
            category: "Material",
            group: "Mineral",
            owner: "Alt One",
            isCorp: false,
            locationId: 60003760,
            station: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
            solarSystem: "Jita",
          },
        ],
        roots: [],
        sellTotal: 5_000_000,
        buyTotal: 4_500_000,
        volumeTotal: 5000,
      }),
    });
    renderWithQuery(
      <>
        <AssetsPage />
        <MassProductionPage />
      </>,
    );

    // The Assets page auto-loads on mount (no click needed there either) —
    // wait for its own "Refresh" button to confirm the shared query landed.
    await screen.findByRole("button", { name: "Refresh" });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("assets_load"));

    await pasteAndImport("5MN Microwarpdrive II Blueprint");
    await screen.findByText("Mineral");

    // Never clicked "Load owned stock" here — the picker is already
    // populated from the Assets page's load, sharing one cache entry.
    fireEvent.change(
      screen.getByTitle(
        "Subtract what the roster already has stocked at a location",
      ),
      { target: { value: "60003760" } },
    );

    expect(await screen.findByText("10")).toBeInTheDocument();
  });

  it("groups the matched blueprints by tech tier", async () => {
    const TIERED_PLAN: MassProductionPlan = {
      unresolvedNames: [],
      matchedBlueprints: [
        {
          name: "Widget I Blueprint",
          typeId: 998,
          ownedCopies: 5,
          totalRuns: 5,
          assumed: null,
          tier: "Tech I",
        },
        MWD_PLAN.matchedBlueprints[0],
      ],
      groups: [],
    };
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => TIERED_PLAN,
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport("Widget I Blueprint\n5MN Microwarpdrive II Blueprint");

    expect(await screen.findByText("Tech I")).toBeInTheDocument();
    expect(screen.getByText("Tech II")).toBeInTheDocument();
    expect(screen.getByText("Widget I Blueprint")).toBeInTheDocument();
    expect(
      screen.getByText("5MN Microwarpdrive II Blueprint"),
    ).toBeInTheDocument();
  });

  it("edits a blueprint's build-runs and recomputes the plan with the override", async () => {
    const overriddenPlan: MassProductionPlan = {
      ...MWD_PLAN,
      matchedBlueprints: [{ ...MWD_PLAN.matchedBlueprints[0], totalRuns: 50 }],
    };
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: (args) => {
        const { lines } = args as {
          lines: { buildRuns?: number | null }[];
        };
        return lines.some((l) => l.buildRuns === 50)
          ? overriddenPlan
          : MWD_PLAN;
      },
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport("5MN Microwarpdrive II Blueprint");
    const input = await screen.findByLabelText("Runs to build of 1073");
    expect(input).toHaveValue(300);

    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("massprod_plan", {
        lines: [{ name: "5MN Microwarpdrive II Blueprint", buildRuns: 50 }],
        mode: "owned",
        hypotheticalConfig: { t1Runs: 1, t1Me: 10, t2Me: 2 },
      }),
    );
    expect(await screen.findByLabelText("Runs to build of 1073")).toHaveValue(
      50,
    );
  });

  it("removes a blueprint from the build list and recomputes without it", async () => {
    const TWO_BLUEPRINT_PLAN: MassProductionPlan = {
      unresolvedNames: [],
      matchedBlueprints: [
        {
          name: "Widget I Blueprint",
          typeId: 998,
          ownedCopies: 5,
          totalRuns: 5,
          assumed: null,
          tier: "Tech I",
        },
        MWD_PLAN.matchedBlueprints[0],
      ],
      groups: [],
    };
    const AFTER_REMOVE_PLAN: MassProductionPlan = {
      ...MWD_PLAN,
      matchedBlueprints: [MWD_PLAN.matchedBlueprints[0]],
    };
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: (args) => {
        const { lines } = args as { lines: { name: string }[] };
        return lines.some((l) => l.name === "Widget I Blueprint")
          ? TWO_BLUEPRINT_PLAN
          : AFTER_REMOVE_PLAN;
      },
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport("Widget I Blueprint\n5MN Microwarpdrive II Blueprint");
    await screen.findByText("Widget I Blueprint");
    expect(
      screen.getByText("5MN Microwarpdrive II Blueprint"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Widget I Blueprint" }),
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("massprod_plan", {
        lines: [{ name: "5MN Microwarpdrive II Blueprint", buildRuns: null }],
        mode: "owned",
        hypotheticalConfig: { t1Runs: 1, t1Me: 10, t2Me: 2 },
      }),
    );
    expect(screen.queryByText("Widget I Blueprint")).not.toBeInTheDocument();
    expect(
      await screen.findByText("5MN Microwarpdrive II Blueprint"),
    ).toBeInTheDocument();
  });

  it("saves, loads, and deletes a build list", async () => {
    const SAVED_LIST = {
      id: "doctrine",
      name: "Doctrine",
      items: [
        {
          typeId: 1073,
          name: "5MN Microwarpdrive II Blueprint",
          buildRuns: 50,
        },
      ],
    };
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => MWD_PLAN,
      massprod_lists: () => [SAVED_LIST],
      massprod_save_list: () => SAVED_LIST,
      massprod_delete_list: () => undefined,
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport("5MN Microwarpdrive II Blueprint");
    await screen.findByText("Mineral");

    fireEvent.click(screen.getByRole("button", { name: /Save build list/ }));
    const nameInput = screen.getByPlaceholderText(/Build list/);
    fireEvent.change(nameInput, { target: { value: "Doctrine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("massprod_save_list", {
        name: "Doctrine",
        items: [{ typeId: 1073, buildRuns: null }],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Build lists" }));
    const loadButton = await screen.findByTitle(
      'Load "Doctrine" (1 blueprints)',
    );
    fireEvent.click(loadButton);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("massprod_plan", {
        lines: [{ name: "5MN Microwarpdrive II Blueprint", buildRuns: 50 }],
        mode: "owned",
        hypotheticalConfig: { t1Runs: 1, t1Me: 10, t2Me: 2 },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Build lists" }));
    const deleteButton = await screen.findByRole("button", {
      name: "Delete Doctrine",
    });
    fireEvent.click(deleteButton);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("massprod_delete_list", {
        id: "doctrine",
      }),
    );
  });

  it("parses a build-run count on a pasted line and applies it as an override", async () => {
    const overriddenPlan: MassProductionPlan = {
      ...MWD_PLAN,
      matchedBlueprints: [{ ...MWD_PLAN.matchedBlueprints[0], totalRuns: 50 }],
    };
    mockInvoke({
      sde_status: () => SDE_OK,
      massprod_plan: () => overriddenPlan,
    });
    renderWithQuery(<MassProductionPage />);

    await pasteAndImport("5MN Microwarpdrive II Blueprint\t50");

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("massprod_plan", {
        lines: [{ name: "5MN Microwarpdrive II Blueprint", buildRuns: 50 }],
        mode: "owned",
        hypotheticalConfig: { t1Runs: 1, t1Me: 10, t2Me: 2 },
      }),
    );
    expect(await screen.findByLabelText("Runs to build of 1073")).toHaveValue(
      50,
    );
  });

  describe("exporting lists", () => {
    const writeText = vi.fn<(t: string) => Promise<void>>();
    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("copies the current blueprint list with its resolved run counts", async () => {
      mockInvoke({
        sde_status: () => SDE_OK,
        massprod_plan: () => MWD_PLAN,
      });
      renderWithQuery(<MassProductionPage />);

      await pasteAndImport("5MN Microwarpdrive II Blueprint");
      await screen.findByText("Mineral");

      fireEvent.click(screen.getByRole("button", { name: "Copy list" }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(
          "5MN Microwarpdrive II Blueprint\t300",
        ),
      );
    });

    it("copies a saved build list, omitting the count for lines with no override", async () => {
      mockInvoke({
        sde_status: () => SDE_OK,
        massprod_lists: () => [
          {
            id: "doctrine",
            name: "Doctrine",
            items: [
              {
                typeId: 1073,
                name: "5MN Microwarpdrive II Blueprint",
                buildRuns: 50,
              },
              { typeId: 999, name: "Widget I Blueprint", buildRuns: null },
            ],
          },
        ],
      });
      renderWithQuery(<MassProductionPage />);
      await screen.findByRole("button", { name: "Paste blueprint names" });

      fireEvent.click(screen.getByRole("button", { name: "Build lists" }));
      await screen.findByText("Doctrine");
      fireEvent.click(screen.getByRole("button", { name: "Copy Doctrine" }));

      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith(
          "5MN Microwarpdrive II Blueprint\t50\nWidget I Blueprint",
        ),
      );
    });
  });
});
