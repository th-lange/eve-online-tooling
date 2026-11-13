//! Persistence for the Notes module: plain files on disk.
//!
//! A *store* is a directory (the "root"). Folders are real sub-directories and
//! each note is one real file — `.md`, `.txt` or `.csv` — so the whole thing
//! is readable and editable outside the app, and a shared drive (Dropbox,
//! Syncthing, a network share, …) syncs it file-by-file instead of
//! last-writer-wins on one big document.
//!
//! Tags can't live inside the files (CSV/plain text have nowhere to put them),
//! so they sit in one small hidden index, `<root>/.notes-meta.json`, keyed by
//! each note's relative path. Rename/move/delete keep it in step.
//!
//! Every function takes the store `root` explicitly and treats every relative
//! path it is given as untrusted: components are validated so nothing can
//! escape the root (`..`, absolute paths, drive prefixes) or touch hidden
//! files such as the index itself.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::types::{NoteEntry, NoteKind, NoteTree, SaveResult, SearchHit};

/// Hidden tag index, written next to the notes.
const META_FILE: &str = ".notes-meta.json";
/// Folder nesting limit when listing (guards against pathological trees).
const MAX_DEPTH: usize = 16;
const MAX_NAME_CHARS: usize = 100;
const MAX_TAGS: usize = 50;
const MAX_TAG_CHARS: usize = 40;
/// Files larger than this are matched by name/tags only, not content.
const MAX_SEARCH_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_HITS: usize = 200;

// --- Locations ----------------------------------------------------------------

/// This device's own notes directory: `<app data>/notes`.
pub fn local_root(app_data: &Path) -> PathBuf {
    app_data.join("notes")
}

/// The notes directory inside a shared (sync) folder: `<shared>/notes`.
pub fn shared_root(shared: &str) -> PathBuf {
    Path::new(shared).join("notes")
}

/// Where notes live right now: the shared folder's `notes/` when one is
/// configured (non-blank), otherwise the local app-data one.
pub fn resolve_root(app_data: &Path, shared: Option<&str>) -> PathBuf {
    match shared.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => shared_root(dir),
        None => local_root(app_data),
    }
}

// --- Path + name validation ---------------------------------------------------

/// One component of an *existing* relative path. Lenient about what a name may
/// contain, strict about anything that could leave the root or hit hidden files.
fn check_component(c: &str) -> Result<(), String> {
    if c.is_empty()
        || c.starts_with('.')
        || c.contains(['\\', ':'])
        || c.chars().any(char::is_control)
    {
        return Err(format!("invalid path {c:?}"));
    }
    Ok(())
}

/// Absolute path for a relative one (`""` = the root itself).
fn abs_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    if rel.is_empty() {
        return Ok(path);
    }
    for component in rel.split('/') {
        check_component(component)?;
        path.push(component);
    }
    Ok(path)
}

/// Absolute path of a note file, plus its kind (from the extension).
fn note_path(root: &Path, rel: &str) -> Result<(PathBuf, NoteKind), String> {
    let kind = rel
        .rsplit_once('.')
        .and_then(|(_, ext)| NoteKind::from_extension(ext))
        .ok_or_else(|| format!("{rel:?} is not a note (.md, .txt or .csv)"))?;
    Ok((abs_path(root, rel)?, kind))
}

/// Absolute path of an existing folder; errors if it isn't a directory.
fn folder_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = abs_path(root, rel)?;
    if path.is_dir() {
        Ok(path)
    } else {
        Err(format!("folder {rel:?} doesn't exist"))
    }
}

/// A user-supplied note/folder name, validated for use as a file name on every
/// platform (Windows is the strictest). Returns it trimmed.
fn validate_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Name can't be empty".into());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("Name is longer than {MAX_NAME_CHARS} characters"));
    }
    if name.starts_with('.') || name.ends_with('.') {
        return Err("Name can't start or end with a dot".into());
    }
    if let Some(bad) = name
        .chars()
        .find(|c| c.is_control() || "/\\:*?\"<>|".contains(*c))
    {
        return Err(format!("Name can't contain {bad:?}"));
    }
    // Windows reserves these device names, with or without an extension.
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return Err(format!("{name:?} is a reserved name"));
    }
    Ok(name.to_string())
}

