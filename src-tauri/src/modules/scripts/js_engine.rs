//! JavaScript backend (`boa`): builds a fresh [`Context`] per run with a
//! loop-iteration and recursion cap, binds the curated host API as global
//! native functions, evaluates the snippet, and converts its result to JSON.
//!
//! `boa`'s garbage collector can't trace arbitrary closures, so the host
//! functions are plain function pointers that read the active [`HostCtx`] from a
//! thread-local. That's sound here because a run is executed synchronously on
//! one dedicated blocking thread: the host is installed before `eval` and
//! cleared after.

use std::cell::RefCell;
use std::sync::Arc;

use boa_engine::{
    Context, JsError, JsNativeError, JsResult, JsString, JsValue, NativeFunction, Source,
};
use serde_json::Value;

use super::engine::{Limits, ScriptEngine};
use super::host::Host;

thread_local! {
    /// The host for the run currently executing on this thread.
    static HOST: RefCell<Option<Arc<dyn Host>>> = const { RefCell::new(None) };
}

pub struct JsEngine;

impl ScriptEngine for JsEngine {
    fn execute(&self, host: &Arc<dyn Host>, code: &str, limits: &Limits) -> Result<Value, String> {
        HOST.with(|h| *h.borrow_mut() = Some(host.clone()));
        let result = run_inner(code, limits);
        HOST.with(|h| *h.borrow_mut() = None);
        result
    }
}

fn run_inner(code: &str, limits: &Limits) -> Result<Value, String> {
    let mut context = Context::default();
    {
        let lim = context.runtime_limits_mut();
        lim.set_loop_iteration_limit(limits.loop_iter_limit);
        lim.set_recursion_limit(limits.recursion_limit);
    }
    register(&mut context).map_err(|e| e.to_string())?;
    let value = context
        .eval(Source::from_bytes(code))
        .map_err(|e| e.to_string())?;
    let json = value.to_json(&mut context).map_err(|e| e.to_string())?;
    Ok(json.unwrap_or(Value::Null))
}

fn register(context: &mut Context) -> JsResult<()> {
    let fns: &[(&str, usize, NativeFunction)] = &[
        ("log", 1, NativeFunction::from_fn_ptr(js_log)),
        ("notify", 2, NativeFunction::from_fn_ptr(js_notify)),
        (
            "market_price",
            2,
            NativeFunction::from_fn_ptr(js_market_price),
        ),
        (
            "sde_type_info",
            1,
            NativeFunction::from_fn_ptr(js_sde_type_info),
        ),
        ("assets", 0, NativeFunction::from_fn_ptr(js_assets)),
        ("my_orders", 0, NativeFunction::from_fn_ptr(js_my_orders)),
        (
            "corp_assets",
            0,
            NativeFunction::from_fn_ptr(js_corp_assets),
        ),
        ("kv_get", 1, NativeFunction::from_fn_ptr(js_kv_get)),
        ("kv_set", 2, NativeFunction::from_fn_ptr(js_kv_set)),
        ("play_sound", 1, NativeFunction::from_fn_ptr(js_play_sound)),
        ("send_alarm", 1, NativeFunction::from_fn_ptr(js_send_alarm)),
        (
            "write_message",
            1,
            NativeFunction::from_fn_ptr(js_write_message),
        ),
        ("invoke", 2, NativeFunction::from_fn_ptr(js_call)),
        ("now", 0, NativeFunction::from_fn_ptr(js_now)),
        (
            "json_encode",
            1,
            NativeFunction::from_fn_ptr(js_json_encode),
        ),
        (
            "json_decode",
            1,
            NativeFunction::from_fn_ptr(js_json_decode),
        ),
    ];
    for (name, len, f) in fns {
        context.register_global_callable(JsString::from(*name), *len, f.clone())?;
    }
    Ok(())
}

/// Run `f` with the thread-local host, or a clear error if none is installed.
fn with_host<T>(f: impl FnOnce(&dyn Host) -> Result<T, String>) -> Result<T, String> {
    HOST.with(|h| {
        let borrowed = h.borrow();
        let host = borrowed.as_ref().ok_or("script host unavailable")?;
        f(host.as_ref())
    })
}

/// Wrap a host error message as a JS exception.
fn throw(msg: String) -> JsError {
    JsNativeError::error().with_message(msg).into()
}

fn arg_str(args: &[JsValue], i: usize, context: &mut Context) -> JsResult<String> {
    Ok(match args.get(i) {
        Some(v) => v.to_string(context)?.to_std_string_escaped(),
        None => String::new(),
    })
}

