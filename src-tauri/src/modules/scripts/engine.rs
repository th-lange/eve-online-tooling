//! Engine-agnostic execution: a [`ScriptEngine`] trait, the resource [`Limits`]
//! every run is capped by, and the [`run`] dispatcher that times a run,
//! watches its memory, and collects its logs.
//!
//! Scripts are trusted but not unbounded: every run is bounded so a runaway
//! `while(true)` returns an error instead of freezing the app. Rhai is capped by
//! an operation count plus a wall-clock deadline it checks on progress; the JS
//! engine (`boa`) is capped by a loop-iteration limit and a recursion limit.
//! Heap memory is bounded too, but only by a best-effort watchdog outside
//! either engine — see [`Limits::max_memory_mb`] and issue #815.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::host::Host;
use super::js_engine::JsEngine;
use super::rhai_engine::RhaiEngine;
use super::types::{Language, ScriptRun};

/// Ceilings applied to every run.
///
/// Loop iterations, recursion depth, and wall-clock are enforced *inside* the
/// engine (Rhai checks its op count/deadline on every instruction; `boa`
/// checks its loop/recursion counters on every loop iteration and call) — a
/// script simply cannot cross them. `max_memory_mb` is different: neither
/// engine has a native heap cap (Rhai has none; `boa` 0.21 doesn't expose
/// one), so it's enforced *outside* the engine, by [`run`]'s watchdog thread,
/// which samples process RSS growth since the run started. That makes it a
/// best-effort proxy, not a hard guarantee:
/// - it measures the whole **process's** RSS, not the script's own heap — a
///   faithful enough proxy here because runs execute one at a time on their
///   own dedicated thread, but something else in the process allocating
///   heavily at the same moment could trip it early;
/// - Rhai polls the watchdog's abort flag from the same `on_progress` hook
///   that already enforces the wall-clock timeout, so it aborts promptly,
///   mid-script, the same way a timeout does;
/// - `boa` has no equivalent per-instruction checkpoint to poll, so a JS loop
///   that never calls back into host code (e.g.
///   `let a=[]; for(;;) a.push({})`) can't be preempted mid-flight. The
///   watchdog still keeps the *caller* from waiting forever — it returns a
///   "script exceeded memory limit" error and detaches the runaway thread —
///   but that detached thread's own memory isn't reclaimed until it trips
///   its loop-iteration limit or the process itself runs out of memory. See
///   issue #815.
#[derive(Clone, Copy)]
pub struct Limits {
    /// Wall-clock budget (Rhai aborts on progress past this).
    pub timeout: Duration,
    /// Max Rhai operations before it aborts.
    pub max_ops: u64,
    /// Max JS loop iterations before `boa` throws.
    pub loop_iter_limit: u64,
    /// Max call/recursion depth (both engines).
    pub recursion_limit: usize,
    /// Soft heap cap in MiB, matching the plugin sandbox's Extism cap.
    /// Enforced by a best-effort RSS watchdog, not the engine itself — see
    /// this struct's doc comment for exactly what that does and doesn't
    /// guarantee.
    pub max_memory_mb: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(2),
            max_ops: 5_000_000,
            loop_iter_limit: 5_000_000,
            recursion_limit: 128,
            max_memory_mb: 64,
        }
    }
}

/// Out-of-band abort signal the memory watchdog trips. Cloned into the engine
/// so it can poll [`is_tripped`](Interrupt::is_tripped) from whatever
/// periodic checkpoint it already has (Rhai's `on_progress`); an engine
/// without one (`boa`) can only observe it before `eval` starts.
#[derive(Clone, Default)]
pub struct Interrupt(Arc<AtomicBool>);

