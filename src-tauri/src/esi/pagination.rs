//! Shared page-walking for ESI's `X-Pages`-paginated endpoints.
//!
//! Used by [`super::cache::ConditionalCache::get_paged`] (conditional GET of
//! page 1, then a fully uncached walk of the rest) and by any other caller
//! that needs to concatenate every page of a paginated collection.

use reqwest::{RequestBuilder, Response};
use serde_json::Value;

use super::error::EsiError;
use super::net::send_retrying;

/// Total pages from the `X-Pages` header (1 if absent/garbled).
pub(super) fn x_pages(headers: &reqwest::header::HeaderMap) -> u32 {
    headers
        .get("x-pages")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(1)
}

/// Concatenate the JSON array from an already-received page-1 response with
/// every subsequent page (per `X-Pages`), fetched via `build_page`. Shared by
/// [`super::cache::ConditionalCache::get_paged`] (which handles page 1 itself,
/// for conditional-GET revalidation) and [`walk_pages`] (uncached).
pub(super) async fn collect_remaining_pages<F: Fn(u32) -> RequestBuilder>(
    page1: Response,
    build_page: &F,
) -> Result<Vec<Value>, EsiError> {
    let pages = x_pages(page1.headers());
    let mut all: Vec<Value> = page1.json().await?;
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

/// Walk every page (no caching), concatenating the JSON arrays.
pub(super) async fn walk_pages<F: Fn(u32) -> RequestBuilder>(
    build_page: &F,
) -> Result<Vec<Value>, EsiError> {
    let resp = send_retrying(|| build_page(1)).await?.error_for_status()?;
    collect_remaining_pages(resp, build_page).await
}
