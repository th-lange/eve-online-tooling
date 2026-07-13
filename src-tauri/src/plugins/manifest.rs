//! The `plugin.json` manifest: the declaration a third-party plugin ships so
//! the host knows what it is, what it runs, and what it wants access to.
//!
//! This module only *parses and validates* a manifest — no execution, no
//! capability enforcement (those are separate tickets). Validation is strict:
//! an untrusted author's manifest is rejected outright on any malformed field
//! rather than silently coerced, so a bad plugin never reaches the runtime.

use serde::{Deserialize, Serialize};

/// A capability a plugin may request. Serialized as the wire string an author
/// writes in `plugin.json` (e.g. `"market:read"`); serde rejects any unknown
/// string, which is exactly how "reject unknown permission strings" is
/// enforced — the deserialize fails before validation even runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Permission {
    /// Read market prices via the capability broker.
    #[serde(rename = "market:read")]
    MarketRead,
    /// Read Static Data Export (types, blueprints, materials).
    #[serde(rename = "sde:read")]
    SdeRead,
    /// Read the user's assets.
    #[serde(rename = "assets:read")]
    AssetsRead,
    /// Read/write the plugin's *own* isolated storage namespace.
    #[serde(rename = "storage:own")]
    StorageOwn,
    /// Make outbound HTTP requests, but only to the manifest's `allowedHosts`.
    #[serde(rename = "net:fetch")]
    NetFetch,
}

/// One MCP tool a plugin declares it backs. The host advertises it (namespaced
/// as `<pluginId>.<name>`) while the plugin is active, and routes a call to the
/// plugin's exported `function` via the normal sandboxed plugin path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDef {
    /// Tool name (namespaced by the host); `[A-Za-z0-9_-]`.
    pub name: String,
    /// Human-readable description shown to the agent.
    #[serde(default)]
    pub description: String,
    /// JSON-Schema for the tool's arguments (opaque, advertised as-is).
    #[serde(default)]
    pub input_schema: serde_json::Value,
    /// The plugin's exported WASM function that implements this tool.
    pub function: String,
}

/// A parsed, validated `plugin.json`. Construct only via
/// [`Manifest::parse_and_validate`] — the fields are public for read-out but a
/// value only exists once every invariant below holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Stable plugin id. Must equal the containing directory name and be safe
    /// to use as a path segment (alphanumeric, `-`, `_`).
    pub id: String,
    /// Human-readable name.
    pub name: String,
    /// Plugin version (semver).
    pub version: String,
    /// Minimum host app version this plugin supports (semver).
    pub min_app_version: String,
    /// Relative path to the WASM logic entry point, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wasm: Option<String>,
    /// Relative path to the UI HTML entry point, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<String>,
    /// Capabilities the plugin requests. Empty = a pure, powerless plugin.
    #[serde(default)]
    pub permissions: Vec<Permission>,
    /// MCP tools this plugin backs (empty = none). Each needs a `wasm` entry.
    #[serde(default)]
    pub mcp_tools: Vec<McpToolDef>,
    /// Hosts the plugin may contact when `net:fetch` is granted (bare
    /// hostnames, no scheme/path). Empty unless `net:fetch` is requested.
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
}

/// Why a manifest was rejected. Each variant maps to a distinct validation
/// failure so callers (and tests) can distinguish them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    /// Malformed JSON, wrong types, or an unknown permission string.
    Json(String),
    /// `id` is empty or contains characters unsafe in a path segment.
    InvalidId(String),
    /// `version` is not valid semver.
    BadVersion(String),
    /// `minAppVersion` is not valid semver.
    BadMinAppVersion(String),
    /// Neither a `wasm` nor a `ui` entry point was declared.
    NoEntryPoint,
    /// The manifest `id` does not match the directory it was loaded from.
    IdMismatch { manifest: String, dir: String },
    /// An `mcpTools` entry is malformed (bad name, empty function, or declared
    /// without a `wasm` entry point to back it).
    BadMcpTool(String),
    /// `net:fetch` / `allowedHosts` are inconsistent or a host is malformed.
    BadNetFetch(String),
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::Json(e) => write!(f, "invalid plugin.json: {e}"),
            ManifestError::InvalidId(id) => {
                write!(f, "invalid plugin id {id:?}: use only [A-Za-z0-9_-]")
            }
            ManifestError::BadVersion(v) => write!(f, "invalid version {v:?}: not semver"),
            ManifestError::BadMinAppVersion(v) => {
                write!(f, "invalid minAppVersion {v:?}: not semver")
            }
            ManifestError::NoEntryPoint => {
                write!(f, "plugin declares neither a wasm nor a ui entry point")
            }
            ManifestError::IdMismatch { manifest, dir } => {
                write!(f, "manifest id {manifest:?} != plugin dir {dir:?}")
            }
            ManifestError::BadMcpTool(msg) => write!(f, "invalid mcpTools entry: {msg}"),
            ManifestError::BadNetFetch(msg) => write!(f, "invalid net:fetch config: {msg}"),
        }
    }
}

