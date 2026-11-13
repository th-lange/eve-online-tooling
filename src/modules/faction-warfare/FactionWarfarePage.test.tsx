import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { FactionWarfarePage } from "./FactionWarfarePage";
import type { FwSystemNode } from "../../lib/api";

function renderPage() {
  return renderWithQuery(
    <MemoryRouter>
      <FactionWarfarePage />
    </MemoryRouter>,
  );
}

function node(
  name: string,
  contested: string,
  id: number,
  occupierId = 500003,
  occupier = "Amarr",
  battlefield = "rearguard",
  vpVelocity: number | null = null,
): FwSystemNode {
  return {
    systemId: id,
    name,
    region: "Devoid",
    warzone: "Amarr–Minmatar",
    security: 0.3,
    owner: occupier,
    occupier,
    ownerId: occupierId,
    occupierId,
    contested,
    vpPct: contested === "uncontested" ? 0 : 0.5,
    kills: 0,
    npcKills: 0,
    jumps: 0,
    battlefield,
    vpVelocity,
    vpDelta30m: null,
    x: id * 1e15,
    z: id * 1e15,
  };
}
const NODES = [
  node("QuietTown", "uncontested", 1),
  node("FightVille", "contested", 2),
  node("VulnBurg", "vulnerable", 3),
  // Minmatar-occupied + contested — lets militia-perspective tests see both
  // "defend" (an Amarr-occupied contested system, from Amarr's perspective)
  // and "push" (this one, from Amarr's perspective) at once.
  node("RebelHold", "contested", 4, 500002, "Minmatar"),
];

// The star map renders system names too, so scope row assertions to the table.
const inTable = () => within(screen.getByRole("table"));

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  mockInvoke({
    intel_fw_stats: () => [],
    intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
    auth_characters: () => [],
    auth_active_character: () => null,
    // Hotspots now fire for any perspective-mode render (heat is always
    // on) — a harmless default so tests that don't care about hotspot
    // data don't spam "query data cannot be undefined" console noise.
    intel_fw_hotspots: () => ({ systems: [] }),
  });
});

describe("FW warzone list filter", () => {
  it("filters the system table by contested / uncontested / all", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(inTable().getByText("FightVille")).toBeInTheDocument();
    expect(inTable().getByText("VulnBurg")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Contested" }));
    await waitFor(() =>
      expect(inTable().queryByText("QuietTown")).not.toBeInTheDocument(),
    );
    expect(inTable().getByText("FightVille")).toBeInTheDocument();
    expect(inTable().getByText("VulnBurg")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Uncontested" }));
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(inTable().queryByText("FightVille")).not.toBeInTheDocument();
    expect(inTable().queryByText("VulnBurg")).not.toBeInTheDocument();

    fireEvent.click(
      within(
        screen.getByText("Show").nextElementSibling as HTMLElement,
      ).getByRole("button", { name: "All" }),
    );
    await waitFor(() =>
      expect(inTable().getByText("FightVille")).toBeInTheDocument(),
    );
    expect(inTable().getByText("QuietTown")).toBeInTheDocument();
    expect(inTable().getByText("VulnBurg")).toBeInTheDocument();
  });
});

describe("FW name filter", () => {
  it("hides non-matching systems from both the table and the map", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(inTable().getByText("FightVille")).toBeInTheDocument();

    const search = screen.getByPlaceholderText("Filter by system name…");
    fireEvent.change(search, { target: { value: "fight" } });

    await waitFor(() =>
      expect(inTable().queryByText("QuietTown")).not.toBeInTheDocument(),
    );
    expect(inTable().getByText("FightVille")).toBeInTheDocument();
    expect(inTable().queryByText("VulnBurg")).not.toBeInTheDocument();
    expect(inTable().queryByText("RebelHold")).not.toBeInTheDocument();
    // Not just the table — "QuietTown" shouldn't appear anywhere on the
    // page (the star map renders node labels too), confirming the map is
    // filtered along with the table.
    expect(screen.queryByText("QuietTown")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(inTable().getByText("VulnBurg")).toBeInTheDocument();
  });

  it("matches case-insensitively", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    const search = screen.getByPlaceholderText("Filter by system name…");
    fireEvent.change(search, { target: { value: "QUIET" } });
    await waitFor(() =>
      expect(inTable().queryByText("FightVille")).not.toBeInTheDocument(),
    );
    expect(inTable().getByText("QuietTown")).toBeInTheDocument();
  });
});