/// `folder` + `name` as a relative path.
fn join_rel(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

/// Split a relative path into (parent folder, last component).
fn split_rel(rel: &str) -> (&str, &str) {
    rel.rsplit_once('/').unwrap_or(("", rel))
}

/// True when both paths resolve to the same file (so a case-only rename on a
/// case-insensitive filesystem isn't mistaken for a collision).
fn same_file(a: &Path, b: &Path) -> bool {
    matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

fn modified_ms(md: &fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Write via a hidden temp file + rename, so a reader (or the sync tool) never
/// sees a half-written note and a crash can't truncate the original.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("invalid file name")?;
    let tmp = path.with_file_name(format!(".{file_name}.tmp"));
    let result = fs::File::create(&tmp)
        .and_then(|mut f| f.write_all(content.as_bytes()).and_then(|_| f.sync_all()))
        .and_then(|_| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("writing {file_name}: {e}"))
}

// --- Tag index ----------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct Meta {
    /// Relative note path → tags.
    #[serde(default)]
    tags: BTreeMap<String, Vec<String>>,
}

/// Read the tag index. A missing file is an empty index; an unreadable or
/// corrupt one is an error so callers never overwrite it blindly.
fn load_meta(root: &Path) -> Result<Meta, String> {
    match fs::read(root.join(META_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("the tag index ({META_FILE}) is unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Meta::default()),
        Err(e) => Err(format!("reading {META_FILE}: {e}")),
    }
}

fn save_meta(root: &Path, meta: &Meta) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("creating {}: {e}", root.display()))?;
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    write_atomic(&root.join(META_FILE), &json)
}

/// Move the index entry for `old` (and, for a folder, everything under it) to
/// `new`. Returns whether anything changed.
fn rekey(meta: &mut Meta, old: &str, new: &str) -> bool {
    let prefix = format!("{old}/");
    let moved: Vec<String> = meta
        .tags
        .keys()
        .filter(|k| *k == old || k.starts_with(&prefix))
        .cloned()
        .collect();
    for key in &moved {
        if let Some(tags) = meta.tags.remove(key) {
            meta.tags
                .insert(format!("{new}{}", &key[old.len()..]), tags);
        }
    }
    !moved.is_empty()
}

/// Drop the index entry for `target` (and everything under it).
fn forget(meta: &mut Meta, target: &str) -> bool {
    let prefix = format!("{target}/");
    let before = meta.tags.len();
    meta.tags
        .retain(|k, _| k != target && !k.starts_with(&prefix));
    meta.tags.len() != before
}

/// Best-effort index update after a rename/move/delete. A corrupt index is
/// left alone (never overwritten) — the file operation already succeeded.
fn update_meta(root: &Path, change: impl FnOnce(&mut Meta) -> bool) {
    if let Ok(mut meta) = load_meta(root) {
        if change(&mut meta) {
            let _ = save_meta(root, &meta);
        }
    }
}

/// Lowercase, trim, strip a leading `#`, collapse inner whitespace, drop
/// empties and duplicates, and cap length/count.
pub fn normalize_tags(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in raw {
        let cleaned = tag
            .trim()
            .trim_start_matches('#')
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        let cleaned: String = cleaned.chars().take(MAX_TAG_CHARS).collect();
        if !cleaned.is_empty() && !out.contains(&cleaned) {
            out.push(cleaned);
        }
        if out.len() >= MAX_TAGS {
            break;
        }
    }
    out
}

// --- Listing ------------------------------------------------------------------

fn entry_for(rel: &str, md: &fs::Metadata, meta: &Meta) -> Option<NoteEntry> {
    let (folder, file) = split_rel(rel);
    let (name, ext) = file.rsplit_once('.')?;
    let kind = NoteKind::from_extension(ext)?;
    Some(NoteEntry {
        path: rel.to_string(),
        name: name.to_string(),
        kind,
        folder: folder.to_string(),
        tags: meta.tags.get(rel).cloned().unwrap_or_default(),
        updated_at: modified_ms(md),
        size: md.len(),
    })
}

fn entry(root: &Path, rel: &str) -> Result<NoteEntry, String> {
    let (path, _) = note_path(root, rel)?;
    let md = fs::metadata(&path).map_err(|_| format!("note {rel:?} no longer exists"))?;
    let meta = load_meta(root).unwrap_or_default();
    entry_for(rel, &md, &meta).ok_or_else(|| format!("{rel:?} is not a note"))
}

/// Depth-first walk collecting folders and notes. Hidden entries, symlinks and
/// non-note files are skipped; everything returned is addressable by the other
/// functions here.
fn walk(
    dir: &Path,
    rel: &str,
    depth: usize,
    meta: &Meta,
    folders: &mut Vec<String>,
    notes: &mut Vec<NoteEntry>,
) {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    for item in read_dir.flatten() {
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        if check_component(&name).is_err() {
            continue;
        }
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        let child = join_rel(rel, &name);
        if file_type.is_dir() {
            if depth < MAX_DEPTH {
                folders.push(child.clone());
                walk(&item.path(), &child, depth + 1, meta, folders, notes);
            }
        } else if file_type.is_file() {
            if let Ok(md) = item.metadata() {
                if let Some(note) = entry_for(&child, &md, meta) {
                    notes.push(note);
                }
            }
        }
    }
}

/// Every folder and note under `root` (empty when it doesn't exist yet).
pub fn list(root: &Path) -> NoteTree {
    let meta = load_meta(root).unwrap_or_default();
    let mut folders = Vec::new();
    let mut notes = Vec::new();
    walk(root, "", 0, &meta, &mut folders, &mut notes);
    folders.sort_by_key(|f| f.to_lowercase());
    notes.sort_by_key(|n| n.path.to_lowercase());
    NoteTree { folders, notes }
}

// --- Notes --------------------------------------------------------------------

/// A note's text content. Fails for non-UTF-8 files rather than corrupting
/// them on the next save.
pub fn read(root: &Path, rel: &str) -> Result<String, String> {
    let (path, _) = note_path(root, rel)?;
    let bytes = fs::read(&path).map_err(|e| format!("reading {rel}: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{rel} is not valid UTF-8 text"))?;
    // Spreadsheet tools love a leading byte-order mark; it isn't content.
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// Create a note in `folder`. If `name` is taken, a numeric suffix is added
/// (`Untitled`, `Untitled 2`, …) so creating never fails on a collision.
pub fn create(
    root: &Path,
    folder: &str,
    name: &str,
    kind: NoteKind,
    content: &str,
) -> Result<NoteEntry, String> {
    let name = validate_name(name)?;
    fs::create_dir_all(root).map_err(|e| format!("creating {}: {e}", root.display()))?;
    let dir = folder_path(root, folder)?;
    let ext = kind.extension();
    let mut attempt = 1;
    loop {
        let file = if attempt == 1 {
            format!("{name}.{ext}")
        } else {
            format!("{name} {attempt}.{ext}")
        };
        // `create_new` fails atomically if the file exists, so two devices
        // creating the same name at once can't overwrite each other.
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(&file))
        {
            Ok(mut f) => {
                f.write_all(content.as_bytes())
                    .map_err(|e| format!("writing {file}: {e}"))?;
                return entry(root, &join_rel(folder, &file));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => attempt += 1,
            Err(e) => return Err(format!("creating {file}: {e}")),
        }
    }
}

/// Overwrite a note's content. With `expected_updated_at`, refuses (returns
/// `saved: false`) when the file changed since the caller loaded it.
pub fn save(
    root: &Path,
    rel: &str,
    content: &str,
    expected_updated_at: Option<i64>,
) -> Result<SaveResult, String> {
    let (path, _) = note_path(root, rel)?;
    let md = fs::metadata(&path).map_err(|_| format!("note {rel:?} no longer exists"))?;
    if let Some(expected) = expected_updated_at {
        if modified_ms(&md) != expected {
            return Ok(SaveResult {
                saved: false,
                entry: entry(root, rel)?,
            });
        }
    }
    write_atomic(&path, content)?;
    Ok(SaveResult {
        saved: true,
        entry: entry(root, rel)?,
    })
}

/// Rename a note (its extension is kept).
pub fn rename(root: &Path, rel: &str, new_name: &str) -> Result<NoteEntry, String> {
    let name = validate_name(new_name)?;
    let (old, kind) = note_path(root, rel)?;
    let (folder, _) = split_rel(rel);
    let new_rel = join_rel(folder, &format!("{name}.{}", kind.extension()));
    if new_rel == rel {
        return entry(root, rel);
    }
    relocate(root, rel, &new_rel, &old)?;
    entry(root, &new_rel)
}

/// Move a note into `folder` (`""` = the root).
pub fn move_note(root: &Path, rel: &str, folder: &str) -> Result<NoteEntry, String> {
    let (old, _) = note_path(root, rel)?;
    folder_path(root, folder)?;
    let (_, file) = split_rel(rel);
    let new_rel = join_rel(folder, file);
    if new_rel == rel {
        return entry(root, rel);
    }
    relocate(root, rel, &new_rel, &old)?;
    entry(root, &new_rel)
}

/// Rename `old_rel` to `new_rel` on disk (refusing to clobber a different
/// file) and carry its tags along.
fn relocate(root: &Path, old_rel: &str, new_rel: &str, old_abs: &Path) -> Result<(), String> {
    let new_abs = abs_path(root, new_rel)?;
    if new_abs.exists() && !same_file(old_abs, &new_abs) {
        let (_, file) = split_rel(new_rel);
        return Err(format!("{file:?} already exists there"));
    }
    fs::rename(old_abs, &new_abs).map_err(|e| format!("moving {old_rel}: {e}"))?;
    update_meta(root, |meta| rekey(meta, old_rel, new_rel));
    Ok(())
}

pub fn delete(root: &Path, rel: &str) -> Result<(), String> {
    let (path, _) = note_path(root, rel)?;
    fs::remove_file(&path).map_err(|e| format!("deleting {rel}: {e}"))?;
    update_meta(root, |meta| forget(meta, rel));
    Ok(())
}

pub fn set_tags(root: &Path, rel: &str, tags: &[String]) -> Result<NoteEntry, String> {
    let (path, _) = note_path(root, rel)?;
    if !path.is_file() {
        return Err(format!("note {rel:?} no longer exists"));
    }
    let mut meta = load_meta(root)?;
    let tags = normalize_tags(tags);
    if tags.is_empty() {
        meta.tags.remove(rel);
    } else {
        meta.tags.insert(rel.to_string(), tags);
    }
    save_meta(root, &meta)?;
    entry(root, rel)
}

// --- Folders ------------------------------------------------------------------

/// Create `name` inside `parent`; returns the new folder's relative path.
pub fn create_folder(root: &Path, parent: &str, name: &str) -> Result<String, String> {
    let name = validate_name(name)?;
    fs::create_dir_all(root).map_err(|e| format!("creating {}: {e}", root.display()))?;
    let dir = folder_path(root, parent)?;
    match fs::create_dir(dir.join(&name)) {
        Ok(()) => Ok(join_rel(parent, &name)),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(format!("A folder named {name:?} already exists there"))
        }
        Err(e) => Err(format!("creating folder {name}: {e}")),
    }
}

pub fn rename_folder(root: &Path, rel: &str, new_name: &str) -> Result<String, String> {
    if rel.is_empty() {
        return Err("The root folder can't be renamed".into());
    }
    let name = validate_name(new_name)?;
    let old = folder_path(root, rel)?;
    let (parent, _) = split_rel(rel);
    let new_rel = join_rel(parent, &name);
    if new_rel == rel {
        return Ok(new_rel);
    }
    relocate(root, rel, &new_rel, &old)?;
    Ok(new_rel)
}

/// Move folder `rel` (with everything in it) under `parent`.
pub fn move_folder(root: &Path, rel: &str, parent: &str) -> Result<String, String> {
    if rel.is_empty() {
        return Err("The root folder can't be moved".into());
    }
    if parent == rel || parent.starts_with(&format!("{rel}/")) {
        return Err("A folder can't be moved into itself".into());
    }
    let old = folder_path(root, rel)?;
    folder_path(root, parent)?;
    let (_, last) = split_rel(rel);
    let new_rel = join_rel(parent, last);
    if new_rel == rel {
        return Ok(new_rel);
    }
    relocate(root, rel, &new_rel, &old)?;
    Ok(new_rel)
}

/// Delete a folder and everything in it.
pub fn delete_folder(root: &Path, rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("The root folder can't be deleted".into());
    }
    let path = folder_path(root, rel)?;
    fs::remove_dir_all(&path).map_err(|e| format!("deleting {rel}: {e}"))?;
    update_meta(root, |meta| forget(meta, rel));
    Ok(())
}

