import { describe, expect, it } from "vitest";

// Guard for the dimmest text tier (#1265). `text-zinc-600` measures about
// 2.3–2.6:1 against the app's surfaces in both themes — well under the 4.5:1
// that normal text needs — and there is no room to fix that in the palette: a
// grey that passes on a panel is indistinguishable from `text-zinc-500`.
//
// So the tier is reserved for things that are allowed to be faint:
//   - separator glyphs and empty-cell dashes (`—`, `›`, `·`, `→`)
//   - idle icon buttons that brighten on hover
//   - input placeholders (`placeholder:text-zinc-600`)
//   - "nothing here" values (0 kills, `±0`, a zero resist)
//
// Anything a user is meant to read — empty-state messages, hints, help
// paragraphs, counts, axis labels, timestamps — uses `text-zinc-500` or
// brighter.
//
// The budget below is the reviewed set of decorative uses per file. A new use
// fails this test: if it is decoration, raise that file's number; if it is
// text, use `text-zinc-500`.
const sources = import.meta.glob(
  [
    "/src/**/*.{ts,tsx}",
    "!/src/**/*.test.{ts,tsx}",
    "!/src/lib/api/generated/**",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const DECORATIVE_USES: Record<string, number> = {
  "/src/components/Layout.tsx": 1,
  "/src/components/Sparkline.tsx": 1,
  "/src/components/SystemGraph.tsx": 1,
  "/src/components/forms.tsx": 1,
  "/src/components/page.tsx": 1,
  "/src/components/typeIdLists.tsx": 3,
  "/src/modules/accounting/AccountingPage.tsx": 1,
  "/src/modules/appraisal/AppraisalPage.tsx": 1,
  "/src/modules/assets/AssetsPage.tsx": 4,
  "/src/modules/dpsmeter/HitQualityIndicators.tsx": 1,
  "/src/modules/dpsmeter/ThresholdPopover.tsx": 1,
  "/src/modules/faction-warfare/SystemNameCell.tsx": 1,
  "/src/modules/faction-warfare/SystemTable.tsx": 2,
  "/src/modules/faction-warfare/Warzone.tsx": 1,
  "/src/modules/feedback/FeedbackPage.tsx": 5,
  "/src/modules/fitting/ComparisonPanel.tsx": 5,
  "/src/modules/fitting/ModuleBrowser.tsx": 3,
  "/src/modules/fitting/SlotGrid.tsx": 1,
  "/src/modules/fitting/TargetProfileBox.tsx": 1,
  "/src/modules/fitting/fitHelpers.ts": 1,
  "/src/modules/localintel/KillsTab.tsx": 1,
  "/src/modules/localintel/LocalIntelPage.tsx": 2,
  "/src/modules/localintel/PilotTable.tsx": 1,
  "/src/modules/lpstore/ItemSearch.tsx": 1,
  "/src/modules/massproduction/GroupSection.tsx": 1,
  "/src/modules/massproduction/PlanResult.tsx": 1,
  "/src/modules/notes/FolderTree.tsx": 1,
  "/src/modules/notes/NotesPage.tsx": 1,
  "/src/modules/notes/TableEditor.tsx": 2,
  "/src/modules/orders/OrdersPage.tsx": 1,
  "/src/modules/pi/ChainRow.tsx": 1,
  "/src/modules/pi/ColonyReminderButton.tsx": 1,
  "/src/modules/pochven/EntryResults.tsx": 2,
  "/src/modules/production/ParamsPanel.tsx": 2,
  "/src/modules/production/components.tsx": 1,
  "/src/modules/pvp/PvpPage.tsx": 2,
  "/src/modules/recording/RecordingSettingsCard.tsx": 4,
  "/src/modules/reminders/RemindersPage.tsx": 2,
  "/src/modules/reminders/WhenField.tsx": 2,
  "/src/modules/route/RoutePage.tsx": 1,
  "/src/modules/shopping/AddItemField.tsx": 1,
  "/src/modules/shopping/ItemRow.tsx": 1,
  "/src/modules/shopping/ListSidebar.tsx": 1,
  "/src/modules/universe/UniversePage.tsx": 1,
  "/src/modules/wormholes/JumpPlanner.tsx": 1,
  "/src/modules/wormholes/Routing.tsx": 1,
  "/src/modules/wormholes/Signatures.tsx": 1,
  "/src/modules/wormholes/TripwirePanel.tsx": 1,
  "/src/modules/wormholes/WormholesPage.tsx": 5,
};

describe("the dimmest text tier", () => {
  it("is used only where it was reviewed as decoration", () => {
    const overBudget: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      const uses = text.match(/text-zinc-600/g)?.length ?? 0;
      const allowed = DECORATIVE_USES[file] ?? 0;
      if (uses > allowed) {
        overBudget.push(`${file}: ${uses} uses, ${allowed} reviewed`);
      }
    }
    expect(
      overBudget,
      "text-zinc-600 is too faint to read. Use text-zinc-500 for text; for a " +
        "glyph, idle icon, placeholder or zero value, raise the file's count " +
        "in DECORATIVE_USES.",
    ).toEqual([]);
  });

  it("has no stale budget left over from removed uses", () => {
    const stale = Object.entries(DECORATIVE_USES)
      .filter(
        ([file, allowed]) =>
          (sources[file]?.match(/text-zinc-600/g)?.length ?? 0) < allowed,
      )
      .map(([file]) => file);
    expect(stale).toEqual([]);
  });
});
