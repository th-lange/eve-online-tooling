// The pure "which way does this module sync" decision, isolated from I/O so
// it's trivially unit-tested (see `decide.test.ts`) — newer unix-ms wins,
// whole-module replace, no field merge.

export type SyncDecision = "import" | "export" | "noop";

/**
 * `localTs` is this device's `updatedAt` for the module (from the sync
 * manifest, `0` if never touched/imported); `remoteTs` is the sync file's
 * `updatedAt`, or `undefined` if there's no (schema-matching) remote file.
 */
export function decideSync(
  localTs: number,
  remoteTs: number | undefined,
): SyncDecision {
  if (remoteTs !== undefined && remoteTs > localTs) return "import";
  if (localTs > (remoteTs ?? -1)) return "export";
  return "noop";
}
