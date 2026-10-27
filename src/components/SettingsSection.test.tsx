import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingsSection } from "./SettingsSection";

beforeEach(() => {
  localStorage.clear();
});

describe("SettingsSection", () => {
  it("is expanded by default and shows its children", () => {
    render(
      <SettingsSection id="s1" title="A section">
        <div>child content</div>
      </SettingsSection>,
    );
    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /A section/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("collapses on click, hiding its children", () => {
    render(
      <SettingsSection id="s2" title="Another section">
        <div>child content</div>
      </SettingsSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Another section/ }));

    expect(screen.queryByText("child content")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Another section/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("remembers collapsed state across remounts via localStorage", () => {
    const { unmount } = render(
      <SettingsSection id="s3" title="Remembered">
        <div>child content</div>
      </SettingsSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Remembered/ }));
    unmount();

    render(
      <SettingsSection id="s3" title="Remembered">
        <div>child content</div>
      </SettingsSection>,
    );
    expect(screen.queryByText("child content")).not.toBeInTheDocument();
  });

  it("respects defaultOpen=false for a section never toggled before", () => {
    render(
      <SettingsSection id="s4" title="Closed by default" defaultOpen={false}>
        <div>child content</div>
      </SettingsSection>,
    );
    expect(screen.queryByText("child content")).not.toBeInTheDocument();
  });

  it("renders an optional description", () => {
    render(
      <SettingsSection id="s5" title="With description" description="hint text">
        <div>child content</div>
      </SettingsSection>,
    );
    expect(screen.getByText("hint text")).toBeInTheDocument();
  });
});
