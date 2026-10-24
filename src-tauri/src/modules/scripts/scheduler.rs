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
//!
//! The loop parks (no tick, no disk read) while no script is armed — the same
//! lazy-connect pattern the zKill live stream uses for its subscriber lease
//! (#1060) — and wakes when [`SchedulerState::set_armed`] sees the flag flip
//! false -> true, which `scripts_save`/`scripts_delete` call after every
//! mutation (#1103).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::engine::{self, Limits};
use super::host::{Host, HostCtx};
use super::store;
use super::types::{Script, ScriptRun};

/// One minute in the timeline.
const TICK: Duration = Duration::from_secs(60);

/// App-wide managed state driving the lazy scheduler loop (#1103): the loop
/// parks while no script is armed, and wakes when the flag flips false ->
/// true.
#[derive(Default)]
pub struct SchedulerState {
    armed: AtomicBool,
    /// Wakes the parked loop when [`Self::set_armed`] sees a false -> true
    /// transition.
    wake: tokio::sync::Notify,
}

impl SchedulerState {
    /// Record whether any script is armed right now, notifying the parked
    /// loop on a false -> true transition. Call after every mutation to the
    /// stored script set (`scripts_save`/`scripts_delete`).
    pub fn set_armed(&self, armed: bool) {
        let was_armed = self.armed.swap(armed, Ordering::SeqCst);
        if armed && !was_armed {
            self.wake.notify_waiters();
        }
    }
}

/// Whether `script` counts toward the scheduler's armed flag: enabled with a
/// positive minute interval — [`is_due`] additionally requires the interval
/// to land on the current minute, which only matters once the loop is
/// actually running.
pub(crate) fn is_armed(script: &Script) -> bool {
    script.enabled && script.interval_min.is_some_and(|m| m > 0)
}

/// Park until at least one script is armed. The `notified()` future is
/// armed *before* the re-check, so an arm landing between the check and the
/// await can't be missed.
async fn wait_for_armed(state: &SchedulerState) {
    loop {
        if state.armed.load(Ordering::SeqCst) {
            return;
        }
        let notified = state.wake.notified();
        if state.armed.load(Ordering::SeqCst) {
            return;
        }
        notified.await;
    }
}
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
        // Minutes since start. Reset to 0 whenever the loop (re)arms, so the
        // startup-style "runs immediately once armed" semantics hold both at
        // launch and after an idle park.
        let mut minute: u64 = 0;

        // Seed the armed flag from whatever's already on disk at launch —
        // after this, scripts_save/scripts_delete keep it current, so the
        // loop itself never reads disk just to decide whether to park.
        if let (Some(state), Ok(dir)) = (
            app.try_state::<SchedulerState>(),
            crate::storage::app_data_dir(&app),
        ) {
            state.set_armed(store::load(&dir).iter().any(is_armed));
        }

        loop {
            if let Some(state) = app.try_state::<SchedulerState>() {
                if !state.armed.load(Ordering::SeqCst) {
                    wait_for_armed(&state).await;
                    minute = 0;
                }
            }

            ticker.tick().await;
            let Ok(dir) = crate::storage::app_data_dir(&app) else {
                minute = minute.wrapping_add(1);
                continue;
            };

            let scripts = store::load(&dir);
            if let Some(state) = app.try_state::<SchedulerState>() {
                state.set_armed(scripts.iter().any(is_armed));
            }

            for script in scripts {
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

    #[test]
    fn is_armed_matches_enabled_scripts_with_a_positive_interval() {
        assert!(is_armed(&script(true, Some(5))));
        assert!(!is_armed(&script(false, Some(5))));
        assert!(!is_armed(&script(true, None)));
        assert!(!is_armed(&script(true, Some(0))));
    }

    #[tokio::test]
    async fn wait_for_armed_parks_until_set_armed_true() {
        let state = Arc::new(SchedulerState::default());

        // Not armed: the wait must still be pending after a beat.
        let waiter = {
            let state = state.clone();
            tokio::spawn(async move { wait_for_armed(&state).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!waiter.is_finished());

        // Arming wakes the parked loop.
        state.set_armed(true);
        tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("wait_for_armed should return once armed")
            .unwrap();
    }
}
