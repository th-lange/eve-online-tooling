//! EVE SSO (OAuth2 **PKCE**) flow for native desktop apps.
//!
//! Generate a PKCE verifier/challenge, open EVE SSO in the browser, catch the
//! `?code=` redirect on a loopback server, exchange it for tokens, and decode
//! the access-token JWT for the character. The Client ID is public (native
//! PKCE app); there is no client secret.

use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::auth::AuthError;

/// Public Client ID of the registered EVE developer application (PKCE — not a
/// secret).
const CLIENT_ID: &str = "eb8ccb39b8ed4115a3d2175ab9feda8d";
/// Loopback port for the SSO redirect. Must be registered as a callback
/// (`http://localhost:8765/callback`) on the EVE developer application. Fixed
/// (not a fallback range): EVE only accepts registered redirect URIs, so binding
/// any other port would just yield a confusing "redirect not configured" error.
const REDIRECT_PORT: u16 = 8765;
const AUTHORIZE_URL: &str = "https://login.eveonline.com/v2/oauth/authorize/";
const SCOPES: &[&str] = &[
    "publicData",
    "esi-assets.read_assets.v1",
    "esi-assets.read_corporation_assets.v1",
    "esi-characters.read_blueprints.v1",
    "esi-corporations.read_blueprints.v1",
    // Character-data features. NOTE: these must also be enabled on the EVE
    // developer application, or SSO rejects the whole login.
    "esi-ui.open_window.v1",
    "esi-ui.write_waypoint.v1",
    "esi-characters.read_loyalty.v1",
    "esi-wallet.read_character_wallet.v1",
    "esi-skills.read_skills.v1",
    "esi-skills.read_skillqueue.v1",
    "esi-characters.read_standings.v1",
    "esi-characters.read_contacts.v1",
    "esi-corporations.read_contacts.v1",
    "esi-alliances.read_contacts.v1",
    "esi-characters.read_agents_research.v1",
    "esi-characters.read_notifications.v1",
    "esi-industry.read_character_mining.v1",
    "esi-industry.read_character_jobs.v1",
    "esi-industry.read_corporation_jobs.v1",
    "esi-planets.manage_planets.v1",
    "esi-markets.read_character_orders.v1",
    "esi-location.read_location.v1",
    // Current ship hull (combat overlay auto-loads your fit's optimals + drone
    // reminders). Must also be enabled on the EVE developer application.
    "esi-location.read_ship_type.v1",
    "esi-fleets.read_fleet.v1",
    // Character + corp saved fittings (#178). These must also be enabled on the
    // EVE developer application registration before the SSO grant includes them.
    "esi-fittings.read_fittings.v1",
    "esi-fittings.write_fittings.v1",
];
/// How long to wait for the user to complete the browser login.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

/// PKCE verifier + challenge.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

fn random_b64(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// S256 code challenge for a verifier.
fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn generate_pkce() -> Pkce {
    let verifier = random_b64(32);
    let challenge = code_challenge(&verifier);
    Pkce {
        verifier,
        challenge,
    }
}

pub fn random_state() -> String {
    random_b64(16)
}

/// The EVE SSO authorize URL to open in the browser. The `redirect_uri` is the
/// fixed loopback callback registered on the EVE app.
pub fn authorize_url(challenge: &str, state: &str) -> String {
    let scope = SCOPES.join("%20");
    // URL-encoded `http://localhost:8765/callback`.
    let redirect_uri = format!("http%3A%2F%2Flocalhost%3A{REDIRECT_PORT}%2Fcallback");
    format!(
        "{AUTHORIZE_URL}?response_type=code&redirect_uri={redirect_uri}\
         &client_id={CLIENT_ID}&scope={scope}&state={state}\
         &code_challenge={challenge}&code_challenge_method=S256"
    )
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

/// Exchange an authorization code for tokens. `token_url` is the SSO token
/// endpoint — always [`super::token_cache::TOKEN_URL`] outside tests;
/// overridable so tests can point it at a local stub, mirroring [`refresh`].
pub async fn exchange_code(
    http: &reqwest::Client,
    token_url: &str,
    code: &str,
    verifier: &str,
) -> Result<TokenResponse, AuthError> {
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ];
    let resp = http
        .post(token_url)
        .form(&params)
        .send()
        .await?
        .error_for_status()?;
    Ok(resp.json().await?)
}

/// Exchange a refresh token for a fresh access token. `token_url` is the SSO
/// token endpoint — always the real SSO token endpoint outside tests.
pub async fn refresh(
    http: &reqwest::Client,
    refresh_token: &str,
    token_url: &str,
) -> Result<TokenResponse, AuthError> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", CLIENT_ID),
    ];
    let resp = http
        .post(token_url)
        .form(&params)
        .send()
        .await?
        .error_for_status()?;
    Ok(resp.json().await?)
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Scp {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
    name: String,
    #[serde(default)]
    scp: Option<Scp>,
}

