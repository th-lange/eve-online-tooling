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

#[cfg(target_os = "linux")]
use std::path::Path;
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
/// Proton prefixes always name the prefix user "steamuser"; a plain Wine
/// prefix names it after the real login user instead, so probing `.wine` with
/// "steamuser" can never match. `wine_user` is that login name (None when it
/// can't be determined — then only the Proton spelling is tried).
#[cfg(target_os = "linux")]
fn linux_prefix_candidates(home: &Path, sub: &str, wine_user: Option<&str>) -> Vec<PathBuf> {
    let logs_for = |user: &str| format!("drive_c/users/{user}/Documents/EVE/logs/{sub}");
    let mut out: Vec<PathBuf> = [
        ".local/share/Steam/steamapps/compatdata/8500/pfx",
        ".steam/steam/steamapps/compatdata/8500/pfx",
        ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/compatdata/8500/pfx",
    ]
    .iter()
    .map(|prefix| home.join(prefix).join(logs_for("steamuser")))
    .collect();
    // Plain Wine: the real user first, then "steamuser" for prefixes copied
    // from a Proton install.
    if let Some(user) = wine_user {
        out.push(home.join(".wine").join(logs_for(user)));
    }
    out.push(home.join(".wine").join(logs_for("steamuser")));
    out
}

/// The login name a plain Wine prefix would use for its user directory.
#[cfg(target_os = "linux")]
fn wine_user() -> Option<String> {
    std::env::var("USER").ok().filter(|u| !u.is_empty())
}

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
        candidates.extend(linux_prefix_candidates(home, sub, wine_user().as_deref()));
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

    #[cfg(target_os = "linux")]
    #[test]
    fn wine_prefix_uses_the_login_user_not_steamuser() {
        let home = Path::new("/home/pilot");
        let cands = linux_prefix_candidates(home, "Gamelogs", Some("pilot"));
        let has = |p: &str| cands.iter().any(|c| c == Path::new(p));

        // Proton prefixes keep the "steamuser" spelling …
        assert!(has("/home/pilot/.local/share/Steam/steamapps/compatdata/8500/pfx/drive_c/users/steamuser/Documents/EVE/logs/Gamelogs"));
        // … while a plain Wine prefix is probed under the real login user.
        assert!(has(
            "/home/pilot/.wine/drive_c/users/pilot/Documents/EVE/logs/Gamelogs"
        ));
        // The steamuser spelling is still tried for copied prefixes, but after.
        let real = cands
            .iter()
            .position(|c| c.to_string_lossy().contains("users/pilot"))
            .unwrap();
        let steam = cands
            .iter()
            .rposition(|c| c.to_string_lossy().contains(".wine"))
            .unwrap();
        assert!(real < steam);

        // With no login name, only the Proton spelling is probed under .wine.
        let anon = linux_prefix_candidates(home, "Chatlogs", None);
        assert!(!anon
            .iter()
            .any(|c| c.to_string_lossy().contains("users/pilot")));
    }

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }
}
