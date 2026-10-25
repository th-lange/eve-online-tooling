import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { WhenField } from "./WhenField";

/** Wire WhenField exactly like a real form does — `onChange` feeds back into
 *  `value` — so the controlled round trip (and the mid-edit NaN case) is
 *  actually exercised. `onChange` spy observes every emission. */
function Harness({
  initial,
  onChange,
}: {
  initial: number;
  onChange: (ms: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <WhenField
      value={value}
      onChange={(ms) => {
        setValue(ms);
        onChange(ms);
      }}
    />
  );
}

describe("WhenField", () => {
  it("keeps the date when the time is edited, even through an incomplete value", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={new Date("2099-01-01T08:00").getTime()}
        onChange={onChange}
      />,
    );
    const date = screen.getByLabelText(
      "Reminder date (YYYY-MM-DD)",
    ) as HTMLInputElement;
    const time = screen.getByLabelText(
      "Reminder time (HH:MM)",
    ) as HTMLInputElement;

    fireEvent.change(date, { target: { value: "2099-06-15" } });
    // Type the time through an incomplete (invalid) intermediate state.
    fireEvent.change(time, { target: { value: "09:3" } });
    // The date must NOT have been wiped by the mid-edit NaN.
    expect(date.value).toBe("2099-06-15");
    expect(time.value).toBe("09:3");

    fireEvent.change(time, { target: { value: "09:30" } });
    expect(date.value).toBe("2099-06-15");
    expect(onChange).toHaveBeenLastCalledWith(
      new Date("2099-06-15T09:30").getTime(),
    );
  });

  it("flags an incomplete entry and blocks it with NaN", () => {
    const onChange = vi.fn();
    render(<Harness initial={Date.now()} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Reminder time (HH:MM)"), {
      target: { value: "" },
    });
    expect(Number.isNaN(onChange.mock.lastCall![0])).toBe(true);
    expect(screen.getByText(/Enter a date as YYYY-MM-DD/)).toBeInTheDocument();
  });

  it("a quick offset sets a time roughly that far from now", () => {
    const onChange = vi.fn();
    render(<Harness initial={Date.now()} onChange={onChange} />);
    const before = Date.now();
    fireEvent.click(screen.getByRole("button", { name: "+1h" }));
    const got = onChange.mock.lastCall![0] as number;
    expect(got).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000);
    expect(got).toBeLessThanOrEqual(Date.now() + 60 * 60_000 + 1000);
    // The text fields reflect the offset (resynced from the new value).
    expect(
      (screen.getByLabelText("Reminder date (YYYY-MM-DD)") as HTMLInputElement)
        .value,
    ).not.toBe("");
  });
});
