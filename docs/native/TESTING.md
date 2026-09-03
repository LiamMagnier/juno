# Juno Native — Testing Record and Gates

## Baseline — 2026-07-21

| Command | Result | Notes |
|---|---|---|
| `npx tsc --noEmit` | Pass | No TypeScript errors. |
| `npm run lint` | Pass with warnings | Three pre-existing React Hook warnings; no lint errors. |
| `npm test` | Pass | 121 Node tests plus auth, message-crypto, and moderation scripts. Required approved execution because `tsx` IPC is blocked in the restricted sandbox. |
| Prototype macOS Debug unsigned build | Pass | Xcode 27 beta, destination `platform=macOS`, signing disabled, DerivedData in `/tmp/juno-prototype-derived`. |
| Prototype macOS Release unsigned build | Pass | Generic macOS destination, signing disabled. Built artifact is version 3.0.0 build 28 and is not a signed release candidate. |
| Prototype macOS unit tests | Pass | 34/34 tests. Coverage is limited and does not validate production auth/sync/trust/UI/Remote requirements. |
| Prototype iOS Debug Simulator build | Fail | `AuthSession.swift:73` calls macOS-only `Host.current()` and hardcodes `platform: "macOS"`. This is a pre-existing prototype topology defect. |
| Prototype iOS tests | Not run | Build must compile first. |

## 2026-07-22 — signing is a functional requirement, not a packaging step

Every build command recorded in this file and in STATUS.md passes
`CODE_SIGNING_ALLOWED=NO`. Those commands verify that the apps **compile**. They
do not verify that the apps **run**.

An unsigned build carries no `application-identifier`. iOS uses that entitlement
as an app's default Keychain access group, so without it every Keychain call
returns `errSecMissingEntitlement` (-34018): no token can be stored, and the
sign-in gate drops to `.unavailable` with its button hidden. Confirmed in the
iOS 27 simulator on both Debug and Stable.

Rebuilding the same configuration **with signing enabled** produces a working
sign-in gate:

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcodebuild -project native/iOS/JunoMobile/JunoMobile.xcodeproj \
  -scheme JunoMobile -configuration Stable \
  -destination 'generic/platform=iOS Simulator' \
  -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM=58PVP763WX build
```

Use the unsigned form for compile gates only. Any test that exercises auth,
token storage, sync or an authenticated screen must use a signed build, or it is
testing the failure path.

The macOS app is unaffected (not sandboxed, and its Keychain access does not
depend on an access group), as is the device `.ipa`, which gets
`application-identifier` from its provisioning profile.

## 2026-07-22 — JunoAuthTests does not hang

Recorded because a mission brief listed "fix the hanging JunoAuthTests" as a
task. At `69cf7df` and at every commit since, the suite completes in ~18 ms with
all cases passing. The symptom is not reproducible in this worktree. Nothing was
skipped, weakened, or disabled.

## 2026-07-22 — macOS UI tests and screenshots cannot run in the agent sandbox

- `JunoMacUITests` fails with `Failed to load the test bundle … dlopen` under
  both `CODE_SIGNING_ALLOWED=NO` and ad-hoc signing. The runner needs a session
  where it can be granted Accessibility control.
- `screencapture` returns an all-black image — Screen Recording is not granted.

macOS visual QA was therefore done by reading the **live accessibility tree** of
the running app (`osascript` + System Events, after setting
`AXEnhancedUserInterface`). That is what surfaced the overridden accessibility
identifiers, the unnamed icon-only buttons and the raw model id in the window
subtitle. It is a genuine substitute for structure, labels and ordering; it says
nothing about spacing, colour or contrast.

## Canonical local toolchain

The global developer directory points at Command Line Tools. Prefix native commands with:

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
```

Swift: 6.4. Xcode: 27.0 beta (`27A5218g`). Before production release, repeat all archives with the intended stable Xcode/SDK.

## How to screenshot each platform

