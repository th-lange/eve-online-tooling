import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecordingProvider } from "./RecordingProvider";
import { RecordingPage } from "./RecordingPage";

describe("RecordingPage", () => {
  it("hosts the full recording configuration", () => {
    localStorage.clear();
    render(
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
