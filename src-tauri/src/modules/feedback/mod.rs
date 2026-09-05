//! Feedback — in-app ratings, bug reports and feature requests.
//!
//! The app has no backend of its own, so submissions go straight into a
//! **Firebase Firestore** collection from the client. Two things make that safe
//! enough to ship in a public binary:
//!
//! 1. **Security rules are the entire access model** (see `firestore.rules` at
//!    the repo root). The collection is `create`-only: nobody can read, update
//!    or delete a document — not even the person who wrote it. Rules also
//!    validate the shape (field allowlist, enum on `kind`, length caps), so the
//!    worst a hostile client can do is insert a well-formed row.
//! 2. **No secrets ship in the binary.** The Firebase web API key is an
//!    identifier, not a credential (that is Google's documented position); it
//!    grants exactly what the rules allow and nothing else. Reading the corpus
//!    needs a *service account* key, which lives only on the maintainer's
//!    machine — see `scripts/feedback-pull.mjs`.
//!
//! Because nothing is readable back, [`commands`] keeps a **local** record of
//! what this install submitted (in the app data dir) so the user can still see
//! their own history and quote a document id. That local copy is also the retry
//! queue: a send that fails offline is stored `Pending` and re-tried later.
//!
//! [`firebase`] speaks the two Google REST APIs directly (anonymous sign-in +
//! Firestore document create) rather than pulling in a Firebase SDK — it is two
//! POSTs, and `reqwest` is already a dependency.

pub mod commands;
mod firebase;

/// Epoch seconds as a **signed** value. Timestamps in this module are `i64`:
/// they cross into the UI as JSON numbers and get subtracted from each other
/// (cooldowns, "was this in the last day"), where a `u64` would underflow. The
/// shared clock returns `u64`, so the cast happens here, once.
pub(crate) fn now_secs() -> i64 {
    crate::util::time::now_secs() as i64
}
