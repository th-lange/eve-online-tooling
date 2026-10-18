//! Fight-recording hooks (#1014): when the overlay detects a fight starting
//! or ending, the frontend invokes [`recording_run_hook`] with the command the
//! user configured in Settings (placeholders like `{start}`/`{end}` already
//! substituted). The command is the user's own — same trust level as their
//! shell — and typically toggles an external recorder
//! (`gpu-screen-recorder-save-replay`, an OBS CLI, `ffmpeg`, …).

use std::process::Child;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{RecvTimeoutError, Sender};
use std::sync::{Arc, LazyLock};

/// One shared reaper for every hook child (#1065). Hooks used to detach one
/// OS thread per invocation blocked in `child.wait()` — a hanging user hook
/// (a recorder that never exits, a command stuck on stdin) parked a ~2 MiB
/// thread stack forever, one more per fight. Now a single lazily-started
/// thread owns all live children and polls `try_wait` once a second while
/// any exist (it parks indefinitely on the channel when none do), so quick
/// hooks are reaped within ~1s and a hanging hook costs one `Child` entry,
/// not a thread.
struct HookReaper {
    tx: Sender<Child>,
    /// Children handed over and not yet reaped — test observability.
    pending: Arc<AtomicUsize>,
}

static HOOK_REAPER: LazyLock<HookReaper> = LazyLock::new(|| {
    let (tx, rx) = std::sync::mpsc::channel::<Child>();
    let pending = Arc::new(AtomicUsize::new(0));
    let reaped = pending.clone();
    std::thread::spawn(move || {
        let mut children: Vec<Child> = Vec::new();
        loop {
            // Park on the channel while idle; wake once a second to reap
            // while any child is still running.
            let received = if children.is_empty() {
                rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
            } else {
                rx.recv_timeout(std::time::Duration::from_secs(1))
            };
            match received {
                Ok(child) => children.push(child),
                Err(RecvTimeoutError::Timeout) => {}
                // Sender is a static — only dropped at process exit.
                Err(RecvTimeoutError::Disconnected) => return,
            }
            children.retain_mut(|c| match c.try_wait() {
                // Exited (or unwaitable) → reaped, drop the handle.
                Ok(Some(_)) | Err(_) => {
                    reaped.fetch_sub(1, Ordering::SeqCst);
                    false
                }
                Ok(None) => true,
            });
        }
    });
    HookReaper { tx, pending }
});

/// Spawn the configured hook command detached through the platform shell
/// (`sh -c` / `cmd /C`). Returns an error only when the shell itself fails to
/// start — the hook's own exit code is intentionally ignored (a recorder that
/// is already running, say, must not surface as a fight-overlay error). The
/// shared [`HOOK_REAPER`] waits on the child so it never lingers as a zombie.
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
    let child = spawned.map_err(|e| format!("hook failed to start: {e}"))?;
    HOOK_REAPER.pending.fetch_add(1, Ordering::SeqCst);
    if let Err(returned) = HOOK_REAPER.tx.send(child) {
        // Unreachable in practice (the reaper outlives the process), but a
        // child must never be silently leaked: fall back to a direct wait.
        HOOK_REAPER.pending.fetch_sub(1, Ordering::SeqCst);
        let mut child = returned.0;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

/// Write the fight's metadata next to a finished clip (#1016):
/// `<clip>.fight.json`. `meta` is whatever the overlay knows about the fight
/// (span, totals, attackers) — stored as-is, pretty-printed, so external
/// tooling and the future chart→video deep links share one format.
#[tauri::command]
pub fn recording_write_sidecar(
    clip_path: String,
    meta: serde_json::Value,
) -> Result<String, String> {
    let clip = std::path::Path::new(&clip_path);
    if !clip.is_absolute() {
        return Err(format!("clip path is not absolute: {clip_path}"));
    }
    let sidecar = format!("{clip_path}.fight.json");
    let body = serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(&sidecar, body).map_err(|e| format!("{sidecar}: {e}"))?;
    Ok(sidecar)
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

    #[cfg(unix)]
    #[test]
    fn the_shared_reaper_reaps_children_without_a_thread_per_hook() {
        // Two quick hooks: both children must be handed to the reaper and
        // reaped (pending back to zero) within its 1s polling cadence.
        assert_eq!(recording_run_hook("true".into()), Ok(()));
        assert_eq!(recording_run_hook("true".into()), Ok(()));
        for _ in 0..50 {
            if HOOK_REAPER.pending.load(Ordering::SeqCst) == 0 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("hook children were not reaped within 5s");
    }

    #[test]
    fn writes_the_sidecar_next_to_the_clip_and_rejects_relative_paths() {
        let dir = std::env::temp_dir().join(format!("sidecar-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("fight.mkv");
        let meta = serde_json::json!({ "start": 1000, "end": 1065 });

        let sidecar = recording_write_sidecar(clip.to_string_lossy().into(), meta.clone()).unwrap();
        assert_eq!(sidecar, format!("{}.fight.json", clip.to_string_lossy()));
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        assert_eq!(written, meta);

        assert!(recording_write_sidecar("relative/clip.mkv".into(), meta).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
