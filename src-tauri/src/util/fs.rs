//! Filesystem helpers for scanning EVE's log folders (gamelogs, chatlogs).
//!
//! Every module that follows EVE logs needs the same primitive: "the files in
//! this folder whose name matches X, by modification time". Before this
//! helper, dpsmeter, localintel, and shopping each hand-rolled the
//! `read_dir → filter(name) → metadata().modified() → max_by_key/sort` walk,
//! and the copies had already drifted (inconsistent error handling, no
//! `is_file()` check). Keep the walk here, in one place.

use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// List the files in `dir` whose name matches `name_matches`, paired with
/// their modification time (unsorted).
///
/// - The predicate receives the file name **ASCII-lowercased**, so callers
///   can match case-insensitively (EVE's log names mix case across OSes)
///   without each re-doing the lowercasing.
/// - Only regular files are returned — a stray directory named like a log
///   can't sneak in.
/// - Entries whose metadata or mtime can't be read are skipped, not errors;
///   only failing to open `dir` itself is an error.
pub fn list_files_by_mtime(
    dir: &Path,
    name_matches: impl Fn(&str) -> bool,
) -> io::Result<Vec<(PathBuf, SystemTime)>> {
    Ok(std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            name_matches(
                e.file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .as_str(),
            )
        })
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((e.path(), meta.modified().ok()?))
        })
        .collect())
}

/// The newest matching file in `dir` by modification time (the "active" log),
/// or `None` when nothing matches. Same matching rules as
/// [`list_files_by_mtime`].
pub fn newest_file_by_mtime(
    dir: &Path,
    name_matches: impl Fn(&str) -> bool,
) -> io::Result<Option<PathBuf>> {
    Ok(list_files_by_mtime(dir, name_matches)?
        .into_iter()
        .max_by_key(|(_, modified)| *modified)
        .map(|(path, _)| path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::Duration;

    /// A throwaway directory under the OS temp dir, removed on drop.
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("eve-tooling-utilfs-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create tmp dir");
            TmpDir(dir)
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Create `name` in `dir` with a mtime `secs_ago` seconds in the past.
    fn touch(dir: &Path, name: &str, secs_ago: u64) -> PathBuf {
        let path = dir.join(name);
        let file = File::create(&path).expect("create file");
        let mtime = SystemTime::now() - Duration::from_secs(secs_ago);
        file.set_modified(mtime).expect("set mtime");
        path
    }

    #[test]
    fn lists_matching_files_with_mtimes() {
        let tmp = TmpDir::new("list");
        touch(&tmp.0, "a.txt", 30);
        touch(&tmp.0, "b.txt", 10);
        touch(&tmp.0, "notes.log", 20); // filtered out by the predicate

        let mut names: Vec<String> = list_files_by_mtime(&tmp.0, |n| n.ends_with(".txt"))
            .expect("readable dir")
            .into_iter()
            .filter_map(|(p, _)| Some(p.file_name()?.to_string_lossy().into_owned()))
            .collect();
        names.sort();
        assert_eq!(names, ["a.txt", "b.txt"]);
    }

    #[test]
    fn predicate_sees_lowercased_names() {
        let tmp = TmpDir::new("lower");
        touch(&tmp.0, "Local_20260718.txt", 5);
        let newest = newest_file_by_mtime(&tmp.0, |n| n.starts_with("local_"))
            .expect("readable dir")
            .expect("one match");
        // The returned path keeps the on-disk casing.
        assert_eq!(newest.file_name().unwrap(), "Local_20260718.txt");
    }

    #[test]
    fn newest_picks_highest_mtime_and_skips_directories() {
        let tmp = TmpDir::new("newest");
        touch(&tmp.0, "old.txt", 300);
        let expected = touch(&tmp.0, "new.txt", 10);
        touch(&tmp.0, "middle.txt", 100);
        // A directory whose name matches must not be considered.
        std::fs::create_dir(tmp.0.join("dir.txt")).expect("create subdir");

        let newest = newest_file_by_mtime(&tmp.0, |n| n.ends_with(".txt"))
            .expect("readable dir")
            .expect("some file matches");
        assert_eq!(newest, expected);
    }

    #[test]
    fn no_match_is_none_and_missing_dir_is_err() {
        let tmp = TmpDir::new("empty");
        assert_eq!(
            newest_file_by_mtime(&tmp.0, |n| n.ends_with(".txt")).expect("readable dir"),
            None
        );
        assert!(newest_file_by_mtime(&tmp.0.join("does-not-exist"), |_| true).is_err());
    }
}