describe("FW playstyle presets (#904)", () => {
  it("Plexing mode hides rearguard systems, seeds a farm-score sort, and stays sortable via the header row", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({
        nodes: [
          // Low farm score (high kills) so it sorts behind AlphaSys once
          // Plexing's farm-score-desc default kicks in, but ahead
          // alphabetically — proves the "System" header click re-sorts.
          {
            ...node("ZetaSys", "contested", 1, 500003, "Amarr", "frontline"),
            kills: 12,
          },
          node("AlphaSys", "contested", 2, 500003, "Amarr", "frontline"),
          node("RearSys", "uncontested", 3, 500003, "Amarr", "rearguard"),
        ],
        edges: [],
      }),
      auth_characters: () => [],
      auth_active_character: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("AlphaSys")).toBeInTheDocument(),
    );
    expect(inTable().getByText("RearSys")).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: /Farm Score/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Plexing" }));
    await waitFor(() =>
      expect(inTable().queryByText("RearSys")).not.toBeInTheDocument(),
    );
    expect(inTable().getByText("AlphaSys")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: /Farm Score/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const rows = inTable().getAllByRole("row");
      // Seeded farm-score-desc: AlphaSys (fewer kills, higher score) first.
      expect(within(rows[1]).getByText("AlphaSys")).toBeInTheDocument();
    });

    // Clicking the "System" header still re-sorts the table in Plexing mode.
    fireEvent.click(screen.getByRole("button", { name: /^System/i }));
    await waitFor(() => {
      const rows = inTable().getAllByRole("row");
      expect(within(rows[1]).getByText("AlphaSys")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /^System/i }));
    await waitFor(() => {
      const rows = inTable().getAllByRole("row");
      expect(within(rows[1]).getByText("ZetaSys")).toBeInTheDocument();
    });
  });
});

describe("FW militia perspective", () => {
  it("Observer mode is the default and has no Defend/Push column", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("columnheader", { name: /Perspective/i }),
    ).not.toBeInTheDocument();
    expect(inTable().queryByText("defend")).not.toBeInTheDocument();
    expect(inTable().queryByText("push")).not.toBeInTheDocument();
  });

  it("selecting a militia classifies contested systems as Defend or Push", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Amarr Empire" }));

    // FightVille + VulnBurg: Amarr-occupied and contested → defend.
    await waitFor(() =>
      expect(inTable().getAllByText("defend")).toHaveLength(2),
    );
    // RebelHold: Minmatar-occupied and contested → push, from Amarr's view.
    expect(inTable().getAllByText("push")).toHaveLength(1);
    // QuietTown: Amarr-occupied but uncontested → neither classification.
    const quietRow = inTable().getByText("QuietTown").closest("tr")!;
    expect(within(quietRow).queryByText("defend")).not.toBeInTheDocument();
    expect(within(quietRow).queryByText("push")).not.toBeInTheDocument();
  });

  it("flips Defend/Push when the opposing militia is selected", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Minmatar Republic" }));

    // From Minmatar's perspective, RebelHold (Minmatar-occupied) is defend,
    // and the two Amarr-occupied contested systems become push.
    await waitFor(() =>
      expect(inTable().getAllByText("defend")).toHaveLength(1),
    );
    expect(inTable().getAllByText("push")).toHaveLength(2);
  });

  it("auto-detects the militia from an enlisted character when unset", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_enlistment: () => 500003, // Amarr Empire
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
      intel_fw_personal_stats: () => ({ stats: null, missingScope: false }),
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/auto-detected/)).toBeInTheDocument(),
    );
    // Defaulted straight to Amarr's perspective without a click.
    await waitFor(() =>
      expect(inTable().getAllByText("defend")).toHaveLength(2),
    );
  });

  it("falls back to Observer when the character isn't enlisted", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_enlistment: () => null,
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/auto-detected/)).not.toBeInTheDocument();
    expect(inTable().queryByText("defend")).not.toBeInTheDocument();
  });

  it("an explicit Observer pick overrides auto-detect and persists", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_enlistment: () => 500002, // Minmatar Republic
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
      intel_fw_personal_stats: () => ({ stats: null, missingScope: false }),
    });
    const { unmount } = renderPage();
    await waitFor(() =>
      expect(inTable().getAllByText("defend")).toHaveLength(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "Observer" }));
    await waitFor(() =>
      expect(inTable().queryByText("defend")).not.toBeInTheDocument(),
    );
    unmount();

    // Remount: the explicit Observer choice persists over auto-detect.
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(inTable().queryByText("defend")).not.toBeInTheDocument();
  });
});

