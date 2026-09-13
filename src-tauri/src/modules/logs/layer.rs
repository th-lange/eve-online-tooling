//! A `tracing_subscriber::Layer` that captures WARN and ERROR records into
//! the shared [`LogStore`] and forwards each entry to the frontend via the
//! `logs://entry` Tauri event.

use std::sync::Arc;
use tracing::{
    field::{Field, Visit},
    Level, Subscriber,
};
use tracing_subscriber::layer::Context;
use tracing_subscriber::Layer;

use super::LogStore;

/// Installed as a global subscriber layer in `lib.rs::run()::setup()`.
pub struct LogLayer {
    pub store: Arc<LogStore>,
    pub app: tauri::AppHandle,
}

impl<S: Subscriber> Layer<S> for LogLayer {
    fn enabled(&self, metadata: &tracing::Metadata<'_>, _ctx: Context<'_, S>) -> bool {
        // Only care about WARN and ERROR; drop everything else early.
        *metadata.level() <= Level::WARN
    }

    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() > Level::WARN {
            return;
        }
        let level = if *meta.level() == Level::ERROR {
            "error"
        } else {
            "warn"
        };
        let mut visitor = MsgVisitor::default();
        event.record(&mut visitor);
        let entry = self.store.push(level, meta.target(), visitor.message);
        use tauri::Emitter;
        let _ = self.app.emit("logs://entry", &entry);
    }
}

/// Collects the `message` field from a tracing event.
#[derive(Default)]
struct MsgVisitor {
    message: String,
}

impl Visit for MsgVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_owned();
        }
    }
}
