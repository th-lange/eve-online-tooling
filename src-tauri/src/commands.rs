//! Thin command layer wiring the frontend (`invoke()`) to core services.
//!
//! Feature-specific commands live in their own module under `modules/` and are
//! re-exported here as the surface grows; for now this holds only the
//! bridge health-check.

/// Health-check used by the frontend to verify the Rust bridge is live.
#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Best-guess default folder for an EVE log type, to prefill the log-folder
/// inputs (Local Intel chatlogs, DPS-meter gamelogs). `kind` is `"chatlogs"` or
/// `"gamelogs"`.
///
/// Windows/macOS keep logs under `Documents/EVE/logs/<Sub>`, so we return that
/// even if it doesn't exist yet (it's the canonical spot). On Linux the EVE
/// client runs under Wine/Proton, so the logs live deep inside a prefix that
/// varies by installer — we probe the common Steam/Lutris/Wine prefixes and
/// return the first that actually exists, or `None` if we can't find one.
#[tauri::command]
pub fn eve_default_log_dir(app: AppHandle, kind: String) -> Option<String> {
    let sub = if kind == "chatlogs" { "Chatlogs" } else { "Gamelogs" };
    let path = app.path();

    // Probe order: existing dirs win. Documents-based first (native Win/macOS).
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(docs) = path.document_dir() {
        candidates.push(docs.join("EVE").join("logs").join(sub));
    }
    let home = path.home_dir().ok();
    if let Some(home) = &home {
        candidates.push(home.join("Documents").join("EVE").join("logs").join(sub));
        // Linux Wine/Proton prefixes (EVE's Steam app id is 8500).
        #[cfg(target_os = "linux")]
        {
            let inner = format!("drive_c/users/steamuser/Documents/EVE/logs/{sub}");
            for prefix in [
                ".steam/steam/steamapps/compatdata/8500/pfx",
                ".local/share/Steam/steamapps/compatdata/8500/pfx",
                ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/compatdata/8500/pfx",
                ".wine",
            ] {
                candidates.push(home.join(prefix).join(&inner));
            }
        }
    }

    if let Some(existing) = candidates.iter().find(|p| p.is_dir()) {
        return Some(existing.to_string_lossy().into_owned());
    }
    // No folder found. On Windows/macOS the Documents path is still the right
    // hint; on Linux it's too installer-specific to guess, so prefill nothing.
    if cfg!(target_os = "linux") {
        None
    } else {
        candidates.first().map(|p| p.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }
}
