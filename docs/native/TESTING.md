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
