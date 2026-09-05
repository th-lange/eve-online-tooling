# Feedback module — setup & operations

The **Feedback** module lets users rate a module, report a bug or ask for a
feature from inside the app. There is no backend of our own: submissions go
straight into a **Firebase Firestore** collection, which is free (Spark plan,
no card) and needs nothing running.

This page is for the maintainer. Users need none of it.

## The module is gated on a logged-in character

With an empty character roster the module is **inactive**: the sidebar and the
⌘K palette leave it out, its page says *"Module inactive — registered account
required"*, and `feedback_submit` refuses. Feedback is tied to a character so a
report can be answered by EVE mail, and so the corpus isn't open to anyone who
merely downloaded the binary.

Gating is declared in the registry (`requiresCharacter: true` on the module
entry) and applied by `useAvailableModules()`, which both nav surfaces build
from. The *route* still exists either way — that is what a direct link or a
restored "last visited" lands on, which is why the page states the reason
itself rather than relying on being unreachable.

## The privacy posture, stated plainly

- A submission carries **only**: kind (rating/bug/feature), module id, star
  rating, the user's text, app version, OS, an anonymous account id, and a
  character name.
- The character is **chosen per submission** from a picker listing the logged-in
  roster, defaulting to the active character. "Don't include a character" is
  always an option, and sends an explicit null.
- Only the character *id* crosses the Tauri bridge; the name is resolved from
  the roster in Rust, so a submission can only ever name a character that
  install actually has. An id that isn't in the roster is refused rather than
  silently downgraded to anonymous — a user who asked to be contactable should
  not be quietly made anonymous.
- **Never** sent: character id, ESI data, assets, wallet, logs, file paths,
  anything about the machine beyond the OS name.
- Nothing is sent until the user presses the button. The app shows the exact
  payload beforehand (`feedback_preview` returns the same record `feedback_submit`
  uploads, so the preview cannot drift from reality).
- The collection is **write-only**. No client can read a submission back — not
  another user, not its author, not the app. Only a service-account key can
  read the corpus, and that key lives on the maintainer's machine.

Because users cannot read their submissions back, the app keeps a **local**
mirror of what each install sent, purely for their own reference.

## One-time Firebase setup

1. Create a project at <https://console.firebase.google.com>. Stay on the
   **Spark** (free) plan — no billing account is needed, because we never use
   Cloud Functions.
2. **Authentication → Sign-in method → Anonymous → Enable.** Every submission
   is attributed to an anonymous account, which is what gives an install a
   stable `uid` across restarts.
3. **Firestore Database → Create database → Native mode.** Pick a region near
   most users; it cannot be changed later.
4. Deploy the rules in [`firestore.rules`](../firestore.rules) — either paste
   them into the console's **Rules** tab, or `firebase deploy --only
   firestore:rules`. **Do not skip this.** The rules are the entire access
   model; the console's default template allows far more than we want.
5. **Project settings → General → Your apps → Web app.** Note the
   **Project ID** and the **Web API key**.

### Is shipping the API key safe?

Yes, and it is unavoidable for a client-only design. A Firebase web API key
identifies a project; it is not a credential, and Google documents it as
publishable. It grants exactly what the security rules allow — here, "create
one well-formed feedback document, attributed to your own anonymous account,
and nothing else." Anyone who unzips a release can extract it and write to the
collection, so the rules do the real work: a field allowlist, an enum on `kind`,
length caps, and `uid == request.auth.uid`.

There is no App Check option for a desktop app (its attestation providers are
web/iOS/Android only). If the collection is ever abused in volume, the escape
hatch is to put a Cloudflare Worker in front and ship a new endpoint.

Worth doing anyway: in the Google Cloud console, **APIs & Services →
Credentials → the browser key → API restrictions**, limit the key to the
*Identity Toolkit API* and *Cloud Firestore API*. It can't stop someone writing
feedback (the rules handle that), but it stops an extracted key being used
against any other Google API enabled on the project.

## Build-time configuration

The project id and API key are baked in at compile time:

```sh
EVE_TOOLING_FIREBASE_PROJECT_ID=your-project-id \
EVE_TOOLING_FIREBASE_API_KEY=AIza... \
  npm run tauri build
```

A build **without** them is fine — `feedback_status` reports
`configured: false`, the send button is disabled, and the UI offers the
prefilled GitHub-issue route instead. That is also what dev builds do by
default, so local development never writes to the real collection.

### In CI

`.github/workflows/release.yml` passes both to `tauri-action` from **repository
secrets of the same names**:

| Secret | Value |
| --- | --- |
| `EVE_TOOLING_FIREBASE_PROJECT_ID` | the Firebase project id |
| `EVE_TOOLING_FIREBASE_API_KEY` | the Firebase **web** API key |

Set them under *Settings → Secrets and variables → Actions*. A build where
they're absent — a fork, or a release run before they were added — ships with
feedback disabled rather than failing, so nothing breaks; it just quietly won't
collect anything. Check a release binary once after adding them.

`ci.yml` deliberately does **not** set them: test runs must never write into
the real collection.

Note `src-tauri/build.rs` emits `cargo:rerun-if-env-changed` for both. Cargo
doesn't track `option_env!` on its own, and CI restores a warm `target` cache —
without that, a build could reuse an object file compiled before the variables
existed and silently ship with feedback disabled.

## Reading the corpus

Reading needs a service account, whose key **bypasses security rules by design**
— keep it off the repo and out of any build.

1. **Project settings → Service accounts → Generate new private key.** Save the
   JSON somewhere private (`.local/` in this repo is git-ignored).
2. Pull:

   ```sh
   GOOGLE_APPLICATION_CREDENTIALS=.local/service-account.json npm run feedback:pull
   ```

This writes two git-ignored files:

| File | What it is |
| --- | --- |
| `.local/feedback.json` | Every submission, newest first — the machine-readable copy |
| `.local/feedback.md` | A digest grouped by module and kind, with per-module average ratings |

`feedback.md` is the one to skim, and the one to hand an agent when asking for
a triage pass ("read `.local/feedback.md`, group the bugs by likely cause,
propose issues"). The script has no dependencies — the service-account OAuth
exchange is a signed JWT that `node:crypto` handles.

Each record carries Firestore's own `createTime` as `createdAt`. That timestamp
is server-side, so unlike a client-supplied one it cannot be forged or
backdated — which is why the client sends no timestamp at all.

## Replying to a reporter

A submission that carries a `character` name can be answered with an **in-game
EVE mail**, sent manually from your own client — the reporter picked that
character precisely so you could. This deliberately needs no extra
ESI scope from the user: EVE exposes no email address through ESI at all, and
sending mail *as* the user would require a `esi-mail.send_mail.v1` token from
them, which would be backwards.

## Deleting a submission on request

Users cannot delete their own submissions (the rules deny `delete` to every
client), so a request comes to you. They can quote the document id shown after
sending, or the app's local history. Delete the document in the Firestore
console.

## If it gets spammed

In rough order of effort:

1. Delete the junk in the console.
2. Tighten `firestore.rules` — shorter caps, or a stricter `module` check.
3. Rotate to a new Firebase project and ship a release pointing at it.
4. Move the write path behind a Cloudflare Worker that can rate-limit by IP.

The client already throttles itself (30s between submissions, 20 per rolling
day per install), but that is a courtesy to honest users, not a defence — a
hostile client simply won't run our code.
