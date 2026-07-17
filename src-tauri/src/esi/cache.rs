//! Disk-backed conditional HTTP cache implementing ESI's caching contract.
//!
//! ESI asks clients to respect cache timers and to revalidate with **ETags**
//! rather than blindly re-downloading. This cache does both:
//!
//! 1. While an entry is still fresh (now < its `Expires`/`max-age` deadline) it is
//!    served straight from cache — **no network call at all**.
//! 2. Once stale, the next request is sent with `If-None-Match: <etag>`. ESI
//!    answers **304 Not Modified** (tiny, body-less) when nothing changed, and we
//!    just push the freshness deadline forward and reuse the stored body.
//! 3. On a **200** we store the new body, ETag, and a deadline derived from the
//!    response's `Cache-Control: max-age` (preferred) or `Expires` − `Date`.
//!
//! Entries live on disk (`<app_data_dir>/esi-cache/<key>.json`) so the cache
//! survives restarts, with an in-memory layer in front to avoid re-reading disk
//! within a session. A cache with no directory (`disabled`) is a transparent
//! pass-through — every call hits the network — used where no data dir is wired.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use reqwest::header::{CACHE_CONTROL, DATE, ETAG, EXPIRES, IF_NONE_MATCH};
use reqwest::{RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::EsiError;
use super::net::send_retrying;

/// Fallback freshness window when a response carries no cache headers. Kept
/// short: with an ETag, revalidation is cheap (a 304), so erring small is safe.
const DEFAULT_TTL: u64 = 60;

#[derive(Clone, Serialize, Deserialize)]
struct CachedResponse {
    /// The response's `ETag`, replayed as `If-None-Match` on revalidation.
    etag: Option<String>,
    /// Unix epoch (secs) after which a revalidation is due.
    expires: u64,
    /// Response body as UTF-8 JSON text. For paged collections this is the
    /// concatenated array of every page.
    body: String,
}

/// A conditional HTTP cache. Cheap to clone-share behind an `Arc`.
pub struct ConditionalCache {
    /// `None` disables persistence/caching (transparent pass-through).
    dir: Option<PathBuf>,
    mem: Mutex<HashMap<String, CachedResponse>>,
}

fn sanitize(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Total pages from the `X-Pages` header (1 if absent/garbled).
fn x_pages(headers: &reqwest::header::HeaderMap) -> u32 {
    headers
        .get("x-pages")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(1)
}

/// Freshness TTL (secs) from cache headers: `Cache-Control: max-age` wins, else
/// `Expires` − `Date`. Pure over the header strings so it can be unit-tested.
fn compute_ttl(
    cache_control: Option<&str>,
    expires: Option<&str>,
    date: Option<&str>,
) -> Option<u64> {
    if let Some(cc) = cache_control {
        for part in cc.split(',') {
            if let Some(n) = part.trim().strip_prefix("max-age=") {
                if let Ok(secs) = n.parse::<u64>() {
                    return Some(secs);
                }
            }
        }
    }
    let expires = httpdate::parse_http_date(expires?).ok()?;
    let base = date
        .and_then(|d| httpdate::parse_http_date(d).ok())
        .unwrap_or_else(SystemTime::now);
    expires.duration_since(base).ok().map(|d| d.as_secs())
}

fn ttl_from(headers: &reqwest::header::HeaderMap) -> u64 {
    compute_ttl(
        headers.get(CACHE_CONTROL).and_then(|v| v.to_str().ok()),
        headers.get(EXPIRES).and_then(|v| v.to_str().ok()),
        headers.get(DATE).and_then(|v| v.to_str().ok()),
    )
    .unwrap_or(DEFAULT_TTL)
}

fn etag_of(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

impl ConditionalCache {
    /// A transparent pass-through (no persistence, always hits the network).
    pub fn disabled() -> Self {
        Self {
            dir: None,
            mem: Mutex::new(HashMap::new()),
        }
    }

    /// A cache persisting under `<dir>/esi-cache/`.
    pub fn on_disk(dir: PathBuf) -> Self {
        Self {
            dir: Some(dir),
            mem: Mutex::new(HashMap::new()),
        }
    }

    fn path(&self, key: &str) -> Option<PathBuf> {
        self.dir
            .as_ref()
            .map(|d| d.join("esi-cache").join(format!("{}.json", sanitize(key))))
    }

    fn load(&self, key: &str) -> Option<CachedResponse> {
        if let Some(hit) = self.mem.lock().unwrap().get(key).cloned() {
            return Some(hit);
        }
        let bytes = std::fs::read(self.path(key)?).ok()?;
        let entry: CachedResponse = serde_json::from_slice(&bytes).ok()?;
        self.mem
            .lock()
            .unwrap()
            .insert(key.to_string(), entry.clone());
        Some(entry)
    }

    fn store(&self, key: &str, entry: CachedResponse) {
        if let Some(path) = self.path(key) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(bytes) = serde_json::to_vec(&entry) {
                let _ = std::fs::write(path, bytes);
            }
        }
        self.mem.lock().unwrap().insert(key.to_string(), entry);
    }

    /// Push a cached entry's freshness deadline forward after a 304, keeping the
    /// body. No-op if the entry has since vanished.
    fn touch(&self, key: &str, ttl: u64) {
        if let Some(mut e) = self.load(key) {
            e.expires = crate::util::time::now_secs() + ttl;
            self.store(key, e);
        }
    }

    /// Conditional GET of a single JSON document.
    ///
    /// `build` produces the request (URL + query + any auth) and is called once
    /// per network attempt; the cache adds `If-None-Match` itself.
    pub async fn get_json<T, F>(&self, key: &str, build: F) -> Result<T, EsiError>
    where
        T: DeserializeOwned,
        F: Fn() -> RequestBuilder,
    {
        if self.dir.is_none() {
            let bytes = send_retrying(build)
                .await?
                .error_for_status()?
                .bytes()
                .await?;
            return Ok(serde_json::from_slice(&bytes)?);
        }

        let entry = self.load(key);
        if let Some(e) = &entry {
            if e.expires > crate::util::time::now_secs() {
                return Ok(serde_json::from_str(&e.body)?);
            }
        }

        let tag = entry.as_ref().and_then(|e| e.etag.as_deref());
        let resp = send_retrying(|| match tag {
            Some(t) => build().header(IF_NONE_MATCH, t),
            None => build(),
        })
        .await?;
        if resp.status() == StatusCode::NOT_MODIFIED {
            if let Some(e) = &entry {
                self.touch(key, ttl_from(resp.headers()));
                return Ok(serde_json::from_str(&e.body)?);
            }
        }
        let resp = resp.error_for_status()?;
        let etag = etag_of(resp.headers());
        let ttl = ttl_from(resp.headers());
        let body = resp.text().await?;
        self.store(
            key,
            CachedResponse {
                etag,
                expires: crate::util::time::now_secs() + ttl,
                body: body.clone(),
            },
        );
        Ok(serde_json::from_str(&body)?)
    }

    /// Conditional GET of a paginated collection. ETag/Expires apply to page 1
    /// and gate the whole walk: a 304 on page 1 serves the cached concatenation;
    /// a 200 re-walks every page. `build_page(page)` produces the request for one
    /// page (the cache adds `If-None-Match` to page 1).
    pub async fn get_paged<T, F>(&self, key: &str, build_page: F) -> Result<Vec<T>, EsiError>
    where
        T: DeserializeOwned,
        F: Fn(u32) -> RequestBuilder,
    {
        if self.dir.is_none() {
            let all = walk_pages(&build_page).await?;
            return Ok(serde_json::from_value(Value::Array(all))?);
        }

        let entry = self.load(key);
        if let Some(e) = &entry {
            if e.expires > crate::util::time::now_secs() {
                return Ok(serde_json::from_str(&e.body)?);
            }
        }

        let tag = entry.as_ref().and_then(|e| e.etag.as_deref());
        let resp = send_retrying(|| match tag {
            Some(t) => build_page(1).header(IF_NONE_MATCH, t),
            None => build_page(1),
        })
        .await?;
        if resp.status() == StatusCode::NOT_MODIFIED {
            if let Some(e) = &entry {
                self.touch(key, ttl_from(resp.headers()));
                return Ok(serde_json::from_str(&e.body)?);
            }
        }
        let resp = resp.error_for_status()?;
        let etag = etag_of(resp.headers());
        let ttl = ttl_from(resp.headers());
        let pages = x_pages(resp.headers());
        let mut all: Vec<Value> = resp.json().await?;
        for page in 2..=pages {
            let more: Vec<Value> = send_retrying(|| build_page(page))
                .await?
                .error_for_status()?
                .json()
                .await?;
            all.extend(more);
        }
        let body = serde_json::to_string(&all)?;
        self.store(
            key,
            CachedResponse {
                etag,
                expires: crate::util::time::now_secs() + ttl,
                body: body.clone(),
            },
        );
        Ok(serde_json::from_str(&body)?)
    }
}

/// Walk every page (no caching), concatenating the JSON arrays.
async fn walk_pages<F: Fn(u32) -> RequestBuilder>(build_page: &F) -> Result<Vec<Value>, EsiError> {
    let resp = send_retrying(|| build_page(1)).await?.error_for_status()?;
    let pages = x_pages(resp.headers());
    let mut all: Vec<Value> = resp.json().await?;
    for page in 2..=pages {
        let more: Vec<Value> = send_retrying(|| build_page(page))
            .await?
            .error_for_status()?
            .json()
            .await?;
        all.extend(more);
    }
    Ok(all)
}

/// A stable cache key from a URL and its query pairs (page param excluded by
/// callers, which key on the unpaginated request).
pub fn cache_key(url: &str, query: &[(&str, String)]) -> String {
    if query.is_empty() {
        return url.to_string();
    }
    let q: Vec<String> = query.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!("{url}?{}", q.join("&"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_age_wins_over_expires() {
        let ttl = compute_ttl(
            Some("public, max-age=1200"),
            Some("Wed, 21 Oct 2026 07:28:00 GMT"),
            Some("Wed, 21 Oct 2026 07:00:00 GMT"),
        );
        assert_eq!(ttl, Some(1200));
    }

    #[test]
    fn expires_minus_date() {
        let ttl = compute_ttl(
            None,
            Some("Wed, 21 Oct 2026 07:30:00 GMT"),
            Some("Wed, 21 Oct 2026 07:00:00 GMT"),
        );
        assert_eq!(ttl, Some(1800));
    }

    #[test]
    fn no_headers_is_none() {
        assert_eq!(compute_ttl(None, None, None), None);
        // Garbled max-age falls through to expires (also absent) → None.
        assert_eq!(compute_ttl(Some("public"), None, None), None);
    }

    #[test]
    fn expires_in_the_past_is_zero_not_error() {
        let ttl = compute_ttl(
            None,
            Some("Wed, 21 Oct 2026 07:00:00 GMT"),
            Some("Wed, 21 Oct 2026 07:30:00 GMT"),
        );
        // expires < date → duration_since errors → None (treated as no signal).
        assert_eq!(ttl, None);
    }

    #[test]
    fn cache_round_trips_and_gates_on_expiry() {
        let dir = std::env::temp_dir().join(format!("eve-esi-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let cache = ConditionalCache::on_disk(dir.clone());

        assert!(cache.load("k").is_none());
        cache.store(
            "k",
            CachedResponse {
                etag: Some("\"abc\"".into()),
                expires: crate::util::time::now_secs() + 3600,
                body: "[1,2,3]".into(),
            },
        );
        let e = cache.load("k").expect("present");
        assert_eq!(e.body, "[1,2,3]");
        assert!(e.expires > crate::util::time::now_secs());

        // A fresh process (cold mem) still reads it from disk.
        let cold = ConditionalCache::on_disk(dir.clone());
        assert_eq!(cold.load("k").map(|e| e.body), Some("[1,2,3]".into()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_includes_query() {
        assert_eq!(cache_key("u", &[]), "u");
        assert_eq!(
            cache_key(
                "u",
                &[("type_id", "34".into()), ("order_type", "all".into())]
            ),
            "u?type_id=34&order_type=all"
        );
    }
}
