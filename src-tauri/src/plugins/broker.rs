//! The capability broker — the single security choke point between an
//! untrusted plugin and the host's services.
//!
//! A plugin gets **no ambient authority**: it can reach a host service only
//! through a host function the broker registers, and the broker registers a
//! host function *only when the plugin was granted the matching permission*
//! (load-time linking). An un-granted capability isn't merely refused at call
//! time — the import is absent, so a plugin that tries to use it fails to
//! instantiate. Nothing else (filesystem, network, keychain, ESI tokens) is
//! ever exposed.
//!
//! First capability: `storage:own` — a per-plugin key/value store rooted at
//! `plugin-data/<id>/kv/` (outside the install dir, so reinstalling a plugin
//! keeps its data and `plugin://` never serves it), with no path escape and no visibility into any other
//! plugin's data or the app's own storage. Further capabilities (`sde:read`,
//! `market:read`, `assets:read`) plug into `host_functions` the same way.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use extism::{CurrentPlugin, Error, Function, UserData, Val, PTR};

use super::manifest::Permission;
use crate::capabilities;
use crate::esi::AuthState;
use crate::market::MarketService;

/// Everything a plugin's host functions are allowed to know about it: where
/// its private storage lives, plus the shared `MarketService`/`AuthState`
/// instances the host-call capability dispatcher runs against. `market`/
/// `auth` are process-shared (one per [`super::manager::PluginManager`], not
/// per plugin) so repeated `host_call`s hit warm TTL caches instead of
/// building a fresh client + empty caches every call (#764).
pub struct BrokerCtx {
    app_data_dir: PathBuf,
    plugin_id: String,
    market: Arc<MarketService>,
    auth: Arc<AuthState>,
}

impl BrokerCtx {
    pub fn new(
        app_data_dir: PathBuf,
        plugin_id: String,
        market: Arc<MarketService>,
        auth: Arc<AuthState>,
    ) -> Self {
        Self {
            app_data_dir,
            plugin_id,
            market,
            auth,
        }
    }

    /// This plugin's private KV directory: `plugin-data/<id>/kv/`.
    fn kv_dir(&self) -> PathBuf {
        plugin_data_dir(&self.app_data_dir, &self.plugin_id).join("kv")
    }
}

/// Where a plugin's persistent data lives: `<app_data_dir>/plugin-data/<id>/`.
/// Deliberately **outside** `plugins/<id>/` — that directory is replaced
/// wholesale on every (re)install, which used to wipe the plugin's KV store
/// (#1154), and is also what the `plugin://` protocol serves to plugin UIs.
/// Only uninstalling a plugin deletes this directory.
pub fn plugin_data_dir(app_data_dir: &Path, plugin_id: &str) -> PathBuf {
    app_data_dir.join("plugin-data").join(plugin_id)
}

/// One-time migration of a pre-#1154 KV store (`plugins/<id>/kv/`) to its new
/// home. Only a real directory is moved (never a symlink planted by a
/// hand-installed plugin), and only when the new location doesn't exist yet,
/// so it can never overwrite data. Best-effort: a failure is logged and the
/// plugin simply starts with an empty store.
pub fn migrate_legacy_kv(app_data_dir: &Path, plugin_id: &str) {
    let old = app_data_dir.join("plugins").join(plugin_id).join("kv");
    if !std::fs::symlink_metadata(&old).is_ok_and(|m| m.is_dir()) {
        return;
    }
    let new = plugin_data_dir(app_data_dir, plugin_id).join("kv");
    if new.exists() {
        return;
    }
    let moved = new
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::rename(&old, &new));
    if let Err(e) = moved {
        tracing::warn!("plugins: could not migrate kv store of {plugin_id:?}: {e}");
    }
}

