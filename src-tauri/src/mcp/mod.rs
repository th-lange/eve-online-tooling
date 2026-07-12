//! MCP bridge — a native, localhost-only Model Context Protocol server that
//! lets external AI agents reach a curated, read-only slice of the app's data.
//!
//! This module is the transport + protocol skeleton (issue #513): a
//! [`tiny_http`] server bound to `127.0.0.1` on an ephemeral port, guarded by a
//! per-session bearer token, speaking JSON-RPC 2.0 over HTTP (`initialize`,
//! `tools/list`, `tools/call`). It ships one trivial `ping` tool to prove the
//! round-trip end to end; the real read-only tools are a later ticket (#514).
//!
//! The server must be native precisely because a sandboxed plugin has no
//! network authority — see epic #512.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use parking_lot::Mutex;
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::model::AppError;

/// MCP protocol revision this server implements.
const PROTOCOL_VERSION: &str = "2024-11-05";

/// A running server instance: where it's bound, its access token, and the
/// handle+flag used to stop its thread.
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

/// What the UI needs to show + configure a client: whether it's up, the
/// loopback URL, and the bearer token (only while running).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub url: Option<String>,
    pub token: Option<String>,
}

impl McpState {
    /// Start the server if not already running; idempotent (returns the current
    /// status when already up). Binds `127.0.0.1:0` (ephemeral port).
    pub fn start(&self) -> Result<McpStatus, String> {
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
            std::thread::spawn(move || serve(server, &token, &stop))
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

/// The request loop: poll for requests (so the stop flag is checked ~1×/s),
/// enforce the bearer token, and answer JSON-RPC. Consumes the server.
fn serve(server: tiny_http::Server, token: &str, stop: &AtomicBool) {
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
        let mut reader_ok = true;
        {
            let reader = request.as_reader();
            if reader.read_to_string(&mut body).is_err() {
                reader_ok = false;
            }
        }
        let reply = if reader_ok {
            match serde_json::from_str::<Value>(&body) {
                Ok(req) => dispatch(&req),
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
            // A JSON-RPC response.
            Some(resp) => {
                let body = serde_json::to_string(&resp).unwrap_or_default();
                let _ = request.respond(json_response(200, &body));
            }
            // A notification (no id) — acknowledge with no body.
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

/// Dispatch a JSON-RPC request. Returns `None` for notifications (no `id`),
/// which take no response.
fn dispatch(req: &Value) -> Option<Value> {
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
        "tools/call" => call_tool(req.get("params")),
        other => Err((-32601, format!("method not found: {other}"))),
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => error_response(&id, code, &message),
    })
}

/// The tools this server advertises. Scaffold: just `ping`.
fn tool_list() -> Value {
    json!([{
        "name": "ping",
        "description": "Health check — returns \"pong\". Proves the bridge is reachable.",
        "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
    }])
}

/// Handle `tools/call`. Scaffold only knows `ping`.
fn call_tool(params: Option<&Value>) -> Result<Value, (i64, String)> {
    let name = params
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .ok_or((-32602, "tools/call requires a tool name".to_string()))?;
    match name {
        "ping" => Ok(json!({ "content": [{ "type": "text", "text": "pong" }] })),
        other => Err((-32602, format!("unknown tool: {other}"))),
    }
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

/// Start the MCP bridge; returns its status (URL + token).
#[tauri::command]
pub fn mcp_start(state: State<'_, McpState>) -> Result<McpStatus, AppError> {
    state.start().map_err(AppError::from)
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

    #[test]
    fn initialize_reports_protocol_and_server_info() {
        let req = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" });
        let resp = dispatch(&req).unwrap();
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(resp["result"]["serverInfo"]["name"], "eve-online-tooling");
    }

    #[test]
    fn tools_list_advertises_ping() {
        let req = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let resp = dispatch(&req).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "ping");
    }

    #[test]
    fn tools_call_ping_returns_pong() {
        let req = json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "ping", "arguments": {} }
        });
        let resp = dispatch(&req).unwrap();
        assert_eq!(resp["result"]["content"][0]["text"], "pong");
    }

    #[test]
    fn unknown_method_and_tool_are_errors() {
        let bad_method = dispatch(&json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" })).unwrap();
        assert_eq!(bad_method["error"]["code"], -32601);
        let bad_tool = dispatch(&json!({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "name": "ghost" }
        }))
        .unwrap();
        assert_eq!(bad_tool["error"]["code"], -32602);
    }

    #[test]
    fn a_notification_gets_no_response() {
        // No `id` -> notification -> nothing to send back.
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(dispatch(&note).is_none());
    }

    #[test]
    fn authorized_requires_exact_bearer_token() {
        let bearer = |v: &str| {
            vec![tiny_http::Header::from_bytes(&b"Authorization"[..], v.as_bytes()).unwrap()]
        };
        assert!(authorized(&bearer("Bearer secret"), "secret"));
        assert!(!authorized(&bearer("Bearer wrong"), "secret"));
        assert!(!authorized(&bearer("secret"), "secret")); // missing scheme
        assert!(!authorized(&[], "secret")); // no header
    }

    /// Minimal HTTP/1.1 POST over a raw socket (server sets Content-Length and
    /// closes on `Connection: close`, so we can read to EOF). Returns
    /// `(status_code, body)`.
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
    fn server_binds_loopback_and_round_trips_over_http() {
        let state = McpState::default();
        let started = state.start().unwrap();
        assert!(started.running);
        let url = started.url.clone().unwrap();
        assert!(url.starts_with("http://127.0.0.1:"));
        let token = started.token.clone().unwrap();

        // Parse the bound addr back out of the URL.
        let addr: SocketAddr = url
            .trim_start_matches("http://")
            .trim_end_matches("/mcp")
            .parse()
            .unwrap();
        assert!(addr.ip().is_loopback());

        // Correct token: initialize round-trips.
        let (ok_status, ok_body) = post(
            addr,
            &token,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
        );
        assert_eq!(ok_status, 200);
        let parsed: Value = serde_json::from_str(&ok_body).unwrap();
        assert_eq!(parsed["result"]["protocolVersion"], PROTOCOL_VERSION);

        // Wrong token: rejected.
        let (bad_status, _) = post(
            addr,
            "not-the-token",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
        );
        assert_eq!(bad_status, 401);

        // Stop is reflected in status.
        let stopped = state.stop();
        assert!(!stopped.running);
        assert!(!state.status().running);
    }
}
