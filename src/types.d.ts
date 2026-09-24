export {};

declare global {
  interface Window {
    /** Safari's legacy prefixed `AudioContext` — not covered by lib.dom.
     *  Optional because only Safari ever defines it. */
    webkitAudioContext?: typeof AudioContext;
  }
}
