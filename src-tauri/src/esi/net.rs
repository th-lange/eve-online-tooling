//! Shared network policy for ESI: error-budget backoff + transient retries.
//!
//! ESI enforces a per-IP **error budget** (~100 errored requests per rolling
//! ~60s window) and signals it on every response via
//! `X-ESI-Error-Limit-Remain` / `X-ESI-Error-Limit-Reset`. Blow the budget and
//! ESI returns **420 "error limited"** and can temp-ban the IP. So all ESI
//! traffic flows through [`send_retrying`], which:
//!
//! - tracks the budget in a process-global [`ErrorBudget`] (shared across the
//!   public and authed clients — the limit is per-IP, not per-client), and
//!   **pauses until the window resets** when the budget runs low;
//! - retries transient failures — connection/timeout errors, 5xx, 420, 429 —
//!   up to a small cap with exponential backoff + jitter, honouring
//!   `Retry-After` when present;
//! - returns every other response (2xx/3xx/4xx incl. 304/404) unchanged for the
//!   caller to interpret.
//!
//! Non-idempotent writes that must not risk a duplicate on a lost 5xx use
//! [`send_once`] instead — same budget tracking, no retry.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

use reqwest::header::{HeaderMap, RETRY_AFTER};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

/// Pause new requests once the remaining budget dips below this.
const LOW_BUDGET: i64 = 10;
/// Total attempts (1 try + up to 3 retries).
const MAX_ATTEMPTS: u32 = 4;

/// Process-global view of ESI's error budget.
pub struct ErrorBudget {
    /// Last-seen remaining count; `-1` = unknown (no response observed yet).
    remain: AtomicI64,
    /// Epoch (secs) at which the current error window resets.
    reset_at: AtomicU64,
}

impl ErrorBudget {
    const fn new() -> Self {
        Self {
            remain: AtomicI64::new(-1),
            reset_at: AtomicU64::new(0),
        }
    }

    /// The shared, process-wide budget.
    pub fn global() -> &'static ErrorBudget {
        static BUDGET: ErrorBudget = ErrorBudget::new();
        &BUDGET
    }

    /// Update from a response's error-limit headers.
    pub fn observe(&self, headers: &HeaderMap) {
        if let Some(remain) = header_i64(headers, "x-esi-error-limit-remain") {
            self.remain.store(remain, Ordering::Relaxed);
        }
        if let Some(reset) = header_i64(headers, "x-esi-error-limit-reset") {
            // `reset` is seconds until the window resets.
            self.reset_at.store(
                crate::util::time::now_secs() + reset.max(0) as u64,
                Ordering::Relaxed,
            );
        }
    }

    /// How long to pause before the next request, given the current budget.
    /// Pure (no clock read) so it can be unit-tested.
    fn wait_needed(&self, now: u64) -> Option<Duration> {
        let remain = self.remain.load(Ordering::Relaxed);
        let reset_at = self.reset_at.load(Ordering::Relaxed);
        if (0..LOW_BUDGET).contains(&remain) && reset_at > now {
            // +1s cushion so we resume just after the window flips.
            Some(Duration::from_secs(reset_at - now + 1))
        } else {
            None
        }
    }

    async fn throttle(&self) {
        if let Some(d) = self.wait_needed(crate::util::time::now_secs()) {
            tokio::time::sleep(d).await;
        }
    }
}

/// Whether an HTTP status warrants a retry (transient/limited).
fn should_retry_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS  // 429
        || status.as_u16() == 420            // ESI "error limited"
        || status.is_server_error() // 5xx (incl. 503/504)
}

/// Base backoff (no jitter) for the Nth attempt (1-based): 0.5s, 1s, 2s, …
fn backoff_base(attempt: u32) -> Duration {
    Duration::from_millis(500u64 << attempt.saturating_sub(1).min(5))
}

fn backoff(attempt: u32) -> Duration {
    use rand::Rng;
    let jitter = rand::thread_rng().gen_range(0..250);
    backoff_base(attempt) + Duration::from_millis(jitter)
}

fn header_i64(headers: &HeaderMap, name: &str) -> Option<i64> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse().ok())
}

/// `Retry-After` as a delay (delta-seconds form only; HTTP-date form ignored).
fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let secs: u64 = headers
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse().ok())?;
    Some(Duration::from_secs(secs))
}

