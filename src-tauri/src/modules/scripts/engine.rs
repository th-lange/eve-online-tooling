//! Engine-agnostic execution: a [`ScriptEngine`] trait, the resource [`Limits`]
//! every run is capped by, and the [`run`] dispatcher that times a run and
//! collects its logs.
//!
//! Scripts are trusted but not unbounded: every run is bounded so a runaway
//! `while(true)` returns an error instead of freezing the app. Rhai is capped by
//! an operation count plus a wall-clock deadline it checks on progress; the JS
//! engine (`boa`) is capped by a loop-iteration limit and a recursion limit.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::host::Host;
use super::js_engine::JsEngine;
use super::rhai_engine::RhaiEngine;
use super::types::{Language, ScriptRun};

/// Ceilings applied to every run.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Wall-clock budget (Rhai aborts on progress past this).
    pub timeout: Duration,
    /// Max Rhai operations before it aborts.
    pub max_ops: u64,
    /// Max JS loop iterations before `boa` throws.
    pub loop_iter_limit: u64,
    /// Max call/recursion depth (both engines).
    pub recursion_limit: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(2),
            max_ops: 5_000_000,
            loop_iter_limit: 5_000_000,
            recursion_limit: 128,
        }
    }
}

/// One embedded scripting backend.
pub trait ScriptEngine {
    /// Execute `code` under `limits`, returning its JSON result value or a
    /// human-readable error message. Host `log()` output accumulates on `host`.
    fn execute(&self, host: &Arc<dyn Host>, code: &str, limits: &Limits) -> Result<Value, String>;
}

/// Run a snippet end to end: time it, dispatch to the right engine, and fold the
/// outcome plus captured logs into a [`ScriptRun`]. Never panics on script error.
pub fn run(host: Arc<dyn Host>, language: Language, code: &str, limits: &Limits) -> ScriptRun {
    let start = Instant::now();
    let outcome = match language {
        Language::Rhai => RhaiEngine.execute(&host, code, limits),
        Language::Js => JsEngine.execute(&host, code, limits),
    };
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
        // Second Pilot has a running manufacturing job (used == 1) and Test
        // Pilot doesn't — only Test Pilot should count as idle, not both.
        let rhai = run(
            host(),
            Language::Rhai,
            r#"invoke("industry_jobs", #{}).byCharacter.filter(|c| c.slots.manufacturing.used == 0).len()"#,
            &Limits::default(),
        );
        assert!(rhai.ok, "error: {:?}", rhai.error);
        assert_eq!(rhai.result.as_f64(), Some(1.0));
        let js = run(
            host(),
            Language::Js,
            r#"invoke("industry_jobs", {}).byCharacter.filter((c) => c.slots.manufacturing.used === 0).length;"#,
            &Limits::default(),
        );
        assert!(js.ok, "error: {:?}", js.error);
        assert_eq!(js.result.as_f64(), Some(1.0));
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
