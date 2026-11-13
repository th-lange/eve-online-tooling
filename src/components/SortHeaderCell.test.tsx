import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SortHeaderCell } from "./SortHeaderCell";

const COL = {
  key: "profit" as const,
  label: "Profit",
  numeric: true,
  description: "Net ISK per run",
};

function renderCell(active = false, dir: "asc" | "desc" = "asc") {
  const onClick = vi.fn();
  render(
    <table>
      <thead>
        <tr>
          <SortHeaderCell
            column={COL}
            active={active}
            dir={dir}
            onClick={onClick}
          />
        </tr>
      </thead>
    </table>,
  );
  return onClick;
}

describe("SortHeaderCell", () => {
  it("exposes the label as a keyboard-operable button with a description", () => {
    const onClick = renderCell();
    const btn = screen.getByRole("button", { name: /Profit/ });
    expect(btn).toHaveAccessibleDescription("Net ISK per run");
    // A real <button> is in the tab order and fires click on Enter/Space.
    btn.focus();
    expect(btn).toHaveFocus();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledWith("profit");
  });

  it("keeps aria-sort on the columnheader", () => {
    renderCell(true, "desc");
    expect(screen.getByRole("columnheader")).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });
});
