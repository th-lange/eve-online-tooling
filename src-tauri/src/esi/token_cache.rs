//! In-memory access-token cache + keychain-backed refresh flow.
//!
//! Refresh tokens live in the OS keychain (via [`crate::storage`]); this
//! module holds the short-lived access tokens in memory, keyed by character,
//! and single-flights concurrent refreshes so EVE SSO's refresh-token
//! rotation can't strand a character logged out.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use super::auth::AuthError;
use super::cache::ConditionalCache;
use super::oauth_exchange::{refresh, TokenResponse};
use crate::model::Character;

/// SSO token endpoint. Always this outside tests; overridable via
/// [`AuthState::with_token_url`] so tests can point it at a local stub.
const TOKEN_URL: &str = "https://login.eveonline.com/v2/oauth/token";

/// Lock a `Mutex` guarding small pieces of in-memory auth state (the
/// per-character access-token cache, per-character refresh locks),
/// recovering from poison instead of panicking.
///
/// A poisoned lock here means some other thread panicked while holding it —
/// but the guarded data is just a cache: the worst a recovered guard can see
/// is a stale or missing entry, which every caller already treats as "not
/// cached" and falls back to a fresh SSO refresh/login for. Propagating the
/// panic instead would turn one earlier bug into a permanent crash loop on
/// every subsequent request that touches auth, since `access_token_for` is on
/// the hot path for every ESI call. Degrading to a re-login is the safe
/// outcome, not a crash.
fn recover_lock<'a, T>(
    result: Result<MutexGuard<'a, T>, PoisonError<MutexGuard<'a, T>>>,
) -> MutexGuard<'a, T> {
    result.unwrap_or_else(PoisonError::into_inner)
}

