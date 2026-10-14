//! Minimal obs-websocket **v5** client (#1015) — enough to drive OBS's
//! recorder from the fight overlay: `SaveReplayBuffer` + `StartRecord` when a
//! fight is detected, `StopRecord` when it ends, `GetVersion` as the Settings
//! "Test connection" probe.
//!
//! The protocol (OBS ≥ 28, which bundles the plugin): the server greets with
//! `Hello` (op 0, carrying a challenge/salt when auth is on), the client
//! answers `Identify` (op 1) and receives `Identified` (op 2); after that,
//! requests are `{op:6, d:{requestType, requestId, requestData}}` answered by
//! op 7 with a `requestStatus`. One short-lived connection per trigger — a
//! fight happens every few minutes at most, and reconnect-on-use is far
//! simpler than keeping a session healthy across OBS restarts.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::Message;

/// Connection settings from the frontend (Settings → Record fights → OBS).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsSettings {
    /// e.g. `ws://127.0.0.1:4455`.
    pub url: String,
    /// Empty/absent when OBS auth is disabled.
    #[serde(default)]
    pub password: Option<String>,
}

/// The obs-websocket v5 auth response:
/// `base64(sha256(base64(sha256(password + salt)) + challenge))`.
pub(crate) fn auth_response(password: &str, salt: &str, challenge: &str) -> String {
    let secret = BASE64.encode(Sha256::digest(format!("{password}{salt}")));
    BASE64.encode(Sha256::digest(format!("{secret}{challenge}")))
}

/// Connect, identify (authenticating if the Hello demands it), run `requests`
/// in order, and return each one's `responseData`. A request whose
/// `requestStatus.result` is false yields `Err` for THAT slot rather than
/// aborting the whole batch — the caller decides which failures matter (e.g.
/// `SaveReplayBuffer` failing because the buffer is off is routine).
async fn obs_call(
    settings: &ObsSettings,
    requests: &[(&str, Value)],
) -> Result<Vec<Result<Value, String>>, String> {
    let (ws, _) = tokio_tungstenite::connect_async(&settings.url)
        .await
        .map_err(|e| format!("OBS not reachable at {}: {e}", settings.url))?;
    let (mut tx, mut rx) = ws.split();

    // Hello → Identify → Identified.
    let hello = next_json(&mut rx).await?;
    if hello["op"] != 0 {
        return Err("OBS sent an unexpected greeting".into());
    }
    let mut identify = json!({ "rpcVersion": 1, "eventSubscriptions": 0 });
    if let Some(auth) = hello["d"]["authentication"].as_object() {
        let password = settings.password.clone().unwrap_or_default();
        if password.is_empty() {
            return Err(
                "OBS requires a websocket password (Tools → WebSocket Server Settings)".into(),
            );
        }
        let salt = auth["salt"].as_str().unwrap_or_default();
        let challenge = auth["challenge"].as_str().unwrap_or_default();
        identify["authentication"] = json!(auth_response(&password, salt, challenge));
    }
    tx.send(Message::Text(json!({ "op": 1, "d": identify }).to_string()))
        .await
        .map_err(|e| format!("OBS handshake failed: {e}"))?;
    let identified = next_json(&mut rx).await?;
    if identified["op"] != 2 {
        return Err("OBS rejected the connection — wrong websocket password?".into());
    }

    let mut results = Vec::with_capacity(requests.len());
    for (i, (request_type, data)) in requests.iter().enumerate() {
        let id = format!("req-{i}");
        tx.send(Message::Text(
            json!({
                "op": 6,
                "d": { "requestType": request_type, "requestId": id, "requestData": data },
            })
            .to_string(),
        ))
        .await
        .map_err(|e| format!("OBS request failed: {e}"))?;
        // Skip anything that isn't our matching response (events are
        // subscribed off, but be tolerant).
        let response = loop {
            let msg = next_json(&mut rx).await?;
            if msg["op"] == 7 && msg["d"]["requestId"] == id.as_str() {
                break msg;
            }
        };
        let status = &response["d"]["requestStatus"];
        if status["result"] == true {
            results.push(Ok(response["d"]["responseData"].clone()));
        } else {
            let comment = status["comment"].as_str().unwrap_or("request failed");
            results.push(Err(format!("{request_type}: {comment}")));
        }
    }
    let _ = tx.send(Message::Close(None)).await;
    Ok(results)
}