describe("FW VP change columns (Δ30m / Δ login)", () => {
  it("Observer mode has no Δ30m/Δ login columns", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("columnheader", { name: /Δ 30m/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: /Δ login/ }),
    ).not.toBeInTheDocument();
  });

  it("signs the 30m delta for the selected militia: an enemy gain reads negative, an enemy loss reads positive", async () => {
    const nodes = [
      // Amarr-occupied, gained 0.4 VP over the window — bad for Minmatar.
      {
        ...node("AmarrGain", "contested", 10, 500003, "Amarr"),
        vpDelta30m: 0.4,
      },
      // Amarr-occupied, lost 0.2 VP over the window — good for Minmatar.
      {
        ...node("AmarrLoss", "contested", 11, 500003, "Amarr"),
        vpDelta30m: -0.2,
      },
    ];
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes, edges: [] }),
      auth_characters: () => [],
      auth_active_character: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("AmarrGain")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Minmatar Republic" }));

    await waitFor(() => {
      const gainRow = inTable().getByText("AmarrGain").closest("tr")!;
      expect(within(gainRow).getByText("-40.0%")).toBeInTheDocument();
    });
    const lossRow = inTable().getByText("AmarrLoss").closest("tr")!;
    expect(within(lossRow).getByText("+20.0%")).toBeInTheDocument();
  });

  it("anchors the Δ login column at the first-seen VP and shows 0.0% with no movement yet", async () => {
    const nodes = [
      {
        ...node("FreshSystem", "contested", 12, 500003, "Amarr"),
        vpDelta30m: null,
      },
    ];
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes, edges: [] }),
      auth_characters: () => [],
      auth_active_character: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("FreshSystem")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Amarr Empire" }));

    const row = await waitFor(() =>
      inTable().getByText("FreshSystem").closest("tr")!,
    );
    // No history yet (vpDelta30m null) → "—"; login baseline anchors on
    // first observation → "0.0%", not a bogus nonzero delta.
    expect(within(row).getByTitle(/the last 30 min/).textContent).toBe("—");
    expect(
      within(row).getByTitle(/since you opened this session/).textContent,
    ).toBe("0.0%");
  });

  it("signs the Trend arrow for the selected militia too (#950) — an enemy's fast loss reads as your fast gain", async () => {
    const nodes = [
      // Amarr-occupied, Amarr's own VP climbing fast (good for Amarr, bad
      // for Minmatar) — raw tier would be fast-up (↑↑), signed should read
      // as a plain down (↓) for Minmatar (the tier system only has a
      // "fast" variant on the up side, by design).
      {
        ...node("AmarrClimbing", "contested", 13, 500003, "Amarr"),
        vpVelocity: 0.15,
      },
      // Amarr-occupied, Amarr's own VP falling fast (bad for Amarr, good
      // for Minmatar) — raw tier would be "down", signed should read as a
      // fast gain (↑↑) for Minmatar, matching a positive Δ30m on the same
      // row rather than contradicting it with a down arrow.
      {
        ...node("AmarrFalling", "contested", 14, 500003, "Amarr"),
        vpVelocity: -0.15,
      },
    ];
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes, edges: [] }),
      auth_characters: () => [],
      auth_active_character: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("AmarrClimbing")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Minmatar Republic" }));

    await waitFor(() => {
      const climbingRow = inTable().getByText("AmarrClimbing").closest("tr")!;
      expect(within(climbingRow).getByText("↓")).toBeInTheDocument();
    });
    const fallingRow = inTable().getByText("AmarrFalling").closest("tr")!;
    expect(within(fallingRow).getByText("↑↑")).toBeInTheDocument();
  });
});