DEBUG only, no account needed. Both apps render the real authenticated screens
over a throwaway encrypted database with a no-network sender, via
`JunoPreviewSupport`
(`native/Packages/JunoNativeKit/Sources/JunoPreviewSupport/`). It never
composes the production store, Keychain, or network; add fixtures there for
anything new so it can be screenshotted without signing in. The Stable/Release
binary contains zero preview symbols (gated by `release-gates.sh`).

Activate with `--juno-ui-preview` or `JUNO_UI_PREVIEW=1` — launch arguments and
`JUNO_PREVIEW_*` env vars are interchangeable (`JunoPreviewEnvironment` in
`PreviewShell.swift`). One asymmetry: `simctl` only forwards environment
variables prefixed `SIMCTL_CHILD_`, so launch arguments are the simpler path on
iOS.

macOS (`JunoDesktop`, Debug build):

```bash
# Build once (Debug), then launch the app binary directly — not via `open -n`,
# which can reuse a just-terminated instance with no window.
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
xcodebuild -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj \
  -scheme JunoDesktop -configuration Debug -destination 'platform=macOS' build

APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/JunoDesktop-*/Build/Products/Debug/Juno*.app | head -n1)
"$APP/Contents/MacOS/$(basename "$APP" .app)" \
  --juno-ui-preview --juno-preview-tab chat --juno-preview-appearance light \
  --juno-preview-size 1240x800

# Or batch every surface in light + dark (waits for the window, refuses to
# capture if Juno never came forward):
./native/Scripts/capture-desktop.sh "$APP"
```

iOS (`JunoMobile`, `com.liammagnier.JunoMobile.debug`):

```bash
xcrun simctl boot "iPhone 17 Pro"
xcrun simctl install booted <path-to-Debug-JunoMobile.app>
xcrun simctl launch booted com.liammagnier.JunoMobile.debug \
  --juno-ui-preview --juno-preview-tab chat --juno-preview-appearance dark
xcrun simctl io booted screenshot out.png
# Env-var form (note the SIMCTL_CHILD_ prefix):
SIMCTL_CHILD_JUNO_UI_PREVIEW=1 SIMCTL_CHILD_JUNO_PREVIEW_TAB=projects \
  xcrun simctl launch booted com.liammagnier.JunoMobile.debug
```

Useful flags — the first group also has a `JUNO_PREVIEW_*` env twin; the
composer and overlay flags are launch-argument only
(`JunoPreviewEnvironment` / `JunoComposerPreviewFlags` in `JunoPreviewSupport`):

- `--juno-preview-tab` — `chat search projects library artifacts connections
  tasks usage settings`, plus `memory` and `design` on macOS, `code` and `work`
  (products on macOS, sidebar sections on iOS), and the iOS-only
  `voice` / `sidebar` shorthands.
- `--juno-preview-scenario
  <normal|manyItems|empty|loading|offline|error|conflict|mutating|longText|streaming>`
- `--juno-preview-appearance <light|dark>` · `--juno-preview-size <WxH>`
  (macOS only) · `--juno-preview-accent <name>` (each of the five accents)
- `--juno-preview-settings-route <voice|archived|notifications|code|appearance|…>`
- `--juno-preview-signed-out` (onboarding) · `--juno-preview-voice-fullscreen`
- `--juno-preview-code-session <id>` / `--juno-preview-code-remote-session <id>`
  (Code states; ids in `PreviewCodeFixtures` / `PreviewCodeRemoteFixtures`)
- `--juno-preview-work-overview`, `--juno-preview-work-files`,
  `--juno-preview-update-ready` (macOS staged-update card)
- Composer QA (both apps): `--juno-preview-model-selector`,
  `--juno-preview-model <id>`, `--juno-preview-model-search <text>`,
  `--juno-preview-model-provider <id>`, `--juno-preview-thinking`,
  `--juno-preview-thinking-level <off|minimal|low|medium|high|xhigh|max>`,
  `--juno-preview-keyboard`, `--juno-preview-picker <photos|camera|files>`
- macOS overlays: `--juno-preview-overlay <sheet|alert|confirm|popover|add-menu>`

