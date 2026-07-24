//! Public ESI HTTP client.
//!
//! Covers the unauthenticated endpoints the market service needs. Requests go
//! through a [`ConditionalCache`] (ETag + `Expires`/`max-age`), so repeated
//! reads serve from cache or revalidate with a cheap 304 rather than
//! re-downloading. Build with [`EsiClient::with_cache`] to persist across
//! restarts; [`EsiClient::new`] is a non-persisting pass-through.

use std::path::PathBuf;
use std::sync::Arc;

use serde::de::DeserializeOwned;

use super::cache::{cache_key, ConditionalCache};
use super::error::EsiError;
use super::ESI_BASE;

#[derive(Clone)]
pub struct EsiClient {
    http: reqwest::Client,
    base: String,
    cache: Arc<ConditionalCache>,
}

impl Default for EsiClient {
    fn default() -> Self {
        Self::new()
    }
}

impl EsiClient {
    /// A client with no persistent cache (transparent pass-through).
    pub fn new() -> Self {
        Self::build(ConditionalCache::disabled())
    }

    /// A client whose conditional cache persists under `<dir>/esi-cache/`.
    pub fn with_cache(dir: PathBuf) -> Self {
        Self::build(ConditionalCache::on_disk(dir))
    }

    /// Test-only seam: a client pointed at an arbitrary `base` (e.g. a
    /// loopback test server) instead of the real [`ESI_BASE`], with an
    /// explicit conditional-cache policy so tests can isolate the layer
    /// they're exercising.
    #[cfg(test)]
    pub(crate) fn with_base(base: impl Into<String>, cache: ConditionalCache) -> Self {
        let mut client = Self::build(cache);
        client.base = base.into();
        client
    }

    fn build(cache: ConditionalCache) -> Self {
        let http = super::http_client_builder()
            .build()
            .expect("failed to build HTTP client");
        Self {
            http,
            base: ESI_BASE.to_string(),
            cache: Arc::new(cache),
        }
    }

    /// GET a single JSON document (conditionally cached).
    pub async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, EsiError> {
        let url = format!("{}{}", self.base, path);
        let key = cache_key(&url, query);
        self.cache
            .get_json(&key, || self.http.get(&url).query(query))
            .await
    }

    /// GET a paginated collection, following the `X-Pages` header and
    /// concatenating every page (conditionally cached on page 1).
    pub async fn get_paged<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Vec<T>, EsiError> {
        let url = format!("{}{}", self.base, path);
        let key = cache_key(&url, query);
        self.cache
            .get_paged(&key, |page| {
                let mut q = query.to_vec();
                q.push(("page", page.to_string()));
                self.http.get(&url).query(&q)
            })
            .await
    }
}
