//! MCP bridge — a native, localhost-only Model Context Protocol server that
//! lets external AI agents reach a curated, **read-only** slice of the app's
//! data (epic #512).
//!
//! Transport: a [`tiny_http`] server bound to `127.0.0.1` on an ephemeral port,
//! guarded by a per-session bearer token, speaking JSON-RPC 2.0 over HTTP
//! (`initialize`, `tools/list`, `tools/call`).
//!
//! Tools are **read-only and public**: SDE lookups and market prices. The tool
//! layer is handed a [`ToolCtx`] carrying only the query services it may touch
//! (the SDE dir + a `MarketService`) — never `AuthState`, ESI tokens, the
//! keychain, or any write path — so an MCP tool *cannot* reach personal data or
//! mutate anything, by construction. Market lookups reuse `MarketService` and
//! therefore its caches (so a looping agent mostly hits cache, not ESI).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use parking_lot::Mutex;
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::capabilities;
use crate::esi::AuthState;
use crate::market::MarketService;
use crate::model::AppError;
use crate::plugins::manager::run_plugin;
use crate::plugins::{PluginManager, PluginRegistry};

/// MCP protocol revision this server implements.
const PROTOCOL_VERSION: &str = "2024-11-05";

/// The **only** capabilities MCP tools may reach: read-only game data. No auth
/// state, no ESI token, no keychain, no filesystem beyond the SDE db, no write
/// path — a tool physically cannot touch anything else.
pub struct ToolCtx {
    app_data_dir: PathBuf,
    market: MarketService,
    /// Live plugin state, so plugin-contributed tools reflect activation and
    /// route through the sandboxed plugin path. Shared with the Tauri commands.
    registry: Arc<PluginRegistry>,
    manager: Arc<PluginManager>,
}

struct Running {
    addr: SocketAddr,
    token: String,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

/// Managed state holding the (optional) running MCP server. Off until started.
#[derive(Default)]
pub struct McpState {
    running: Mutex<Option<Running>>,
}

/// What the UI needs to show + configure a client.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub url: Option<String>,
    pub token: Option<String>,
}

impl McpState {
    /// Start the server (idempotent) with the given read-only tool context,
    /// bound to `port` (`0` = an OS-assigned ephemeral port).
    pub fn start(&self, ctx: Arc<ToolCtx>, port: u16) -> Result<McpStatus, String> {
        let mut guard = self.running.lock();
        if let Some(r) = guard.as_ref() {
            return Ok(status_of(Some(r)));
        }
        let server = tiny_http::Server::http(("127.0.0.1", port))
            .map_err(|e| format!("could not start MCP server on port {port}: {e}"))?;
        let addr = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| "MCP server bound a non-IP address".to_string())?;
        let token: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(32)
            .map(char::from)
            .collect();

        let stop = Arc::new(AtomicBool::new(false));
        let handle = {
            let stop = stop.clone();
            let token = token.clone();
            std::thread::spawn(move || serve(server, &token, &stop, &ctx))
        };
        *guard = Some(Running {
            addr,
            token,
            stop,
            handle: Some(handle),
        });
        Ok(status_of(guard.as_ref()))
    }

    /// Stop the server if running; idempotent.
    pub fn stop(&self) -> McpStatus {
        let mut guard = self.running.lock();
        if let Some(mut r) = guard.take() {
            r.stop.store(true, Ordering::SeqCst);
            if let Some(handle) = r.handle.take() {
                let _ = handle.join();
            }
        }
        status_of(None)
    }

    /// Current status.
    pub fn status(&self) -> McpStatus {
        status_of(self.running.lock().as_ref())
    }
}

fn status_of(running: Option<&Running>) -> McpStatus {
    match running {
        Some(r) => McpStatus {
            running: true,
            url: Some(format!("http://{}/mcp", r.addr)),
            token: Some(r.token.clone()),
        },
        None => McpStatus {
            running: false,
            url: None,
            token: None,
        },
    }
}

