use std::path::{Path, PathBuf};

fn main() {
    // The Feedback module reads these with `option_env!` at compile time. This
    // build script does two things for them:
    //
    //  1. Re-runs the build when they change. `option_env!` is not tracked as a
    //     dependency on its own, so without this a warm `target` cache (CI
    //     restores one) could reuse an object file compiled before the variable
    //     was set — silently shipping a build with feedback disabled, and no
    //     build error to notice.
    //  2. Lets a local, git-ignored `.env` supply them for `npm run tauri dev`
    //     without prefixing every command. A real environment variable (CI
    //     secrets, or an explicit `VAR=… npm run tauri dev`) always wins, so the
    //     `.env` only fills a gap and never overrides CI.
    //
    // Keep the variable names in step with the constants in
    // `src/modules/feedback/firebase.rs`.
    const VARS: [&str; 2] = [
        "EVE_TOOLING_FIREBASE_PROJECT_ID",
        "EVE_TOOLING_FIREBASE_API_KEY",
    ];

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    // Repo root first (where Vite also looks for a `.env`), then the crate dir.
    let env_files: Vec<PathBuf> = [
        manifest_dir.parent().map(|p| p.join(".env")),
        Some(manifest_dir.join(".env")),
    ]
    .into_iter()
    .flatten()
    .collect();

    // Re-run when a `.env` appears, changes or is removed.
    for file in &env_files {
        println!("cargo:rerun-if-changed={}", file.display());
    }

    for var in VARS {
        println!("cargo:rerun-if-env-changed={var}");
        // An ambient variable (CI secrets, explicit prefix) always wins; only
        // reach for the `.env` when it is absent.
        if std::env::var_os(var).is_some() {
            continue;
        }
        for file in &env_files {
            if let Some(value) = read_dotenv_var(file, var) {
                println!("cargo:rustc-env={var}={value}");
                break;
            }
        }
    }

    tauri_build::build()
}

/// Minimal `.env` reader: `KEY=VALUE` lines, `#` comments, an optional `export`
/// prefix and optional surrounding quotes. Zero dependencies — the file only
/// ever holds a couple of keys.
fn read_dotenv_var(path: &Path, key: &str) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        return Some(value.to_string());
    }
    None
}
