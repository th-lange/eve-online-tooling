// Types for the plugin UI SDK (plugin-ui-sdk.js). Drop this next to the SDK so
// a TypeScript UI gets a typed `invoke`.

/**
 * Call one of *your own* plugin's exported WASM functions through the host and
 * await its JSON result. The host still enforces the capabilities your
 * `plugin.json` was granted, and only ever dispatches to your own plugin — a UI
 * can drive nothing but its own (sandboxed, broker-gated) logic.
 *
 * @param fn   Exported function name in your plugin's WASM.
 * @param args JSON-serialisable argument, exactly as `plugins_invoke` receives
 *   it (e.g. a number, string, or object your function decodes).
 */
export function invoke<T = unknown>(fn: string, args?: unknown): Promise<T>;