/// The character identified by a verified SSO access token.
pub struct TokenCharacter {
    pub character_id: i64,
    pub name: String,
    pub scopes: Vec<String>,
}

/// Decode the character from the access-token JWT. The token came straight from
/// EVE's token endpoint over TLS, so we read the claims rather than re-verifying
/// the signature (a JWKS check is a future hardening step).
pub fn character_from_token(access_token: &str) -> Result<TokenCharacter, AuthError> {
    let payload = access_token
        .split('.')
        .nth(1)
        .ok_or_else(|| AuthError::Jwt("not a JWT".into()))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|e| AuthError::Jwt(e.to_string()))?;
    let claims: Claims =
        serde_json::from_slice(&bytes).map_err(|e| AuthError::Jwt(e.to_string()))?;
    let character_id = character_id_from_sub(&claims.sub)
        .ok_or_else(|| AuthError::Jwt(format!("unexpected sub: {}", claims.sub)))?;
    let scopes = match claims.scp {
        Some(Scp::One(s)) => vec![s],
        Some(Scp::Many(v)) => v,
        None => Vec::new(),
    };
    Ok(TokenCharacter {
        character_id,
        name: claims.name,
        scopes,
    })
}

/// Parse the character id from a `sub` like `CHARACTER:EVE:2112625428`.
fn character_id_from_sub(sub: &str) -> Option<i64> {
    sub.rsplit(':').next()?.parse().ok()
}

/// Bind the loopback redirect server on the fixed [`REDIRECT_PORT`]. Done before
/// opening the browser so the redirect can't arrive before we're listening. A
/// busy port is almost always a login that's still open (its server holds 8765
/// until it completes or times out), so the error says so rather than failing
/// obscurely.
pub fn bind_loopback() -> Result<tiny_http::Server, AuthError> {
    tiny_http::Server::http(("127.0.0.1", REDIRECT_PORT)).map_err(|_| {
        AuthError::Server(format!(
            "port {REDIRECT_PORT} is in use — a previous login may still be open; \
             quit and relaunch the app, then try again"
        ))
    })
}

/// Block until the SSO redirect arrives (or we time out), returning the code.
pub fn capture_code(server: tiny_http::Server, expected_state: &str) -> Result<String, AuthError> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return Err(AuthError::Timeout);
        }
        match server.recv_timeout(Duration::from_secs(1)) {
            Ok(Some(request)) => {
                let (code, state) = parse_callback(request.url());
                let _ = request.respond(done_page());
                if let Some(code) = code {
                    return if state.as_deref() == Some(expected_state) {
                        Ok(code)
                    } else {
                        Err(AuthError::StateMismatch)
                    };
                }
                // Ignore unrelated requests (e.g. favicon) and keep waiting.
            }
            Ok(None) => continue,
            Err(e) => return Err(AuthError::Server(e.to_string())),
        }
    }
}

fn parse_callback(path_and_query: &str) -> (Option<String>, Option<String>) {
    let Ok(url) = reqwest::Url::parse(&format!("http://localhost{path_and_query}")) else {
        return (None, None);
    };
    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            _ => {}
        }
    }
    (code, state)
}