/// Sanitize a KV key to a single safe filename component and resolve it to a
/// file inside the plugin's own `kv/` dir. Rejects empty keys and anything
/// with a path separator or `..`, and — because the character filter alone
/// doesn't stop a *symlink* — canonicalizes the `kv/` dir and requires it to
/// sit under `plugin-data/`, and refuses a key whose file is itself a symlink
/// (a hand-installed plugin could otherwise point it at any app document;
/// `.` is an allowed key character, so `scripts.json` is a valid key).
/// `create` makes the `kv/` dir first (writes); for reads a missing dir
/// yields `Ok(None)` (empty store).
fn key_path(ctx: &BrokerCtx, key: &str, create: bool) -> Result<Option<PathBuf>, Error> {
    let safe: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .collect();
    if safe.is_empty() || safe.contains("..") {
        return Err(Error::msg(format!("invalid storage key {key:?}")));
    }
    let kv = ctx.kv_dir();
    if create {
        std::fs::create_dir_all(&kv).map_err(|e| Error::msg(e.to_string()))?;
    }
    let Ok(canonical_kv) = std::fs::canonicalize(&kv) else {
        return Ok(None); // no kv dir yet -> nothing stored
    };
    let canonical_root = std::fs::canonicalize(ctx.app_data_dir.join("plugin-data"))
        .map_err(|e| Error::msg(e.to_string()))?;
    if !canonical_kv.starts_with(&canonical_root) {
        return Err(Error::msg("plugin storage dir escapes plugin-data"));
    }
    let file = canonical_kv.join(safe);
    if std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(Error::msg(format!("storage key {key:?} is a symlink")));
    }
    Ok(Some(file))
}