/// In-memory auth state: an HTTP client and a per-character access-token cache,
/// plus the shared conditional response cache for authed ESI reads. Refresh
/// tokens live in the keychain, not here.
pub struct AuthState {
    http: reqwest::Client,
    tokens: Mutex<HashMap<i64, CachedToken>>,
    /// One async lock per character, serialising that character's refreshes.
    /// EVE SSO *rotates* refresh tokens, so two concurrent refreshes would each
    /// invalidate the other's token and the loser's write would strand the
    /// character — see [`AuthState::access_token_for`].
    refresh_locks: Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>,
    cache: Arc<ConditionalCache>,
    /// SSO token endpoint. Always [`TOKEN_URL`] outside tests; overridable via
    /// [`AuthState::with_token_url`] so tests can point it at a local stub.
    token_url: String,
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
        let http = crate::esi::http_client_builder()
            .build()
            .expect("failed to build HTTP client");
        Self {
            http,
            tokens: Mutex::new(HashMap::new()),
            refresh_locks: Mutex::new(HashMap::new()),
            cache: Arc::new(cache),
            token_url: TOKEN_URL.to_string(),
        }
    }

    /// The shared conditional cache, for authed endpoint wrappers.
    pub fn cache(&self) -> &ConditionalCache {
        &self.cache
    }

    /// The SSO token endpoint — always [`TOKEN_URL`] outside tests. Passed
    /// explicitly to [`super::oauth_exchange::exchange_code`] so tests can
    /// stub it the same way [`AuthState::access_token_for`] stubs
    /// [`refresh`].
    pub fn token_url(&self) -> &str {
        &self.token_url
    }

    /// Point the SSO token endpoint at a local stub instead of EVE's real
    /// server. Test-only.
    #[cfg(test)]
    pub fn with_token_url(mut self, token_url: impl Into<String>) -> Self {
        self.token_url = token_url.into();
        self
    }

    /// The cached access token for a character, and whether it's still
    /// considered valid (i.e. would be served without a refresh). `None` when
    /// nothing is cached. Test-only.
    #[cfg(test)]
    pub fn cached_token(&self, character_id: i64) -> Option<(String, bool)> {
        recover_lock(self.tokens.lock())
            .get(&character_id)
            .map(|t| {
                let valid = t.expires_at > Instant::now();
                (t.access_token.clone(), valid)
            })
    }

    fn cache_token(&self, character_id: i64, access_token: String, expires_in: u64) {
        // Refresh a minute early to avoid using a just-expired token.
        let ttl = Duration::from_secs(expires_in.saturating_sub(60));
        recover_lock(self.tokens.lock()).insert(
            character_id,
            CachedToken {
                access_token,
                expires_at: Instant::now() + ttl,
            },
        );
    }

    /// The cached access token for a character if it is still valid.
    fn valid_cached_token(&self, character_id: i64) -> Option<String> {
        recover_lock(self.tokens.lock())
            .get(&character_id)
            .filter(|t| t.expires_at > Instant::now())
            .map(|t| t.access_token.clone())
    }

    /// The lock guarding this character's refreshes, created on first use.
    fn refresh_lock(&self, character_id: i64) -> Arc<tokio::sync::Mutex<()>> {
        recover_lock(self.refresh_locks.lock())
            .entry(character_id)
            .or_default()
            .clone()
    }

    /// A valid (cached or refreshed) access token for a character, loading its
    /// refresh token from the keychain.
    ///
    /// Refreshes are single-flighted per character: concurrent callers queue on
    /// that character's lock and whoever loses the race finds the winner's
    /// freshly cached token instead of starting a second refresh. Without this,
    /// both would POST the same refresh token, EVE SSO would rotate it twice,
    /// and the token persisted last would already be invalid — logging the
    /// character out with no visible cause.
    pub async fn access_token_for(&self, character_id: i64) -> Result<String, AuthError> {
        if let Some(token) = self.valid_cached_token(character_id) {
            return Ok(token);
        }

        let lock = self.refresh_lock(character_id);
        let _guard = lock.lock().await;
        // Re-check under the lock: another caller may have refreshed while we
        // were queued, in which case its token is now cached and good.
        if let Some(token) = self.valid_cached_token(character_id) {
            return Ok(token);
        }

        let refresh_token = crate::storage::load_refresh_token(character_id)
            .map_err(AuthError::Storage)?
            .ok_or(AuthError::NotLoggedIn)?;
        let tokens = refresh(&self.http, &refresh_token, &self.token_url).await?;
        // ESI rotates refresh tokens: persist the new one so the old (now
        // invalidated) token isn't reused on the next refresh.
        if tokens.refresh_token != refresh_token {
            if let Err(e) = crate::storage::store_refresh_token(character_id, &tokens.refresh_token)
            {
                // Not fatal to this refresh (the access token we just got is
                // still good), but silently swallowing it here means the
                // *next* refresh reuses the now-rotated-away token and the
                // character gets logged out with no clue why — log it.
                eprintln!(
                    "esi::auth: failed to persist rotated refresh token for character \
                     {character_id}: {e} — next refresh may use a stale token and force a re-login"
                );
            }
        }
        self.cache_token(character_id, tokens.access_token.clone(), tokens.expires_in);
        Ok(tokens.access_token)
    }

    pub fn forget(&self, character_id: i64) {
        recover_lock(self.tokens.lock()).remove(&character_id);
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
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
    fn cache_token_saturates_short_ttl_below_the_expiry_cushion() {
        let state = AuthState::new();
        // 30s < the 60s "refresh a minute early" cushion, so the TTL must
        // saturate to zero rather than underflow.
        state.cache_token(910_001, "short-lived".to_string(), 30);
        let (token, valid) = state.cached_token(910_001).expect("token cached");
        assert_eq!(token, "short-lived");
        assert!(
            !valid,
            "expires_in=30 is inside the 60s cushion and must not be served as valid"
        );
    }

    #[test]
    fn cache_token_with_generous_ttl_is_served_as_valid() {
        let state = AuthState::new();
        state.cache_token(910_002, "long-lived".to_string(), 3600);
        let (token, valid) = state.cached_token(910_002).expect("token cached");
        assert_eq!(token, "long-lived");
        assert!(
            valid,
            "expires_in=3600 is well outside the 60s cushion and must be served as valid"
        );
    }

    #[test]
    fn access_token_for_serves_a_still_valid_cached_token_without_refreshing() {
        let state = AuthState::new();
        state.cache_token(910_003, "cached-access-token".to_string(), 3600);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        // No refresh token is stored and no SSO stub is running, so this only
        // succeeds if the cache-hit branch returns without going further.
        let token = rt
            .block_on(state.access_token_for(910_003))
            .expect("valid cached token should be served without a refresh");
        assert_eq!(token, "cached-access-token");
    }

    /// A `keyring` credential store that (a) actually persists across
    /// separate `Entry::new` calls — unlike `keyring::mock`, whose entries
    /// have no persistence beyond the single `Entry` instance that created
    /// them, which doesn't round-trip through `crate::storage`'s
    /// call-a-fresh-`Entry`-every-time functions — and (b) counts
    /// `set_secret` calls, so tests can assert exactly when a rotation write
    /// actually happens.
    mod counting_credential {
        use std::any::Any;
        use std::collections::HashMap;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, LazyLock};

        use keyring::credential::{
            Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
        };
        use parking_lot::Mutex;

        #[derive(Default)]
        struct Inner {
            secret: Mutex<Option<Vec<u8>>>,
            set_calls: AtomicUsize,
        }

        #[derive(Clone, Default)]
        pub struct CountingCredential(Arc<Inner>);

        impl CountingCredential {
            /// Number of `set_secret`/`set_password` calls seen so far.
            pub fn set_calls(&self) -> usize {
                self.0.set_calls.load(Ordering::SeqCst)
            }
        }

        impl CredentialApi for CountingCredential {
            fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
                self.0.set_calls.fetch_add(1, Ordering::SeqCst);
                *self.0.secret.lock() = Some(secret.to_vec());
                Ok(())
            }
            fn get_secret(&self) -> keyring::Result<Vec<u8>> {
                self.0.secret.lock().clone().ok_or(keyring::Error::NoEntry)
            }
            fn delete_credential(&self) -> keyring::Result<()> {
                let mut secret = self.0.secret.lock();
                if secret.take().is_none() {
                    return Err(keyring::Error::NoEntry);
                }
                Ok(())
            }
            fn as_any(&self) -> &dyn Any {
                self
            }
        }

        struct CountingBuilder;

        impl CredentialBuilderApi for CountingBuilder {
            fn build(
                &self,
                _target: Option<&str>,
                service: &str,
                user: &str,
            ) -> keyring::Result<Box<Credential>> {
                static REGISTRY: LazyLock<Mutex<HashMap<(String, String), CountingCredential>>> =
                    LazyLock::new(|| Mutex::new(HashMap::new()));
                let mut registry = REGISTRY.lock();
                let credential = registry
                    .entry((service.to_string(), user.to_string()))
                    .or_default()
                    .clone();
                Ok(Box::new(credential))
            }
            fn as_any(&self) -> &dyn Any {
                self
            }
            fn persistence(&self) -> CredentialPersistence {
                CredentialPersistence::UntilDelete
            }
        }

        /// Install this store as `keyring`'s default credential builder for
        /// the rest of the test process.
        pub fn install() {
            keyring::set_default_credential_builder(Box::new(CountingBuilder));
        }

        /// The credential registered for a character's keychain entry.
        /// [`install`] must have run first.
        pub fn credential_for(character_id: i64) -> CountingCredential {
            let entry =
                keyring::Entry::new(crate::storage::KEYCHAIN_SERVICE, &character_id.to_string())
                    .expect("build entry");
            entry
                .get_credential()
                .downcast_ref::<CountingCredential>()
                .expect("counting credential")
                .clone()
        }
    }

    /// Bind a one-shot HTTP stub that answers the next request with `body`,
    /// returning its `http://127.0.0.1:<port>/` URL and the server thread.
    fn start_token_stub(body: String) -> (String, std::thread::JoinHandle<()>) {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind stub sso");
        let addr = server.server_addr().to_ip().expect("ip addr");
        let handle = std::thread::spawn(move || {
            if let Ok(request) = server.recv() {
                let _ = request.respond(tiny_http::Response::from_string(body));
            }
        });
        (format!("http://{addr}/"), handle)
    }

    /// Bind a stub that answers *every* request with `body`, counting them, so
    /// a test can assert how many refreshes actually went out.
    fn start_counting_token_stub(
        body: String,
    ) -> (
        String,
        Arc<std::sync::atomic::AtomicUsize>,
        std::thread::JoinHandle<()>,
    ) {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind stub sso");
        let addr = server.server_addr().to_ip().expect("ip addr");
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        let handle = std::thread::spawn(move || {
            for request in server.incoming_requests() {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = request.respond(tiny_http::Response::from_string(body.clone()));
            }
        });
        (format!("http://{addr}/"), hits, handle)
    }

    #[test]
    fn concurrent_callers_share_one_refresh() {
        counting_credential::install();
        let character_id = 910_104;
        crate::storage::store_refresh_token(character_id, "old-refresh-token")
            .expect("seed initial refresh token");

        let body = serde_json::json!({
            "access_token": "fresh-access-token",
            "refresh_token": "rotated-refresh-token",
            "expires_in": 1200,
        })
        .to_string();
        let (url, hits, _server) = start_counting_token_stub(body);
        let state = Arc::new(AuthState::new().with_token_url(url));

        // Several commands asking at once — the normal case when a page mounts
        // and fires its queries together.
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("runtime");
        let tokens: Vec<String> = rt.block_on(async {
            let calls = (0..4).map(|_| {
                let state = state.clone();
                tokio::spawn(async move { state.access_token_for(character_id).await })
            });
            futures_util::future::join_all(calls)
                .await
                .into_iter()
                .map(|j| j.expect("task").expect("refresh should succeed"))
                .collect()
        });

        assert!(tokens.iter().all(|t| t == "fresh-access-token"));
        // Exactly one refresh POST: any more would have rotated the refresh
        // token again and invalidated whichever result was stored last.
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            crate::storage::load_refresh_token(character_id).unwrap(),
            Some("rotated-refresh-token".to_string())
        );
    }

    #[test]
    fn access_token_for_reports_not_logged_in_when_nothing_is_stored() {
        counting_credential::install();
        let state = AuthState::new();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let err = rt
            .block_on(state.access_token_for(910_101))
            .expect_err("no refresh token stored for this character");
        assert!(
            matches!(err, AuthError::NotLoggedIn),
            "expected NotLoggedIn, got {err:?}"
        );
    }

    #[test]
    fn access_token_for_persists_a_rotated_refresh_token() {
        counting_credential::install();
        let character_id = 910_102;
        crate::storage::store_refresh_token(character_id, "old-refresh-token")
            .expect("seed initial refresh token");
        assert_eq!(
            counting_credential::credential_for(character_id).set_calls(),
            1
        );

        let body = serde_json::json!({
            "access_token": "fresh-access-token",
            "refresh_token": "rotated-refresh-token",
            "expires_in": 1200,
        })
        .to_string();
        let (url, server_thread) = start_token_stub(body);
        let state = AuthState::new().with_token_url(url);

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let access_token = rt
            .block_on(state.access_token_for(character_id))
            .expect("refresh should succeed");
        assert_eq!(access_token, "fresh-access-token");

        // The rotated token differs from what was on file, so the write-back
        // must have fired exactly once more.
        assert_eq!(
            counting_credential::credential_for(character_id).set_calls(),
            2
        );
        assert_eq!(
            crate::storage::load_refresh_token(character_id).unwrap(),
            Some("rotated-refresh-token".to_string())
        );

        server_thread.join().expect("server thread");
    }

    #[test]
    fn access_token_for_skips_a_redundant_store_when_the_refresh_token_is_unchanged() {
        counting_credential::install();
        let character_id = 910_103;
        crate::storage::store_refresh_token(character_id, "same-refresh-token")
            .expect("seed initial refresh token");
        assert_eq!(
            counting_credential::credential_for(character_id).set_calls(),
            1
        );

        let body = serde_json::json!({
            "access_token": "fresh-access-token",
            "refresh_token": "same-refresh-token",
            "expires_in": 1200,
        })
        .to_string();
        let (url, server_thread) = start_token_stub(body);
        let state = AuthState::new().with_token_url(url);

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let access_token = rt
            .block_on(state.access_token_for(character_id))
            .expect("refresh should succeed");
        assert_eq!(access_token, "fresh-access-token");

        // ESI returned the same refresh token we already had on file: no
        // redundant write-back.
        assert_eq!(
            counting_credential::credential_for(character_id).set_calls(),
            1,
            "unchanged refresh token must not trigger a redundant store"
        );

        server_thread.join().expect("server thread");
    }
}
