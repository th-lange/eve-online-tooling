//! EVE SSO (OAuth2 **PKCE**) flow for native desktop apps.
//!
//! Login: generate a PKCE verifier/challenge, open EVE SSO in the browser,
//! catch the `?code=` redirect on a loopback server, exchange it for tokens,
//! and decode the access-token JWT for the character. The Client ID is public
//! (native PKCE app); there is no client secret.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::cache::ConditionalCache;
use super::USER_AGENT;
use crate::model::Character;

/// Public Client ID of the registered EVE developer application (PKCE — not a
/// secret).
const CLIENT_ID: &str = "eb8ccb39b8ed4115a3d2175ab9feda8d";
const REDIRECT_URI_ENCODED: &str = "http%3A%2F%2Flocalhost%3A8765%2Fcallback";
const REDIRECT_ADDR: &str = "127.0.0.1:8765";
const AUTHORIZE_URL: &str = "https://login.eveonline.com/v2/oauth/authorize/";
const TOKEN_URL: &str = "https://login.eveonline.com/v2/oauth/token";
const SCOPES: &[&str] = &[
    "publicData",
    "esi-assets.read_assets.v1",
    "esi-characters.read_blueprints.v1",
    "esi-corporations.read_blueprints.v1",
    // Character-data features. NOTE: these must also be enabled on the EVE
    // developer application, or SSO rejects the whole login.
    "esi-ui.open_window.v1",
    "esi-characters.read_loyalty.v1",
    "esi-wallet.read_character_wallet.v1",
    "esi-skills.read_skills.v1",
    "esi-skills.read_skillqueue.v1",
    "esi-characters.read_standings.v1",
    "esi-characters.read_contacts.v1",
    "esi-characters.read_agents_research.v1",
    "esi-industry.read_character_mining.v1",
    "esi-industry.read_character_jobs.v1",
    "esi-industry.read_corporation_jobs.v1",
    "esi-markets.read_character_orders.v1",
    "esi-location.read_location.v1",
    "esi-fleets.read_fleet.v1",
];
/// How long to wait for the user to complete the browser login.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("login timed out")]
    Timeout,
    #[error("state mismatch (possible CSRF) — login aborted")]
    StateMismatch,
    #[error("could not parse the SSO token: {0}")]
    Jwt(String),
    #[error("loopback server error: {0}")]
    Server(String),
    #[error("character is not logged in")]
    NotLoggedIn,
    #[error("credential storage error: {0}")]
    Storage(String),
    #[error(transparent)]
    Esi(#[from] super::error::EsiError),
}

/// In-memory auth state: an HTTP client and a per-character access-token cache,
/// plus the shared conditional response cache for authed ESI reads. Refresh
/// tokens live in the keychain, not here.
pub struct AuthState {
    http: reqwest::Client,
    tokens: Mutex<HashMap<i64, CachedToken>>,
    cache: Arc<ConditionalCache>,
}

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

impl Default for AuthState {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthState {
    /// Auth state with no persistent response cache (pass-through).
    pub fn new() -> Self {
        Self::build(ConditionalCache::disabled())
    }

    /// Auth state whose authed reads are conditionally cached under
    /// `<dir>/esi-cache/`, surviving restarts.
    pub fn with_cache(dir: PathBuf) -> Self {
        Self::build(ConditionalCache::on_disk(dir))
    }

    fn build(cache: ConditionalCache) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .expect("failed to build HTTP client");
        Self {
            http,
            tokens: Mutex::new(HashMap::new()),
            cache: Arc::new(cache),
        }
    }

    /// The shared conditional cache, for authed endpoint wrappers.
    pub fn cache(&self) -> &ConditionalCache {
        &self.cache
    }

    fn cache_token(&self, character_id: i64, access_token: String, expires_in: u64) {
        // Refresh a minute early to avoid using a just-expired token.
        let ttl = Duration::from_secs(expires_in.saturating_sub(60));
        self.tokens.lock().unwrap().insert(
            character_id,
            CachedToken {
                access_token,
                expires_at: Instant::now() + ttl,
            },
        );
    }

    /// A valid (cached or refreshed) access token for a character, loading its
    /// refresh token from the keychain.
    pub async fn access_token_for(&self, character_id: i64) -> Result<String, AuthError> {
        if let Some(t) = self.tokens.lock().unwrap().get(&character_id) {
            if t.expires_at > Instant::now() {
                return Ok(t.access_token.clone());
            }
        }
        let refresh_token = crate::storage::load_refresh_token(character_id)
            .map_err(AuthError::Storage)?
            .ok_or(AuthError::NotLoggedIn)?;
        let tokens = refresh(&self.http, &refresh_token).await?;
        // ESI rotates refresh tokens: persist the new one so the old (now
        // invalidated) token isn't reused on the next refresh.
        if tokens.refresh_token != refresh_token {
            let _ = crate::storage::store_refresh_token(character_id, &tokens.refresh_token);
        }
        self.cache_token(character_id, tokens.access_token.clone(), tokens.expires_in);
        Ok(tokens.access_token)
    }

    pub fn forget(&self, character_id: i64) {
        self.tokens.lock().unwrap().remove(&character_id);
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
}

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

/// The EVE SSO authorize URL to open in the browser.
pub fn authorize_url(challenge: &str, state: &str) -> String {
    let scope = SCOPES.join("%20");
    format!(
        "{AUTHORIZE_URL}?response_type=code&redirect_uri={REDIRECT_URI_ENCODED}\
         &client_id={CLIENT_ID}&scope={scope}&state={state}\
         &code_challenge={challenge}&code_challenge_method=S256"
    )
}

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

pub async fn exchange_code(
    http: &reqwest::Client,
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
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await?
        .error_for_status()?;
    Ok(resp.json().await?)
}

/// Exchange a refresh token for a fresh access token.
pub async fn refresh(
    http: &reqwest::Client,
    refresh_token: &str,
) -> Result<TokenResponse, AuthError> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", CLIENT_ID),
    ];
    let resp = http
        .post(TOKEN_URL)
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

/// Bind the loopback redirect server. Done before opening the browser so the
/// redirect can't arrive first.
pub fn bind_loopback() -> Result<tiny_http::Server, AuthError> {
    tiny_http::Server::http(REDIRECT_ADDR).map_err(|e| AuthError::Server(e.to_string()))
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

/// Convenience: cache a freshly-issued access token (used after login).
pub fn cache_login_token(state: &AuthState, character: &Character, token: &TokenResponse) {
    state.cache_token(
        character.character_id,
        token.access_token.clone(),
        token.expires_in,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
