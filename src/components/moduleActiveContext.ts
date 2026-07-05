import { createContext } from "react";

/**
 * Whether the module reading this context is the one currently on screen.
 * `ModuleHost` (Layout) keeps every visited page mounted (hidden with
 * `display:none`), so a page with a live subscription (e.g. the DPS meter's
 * tick feed) would otherwise keep re-rendering while invisible. Pages can read
 * this to pause work while backgrounded. Defaults to `true` so a page rendered
 * on its own (tests, or any non-`ModuleHost` mount) always behaves as active.
 */
export const ModuleActiveContext = createContext(true);