/// Send a request with error-budget throttling + transient retry. `build`
/// produces a fresh request each attempt — not just GETs: since `build` is
/// called anew per attempt, it can rebuild a JSON body just as cheaply as a
/// bare GET, so POSTs retry safely too as long as the write is idempotent.
/// Non-idempotent writes (e.g. creating a fitting) that must not risk a
/// duplicate after a 5xx should use [`send_once`] instead.
pub async fn send_retrying<F>(build: F) -> Result<Response, reqwest::Error>
where
    F: Fn() -> RequestBuilder,
{
    let budget = ErrorBudget::global();
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        budget.throttle().await;
        match build().send().await {
            Ok(resp) => {
                budget.observe(resp.headers());
                if attempt < MAX_ATTEMPTS && should_retry_status(resp.status()) {
                    let wait = retry_after(resp.headers()).unwrap_or_else(|| backoff(attempt));
                    tokio::time::sleep(wait).await;
                    continue;
                }
                return Ok(resp);
            }
            Err(e) => {
                // Retry connection/timeout/request-build hiccups; surface the
                // rest (decode, etc.) to the caller.
                if attempt < MAX_ATTEMPTS && (e.is_timeout() || e.is_connect() || e.is_request()) {
                    tokio::time::sleep(backoff(attempt)).await;
                    continue;
                }
                return Err(e);
            }
        }
    }
}

/// Send a request **exactly once** — no status-based or transient retry — but
/// still throttles on and observes the error-budget headers, same as
/// [`send_retrying`]. For non-idempotent writes where a lost response after a
/// 5xx can't be told apart from a lost request: the write may already have
/// committed server-side, so blindly retrying risks doing it twice. Callers
/// get the raw result back and decide themselves whether it's safe to retry.
pub async fn send_once<F>(build: F) -> Result<Response, reqwest::Error>
where
    F: FnOnce() -> RequestBuilder,
{
    let budget = ErrorBudget::global();
    budget.throttle().await;
    let resp = build().send().await?;
    budget.observe(resp.headers());
    Ok(resp)
}

/// POST `body` as JSON to `url` and decode the JSON response, through
/// [`send_retrying`] (error-budget aware; retries transient failures).
/// Mirrors the inline `send_retrying` → `error_for_status` → `json` pattern
/// the public POST resolvers in `esi::character` (`resolve_names`,
/// `resolve_character_ids`) use directly. Swallows any failure — network,
/// non-2xx status, or decode — as `None`; callers that need to tell those
/// apart should call [`send_retrying`] directly.
pub async fn post_json<T: DeserializeOwned, B: Serialize + ?Sized>(
    client: &Client,
    url: &str,
    body: &B,
) -> Option<T> {
    send_retrying(|| client.post(url).json(body))
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<T>()
        .await
        .ok()
}

/// GET and decode a JSON response for an **immutable** resource (e.g. a
/// killmail) that never changes once created, so no conditional-cache
/// revalidation is needed — just error-budget observation + transient retry
/// via [`send_retrying`]. Swallows any failure as `None`.
pub async fn get_immutable_json<T: DeserializeOwned>(client: &Client, url: &str) -> Option<T> {
    send_retrying(|| client.get(url))
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<T>()
        .await
        .ok()
}