/// Request loop: poll (so the stop flag is checked ~1×/s), enforce the bearer
/// token, answer JSON-RPC. Consumes the server.
fn serve(server: tiny_http::Server, token: &str, stop: &AtomicBool, ctx: &ToolCtx) {
    while !stop.load(Ordering::SeqCst) {
        let mut request = match server.recv_timeout(Duration::from_secs(1)) {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(_) => break,
        };

        if !authorized(request.headers(), token) {
            let _ = request.respond(text_response(401, ""));
            continue;
        }

        let mut body = String::new();
        let read_ok = request.as_reader().read_to_string(&mut body).is_ok();
        let reply = if read_ok {
            match serde_json::from_str::<Value>(&body) {
                Ok(req) => dispatch(&req, ctx),
                Err(_) => Some(error_response(&Value::Null, -32700, "parse error")),
            }
        } else {
            Some(error_response(
                &Value::Null,
                -32700,
                "could not read request body",
            ))
        };

        match reply {
            Some(resp) => {
                let body = serde_json::to_string(&resp).unwrap_or_default();
                let _ = request.respond(json_response(200, &body));
            }
            None => {
                let _ = request.respond(text_response(202, ""));
            }
        }
    }
}

/// True iff an `Authorization: Bearer <token>` header matches exactly.
fn authorized(headers: &[tiny_http::Header], token: &str) -> bool {
    headers
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|got| got == token)
}

/// Dispatch a JSON-RPC request. Returns `None` for notifications (no `id`).
fn dispatch(req: &Value, ctx: &ToolCtx) -> Option<Value> {
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    // A request without an id is a notification: run nothing, answer nothing.
    let id = req.get("id").cloned()?;

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "eve-online-tooling", "version": env!("CARGO_PKG_VERSION") },
        })),
        "tools/list" => Ok(json!({ "tools": tool_list(ctx) })),
        "tools/call" => call_tool(req.get("params"), ctx),
        other => Err((-32601, format!("method not found: {other}"))),
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => error_response(&id, code, &message),
    })
}

/// The tools this server advertises: the built-in read-only tools plus any
/// declared by currently-active plugins (namespaced `<pluginId>.<tool>`).
fn tool_list(ctx: &ToolCtx) -> Value {
    let mut tools = vec![json!({
        "name": "ping",
        "description": "Health check — returns \"pong\".",
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
    })];
    // Built-in tools are the MCP-exposed capabilities from the shared registry.
    for cap in capabilities::registry().iter().filter(|c| c.mcp) {
        tools.push(json!({
            "name": cap.name,
            "description": cap.description,
            "inputSchema": capabilities::input_schema(cap),
        }));
    }
    for (plugin_id, def) in ctx.registry.active_mcp_tools() {
        tools.push(json!({
            "name": format!("{plugin_id}.{}", def.name),
            "description": def.description,
            "inputSchema": def.input_schema,
        }));
    }
    Value::Array(tools)
}

/// Handle `tools/call`.
fn call_tool(params: Option<&Value>, ctx: &ToolCtx) -> Result<Value, (i64, String)> {
    let params = params.unwrap_or(&Value::Null);
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "tools/call requires a tool name".to_string()))?;
    let args = params.get("arguments").unwrap_or(&Value::Null);

    match name {
        "ping" => text_content("pong"),
        // A built-in capability (read-only, MCP-exposed) from the registry.
        other if capabilities::find(other).is_some_and(|c| c.mcp) => {
            let auth = AuthState::with_cache(ctx.app_data_dir.clone());
            let hctx = capabilities::HostCtx {
                app_data_dir: &ctx.app_data_dir,
                market: &ctx.market,
                auth: &auth,
            };
            let value = capabilities::invoke(&hctx, other, args).map_err(|e| (-32602, e))?;
            json_content(&value)
        }
        // Namespaced `<pluginId>.<tool>` -> a plugin-contributed tool.
        other => route_plugin_tool(other, args, ctx),
    }
}

/// Route a `<pluginId>.<tool>` call to the plugin that backs it, via the
/// sandboxed plugin path (which enforces active state + granted capabilities).
fn route_plugin_tool(name: &str, args: &Value, ctx: &ToolCtx) -> Result<Value, (i64, String)> {
    let unknown = || (-32602, format!("unknown tool: {name}"));
    let (plugin_id, tool) = name.split_once('.').ok_or_else(unknown)?;
    let manifest = ctx.registry.manifest(plugin_id).ok_or_else(unknown)?;
    let def = manifest
        .mcp_tools
        .iter()
        .find(|t| t.name == tool)
        .ok_or_else(unknown)?;
    let value = run_plugin(
        &ctx.registry,
        &ctx.manager,
        &ctx.app_data_dir,
        plugin_id,
        &def.function,
        args,
    )
    .map_err(|e| (-32603, e))?;
    json_content(&value)
}

