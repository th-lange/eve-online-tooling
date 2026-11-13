//! Wire types for the Notes module.

use serde::{Deserialize, Serialize};

/// What a note's file holds. The kind is encoded in the file extension, so
/// a notes folder stays readable (and editable) with any text editor or
/// spreadsheet outside the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteKind {
    /// Plain text (`.txt`).
    Text,
    /// Markdown (`.md`).
    Markdown,
    /// A table (`.csv`).
    Table,
}

impl NoteKind {
    /// The file extension (without the dot) for this kind.
    pub fn extension(self) -> &'static str {
        match self {
            NoteKind::Text => "txt",
            NoteKind::Markdown => "md",
            NoteKind::Table => "csv",
        }
    }

    /// The kind for a file extension (case-insensitive), or `None` for files
    /// that aren't notes (images, the metadata file, …) so listing skips them.
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "txt" => Some(NoteKind::Text),
            "md" => Some(NoteKind::Markdown),
            "csv" => Some(NoteKind::Table),
            _ => None,
        }
    }
}

/// One note's metadata (everything except its content).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    /// Path relative to the notes root, `/`-separated, with extension
    /// (`ships/Rifter fit.md`). The note's stable identity within a store.
    pub path: String,
    /// Display name: the file name without its extension.
    pub name: String,
    pub kind: NoteKind,
    /// The containing folder's relative path (`""` = the root).
    pub folder: String,
    /// Normalised (lowercase, trimmed, de-duplicated) tags.
    pub tags: Vec<String>,
    /// File modification time, unix milliseconds (0 if unavailable).
    pub updated_at: i64,
    /// File size in bytes.
    pub size: u64,
}

/// Every folder and note in a store.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTree {
    /// Relative folder paths (the root itself is implicit), sorted.
    pub folders: Vec<String>,
    pub notes: Vec<NoteEntry>,
}

/// Outcome of a save. `saved == false` means the file changed on disk since
/// the caller loaded it (another device via the shared folder, an external
/// editor) — nothing was written and `entry` describes the file as it is now,
/// so the UI can offer reload or overwrite.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved: bool,
    pub entry: NoteEntry,
}

/// One search result: the note plus a one-line excerpt around the first
/// content match (empty when only the name/folder/tags matched).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub entry: NoteEntry,
    pub snippet: String,
}

/// Where notes currently live, for the page header and the "copy local notes
/// to the shared folder" prompt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesLocation {
    /// Absolute path of the active notes folder.
    pub root: String,
    /// True when `root` is inside the configured shared (sync) folder.
    pub shared: bool,
    /// Notes in this device's local store that aren't in the shared store yet
    /// (always 0 when not shared).
    pub local_only: u32,
}
