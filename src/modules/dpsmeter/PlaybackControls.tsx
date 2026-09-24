import { Pause, Play, Repeat, Square } from "lucide-react";
import type { Mode } from "./dpsMeterShared";

/** Playback-mode transport: Pause (while running), Resume (while paused),
 *  Stop, Start/Play, and Loop toggle. Live mode shows Start/Stop only. */
export function PlaybackControls({
  mode,
  running,
  paused,
  dir,
  file,
  looping,
  onSetLooping,
  onPause,
  onResume,
  onStop,
  onStart,
  onPlayCurrent,
}: {
  mode: Mode;
  running: boolean;
  paused: boolean;
  dir: string;
  file: string;
  looping: boolean;
  onSetLooping: (v: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onStart: () => void;
  onPlayCurrent: () => void;
}) {
  return (
    <>
      {mode === "playback" && running && !paused && (
        <button
          onClick={onPause}
          className="flex items-center gap-1.5 rounded bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
        >
          <Pause size={14} /> Pause
        </button>
      )}
      {mode === "playback" && paused && (
        <button
          onClick={onResume}
          disabled={!file}
          className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <Play size={14} /> Resume
        </button>
      )}
      {running || paused ? (
        <button
          onClick={onStop}
          className="flex items-center gap-1.5 rounded bg-rose-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
        >
          <Square size={14} /> Stop
        </button>
      ) : (
        <button
          onClick={() => (mode === "live" ? onStart() : onPlayCurrent())}
          disabled={mode === "live" ? !dir.trim() : !file}
          className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <Play size={14} /> {mode === "live" ? "Start" : "Play"}
        </button>
      )}
      {mode === "playback" && (
        <button
          onClick={() => onSetLooping(!looping)}
          title={looping ? "Loop: on" : "Loop: off"}
          aria-pressed={looping}
          className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
            looping
              ? "bg-indigo-700 text-white hover:bg-indigo-600"
              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
          }`}
        >
          <Repeat size={14} /> Loop
        </button>
      )}
    </>
  );
}
