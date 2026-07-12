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
//! `plugins/<id>/kv/`, with no path escape and no visibility into any other
//! plugin's data or the app's own storage. Further capabilities (`sde:read`,
//! `market:read`, `assets:read`) plug into `host_functions` the same way.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use extism::{CurrentPlugin, Error, Function, UserData, Val, PTR};

use super::manifest::Permission;
use crate::sde::{Sde, SdePaths};

/// Everything a plugin's host functions are allowed to know about it: where its
/// private storage lives. Shared (immutably) into each host-fn closure.
pub struct BrokerCtx {
    app_data_dir: PathBuf,
    plugin_id: String,
}

impl BrokerCtx {
    pub fn new(app_data_dir: PathBuf, plugin_id: String) -> Self {
        Self {
            app_data_dir,
            plugin_id,
        }
    }

    /// This plugin's private KV directory: `plugins/<id>/kv/`.
    fn kv_dir(&self) -> PathBuf {
        self.app_data_dir
            .join("plugins")
            .join(&self.plugin_id)
            .join("kv")
    }
}

/// Sanitize a KV key to a single safe filename component. Rejects empty keys
/// and anything with a path separator or `..`, so a key can never escape the
/// plugin's own `kv/` dir.
fn key_path(ctx: &BrokerCtx, key: &str) -> Result<PathBuf, Error> {
    let safe: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .collect();
    if safe.is_empty() || safe.contains("..") {
        return Err(Error::msg(format!("invalid storage key {key:?}")));
    }
    Ok(ctx.kv_dir().join(safe))
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
                let path = key_path(&get_ctx, &key)?;
                let value = std::fs::read_to_string(&path).unwrap_or_default();
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
                let path = key_path(&set_ctx, &key)?;
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| Error::msg(e.to_string()))?;
                }
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
                let sde = Sde::open(&SdePaths::new(sde_ctx.app_data_dir.clone()).db)
                    .map_err(|e| Error::msg(e.to_string()))?;
                let info = sde
                    .type_info(type_id)
                    .map_err(|e| Error::msg(e.to_string()))?;
                // `null` when the type is unknown — a clean, parseable result.
                let json = serde_json::to_string(&info).map_err(|e| Error::msg(e.to_string()))?;
                plugin.memory_set_val(&mut outputs[0], json)?;
                Ok(())
            },
        ));
    }

    functions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_path_stays_inside_the_plugin_kv_dir() {
        let ctx = BrokerCtx::new(PathBuf::from("/data"), "acme".into());
        let ok = key_path(&ctx, "prefs").unwrap();
        assert_eq!(ok, PathBuf::from("/data/plugins/acme/kv/prefs"));
        // A traversal attempt is rejected outright, never resolved.
        assert!(key_path(&ctx, "../../etc/passwd").is_err());
    }

    #[test]
    fn empty_key_is_rejected() {
        let ctx = BrokerCtx::new(PathBuf::from("/data"), "acme".into());
        assert!(key_path(&ctx, "///").is_err());
    }

    #[test]
    fn host_functions_track_grants() {
        let ctx = Arc::new(BrokerCtx::new(PathBuf::from("/data"), "acme".into()));
        assert!(host_functions(&HashSet::new(), ctx.clone()).is_empty());
        // storage:own -> storage_get + storage_set.
        let storage = HashSet::from([Permission::StorageOwn]);
        assert_eq!(host_functions(&storage, ctx.clone()).len(), 2);
        // sde:read -> sde_type_info.
        let sde = HashSet::from([Permission::SdeRead]);
        assert_eq!(host_functions(&sde, ctx.clone()).len(), 1);
        // Both -> all three.
        let both = HashSet::from([Permission::StorageOwn, Permission::SdeRead]);
        assert_eq!(host_functions(&both, ctx).len(), 3);
    }
}
