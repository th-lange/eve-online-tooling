import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RepeatField } from "./RepeatField";

const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;

describe("RepeatField", () => {
  it("emits an interval when enabled (and null when off)", () => {
    const onChange = vi.fn();
    render(<RepeatField value={null} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Repeat this reminder"));
    expect(onChange).toHaveBeenLastCalledWith(DAY); // default 1 day

    fireEvent.change(screen.getByLabelText("Repeat interval"), {
      target: { value: "6" },
    });
    expect(onChange).toHaveBeenLastCalledWith(6 * DAY);

    fireEvent.change(screen.getByLabelText("Repeat unit"), {
      target: { value: "weeks" },
    });
    expect(onChange).toHaveBeenLastCalledWith(6 * WEEK);

    fireEvent.click(screen.getByLabelText("Repeat this reminder"));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("initializes its fields from an existing interval", () => {
    render(<RepeatField value={6 * DAY} onChange={() => {}} />);
    expect(
      (screen.getByLabelText("Repeat interval") as HTMLInputElement).value,
    ).toBe("6");
    expect(
      (screen.getByLabelText("Repeat unit") as HTMLSelectElement).value,
    ).toBe("days");
  });
});
