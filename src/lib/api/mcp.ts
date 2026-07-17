import { invoke } from "@tauri-apps/api/core";

/** Status of the local MCP bridge (see epic #512). */
export interface McpStatus {
  running: boolean;
  /** Loopback URL an MCP client connects to (only while running). */
  url: string | null;
  /** Per-session bearer token (only while running). */
  token: string | null;
}

/** Current MCP bridge status. */
export function mcpStatus(): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_status");
}

/** Start the MCP bridge; resolves to its status (URL + token). */
export function mcpStart(): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_start");
}

/** Stop the MCP bridge. */
export function mcpStop(): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_stop");
}

/** User-configurable MCP settings. */
export interface McpConfig {
  /** Preferred port (0 = OS-assigned / auto). */
  port: number;
  /** Start the bridge automatically on app launch. */
  autostart: boolean;
  /** Advertise the dev-tier compute-engine tools (production profit, fitting
   *  stats, …) over MCP. Off by default. */
  devTier: boolean;
}

/** The current MCP configuration. */
export function mcpConfig(): Promise<McpConfig> {
  return invoke<McpConfig>("mcp_config");
}

/** Set the preferred port (0 = auto); restarts the bridge if running. */
export function mcpSetPort(port: number): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_set_port", { port });
}

/** Opt in/out of starting the MCP bridge automatically on app launch. Takes
 *  effect on the next launch; does not itself start/stop the bridge. */
export function mcpSetAutostart(autostart: boolean): Promise<McpConfig> {
  return invoke<McpConfig>("mcp_set_autostart", { autostart });
}

/** Opt in/out of advertising the dev-tier compute-engine tools (production
 *  profit, fitting stats, …) over MCP. Takes effect immediately — no bridge
 *  restart needed. */
export function mcpSetDevTier(devTier: boolean): Promise<McpConfig> {
  return invoke<McpConfig>("mcp_set_dev_tier", { devTier });
}
