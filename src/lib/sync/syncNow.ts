// The folder sync algorithm (#1128): one Rust round trip to read every
// `*.json` file in the folder, then per registered store, newer-`updatedAt`-
// wins (whole-module replace, no field merge — see `decide.ts`).

import { syncFolderRead, syncFolderWrite } from "../api/sync";
import { getMeta, setMeta } from "./manifest";
import { SYNC_STORES, type SyncableStore } from "./stores";
import { decideSync } from "./decide";

/** One sync file's envelope, as written by `exportStore`/read by `syncNow`. */
export interface SyncEnvelope {
  module: string;
  schema: number;
  updatedAt: number;
  data: unknown;
}

export interface SyncResult {
  imported: string[];
  exported: string[];
  unchanged: string[];
  /** Modules whose remote file is present but unusable (unreadable, corrupt,
   *  another schema version, wrong shape). Left untouched, never overwritten. */
  skipped: string[];
}

function emptyResult(): SyncResult {
  return { imported: [], exported: [], unchanged: [], skipped: [] };
}

function fileName(module: string): string {
  return `${module}.json`;
}

/** What `readRemoteFiles` found: envelopes keyed by their `module` field, plus
 *  the file names that exist but couldn't be used as an envelope. */
interface RemoteFiles {
  envelopes: Map<string, SyncEnvelope>;
  unusableFiles: Set<string>;
}

/** Every `*.json` file in `dir`, parsed and keyed by its `module` field.
 *  A file that isn't a well-formed envelope (unreadable, corrupt, half-written
 *  by a sync client) is recorded in `unusableFiles` by name rather than failing
 *  the whole sync — and, crucially, rather than being forgotten: a store whose
 *  own file is unusable must be skipped, not overwritten (#1176). */
async function readRemoteFiles(dir: string): Promise<RemoteFiles> {
  const files = await syncFolderRead(dir);
  const envelopes = new Map<string, SyncEnvelope>();
  const unusableFiles = new Set<string>();
  for (const file of files) {
    if (file.unreadable) {
      unusableFiles.add(file.name);
      continue;
    }
    try {
      const parsed = JSON.parse(file.content) as Partial<SyncEnvelope> | null;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof parsed.module === "string" &&
        typeof parsed.schema === "number" &&
        typeof parsed.updatedAt === "number" &&
        "data" in parsed
      ) {
        envelopes.set(parsed.module, parsed as SyncEnvelope);
      } else {
        unusableFiles.add(file.name);
      }
    } catch {
      unusableFiles.add(file.name);
    }
  }
  return { envelopes, unusableFiles };
}

/** The remote state for `store`: a usable envelope, or why there isn't one.
 *  An incompatible schema or a data payload the store rejects is "unusable"
 *  (never applied/reinterpreted, and never overwritten either). */
function remoteFor(
  remote: RemoteFiles,
  store: SyncableStore,
): { state: "absent" | "unusable" } | { state: "ok"; file: SyncEnvelope } {
  const file = remote.envelopes.get(store.module);
  if (!file) {
    return {
      state: remote.unusableFiles.has(fileName(store.module))
        ? "unusable"
        : "absent",
    };
  }
  if (file.schema !== store.schema) return { state: "unusable" };
  if (store.validate && !store.validate(file.data)) {
    return { state: "unusable" };
  }
  return { state: "ok", file };
}

async function exportStore(
  dir: string,
  store: SyncableStore,
  updatedAt: number,
): Promise<void> {
  const data = await store.read();
  const envelope: SyncEnvelope = {
    module: store.module,
    schema: store.schema,
    updatedAt,
    data,
  };
  await syncFolderWrite(dir, fileName(store.module), JSON.stringify(envelope));
}

/** Run the sync algorithm once against `dir`: import any store whose remote
 *  file is newer than the local manifest, export any store that's locally
 *  newer than its remote file (or has none yet), leave the rest alone. */
export async function syncNow(dir: string): Promise<SyncResult> {
  const remote = await readRemoteFiles(dir);
  const result = emptyResult();

  for (const store of SYNC_STORES) {
    const localTs = getMeta(store.module);
    const found = remoteFor(remote, store);
    const decision = decideSync(
      localTs,
      found.state === "ok" ? found.file.updatedAt : found.state,
    );

    if (decision === "skip") {
      result.skipped.push(store.module);
    } else if (decision === "import" && found.state === "ok") {
      await store.apply(found.file.data);
      setMeta(store.module, found.file.updatedAt);
      result.imported.push(store.module);
    } else if (decision === "export") {
      await exportStore(dir, store, localTs);
      result.exported.push(store.module);
    } else {
      result.unchanged.push(store.module);
    }
  }

  return result;
}

/** Force-export every store to `dir`, bumping each one's `updatedAt` to
 *  `max(local manifest, now)` and overwriting whatever's already there —
 *  for first-time setup or "this device is the source of truth". */
export async function pushAll(dir: string): Promise<SyncResult> {
  const result = emptyResult();
  for (const store of SYNC_STORES) {
    const updatedAt = Math.max(getMeta(store.module), Date.now());
    await exportStore(dir, store, updatedAt);
    setMeta(store.module, updatedAt);
    result.exported.push(store.module);
  }
  return result;
}

/** Force-import every store that has a (schema-matching) remote file in
 *  `dir`, regardless of timestamps — destructive to local data, so the
 *  caller MUST confirm with the user first. */
export async function pullAll(dir: string): Promise<SyncResult> {
  const remote = await readRemoteFiles(dir);
  const result = emptyResult();
  for (const store of SYNC_STORES) {
    const found = remoteFor(remote, store);
    if (found.state !== "ok") {
      (found.state === "unusable" ? result.skipped : result.unchanged).push(
        store.module,
      );
      continue;
    }
    await store.apply(found.file.data);
    setMeta(store.module, found.file.updatedAt);
    result.imported.push(store.module);
  }
  return result;
}