// --- Search -------------------------------------------------------------------

/// Case-fold one char at a time so the folded text stays char-for-char aligned
/// with the original (needed to cut snippets from the original).
fn fold(s: &str) -> String {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

/// ~120 chars of single-line context around the match of `term`.
fn snippet(content: &str, folded: &str, term: &str) -> String {
    let Some(byte_pos) = folded.find(term) else {
        return String::new();
    };
    let at = folded[..byte_pos].chars().count();
    let chars: Vec<char> = content.chars().collect();
    let start = at.saturating_sub(40);
    let end = (at + term.chars().count() + 80).min(chars.len());
    let body: String = chars[start..end].iter().collect();
    let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        body,
        if end < chars.len() { "…" } else { "" }
    )
}

/// Full-text search over every note's name, folder, tags and content. Every
/// whitespace-separated term must match somewhere (case-insensitive); results
/// rank name matches, then name/folder/tag matches, then content-only matches,
/// newest first within each.
pub fn search(root: &Path, query: &str) -> Vec<SearchHit> {
    let folded_query = fold(query);
    let terms: Vec<&str> = folded_query.split_whitespace().collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let mut ranked: Vec<(u8, SearchHit)> = Vec::new();
    for note in list(root).notes {
        let name = fold(&note.name);
        let meta_text = fold(&format!(
            "{} {} {}",
            note.name,
            note.folder,
            note.tags.join(" ")
        ));
        let content = if note.size <= MAX_SEARCH_BYTES {
            read(root, &note.path).unwrap_or_default()
        } else {
            String::new()
        };
        let folded = fold(&content);
        if !terms
            .iter()
            .all(|t| meta_text.contains(t) || folded.contains(t))
        {
            continue;
        }
        let rank = if terms.iter().all(|t| name.contains(t)) {
            0
        } else if terms.iter().all(|t| meta_text.contains(t)) {
            1
        } else {
            2
        };
        let snippet = terms
            .iter()
            .find(|t| folded.contains(**t))
            .map(|t| snippet(&content, &folded, t))
            .unwrap_or_default();
        ranked.push((
            rank,
            SearchHit {
                entry: note,
                snippet,
            },
        ));
    }
    ranked.sort_by(|(ra, a), (rb, b)| ra.cmp(rb).then(b.entry.updated_at.cmp(&a.entry.updated_at)));
    ranked.truncate(MAX_SEARCH_HITS);
    ranked.into_iter().map(|(_, hit)| hit).collect()
}

