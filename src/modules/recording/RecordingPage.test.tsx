import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { mockInvoke, renderWithQuery } from "../../test/harness";
import { RecordingProvider } from "./RecordingProvider";
import { RecordingPage } from "./RecordingPage";

describe("RecordingPage", () => {
  it("hosts the full recording configuration", () => {
    localStorage.clear();
    mockInvoke({});
    renderWithQuery(
      <RecordingProvider>
        <RecordingPage />
      </RecordingProvider>,
    );
    expect(
      screen.getByRole("heading", { name: "Recording" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Record fights")).not.toBeChecked();
  });
});