Capture with `screencapture -R x,y,w,h` (points, not pixels) on macOS, or
`xcrun simctl io booted screenshot out.png` in the simulator. Screenshot every
screen light + dark; on iPad Pro 13" do both orientations.

The harness itself needs no signing — it never composes the live configuration.
The signed-vs-unsigned caveat at the top of this file still applies the moment
a screenshot leaves the fixture world: an unsigned iOS build has no
`application-identifier`, every Keychain call fails with
`errSecMissingEntitlement`, and the sign-in gate drops to `.unavailable`. Use a
signed build for anything that must show real authenticated state.

## Contract alignment — `b903159`

| Command | Result | Notes |
|---|---|---|
| `npx tsx --test tests/native-contract.test.ts tests/native-auth-core.test.ts` | Pass | Exact canonical/legacy callback allowlist, backend/OpenAPI version parity, deterministic self-contained generation, PKCE and token checks. |
| `npx tsc --noEmit` | Pass | Contract version 1.0.1 introduces no TypeScript errors. |
| Generated Swift `swiftc -typecheck -strict-concurrency=complete -warnings-as-errors` | Pass | Required approved execution because the Xcode module cache is outside the restricted sandbox. |

## Shared foundation and independent projects — `0fb7cc3`

| Command / gate | Result | Notes |
|---|---|---|
| `npm run native:contract:check` | Pass | Regeneration in a temporary directory matches the checked-in Swift contract and canonical OpenAPI digest. |
| `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift build --package-path native/Packages/JunoNativeKit --configuration release --scratch-path /tmp/juno-native-kit-release-final -Xswiftc -warnings-as-errors` | Pass | Ten Swift 6 products compile under strict concurrency with warnings treated as errors. |
| `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path native/Packages/JunoNativeKit --scratch-path /tmp/juno-native-kit-tests-final -Xswiftc -warnings-as-errors` | Pass | 50/50 focused tests across Core, API, Auth, Storage, Sync, Search, DesignSystem, ChatKit, CodeKit, and VoiceKit. |
| JunoMac Debug unsigned build | Pass | `platform=macOS`, DerivedData `/tmp/juno-mac-foundation-derived`, signing disabled. |
| JunoMac Stable unsigned build | Pass | DerivedData `/tmp/juno-mac-stable-derived`; universal `arm64` + `x86_64`. |
| JunoMobile Debug simulator build | Pass | Generic iOS Simulator, DerivedData `/tmp/juno-mobile-foundation-derived`, signing disabled. |
| JunoMobile Stable simulator build | Pass | DerivedData `/tmp/juno-mobile-stable-derived`; `arm64` + `x86_64`. |
| `JunoMacTests` | Pass | 2/2 shell/navigation unit tests. |
| `JunoMobileTests` | Pass | 2/2 shell/navigation unit tests on an iPhone 17 Pro simulator. |
| UI test targets | Not run | Targets and sources compile; runtime UI coverage remains a later gate. |
| Next configurations | Not run | Settings and shared schemes were generated and inspected; compile Next explicitly before using that channel. |

## Keychain token persistence — `8297de4`

| Command | Result | Evidence |
|---|---|---|
| Strict `KeychainAuthTokenStoreTests` | Pass | 8/8: account/device scope, replacement, compare-and-swap, missing item, conditional deletion, malformed/cross-account payloads, Security denial and service validation. |
| Strict full package suite | Pass | 58/58 tests with Swift 6 warnings treated as errors. |
| Strict Release package build | Pass | All ten products compile through Security.framework with warnings treated as errors. |
| `npm run native:contract:check` | Pass | Generated Swift contract still matches canonical OpenAPI. |

Environment note: a default package `.build` directory inside the Desktop/File
Provider worktree can acquire Finder metadata/resource forks and make product
signing fail. Use an isolated `--scratch-path /tmp/...`; both final package
commands above pass there. This is not a source regression.

## Production browser authentication — `7e80d8e`

