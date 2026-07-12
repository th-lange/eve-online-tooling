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
use tauri::{AppHandle, Manager, State};

use crate::market::{default_region_id, resolve_location, MarketService};
use crate::model::AppError;
use crate::sde::{Sde, SdePaths};

/// MCP protocol revision this server implements.
const PROTOCOL_VERSION: &str = "2024-11-05";
/// Hard cap on `sde_search` results, whatever the caller asks for.
const SEARCH_LIMIT_MAX: i64 = 50;
/// Reject absurdly long search queries (an LLM could send anything).
const QUERY_MAX_LEN: usize = 200;

/// The **only** capabilities MCP tools may reach: read-only game data. No auth
/// state, no ESI token, no keychain, no filesystem beyond the SDE db, no write
/// path — a tool physically cannot touch anything else.
pub struct ToolCtx {
    app_data_dir: PathBuf,
    market: MarketService,
}

impl ToolCtx {
    fn open_sde(&self) -> Result<Sde, (i64, String)> {
        Sde::open(&SdePaths::new(self.app_data_dir.clone()).db)
            .map_err(|e| (-32603, format!("static data unavailable: {e}")))
    }
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
    /// Start the server (idempotent) with the given read-only tool context.
    pub fn start(&self, ctx: Arc<ToolCtx>) -> Result<McpStatus, String> {
        let mut guard = self.running.lock();
        if let Some(r) = guard.as_ref() {
            return Ok(status_of(Some(r)));
        }
        let server = tiny_http::Server::http(("127.0.0.1", 0))
            .map_err(|e| format!("could not start MCP server: {e}"))?;
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
        "tools/list" => Ok(json!({ "tools": tool_list() })),
        "tools/call" => call_tool(req.get("params"), ctx),
        other => Err((-32601, format!("method not found: {other}"))),
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => error_response(&id, code, &message),
    })
}

/// The read-only tools this server advertises.
fn tool_list() -> Value {
    json!([
        {
            "name": "ping",
            "description": "Health check — returns \"pong\".",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
        },
        {
            "name": "sde_search",
            "description": "Search EVE item types by name. Returns matching type ids + names.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Name substring(s) to match." },
                    "limit": { "type": "integer", "description": "Max results (capped at 50)." },
                },
                "required": ["query"],
            },
        },
        {
            "name": "sde_type",
            "description": "Look up an item type by id: name, group, and packaged volume.",
            "inputSchema": {
                "type": "object",
                "properties": { "typeId": { "type": "integer" } },
                "required": ["typeId"],
            },
        },
        {
            "name": "market_price",
            "description": "Market price vectors (sell/buy percentile, adjusted, average) for a type, at a region (default The Forge / Jita).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "typeId": { "type": "integer" },
                    "regionId": { "type": "integer", "description": "Optional; defaults to The Forge." },
                },
                "required": ["typeId"],
            },
        },
    ])
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
        "sde_search" => tool_sde_search(args, ctx),
        "sde_type" => tool_sde_type(args, ctx),
        "market_price" => tool_market_price(args, ctx),
        other => Err((-32602, format!("unknown tool: {other}"))),
    }
}

fn tool_sde_search(args: &Value, ctx: &ToolCtx) -> Result<Value, (i64, String)> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or((-32602, "sde_search requires a string \"query\"".to_string()))?;
    if query.trim().is_empty() || query.len() > QUERY_MAX_LEN {
        return Err((-32602, "query must be 1..=200 chars".to_string()));
    }
    let limit = args
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(SEARCH_LIMIT_MAX)
        .clamp(1, SEARCH_LIMIT_MAX);
    let sde = ctx.open_sde()?;
    let hits = sde
        .search_types(query, limit)
        .map_err(|e| (-32603, format!("search failed: {e}")))?;
    let results: Vec<Value> = hits
        .into_iter()
        .map(|(type_id, name)| json!({ "typeId": type_id, "name": name }))
        .collect();
    json_content(&json!({ "results": results }))
}

fn tool_sde_type(args: &Value, ctx: &ToolCtx) -> Result<Value, (i64, String)> {
    let type_id = args.get("typeId").and_then(Value::as_i64).ok_or((
        -32602,
        "sde_type requires an integer \"typeId\"".to_string(),
    ))?;
    let sde = ctx.open_sde()?;
    let info = sde
        .type_info(type_id)
        .map_err(|e| (-32603, format!("lookup failed: {e}")))?;
    // `null` when unknown — a clean, parseable answer.
    json_content(&json!(info))
}

fn tool_market_price(args: &Value, ctx: &ToolCtx) -> Result<Value, (i64, String)> {
    let type_id = args.get("typeId").and_then(Value::as_i64).ok_or((
        -32602,
        "market_price requires an integer \"typeId\"".to_string(),
    ))?;
    let region_id = args
        .get("regionId")
        .and_then(Value::as_i64)
        .unwrap_or_else(default_region_id);
    let location = resolve_location(region_id, None);
    // Reuses MarketService (and its caches); runs the async fetch on the app's
    // runtime, blocking this MCP worker thread until it resolves.
    let model = tauri::async_runtime::block_on(ctx.market.price_model(location, type_id))
        .map_err(|e| (-32603, format!("market lookup failed: {e}")))?;
    json_content(&json!(model))
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

/// Start the MCP bridge; returns its status (URL + token). The tool context is
/// built here from read-only handles only.
#[tauri::command]
pub fn mcp_start(app: AppHandle, state: State<'_, McpState>) -> Result<McpStatus, AppError> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let ctx = Arc::new(ToolCtx {
        app_data_dir: dir.clone(),
        market: MarketService::with_cache(dir),
    });
    state.start(ctx).map_err(AppError::from)
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
             INSERT INTO invTypes VALUES (34, 18, 'Tritanium', 0.01, 1, 1);",
        )
        .unwrap();
        let ctx = ToolCtx {
            app_data_dir: dir.clone(),
            market: MarketService::with_cache(dir.clone()),
        };
        (dir, ctx)
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
        assert!(names.contains(&"sde_type"));
        assert!(names.contains(&"market_price"));
    }

    #[test]
    fn sde_type_returns_type_info() {
        let (_d, ctx) = ctx_with_sde("type");
        let resp = call(&ctx, "sde_type", json!({ "typeId": 34 }));
        assert_eq!(payload(&resp)["name"], "Tritanium");
    }

    #[test]
    fn sde_type_unknown_is_null_not_error() {
        let (_d, ctx) = ctx_with_sde("type-null");
        let resp = call(&ctx, "sde_type", json!({ "typeId": 999999 }));
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
        let e1 = call(&ctx, "sde_type", json!({ "typeId": "not-a-number" }));
        assert_eq!(e1["error"]["code"], -32602);
        let e2 = call(&ctx, "market_price", json!({}));
        assert_eq!(e2["error"]["code"], -32602);
        let e3 = call(&ctx, "sde_search", json!({ "query": "" }));
        assert_eq!(e3["error"]["code"], -32602);
        let e4 = call(&ctx, "unknown_tool", json!({}));
        assert_eq!(e4["error"]["code"], -32602);
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
        let ctx = Arc::new(ToolCtx {
            app_data_dir: dir.clone(),
            market: MarketService::with_cache(dir.clone()),
        });
        let state = McpState::default();
        let started = state.start(ctx).unwrap();
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