fn done_page() -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let html = "<!doctype html><html><body style=\"font-family:sans-serif;background:#18181b;color:#e4e4e7;padding:3rem;text-align:center\">\
        <h2>Login complete</h2><p>You can close this tab and return to EVE Online Tooling.</p></body></html>";
    let header =
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
            .expect("valid header");
    tiny_http::Response::from_string(html).with_header(header)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    #[test]
    fn authorize_url_uses_the_registered_redirect_uri() {
        let url = authorize_url("chal", "st");
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcallback"));
        assert!(url.contains("code_challenge=chal"));
        assert!(url.contains("state=st"));
        assert!(url.contains("code_challenge_method=S256"));
    }

    #[test]
    fn code_challenge_matches_rfc7636_vector() {
        // RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn parses_character_id_from_sub() {
        assert_eq!(
            character_id_from_sub("CHARACTER:EVE:2112625428"),
            Some(2112625428)
        );
        assert_eq!(character_id_from_sub("nonsense"), None);
    }

    #[test]
    fn decodes_character_from_jwt() {
        // header.payload.sig — only the payload matters here.
        let payload = serde_json::json!({
            "sub": "CHARACTER:EVE:95465499",
            "name": "Test Pilot",
            "scp": ["publicData", "esi-assets.read_assets.v1"],
            "exp": 9999999999i64
        });
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let token = format!("aGVhZGVy.{encoded}.c2ln");
        let c = character_from_token(&token).unwrap();
        assert_eq!(c.character_id, 95465499);
        assert_eq!(c.name, "Test Pilot");
        assert_eq!(c.scopes.len(), 2);
    }

    #[test]
    fn decodes_single_scope_jwt() {
        let payload = serde_json::json!({
            "sub": "CHARACTER:EVE:1",
            "name": "Solo",
            "scp": "publicData"
        });
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let token = format!("h.{encoded}.s");
        let c = character_from_token(&token).unwrap();
        assert_eq!(c.scopes, vec!["publicData".to_string()]);
    }

    #[test]
    fn pkce_challenge_is_deterministic_for_verifier() {
        let p = generate_pkce();
        assert_eq!(code_challenge(&p.verifier), p.challenge);
    }

    #[test]
    fn exchange_code_posts_expected_form_params() {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind stub sso");
        let addr = server.server_addr().to_ip().expect("ip addr");
        let captured: Arc<parking_lot::Mutex<Option<String>>> =
            Arc::new(parking_lot::Mutex::new(None));
        let captured_writer = captured.clone();
        let body = serde_json::json!({
            "access_token": "fresh-access-token",
            "refresh_token": "fresh-refresh-token",
            "expires_in": 1200,
        })
        .to_string();
        let server_thread = std::thread::spawn(move || {
            if let Ok(mut request) = server.recv() {
                let mut form = String::new();
                let _ = request.as_reader().read_to_string(&mut form);
                *captured_writer.lock() = Some(form);
                let _ = request.respond(tiny_http::Response::from_string(body));
            }
        });
        let token_url = format!("http://{addr}/");

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let http = reqwest::Client::new();
        let tokens = rt
            .block_on(exchange_code(&http, &token_url, "the-code", "the-verifier"))
            .expect("exchange should succeed");
        assert_eq!(tokens.access_token, "fresh-access-token");

        server_thread.join().expect("server thread");
        let form = captured.lock().clone().expect("request captured");
        // Values in this test are plain ASCII, so a bare `k=v` split (no
        // percent-decoding) is enough to assert the params `reqwest::form`
        // sent.
        let params: HashMap<&str, &str> = form
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .collect();
        assert_eq!(params.get("grant_type"), Some(&"authorization_code"));
        assert_eq!(params.get("code"), Some(&"the-code"));
        assert_eq!(params.get("client_id"), Some(&CLIENT_ID));
        assert_eq!(params.get("code_verifier"), Some(&"the-verifier"));
    }

    #[test]
    fn exchange_code_maps_a_400_to_a_status_bearing_http_error() {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind stub sso");
        let addr = server.server_addr().to_ip().expect("ip addr");
        let server_thread = std::thread::spawn(move || {
            if let Ok(request) = server.recv() {
                let _ = request.respond(
                    tiny_http::Response::from_string(r#"{"error":"invalid_grant"}"#)
                        .with_status_code(400),
                );
            }
        });
        let token_url = format!("http://{addr}/");

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let http = reqwest::Client::new();
        let err = rt
            .block_on(exchange_code(&http, &token_url, "stale-code", "verifier"))
            .expect_err("400 must surface as an error");
        match err {
            AuthError::Http(e) => {
                assert_eq!(e.status(), Some(reqwest::StatusCode::BAD_REQUEST));
            }
            other => panic!("expected AuthError::Http(400), got {other:?}"),
        }

        server_thread.join().expect("server thread");
    }
}
