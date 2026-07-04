# Code signing

Where things stand and how to turn on **free Windows code signing**.

| Platform | Status | Notes |
| --- | --- | --- |
| 🐧 Linux | ✅ nothing needed | AppImage/deb/rpm run unsigned. |
| 🪟 Windows | 🟡 prepped, off | Free via **SignPath Foundation** (OSS) — steps below. |
| 🍎 macOS | ❌ not free | Needs an Apple Developer account ($99/yr) for a Developer ID cert + notarization. Left unsigned; users right-click → **Open** the first time. |

## Windows — SignPath Foundation (free for open source)

[SignPath Foundation](https://signpath.org/) issues free Authenticode certificates
to OSS projects. The release workflow already has the signing steps wired in —
they stay **inert until the secrets/variables below exist**, so nothing changes
until you finish setup.

### 1. Apply
- Sign up at <https://about.signpath.io/product/open-source> and create an
  organization for this project.
- Requirement met: the repo is public **and MIT-licensed** (`LICENSE`).

### 2. Create the SignPath project
In the SignPath dashboard, create:
- **Project** with slug **`eve-online-tooling`**
- **Artifact configuration** with slug **`windows-installers`** (a ZIP containing
  the `.exe` + `.msi`; SignPath's "authenticode" template)
- **Signing policy** with slug **`release-signing`** (bound to the Foundation
  certificate)
- A **CI user** with an **API token**

> If you pick different slugs, update them in `.github/workflows/release.yml`
> (the three "SignPath" steps).

### 3. Add the GitHub secrets/variables
On `th-lange/eve-online-tooling` → Settings:
- **Secret** `SIGNPATH_API_TOKEN` = the SignPath CI user's API token
- **Variable** `SIGNPATH_ORGANIZATION_ID` = your SignPath organization id

That's it. The next **minor** release tag (`vX.Y.0`, which builds Windows) will:
1. build the installers,
2. submit them to SignPath (`signpath/github-action-submit-signing-request`),
3. replace the release's `.exe`/`.msi` with the **signed** versions.

### 4. Housekeeping
- Once signing works, drop the "**unsigned**" line from `releaseBody` in
  `release.yml` for Windows, and update the README's open instructions.
- SmartScreen reputation builds up over the first downloads even with a valid
  cert — early users may still see a prompt until reputation accrues.

## macOS (optional, paid)

If you later get an Apple Developer account, `tauri-action` supports signing +
notarization via `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` secrets —
see the Tauri docs. Not wired up here.
