//! Thin command layer wiring the frontend (`invoke()`) to core services.
//!
//! Feature-specific commands live in their own module under `modules/` and are
//! re-exported here as the surface grows; for now this holds only the
//! bridge health-check.

/// Health-check used by the frontend to verify the Rust bridge is live.
#[tauri::command]
pub fn ping() -> String {
    "pong".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }
}
