//! Download + decompress + verify the Fuzzwork SQLite SDE.

use std::path::Path;

use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use super::{SdeError, SdePaths, SDE_URL};

/// Progress update emitted while (re)building the SDE. `phase` is one of
/// `downloading` | `decompressing` | `verifying` | `done`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdeProgress {
    pub phase: String,
    pub downloaded: u64,
    pub total: Option<u64>,
}

impl SdeProgress {
    fn new(phase: &str, downloaded: u64, total: Option<u64>) -> Self {
        Self {
            phase: phase.to_string(),
            downloaded,
            total,
        }
    }
}

/// Fetch the SDE, decompress and verify it, then atomically replace any
/// existing database. `progress` is called as the work advances.
pub async fn download_sde<F>(paths: &SdePaths, progress: F) -> Result<(), SdeError>
where
    F: Fn(SdeProgress),
{
    tokio::fs::create_dir_all(&paths.dir).await?;

    // 1. Stream the bz2 to a temp file so we never hold the whole archive in RAM.
    let resp = reqwest::Client::new()
        .get(SDE_URL)
        .send()
        .await?
        .error_for_status()?;
    let total = resp.content_length();
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(&paths.tmp_bz2).await?;
    let mut downloaded = 0u64;
    progress(SdeProgress::new("downloading", 0, total));
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        progress(SdeProgress::new("downloading", downloaded, total));
    }
    file.flush().await?;
    drop(file);

    // 2. Decompress (CPU-bound) on a blocking thread.
    progress(SdeProgress::new("decompressing", downloaded, total));
    let bz2 = paths.tmp_bz2.clone();
    let tmp_db = paths.tmp_db.clone();
    tokio::task::spawn_blocking(move || decompress(&bz2, &tmp_db))
        .await
        .map_err(|e| SdeError::Decompress(e.to_string()))??;

    // 3. Sanity-check the decompressed database before trusting it.
    progress(SdeProgress::new("verifying", downloaded, total));
    let tmp_db = paths.tmp_db.clone();
    tokio::task::spawn_blocking(move || verify(&tmp_db))
        .await
        .map_err(|e| SdeError::Decompress(e.to_string()))??;

    // 4. Swap into place and clean up.
    tokio::fs::rename(&paths.tmp_db, &paths.db).await?;
    let _ = tokio::fs::remove_file(&paths.tmp_bz2).await;
    progress(SdeProgress::new("done", downloaded, total));
    Ok(())
}

fn decompress(bz2: &Path, out: &Path) -> Result<(), SdeError> {
    use std::io::BufReader;
    let input = std::fs::File::open(bz2)?;
    let mut decoder = bzip2::read::BzDecoder::new(BufReader::new(input));
    let mut output = std::fs::File::create(out)?;
    std::io::copy(&mut decoder, &mut output)?;
    Ok(())
}

/// Confirm the decompressed file is a SQLite DB with the tables we rely on.
fn verify(db: &Path) -> Result<(), SdeError> {
    use rusqlite::{Connection, OpenFlags};
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    for table in [
        "invTypes",
        "industryActivityProducts",
        "industryActivityMaterials",
    ] {
        let exists: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [table],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(SdeError::Corrupt(format!("missing table {table}")));
        }
    }
    Ok(())
}
