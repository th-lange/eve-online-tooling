# Code signing — applied to SignPath Foundation (pending)

**Status: builds are unsigned.** For Windows we have applied (2026-11-14) to the
[SignPath Foundation](https://signpath.org), which provides free code signing
for open-source projects, and we would be grateful for their support. Nothing is
signed until they accept; this file is updated when that changes.

| Platform | Status | Notes |
| --- | --- | --- |
| 🐧 Linux | ✅ no signing needed | AppImage/deb/rpm run unsigned, no OS prompt. |
| 🍎 macOS | ❌ unsigned | Gatekeeper warns on first launch — right-click → **Open**, or `xattr -dr com.apple.quarantine`. |
| 🪟 Windows | ❌ unsigned, SignPath application pending | SmartScreen warns on first launch — **More info** → **Run anyway**. |

## Why this was unsigned until now

The usual routes to a trusted Authenticode certificate on Windows — Microsoft's
**Azure Artifact Signing** (formerly Trusted Signing) or a traditional EV cert —
require **identity validation**, and for Public Trust certs (the kind that
suppresses the SmartScreen prompt) that is currently only available to
**organizations in the US, Canada, the EU or the UK**, and to **individual
developers only in the US and Canada**. This project is run by an individual
outside that set, so there was no path at a reasonable price. Apple's
equivalent (a $99/year Developer ID + notarization) is available everywhere but
is a recurring cost for a free hobby project, so macOS stays unsigned.

## The SignPath route

SignPath Foundation's certificate is issued to the Foundation, so it needs no
identity validation of the maintainer and no fee. In exchange it asks for: an
OSI-approved licence (MIT), a released and documented project, MFA for everyone
with repository or SignPath access, builds produced by CI in a verifiable way,
manual approval of every signed release, product name/version metadata on the
signed binaries, and a published **code signing policy** (team roles and a
privacy statement). Acceptance also depends on a "verifiable reputation" review,
which a young project may not pass; if they decline, Windows stays unsigned and
this file says so.

If accepted, the plan is: the release workflow builds the Windows installers
unsigned, submits them to SignPath through its GitHub integration, waits for the
maintainer's approval, and publishes the signed files; `SHA256SUMS` and the
attestation are then generated over the **signed** files. The README then carries
SignPath's required wording and the code signing policy.

## Verifying downloads instead

Unsigned does not mean unverifiable. Each release includes a `SHA256SUMS` file
and a GitHub build-provenance attestation per installer (generated in the
`notes` job of `.github/workflows/release.yml`). This covers every platform,
including the Linux AppImage/deb/rpm, which have no OS signing at all:

```sh
sha256sum -c --ignore-missing SHA256SUMS
gh attestation verify <file> --repo th-lange/eve-online-tooling
```

There is deliberately no in-app updater (#1205).

Every release page repeats the click-through instructions and this
reasoning — see `.github/workflows/release.yml`'s `notes` job.