/// MCP tool result carrying a plain-text payload.
fn text_content(text: &str) -> Result<Value, (i64, String)> {
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

/// MCP tool result carrying a JSON payload (serialized into a text block).
fn json_content(value: &Value) -> Result<Value, (i64, String)> {
    let text = serde_json::to_string(value).map_err(|e| (-32603, e.to_string()))?;
    text_content(&text)
}

fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn json_response(status: u16, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let header =
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header)
}

fn text_response(status: u16, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(body).with_status_code(status)
}

/// Persisted MCP config key: the configured port (`0` = auto).
const PORT_KEY: &str = "mcp_port";

/// User-configurable MCP settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    /// Preferred port (`0` = OS-assigned ephemeral).
    pub port: u16,
}

fn configured_port(dir: &std::path::Path) -> u16 {
    crate::storage::load_data::<u16>(dir, PORT_KEY).unwrap_or(0)
}

fn build_ctx(
    dir: &std::path::Path,
    registry: Arc<PluginRegistry>,
    manager: Arc<PluginManager>,
) -> Arc<ToolCtx> {
    Arc::new(ToolCtx {
        app_data_dir: dir.to_path_buf(),
        market: MarketService::with_cache(dir.to_path_buf()),
        registry,
        manager,
    })
}

/// Start the MCP bridge on the configured port; returns its status. The tool
/// context is built here from read-only handles only.
#[tauri::command]
pub fn mcp_start(
    app: AppHandle,
    state: State<'_, McpState>,
    registry: State<'_, Arc<PluginRegistry>>,
    manager: State<'_, Arc<PluginManager>>,
) -> Result<McpStatus, AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    let ctx = build_ctx(&dir, registry.inner().clone(), manager.inner().clone());
    state
        .start(ctx, configured_port(&dir))
        .map_err(AppError::from)
}

/// Stop the MCP bridge.
#[tauri::command]
pub fn mcp_stop(state: State<'_, McpState>) -> McpStatus {
    state.stop()
}

/// Current MCP bridge status.
#[tauri::command]
pub fn mcp_status(state: State<'_, McpState>) -> McpStatus {
    state.status()
}

/// The current MCP configuration (preferred port).
#[tauri::command]
pub fn mcp_config(app: AppHandle) -> Result<McpConfig, AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    Ok(McpConfig {
        port: configured_port(&dir),
    })
}

