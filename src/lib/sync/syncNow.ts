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
}

function fileName(module: string): string {
  return `${module}.json`;
}

/** Every `*.json` file in `dir`, parsed and keyed by its `module` field.
 *  Files that aren't a well-formed envelope (foreign/corrupt JSON in the
 *  folder) are silently skipped rather than failing the whole sync. */
async function readRemoteFiles(
  dir: string,
): Promise<Map<string, SyncEnvelope>> {
  const files = await syncFolderRead(dir);
  const map = new Map<string, SyncEnvelope>();
  for (const file of files) {
    try {
      const parsed = JSON.parse(file.content) as Partial<SyncEnvelope>;
      if (
        typeof parsed.module === "string" &&
        typeof parsed.schema === "number" &&
        typeof parsed.updatedAt === "number" &&
        "data" in parsed
      ) {
        map.set(parsed.module, parsed as SyncEnvelope);
      }
    } catch {
      // Not valid JSON — ignore.
    }
  }
  return map;
}

/** The remote file for `store`, or `undefined` if absent or written by an
 *  incompatible schema version (never applied/reinterpreted). */
function matchingRemote(
  remote: Map<string, SyncEnvelope>,
  store: SyncableStore,
): SyncEnvelope | undefined {
  const file = remote.get(store.module);
  return file && file.schema === store.schema ? file : undefined;
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
  const result: SyncResult = { imported: [], exported: [], unchanged: [] };

  for (const store of SYNC_STORES) {
    const localTs = getMeta(store.module);
    const remoteFile = matchingRemote(remote, store);
    const decision = decideSync(localTs, remoteFile?.updatedAt);

    if (decision === "import" && remoteFile) {
      await store.apply(remoteFile.data);
      setMeta(store.module, remoteFile.updatedAt);
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
  const result: SyncResult = { imported: [], exported: [], unchanged: [] };
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
  const result: SyncResult = { imported: [], exported: [], unchanged: [] };
  for (const store of SYNC_STORES) {
    const remoteFile = matchingRemote(remote, store);
    if (!remoteFile) {
      result.unchanged.push(store.module);
      continue;
    }
    await store.apply(remoteFile.data);
    setMeta(store.module, remoteFile.updatedAt);
    result.imported.push(store.module);
  }
  return result;
}