// --- Local → shared -----------------------------------------------------------

/// Local notes that don't exist at the same path in the shared store.
pub fn local_only(app_data: &Path, shared: &Path) -> u32 {
    let local = local_root(app_data);
    if same_file(&local, shared) {
        return 0;
    }
    list(&local)
        .notes
        .iter()
        .filter(|n| abs_path(shared, &n.path).is_ok_and(|p| !p.exists()))
        .count() as u32
}

/// Copy this device's local notes (and folders, and tags) into the shared
/// store. Never overwrites a note that already exists there and never touches
/// the local copies. Returns how many notes were copied.
pub fn import_local(app_data: &Path, shared: &Path) -> Result<u32, String> {
    let local = local_root(app_data);
    if !local.is_dir() || same_file(&local, shared) {
        return Ok(0);
    }
    let tree = list(&local);
    fs::create_dir_all(shared).map_err(|e| format!("creating {}: {e}", shared.display()))?;
    for folder in &tree.folders {
        fs::create_dir_all(abs_path(shared, folder)?)
            .map_err(|e| format!("creating folder {folder}: {e}"))?;
    }
    let mut shared_meta = load_meta(shared)?;
    let mut copied = 0;
    let mut meta_changed = false;
    for note in &tree.notes {
        let dest = abs_path(shared, &note.path)?;
        if dest.exists() {
            continue;
        }
        fs::copy(abs_path(&local, &note.path)?, &dest)
            .map_err(|e| format!("copying {}: {e}", note.path))?;
        copied += 1;
        if !note.tags.is_empty() {
            shared_meta
                .tags
                .entry(note.path.clone())
                .or_insert_with(|| note.tags.clone());
            meta_changed = true;
        }
    }
    if meta_changed {
        save_meta(shared, &shared_meta)?;
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A fresh, empty directory per call, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "notes-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn md(root: &Path, folder: &str, name: &str, body: &str) -> NoteEntry {
        create(root, folder, name, NoteKind::Markdown, body).unwrap()
    }

    #[test]
    fn create_dedupes_names_and_listing_skips_non_notes() {
        let t = TempDir::new();
        let root = &t.0;
        assert_eq!(md(root, "", "Untitled", "a").path, "Untitled.md");
        assert_eq!(md(root, "", "Untitled", "b").path, "Untitled 2.md");
        create(root, "", "Prices", NoteKind::Table, "a,b\n1,2").unwrap();
        fs::write(root.join("photo.png"), b"x").unwrap();
        fs::write(root.join(".hidden.md"), b"x").unwrap();
        let tree = list(root);
        let paths: Vec<_> = tree.notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(paths, ["Prices.csv", "Untitled 2.md", "Untitled.md"]);
        assert_eq!(tree.notes[0].kind, NoteKind::Table);
    }

    #[test]
    fn rejects_paths_that_escape_the_root_or_hit_hidden_files() {
        let t = TempDir::new();
        let root = &t.0;
        md(root, "", "ok", "x");
        for bad in [
            "../ok.md",
            "a/../ok.md",
            "/etc/passwd.md",
            ".notes-meta.json.md",
            "C:/x.md",
        ] {
            assert!(read(root, bad).is_err(), "{bad} should be rejected");
        }
        assert!(read(root, "ok.exe").is_err());
        assert!(create(root, "", "a/b", NoteKind::Text, "").is_err());
        assert!(create(root, "", "..", NoteKind::Text, "").is_err());
        assert!(create(root, "", "con", NoteKind::Text, "").is_err());
        assert!(create(root, "../elsewhere", "x", NoteKind::Text, "").is_err());
    }

    #[test]
    fn rename_and_move_carry_tags_and_refuse_collisions() {
        let t = TempDir::new();
        let root = &t.0;
        create_folder(root, "", "Ships").unwrap();
        md(root, "", "Rifter", "fit");
        md(root, "Ships", "Rifter", "other");
        set_tags(root, "Rifter.md", &["#PVP".into(), "frigate".into()]).unwrap();

        // Same name already in the destination folder → refused, nothing moved.
        assert!(move_note(root, "Rifter.md", "Ships").is_err());
        assert!(read(root, "Rifter.md").is_ok());

        let renamed = rename(root, "Rifter.md", "Slasher").unwrap();
        assert_eq!(renamed.path, "Slasher.md");
        assert_eq!(renamed.tags, ["pvp", "frigate"]);

        let moved = move_note(root, "Slasher.md", "Ships").unwrap();
        assert_eq!(moved.path, "Ships/Slasher.md");
        assert_eq!(moved.folder, "Ships");
        assert_eq!(moved.tags, ["pvp", "frigate"]);
        assert!(read(root, "Slasher.md").is_err());
        assert_eq!(read(root, "Ships/Slasher.md").unwrap(), "fit");

        // Renaming onto an existing sibling is refused too.
        assert!(rename(root, "Ships/Slasher.md", "Rifter").is_err());
    }

    #[test]
    fn folder_rename_and_move_rekey_nested_tags() {
        let t = TempDir::new();
        let root = &t.0;
        create_folder(root, "", "A").unwrap();
        create_folder(root, "A", "B").unwrap();
        create_folder(root, "", "C").unwrap();
        md(root, "A/B", "deep", "x");
        set_tags(root, "A/B/deep.md", &["t".into()]).unwrap();

        assert_eq!(rename_folder(root, "A", "Alpha").unwrap(), "Alpha");
        assert_eq!(move_folder(root, "Alpha", "C").unwrap(), "C/Alpha");
        let tree = list(root);
        assert_eq!(tree.notes[0].path, "C/Alpha/B/deep.md");
        assert_eq!(tree.notes[0].tags, ["t"]);

        assert!(move_folder(root, "C", "C/Alpha/B").is_err());
        assert!(move_folder(root, "C", "C").is_err());
        assert!(rename_folder(root, "", "x").is_err());
    }

    #[test]
    fn delete_removes_tags_and_folder_contents() {
        let t = TempDir::new();
        let root = &t.0;
        create_folder(root, "", "F").unwrap();
        md(root, "F", "n", "x");
        set_tags(root, "F/n.md", &["keep".into()]).unwrap();
        delete_folder(root, "F").unwrap();
        assert!(list(root).notes.is_empty());
        assert!(load_meta(root).unwrap().tags.is_empty());
        assert!(delete_folder(root, "").is_err());
    }

    #[test]
    fn save_refuses_when_the_file_changed_underneath() {
        let t = TempDir::new();
        let root = &t.0;
        let note = md(root, "", "n", "v1");
        // Another device rewrites the file after we loaded it.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(root.join("n.md"), "theirs").unwrap();

        let stale = save(root, "n.md", "mine", Some(note.updated_at)).unwrap();
        assert!(!stale.saved);
        assert_eq!(read(root, "n.md").unwrap(), "theirs");

        // Retrying against the current version (or force-saving) succeeds.
        let ok = save(root, "n.md", "mine", Some(stale.entry.updated_at)).unwrap();
        assert!(ok.saved);
        assert_eq!(read(root, "n.md").unwrap(), "mine");
        assert!(save(root, "n.md", "forced", None).unwrap().saved);
        assert!(save(root, "gone.md", "x", None).is_err());
    }

    #[test]
    fn search_requires_every_term_and_ranks_names_first() {
        let t = TempDir::new();
        let root = &t.0;
        create_folder(root, "", "Ships").unwrap();
        md(root, "", "Jita routes", "gate camps near the Perimeter");
        md(root, "Ships", "Fits", "Rifter with Perimeter autocannons");
        md(root, "", "Misc", "nothing relevant");
        set_tags(root, "Misc.md", &["perimeter".into()]).unwrap();

        let hits = search(root, "perimeter");
        let paths: Vec<_> = hits.iter().map(|h| h.entry.path.as_str()).collect();
        // Tag match ranks above content-only matches.
        assert_eq!(paths[0], "Misc.md");
        assert_eq!(hits.len(), 3);

        let narrowed = search(root, "RIFTER perimeter");
        assert_eq!(narrowed.len(), 1);
        assert_eq!(narrowed[0].entry.path, "Ships/Fits.md");
        assert!(narrowed[0].snippet.contains("Rifter with Perimeter"));

        // Folder and name are searchable even with no content match.
        assert_eq!(search(root, "ships")[0].entry.path, "Ships/Fits.md");
        assert!(search(root, "zzz").is_empty());
        assert!(search(root, "   ").is_empty());
    }

    #[test]
    fn import_local_copies_without_overwriting() {
        let app = TempDir::new();
        let shared = TempDir::new();
        let local = local_root(&app.0);
        let shared_notes = shared_root(shared.0.to_str().unwrap());

        create_folder(&local, "", "F").unwrap();
        md(&local, "F", "a", "local a");
        md(&local, "", "b", "local b");
        set_tags(&local, "F/a.md", &["x".into()]).unwrap();
        md(&shared_notes, "", "b", "shared b");

        assert_eq!(local_only(&app.0, &shared_notes), 1);
        assert_eq!(import_local(&app.0, &shared_notes).unwrap(), 1);
        assert_eq!(local_only(&app.0, &shared_notes), 0);

        assert_eq!(read(&shared_notes, "F/a.md").unwrap(), "local a");
        let copied = list(&shared_notes);
        let a = copied.notes.iter().find(|n| n.path == "F/a.md").unwrap();
        assert_eq!(a.tags, ["x"]);
        // The shared copy of `b` wins; the local one is untouched.
        assert_eq!(read(&shared_notes, "b.md").unwrap(), "shared b");
        assert_eq!(read(&local, "b.md").unwrap(), "local b");
        // Idempotent.
        assert_eq!(import_local(&app.0, &shared_notes).unwrap(), 0);
    }

    #[test]
    fn resolve_root_prefers_a_configured_shared_folder() {
        let app = Path::new("/data");
        assert_eq!(resolve_root(app, None), Path::new("/data/notes"));
        assert_eq!(resolve_root(app, Some("  ")), Path::new("/data/notes"));
        assert_eq!(
            resolve_root(app, Some("/mnt/drive")),
            Path::new("/mnt/drive/notes")
        );
    }

    #[test]
    fn tags_are_normalised() {
        let raw = [
            " #PvP ".to_string(),
            "pvp".into(),
            "  two   words ".into(),
            "".into(),
            "#".into(),
        ];
        assert_eq!(normalize_tags(&raw), ["pvp", "two words"]);
    }

    #[test]
    fn a_corrupt_tag_index_is_never_overwritten_by_renames() {
        let t = TempDir::new();
        let root = &t.0;
        md(root, "", "n", "x");
        fs::write(root.join(META_FILE), "{ not json").unwrap();
        rename(root, "n.md", "m").unwrap();
        assert_eq!(
            fs::read_to_string(root.join(META_FILE)).unwrap(),
            "{ not json"
        );
        assert!(set_tags(root, "m.md", &["a".into()]).is_err());
    }
}