/// Build the Extism host functions this plugin is entitled to, given its
/// granted permissions. Only granted capabilities are produced — the rest
/// simply don't exist for this instance.
pub fn host_functions(granted: &HashSet<Permission>, ctx: Arc<BrokerCtx>) -> Vec<Function> {
    let mut functions = Vec::new();

    if granted.contains(&Permission::StorageOwn) {
        let get_ctx = ctx.clone();
        functions.push(Function::new(
            "storage_get",
            [PTR],
            [PTR],
            UserData::new(()),
            move |plugin: &mut CurrentPlugin,
                  inputs: &[Val],
                  outputs: &mut [Val],
                  _ud: UserData<()>|
                  -> Result<(), Error> {
                let key: String = plugin.memory_get_val(&inputs[0])?;
                let value = match key_path(&get_ctx, &key, false)? {
                    Some(path) => std::fs::read_to_string(&path).unwrap_or_default(),
                    None => String::new(),
                };
                plugin.memory_set_val(&mut outputs[0], value)?;
                Ok(())
            },
        ));

        let set_ctx = ctx.clone();
        functions.push(Function::new(
            "storage_set",
            [PTR, PTR],
            [],
            UserData::new(()),
            move |plugin: &mut CurrentPlugin,
                  inputs: &[Val],
                  _outputs: &mut [Val],
                  _ud: UserData<()>|
                  -> Result<(), Error> {
                let key: String = plugin.memory_get_val(&inputs[0])?;
                let value: String = plugin.memory_get_val(&inputs[1])?;
                let path = key_path(&set_ctx, &key, true)?
                    .ok_or_else(|| Error::msg("plugin storage dir unavailable"))?;
                std::fs::write(&path, value).map_err(|e| Error::msg(e.to_string()))?;
                Ok(())
            },
        ));
    }
    if granted.contains(&Permission::SdeRead) {
        let sde_ctx = ctx.clone();
        functions.push(Function::new(
            "sde_type_info",
            [PTR],
            [PTR],
            UserData::new(()),
            move |plugin: &mut CurrentPlugin,
                  inputs: &[Val],
                  outputs: &mut [Val],
                  _ud: UserData<()>|
                  -> Result<(), Error> {
                let arg: String = plugin.memory_get_val(&inputs[0])?;
                let type_id: i64 = arg
                    .trim()
                    .parse()
                    .map_err(|_| Error::msg(format!("sde_type_info: not a type id: {arg:?}")))?;
                // The shared helper reports errors as `String`; extism hosts
                // speak `extism::Error`, so map at this boundary. Delegates to
                // the capability registry (cap_sde_type_info) instead of
                // re-implementing the SDE lookup here, so the two callers
                // can't drift. `invoke` is async-first (#1030); Extism host
                // functions are synchronous by contract, and every path that
                // reaches this closure runs it off the Tauri main thread and
                // off any tokio worker (see the `host_call` threading note
                // below), so `block_on` here only blocks that dedicated thread.
                let hctx = capabilities::HostCtx {
                    app_data_dir: &sde_ctx.app_data_dir,
                    market: &sde_ctx.market,
                    auth: Some(&sde_ctx.auth),
                };
                let args = serde_json::json!({ "typeId": type_id });
                let json = tauri::async_runtime::block_on(capabilities::invoke(
                    &hctx,
                    "sde_type_info",
                    &args,
                ))
                .map_err(Error::msg)?
                .to_string();
                plugin.memory_set_val(&mut outputs[0], json)?;
                Ok(())
            },
        ));
    }
    if granted.contains(&Permission::InfoWrite) {
        let alarm_ctx = ctx.clone();
        functions.push(Function::new(
            "send_alarm",
            [PTR],
            [],
            UserData::new(()),
            move |plugin: &mut CurrentPlugin,
                  inputs: &[Val],
                  _outputs: &mut [Val],
                  _ud: UserData<()>|
                  -> Result<(), Error> {
                let text: String = plugin.memory_get_val(&inputs[0])?;
                let source = format!("plugin:{}", alarm_ctx.plugin_id);
                crate::info::push(
                    &alarm_ctx.app_data_dir,
                    crate::info::Kind::Alarm,
                    &text,
                    None,
                    &source,
                );
                Ok(())
            },
        ));

        let msg_ctx = ctx.clone();
        functions.push(Function::new(
            "write_message",
            [PTR],
            [],
            UserData::new(()),
            move |plugin: &mut CurrentPlugin,
                  inputs: &[Val],
                  _outputs: &mut [Val],
                  _ud: UserData<()>|
                  -> Result<(), Error> {
                let text: String = plugin.memory_get_val(&inputs[0])?;
                let source = format!("plugin:{}", msg_ctx.plugin_id);
                crate::info::push(
                    &msg_ctx.app_data_dir,
                    crate::info::Kind::Message,
                    &text,
                    None,
                    &source,
                );
                Ok(())
            },
        ));
    }

    // `host_call(name, argsJson) -> resultJson` — the generic gateway to the
    // capability registry. Always linked; each call is gated at runtime against
    // the plugin's grants (a generic dispatcher can't be gated at load time).
    //
    // Threading: Extism host functions are synchronous by contract, and
    // `capabilities::invoke` is async-first (#1030) so a handler that needs
    // real network I/O (ESI/Fuzzwork) `.await`s it directly instead of
    // blocking deep inside a handler. That leaves exactly one `block_on`
    // here, driving the whole future to completion — acceptable only because
    // every path into plugin wasm keeps this closure off async runtime
    // workers and off the main thread: the `plugins_invoke` command wraps
    // the call in `tokio::task::spawn_blocking` (see `manager::plugins_invoke`),
    // and the MCP bridge runs on its own dedicated OS thread. Do not call
    // plugin wasm inline from a sync command or from an async task — a slow
    // capability would stall the UI (or panic on re-entrant `block_on`).
    let call_granted = granted.clone();
    let call_ctx = ctx.clone();
    functions.push(Function::new(
        "host_call",
        [PTR, PTR],
        [PTR],
        UserData::new(()),
        move |plugin: &mut CurrentPlugin,
              inputs: &[Val],
              outputs: &mut [Val],
              _ud: UserData<()>|
              -> Result<(), Error> {
            let name: String = plugin.memory_get_val(&inputs[0])?;
            let args_json: String = plugin.memory_get_val(&inputs[1])?;
            let args: serde_json::Value =
                serde_json::from_str(&args_json).unwrap_or(serde_json::Value::Null);
            let cap = capabilities::find(&name)
                .ok_or_else(|| Error::msg(format!("unknown capability {name:?}")))?;
            if !call_granted.contains(&cap.permission) {
                return Err(Error::msg(format!(
                    "capability {name:?} requires a permission this plugin wasn't granted"
                )));
            }
            // Shared long-lived services (see `BrokerCtx` docs): warm TTL
            // caches persist across calls instead of being rebuilt each time.
            // No auth is available for a plugin unless a character is logged
            // in on the host side.
            let hctx = capabilities::HostCtx {
                app_data_dir: &call_ctx.app_data_dir,
                market: &call_ctx.market,
                auth: Some(&call_ctx.auth),
            };
            let result = tauri::async_runtime::block_on(capabilities::invoke(&hctx, &name, &args))
                .map_err(Error::msg)?;
            let out = serde_json::to_string(&result).map_err(|e| Error::msg(e.to_string()))?;
            plugin.memory_set_val(&mut outputs[0], out)?;
            Ok(())
        },
    ));

    functions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ctx(dir: &str, plugin_id: &str) -> BrokerCtx {
        BrokerCtx::new(
            PathBuf::from(dir),
            plugin_id.into(),
            Arc::new(MarketService::new()),
            Arc::new(AuthState::new()),
        )
    }

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eve-broker-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn key_path_stays_inside_the_plugin_kv_dir() {
        let dir = tmp("kvpath");
        let ctx = test_ctx(dir.to_str().unwrap(), "acme");
        let ok = key_path(&ctx, "prefs", true).unwrap().unwrap();
        assert_eq!(
            ok,
            std::fs::canonicalize(dir.join("plugin-data/acme/kv"))
                .unwrap()
                .join("prefs")
        );
        // A traversal attempt is rejected outright, never resolved.
        assert!(key_path(&ctx, "../../etc/passwd", true).is_err());
    }

    #[test]
    fn empty_key_is_rejected() {
        let ctx = test_ctx("/data", "acme");
        assert!(key_path(&ctx, "///", false).is_err());
    }

    #[test]
    fn missing_kv_dir_reads_as_empty_without_creating_it() {
        let dir = tmp("kvmissing");
        let ctx = test_ctx(dir.to_str().unwrap(), "acme");
        assert_eq!(key_path(&ctx, "k", false).unwrap(), None);
        assert!(!dir.join("plugin-data").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_kv_dir_cannot_reach_other_app_data() {
        // The #1151 attack: a hand-installed plugin ships `kv -> ../../data`.
        let dir = tmp("kvlink");
        std::fs::create_dir_all(dir.join("plugin-data/acme")).unwrap();
        std::fs::create_dir_all(dir.join("outside")).unwrap();
        std::fs::write(dir.join("outside/scripts.json"), "secret").unwrap();
        std::os::unix::fs::symlink(dir.join("outside"), dir.join("plugin-data/acme/kv")).unwrap();
        let ctx = test_ctx(dir.to_str().unwrap(), "acme");
        assert!(key_path(&ctx, "scripts.json", false).is_err());
        assert!(key_path(&ctx, "scripts.json", true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_kv_file_is_refused() {
        let dir = tmp("kvfilelink");
        let kv = dir.join("plugin-data/acme/kv");
        std::fs::create_dir_all(&kv).unwrap();
        std::fs::write(dir.join("target.json"), "secret").unwrap();
        std::os::unix::fs::symlink(dir.join("target.json"), kv.join("scripts.json")).unwrap();
        let ctx = test_ctx(dir.to_str().unwrap(), "acme");
        assert!(key_path(&ctx, "scripts.json", true).is_err());
        // An ordinary key beside it still works.
        assert!(key_path(&ctx, "prefs", true).unwrap().is_some());
    }

    #[test]
    fn legacy_kv_moves_out_of_the_install_dir_once() {
        let dir = tmp("kvmigrate");
        let old = dir.join("plugins/acme/kv");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("prefs"), "v1").unwrap();
        migrate_legacy_kv(&dir, "acme");
        assert_eq!(
            std::fs::read_to_string(dir.join("plugin-data/acme/kv/prefs")).unwrap(),
            "v1"
        );
        assert!(!old.exists());
        // A second legacy dir (e.g. shipped in a new archive) never overwrites.
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("prefs"), "seeded").unwrap();
        migrate_legacy_kv(&dir, "acme");
        assert_eq!(
            std::fs::read_to_string(dir.join("plugin-data/acme/kv/prefs")).unwrap(),
            "v1"
        );
    }

    #[test]
    fn host_functions_track_grants() {
        let ctx = Arc::new(test_ctx("/data", "acme"));
        // `host_call` (the generic gateway) is always linked, so every count
        // includes it.
        assert_eq!(host_functions(&HashSet::new(), ctx.clone()).len(), 1);
        // storage:own -> storage_get + storage_set (+ host_call).
        let storage = HashSet::from([Permission::StorageOwn]);
        assert_eq!(host_functions(&storage, ctx.clone()).len(), 3);
        // sde:read -> sde_type_info (+ host_call).
        let sde = HashSet::from([Permission::SdeRead]);
        assert_eq!(host_functions(&sde, ctx.clone()).len(), 2);
        // info:write -> send_alarm + write_message (+ host_call).
        let info = HashSet::from([Permission::InfoWrite]);
        assert_eq!(host_functions(&info, ctx.clone()).len(), 3);
        // Both storage + sde (+ host_call).
        let both = HashSet::from([Permission::StorageOwn, Permission::SdeRead]);
        assert_eq!(host_functions(&both, ctx).len(), 4);
    }
}
