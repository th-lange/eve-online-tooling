import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithQuery } from "../test/harness";
import { Combo } from "./Combo";

const ITEMS = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Alps" },
  { id: 3, name: "Alder" },
];

function setup(value: { id: number; name: string } | null = null) {
  const onPick = vi.fn();
  renderWithQuery(
    <Combo
      label="System"
      scope="t"
      value={value}
      onPick={onPick}
      search={async () => ITEMS}
    />,
  );
  return onPick;
}

async function open() {
  const input = screen.getByRole("combobox", { name: "System" });
  fireEvent.change(input, { target: { value: "Al" } });
  await screen.findByRole("listbox");
  return input;
}

describe("Combo keyboard", () => {
  it("navigates with arrows and picks with Enter", async () => {
    const onPick = setup();
    const input = await open();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getAllByRole("option")[0].id,
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(ITEMS[1]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape and reopens when typing resumes", async () => {
    setup();
    const input = await open();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(input, { target: { value: "Alp" } });
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
  });

  it("closes when focus leaves the combo", async () => {
    setup();
    const input = await open();
    input.focus();
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("picks with the mouse", async () => {
    const onPick = setup();
    await open();
    fireEvent.click(screen.getByRole("option", { name: "Alder" }));
    expect(onPick).toHaveBeenCalledWith(ITEMS[2]);
  });

  it("labels the clear button for assistive tech", () => {
    const onPick = setup({ id: 1, name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Clear System" }));
    expect(onPick).toHaveBeenCalledWith(null);
  });
});