describe("FW battlefield classification", () => {
  it("shows the derived battlefield chip per system, in Observer mode too", async () => {
    const battlefieldNodes = [
      node("EdgeSystem", "contested", 20, 500003, "Amarr", "frontline"),
      node("StagingSystem", "uncontested", 21, 500003, "Amarr", "commandops"),
      node("QuietBackwater", "uncontested", 22, 500003, "Amarr", "rearguard"),
    ];
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: battlefieldNodes, edges: [] }),
      auth_characters: () => [],
      auth_active_character: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("EdgeSystem")).toBeInTheDocument(),
    );
    expect(inTable().getByText("Frontline")).toBeInTheDocument();
    expect(inTable().getByText("Command Ops")).toBeInTheDocument();
    expect(inTable().getByText("Rearguard")).toBeInTheDocument();
  });
});

describe("FW map size control", () => {
  it("defaults to M (480px), switches presets, and persists the choice", async () => {
    const { container } = renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(container.querySelector('[style*="480px"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "L" }));
    await waitFor(() =>
      expect(container.querySelector('[style*="720px"]')).toBeTruthy(),
    );
    expect(localStorage.getItem("fw.mapSize")).toBe('"l"');

    fireEvent.click(screen.getByRole("button", { name: "S" }));
    await waitFor(() =>
      expect(container.querySelector('[style*="320px"]')).toBeTruthy(),
    );
    expect(localStorage.getItem("fw.mapSize")).toBe('"s"');
  });
});

describe("FW NPC kills column", () => {
  it("shows NPC kills alongside ship kills, sortable", async () => {
    const withNpcKills = [
      { ...node("FarmSystem", "uncontested", 30), npcKills: 42 },
      { ...node("EmptySystem", "uncontested", 31), npcKills: 0 },
    ];
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: withNpcKills, edges: [] }),
      auth_characters: () => [],
      auth_active_character: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("FarmSystem")).toBeInTheDocument(),
    );
    expect(inTable().getByText("42")).toBeInTheDocument();

    // Sortable via its column header.
    fireEvent.click(screen.getByRole("button", { name: /NPC Kills 1h/i }));
    const rows = inTable().getAllByRole("row");
    // Header row + 2 data rows; after a desc-toggle click the highest NPC
    // kill count (FarmSystem) should lead.
    expect(within(rows[1]).queryByText("FarmSystem")).toBeInTheDocument();
  });
});

