import type { WatchEntry } from "../../lib/api";

/** Alarm-settings checkboxes (any-red / neutrals / sound), the "audio alerts
 *  unavailable" safety warning (#819), and the current watchlist chips. Pure
 *  presentation over `useLocalIntelData`'s alarm settings — no fetching of
 *  its own. */
export function AlarmPanel({
  alertAnyRed,
  onAlertAnyRedChange,
  alertNeutrals,
  onAlertNeutralsChange,
  soundOn,
  onSoundOnChange,
  audioUnavailable,
  watchlist,
  onUnwatch,
}: {
  alertAnyRed: boolean;
  onAlertAnyRedChange: (checked: boolean) => void;
  alertNeutrals: boolean;
  onAlertNeutralsChange: (checked: boolean) => void;
  soundOn: boolean;
  onSoundOnChange: (checked: boolean) => void;
  audioUnavailable: boolean;
  watchlist: WatchEntry[];
  onUnwatch: (id: number, name: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-zinc-400">
      <label
        className="flex cursor-pointer items-center gap-2"
        title="Alarm when a red enters Local"
      >
        <input
          type="checkbox"
          checked={alertAnyRed}
          onChange={(e) => onAlertAnyRedChange(e.currentTarget.checked)}
        />
        Alert on any red
      </label>
      <label
        className="flex cursor-pointer items-center gap-2"
        title="Also alarm when any neutral/unknown pilot enters Local"
      >
        <input
          type="checkbox"
          checked={alertNeutrals}
          onChange={(e) => onAlertNeutralsChange(e.currentTarget.checked)}
        />
        Alert on neutrals
      </label>
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={soundOn}
          onChange={(e) => onSoundOnChange(e.currentTarget.checked)}
        />
        Sound alarm
      </label>
      {audioUnavailable && (
        <span
          className="rounded border border-rose-800 bg-rose-950/40 px-1.5 py-0.5 text-rose-300"
          title="The alarm beep couldn't play — check your system audio/autoplay settings. Local Intel can't sound a hostile alert until this is resolved."
        >
          ⚠ audio alerts unavailable
        </span>
      )}
      {watchlist.length > 0 && (
        <span>
          Watching:{" "}
          {watchlist.map((w) => (
            <button
              key={w.id}
              onClick={() => onUnwatch(w.id, w.name)}
              title="Remove from watchlist"
              className="mr-1 rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-300 hover:bg-amber-900/70"
            >
              {w.name} ✕
            </button>
          ))}
        </span>
      )}
    </div>
  );
}
