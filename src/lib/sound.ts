// Shared cross-platform sound cues. Plays short bundled audio clips through the
// webview's HTML5 Audio, which works on every Tauri platform (WebKitGTK, WKWebView,
// WebView2) with no OS binary — unlike the Web Speech API, which is silent on
// WebKitGTK. Any module can import `playCue` to signal an event audibly.
//
// The clips are spoken-word recordings ("scrambled", "point off", "launch
// drones", …) pre-generated with the piper neural TTS and committed as static
// assets, so no TTS engine is needed at build or run time. To regenerate/extend
// them, see docs/sound-cues.md.

import scram from "../assets/sounds/scram.wav";
import scramOff from "../assets/sounds/scram-off.wav";
import point from "../assets/sounds/point.wav";
import pointOff from "../assets/sounds/point-off.wav";
import drones from "../assets/sounds/drones.wav";

/** Bundled cue clips, keyed by event. Add a clip + key to extend. */
const CUES = {
  scram,
  scramOff,
  point,
  pointOff,
  drones,
} as const;

export type CueSound = keyof typeof CUES;

// One preloaded element per clip; we clone it per play so overlapping cues
// (e.g. scram + launch-drones back to back) don't cut each other off.
const preloaded: Partial<Record<CueSound, HTMLAudioElement>> = {};

/**
 * Play a bundled cue clip. Fire-and-forget and safe to call anywhere — a
 * blocked autoplay (no prior user gesture) or missing audio device just
 * resolves to nothing rather than throwing.
 *
 * @param name   which cue to play
 * @param volume 0..1 (default 0.5)
 */
export function playCue(name: CueSound, volume = 0.5): void {
  const base = (preloaded[name] ??= new Audio(CUES[name]));
  const clip = base.cloneNode() as HTMLAudioElement;
  clip.volume = Math.min(1, Math.max(0, volume));
  void clip.play().catch(() => {
    /* autoplay blocked or no audio output — nothing to do */
  });
}