impl std::error::Error for ManifestError {}

/// A plugin id is safe iff it's non-empty and every char is alphanumeric, `-`
/// or `_` — the same shape the storage layer allows in a path segment, so an
/// id can never escape `plugins/<id>/`.
pub(crate) fn id_is_safe(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Manifest {
    /// Parse `raw` (`plugin.json` bytes as text) and validate every invariant,
    /// checking the declared `id` against `dir_id` (the directory it lives in).
    /// Returns the manifest only if it is well-formed and internally consistent.
    pub fn parse_and_validate(raw: &str, dir_id: &str) -> Result<Manifest, ManifestError> {
        let manifest: Manifest =
            serde_json::from_str(raw).map_err(|e| ManifestError::Json(e.to_string()))?;

        if !id_is_safe(&manifest.id) {
            return Err(ManifestError::InvalidId(manifest.id));
        }
        if manifest.id != dir_id {
            return Err(ManifestError::IdMismatch {
                manifest: manifest.id,
                dir: dir_id.to_string(),
            });
        }
        if semver::Version::parse(&manifest.version).is_err() {
            return Err(ManifestError::BadVersion(manifest.version));
        }
        if semver::Version::parse(&manifest.min_app_version).is_err() {
            return Err(ManifestError::BadMinAppVersion(manifest.min_app_version));
        }
        if manifest.wasm.is_none() && manifest.ui.is_none() {
            return Err(ManifestError::NoEntryPoint);
        }
        for tool in &manifest.mcp_tools {
            if !id_is_safe(&tool.name) {
                return Err(ManifestError::BadMcpTool(format!(
                    "tool name {:?}: use only [A-Za-z0-9_-]",
                    tool.name
                )));
            }
            if tool.function.trim().is_empty() {
                return Err(ManifestError::BadMcpTool(format!(
                    "tool {:?} has no backing function",
                    tool.name
                )));
            }
            if manifest.wasm.is_none() {
                return Err(ManifestError::BadMcpTool(format!(
                    "tool {:?} needs a wasm entry point",
                    tool.name
                )));
            }
        }
        let wants_net = manifest.permissions.contains(&Permission::NetFetch);
        if wants_net && manifest.allowed_hosts.is_empty() {
            return Err(ManifestError::BadNetFetch(
                "net:fetch granted but allowedHosts is empty".to_string(),
            ));
        }
        if !manifest.allowed_hosts.is_empty() && !wants_net {
            return Err(ManifestError::BadNetFetch(
                "allowedHosts set without requesting net:fetch".to_string(),
            ));
        }
        for host in &manifest.allowed_hosts {
            let bad = host.is_empty()
                || host.contains("://")
                || host.contains('/')
                || host.chars().any(char::is_whitespace);
            if bad {
                return Err(ManifestError::BadNetFetch(format!(
                    "host {host:?} must be a bare hostname (no scheme, path, or spaces)"
                )));
            }
        }
        Ok(manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_json() -> String {
        r#"{
            "id": "price-oracle",
            "name": "Price Oracle",
            "version": "1.2.0",
            "minAppVersion": "0.33.0",
            "wasm": "logic.wasm",
            "permissions": ["market:read", "sde:read"]
        }"#
        .to_string()
    }

    #[test]
    fn parses_and_validates_a_good_manifest() {
        let m = Manifest::parse_and_validate(&valid_json(), "price-oracle").unwrap();
        assert_eq!(m.id, "price-oracle");
        assert_eq!(m.version, "1.2.0");
        assert_eq!(m.wasm.as_deref(), Some("logic.wasm"));
        assert_eq!(m.ui, None);
        assert_eq!(
            m.permissions,
            vec![Permission::MarketRead, Permission::SdeRead]
        );
    }

    #[test]
    fn ui_only_plugin_with_no_permissions_is_valid() {
        let json = r#"{
            "id": "notes",
            "name": "Notes",
            "version": "0.1.0",
            "minAppVersion": "0.33.0",
            "ui": "index.html"
        }"#;
        let m = Manifest::parse_and_validate(json, "notes").unwrap();
        assert_eq!(m.ui.as_deref(), Some("index.html"));
        assert!(m.permissions.is_empty());
    }

    #[test]
    fn rejects_malformed_json() {
        let err = Manifest::parse_and_validate("{ not json", "x").unwrap_err();
        assert!(matches!(err, ManifestError::Json(_)));
    }

    #[test]
    fn rejects_unknown_permission() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0",
            "wasm": "a.wasm", "permissions": ["market:write"]
        }"#;
        let err = Manifest::parse_and_validate(json, "x").unwrap_err();
        assert!(matches!(err, ManifestError::Json(_)));
    }

    #[test]
    fn rejects_bad_version() {
        let json = r#"{
            "id": "x", "name": "X", "version": "not-semver", "minAppVersion": "0.33.0",
            "wasm": "a.wasm"
        }"#;
        let err = Manifest::parse_and_validate(json, "x").unwrap_err();
        assert_eq!(err, ManifestError::BadVersion("not-semver".into()));
    }

    #[test]
    fn rejects_bad_min_app_version() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.x",
            "wasm": "a.wasm"
        }"#;
        let err = Manifest::parse_and_validate(json, "x").unwrap_err();
        assert_eq!(err, ManifestError::BadMinAppVersion("0.x".into()));
    }

    #[test]
    fn rejects_invalid_id() {
        let json = r#"{
            "id": "../evil", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0",
            "wasm": "a.wasm"
        }"#;
        let err = Manifest::parse_and_validate(json, "../evil").unwrap_err();
        assert!(matches!(err, ManifestError::InvalidId(_)));
    }

    #[test]
    fn rejects_id_dir_mismatch() {
        let err = Manifest::parse_and_validate(&valid_json(), "other-dir").unwrap_err();
        assert_eq!(
            err,
            ManifestError::IdMismatch {
                manifest: "price-oracle".into(),
                dir: "other-dir".into(),
            }
        );
    }

    #[test]
    fn rejects_no_entry_point() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0"
        }"#;
        let err = Manifest::parse_and_validate(json, "x").unwrap_err();
        assert_eq!(err, ManifestError::NoEntryPoint);
    }

    #[test]
    fn parses_mcp_tools() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0",
            "wasm": "a.wasm",
            "mcpTools": [
                { "name": "price_vector", "description": "d",
                  "inputSchema": {"type":"object"}, "function": "run_price" }
            ]
        }"#;
        let m = Manifest::parse_and_validate(json, "x").unwrap();
        assert_eq!(m.mcp_tools.len(), 1);
        assert_eq!(m.mcp_tools[0].name, "price_vector");
        assert_eq!(m.mcp_tools[0].function, "run_price");
    }

    #[test]
    fn rejects_mcp_tool_without_wasm() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0",
            "ui": "index.html",
            "mcpTools": [{ "name": "t", "function": "f" }]
        }"#;
        let err = Manifest::parse_and_validate(json, "x").unwrap_err();
        assert!(matches!(err, ManifestError::BadMcpTool(_)));
    }

    #[test]
    fn rejects_mcp_tool_with_empty_function() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0",
            "wasm": "a.wasm",
            "mcpTools": [{ "name": "t", "function": "" }]
        }"#;
        let err = Manifest::parse_and_validate(json, "x").unwrap_err();
        assert!(matches!(err, ManifestError::BadMcpTool(_)));
    }

    #[test]
    fn parses_net_fetch_with_allowed_hosts() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0",
            "wasm": "a.wasm", "permissions": ["net:fetch"],
            "allowedHosts": ["api.example.com", "zkillboard.com"]
        }"#;
        let m = Manifest::parse_and_validate(json, "x").unwrap();
        assert!(m.permissions.contains(&Permission::NetFetch));
        assert_eq!(m.allowed_hosts, vec!["api.example.com", "zkillboard.com"]);
    }

    #[test]
    fn rejects_net_fetch_without_hosts() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0",
            "wasm": "a.wasm", "permissions": ["net:fetch"]
        }"#;
        assert!(matches!(
            Manifest::parse_and_validate(json, "x").unwrap_err(),
            ManifestError::BadNetFetch(_)
        ));
    }

    #[test]
    fn rejects_hosts_without_net_fetch() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0",
            "wasm": "a.wasm", "allowedHosts": ["api.example.com"]
        }"#;
        assert!(matches!(
            Manifest::parse_and_validate(json, "x").unwrap_err(),
            ManifestError::BadNetFetch(_)
        ));
    }

    #[test]
    fn rejects_host_with_scheme_or_path() {
        let json = r#"{
            "id": "x", "name": "X", "version": "1.0.0", "minAppVersion": "0.33.0",
            "wasm": "a.wasm", "permissions": ["net:fetch"],
            "allowedHosts": ["https://api.example.com/v2"]
        }"#;
        assert!(matches!(
            Manifest::parse_and_validate(json, "x").unwrap_err(),
            ManifestError::BadNetFetch(_)
        ));
    }
}