impl Interrupt {
    fn trip(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    /// Whether the watchdog has asked the running script to stop.
    pub fn is_tripped(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// One embedded scripting backend.
pub trait ScriptEngine {
    /// Execute `code` under `limits`, returning its JSON result value or a
    /// human-readable error message. Host `log()` output accumulates on
    /// `host`. `interrupt` is tripped by [`run`]'s memory watchdog; an engine
    /// with a periodic checkpoint should poll it there and abort with a
    /// clear message, matching how it already handles a timeout.
    fn execute(
        &self,
        host: &Arc<dyn Host>,
        code: &str,
        limits: &Limits,
        interrupt: &Interrupt,
    ) -> Result<Value, String>;
}

/// How often the watchdog re-samples RSS while a script is running. Coarse
/// enough to be cheap (one `/proc` read per tick), fine enough that the
/// allocation-bomb case from #815 trips within tens of milliseconds.
const WATCHDOG_POLL: Duration = Duration::from_millis(20);

/// After tripping the interrupt, how long to keep waiting for the engine to
/// notice and unwind before giving up on it. Meaningful for Rhai (which will
/// notice); `boa` never will, so this just bounds how long the caller waits.
const WATCHDOG_GRACE: Duration = Duration::from_millis(200);

/// Run a snippet end to end: time it, dispatch to the right engine on a
/// dedicated thread, watch that thread's memory footprint, and fold the
/// outcome plus captured logs into a [`ScriptRun`]. Never panics on script
/// error.
pub fn run(host: Arc<dyn Host>, language: Language, code: &str, limits: &Limits) -> ScriptRun {
    let start = Instant::now();
    let outcome = execute_watched(host.clone(), language, code, limits);
    let duration_ms = start.elapsed().as_millis() as u64;
    let logs = host.take_logs();
    match outcome {
        Ok(result) => ScriptRun {
            ok: true,
            result,
            logs,
            error: None,
            duration_ms,
        },
        Err(error) => ScriptRun {
            ok: false,
            result: Value::Null,
            logs,
            error: Some(error),
            duration_ms,
        },
    }
}

/// Run `code` on a dedicated thread and race it against a memory watchdog on
/// the calling thread. Whichever finishes first wins; on a memory trip the
/// losing worker thread is detached (not joined), so this call never blocks
/// more than [`WATCHDOG_GRACE`] past the point of exceeding
/// `limits.max_memory_mb`.
fn execute_watched(
    host: Arc<dyn Host>,
    language: Language,
    code: &str,
    limits: &Limits,
) -> Result<Value, String> {
    let interrupt = Interrupt::default();
    let (tx, rx) = mpsc::channel();
    let code = code.to_string();
    let worker_limits = *limits;
    let worker_interrupt = interrupt.clone();
    let worker = thread::Builder::new()
        .name("script-eval".into())
        .spawn(move || {
            let result = match language {
                Language::Rhai => {
                    RhaiEngine.execute(&host, &code, &worker_limits, &worker_interrupt)
                }
                Language::Js => JsEngine.execute(&host, &code, &worker_limits, &worker_interrupt),
            };
            // The receiver may already be gone (watchdog gave up on us) — fine.
            let _ = tx.send(result);
        })
        .expect("spawn script-eval thread");

    let baseline_rss = resident_memory_mb();
    let max_growth = limits.max_memory_mb;
    loop {
        match rx.recv_timeout(WATCHDOG_POLL) {
            Ok(result) => {
                let _ = worker.join();
                return result;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("script worker terminated unexpectedly".to_string());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let (Some(baseline), Some(current)) = (baseline_rss, resident_memory_mb()) else {
                    // No RSS sampling on this platform: fall back to the
                    // pre-#815 behavior (time/iteration limits only).
                    continue;
                };
                if current.saturating_sub(baseline) <= max_growth {
                    continue;
                }
                interrupt.trip();
                // Give the engine a short grace window to notice and unwind
                // (Rhai will; `boa` can't — see [`Limits`]'s doc comment).
                if let Ok(result) = rx.recv_timeout(WATCHDOG_GRACE) {
                    let _ = worker.join();
                    return result;
                }
                // Didn't unwind in time (the `boa` case): stop waiting so the
                // caller isn't blocked indefinitely. Dropping the JoinHandle
                // without joining detaches the thread — it keeps running
                // independently and frees its memory once it trips its own
                // loop-iteration limit or errors out on its own.
                drop(worker);
                return Err(format!("script exceeded memory limit ({max_growth} MiB)"));
            }
        }
    }
}

/// Best-effort resident set size of this process, in MiB. `None` when the
/// platform has no supported sampling path — the memory watchdog then never
/// trips and scripts fall back to the pre-#815 time/iteration-only limits.
/// Deliberately avoids a `sysinfo`-style dependency: Linux is the only
/// platform sampled, via `/proc/self/statm` (page size hardcoded to 4 KiB,
/// the value on every architecture this app ships for).
#[cfg(target_os = "linux")]
fn resident_memory_mb() -> Option<u64> {
    const PAGE_SIZE_BYTES: u64 = 4096;
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    // Fields are "size resident shared text lib data dt", all in pages; we
    // want the second one (resident).
    let resident_pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    Some(resident_pages * PAGE_SIZE_BYTES / (1024 * 1024))
}

/// No supported sampling path on this platform — see [`resident_memory_mb`]
/// above for the Linux implementation this stands in for.
#[cfg(not(target_os = "linux"))]
fn resident_memory_mb() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use crate::modules::scripts::examples;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use parking_lot::Mutex;
    use serde_json::json;

    use super::{run, Limits};
    use crate::modules::scripts::host::Host;
    use crate::modules::scripts::types::Language;

    /// An in-memory host with no Tauri/ESI dependencies, so the engines can be
    /// exercised deterministically.
    #[derive(Default)]
    struct FakeHost {
        logs: Mutex<Vec<String>>,
        kv: Mutex<HashMap<String, String>>,
    }

    impl Host for FakeHost {
        fn log(&self, line: String) {
            self.logs.lock().push(line);
        }
        fn take_logs(&self) -> Vec<String> {
            std::mem::take(&mut *self.logs.lock())
        }
        fn notify(&self, _title: &str, _body: &str) -> Result<(), String> {
            Ok(())
        }
        fn market_price(
            &self,
            type_id: i64,
            _region: Option<i64>,
        ) -> Result<serde_json::Value, String> {
            Ok(json!({
                "typeId": type_id,
                "sell": 100.0,
                "sellMin": 100.0,
                "buyMax": 90.0,
                "dailyVolume": 1000,
                "orderCount": 2,
            }))
        }
        fn sde_type_info(&self, _type_id: i64) -> Result<serde_json::Value, String> {
            Ok(json!({ "name": "Tritanium" }))
        }
        fn assets(&self) -> Result<serde_json::Value, String> {
            Ok(json!([]))
        }
        fn corp_assets(&self) -> Result<serde_json::Value, String> {
            Ok(json!([{ "typeId": 34, "quantity": 10 }]))
        }
        fn my_orders(&self) -> Result<serde_json::Value, String> {
            Ok(json!([
                { "name": "Widget", "price": 5.0, "location": "Jita", "undercut": true },
                { "name": "Gadget", "price": 7.0, "location": "Amarr", "undercut": false },
            ]))
        }
        fn kv_get(&self, key: &str) -> Result<String, String> {
            Ok(self.kv.lock().get(key).cloned().unwrap_or_default())
        }
        fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
            self.kv.lock().insert(key.to_string(), value.to_string());
            Ok(())
        }
        fn play_sound(&self, _path: &str) -> Result<(), String> {
            Ok(())
        }
        fn send_alarm(&self, _text: &str, _detail: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn write_message(&self, _text: &str, _detail: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn call(&self, name: &str, args: &serde_json::Value) -> Result<serde_json::Value, String> {
            match name {
                "market_price" => self.market_price(
                    args.get("typeId").and_then(|v| v.as_i64()).unwrap_or(0),
                    None,
                ),
                "appraise" => Ok(json!({
                    "buyTotal": 100.0, "sellTotal": 150.0, "volume": 5.0, "lines": []
                })),
                "route" => Ok(json!({
                    "from": "Jita", "to": "Amarr", "jumps": 5, "reachable": true
                })),
                "sde_search" => Ok(json!({ "results": [{ "typeId": 34, "name": "Tritanium" }] })),
                "pi_overview" => Ok(json!([
                    {
                        "characterId": 1, "characterName": "Test Pilot",
                        "planetId": 40000001, "systemId": 30000001, "systemName": "Jita",
                        "planetType": "Barren", "upgradeLevel": 3, "pinCount": 5,
                        "extractors": [], "storage": [], "balance": [], "produced": [],
                        "needsAttention": true,
                    }
                ])),
                "industry_jobs" => Ok(json!({
                    "jobs": [
                        {
                            "jobId": 1, "activity": "Manufacturing", "product": "Rifter",
                            "runs": 1, "status": "active", "cost": 1000.0,
                            "startDate": "", "endDate": "", "facility": "Jita IV - Moon 4",
                            "owner": "You", "characterId": 2, "characterName": "Second Pilot",
                        }
                    ],
                    "slots": {
                        "manufacturing": { "used": 1, "total": 3 },
                        "science": { "used": 0, "total": 2 },
                        "reactions": { "used": 0, "total": 0 },
                    },
                    "byCharacter": [
                        {
                            "characterId": 1, "characterName": "Test Pilot",
                            "slots": {
                                "manufacturing": { "used": 0, "total": 2 },
                                "science": { "used": 0, "total": 1 },
                                "reactions": { "used": 0, "total": 0 },
                            }
                        },
                        {
                            "characterId": 2, "characterName": "Second Pilot",
                            "slots": {
                                "manufacturing": { "used": 1, "total": 1 },
                                "science": { "used": 0, "total": 1 },
                                "reactions": { "used": 0, "total": 0 },
                            }
                        }
                    ]
                })),
                "pi_idle_colonies" => Ok(json!([
                    {
                        "characterId": 1, "characterName": "Test Pilot",
                        "systemName": "Jita", "planetType": "Barren",
                    }
                ])),
                "industry_line_status" => Ok(json!({
                    "manufacturing": [
                        { "characterId": 1, "characterName": "Test Pilot", "idle": true },
                        { "characterId": 2, "characterName": "Second Pilot", "idle": false }
                    ],
                    "invention": [
                        { "characterId": 1, "characterName": "Test Pilot", "idle": true },
                        { "characterId": 2, "characterName": "Second Pilot", "idle": true }
                    ],
                    "reactions": [
                        { "characterId": 1, "characterName": "Test Pilot", "idle": true },
                        { "characterId": 2, "characterName": "Second Pilot", "idle": true }
                    ]
                })),
                "big_payload" => Ok(json!({
                    // ~400 KB of cumulative string content: comfortably over
                    // Rhai's old 256 KiB max_string_size (real personal
                    // industry_jobs/pi_overview/assets payloads blow that),
                    // comfortably under the new 8 MiB cap.
                    "items": (0..2000)
                        .map(|i| json!({ "name": format!("item-{i}"), "note": "x".repeat(200) }))
                        .collect::<Vec<_>>()
                })),
                other => Ok(json!({ "called": other })),
            }
        }
    }

    fn host() -> Arc<dyn Host> {
        Arc::new(FakeHost::default())
    }

    #[test]
    fn rhai_evaluates_and_returns_its_value() {
        let out = run(host(), Language::Rhai, "40 + 2", &Limits::default());
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(42.0));
    }

    #[test]
    fn js_evaluates_and_returns_its_value() {
        let out = run(host(), Language::Js, "40 + 2", &Limits::default());
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(42.0));
    }

    #[test]
    fn rhai_captures_log_output() {
        let out = run(
            host(),
            Language::Rhai,
            r#"log("hello"); 7"#,
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.logs, vec!["hello".to_string()]);
    }

    #[test]
    fn js_captures_log_output() {
        let out = run(
            host(),
            Language::Js,
            r#"log("hi"); log("there"); 1"#,
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.logs, vec!["hi".to_string(), "there".to_string()]);
    }

    #[test]
    fn rhai_host_binding_reaches_market_price() {
        let out = run(
            host(),
            Language::Rhai,
            "market_price(34).sell",
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(100.0));
    }

    #[test]
    fn js_host_binding_reaches_market_price() {
        let out = run(
            host(),
            Language::Js,
            "market_price(34).sell",
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(100.0));
    }

    #[test]
    fn rhai_kv_roundtrips_through_the_host() {
        let h = host();
        let out = run(
            h,
            Language::Rhai,
            r#"kv_set("k", "v"); kv_get("k")"#,
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_str(), Some("v"));
    }

    #[test]
    fn js_kv_roundtrips_through_the_host() {
        let out = run(
            host(),
            Language::Js,
            r#"kv_set("k", "v"); kv_get("k")"#,
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_str(), Some("v"));
    }

    #[test]
    fn rhai_infinite_loop_is_stopped_by_the_deadline() {
        let limits = Limits {
            timeout: Duration::from_millis(50),
            max_ops: 1_000_000_000,
            ..Limits::default()
        };
        let out = run(host(), Language::Rhai, "while true {}", &limits);
        assert!(!out.ok);
        assert!(out.error.unwrap().contains("timed out"));
    }

    #[test]
    fn rhai_allocation_bomb_is_stopped_by_the_memory_watchdog() {
        // #815: an unbounded loop that allocates every iteration and never
        // calls back into host code — nothing but the memory watchdog can
        // catch this. `max_memory_mb` is measured as *growth* since the run
        // started, so a tiny cap here reliably trips regardless of whatever
        // the test process's baseline RSS already is. Timeout/op-count are
        // set generously so the memory trip — not those — is what fires.
        let limits = Limits {
            max_memory_mb: 1,
            timeout: Duration::from_secs(10),
            max_ops: u64::MAX,
            ..Limits::default()
        };
        let out = run(
            host(),
            Language::Rhai,
            "let a = []; loop { a.push(#{}); }",
            &limits,
        );
        assert!(!out.ok);
        assert!(
            out.error.as_deref().unwrap().contains("memory limit"),
            "expected a memory-limit error, got: {:?}",
            out.error
        );
    }

    // `boa` (JS) has no periodic checkpoint to poll the watchdog's interrupt
    // from (see `Limits`'s and `js_engine`'s doc comments), so the equivalent
    // JS allocation bomb — `let a=[]; for(;;) a.push({})` — can't be
    // preempted mid-loop the way the Rhai case above is, and isn't safe to
    // assert on here: the offending thread would keep running detached in
    // the background for the rest of the test process's life, potentially
    // exhausting real memory in CI. Manual verification recipe: run that
    // snippet via `scripts_run` with a low `max_memory_mb` (e.g. via the
    // Scripts UI or a temporary `Limits::default()` override) and confirm
    // the command returns promptly with a "script exceeded memory limit"
    // error instead of hanging or crashing the app — the watchdog still
    // bounds the caller's wait even though it can't stop the runaway thread.

    #[test]
    fn js_infinite_loop_is_stopped_by_the_iteration_cap() {
        let limits = Limits {
            loop_iter_limit: 1_000,
            ..Limits::default()
        };
        let out = run(
            host(),
            Language::Js,
            "let i = 0; while (true) { i += 1; }",
            &limits,
        );
        assert!(!out.ok);
        assert!(out.error.is_some());
    }

    #[test]
    fn rhai_json_encode_decode_roundtrips() {
        let out = run(
            host(),
            Language::Rhai,
            r#"let s = json_encode(#{ a: 1, b: "x" }); json_decode(s).a"#,
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(1.0));
    }

    #[test]
    fn js_json_encode_decode_roundtrips() {
        let out = run(
            host(),
            Language::Js,
            r#"json_decode(json_encode({ a: 1, b: "x" })).a"#,
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(1.0));
    }

    #[test]
    fn both_engines_expose_now() {
        let rhai = run(host(), Language::Rhai, "now()", &Limits::default());
        assert!(rhai.ok, "error: {:?}", rhai.error);
        assert!(rhai.result.as_f64().unwrap_or(0.0) > 0.0);
        let js = run(host(), Language::Js, "now()", &Limits::default());
        assert!(js.ok, "error: {:?}", js.error);
        assert!(js.result.as_f64().unwrap_or(0.0) > 0.0);
    }

    #[test]
    fn rhai_starter_example_runs_green() {
        let code = "let answer = 6 * 7;\nlog(\"Hello from Rhai! epoch=\" + now());\nanswer";
        let out = run(host(), Language::Rhai, code, &Limits::default());
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(42.0));
    }

