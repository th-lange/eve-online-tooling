//! Fight-recording hooks (#1014): when the overlay detects a fight starting
//! or ending, the frontend invokes [`recording_run_hook`] with the command the
//! user configured in Settings (placeholders like `{start}`/`{end}` already
//! substituted). The command is the user's own — same trust level as their
//! shell — and typically toggles an external recorder
//! (`gpu-screen-recorder-save-replay`, an OBS CLI, `ffmpeg`, …).

/// Spawn the configured hook command detached through the platform shell
/// (`sh -c` / `cmd /C`). Returns an error only when the shell itself fails to
/// start — the hook's own exit code is intentionally ignored (a recorder that
/// is already running, say, must not surface as a fight-overlay error). A
/// reaper thread waits on the child so it never lingers as a zombie.
#[tauri::command]
pub fn recording_run_hook(command: String) -> Result<(), String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd").args(["/C", cmd]).spawn();
    #[cfg(not(target_os = "windows"))]
    let spawned = std::process::Command::new("sh").args(["-c", cmd]).spawn();
    let mut child = spawned.map_err(|e| format!("hook failed to start: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_whitespace_commands_are_a_quiet_no_op() {
        assert_eq!(recording_run_hook(String::new()), Ok(()));
        assert_eq!(recording_run_hook("   ".into()), Ok(()));
    }

    #[cfg(unix)]
    #[test]
    fn spawns_a_shell_command_without_waiting_for_it() {
        // `true` exits immediately; the command returns before/regardless.
        assert_eq!(recording_run_hook("true".into()), Ok(()));
        // A failing hook is still a successful spawn — exit codes are the
        // user's business, not an overlay error.
        assert_eq!(recording_run_hook("false".into()), Ok(()));
    }
}
