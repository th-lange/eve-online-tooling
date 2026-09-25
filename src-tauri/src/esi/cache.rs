//! ESI-specific conditional HTTP cache: wraps the provider-agnostic
//! [`crate::net::conditional_cache::ConditionalCache`] (#886) with ESI's
//! error-budget-aware [`send_retrying`], and adds paginated-collection
//! support (`get_paged`) — ESI is the only provider fetched through here that
//! pages, so that part stays ESI-specific rather than moving to `net`.
//!
//! See `net::conditional_cache` for the revalidation contract (ETag +
//! `Cache-Control`/`Expires` freshness, on-disk persistence, stale-entry
//! retention).

use std::path::{Path, PathBuf};

use reqwest::header::IF_NONE_MATCH;
use reqwest::{RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::net::conditional_cache::{
    self, CachedResponse, ConditionalCache as CoreCache, ConditionalCacheError,
};

use super::error::EsiError;
use super::net::send_retrying;
use super::pagination::{collect_remaining_pages, walk_pages};

pub use conditional_cache::cache_key;

impl From<ConditionalCacheError> for EsiError {
    fn from(err: ConditionalCacheError) -> Self {
        match err {
            ConditionalCacheError::Http(e) => EsiError::Http(e),
            ConditionalCacheError::Json(e) => EsiError::Json(e),
        }
    }
}

/// A conditional HTTP cache for ESI. Cheap to clone-share behind an `Arc`.
pub struct ConditionalCache(CoreCache);

impl ConditionalCache {
    /// A transparent pass-through (no persistence, always hits the network).
    pub fn disabled() -> Self {
        Self(CoreCache::disabled())
    }

    /// A cache persisting under `<dir>/esi-cache/`.
    pub fn on_disk(dir: PathBuf) -> Self {
        Self(CoreCache::on_disk(dir))
    }

    /// The cached freshness deadline (Unix epoch secs) for `key`, if an
    /// entry exists. Proxies [`CoreCache::expires_at`] so ESI-specific
    /// callers (e.g. [`super::client::EsiClient`]) can surface the same
    /// deadline downstream (#885).
    pub(crate) async fn expires_at(&self, key: &str) -> Option<u64> {
        self.0.expires_at(key).await
    }

    /// Startup maintenance: delete on-disk cache files whose TTL has been
    /// expired for longer than the retention window. Synchronous — this runs
    /// once, early, in the Tauri `setup` closure before the async runtime is
    /// spun up for anything cache-related.
    pub fn prune_disk_startup(dir: &Path) {
        CoreCache::prune_disk_startup(dir);
    }

    /// Conditional GET of a single JSON document, sent via [`send_retrying`]
    /// (error-budget aware, transient-retry).
    ///
    /// `build` produces the request (URL + query + any auth) and is called once
    /// per network attempt; the cache adds `If-None-Match` itself.
    pub async fn get_json<T, F>(&self, key: &str, build: F) -> Result<T, EsiError>
    where
        T: DeserializeOwned,
        F: Fn() -> RequestBuilder,
    {
        Ok(self
            .0
            .get_json(key, &build, |rb: RequestBuilder| {
                send_retrying(move || rb.try_clone().expect("ESI requests never stream a body"))
            })
            .await?)
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
        if self.0.is_disabled() {
            let all = walk_pages(&build_page).await?;
            return Ok(serde_json::from_value(Value::Array(all))?);
        }

        let entry = self.0.load(key).await;
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
                self.0
                    .touch(key, conditional_cache::ttl_from(resp.headers()))
                    .await;
                return Ok(serde_json::from_str(&e.body)?);
            }
        }
        let resp = resp.error_for_status()?;
        let etag = conditional_cache::etag_of(resp.headers());
        let ttl = conditional_cache::ttl_from(resp.headers());
        let all = collect_remaining_pages(resp, &build_page).await?;
        let all = Value::Array(all);
        let body = serde_json::to_string(&all)?;
        let value: Vec<T> = serde_json::from_value(all)?;
        self.0
            .store(
                key,
                CachedResponse {
                    etag,
                    expires: crate::util::time::now_secs() + ttl,
                    body,
                },
            )
            .await;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ESI's `get_json` wrapper maps a decode failure through `EsiError` and
    /// never persists the bad response — exercised end-to-end (including
    /// `send_retrying`) since the pure revalidation logic itself is covered by
    /// `net::conditional_cache`'s own tests.
    #[test]
    fn failed_deserialize_does_not_populate_cache() {
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

            let dir =
                std::env::temp_dir().join(format!("eve-esi-cache-bad-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let cache = ConditionalCache::on_disk(dir.clone());
            let client = reqwest::Client::new();
            let url = format!("http://{}/", addr);

            let result: Result<Value, EsiError> =
                cache.get_json("bad-key", || client.get(&url)).await;
            assert!(result.is_err());
            assert!(cache.0.load("bad-key").await.is_none());

            server_thread.join().expect("server thread");
            let _ = std::fs::remove_dir_all(&dir);
        });
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
