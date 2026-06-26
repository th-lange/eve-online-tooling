use thiserror::Error;

/// Errors from ESI HTTP calls.
#[derive(Debug, Error)]
pub enum EsiError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("decode error: {0}")]
    Json(#[from] serde_json::Error),
}