| Command / gate | Result | Evidence |
|---|---|---|
| Strict full package suite | Pass | 67/67 tests; JunoAuth 26/26, including Keychain 10/10 and browser/API/runtime 7/7. |
| Strict Release package build | Pass | All ten products compile with warnings treated as errors. |
| JunoMac Debug + Stable unsigned builds | Pass | Production auth composition and AuthenticationServices adapter compile. |
| JunoMobile Debug + Stable simulator builds | Pass | iPhone/iPad auth composition and AuthenticationServices adapter compile. |
| App unit suites | Pass | JunoMacTests 2/2 and JunoMobileTests 2/2. |
| Auth gate UI suites | Pass | JunoMacUITests 1/1 and JunoMobileUITests 1/1; macOS ad-hoc XCUI runner required `ENABLE_HARDENED_RUNTIME=NO`. |
| `npm run native:contract:check` | Pass | No backend/OpenAPI/generated Swift drift. |
| Live account browser completion | Not run | Requires an interactive authenticated Juno browser session; no mock was substituted. |

## Refresh-aware authenticated bootstrap — `9dad2a1`

| Command / gate | Result | Evidence |
|---|---|---|
| Strict full package suite | Pass | 74/74 tests; Auth 29/29 and Sync 12/12. |
| Strict Release package build | Pass | All ten products compile with warnings treated as errors. |
| Concurrent rejected-token rotation | Pass | 24 simultaneous 401 callers plus a late caller share one refresh rotation. |
| Existing bootstrap route decoding | Pass | Request path, account binding, contract version, canonical cursors, manifest version and typed server errors are covered. |
| `npm run native:contract:check` | Pass | Existing OpenAPI and generated Swift remain aligned; no server change was required. |

## Required gates by unit

### Shared packages

- `swift test --package-path native/Packages/JunoNativeKit`
- Strict concurrency warnings treated as errors in CI.
- Tests for decoding/typed errors, URL validation, PKCE vectors, single-flight refresh, token failure/revocation, cursor/gap/duplicate handling, mutation idempotency/conflicts, account-scoped storage, search normalization/wipe, Remote sequence/replay, and permission policy.

### Backend/contracts

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- Validate OpenAPI 3.1.
- Generate Swift contracts and fail if generation changes the working tree.
- Route tests for bearer ownership, refresh rotation/reuse, revocation, typed errors, idempotency, Remote ordering/replay, and migration convergence.

### macOS

- Debug and Release builds with signing disabled in CI.
- Unit and UI tests for auth, navigation, chat, search, workspace trust, Code session, terminal/diff/tests, approvals, Remote Host, Computer Use stop/indicator, restoration, keyboard, VoiceOver, Reduce Motion/Transparency.
- Archive dry run, entitlements inspection, secret scan, and final signed/notarized Gatekeeper verification.

### iOS/iPadOS

- Debug and Release simulator builds.
- Unit/UI tests for auth, edge sidebar, chat/stream recovery, global search, Cloud task, Remote reconnect/approval, deep links, account switch/revocation, keyboard/focus, Dynamic Type and accessibility settings.
- Archive dry run, privacy manifest/permission strings, secret scan, and final TestFlight validation.

## Mandatory end-to-end suites

1. Web → Mac/iPhone change propagation.
2. iPhone streaming → Web/Mac without duplication.
3. Offline mutation and revision conflict recovery.
4. Concurrent 401s produce one refresh; expired/reused/revoked credentials fail closed.
5. Projects/files/settings converge on all surfaces.
6. Mobile Cloud task emits subagents/files/tests and creates a real branch/PR in a dedicated test repo.
7. Mac local session is discovered and controlled from mobile; approvals, stop/resume, network loss and replay recovery work.
8. Mac revocation immediately removes mobile authority.
9. Untrusted repository instructions/config never execute silently.
10. Light/dark, extreme Dynamic Type, VoiceOver, Reduce Motion/Transparency, contrast, and binary secret scan.

## Failure recording policy

Every failing command added here must include the first actionable error, whether it is introduced or pre-existing, and the exact next rerun. Do not replace a failure with a claimed pass until the same relevant command exits successfully.

## 2026-07-26 — greenfield JunoDesktop and Juno Code studio