/// Fetch and decode JSON from an arbitrary URL, swallowing any failure —
/// network, non-2xx status, or decode — as `None`. A plain one-shot GET with
/// **no** error-budget throttling or retry: for best-effort external lookups
/// (e.g. zKillboard) that don't share ESI's error budget. ESI calls should go
/// through [`get_immutable_json`]/[`post_json`] instead.
pub async fn fetch_json_url<T: DeserializeOwned>(client: &Client, url: &str) -> Option<T> {
    client.get(url).send().await.ok()?.json().await.ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_only_transient_statuses() {
        assert!(should_retry_status(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(should_retry_status(StatusCode::GATEWAY_TIMEOUT));
        assert!(should_retry_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(should_retry_status(StatusCode::from_u16(420).unwrap()));
        assert!(!should_retry_status(StatusCode::OK));
        assert!(!should_retry_status(StatusCode::NOT_MODIFIED));
        assert!(!should_retry_status(StatusCode::FORBIDDEN));
        assert!(!should_retry_status(StatusCode::NOT_FOUND));
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff_base(1), Duration::from_millis(500));
        assert_eq!(backoff_base(2), Duration::from_millis(1000));
        assert_eq!(backoff_base(3), Duration::from_millis(2000));
        // Saturates rather than overflowing on absurd attempt counts.
        assert_eq!(backoff_base(100), Duration::from_millis(500 << 5));
    }

    #[test]
    fn pauses_only_when_budget_low_and_window_open() {
        let b = ErrorBudget::new();
        // Unknown budget → never pause.
        assert_eq!(b.wait_needed(1000), None);

        b.remain.store(3, Ordering::Relaxed);
        b.reset_at.store(1010, Ordering::Relaxed);
        // Low + window still open → pause until reset (+1s cushion).
        assert_eq!(b.wait_needed(1000), Some(Duration::from_secs(11)));
        // Window already passed → no pause.
        assert_eq!(b.wait_needed(1020), None);

        // Healthy budget → no pause even with an open window.
        b.remain.store(50, Ordering::Relaxed);
        assert_eq!(b.wait_needed(1000), None);
    }

    #[test]
    fn observe_reads_headers() {
        let mut h = HeaderMap::new();
        h.insert("x-esi-error-limit-remain", "7".parse().unwrap());
        h.insert("x-esi-error-limit-reset", "30".parse().unwrap());
        let b = ErrorBudget::new();
        b.observe(&h);
        assert_eq!(b.remain.load(Ordering::Relaxed), 7);
        assert!(b.reset_at.load(Ordering::Relaxed) >= crate::util::time::now_secs());
        // Low budget recorded → it would pause within the window.
        assert!(b.wait_needed(crate::util::time::now_secs()).is_some());
    }

    #[test]
    fn retry_after_seconds_parsed() {
        let mut h = HeaderMap::new();
        h.insert(RETRY_AFTER, "5".parse().unwrap());
        assert_eq!(retry_after(&h), Some(Duration::from_secs(5)));
        assert_eq!(retry_after(&HeaderMap::new()), None);
    }

    #[test]
    fn post_json_decodes_a_successful_response() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let server = tiny_http::Server::http("127.0.0.1:0").expect("bind loopback");
            let addr = server.server_addr().to_ip().expect("ip addr");
            let server_thread = std::thread::spawn(move || {
                if let Ok(request) = server.recv() {
                    let _ = request.respond(tiny_http::Response::from_string(r#"{"n":7}"#));
                }
            });

            #[derive(serde::Deserialize)]
            struct Row {
                n: i64,
            }
            let client = reqwest::Client::new();
            let url = format!("http://{addr}/");
            let got: Option<Row> = post_json(&client, &url, &[1, 2, 3]).await;
            assert_eq!(got.map(|r| r.n), Some(7));

            server_thread.join().expect("server thread");
        });
    }

    #[test]
    fn get_immutable_json_is_none_on_error_status() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let server = tiny_http::Server::http("127.0.0.1:0").expect("bind loopback");
            let addr = server.server_addr().to_ip().expect("ip addr");
            let server_thread = std::thread::spawn(move || {
                if let Ok(request) = server.recv() {
                    let _ = request.respond(
                        tiny_http::Response::from_string("not found").with_status_code(404),
                    );
                }
            });

            let client = reqwest::Client::new();
            let url = format!("http://{addr}/");
            let got: Option<serde_json::Value> = get_immutable_json(&client, &url).await;
            assert!(got.is_none());

            server_thread.join().expect("server thread");
        });
    }

    #[test]
    fn fetch_json_url_decodes_a_successful_response() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let server = tiny_http::Server::http("127.0.0.1:0").expect("bind loopback");
            let addr = server.server_addr().to_ip().expect("ip addr");
            let server_thread = std::thread::spawn(move || {
                if let Ok(request) = server.recv() {
                    let _ = request.respond(tiny_http::Response::from_string("[1,2,3]"));
                }
            });

            let client = reqwest::Client::new();
            let url = format!("http://{addr}/");
            let got: Option<Vec<i64>> = fetch_json_url(&client, &url).await;
            assert_eq!(got, Some(vec![1, 2, 3]));

            server_thread.join().expect("server thread");
        });
    }

    #[test]
    fn fetch_json_url_is_none_when_the_body_does_not_decode() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        rt.block_on(async {
            let server = tiny_http::Server::http("127.0.0.1:0").expect("bind loopback");
            let addr = server.server_addr().to_ip().expect("ip addr");
            let server_thread = std::thread::spawn(move || {
                if let Ok(request) = server.recv() {
                    let _ = request.respond(tiny_http::Response::from_string("not json"));
                }
            });

            let client = reqwest::Client::new();
            let url = format!("http://{addr}/");
            let got: Option<Vec<i64>> = fetch_json_url(&client, &url).await;
            assert!(got.is_none());

            server_thread.join().expect("server thread");
        });
    }
}
