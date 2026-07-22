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
