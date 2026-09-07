fn main() {
    // The Feedback module reads these with `option_env!`, which cargo does not
    // track as a dependency on its own. Without these lines a warm `target`
    // cache (CI restores one) could reuse an object file compiled before the
    // variable was set — silently shipping a release with feedback disabled,
    // and no build error to notice. Keep in step with the constants in
    // `src/modules/feedback/firebase.rs`.
    println!("cargo:rerun-if-env-changed=EVE_TOOLING_FIREBASE_PROJECT_ID");
    println!("cargo:rerun-if-env-changed=EVE_TOOLING_FIREBASE_API_KEY");
    tauri_build::build()
}