| Command / gate | Result | Evidence |
|---|---|---|
| `swift test --package-path native/Packages/JunoNativeKit --scratch-path /tmp/juno-nativekit-final-tests -Xswiftc -warnings-as-errors` | Pass | 391 tests across XCTest and Swift Testing, no failures. Includes Voice permission-denied state coverage. Log: `/tmp/juno-nativekit-final-tests.log`. |
| `npm run native:contract:check` | Pass | Regenerated Swift matches canonical OpenAPI SHA-256 `9723b452be44aa1f596a7544928f79abe6501b2de9c67b24896656c3fc36a745`. Log: `/tmp/juno-native-contract-check.log`. |
| `swift test --package-path native/Packages/JunoCode --scratch-path /tmp/juno-code-hunk-tests -Xswiftc -warnings-as-errors` | Pass | 214 tests, no failures. Includes canonical provider routing across Anthropic/OpenAI-compatible/Responses protocols, Ask/Plan/Code tool enforcement, safe editor save/conflict/checkpoint behavior, deterministic hunk review identity, partial checkpointed reversal and stale-render rejection, confirmation-bound non-force publication to a real bare Git remote, stale push-plan rejection, GitHub PR/check identity and payload parsing, preview inertness, runtime/local/core/bridge coverage, real vertical slice, approval suspension, persistent network failure, and transient reconnect recovery. Latest log: `/tmp/juno-code-github-tests.log`. |
| Strict `JunoDesktop` Debug build | Pass | `SWIFT_TREAT_WARNINGS_AS_ERRORS=YES`, `CODE_SIGNING_ALLOWED=NO`, DerivedData `/tmp/juno-desktop-derived`; latest post-GitHub-status build log: `/tmp/juno-desktop-github-status-build.log`. |
| `JunoDesktopTests` | Pass | 2/2 smoke tests in the signed test build: stable product restoration values and safe model-selection fallback. |
| Live preview inspection | Pass at standard size | Chat composer/model selector, Code Start, local run canvas, and inspector inspected at 1240×800. |
| Signed `JunoDesktopUITests` | Pending environmental rerun | The Mac auto-locked during the batch; XCTest then failed activation with `current state: Running Background` and could not read any accessibility tree. Rerun the same signed UI suite only after manual unlock. |

The strict build emits only Xcode's `appintentsmetadataprocessor` notice that
the target has no AppIntents dependency. It emits no Swift compiler warning.
The latest build after model routing, behavior enforcement, editor,
side-by-side and per-hunk review, and confirmation-bound Git publication
plus read-only GitHub PR/CI visibility passed.

The failed UI batch is not a product failure: the first direct Code/auth tests
had passed in an earlier unlocked run, and every later surface—including the
authentication gate—became invisible after the session locked. The final
deterministic selector and local-session preview routes must still be rerun; no
pass is claimed for them here.

## 2026-07-26 (later) — native shell, Liquid Glass, project-grouped Code

Working tree on `main`, uncommitted, parent commit `540d1d8`.
Toolchain: Xcode 27.0 (`27A5218g`), macOS 27.0 (`26A5388g`), Swift 6.4.

| Command / gate | Result | Evidence |
|---|---|---|
| `swift test --package-path native/Packages/JunoNativeKit -Xswiftc -warnings-as-errors` | Pass | 391 tests (368 XCTest + 23 Swift Testing), 0 failures. Log `/tmp/t-nk.log`. |
| `swift test --package-path native/Packages/JunoCode -Xswiftc -warnings-as-errors` | Pass | 214 tests, 0 failures. Log `/tmp/t-jc2.log`. |
| `npm run native:contract:check` | Pass | Regenerated Swift matches OpenAPI SHA-256 `9723b452…6a745`. |
| `JunoDesktop` Debug, `SWIFT_TREAT_WARNINGS_AS_ERRORS=YES` | Pass | Log `/tmp/bv.log`. |
| `JunoDesktop` **Stable**, warnings-as-errors | Pass | Log `/tmp/b-stable3.log`. Product is `Juno.app`. |
| Preview harness absent from the Stable binary | Pass | 0 launch-flag strings, 0 preview symbols in `Juno.app/Contents/MacOS/Juno`. |
| `JunoDesktopTests` (signed) | Pass | 13 tests in 2 suites. |
| `JunoMobile` Debug simulator, warnings-as-errors | Pass | Shared-package changes keep the phone app building. Log `/tmp/gate-ios2.log`. |
| `./scripts/release-gates.sh` | Pass except "worktree dirty" | Dirty is expected and correct: nothing is committed. Every other gate passes. |
| Light and dark appearance | Pass | Inspected via the new `--juno-preview-appearance` route at 1240×800 and 1280×820. |
| `JunoDesktopUITests` (signed) | **Not run** | Still outstanding. See below. |

