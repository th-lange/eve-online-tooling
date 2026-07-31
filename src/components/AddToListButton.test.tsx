import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../test/harness";
import { AddToListButton } from "./AddToListButton";

const LISTS = [{ id: "l1", name: "Shopping", items: [] }];

beforeEach(() => {
  invokeMock.mockReset();
});

describe("AddToListButton", () => {
  it("shows the failure and keeps the popover open when adding fails", async () => {
    mockInvoke({
      shopping_lists: () => LISTS,
      shopping_add_item: () => {
        throw "list deleted";
      },
    });
    renderWithQuery(<AddToListButton typeId={34} />);

    fireEvent.click(screen.getByRole("button", { name: /add to list/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Shopping" }));

    expect(await screen.findByText(/list deleted/i)).toBeInTheDocument();
    // Still open (the list entry is visible), and no success badge.
    expect(
      screen.getByRole("button", { name: "Shopping" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/added to/i)).not.toBeInTheDocument();
  });

  it("closes and confirms on a successful add", async () => {
    mockInvoke({
      shopping_lists: () => LISTS,
      shopping_add_item: () => null,
    });
    renderWithQuery(<AddToListButton typeId={34} />);

    fireEvent.click(screen.getByRole("button", { name: /add to list/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Shopping" }));

    expect(await screen.findByText(/added to shopping/i)).toBeInTheDocument();
  });
});
