import { describe, expect, it } from "vitest";
import { mergeListenerCharacters } from "./listenerCharacters";

describe("mergeListenerCharacters", () => {
  it("lists roster names when there are no recent gamelogs", () => {
    expect(
      mergeListenerCharacters([], [{ name: "Alpha" }, { name: "Beta" }]),
    ).toEqual(["Alpha", "Beta"]);
  });

  it("keeps gamelog-only names first and dedupes roster overlap", () => {
    expect(
      mergeListenerCharacters(
        ["Alt Never Logged In", "Alpha"],
        [{ name: "Alpha" }, { name: "Beta" }],
      ),
    ).toEqual(["Alt Never Logged In", "Alpha", "Beta"]);
  });

  it("tolerates a roster or log list that has not loaded", () => {
    expect(mergeListenerCharacters(undefined, undefined)).toEqual([]);
    expect(mergeListenerCharacters(["Alpha"], undefined)).toEqual(["Alpha"]);
  });
});