### Building `Stable` is now a required gate, not an optional one

Only Debug had ever been built. `Stable` caught a compile error Debug
structurally cannot: a preview-mode guard written as a ternary over a
compile-time-constant flag leaves a statically dead branch, which is an error
under warnings-as-errors in Release and fine in Debug. Both configurations are
now built in `.github/workflows/native.yml`.

### `release-gates.sh` had a false positive that failed every run

Its host pattern `\.local:` also matched Swift's `case .local:` — and Juno Code
has a `.local` execution environment — so gate 3 failed on every build. A gate
that always fails is a gate that gets ignored. Tightened to require a hostname
character before `.local`.

### The AppKit constraint crash, correctly diagnosed

`MACOS_ARCHITECTURE_V2.md` previously recorded that `NavigationSplitView` and
`.inspector` "cannot coexist" on macOS 27, and the shell was a hand-rolled
`HStack` because of it. Re-tested from scratch:

- `NavigationSplitView` alone: stable. Six rounds of sidebar toggling plus the
  full-width model selector held open over the live split view, no crash, and the
  accessibility tree confirms a real AppKit `splitter group`.
- `.inspector` **on the detail column**: crashes every time, reproducibly, on the
  Chat → Code switch. `SwiftUI.NSHostingView.updateConstraints` calls
  `setNeedsUpdateConstraints:` while the window's constraint pass is already
  running; AppKit throws from `-[NSWindow _postWindowNeedsUpdateConstraints]` and
  the process takes `SIGTRAP`. Crash report
  `JunoDesktop-2026-07-26-170247.ips`.
- `.inspector` **on the `NavigationSplitView` itself**: stable. Same test, no
  crash.

So the placement was the bug, not the pairing. Two rules now carry that fix and
must not be relaxed: every anchored popover declares an explicit `.frame`, and
toolbar items are always present and `.disabled()` rather than conditional.

### Signed UI tests — still the open gate

`JunoDesktopUITests` has not been run against this shell. The suite also needs
rewriting: it was authored against the previous hand-rolled column, so its
element queries do not match a `List(selection:)` source list, a real `.toolbar`,
or the project-grouped Code sidebar. Do not report a pass until the suite is
rewritten and run signed with `ENABLE_HARDENED_RUNTIME=NO`.

### Environment notes that cost real time

- **A signed build is required for any interactive verification.** An unsigned
  build has a different code identity from the one that created the Keychain
  item, so macOS raises a modal password prompt no automation can answer. Build
  with `-allowProvisioningUpdates CODE_SIGN_STYLE=Automatic
  DEVELOPMENT_TEAM=58PVP763WX`.
- **Launch the executable directly, not through `open -n`.** `open` hands
  arguments to LaunchServices, which can reuse or "reopen" a just-terminated
  instance and bring the process up with the arguments applied but no window ever
  created — the app becomes frontmost, its menu bar appears, and there is nothing
  to capture.
- **`screencapture -R x,y,w,h`** takes points and resolves the display's backing
  scale itself. Capturing the screen and cropping in pixels means reproducing
  that scale by hand.
- The DEBUG preview harness used to open the production encrypted store before
  discarding it for its throwaway world, which is what raised the Keychain prompt
  on QA launches. It no longer composes the live configuration at all.
