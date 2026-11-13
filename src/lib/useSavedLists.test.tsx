import { beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../test/harness";
import { useTypeIdLists } from "./useSavedLists";

interface Row {
  typeId: number;
  favorite: boolean;
}

function Harness() {
  const [rows, setRows] = useState<Row[]>([
    { typeId: 1, favorite: false },
    { typeId: 2, favorite: false },
  ]);
  const l = useTypeIdLists<Row>("trading", setRows, (r) => r.typeId);
  return (
    <div>
      <div data-testid="rows">
        {rows.map((r) => `${r.typeId}:${r.favorite ? "fav" : "-"}`).join(",")}
      </div>
      <div role="alert">{l.listError}</div>
      <button onClick={() => l.toggleFavorite(rows[0])}>fav</button>
      <button onClick={() => l.blacklistRow(rows[1])}>ban</button>
    </div>
  );
}

beforeEach(() => invokeMock.mockReset());

describe("useTypeIdLists write failures", () => {
  it("reverts an optimistic favorite and exposes the error", async () => {
    mockInvoke({
      trading_get_list: () => [],
      trading_set_list: () => {
        throw { kind: "db", message: "disk full" };
      },
    });
    renderWithQuery(<Harness />);
    fireEvent.click(screen.getByText("fav"));
    // Optimistic flip first, then rolled back once the write rejects.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("disk full"),
    );
    expect(screen.getByTestId("rows")).toHaveTextContent("1:-,2:-");
  });

  it("restores a blacklisted row when the write fails", async () => {
    mockInvoke({
      trading_get_list: () => [],
      trading_set_list: () => {
        throw { kind: "db", message: "disk full" };
      },
    });
    renderWithQuery(<Harness />);
    fireEvent.click(screen.getByText("ban"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("disk full"),
    );
    expect(screen.getByTestId("rows").textContent).toContain("2:-");
  });

  it("keeps the optimistic change when the write succeeds", async () => {
    mockInvoke({ trading_get_list: () => [], trading_set_list: () => null });
    renderWithQuery(<Harness />);
    fireEvent.click(screen.getByText("fav"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("trading_set_list", {
        list: "favorites",
        typeId: 1,
        add: true,
      }),
    );
    expect(screen.getByTestId("rows")).toHaveTextContent("1:fav,2:-");
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });
});