async fn next_json(
    rx: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Result<Value, String> {
    loop {
        match rx.next().await {
            Some(Ok(Message::Text(text))) => {
                return serde_json::from_str(&text)
                    .map_err(|e| format!("OBS sent malformed JSON: {e}"));
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(format!("OBS connection error: {e}")),
            None => return Err("OBS closed the connection".into()),
        }
    }
}

/// Settings "Test connection": returns the OBS version string.
#[tauri::command]
pub async fn obs_test_connection(settings: ObsSettings) -> Result<String, String> {
    let results = obs_call(&settings, &[("GetVersion", json!({}))]).await?;
    let data = results
        .into_iter()
        .next()
        .unwrap_or(Err("no response".into()))?;
    Ok(format!(
        "OBS {} (websocket {})",
        data["obsVersion"].as_str().unwrap_or("?"),
        data["obsWebSocketVersion"].as_str().unwrap_or("?"),
    ))
}

/// Fight start: persist the replay buffer (the seconds BEFORE the fight, when
/// the buffer is enabled — quietly skipped otherwise) and start recording.
/// "Already recording" is routine (back-to-back fights), not an error.
#[tauri::command]
pub async fn obs_fight_started(settings: ObsSettings) -> Result<(), String> {
    let results = obs_call(
        &settings,
        &[("SaveReplayBuffer", json!({})), ("StartRecord", json!({}))],
    )
    .await?;
    // Connection/auth problems already returned Err above; per-request
    // failures here are tolerated by design.
    let _ = results;
    Ok(())
}

/// Fight end (after the post-roll): stop recording. Returns the clip path when
/// OBS reports one (slice 3 writes the fight sidecar next to it); `None` when
/// nothing was recording.
#[tauri::command]
pub async fn obs_fight_ended(settings: ObsSettings) -> Result<Option<String>, String> {
    let results = obs_call(&settings, &[("StopRecord", json!({}))]).await?;
    Ok(results
        .into_iter()
        .next()
        .and_then(|r| r.ok())
        .and_then(|data| data["outputPath"].as_str().map(String::from)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// Fixed vector computed independently (python hashlib):
    /// base64(sha256(base64(sha256("supersecret" + "salt123")) + "chal456")).
    #[test]
    fn auth_response_matches_the_documented_derivation() {
        assert_eq!(
            auth_response("supersecret", "salt123", "chal456"),
            EXPECTED_AUTH,
        );
    }
    const EXPECTED_AUTH: &str = "idDEUbBE8HuhAcGMbsWbFn8FoFrM8t07ova4iICqcWo=";

    /// A miniature obs-websocket v5 server: greets with an authenticated
    /// Hello, verifies the Identify auth string, answers GetVersion. Proves
    /// the whole handshake + request round-trip against a real socket.
    #[tokio::test]
    async fn handshake_authenticates_and_round_trips_a_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            ws.send(Message::Text(
                json!({ "op": 0, "d": { "rpcVersion": 1, "authentication": {
                    "salt": "salt123", "challenge": "chal456" } } })
                .to_string(),
            ))
            .await
            .unwrap();
            // Identify must carry the correct auth string.
            let identify: Value = match ws.next().await.unwrap().unwrap() {
                Message::Text(t) => serde_json::from_str(&t).unwrap(),
                other => panic!("expected Identify, got {other:?}"),
            };
            assert_eq!(identify["op"], 1);
            assert_eq!(
                identify["d"]["authentication"],
                auth_response("supersecret", "salt123", "chal456")
            );
            ws.send(Message::Text(json!({ "op": 2, "d": {} }).to_string()))
                .await
                .unwrap();
            // One GetVersion request.
            let request: Value = match ws.next().await.unwrap().unwrap() {
                Message::Text(t) => serde_json::from_str(&t).unwrap(),
                other => panic!("expected a request, got {other:?}"),
            };
            assert_eq!(request["d"]["requestType"], "GetVersion");
            ws.send(Message::Text(
                json!({ "op": 7, "d": {
                    "requestId": request["d"]["requestId"],
                    "requestStatus": { "result": true },
                    "responseData": { "obsVersion": "31.0.0", "obsWebSocketVersion": "5.5.2" },
                } })
                .to_string(),
            ))
            .await
            .unwrap();
        });

        let settings = ObsSettings {
            url: format!("ws://{addr}"),
            password: Some("supersecret".into()),
        };
        let version = obs_test_connection(settings).await.unwrap();
        assert_eq!(version, "OBS 31.0.0 (websocket 5.5.2)");
        server.await.unwrap();
    }
}
