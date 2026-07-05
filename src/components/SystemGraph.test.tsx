import { describe, expect, it } from "vitest";
import { computeLayout, kindFromSecurity } from "./systemGraphLayout";
import type { SystemGraphEdge, SystemGraphNode } from "./SystemGraph";

describe("SystemGraph.computeLayout", () => {
  it("lays a connected chain out in BFS columns from the root", () => {
    const nodes: SystemGraphNode[] = [
      { id: "a", label: "A", kind: "hisec" },
      { id: "b", label: "B", kind: "lowsec" },
      { id: "c", label: "C", kind: "wspace" },
    ];
    const edges: SystemGraphEdge[] = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];
    const pos = computeLayout(nodes, edges, "a");
    // Depth increases left→right along the chain.
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
    expect(pos.get("b")!.x).toBeLessThan(pos.get("c")!.x);
    expect(pos.get("a")).toEqual({ x: 0, y: 0 });
  });

  it("stacks disconnected components rather than overlapping them", () => {
    const nodes: SystemGraphNode[] = [
      { id: "a", label: "A", kind: "hisec" },
      { id: "b", label: "B", kind: "hisec" },
    ];
    // No edges → two separate components at depth 0, different rows.
    const pos = computeLayout(nodes, []);
    expect(pos.get("a")!.x).toBe(pos.get("b")!.x);
    expect(pos.get("a")!.y).not.toBe(pos.get("b")!.y);
  });

  it("positions every node exactly once", () => {
    const nodes: SystemGraphNode[] = [
      { id: "a", label: "A", kind: "hisec" },
      { id: "b", label: "B", kind: "hisec" },
      { id: "c", label: "C", kind: "hisec" },
    ];
    const pos = computeLayout(nodes, [{ source: "a", target: "b" }]);
    expect(pos.size).toBe(3);
  });
});

describe("SystemGraph.kindFromSecurity", () => {
  it("bands security into hi/low/null", () => {
    expect(kindFromSecurity(0.9)).toBe("hisec");
    expect(kindFromSecurity(0.5)).toBe("hisec");
    expect(kindFromSecurity(0.3)).toBe("lowsec");
    expect(kindFromSecurity(0.0)).toBe("nullsec");
    expect(kindFromSecurity(-0.5)).toBe("nullsec");
  });
});
