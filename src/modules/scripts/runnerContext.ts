import { createContext, useContext } from "react";
import type { ScriptRun } from "../../lib/api";

/** The most recent scheduled run of a script. */
export interface ScriptRunState {
  /** Epoch ms the run finished. */
  at: number;
  /** Its outcome. */
  run: ScriptRun;
}

export const ScriptsRunnerContext = createContext<
  Record<string, ScriptRunState>
>({});

/** Per-script last scheduled-run state, keyed by script id. */
export function useScriptRuns(): Record<string, ScriptRunState> {
  return useContext(ScriptsRunnerContext);
}
