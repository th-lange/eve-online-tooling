//! `plugin://` custom-protocol asset serving (issue #500).
//!
//! Plugin UIs load from a distinct, sandboxed origin so their code can never
//! touch the app document, its `localStorage`, or `invoke` directly. A URL is
//! `plugin://localhost/<id>/<asset>` — the id is the **first path segment**
//! (robust across platforms, where the URL host is rewritten), and the asset is
//! resolved under `app_data_dir/plugins/<id>/`, guarded so it can never escape
//! that plugin's own directory.

use std::path::{Path, PathBuf};

use super::manifest::id_is_safe;

/// Content-Security-Policy served with every plugin asset. It pins the frame to
/// its own scheme and, critically, forbids **all network** (`connect-src
/// 'none'`): a plugin UI reaches foreign data only through the host bridge into
/// its sandboxed WASM (see `net:fetch`), never from the iframe itself.
pub const PLUGIN_FRAME_CSP: &str = "default-src 'none'; \
     script-src 'unsafe-inline' 'unsafe-eval' plugin:; \
     style-src 'unsafe-inline' plugin:; \
     img-src plugin: data: blob:; \
     font-src plugin: data:; \
     media-src plugin: data: blob:; \
     connect-src 'none'; \
     base-uri 'none'; \
     form-action 'none'";

/// Why a `plugin://` request was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum AssetError {
    /// The id segment is missing or not a safe path segment.
    BadId,
    /// The asset path tried to escape the plugin's directory.
    Traversal,
}

/// Resolve a `plugin://` URL path (`/<id>/<asset>`) to a file under
/// `plugins_root`, or reject it. Pure — does not touch the filesystem, so the
/// traversal guard is verified structurally rather than by `canonicalize`.
pub fn resolve_asset(plugins_root: &Path, url_path: &str) -> Result<PathBuf, AssetError> {
    let trimmed = url_path.trim_start_matches('/');
    let mut parts = trimmed.splitn(2, '/');
    let id = parts.next().unwrap_or("");
    if !id_is_safe(id) {
        return Err(AssetError::BadId);
    }
    let asset = parts.next().unwrap_or("");
    // A bare `plugin://localhost/<id>/` serves the entry document.
    let asset = if asset.is_empty() {
        "index.html"
    } else {
        asset
    };
    // Same discipline as the wasm path: no parent hops, no absolute escape, no
    // Windows drive/UNC. The id is already a single safe segment.
    if asset.contains("..") || Path::new(asset).is_absolute() || asset.contains('\\') {
        return Err(AssetError::Traversal);
    }
    Ok(plugins_root.join(id).join(asset))
}

/// Best-effort MIME type from a file extension, for the served asset.
pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html",
        Some("js" | "mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("map") => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_asset_under_plugin_dir() {
        let root = Path::new("/data/plugins");
        assert_eq!(
            resolve_asset(root, "/price-oracle/index.html").unwrap(),
            Path::new("/data/plugins/price-oracle/index.html")
        );
        assert_eq!(
            resolve_asset(root, "/price-oracle/assets/app.js").unwrap(),
            Path::new("/data/plugins/price-oracle/assets/app.js")
        );
    }

    #[test]
    fn bare_id_serves_index() {
        let root = Path::new("/data/plugins");
        assert_eq!(
            resolve_asset(root, "/price-oracle/").unwrap(),
            Path::new("/data/plugins/price-oracle/index.html")
        );
        assert_eq!(
            resolve_asset(root, "/price-oracle").unwrap(),
            Path::new("/data/plugins/price-oracle/index.html")
        );
    }

    #[test]
    fn rejects_parent_traversal() {
        let root = Path::new("/data/plugins");
        assert_eq!(
            resolve_asset(root, "/price-oracle/../other/secret"),
            Err(AssetError::Traversal)
        );
    }

    #[test]
    fn rejects_absolute_and_backslash() {
        let root = Path::new("/data/plugins");
        assert_eq!(
            resolve_asset(root, "/price-oracle//etc/passwd"),
            Err(AssetError::Traversal)
        );
        assert_eq!(
            resolve_asset(root, "/price-oracle/..\\win"),
            Err(AssetError::Traversal)
        );
    }

    #[test]
    fn rejects_bad_id() {
        let root = Path::new("/data/plugins");
        assert_eq!(resolve_asset(root, "/../escape"), Err(AssetError::BadId));
        assert_eq!(resolve_asset(root, "/bad id/x"), Err(AssetError::BadId));
        assert_eq!(resolve_asset(root, "/"), Err(AssetError::BadId));
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type(Path::new("a/index.html")), "text/html");
        assert_eq!(content_type(Path::new("a/app.js")), "text/javascript");
        assert_eq!(content_type(Path::new("a/style.css")), "text/css");
        assert_eq!(content_type(Path::new("a/logic.wasm")), "application/wasm");
        assert_eq!(
            content_type(Path::new("a/x.bin")),
            "application/octet-stream"
        );
    }
}
