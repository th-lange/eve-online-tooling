//! Startup maintenance for the webview's own on-disk cache (#1114).
//!
//! Benchmarking a real profile found `WebKitCache/` grown to 983 MB — larger
//! than the SDE database itself — with nothing bounding it: `tauri.conf.json`
//! sets no cache policy, and Tauri 2's webview API doesn't expose a disk
//! cache **size cap** on any backend. Checked directly against the crates
//! this app actually links:
//!
//! - **Linux (webkit2gtk 2.0.2, via wry 0.55 / tauri 2.11):**
//!   `WebsiteDataManagerBuilder` only configures cache **directories**
//!   (`disk_cache_directory`, `base_cache_directory`, …) — no byte-limit
//!   setter exists anywhere in the bindings. The library's own eviction is
//!   internal/heuristic with no public knob.
//! - **Windows (WebView2)** / **macOS (WKWebView):** same story — no size
//!   cap surfaced through Tauri's `WebviewWindowBuilder` or per-OS config.
//!
//! What webkit2gtk *does* expose is a native way to **clear** the cache
//! (`webkit_website_data_manager_clear`), reachable through Tauri's own
//! `PlatformWebview::inner()` escape hatch. So instead of racing the
//! filesystem — deleting files out from under a webview process that may
//! still have them open — [`prune_startup`] checks the on-disk size at
//! launch and, if it's past [`WEBKIT_CACHE_CAP_BYTES`], clears it through
//! WebKit's own API. This mirrors the #1102 startup prune (check size/age,
//! clear if over budget) but goes through the native data-store API rather
//! than `std::fs::remove_*`, since this directory (unlike #1102's JSON
//! cache) is entirely webkit-managed with no per-entry metadata we control.
//!
//! **Linux only for now.** Windows' WebView2 (`ICoreWebView2Profile::
//! ClearBrowsingDataAsync`) and macOS' WKWebView (`WKWebsiteDataStore.
//! removeData(ofTypes:modifiedSince:completionHandler:)`) each have their
//! own native clear API, but wiring them needs platform-specific
//! dependencies/FFI (`webview2-com` COM calls, Objective-C messaging) this
//! crate doesn't carry today. Rather than guess at those bindings
//! un-exercised, [`prune_startup`] no-ops on those targets; see #1114 for
//! the follow-up.

use std::path::Path;

/// Clear `WebKitCache/` once its on-disk size passes this. Chosen to keep
/// the webview's cache meaningfully useful (portraits from
/// images.evetech.net, the Vite bundle, ESI responses the webview itself
/// fetches) while staying well under the SDE's own footprint (~463 MB)
/// instead of silently growing past it, as the 983 MB observed in #1114 did.
const WEBKIT_CACHE_CAP_BYTES: u64 = 200 * 1024 * 1024;

/// Startup maintenance: if `<app_data_dir>/WebKitCache` is over
/// [`WEBKIT_CACHE_CAP_BYTES`], clear it through the webview's own
/// `WebsiteDataManager`. No-op if the directory doesn't exist, is under the
/// cap, the main window isn't available, or (see module docs) the target
/// platform doesn't have a wired-up native clear path yet.
///
/// Called off the main thread (from the `setup` closure's maintenance thread),
/// since the size walk below can take seconds over a large cache. The native
/// clear must touch the webview, so it hops back to the main thread; by the
/// time the walk finishes the configured window exists.
pub fn prune_startup(app: &tauri::AppHandle, app_data_dir: &Path) {
    let dir = app_data_dir.join("WebKitCache");
    let Ok(size) = dir_size(&dir) else {
        return;
    };
    if size <= WEBKIT_CACHE_CAP_BYTES {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || clear_native(&handle));
}

/// Recursive on-disk size of `dir`, in bytes. Entries that vanish or whose
/// metadata can't be read mid-walk are skipped rather than erroring; only a
/// failure to read `dir` itself is an error (treated as "0 bytes" by the
/// caller, i.e. nothing to prune).
fn dir_size(dir: &Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d)?.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    Ok(total)
}

#[cfg(target_os = "linux")]
fn clear_native(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // Fire-and-forget: this is best-effort startup maintenance, not
    // something launch needs to block on.
    let _ = window.with_webview(|webview| {
        use webkit2gtk::{WebViewExt, WebsiteDataManagerExtManual, WebsiteDataTypes};
        let wv = webview.inner();
        if let Some(manager) = wv.website_data_manager() {
            manager.clear(
                WebsiteDataTypes::DISK_CACHE | WebsiteDataTypes::MEMORY_CACHE,
                webkit2gtk::glib::TimeSpan::from_seconds(0),
                None::<&webkit2gtk::gio::Cancellable>,
                |_result| {},
            );
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn clear_native(_app: &tauri::AppHandle) {
    // Windows (WebView2) / macOS (WKWebView): no native clear path wired up
    // yet — see the module docs and #1114.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "eve-webview-cache-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dir_size_sums_files_recursively() {
        let dir = test_dir();
        std::fs::write(dir.join("a.bin"), vec![0u8; 100]).unwrap();
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("b.bin"), vec![0u8; 250]).unwrap();

        assert_eq!(dir_size(&dir).unwrap(), 350);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_size_errors_for_a_missing_directory() {
        let dir = test_dir().join("does-not-exist");
        assert!(dir_size(&dir).is_err());
    }
}
