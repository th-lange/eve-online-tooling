import { createContext } from "react";

/**
 * Per-module page chrome handed down by `ModuleHost` (Layout): the module's
 * nav title and a callback that hides it from the sidebar. `PageHeader` reads
 * this to render the hide control inline next to the page title — statically,
 * in every page state (loading gate, setup screen, ready) — so the control
 * never relocates. `null` outside `ModuleHost` (tests, storybook-style
 * mounts), which simply omits the control.
 */
export interface ModuleChrome {
  /** Module title as shown in the sidebar (used for the accessible label). */
  title: string;
  /** Hide this module from the sidebar nav (restorable from "Hidden"). */
  hide: () => void;
}

export const ModuleChromeContext = createContext<ModuleChrome | null>(null);
