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

/// Minimum percentage-of-total progress between emitted updates.
const PROGRESS_MIN_DELTA_PCT: f64 = 0.5;
/// Minimum wall-clock time between emitted updates, so a slow link (tiny
/// chunks trickling in) still shows *some* movement even below the delta
/// threshold.
const PROGRESS_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Pure throttle decision, factored out of [`ProgressThrottle`] so it's
/// testable without real sleeps or a network stream: given how much progress
/// and time have passed since the last emitted update, should this one fire?
fn should_emit_progress(
    downloaded: u64,
    last_emitted_downloaded: u64,
    total: Option<u64>,
    elapsed_since_last_emit: std::time::Duration,
) -> bool {
    if elapsed_since_last_emit >= PROGRESS_MIN_INTERVAL {
        return true;
    }
    match total {
        Some(total) if total > 0 => {
            let delta = downloaded.saturating_sub(last_emitted_downloaded);
            (delta as f64 / total as f64) * 100.0 >= PROGRESS_MIN_DELTA_PCT
        }
        // No known total: percentage gating is meaningless, so only the
        // time-based path (above) can fire.
        _ => false,
    }
}

/// Coalesces per-chunk progress into at most one update per
/// [`PROGRESS_MIN_DELTA_PCT`] of total progress or [`PROGRESS_MIN_INTERVAL`]
/// of wall-clock time — a stream delivers ~16-64 KiB chunks, far too fine-
/// grained to forward one UI event each.
struct ProgressThrottle {
    last_emit_at: std::time::Instant,
    last_emitted_downloaded: u64,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            last_emit_at: std::time::Instant::now(),
            last_emitted_downloaded: 0,
        }
    }

    /// Records `downloaded` and returns whether it clears the throttle.
    fn tick(&mut self, downloaded: u64, total: Option<u64>) -> bool {
        let now = std::time::Instant::now();
        let fire = should_emit_progress(
            downloaded,
            self.last_emitted_downloaded,
            total,
            now.duration_since(self.last_emit_at),
        );
        if fire {
            self.last_emit_at = now;
            self.last_emitted_downloaded = downloaded;
        }
        fire
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
    let mut throttle = ProgressThrottle::new();
    progress(SdeProgress::new("downloading", 0, total));
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if throttle.tick(downloaded, total) {
            progress(SdeProgress::new("downloading", downloaded, total));
        }
    }
    // Always report the final byte count, even if the last chunk(s) were
    // coalesced away by the throttle.
    progress(SdeProgress::new("downloading", downloaded, total));
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
    use std::time::Duration;

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

    /// Simulates a stream of tiny (well below the 0.5% threshold) chunks
    /// covering a whole download and asserts the throttle coalesces them
    /// into far fewer than one emission per chunk.
    #[test]
    fn progress_throttle_bounds_emission_count_for_many_small_chunks() {
        let total = Some(1_000_000u64);
        let chunk_size = 1_000u64; // 0.1% of total per chunk.
        let chunk_count = 1_000; // Covers exactly 100% of `total`.

        let mut last_emitted = 0u64;
        let mut downloaded = 0u64;
        let mut emitted = 0usize;
        for _ in 0..chunk_count {
            downloaded += chunk_size;
            // Zero elapsed time isolates the percentage-delta gate so the
            // count is deterministic regardless of how fast this loop runs.
            if should_emit_progress(downloaded, last_emitted, total, Duration::ZERO) {
                last_emitted = downloaded;
                emitted += 1;
            }
        }

        assert!(
            emitted < chunk_count,
            "throttle should coalesce most per-chunk updates, got {emitted} for {chunk_count} chunks"
        );
        // 0.1%/chunk crossing a 0.5% gate fires roughly every 5th chunk.
        assert!(
            (150..=250).contains(&emitted),
            "expected roughly one emission per 0.5% of progress, got {emitted}"
        );
    }

    /// Even when progress hasn't crossed the percentage threshold, enough
    /// elapsed wall-clock time must still let an update through.
    #[test]
    fn progress_throttle_time_based_path_fires_independent_of_delta() {
        assert!(should_emit_progress(
            1,
            0,
            Some(1_000_000),
            Duration::from_millis(300)
        ));
        assert!(!should_emit_progress(
            1,
            0,
            Some(1_000_000),
            Duration::from_millis(100)
        ));
    }
}
