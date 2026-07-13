//! Rhai backend: builds a fresh [`rhai::Engine`] per run with operation and size
//! caps plus a wall-clock deadline (checked in `on_progress`), binds the curated
//! host API as native functions, evaluates the snippet, and converts its
//! [`rhai::Dynamic`] result to JSON.

use std::sync::Arc;
use std::time::Instant;

use rhai::serde::to_dynamic;
use rhai::{Dynamic, Engine, EvalAltResult, ImmutableString, Position};
use serde_json::Value;

use super::engine::{Limits, ScriptEngine};
use super::host::Host;

pub struct RhaiEngine;

impl ScriptEngine for RhaiEngine {
    fn execute(&self, host: &Arc<dyn Host>, code: &str, limits: &Limits) -> Result<Value, String> {
        let mut engine = Engine::new();
        engine.set_max_operations(limits.max_ops);
        engine.set_max_call_levels(limits.recursion_limit);
        engine.set_max_string_size(256 * 1024);
        engine.set_max_array_size(64 * 1024);
        engine.set_max_map_size(64 * 1024);

        // Cooperative wall-clock timeout: `on_progress` runs every operation;
        // returning `Some` terminates the evaluation.
        let deadline = Instant::now() + limits.timeout;
        engine.on_progress(move |_ops| {
            if Instant::now() >= deadline {
                Some(Dynamic::from("timeout"))
            } else {
                None
            }
        });

        register_stdlib(&mut engine);
        register(&mut engine, host);

        match engine.eval::<Dynamic>(code) {
            Ok(value) => Ok(serde_json::to_value(&value).unwrap_or(Value::Null)),
            Err(e) => Err(match *e {
                EvalAltResult::ErrorTerminated(..) => "execution timed out".to_string(),
                other => other.to_string(),
            }),
        }
    }
}

/// A Rhai runtime error carrying a host message.
fn rt(msg: String) -> Box<EvalAltResult> {
    Box::new(EvalAltResult::ErrorRuntime(msg.into(), Position::NONE))
}

/// Render an Info Panel detail argument: a string is used as-is; anything else
/// (a map, array, number) is pretty-printed as JSON so the "output" is legible.
fn detail_string(value: &Dynamic) -> String {
    if value.is_string() {
        value.clone().into_string().unwrap_or_default()
    } else {
        serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
    }
}

/// Current time as Unix epoch seconds.
fn epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Basic, host-independent helpers available to every script (Rhai already
/// bundles math/string/array; this adds JSON + time to match the JS builtins).
fn register_stdlib(engine: &mut Engine) {
    engine.register_fn("now", epoch_secs);
    engine.register_fn(
        "json_encode",
        |value: Dynamic| -> Result<String, Box<EvalAltResult>> {
            serde_json::to_string(&value).map_err(|e| rt(e.to_string()))
        },
    );
    engine.register_fn(
        "json_decode",
        |text: &str| -> Result<Dynamic, Box<EvalAltResult>> {
            let value: Value = serde_json::from_str(text).map_err(|e| rt(e.to_string()))?;
            to_dynamic(&value)
        },
    );
}

/// Bind the curated host API. Each closure captures a cheap clone of the host.
fn register(engine: &mut Engine, host: &Arc<dyn Host>) {
    let h = host.clone();
    engine.register_fn("log", move |msg: ImmutableString| h.log(msg.to_string()));

    let h = host.clone();
    engine.register_fn(
        "notify",
        move |title: ImmutableString, body: ImmutableString| -> Result<(), Box<EvalAltResult>> {
            h.notify(&title, &body).map_err(rt)
        },
    );

    let h = host.clone();
    engine.register_fn(
        "market_price",
        move |type_id: i64| -> Result<Dynamic, Box<EvalAltResult>> {
            to_dynamic(&h.market_price(type_id, None).map_err(rt)?)
        },
    );
    let h = host.clone();
    engine.register_fn(
        "market_price",
        move |type_id: i64, region_id: i64| -> Result<Dynamic, Box<EvalAltResult>> {
            to_dynamic(&h.market_price(type_id, Some(region_id)).map_err(rt)?)
        },
    );

    let h = host.clone();
    engine.register_fn(
        "sde_type_info",
        move |type_id: i64| -> Result<Dynamic, Box<EvalAltResult>> {
            to_dynamic(&h.sde_type_info(type_id).map_err(rt)?)
        },
    );

    let h = host.clone();
    engine.register_fn("assets", move || -> Result<Dynamic, Box<EvalAltResult>> {
        to_dynamic(&h.assets().map_err(rt)?)
    });

    let h = host.clone();
    engine.register_fn(
        "corp_assets",
        move || -> Result<Dynamic, Box<EvalAltResult>> {
            to_dynamic(&h.corp_assets().map_err(rt)?)
        },
    );

    let h = host.clone();
    engine.register_fn(
        "my_orders",
        move || -> Result<Dynamic, Box<EvalAltResult>> { to_dynamic(&h.my_orders().map_err(rt)?) },
    );

    let h = host.clone();
    engine.register_fn(
        "kv_get",
        move |key: ImmutableString| -> Result<ImmutableString, Box<EvalAltResult>> {
            Ok(h.kv_get(&key).map_err(rt)?.into())
        },
    );
    let h = host.clone();
    engine.register_fn(
        "kv_set",
        move |key: ImmutableString, value: ImmutableString| -> Result<(), Box<EvalAltResult>> {
            h.kv_set(&key, &value).map_err(rt)
        },
    );
    let h = host.clone();
    engine.register_fn(
        "play_sound",
        move |path: ImmutableString| -> Result<(), Box<EvalAltResult>> {
            h.play_sound(&path).map_err(rt)
        },
    );

    let h = host.clone();
    engine.register_fn(
        "send_alarm",
        move |text: ImmutableString| -> Result<(), Box<EvalAltResult>> {
            h.send_alarm(&text, None).map_err(rt)
        },
    );
    let h = host.clone();
    engine.register_fn(
        "send_alarm",
        move |text: ImmutableString, detail: Dynamic| -> Result<(), Box<EvalAltResult>> {
            h.send_alarm(&text, Some(&detail_string(&detail)))
                .map_err(rt)
        },
    );
    let h = host.clone();
    engine.register_fn(
        "write_message",
        move |text: ImmutableString| -> Result<(), Box<EvalAltResult>> {
            h.write_message(&text, None).map_err(rt)
        },
    );
    let h = host.clone();
    engine.register_fn(
        "write_message",
        move |text: ImmutableString, detail: Dynamic| -> Result<(), Box<EvalAltResult>> {
            h.write_message(&text, Some(&detail_string(&detail)))
                .map_err(rt)
        },
    );

    let h = host.clone();
    engine.register_fn(
        "invoke",
        move |name: ImmutableString| -> Result<Dynamic, Box<EvalAltResult>> {
            to_dynamic(&h.call(&name, &Value::Null).map_err(rt)?)
        },
    );
    let h = host.clone();
    engine.register_fn(
        "invoke",
        move |name: ImmutableString, args: Dynamic| -> Result<Dynamic, Box<EvalAltResult>> {
            let args = serde_json::to_value(&args).map_err(|e| rt(e.to_string()))?;
            to_dynamic(&h.call(&name, &args).map_err(rt)?)
        },
    );
}
