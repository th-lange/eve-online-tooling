import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { MassProductionPlan } from "../../lib/api";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";

import { MassProductionPage } from "./MassProductionPage";

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
    },
  ],
  groups: [
    {
      groupName: "Mineral",
      categoryName: "Material",
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
    },
  ],
  groups: [
    {
      groupName: "Mineral",
      categoryName: "Material",
      items: [{ typeId: 34, name: "Tritanium", quantity: 100 }],
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
      blueprintNames: [
        "5MN Microwarpdrive II Blueprint",
        "Not A Real Blueprint",
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
      blueprintNames: ["Republic Fleet Gyrostabilizer Blueprint"],
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
});
