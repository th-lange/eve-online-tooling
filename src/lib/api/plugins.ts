import { invoke } from "@tauri-apps/api/core";

/** A capability a plugin can declare in its manifest. */
export type PluginPermission =
  | "market:read"
  | "sde:read"
  | "assets:read"
  | "orders:read"
  | "storage:own"
  | "net:fetch"
  | "info:write";

/** Human-readable description of what each permission grants — shown on the
 *  Plugins page so the user sees what activating a plugin allows. */
export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  "market:read": "Read market prices",
  "sde:read": "Read static game data (items, blueprints)",
  "assets:read": "Read your assets",
  "orders:read": "Read your open market orders",
  "storage:own": "Store its own private data",
  "net:fetch": "Make network requests to specific sites",
  "info:write": "Post alarms and messages to the Info Panel",
};

/** A plugin's `plugin.json`, as parsed by the host. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  wasm?: string;
  ui?: string;
  permissions: PluginPermission[];
  /** Hosts the plugin may contact (only when it requests net:fetch). */
  allowedHosts?: string[];
}

/** An installed plugin plus whether it is currently activated. */
export interface PluginEntry {
  manifest: PluginManifest;
  active: boolean;
}

/** Installed plugins with their manifest metadata and activation state. */
export function pluginsList(): Promise<PluginEntry[]> {
  return invoke<PluginEntry[]>("plugins_list");
}

/** Call an exported function of an activated plugin. Inactive → rejects. */
export function pluginInvoke<T = unknown>(
  pluginId: string,
  fn: string,
  args: unknown,
): Promise<T> {
  return invoke<T>("plugin_invoke", { pluginId, fn, args });
}

/** Activate or deactivate an installed plugin. */
export function pluginSetActive(
  pluginId: string,
  active: boolean,
): Promise<void> {
  return invoke<void>("plugin_set_active", { pluginId, active });
}
