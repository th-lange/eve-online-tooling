// The pure "which way does this module sync" decision, isolated from I/O so
// it's trivially unit-tested (see `decide.test.ts`) — newer unix-ms wins,
// whole-module replace, no field merge.

export type SyncDecision = "import" | "export" | "noop" | "skip";

/**
 * What the sync folder holds for one module: the file's `updatedAt`; `"absent"`
 * (no file); or `"unusable"` (a file is there but unreadable, malformed, from
 * another schema version or the wrong shape). The last must never be treated
 * as absent: exporting would destroy a possibly newer copy (#1176).
 */
export type RemoteState = number | "absent" | "unusable";

/**
 * `localTs` is this device's `updatedAt` for the module (from the sync
 * manifest, `0` if never touched/imported).
 */
export function decideSync(localTs: number, remote: RemoteState): SyncDecision {
  if (remote === "unusable") return "skip";
  if (remote !== "absent" && remote > localTs) return "import";
  if (remote === "absent" || localTs > remote) return "export";
  return "noop";
}
