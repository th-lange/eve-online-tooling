import { describe, expect, it } from "vitest";
import { detectDelimiter, pad, parseCsv, serializeCsv } from "./csv";

describe("csv", () => {
  it("round-trips quotes, delimiters and newlines inside cells", () => {
    const rows = [
      ["name", "note"],
      ['say "hi"', "a,b"],
      ["multi\nline", ""],
    ];
    const text = serializeCsv(rows, ",");
    expect(text).toBe('name,note\n"say ""hi""","a,b"\n"multi\nline",\n');
    expect(parseCsv(text, ",")).toEqual(rows);
  });

  it("accepts CRLF and a missing trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty cells and empty rows' width, and treats blank input as no rows", () => {
    expect(parseCsv("a,,c\n,,\n", ",")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
    expect(parseCsv("", ",")).toEqual([]);
  });

  it("sniffs the delimiter from the header line only", () => {
    expect(detectDelimiter("a;b;c\n1,2,3")).toBe(";");
    expect(detectDelimiter("a\tb\n")).toBe("\t");
    expect(detectDelimiter('"a;b",c\n')).toBe(",");
    expect(detectDelimiter("")).toBe(",");
    const text = "x;y\n1;2\n";
    expect(serializeCsv(parseCsv(text, ";"), ";")).toBe(text);
  });

  it("pads ragged rows and guarantees at least one cell", () => {
    expect(pad([["a"], ["b", "c"]])).toEqual([
      ["a", ""],
      ["b", "c"],
    ]);
    expect(pad([])).toEqual([[""]]);
  });
});
