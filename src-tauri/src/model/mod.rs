//! Shared domain types reused across services and feature modules.

use serde::{Deserialize, Serialize};

/// A logged-in EVE character in the roster. The refresh token lives in the OS
/// keychain (keyed by `character_id`), never here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub character_id: i64,
    pub name: String,
    pub scopes: Vec<String>,
}
