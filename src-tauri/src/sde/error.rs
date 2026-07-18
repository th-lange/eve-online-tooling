use thiserror::Error;

/// Errors from the SDE service: download, decompression, on-disk state, and
/// SQLite queries.
#[derive(Debug, Error)]
pub enum SdeError {
    #[error("SDE database is not installed")]
    NotInstalled,
    #[error("SDE database is corrupt: {0}")]
    Corrupt(String),
    #[error("decompression failed: {0}")]
    Decompress(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}
