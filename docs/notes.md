# Notes

The **Notes** module keeps your own documents and tables next to the rest of the
tools: Markdown or plain-text notes, and CSV tables, filed in named folders,
tagged, sortable and searchable.

## Note types

| Type     | File   | Editor                                                   |
| -------- | ------ | -------------------------------------------------------- |
| Markdown | `.md`  | Text box with an **Edit / Preview** switch               |
| Text     | `.txt` | Plain text box                                           |
| Table    | `.csv` | Spreadsheet-style **grid** (first row = header) or raw CSV |

The Markdown preview covers the everyday subset — headings, bold/italic/strike,
inline code, links (web and mail only), fenced code, quotes, flat bullet /
numbered / task lists and rules. Raw HTML is shown as text, never run.

## Organising

- **Name** a note by editing the title at the top of the editor; **name** a
  folder with the pencil on its row (or double-click it).
- **Folders** nest. Create one with the folder-plus button on a row (hover or
  focus the row to see its buttons).
- **Move** a note by dragging its row onto a folder, or with the editor's
  **Folder** picker. Folders can be dragged onto other folders too.
- **Tags** are added in the editor (type and press Enter; commas add several).
  Click a tag anywhere — the Tags list, a table row — to filter by it.
- **Sort** the note list by clicking any column header: name, folder, type,
  tags, modified, size. The choice is remembered.

## Search

The search box looks through every note's **name, folder, tags and content**
(case-insensitive; every word you type must match somewhere). Results show the
matching excerpt with the terms highlighted. Files over 2 MiB are matched by
name and tags only.

## Where notes are stored

Notes are **plain files**, one per note, in real folders:

- **Shared folder configured** (Settings → Sync: a folder is chosen _and_
  activated) → `<sync folder>/notes/`. Every device pointed at that folder —
  Dropbox, Syncthing, a network share, … — sees the same notes. The Notes
  header shows the active location.
- **Otherwise** → `<app data>/notes/` on this device only.

When sync is active and this device still holds local-only notes, the page
offers **Copy to shared folder**. It never overwrites a note that already
exists in the shared folder and never deletes the local copies.

Because they are ordinary files you can open, edit or back them up with any
tool. Tags are the one exception — they live in a small hidden index,
`notes/.notes-meta.json`. Renaming or moving a note **outside** the app loses
its tags; rename inside the app.

### Edits from several devices

Each note is its own file, so devices editing _different_ notes never collide.
When two devices edit the _same_ note, saving carries the file's modification
time from when you opened it: if it changed in the meantime, nothing is
overwritten and the editor offers **Discard my edits & reload** or **Overwrite
with mine**. A clean (unedited) note you have open reloads by itself when the
file changes underneath it.

## Limits and notes

- Names can't contain `/ \ : * ? " < > |`, can't start or end with a dot, and
  can't be reserved Windows device names (`CON`, `NUL`, …).
- Tags are lower-cased, trimmed and capped at 40 characters.
- A plugin can't use the id `notes` — built-in modules win route collisions.