describe("FW VP trend column", () => {
  it("shows a trend arrow when velocity data exists, and a dash otherwise", async () => {
    const trendNodes = [
      // node(name, contested, id, occupierId, occupier, battlefield, vpVelocity)
      node("ClimbingFast", "contested", 40, 500003, "Amarr", "rearguard", 0.15),
      node("Climbing", "contested", 41, 500003, "Amarr", "rearguard", 0.05),
      node("Holding", "contested", 42, 500003, "Amarr", "rearguard", 0),
      node("Falling", "contested", 43, 500003, "Amarr", "rearguard", -0.1),
      node("NoHistoryYet", "contested", 44, 500003, "Amarr", "rearguard", null),
    ];
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: trendNodes, edges: [] }),
      auth_characters: () => [],
      auth_active_character: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("ClimbingFast")).toBeInTheDocument(),
    );

    const rowFor = (name: string) => inTable().getByText(name).closest("tr")!;
    expect(within(rowFor("ClimbingFast")).getByText("↑↑")).toBeInTheDocument();
    expect(within(rowFor("Climbing")).getByText("↑")).toBeInTheDocument();
    expect(within(rowFor("Holding")).getByText("→")).toBeInTheDocument();
    expect(within(rowFor("Falling")).getByText("↓")).toBeInTheDocument();
    // No history yet — no arrow, just a placeholder dash.
    const noHistoryRow = rowFor("NoHistoryYet");
    expect(within(noHistoryRow).queryByText("↑↑")).not.toBeInTheDocument();
    expect(within(noHistoryRow).queryByText("↑")).not.toBeInTheDocument();
    expect(within(noHistoryRow).queryByText("→")).not.toBeInTheDocument();
    expect(within(noHistoryRow).queryByText("↓")).not.toBeInTheDocument();
  });
});

describe("FW proximity filter", () => {
  it("is hidden without an active character; 'all' behaves like before", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "3j" }),
    ).not.toBeInTheDocument();
    // All four fixture systems still present — unfiltered.
    expect(inTable().getByText("FightVille")).toBeInTheDocument();
    expect(inTable().getByText("VulnBurg")).toBeInTheDocument();
    expect(inTable().getByText("RebelHold")).toBeInTheDocument();
  });

  it("filters the table by jump radius when a character is active, and persists", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      // QuietTown 2j, FightVille 6j, VulnBurg 12j; RebelHold absent (unreachable).
      intel_fw_jumps: () => ({
        characterSystemId: 1,
        jumps: { "1": 2, "2": 6, "3": 12 },
      }),
      intel_fw_enlistment: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "5j" }));
    await waitFor(() =>
      expect(inTable().queryByText("FightVille")).not.toBeInTheDocument(),
    );
    // Within 5 jumps: only QuietTown (2j). 6j/12j/unreachable all excluded.
    expect(inTable().getByText("QuietTown")).toBeInTheDocument();
    expect(inTable().queryByText("VulnBurg")).not.toBeInTheDocument();
    expect(inTable().queryByText("RebelHold")).not.toBeInTheDocument();
    expect(localStorage.getItem("fw.proximityRadius")).toBe('"5"');

    fireEvent.click(screen.getByRole("button", { name: "10j" }));
    await waitFor(() =>
      expect(inTable().getByText("FightVille")).toBeInTheDocument(),
    );
    // Within 10 jumps: QuietTown (2j) + FightVille (6j); 12j/unreachable stay out.
    expect(inTable().queryByText("VulnBurg")).not.toBeInTheDocument();
    expect(inTable().queryByText("RebelHold")).not.toBeInTheDocument();

    // Three "All" buttons exist now (Mode / Show filter / proximity filter);
    // the proximity one renders last.
    const allButtons = screen.getAllByRole("button", { name: "All" });
    fireEvent.click(allButtons[allButtons.length - 1]);
    await waitFor(() =>
      expect(inTable().getByText("VulnBurg")).toBeInTheDocument(),
    );
    expect(inTable().getByText("RebelHold")).toBeInTheDocument();
  });

  it("combines with the contested filter in the count label", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_jumps: () => ({
        characterSystemId: 1,
        jumps: { "1": 2, "2": 3 },
      }),
      intel_fw_enlistment: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );

    // Within 5j: QuietTown (uncontested) + FightVille (contested) — 2 of 2.
    fireEvent.click(screen.getByRole("button", { name: "5j" }));
    await waitFor(() =>
      expect(screen.getByText("2 of 2 systems")).toBeInTheDocument(),
    );

    // Add the contested-only filter on top: 1 of 2 (FightVille only).
    fireEvent.click(screen.getByRole("button", { name: "Contested" }));
    await waitFor(() =>
      expect(screen.getByText("1 of 2 systems")).toBeInTheDocument(),
    );
  });
});