/// Set the preferred port (`0` = auto). If the bridge is running, it restarts
/// on the new port so the change takes effect immediately.
#[tauri::command]
pub fn mcp_set_port(
    app: AppHandle,
    state: State<'_, McpState>,
    registry: State<'_, Arc<PluginRegistry>>,
    manager: State<'_, Arc<PluginManager>>,
    port: u16,
) -> Result<McpStatus, AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    crate::storage::save_data(&dir, PORT_KEY, &port).map_err(AppError::from)?;
    if state.status().running {
        state.stop();
        let ctx = build_ctx(&dir, registry.inner().clone(), manager.inner().clone());
        state.start(ctx, port).map_err(AppError::from)?;
    }
    Ok(state.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eve-mcp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// A tool context backed by a temp SDE db with one type (34 = Tritanium).
    fn ctx_with_sde(tag: &str) -> (PathBuf, ToolCtx) {
        let dir = tmp(tag);
        let sde_dir = dir.join("sde");
        std::fs::create_dir_all(&sde_dir).unwrap();
        let conn = rusqlite::Connection::open(sde_dir.join("sde.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE invGroups(groupID INT, categoryID INT, groupName TEXT);
             CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL, published INT, marketGroupID INT);
             INSERT INTO invGroups VALUES (18, 4, 'Mineral');
             INSERT INTO invTypes VALUES (34, 18, 'Tritanium', 0.01, 1, 1);
             CREATE TABLE mapSolarSystems(solarSystemID INT, solarSystemName TEXT);
             INSERT INTO mapSolarSystems VALUES (30000001, 'Alpha'), (30000002, 'Beta'), (30000003, 'Gamma');
             CREATE TABLE mapSolarSystemJumps(fromSolarSystemID INT, toSolarSystemID INT);
             INSERT INTO mapSolarSystemJumps VALUES (30000001, 30000002), (30000002, 30000001), (30000002, 30000003), (30000003, 30000002);",
        )
        .unwrap();
        (dir.clone(), ctx_for(&dir))
    }

    /// Build a ToolCtx over an existing dir (registry loaded live from it).
    fn ctx_for(dir: &std::path::Path) -> ToolCtx {
        ToolCtx {
            app_data_dir: dir.to_path_buf(),
            market: MarketService::with_cache(dir.to_path_buf()),
            registry: Arc::new(PluginRegistry::load(dir)),
            manager: Arc::new(PluginManager::new()),
        }
    }

    fn call(ctx: &ToolCtx, name: &str, args: Value) -> Value {
        let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": name, "arguments": args } });
        dispatch(&req, ctx).unwrap()
    }

    /// Parse the JSON text payload out of a tools/call result.
    fn payload(resp: &Value) -> Value {
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn initialize_and_tools_list() {
        let (_d, ctx) = ctx_with_sde("init");
        let init = dispatch(
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }),
            &ctx,
        )
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL_VERSION);
        let list = dispatch(
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            &ctx,
        )
        .unwrap();
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"sde_search"));
        assert!(names.contains(&"sde_type_info"));
        assert!(names.contains(&"market_price"));
    }

    #[test]
    fn sde_type_returns_type_info() {
        let (_d, ctx) = ctx_with_sde("type");
        let resp = call(&ctx, "sde_type_info", json!({ "typeId": 34 }));
        assert_eq!(payload(&resp)["name"], "Tritanium");
    }

    #[test]
    fn sde_type_unknown_is_null_not_error() {
        let (_d, ctx) = ctx_with_sde("type-null");
        let resp = call(&ctx, "sde_type_info", json!({ "typeId": 999999 }));
        assert!(payload(&resp).is_null());
    }

    #[test]
    fn sde_search_finds_by_name() {
        let (_d, ctx) = ctx_with_sde("search");
        let resp = call(&ctx, "sde_search", json!({ "query": "trit" }));
        let results = payload(&resp)["results"].as_array().unwrap().clone();
        assert!(results.iter().any(|r| r["typeId"] == 34));
    }

    #[test]
    fn bad_arguments_are_clean_errors() {
        let (_d, ctx) = ctx_with_sde("bad");
        // Missing/!integer typeId -> validation error, no panic, no network.
        let e1 = call(&ctx, "sde_type_info", json!({ "typeId": "not-a-number" }));
        assert_eq!(e1["error"]["code"], -32602);
        let e2 = call(&ctx, "market_price", json!({}));
        assert_eq!(e2["error"]["code"], -32602);
        let e3 = call(&ctx, "sde_search", json!({ "query": "" }));
        assert_eq!(e3["error"]["code"], -32602);
        let e4 = call(&ctx, "unknown_tool", json!({}));
        assert_eq!(e4["error"]["code"], -32602);
    }

    #[test]
    fn route_counts_stargate_jumps_by_name() {
        let (_d, ctx) = ctx_with_sde("route");
        // Alpha - Beta - Gamma; Alpha to Gamma is 2 jumps.
        let r = call(&ctx, "route", json!({ "from": "Alpha", "to": "Gamma" }));
        let p = payload(&r);
        assert_eq!(p["jumps"], 2);
        assert_eq!(p["reachable"], true);
        assert_eq!(p["from"], "Alpha");
        assert_eq!(p["to"], "Gamma");
        // Same system is zero jumps (case-insensitive name match).
        let self_route = call(&ctx, "route", json!({ "from": "beta", "to": "Beta" }));
        assert_eq!(payload(&self_route)["jumps"], 0);
    }

    #[test]
    fn route_unknown_system_is_a_clean_error() {
        let (_d, ctx) = ctx_with_sde("route-bad");
        let r = call(&ctx, "route", json!({ "from": "Alpha", "to": "Nowhere" }));
        assert_eq!(r["error"]["code"], -32602);
    }

    #[test]
    fn appraise_validates_input_without_touching_the_market() {
        let (_d, ctx) = ctx_with_sde("appraise-bad");
        // No items array, and empty array -> validation errors, no network.
        assert_eq!(call(&ctx, "appraise", json!({}))["error"]["code"], -32602);
        assert_eq!(
            call(&ctx, "appraise", json!({ "items": [] }))["error"]["code"],
            -32602
        );
    }

    #[test]
    fn configured_port_persists_and_defaults_to_auto() {
        let dir = tmp("port");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(configured_port(&dir), 0); // default = ephemeral
        crate::storage::save_data(&dir, PORT_KEY, &8477u16).unwrap();
        assert_eq!(configured_port(&dir), 8477);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_notification_gets_no_response() {
        let (_d, ctx) = ctx_with_sde("note");
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(dispatch(&note, &ctx).is_none());
    }

    #[test]
    fn authorized_requires_exact_bearer_token() {
        let bearer = |v: &str| {
            vec![tiny_http::Header::from_bytes(&b"Authorization"[..], v.as_bytes()).unwrap()]
        };
        assert!(authorized(&bearer("Bearer secret"), "secret"));
        assert!(!authorized(&bearer("Bearer wrong"), "secret"));
        assert!(!authorized(&bearer("secret"), "secret"));
        assert!(!authorized(&[], "secret"));
    }

    #[test]
    fn plugin_tool_appears_only_while_active_and_routes() {
        let dir = tmp("plugin-tool");
        let pdir = dir.join("plugins").join("echo-plugin");
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(
            pdir.join("plugin.json"),
            r#"{"id":"echo-plugin","name":"Echo","version":"0.1.0","minAppVersion":"0.33.0","wasm":"echo.wasm","mcpTools":[{"name":"echo","description":"echoes input","inputSchema":{"type":"object"},"function":"echo"}]}"#,
        )
        .unwrap();
        std::fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins/testdata/echo.wasm"),
            pdir.join("echo.wasm"),
        )
        .unwrap();
        let ctx = ctx_for(&dir);

        let names = |ctx: &ToolCtx| -> Vec<String> {
            let list = dispatch(
                &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
                ctx,
            )
            .unwrap();
            list["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect()
        };

        // Inactive: not advertised, not callable.
        assert!(!names(&ctx).contains(&"echo-plugin.echo".to_string()));
        assert!(call(&ctx, "echo-plugin.echo", json!({ "a": 1 }))
            .get("error")
            .is_some());

        // Active: advertised, and a call routes through the plugin (echo returns
        // its input verbatim).
        ctx.registry.set_active("echo-plugin", true).unwrap();
        assert!(names(&ctx).contains(&"echo-plugin.echo".to_string()));
        let r = call(&ctx, "echo-plugin.echo", json!({ "a": 1 }));
        assert_eq!(payload(&r), json!({ "a": 1 }));

        // Deactivated: gone again.
        ctx.registry.set_active("echo-plugin", false).unwrap();
        assert!(!names(&ctx).contains(&"echo-plugin.echo".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn post(addr: SocketAddr, token: &str, body: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(addr).unwrap();
        let req = format!(
            "POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let status = raw
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let body = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body)
    }

    #[test]
    fn server_binds_loopback_and_enforces_token_over_http() {
        let dir = tmp("http");
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = Arc::new(ctx_for(&dir));
        let state = McpState::default();
        let started = state.start(ctx, 0).unwrap();
        let url = started.url.clone().unwrap();
        let token = started.token.clone().unwrap();
        let addr: SocketAddr = url
            .trim_start_matches("http://")
            .trim_end_matches("/mcp")
            .parse()
            .unwrap();
        assert!(addr.ip().is_loopback());

        let (ok, body) = post(
            addr,
            &token,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
        );
        assert_eq!(ok, 200);
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["result"]["protocolVersion"], PROTOCOL_VERSION);

        let (bad, _) = post(
            addr,
            "wrong",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
        );
        assert_eq!(bad, 401);

        assert!(!state.stop().running);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
