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
/// `"gamelogs"`. Always returns a path to start from — an existing folder if we
/// can find one, otherwise the most likely default for this OS (which the user
/// can edit).
///
/// Windows/macOS keep logs under `Documents/EVE/logs/<Sub>`. On Linux the EVE
/// client runs under Wine/Proton, so the logs live deep inside a prefix that
/// varies by installer — we probe the common Steam/Lutris/Wine prefixes, prefer
/// any that exists, and fall back to the default Steam-Proton location.
#[tauri::command]
pub fn eve_default_log_dir(app: AppHandle, kind: String) -> Option<String> {
    let sub = if kind == "chatlogs" {
        "Chatlogs"
    } else {
        "Gamelogs"
    };
    let path = app.path();

    // Probe order: existing dirs win. Documents-based first (native Win/macOS).
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(docs) = path.document_dir() {
        candidates.push(docs.join("EVE").join("logs").join(sub));
    }
    let home = path.home_dir().ok();
    if let Some(home) = &home {
        candidates.push(home.join("Documents").join("EVE").join("logs").join(sub));
        // Linux Wine/Proton prefixes (EVE's Steam app id is 8500). The first is
        // the default Steam-Proton location, used as the fallback below.
        #[cfg(target_os = "linux")]
        {
            let inner = format!("drive_c/users/steamuser/Documents/EVE/logs/{sub}");
            for prefix in [
                ".local/share/Steam/steamapps/compatdata/8500/pfx",
                ".steam/steam/steamapps/compatdata/8500/pfx",
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
    // Nothing detected — still hand back a sensible default to edit from. On
    // Windows/macOS that's the Documents path; on Linux the default Steam-Proton
    // location (the first Linux candidate appended above).
    #[cfg(target_os = "linux")]
    if let Some(home) = &home {
        let def = home
            .join(".local/share/Steam/steamapps/compatdata/8500/pfx/drive_c/users/steamuser/Documents/EVE/logs")
            .join(sub);
        return Some(def.to_string_lossy().into_owned());
    }
    candidates.first().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }
}
