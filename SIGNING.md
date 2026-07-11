# Code signing — not happening (for now)

**Decision: builds stay unsigned.** Not a gap to fill in, not a TODO — a
deliberate call, revisit only if the underlying gatekeeping changes.

| Platform | Status | Notes |
| --- | --- | --- |
| 🐧 Linux | ✅ no signing needed | AppImage/deb/rpm run unsigned, no OS prompt. |
| 🍎 macOS | ❌ unsigned | Gatekeeper warns on first launch — right-click → **Open**, or `xattr -dr com.apple.quarantine`. |
| 🪟 Windows | ❌ unsigned | SmartScreen warns on first launch — **More info** → **Run anyway**. |

## Why

Every practical path to a trusted Authenticode certificate on Windows —
Microsoft's own **Azure Artifact Signing** (formerly Trusted Signing), or a
traditional EV cert — requires **identity validation**, and for Public Trust
certs (the only kind that actually suppresses the SmartScreen prompt) that
validation is currently only available to developers billing out of the
**US, Canada, the EU, or the UK**. Outside those regions there is no path at
a reasonable price — full price, no free/OSS tier, no shortcut. Apple's
equivalent (a $99/year Developer ID + notarization) is at least available
everywhere, but it's still a recurring cost for a free hobby project.

This project isn't paying an ongoing fee, or routing around a geography
requirement, so a handful of maintainers can dodge a warning dialog. The
SmartScreen/Gatekeeper prompts exist to let platform vendors gatekeep who
gets to look "trustworthy" by default; small independent, non-US-aligned
developers just eat the warning. So: unsigned it stays. If Microsoft ever
opens Public Trust identity validation to the rest of the world at a sane
price, this file gets rewritten — until then, this is a closed question, not
an open one.

Every release page repeats the click-through instructions and this
reasoning — see `.github/workflows/release.yml`'s `notes` job.
