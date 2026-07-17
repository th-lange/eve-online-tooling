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

/** Re-scan the plugins folder so a plugin added or removed since launch is
 *  picked up without restarting the app. Returns the fresh list. */
export function pluginsRescan(): Promise<PluginEntry[]> {
  return invoke<PluginEntry[]>("plugins_rescan");
}

/** Install a plugin dropped onto the Plugins page: `path` is an absolute
 *  path to either a plugin folder or a `.zip` of one. Replaces any existing
 *  install of the same id (also how a reinstall/update works). Returns the
 *  fresh installed list. */
export function pluginsInstall(path: string): Promise<PluginEntry[]> {
  return invoke<PluginEntry[]>("plugins_install", { path });
}

/** Uninstall a plugin: deactivate it, remove it from the list, and delete
 *  its folder on disk. Returns the fresh installed list. */
export function pluginsRemove(pluginId: string): Promise<PluginEntry[]> {
  return invoke<PluginEntry[]>("plugins_remove", { pluginId });
}

/** The absolute path plugins install into (differs per OS), for showing the
 *  user where to drop a plugin folder. */
export function pluginsDir(): Promise<string> {
  return invoke<string>("plugins_dir");
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