/// Optional Info Panel detail: a string is used as-is; any other value is
/// pretty-printed as JSON so the "output" is legible. `None` when absent.
fn arg_detail(args: &[JsValue], i: usize, context: &mut Context) -> JsResult<Option<String>> {
    match args.get(i) {
        Some(v) if !v.is_undefined() && !v.is_null() => {
            if v.is_string() {
                Ok(Some(v.to_string(context)?.to_std_string_escaped()))
            } else {
                let json = v.to_json(context)?.unwrap_or(serde_json::Value::Null);
                Ok(Some(
                    serde_json::to_string_pretty(&json).unwrap_or_default(),
                ))
            }
        }
        _ => Ok(None),
    }
}

fn arg_i64(args: &[JsValue], i: usize) -> i64 {
    args.get(i).and_then(JsValue::as_number).unwrap_or(0.0) as i64
}

fn js_log(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let msg = arg_str(args, 0, context)?;
    HOST.with(|h| {
        if let Some(host) = h.borrow().as_ref() {
            host.log(msg);
        }
    });
    Ok(JsValue::undefined())
}

fn js_notify(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let title = arg_str(args, 0, context)?;
    let body = arg_str(args, 1, context)?;
    with_host(|h| h.notify(&title, &body)).map_err(throw)?;
    Ok(JsValue::undefined())
}

fn js_market_price(_this: &JsValue, args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let type_id = arg_i64(args, 0);
    let region = args.get(1).and_then(JsValue::as_number).map(|n| n as i64);
    let value = with_host(|h| h.market_price(type_id, region)).map_err(throw)?;
    JsValue::from_json(&value, _context)
}

fn js_sde_type_info(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let type_id = arg_i64(args, 0);
    let value = with_host(|h| h.sde_type_info(type_id)).map_err(throw)?;
    JsValue::from_json(&value, context)
}

fn js_assets(_this: &JsValue, _args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let value = with_host(|h| h.assets()).map_err(throw)?;
    JsValue::from_json(&value, context)
}

fn js_my_orders(_this: &JsValue, _args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let value = with_host(|h| h.my_orders()).map_err(throw)?;
    JsValue::from_json(&value, context)
}

fn js_corp_assets(_this: &JsValue, _args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let value = with_host(|h| h.corp_assets()).map_err(throw)?;
    JsValue::from_json(&value, context)
}

fn js_kv_get(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let key = arg_str(args, 0, context)?;
    let value = with_host(|h| h.kv_get(&key)).map_err(throw)?;
    Ok(JsValue::from(JsString::from(value.as_str())))
}

fn js_kv_set(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let key = arg_str(args, 0, context)?;
    let value = arg_str(args, 1, context)?;
    with_host(|h| h.kv_set(&key, &value)).map_err(throw)?;
    Ok(JsValue::undefined())
}

fn js_now(_this: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    Ok(JsValue::from(secs as f64))
}

fn js_json_encode(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let value = args.first().cloned().unwrap_or(JsValue::undefined());
    let json = value.to_json(context)?.unwrap_or(Value::Null);
    let text = serde_json::to_string(&json).map_err(|e| throw(e.to_string()))?;
    Ok(JsValue::from(JsString::from(text.as_str())))
}

fn js_json_decode(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = arg_str(args, 0, context)?;
    let value: Value = serde_json::from_str(&text).map_err(|e| throw(e.to_string()))?;
    JsValue::from_json(&value, context)
}

fn js_play_sound(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let path = arg_str(args, 0, context)?;
    with_host(|h| h.play_sound(&path)).map_err(throw)?;
    Ok(JsValue::undefined())
}

fn js_send_alarm(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = arg_str(args, 0, context)?;
    let detail = arg_detail(args, 1, context)?;
    with_host(|h| h.send_alarm(&text, detail.as_deref())).map_err(throw)?;
    Ok(JsValue::undefined())
}

fn js_write_message(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let text = arg_str(args, 0, context)?;
    let detail = arg_detail(args, 1, context)?;
    with_host(|h| h.write_message(&text, detail.as_deref())).map_err(throw)?;
    Ok(JsValue::undefined())
}

fn js_call(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let name = arg_str(args, 0, context)?;
    let call_args = match args.get(1) {
        Some(v) if !v.is_undefined() && !v.is_null() => {
            v.to_json(context)?.unwrap_or(serde_json::Value::Null)
        }
        _ => serde_json::Value::Null,
    };
    let value = with_host(|h| h.call(&name, &call_args)).map_err(throw)?;
    JsValue::from_json(&value, context)
}
