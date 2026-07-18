import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { ShoppingList } from "../../lib/api";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";

import { ShoppingPage } from "./ShoppingPage";

const LISTS: ShoppingList[] = [
  {
    id: "default",
    name: "Default",
    removable: false,
    items: [{ typeId: 34, name: "Tritanium", quantity: 100 }],
  },
];

const setQuantityCalls = () =>
  invokeMock.mock.calls.filter((c) => c[0] === "shopping_set_quantity");

beforeEach(() => {
  invokeMock.mockReset();
  mockInvoke({ shopping_lists: () => LISTS });
});

describe("ShoppingPage quantity editing", () => {
  it("commits once on blur instead of persisting every keystroke", async () => {
    renderWithQuery(<ShoppingPage />);
    const input = await screen.findByLabelText("Quantity of Tritanium");

    // Simulate typing "2500" digit by digit — nothing may persist yet.
    for (const partial of ["2", "25", "250", "2500"]) {
      fireEvent.change(input, { target: { value: partial } });
    }
    expect(setQuantityCalls()).toHaveLength(0);

    fireEvent.blur(input);
    expect(setQuantityCalls()).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("shopping_set_quantity", {
      id: "default",
      typeId: 34,
      quantity: 2500,
    });
  });

  it("does not persist 0 when the field is cleared", async () => {
    renderWithQuery(<ShoppingPage />);
    const input = await screen.findByLabelText("Quantity of Tritanium");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    // Empty draft reverts to the saved quantity — no invoke at all.
    expect(setQuantityCalls()).toHaveLength(0);
    expect(input).toHaveValue(100);
  });

  it("commits on Enter and skips no-op commits", async () => {
    renderWithQuery(<ShoppingPage />);
    const input = await screen.findByLabelText("Quantity of Tritanium");

    // Re-entering the saved value is a no-op.
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.blur(input);
    expect(setQuantityCalls()).toHaveLength(0);

    // Enter commits by blurring the field, so it must actually hold focus.
    (input as HTMLInputElement).focus();
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setQuantityCalls()).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("shopping_set_quantity", {
      id: "default",
      typeId: 34,
      quantity: 7,
    });
  });
});
