import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintLibrary } from "./components";

describe("BlueprintLibrary import", () => {
  it("shows an unparseable file as an inline error, not a blocking alert (#1196)", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const onImport = vi.fn();
    const { container } = render(
      <BlueprintLibrary owned={[]} imported={[]} onImport={onImport} />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const bad = new File(["{ not json"], "bp.json", {
      type: "application/json",
    });
    // jsdom has no File.text(); the component reads files through it.
    Object.defineProperty(bad, "text", {
      value: () => Promise.resolve("{ not json"),
    });
    fireEvent.change(input, { target: { files: [bad] } });

    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't parse that file as a blueprint library/),
      ).toBeInTheDocument(),
    );
    expect(alertSpy).not.toHaveBeenCalled();
    expect(onImport).not.toHaveBeenCalled();
  });
});
