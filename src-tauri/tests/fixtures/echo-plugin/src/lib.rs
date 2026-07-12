//! Minimal Extism guest used only by the host tests.
//!
//! - `echo` returns its input bytes verbatim (a JSON payload round-trips
//!   input -> output unchanged).
//! - `spin` loops forever, to prove the host's per-call timeout terminates a
//!   runaway plugin instead of hanging.
#![no_main]

use extism_pdk::*;

#[plugin_fn]
pub unsafe fn echo(input: String) -> FnResult<String> {
    Ok(input)
}

#[plugin_fn]
pub unsafe fn spin(_input: String) -> FnResult<String> {
    #[allow(clippy::empty_loop)]
    loop {}
}
