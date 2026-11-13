import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { LogsPage } from "./LogsPage";
import { logStore } from "../../lib/logStore";

afterEach(() => act(() => logStore.clear()));

describe("LogsPage — frontend + backend merge", () => {
  it("shows entries from both sources in timestamp order, backend records once", () => {
    render(<LogsPage />);
    expect(screen.getByText("No entries.")).toBeInTheDocument();

    act(() => {
      logStore.push({
        ts: 3000,
        level: "error",
        source: "frontend",
        target: "console",
        message: "fe late",
      });
      // The live `logs://entry` push and the startup `logs_list` backfill
      // both deliver backend record 7.
      logStore.push({
        ts: 2000,
        level: "warn",
        source: "backend",
        target: "app::esi",
        message: "be middle",
        backendId: 7,
      });
      logStore.push({
        ts: 2000,
        level: "warn",
        source: "backend",
        target: "app::esi",
        message: "be middle",
        backendId: 7,
      });
      logStore.push({
        ts: 1000,
        level: "error",
        source: "backend",
        target: "app::sde",
        message: "be early",
        backendId: 3,
      });
    });

    expect(screen.getByText("3 entries")).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(
      rows.map((r) => within(r).getByText(/^(fe|be) /).textContent),
    ).toEqual(["be early", "be middle", "fe late"]);
  });

  it("keeps a frontend entry whose id collides with a backend id", () => {
    render(<LogsPage />);
    act(() => {
      logStore.push({
        ts: 1,
        level: "warn",
        source: "backend",
        target: "t",
        message: "backend zero",
        backendId: 0,
      });
      logStore.push({
        ts: 2,
        level: "warn",
        source: "frontend",
        target: "console",
        message: "frontend zero",
      });
    });
    expect(screen.getByText("2 entries")).toBeInTheDocument();
  });
});
