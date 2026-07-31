# `docs/native/`

Documentation for the **native clients** (`native/macOS/JunoDesktop`, `native/iOS/JunoMobile`, `native/Packages/*`).

The website — including the `/api/v1` contract the native clients consume — is documented in [`../JUNO.md`](../JUNO.md), which is the source of truth for everything server-side.

Every file here is current. Anything that was a point-in-time snapshot has moved to [`archive/`](archive/).

## Current

| File | What it is | Read it when |
|---|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The accepted target architecture for the shared packages | Adding a package or moving code between targets |
| [`DECISIONS.md`](DECISIONS.md) | Numbered architecture decision records (D-001…) | Before reopening a settled question |
| [`SECURITY.md`](SECURITY.md) | Native threat model — trust boundaries, Keychain, entitlements | Touching auth, the Keychain, or Code-agent permissions |
| [`TESTING.md`](TESTING.md) | Testing record and the release gates. **Referenced by `native/Scripts/capture-desktop.sh` and `.github/workflows/native.yml`** | Before a release; when CI is green but you do not trust it |
| [`RELEASE.md`](RELEASE.md) | Release and distribution plan (signing, notarization, the update feed). **Referenced from `DesktopUpdater.swift` and `JunoUpdateFeed.swift`** | Cutting a build |
| [`PARITY_MATRIX.md`](PARITY_MATRIX.md) | Web ↔ macOS ↔ iOS feature parity | Planning what to build next on a client |
| [`RESEARCH.md`](RESEARCH.md) | Platform/product research with primary-source links | Designing against an Apple API or a competitor behaviour |
| [`CODE_SLASH_COMMANDS.md`](CODE_SLASH_COMMANDS.md) | The `/name` saved prompts in the Code composer | Adding or changing a slash command |
| [`ROADMAP.md`](ROADMAP.md) | Execution roadmap | Sequencing work |

### macOS V2

The macOS app is mid-rework. These four describe the target; the legacy `JunoMac` surface stays until V2 passes the acceptance gates in `TESTING.md`.

- [`MACOS_ARCHITECTURE.md`](MACOS_ARCHITECTURE.md) — AppKit `NSSplitViewController` + leaf panes
- [`MACOS_PRODUCT_SPEC.md`](MACOS_PRODUCT_SPEC.md) — what V2 must do
- [`MACOS_DESIGN_REVIEW.md`](MACOS_DESIGN_REVIEW.md) — the current visual review
- [`MACOS_IMPLEMENTATION_STATUS.md`](MACOS_IMPLEMENTATION_STATUS.md) — what is built
- [`MACOS_REUSABLE_CODE_INVENTORY.md`](MACOS_REUSABLE_CODE_INVENTORY.md) — what survives from V1

## `archive/`

Point-in-time documents. Kept because they record *why* something is the way it is; not maintained, and not to be trusted as a description of the code today.

`API_GAPS.md` · `CLOUD_AUDIT.md` · `CODE_REMOTE_AUDIT.md` · `DEPLOY_2026-07-22.md` · `MACOS_DESIGN_REVIEW.md` (the superseded 2026-07-22 review) · `MOBILE_DESIGN_REVIEW.md` · `RELEASE_LAYOUT.md`

## Deleted

`HANDOFF.md`, `NEXT_PROMPT.md`, `STATUS.md`, `JUNO_CODE_HANDOFF.md` and `handoff.json` were scaffolding for handing work between AI coding sessions — a running log of "what to do next", superseded on every session and never a description of the system. They are in git history if a specific decision needs recovering.
