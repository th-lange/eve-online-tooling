//! The script loop — a single background timeline (not per-script, not in the
//! script language, not in the frontend). One tokio task ticks once a minute
//! and re-runs every script in the **Run** state (`enabled` with an
//! `interval_min`) whose interval lands on the current minute. Multiple scripts
//! share this one timeline, so scripts with the same interval fire together.
//!
//! State is read from storage each tick, so arming/disarming a script (a save)
//! takes effect on the next minute with no scheduler restart. Each run executes
//! on a blocking thread (the host API blocks on async services) and emits a
//! `scripts://run` event with its outcome; a run still in flight is skipped
//! rather than overlapped.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::engine::{self, Limits};
use super::host::{Host, HostCtx};
use super::store;
use super::types::{Script, ScriptRun};

/// One minute in the timeline.
const TICK: Duration = Duration::from_secs(60);

/// Emitted after each scheduled run so the UI can show last-run status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunEvent {
    id: String,
    run: ScriptRun,
}

/// Whether a script should run at `minute` on the shared timeline: it's armed
/// (Run state) and its minute-interval divides the elapsed minute. Pure.
fn is_due(script: &Script, minute: u64) -> bool {
    script.enabled
        && script
            .interval_min
            .is_some_and(|m| m > 0 && minute.is_multiple_of(m))
}

/// Start the background loop for the app's lifetime. Idempotent per app —
/// call once at setup.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Scripts already executing, so a slow run isn't overlapped by the next tick.
        let in_flight: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let mut ticker = tokio::time::interval(TICK);
        // Minutes since start. `interval`'s first tick is immediate, so minute 0
        // runs every armed script once at startup, then every `interval_min`.
        let mut minute: u64 = 0;

        loop {
            ticker.tick().await;
            let Ok(dir) = crate::storage::app_data_dir(&app) else {
                minute = minute.wrapping_add(1);
                continue;
            };

            for script in store::load(&dir) {
                if !is_due(&script, minute) {
                    continue;
                }
                // Skip if a previous run of this script is still going.
                if !in_flight.lock().insert(script.id.clone()) {
                    continue;
                }
                let app = app.clone();
                let dir = dir.clone();
                let in_flight = in_flight.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let host: Arc<dyn Host> =
                        Arc::new(HostCtx::new(app.clone(), dir, script.id.clone()));
                    let run = engine::run(host, script.language, &script.code, &Limits::default());
                    let _ = app.emit(
                        "scripts://run",
                        RunEvent {
                            id: script.id.clone(),
                            run,
                        },
                    );
                    in_flight.lock().remove(&script.id);
                });
            }
            minute = minute.wrapping_add(1);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::scripts::types::Language;

    fn script(enabled: bool, interval_min: Option<u64>) -> Script {
        Script {
            id: "s".into(),
            name: "s".into(),
            language: Language::Rhai,
            code: String::new(),
            interval_min,
            enabled,
            updated_at: 0,
        }
    }

    #[test]
    fn due_only_when_armed_and_the_interval_lands() {
        let every_5 = script(true, Some(5));
        assert!(is_due(&every_5, 0)); // immediate at startup
        assert!(is_due(&every_5, 5));
        assert!(is_due(&every_5, 10));
        assert!(!is_due(&every_5, 1));
        assert!(!is_due(&every_5, 7));

        // Disarmed, no interval, or zero interval never runs.
        assert!(!is_due(&script(false, Some(5)), 5));
        assert!(!is_due(&script(true, None), 0));
        assert!(!is_due(&script(true, Some(0)), 0));
    }

    #[test]
    fn scripts_sharing_an_interval_are_due_together() {
        let a = script(true, Some(3));
        let b = script(true, Some(3));
        assert_eq!(is_due(&a, 6), is_due(&b, 6));
        assert!(is_due(&a, 6) && is_due(&b, 6));
    }
}
