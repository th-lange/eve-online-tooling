import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModuleErrorBoundary } from "./ErrorBoundary";

let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error("kaboom");
  return <p>recovered</p>;
}

describe("ModuleErrorBoundary", () => {
  it("contains a render error, keeps siblings alive, and can retry", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    shouldThrow = true;
    render(
      <div>
        <p>sidebar</p>
        <ModuleErrorBoundary moduleId="x" title="Thing">
          <Bomb />
        </ModuleErrorBoundary>
      </div>,
    );
    expect(screen.getByText("sidebar")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Thing crashed");
    expect(screen.getByRole("alert")).toHaveTextContent("kaboom");

    shouldThrow = false;
    fireEvent.click(screen.getByText("Reload module"));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
