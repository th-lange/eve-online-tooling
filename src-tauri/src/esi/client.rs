//! Minimal public ESI HTTP client.
//!
//! Covers the unauthenticated endpoints the market service needs. Auth (SSO)
//! and the full error-limit backoff are layered on in issues #3/#4.

use serde::de::DeserializeOwned;

use super::error::EsiError;
use super::{ESI_BASE, USER_AGENT};

#[derive(Clone)]
pub struct EsiClient {
    http: reqwest::Client,
    base: String,
}

impl Default for EsiClient {
    fn default() -> Self {
        Self::new()
    }
}

impl EsiClient {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .expect("failed to build HTTP client");
        Self {
            http,
            base: ESI_BASE.to_string(),
        }
    }

    /// GET a single JSON document.
    pub async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, EsiError> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .http
            .get(&url)
            .query(query)
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.json::<T>().await?)
    }

    /// GET a paginated collection, following the `X-Pages` header and
    /// concatenating every page.
    pub async fn get_paged<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Vec<T>, EsiError> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .http
            .get(&url)
            .query(query)
            .send()
            .await?
            .error_for_status()?;
        let pages: u32 = resp
            .headers()
            .get("x-pages")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let mut out: Vec<T> = resp.json().await?;

        for page in 2..=pages {
            let mut q = query.to_vec();
            q.push(("page", page.to_string()));
            let resp = self
                .http
                .get(&url)
                .query(&q)
                .send()
                .await?
                .error_for_status()?;
            let mut more: Vec<T> = resp.json().await?;
            out.append(&mut more);
        }
        Ok(out)
    }
}