describe("FW detailed map tiles (#902)", () => {
  it("shows compact tiles at full-warzone scope and detailed tiles once the proximity filter is active", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({
        nodes: [
          {
            ...node("FrontSys", "contested", 1, 500003, "Amarr", "frontline"),
            kills: 5,
            npcKills: 2,
            vpPct: 0.6,
          },
        ],
        edges: [],
      }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_enlistment: () => null,
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: { "1": 2 } }),
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("FrontSys")).toBeInTheDocument(),
    );

    // Full-warzone scope (default "all" radius): no VP bar on the tile.
    expect(screen.queryByTitle(/Victory points/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "5j" }));
    await waitFor(() =>
      expect(screen.getByTitle("Victory points: 60%")).toBeInTheDocument(),
    );

    // Proximity filter off again ("all" of the three "All" buttons, last one).
    const allButtons = screen.getAllByRole("button", { name: "All" });
    fireEvent.click(allButtons[allButtons.length - 1]);
    await waitFor(() =>
      expect(screen.queryByTitle(/Victory points/)).not.toBeInTheDocument(),
    );
  });
});

describe("FW kill hotspots (#905, always-on)", () => {
  it("shows no heat note or Activity column in Observer mode", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Heat:/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: /Activity 6h/ }),
    ).not.toBeInTheDocument();
  });

  it("queries hotspots as soon as a militia is selected and shows activity in the table", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_enlistment: () => null,
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: { "2": 3 } }),
      intel_fw_hotspots: () => ({
        systems: [
          { systemId: 2, friendlyLosses: 5, enemyLosses: 1, cartelActivity: 0 },
        ],
      }),
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Amarr Empire" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("intel_fw_hotspots", {
        myFaction: 500003,
        enemyFaction: 500002,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("columnheader", { name: /Activity 6h/ }),
      ).toBeInTheDocument(),
    );
    const fightVilleRow = inTable().getByText("FightVille").closest("tr")!;
    expect(
      within(fightVilleRow).getByText("5 ours · 1 theirs"),
    ).toBeInTheDocument();
    // A system with no hotspot data at all reads as a dash, not a crash.
    const quietRow = inTable().getByText("QuietTown").closest("tr")!;
    expect(within(quietRow).getByTitle(/friendly losses/).textContent).toBe(
      "—",
    );

    // Back to Observer hides the column again.
    fireEvent.click(screen.getByRole("button", { name: "Observer" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("columnheader", { name: /Activity 6h/ }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("FW auto refresh", () => {
  it("the page-level checkbox is unchecked by default and toggles", async () => {
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    const checkbox = screen.getByRole("checkbox", {
      name: /Auto refresh/,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });
});

describe("FW personal stats card", () => {
  it("is hidden in Observer mode even with a character logged in", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_enlistment: () => null,
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
      intel_fw_personal_stats: () => ({
        stats: {
          factionId: 500003,
          rankName: "Paladin Crusader",
          killsYesterday: 2,
          killsTotal: 40,
          vpYesterday: 100,
          vpTotal: 5000,
          enlistedOn: "2024-01-02T03:04:05Z",
        },
        missingScope: false,
      }),
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Your record/)).not.toBeInTheDocument();
  });

  it("shows rank, kills, VP and enlistment date once a militia is selected", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_enlistment: () => 500003,
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
      intel_fw_personal_stats: () => ({
        stats: {
          factionId: 500003,
          rankName: "Paladin Crusader",
          killsYesterday: 2,
          killsTotal: 40,
          vpYesterday: 100,
          vpTotal: 5000,
          enlistedOn: "2024-01-02T03:04:05Z",
        },
        missingScope: false,
      }),
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Your record/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Paladin Crusader/)).toBeInTheDocument();
    expect(screen.getByText(/2 kills/)).toBeInTheDocument();
    expect(screen.getByText(/40 total/)).toBeInTheDocument();
    expect(screen.getByText(/100 VP yesterday/)).toBeInTheDocument();
    expect(screen.getByText(/5,000 total/)).toBeInTheDocument();
    expect(screen.getByText(/Enlisted 2024-01-02/)).toBeInTheDocument();
  });

  it("is hidden (not an error) when the character isn't enlisted, even with a militia selected", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_enlistment: () => null,
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
      intel_fw_personal_stats: () => ({ stats: null, missingScope: false }),
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("QuietTown")).toBeInTheDocument(),
    );
    // Not enlisted in any militia, but explicitly select one anyway — the
    // perspective is active, yet the card stays hidden because stats is null.
    fireEvent.click(screen.getByRole("button", { name: "Amarr Empire" }));
    await waitFor(() =>
      expect(inTable().getAllByText("defend").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/Your record/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Re-login/)).not.toBeInTheDocument();
  });

  it("shows a re-login hint (not an error) when the scope is missing", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: NODES, edges: [] }),
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      auth_active_character: () => 1,
      intel_fw_enlistment: () => 500003,
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
      intel_fw_personal_stats: () => ({ stats: null, missingScope: true }),
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Re-login/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Your record/)).not.toBeInTheDocument();
  });
});

