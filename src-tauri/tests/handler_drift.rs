//! #818: guard against `invoke_handler` registration drift.
//!
//! Tauri has no compile-time check that every `#[tauri::command]` fn is
//! listed in the `tauri::generate_handler!` macro in `lib.rs` — a forgotten
//! registration doesn't fail the build or crash the app, it just makes the
//! frontend's `invoke()` reject at runtime with no other symptom. This test
//! statically scans the crate's source for both lists and fails, naming the
//! exact command(s), the moment they drift apart.
//!
//! It's a plain string/line scan rather than a regex crate or a proc-macro
//! hook, on purpose: zero new dependencies, zero build-time cost, and it
//! runs as an ordinary `cargo test` (already CI-gated).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Recursively collect every `.rs` file under `dir`.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Pull the identifier out of a `pub fn NAME` / `pub async fn NAME` line
/// (whatever follows — generics, args, return type — is irrelevant; only the
/// name up to the first non-identifier byte matters).
fn fn_name_from_signature(line: &str) -> Option<String> {
    let rest = line
        .trim_start()
        .strip_prefix("pub async fn ")
        .or_else(|| line.trim_start().strip_prefix("pub fn "))?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

/// Every function name annotated `#[tauri::command]` across `src-tauri/src`.
/// The attribute always sits directly above the `pub fn`/`pub async fn` line
/// (see `commands.rs`, `plugins/manager.rs`, etc.) — occasionally with one or
/// more further attributes in between (`#[specta::specta]` on `orders_list`,
/// `#[allow(clippy::too_many_arguments)]` on a couple of wide commands), so
/// the scan skips over any additional `#[...]` lines before the signature.
fn declared_commands() -> BTreeSet<String> {
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src_dir, &mut files);

    let mut names = BTreeSet::new();
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if line.trim() != "#[tauri::command]" {
                continue;
            }
            // Skip any further attribute lines before the fn signature.
            let mut j = i + 1;
            while lines
                .get(j)
                .is_some_and(|l| l.trim_start().starts_with("#["))
            {
                j += 1;
            }
            let Some(sig) = lines.get(j) else { continue };
            match fn_name_from_signature(sig) {
                Some(name) => {
                    names.insert(name);
                }
                None => panic!(
                    "{}:{}: #[tauri::command] not immediately followed by a `pub fn`/`pub async fn` \
                     signature (found {:?}) — the handler-drift scan in tests/handler_drift.rs \
                     can't see this command",
                    file.display(),
                    j + 1,
                    sig
                ),
            }
        }
    }
    names
}

/// The command names inside the `tauri::generate_handler![...]` block in
/// `lib.rs`. Entries are module-qualified paths (e.g.
/// `modules::orders::commands::orders_list`); only the final `::`-segment is
/// the fn's actual identifier, which is what matters for this comparison.
fn registered_commands() -> BTreeSet<String> {
    let lib_rs_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let lib_rs = std::fs::read_to_string(&lib_rs_path).expect("failed to read src/lib.rs");
    let marker = "tauri::generate_handler![";
    let start = lib_rs
        .find(marker)
        .expect("tauri::generate_handler![ block not found in lib.rs")
        + marker.len();
    let end = lib_rs[start..]
        .find(']')
        .expect("unterminated tauri::generate_handler! block in lib.rs")
        + start;
    lib_rs[start..end]
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.rsplit("::").next().unwrap().to_string())
        .collect()
}

#[test]
fn every_tauri_command_is_registered_in_generate_handler() {
    let declared = declared_commands();
    let registered = registered_commands();

    // Sanity check the scan itself isn't silently finding nothing (a change
    // to the attribute style or file layout that broke the scan would
    // otherwise pass this test vacuously).
    assert!(
        declared.len() > 100,
        "found only {} #[tauri::command] fns — the source scan is probably broken",
        declared.len()
    );

    let missing: Vec<&String> = declared.difference(&registered).collect();
    let extra: Vec<&String> = registered.difference(&declared).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "invoke_handler registration drift:\n  \
         defined as #[tauri::command] but missing from generate_handler!: {missing:?}\n  \
         listed in generate_handler! but no matching #[tauri::command] fn found: {extra:?}"
    );
}
