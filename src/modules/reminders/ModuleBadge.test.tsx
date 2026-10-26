import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const goToRoute = vi.fn();
const openColonyInPi = vi.fn();
vi.mock("../../lib/deepLink", () => ({
  goToRoute: (...a: unknown[]) => goToRoute(...a),
  openColonyInPi: (...a: unknown[]) => openColonyInPi(...a),
}));

import { ModuleBadge } from "./ModuleBadge";
import type { Reminder } from "./reminders";

const reminder = (over: Partial<Reminder>): Reminder => ({
  id: "r1",
  category: "other",
  what: "w",
  note: "",
  dueAt: 0,
  ...over,
});

beforeEach(() => {
  goToRoute.mockReset();
  openColonyInPi.mockReset();
});

describe("ModuleBadge", () => {
  it("navigates to the module (and focuses a linked PI colony) on click", () => {
    const onNavigate = vi.fn();
    render(
      <ModuleBadge
        reminder={reminder({
          category: "pi",
          link: { moduleId: "pi", planetId: 42 },
        })}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Planetary Interaction/ }),
    );
    expect(goToRoute).toHaveBeenCalledWith("/pi");
    expect(openColonyInPi).toHaveBeenCalledWith(42);
    expect(onNavigate).toHaveBeenCalled();
  });

  it("maps a plain category with no link to its module (no colony focus)", () => {
    render(<ModuleBadge reminder={reminder({ category: "production" })} />);
    fireEvent.click(screen.getByRole("button", { name: /Production/ }));
    expect(goToRoute).toHaveBeenCalledWith("/production");
    expect(openColonyInPi).not.toHaveBeenCalled();
  });

  it("renders a non-clickable label for an 'Other' reminder", () => {
    render(<ModuleBadge reminder={reminder({ category: "other" })} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });
});