    #[test]
    fn js_starter_example_runs_green() {
        let code = "const answer = 6 * 7;\nlog(\"Hello from JS! epoch=\" + now());\nanswer;";
        let out = run(host(), Language::Js, code, &Limits::default());
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(42.0));
    }

    // --- Example-script logic (mirrors the bundled examples' API usage) ---

    #[test]
    fn every_bundled_example_runs_green() {
        // What ships in the editor's Examples section must run without error
        // against the fake host, in its declared language.
        for ex in examples::examples() {
            let out = run(host(), ex.language, &ex.code, &Limits::default());
            assert!(out.ok, "example {:?} failed: {:?}", ex.id, out.error);
        }
    }

    #[test]
    fn outpriced_example_counts_beaten_orders() {
        let out = run(
            host(),
            Language::Rhai,
            examples::OUTPRICED_RHAI,
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(1.0)); // one undercut order in the fake feed
    }

    #[test]
    fn idle_production_example_flags_all_three_conditions() {
        // Fake feed: one PI colony needing attention, two characters where
        // only one (Test Pilot) has an idle manufacturing line, and neither
        // has an active/ready invention job — all three sections should fire.
        let rhai = run(
            host(),
            Language::Rhai,
            examples::IDLE_PRODUCTION_RHAI,
            &Limits::default(),
        );
        assert!(rhai.ok, "error: {:?}", rhai.error);
        assert_eq!(rhai.result.as_f64(), Some(3.0));
        let js = run(
            host(),
            Language::Js,
            examples::IDLE_PRODUCTION_JS,
            &Limits::default(),
        );
        assert!(js.ok, "error: {:?}", js.error);
        assert_eq!(js.result.as_f64(), Some(3.0));
    }

    #[test]
    fn idle_production_manufacturing_check_names_only_the_idle_character() {
        // Second Pilot is busy (idle: false) and Test Pilot isn't — only
        // Test Pilot should count as idle, not both.
        let rhai = run(
            host(),
            Language::Rhai,
            r#"invoke("industry_line_status", #{}).manufacturing.filter(|c| c.idle).len()"#,
            &Limits::default(),
        );
        assert!(rhai.ok, "error: {:?}", rhai.error);
        assert_eq!(rhai.result.as_f64(), Some(1.0));
        let js = run(
            host(),
            Language::Js,
            r#"invoke("industry_line_status", {}).manufacturing.filter((c) => c.idle).length;"#,
            &Limits::default(),
        );
        assert!(js.ok, "error: {:?}", js.error);
        assert_eq!(js.result.as_f64(), Some(1.0));
    }

    #[test]
    fn rhai_accepts_a_capability_result_over_the_old_256kib_string_cap() {
        // Regression pin: a real personal ESI payload (e.g. industry_jobs or
        // pi_overview fanned out over "All characters" with real history) can
        // easily exceed Rhai's old 256 KiB cumulative max_string_size —
        // rhai checks this on the RETURN VALUE of every native host
        // function, not just script-built strings, so `invoke(...)` itself
        // used to fail with "Length of string too large" on ordinary data,
        // not just a runaway script.
        let out = run(
            host(),
            Language::Rhai,
            r#"invoke("big_payload", #{}).items.len()"#,
            &Limits::default(),
        );
        assert!(out.ok, "error: {:?}", out.error);
        assert_eq!(out.result.as_f64(), Some(2000.0));
    }

    #[test]
    fn both_engines_reach_corp_assets() {
        let rhai = run(
            host(),
            Language::Rhai,
            "corp_assets().len()",
            &Limits::default(),
        );
        assert!(rhai.ok, "error: {:?}", rhai.error);
        assert_eq!(rhai.result.as_f64(), Some(1.0));
        let js = run(
            host(),
            Language::Js,
            "corp_assets().length;",
            &Limits::default(),
        );
        assert!(js.ok, "error: {:?}", js.error);
        assert_eq!(js.result.as_f64(), Some(1.0));
    }

    #[test]
    fn both_engines_post_to_the_info_panel() {
        let rhai = run(
            host(),
            Language::Rhai,
            r#"send_alarm("boom", "extra detail"); write_message("hi", #{ n: 3 }); 1"#,
            &Limits::default(),
        );
        assert!(rhai.ok, "error: {:?}", rhai.error);
        let js = run(
            host(),
            Language::Js,
            r#"send_alarm("boom", "extra detail"); write_message("hi", { n: 3 }); 1;"#,
            &Limits::default(),
        );
        assert!(js.ok, "error: {:?}", js.error);
    }

    #[test]
    fn both_engines_reach_the_registry_via_call() {
        let rhai = run(
            host(),
            Language::Rhai,
            r#"invoke("market_price", #{ typeId: 34 }).sell"#,
            &Limits::default(),
        );
        assert!(rhai.ok, "error: {:?}", rhai.error);
        assert_eq!(rhai.result.as_f64(), Some(100.0));
        let js = run(
            host(),
            Language::Js,
            r#"invoke("market_price", { typeId: 34 }).sell;"#,
            &Limits::default(),
        );
        assert!(js.ok, "error: {:?}", js.error);
        assert_eq!(js.result.as_f64(), Some(100.0));
    }
}
