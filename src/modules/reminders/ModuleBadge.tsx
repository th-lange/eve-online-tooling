import { goToRoute, openColonyInPi } from "../../lib/deepLink";
import { categoryLabel, reminderTarget, type Reminder } from "./reminders";

const BASE =
  "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide";

/**
 * The reminder's type chip. When the reminder has a navigation target (a PI /
 * production / invention category, or an explicit link — e.g. a PI reminder
 * carrying its colony), the chip is a button that opens that module (and
 * focuses the PI colony if one is linked). "Other" reminders with no target
 * render as a plain, non-clickable label.
 *
 * `onNavigate` lets the caller react to the jump — the due modal passes it to
 * close itself once you've left for the module.
 */
export function ModuleBadge({
  reminder,
  onNavigate,
}: {
  reminder: Reminder;
  onNavigate?: () => void;
}) {
  const target = reminderTarget(reminder);
  const label = categoryLabel(reminder.category);

  if (!target) {
    return <span className={`${BASE} bg-zinc-800 text-zinc-400`}>{label}</span>;
  }

  return (
    <button
      type="button"
      onClick={() => {
        goToRoute(`/${target.moduleId}`);
        if (target.planetId != null) openColonyInPi(target.planetId);
        onNavigate?.();
      }}
      title={`Open in ${label}`}
      className={`${BASE} bg-zinc-800 text-indigo-300 hover:bg-zinc-700 hover:text-indigo-200`}
    >
      {label} ↗
    </button>
  );
}
