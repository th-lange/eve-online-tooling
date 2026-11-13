import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { UniversePage } from "./UniversePage";

const DETAIL = {
  typeId: 34,
  name: "Tritanium",
  description: null,
  mass: null,
  volume: null,
  capacity: null,
  portionSize: null,
  marketGroupId: null,
  published: true,
  basePrice: null,
};

/** Drive the tree down to a single type and select it. */
async function selectType() {
  fireEvent.click(await screen.findByRole("button", { name: /Material/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Mineral/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Tritanium" }));
}

function handlers(over: Record<string, () => unknown>) {
  mockInvoke({
    sde_status: () => ({
      installed: true,
      path: "",
      sizeBytes: 1,
      updated: false,
    }),
    sde_categories: () => [{ id: 4, name: "Material" }],
    sde_groups: () => [{ id: 18, name: "Mineral" }],
    sde_types: () => [{ id: 34, name: "Tritanium" }],
    sde_type_attributes: () => [],
    ...over,
  });
}

beforeEach(() => invokeMock.mockReset());

describe("UniversePage detail pane", () => {
  it("shows the error instead of loading forever when the detail query fails", async () => {
    handlers({
      sde_type_detail: () => {
        throw { kind: "db", message: "sde corrupt" };
      },
    });
    renderWithQuery(<UniversePage />);
    await selectType();
    expect(await screen.findByText(/sde corrupt/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("says the type is missing when the detail resolves null", async () => {
    handlers({ sde_type_detail: () => null });
    renderWithQuery(<UniversePage />);
    await selectType();
    expect(await screen.findByText(/isn't in the SDE/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("shows a failed 'Open in EVE' inline instead of alert()", async () => {
    handlers({
      sde_type_detail: () => DETAIL,
      esi_open_market_window: () => {
        throw { kind: "esi", message: "client not running" };
      },
    });
    renderWithQuery(<UniversePage />);
    await selectType();
    fireEvent.click(await screen.findByRole("button", { name: "Open in EVE" }));
    expect(await screen.findByText(/client not running/)).toBeInTheDocument();
  });
});
