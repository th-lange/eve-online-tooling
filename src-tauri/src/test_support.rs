//! Shared harness for the SDE-gated tests (golden suite and friends).
//!
//! Those tests need the real Fuzzwork SDE. Point `EVE_SDE_PATH` at the
//! `sde.sqlite` **file** (e.g.
//! `~/.local/share/com.thlange.eve-online-tooling/sde/sde.sqlite`); when it's
//! unset the tests skip (print a note and pass), so a plain `cargo test` works
//! without an SDE. When it is set but the file is missing the test fails
//! loudly rather than silently skipping.
//!
//! The engine opens `<app_data_dir>/sde/sde.sqlite` ([`SdePaths::new`]), so the
//! tests that call `simulate_fit`/`run_dogma` need that *directory*, not the
//! file's parent. [`test_sde`] derives it.

use crate::sde::Sde;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The SDE file named by `EVE_SDE_PATH`, or `None` (skip) when unset.
/// Panics when the variable is set but the file doesn't exist.
pub fn sde_file() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os("EVE_SDE_PATH")?);
    assert!(
        path.is_file(),
        "EVE_SDE_PATH={path:?} is not a file (point it at the sde.sqlite file)"
    );
    Some(path)
}

/// App-data dir the engine expects for `file`, i.e. a dir `d` such that
/// `d/sde/sde.sqlite` is `file`. The real install layout already satisfies it
/// (`<app_data>/sde/sde.sqlite`); any other location gets a temp dir holding a
/// symlink.
fn app_dir_for(file: &Path) -> PathBuf {
    let file = file.canonicalize().expect("canonicalize EVE_SDE_PATH");
    if file.file_name().is_some_and(|n| n == "sde.sqlite")
        && file
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == "sde")
    {
        return file.parent().and_then(Path::parent).unwrap().to_path_buf();
    }
    static LINKED: OnceLock<PathBuf> = OnceLock::new();
    LINKED
        .get_or_init(|| {
            let dir = std::env::temp_dir().join(format!("eve-sde-test-{}", std::process::id()));
            std::fs::create_dir_all(dir.join("sde")).expect("create sde test dir");
            let link = dir.join("sde").join("sde.sqlite");
            let _ = std::fs::remove_file(&link);
            #[cfg(unix)]
            std::os::unix::fs::symlink(&file, &link).expect("symlink sde");
            #[cfg(not(unix))]
            std::fs::copy(&file, &link).expect("copy sde");
            dir
        })
        .clone()
}

/// Open the real SDE for a test: `(sde, app_data_dir)`, or `None` to skip.
pub fn test_sde() -> Option<(Sde, PathBuf)> {
    let file = sde_file()?;
    let dir = app_dir_for(&file);
    let sde = Sde::open(&file).expect("open sde");
    Some((sde, dir))
}
