import { useState } from "react";
import { Bell } from "lucide-react";
import { Modal } from "../../components/Modal";
import type { ColonyView } from "../../lib/api";
import { useReminders } from "../reminders/reminderContext";
import { WhenField } from "../reminders/WhenField";

/** Earliest extractor-program end across this colony's extractors, as epoch
 *  ms — the obvious "restart me" moment. `null` when the colony has no running
 *  extractor with a known expiry. */
function earliestExpiry(colony: ColonyView): number | null {
  const times = colony.extractors
    .map((e) => (e.expiryTime ? Date.parse(e.expiryTime) : NaN))
    .filter((t) => !Number.isNaN(t));
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * "Remind me" action in a colony's header: opens a small form pre-filled from
 * the colony (what = "<system> <planet type> extraction", when = the earliest
 * extractor's end time, or an hour out if none is running) and creates a PI
 * reminder through the shared {@link useReminders} context. Firing is handled
 * app-wide by `ReminderProvider`; this is just a convenient pre-filled entry
 * point so you don't have to retype it in Settings.
 */
export function ColonyReminderButton({ colony }: { colony: ColonyView }) {
  const { add } = useReminders();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [what, setWhat] = useState("");
  const [note, setNote] = useState("");
  const [dueAt, setDueAt] = useState(() => Date.now() + 60 * 60_000);

  const openForm = () => {
    setWhat(`${colony.systemName} ${colony.planetType} extraction`);
    setNote("");
    setDueAt(earliestExpiry(colony) ?? Date.now() + 60 * 60_000);
    setOpen(true);
  };

  const submit = () => {
    if (what.trim() === "" || Number.isNaN(dueAt)) return;
    add({ category: "pi", what: what.trim(), note: note.trim(), dueAt });
    setOpen(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <>
      <button
        type="button"
        onClick={openForm}
        title="Create a reminder for this colony"
        className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
      >
        <Bell size={12} />
        {saved ? "Reminder set ✓" : "Remind me"}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        role="dialog"
        aria-label="Create reminder"
        backdropClassName="fixed inset-0 z-40 bg-black/40"
        className="fixed left-1/2 top-1/2 z-50 w-96 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-zinc-100">
          Remind me about this colony
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Pre-filled with the earliest extraction end; adjust the time or note
          as you like. Fires only while the app is open.
        </p>
        <div className="mt-3 grid gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">What</span>
            <input
              type="text"
              value={what}
              onChange={(e) => setWhat(e.currentTarget.value)}
              aria-label="What to be reminded about"
              className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">When</span>
            <WhenField value={dueAt} onChange={setDueAt} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              rows={2}
              aria-label="Reminder note"
              className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600"
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
          >
            Add reminder
          </button>
        </div>
      </Modal>
    </>
  );
}
