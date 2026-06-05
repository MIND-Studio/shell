//! Monotonic-ish millisecond clock for KDF calibration timing only.
//!
//! WASM has no `std::time::Instant`; we use `performance.now()` there. This is
//! used *exclusively* for benchmarking the KDF — never for TOTP (the host
//! supplies trusted time via `totp_at`, per the contract).

#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(target_arch = "wasm32")]
pub fn now_ms() -> f64 {
    // Use the browser Performance API; fall back to 0 if unavailable.
    web_now_ms().unwrap_or(0.0)
}

#[cfg(target_arch = "wasm32")]
fn web_now_ms() -> Option<f64> {
    use wasm_bindgen::JsCast;
    let global = js_sys::global();
    // Try Window.performance, then WorkerGlobalScope.performance.
    let perf = js_sys::Reflect::get(&global, &wasm_bindgen::JsValue::from_str("performance")).ok()?;
    let perf: web_sys_performance::Performance = perf.dyn_into().ok()?;
    Some(perf.now())
}

// Minimal shim so we don't pull all of web-sys just for performance.now().
#[cfg(target_arch = "wasm32")]
mod web_sys_performance {
    use wasm_bindgen::prelude::*;
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(extends = js_sys::Object)]
        pub type Performance;
        #[wasm_bindgen(method)]
        pub fn now(this: &Performance) -> f64;
    }
}
