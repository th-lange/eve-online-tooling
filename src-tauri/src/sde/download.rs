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

    // 1. Stream the gzip to a temp file so we never hold the whole archive in RAM.
    // A User-Agent is required — Fuzzwork returns 403 for requests without one.
    // No *total* timeout here — that would abort the large archive on slow
    // links; instead fail when connecting or when the stream stalls between
    // chunks.
    let client = reqwest::Client::builder()
        .user_agent(crate::esi::USER_AGENT)
        .connect_timeout(crate::esi::HTTP_CONNECT_TIMEOUT)
        .read_timeout(crate::esi::HTTP_REQUEST_TIMEOUT)
        .build()?;
    let resp = client.get(SDE_URL).send().await?.error_for_status()?;
    let total = resp.content_length();
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(&paths.tmp_archive).await?;
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
    let archive = paths.tmp_archive.clone();
    let tmp_db = paths.tmp_db.clone();
    tokio::task::spawn_blocking(move || decompress(&archive, &tmp_db))
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
    let _ = tokio::fs::remove_file(&paths.tmp_archive).await;
    progress(SdeProgress::new("done", downloaded, total));
    Ok(())
}

fn decompress(archive: &Path, out: &Path) -> Result<(), SdeError> {
    use std::io::BufReader;
    let input = std::fs::File::open(archive)?;
    let mut decoder = flate2::read::GzDecoder::new(BufReader::new(input));
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
        // Dogma tables the fitting engine relies on (#157). `dgmExpressions` is
        // intentionally absent: the Fuzzwork dump ships it empty, so modifiers
        // are driven off `dgmEffects.modifierInfo` instead.
        "dgmTypeAttributes",
        "dgmAttributeTypes",
        "dgmTypeEffects",
        "dgmEffects",
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    /// Per-process scratch dir, following the repo convention of using the
    /// real filesystem (not the `tempfile` crate) for on-disk fixtures.
    fn test_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("eve-sde-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn decompress_round_trips_gzip_payload() {
        let dir = test_dir();
        let archive = dir.join("roundtrip.gz");
        let out = dir.join("roundtrip.out");

        let payload = b"hello eve sde";
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(payload).unwrap();
        let compressed = encoder.finish().unwrap();
        std::fs::write(&archive, &compressed).unwrap();

        decompress(&archive, &out).unwrap();
        let result = std::fs::read(&out).unwrap();
        assert_eq!(result, payload);

        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn decompress_rejects_garbage_without_panicking() {
        let dir = test_dir();
        // Simulates a saved HTML error page mistakenly downloaded in place
        // of the real gzip archive.
        let archive = dir.join("garbage.gz");
        let out = dir.join("garbage.out");
        std::fs::write(&archive, b"<html>404</html>").unwrap();

        let result = decompress(&archive, &out);
        assert!(result.is_err());

        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn verify_rejects_non_sqlite_file() {
        let dir = test_dir();
        let db = dir.join("not-a-db.sqlite");
        std::fs::write(&db, b"not a database").unwrap();

        assert!(verify(&db).is_err());

        let _ = std::fs::remove_file(&db);
    }

    /// All required tables except `dgmEffects`, so `verify` should fail and
    /// name the specific table it couldn't find.
    fn create_db_missing_dgm_effects(db: &Path) {
        let _ = std::fs::remove_file(db);
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT);
             CREATE TABLE industryActivityProducts(typeID INT);
             CREATE TABLE industryActivityMaterials(typeID INT);
             CREATE TABLE dgmTypeAttributes(typeID INT);
             CREATE TABLE dgmAttributeTypes(attributeID INT);
             CREATE TABLE dgmTypeEffects(typeID INT);",
        )
        .unwrap();
    }

    #[test]
    fn verify_names_missing_table() {
        let dir = test_dir();
        let db = dir.join("missing-table.sqlite");
        create_db_missing_dgm_effects(&db);

        match verify(&db) {
            Err(SdeError::Corrupt(msg)) => assert!(
                msg.contains("dgmEffects"),
                "expected the missing-table error to name dgmEffects, got: {msg}"
            ),
            other => panic!("expected Corrupt(_) naming dgmEffects, got {other:?}"),
        }

        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn verify_passes_with_all_required_tables() {
        let dir = test_dir();
        let db = dir.join("complete.sqlite");
        let _ = std::fs::remove_file(&db);
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT);
             CREATE TABLE industryActivityProducts(typeID INT);
             CREATE TABLE industryActivityMaterials(typeID INT);
             CREATE TABLE dgmTypeAttributes(typeID INT);
             CREATE TABLE dgmAttributeTypes(typeID INT);
             CREATE TABLE dgmTypeEffects(typeID INT);
             CREATE TABLE dgmEffects(effectID INT);",
        )
        .unwrap();
        drop(conn);

        assert!(verify(&db).is_ok());

        let _ = std::fs::remove_file(&db);
    }
}
