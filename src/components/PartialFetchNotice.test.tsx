import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PartialFetchNotice } from "./PartialFetchNotice";

describe("PartialFetchNotice", () => {
  it("lists every failed character in a status region", () => {
    render(<PartialFetchNotice failed={["Alice", "Bob"]} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't load Alice, Bob — showing the rest.",
    );
  });

  it("renders nothing without failures", () => {
    const { container } = render(<PartialFetchNotice failed={[]} />);
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(<PartialFetchNotice failed={undefined} />);
    expect(c2).toBeEmptyDOMElement();
  });
});
