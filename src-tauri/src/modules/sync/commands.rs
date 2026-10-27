//! Commands backing the frontend's folder sync (`src/lib/sync/`): read every
//! `*.json` file in a user-chosen folder in one round trip, and write one
//! back. All sync *decisions* (newer-wins, which modules sync) live in the
//! frontend — this is a thin, sandboxed file transport.

use std::fs;
use std::path::Path;

use serde::Serialize;

/// One sync file as read back from disk: its bare filename (e.g.
/// `reminders.json`) and raw JSON content, left unparsed — the frontend
/// parses/validates the envelope per module.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFile {
    pub name: String,
    pub content: String,
}

/// Every top-level `*.json` file directly inside `dir` (no recursion).
/// Errors if `dir` itself can't be read (missing, not a directory, no
/// permission) — the frontend only calls this once the user has picked a
/// folder, so a hard error here is meaningful, not "nothing synced yet".
#[tauri::command]
pub fn sync_folder_read(dir: String) -> Result<Vec<SyncFile>, String> {
    let entries = fs::read_dir(&dir).map_err(|e| format!("reading {dir}: {e}"))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") || !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        files.push(SyncFile {
            name: name.to_string(),
            content,
        });
    }
    Ok(files)
}

/// Write `content` to `dir/<basename of name>`, creating `dir` if it doesn't
/// exist yet (first-ever sync into a fresh folder). `name` is treated as
/// untrusted: only its final path component is used, so a caller-supplied
/// `../../evil` (or an absolute path) can never write outside `dir`.
#[tauri::command]
pub fn sync_folder_write(dir: String, name: String, content: String) -> Result<(), String> {
    fs::create_dir_all(&dir).map_err(|e| format!("creating {dir}: {e}"))?;
    let basename = sanitize_name(&name)?;
    fs::write(Path::new(&dir).join(basename), content).map_err(|e| e.to_string())
}

/// Reduce `name` to a bare, separator-free filename: just its final path
/// component, so any `..`/`/`/`\` traversal segments are dropped rather than
/// honored. Rejects the degenerate cases (`""`, `.`, `..`) that would still
/// slip through `file_name()` as `None`/a no-op.
fn sanitize_name(name: &str) -> Result<String, String> {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|b| !b.is_empty())
        .ok_or_else(|| format!("invalid sync file name: {name}"))?;
    Ok(base.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "eve-sync-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir.to_str().unwrap().to_string()
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = test_dir("roundtrip");

        sync_folder_write(dir.clone(), "reminders.json".into(), "{\"a\":1}".into())
            .expect("write succeeds");
        sync_folder_write(dir.clone(), "pi.json".into(), "{\"b\":2}".into())
            .expect("write succeeds");
        // Non-JSON files in the same folder are ignored by the read.
        fs::write(Path::new(&dir).join("notes.txt"), "ignore me").unwrap();

        let mut files = sync_folder_read(dir.clone()).expect("read succeeds");
        files.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "pi.json");
        assert_eq!(files[0].content, "{\"b\":2}");
        assert_eq!(files[1].name, "reminders.json");
        assert_eq!(files[1].content, "{\"a\":1}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_creates_the_folder_if_missing() {
        let dir = std::path::PathBuf::from(test_dir("creates")).join("nested");
        let dir_str = dir.to_str().unwrap().to_string();

        sync_folder_write(dir_str, "pi.json".into(), "{}".into()).expect("write creates the dir");

        assert!(dir.join("pi.json").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_errors_when_the_directory_is_missing() {
        let missing = test_dir("missing");
        assert!(sync_folder_read(missing).is_err());
    }

    #[test]
    fn traversal_name_stays_inside_the_sync_dir() {
        let dir = test_dir("traversal");
        fs::create_dir_all(&dir).unwrap();
        let parent = Path::new(&dir).parent().unwrap().to_path_buf();

        sync_folder_write(dir.clone(), "../evil.json".into(), "{}".into())
            .expect("write succeeds, sanitized");

        // Landed inside dir as "evil.json", not one level up.
        assert!(Path::new(&dir).join("evil.json").is_file());
        assert!(!parent.join("evil.json").is_file());

        let files = sync_folder_read(dir.clone()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "evil.json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absolute_path_name_is_reduced_to_its_basename() {
        let dir = test_dir("absolute");
        fs::create_dir_all(&dir).unwrap();

        sync_folder_write(dir.clone(), "/etc/evil.json".into(), "{}".into())
            .expect("write succeeds, sanitized");

        assert!(Path::new(&dir).join("evil.json").is_file());
        assert!(!Path::new("/etc/evil.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
