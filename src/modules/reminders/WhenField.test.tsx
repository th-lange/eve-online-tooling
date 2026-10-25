import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WhenField } from "./WhenField";

describe("WhenField", () => {
  it("reports epoch ms for a typed date + time, and NaN when incomplete", () => {
    const onChange = vi.fn();
    render(
      <WhenField
        value={new Date("2099-01-01T00:00").getTime()}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Reminder date (YYYY-MM-DD)"), {
      target: { value: "2099-06-15" },
    });
    fireEvent.change(screen.getByLabelText("Reminder time (HH:MM)"), {
      target: { value: "09:30" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      new Date("2099-06-15T09:30").getTime(),
    );

    // Blanking the time makes the value invalid (NaN) so submit can be blocked.
    fireEvent.change(screen.getByLabelText("Reminder time (HH:MM)"), {
      target: { value: "" },
    });
    expect(Number.isNaN(onChange.mock.lastCall![0])).toBe(true);
    expect(screen.getByText(/Enter a date as YYYY-MM-DD/)).toBeInTheDocument();
  });

  it("a quick offset sets a time roughly that far from now", () => {
    const onChange = vi.fn();
    render(<WhenField value={Date.now()} onChange={onChange} />);
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "+1h" }));
    const got = onChange.mock.lastCall![0] as number;
    expect(got).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000);
    expect(got).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 1000);
  });
});