describe("FW battlefield filter", () => {
  const BATTLEFIELD_NODES = [
    node("FrontSys", "contested", 50, 500003, "Amarr", "frontline"),
    node("CommandSys", "contested", 51, 500003, "Amarr", "commandops"),
    node("RearSys", "uncontested", 52, 500003, "Amarr", "rearguard"),
  ];

  it("filters the table to Frontlines or Command Post, independent of the Show filter", async () => {
    mockInvoke({
      intel_fw_stats: () => [],
      intel_fw_systems: () => ({ nodes: BATTLEFIELD_NODES, edges: [] }),
      auth_characters: () => [],
      auth_active_character: () => null,
    });
    renderPage();
    await waitFor(() =>
      expect(inTable().getByText("FrontSys")).toBeInTheDocument(),
    );
    expect(inTable().getByText("CommandSys")).toBeInTheDocument();
    expect(inTable().getByText("RearSys")).toBeInTheDocument();

    // "Battlefield" also labels a table column — grab the filter-row span.
    const battlefieldGroup = () =>
      screen.getAllByText("Battlefield").find((el) => el.tagName === "SPAN")!
        .nextElementSibling as HTMLElement | null;

    fireEvent.click(
      within(battlefieldGroup()!).getByRole("button", {
        name: "Frontlines",
      }),
    );
    await waitFor(() =>
      expect(inTable().queryByText("CommandSys")).not.toBeInTheDocument(),
    );
    expect(inTable().queryByText("RearSys")).not.toBeInTheDocument();
    expect(inTable().getByText("FrontSys")).toBeInTheDocument();

    fireEvent.click(
      within(battlefieldGroup()!).getByRole("button", {
        name: "Command Post",
      }),
    );
    await waitFor(() =>
      expect(inTable().queryByText("FrontSys")).not.toBeInTheDocument(),
    );
    expect(inTable().getByText("CommandSys")).toBeInTheDocument();
    expect(inTable().queryByText("RearSys")).not.toBeInTheDocument();

    fireEvent.click(
      within(battlefieldGroup()!).getByRole("button", { name: "All" }),
    );
    await waitFor(() =>
      expect(inTable().getByText("RearSys")).toBeInTheDocument(),
    );
    expect(inTable().getByText("FrontSys")).toBeInTheDocument();
    expect(inTable().getByText("CommandSys")).toBeInTheDocument();
  });
});
