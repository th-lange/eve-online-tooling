use thiserror::Error;

/// Errors from ESI HTTP calls.
#[derive(Debug, Error)]
pub enum EsiError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}
