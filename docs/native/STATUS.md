# Juno Native — Status

Last updated: 2026-07-21 21:45 Europe/Paris

## Repository state

- Branch: `agent/juno-native`
- Current commit: `be6db2564c97a346739043b54b9b816bd8e582a3` (`chore: untrack .claude/launch.json (local Claude state, already gitignored)`)
- Native worktree: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-primary`; it is isolated on `agent/juno-native` and currently contains only the uncommitted `docs/native/**` audit baseline.
- Main checkout: a concurrent task returned `/Users/liammagnier/Desktop/workspace/juno` to `main` and committed `e0d1285`. Its existing Remote Session changes remain there, untouched and unstaged by this native run.
- Remote: `origin https://github.com/LiamMagnier/juno.git`
- GitHub CLI: installed, but the stored `LiamMagnier` token is invalid as of this update.

## Initial baseline

- The active checkout had no `native/` directory, Swift package, Swift source, Xcode project, entitlement, or privacy manifest.
- A separate local prototype exists at `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild` with about 35,845 lines of Swift and one monolithic `Juno.xcodeproj` targeting iOS and macOS.
- The prototype Debug macOS target builds successfully with Xcode 27 beta when signing is disabled.
- The prototype Debug iOS Simulator target fails to compile because `AuthSession.swift` uses macOS-only `Host.current()` and hardcodes `platform: "macOS"`; this confirms that the single target is not a valid mobile application despite listing iOS as a supported platform.
- The prototype cannot be shipped unchanged: it violates the required two-project topology, targets both platforms from one app target, and contains demo/BYOK/provider-key paths that production must not expose.
- Existing Web/backend foundations include native PKCE/device sessions, bearer APIs, bootstrap/change feed/entities/mutations, Cloud Code, agent core, voice relay, and uncommitted Remote Session routes.

## Current phase

Phase 1 — forensic audit, persistent handoff, and safe prototype-salvage plan.

Current task: establish the native documentation baseline, audit the local prototype, then migrate validated code into independent macOS and iOS/iPadOS projects backed by shared Swift packages.

## Completed

- Read the full master prompt and continuity addendum.
- Inspected Git status, branch, history, remotes, worktrees, local prototypes, Web routes, native OpenAPI, toolchain, and release artifacts.
- Created branch `agent/juno-native` without disturbing pre-existing changes.
- Established the Web baseline.
- Located Xcode 27 beta at `/Applications/Xcode-beta.app`; the global developer directory still points at Command Line Tools.
- Built the local monolithic prototype for Debug and Release macOS with code signing disabled; its 34 macOS unit tests pass.
- Ran the prototype iOS Simulator build and captured its existing platform-coupling failure.
- Consulted current official OpenAI, Apple, and Anthropic product/security/design documentation; conclusions are in `RESEARCH.md`.

## Remaining

- Finish prototype safety/parity audit and record salvage inventory.
- Resolve callback URI compatibility across backend, OpenAPI, generator, and both apps.
- Create shared Swift packages for API, auth, sync, storage, search, chat, Code, voice, and design system without circular dependencies.
- Create independent `JunoMac.xcodeproj` and `JunoMobile.xcodeproj` projects and migrate validated features.
- Complete typed API/Remote contracts and generation drift checks.
- Implement and verify auth, single-flight refresh, Keychain, sync, offline queue, conflicts, local search, chat, Cloud Code, Remote Host/mobile, approvals, Computer Use controls, accessibility, localization, and release tooling.
- Add native CI, Release builds, tests, archives, secret scans, and signed distribution gates.
- Authenticate GitHub, obtain Apple signing/notarization/TestFlight inputs, publish only after all gates pass.

## Files currently modified before this run

- `prisma/schema.prisma`
- `src/app/api/code/devices/route.ts`
- `src/app/api/code/tasks/route.ts`
- `src/lib/code-remote.ts`
- `prisma/migrations/20260719120000_remote_code_sessions/migration.sql` (untracked)
- `src/app/api/code/devices/[deviceId]/**` (untracked)
- `src/lib/code-remote-sessions.ts` (untracked)
- `src/lib/code-session-command-route.ts` (untracked)
- `tests/code-remote-sessions.test.ts` (untracked)

These files appear related to the requested Remote work, but ownership predates this run. Keep them isolated from native documentation commits until reviewed.

They live only in the main checkout. The dedicated native worktree does not contain these uncommitted changes.

## Commands executed

### Passing

- `npx tsc --noEmit`
- `npm run lint` — exits 0 with three pre-existing React hook warnings.
- `npm test` — 121 Node tests plus auth, message-crypto, and moderation scripts pass.
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project /Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild/Juno.xcodeproj -scheme Juno -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/juno-prototype-derived CODE_SIGNING_ALLOWED=NO build`
- Prototype unsigned macOS Release build.
- Prototype macOS tests — 34/34 pass.

### Initially failed because of environment restrictions

- `npm test` inside the restricted sandbox: `tsx` could not create its IPC socket (`listen EPERM`). The same command passed with approved local execution.
- `xcodebuild` without `DEVELOPER_DIR`: active directory was `/Library/Developer/CommandLineTools`. Use the explicit Xcode beta path.
- `simctl` inside the restricted sandbox: CoreSimulatorService was unavailable. Use approved Xcode execution for simulator builds/tests.
- Prototype iOS Simulator build after simulator access was approved: compile error at `Juno/Services/Backend/AuthSession.swift:73` (`Host` is unavailable on iOS), plus a hardcoded macOS platform value. This is a prototype defect, not a regression in the active checkout.

## Known pre-existing issues

- ESLint warnings:
  - `src/components/canvas/sandbox-frame.tsx`: unnecessary `runNonce` dependency.
  - `src/components/chat/chat-view.tsx`: two effects omit `chat.messages`.
- Native OpenAPI accepts only legacy `juno://auth/callback`, while the backend canonical URI is `com.liammagnier.juno://auth/callback`.
- The current OpenAPI covers core native auth/sync but not most Chat, Upload, Voice, Code, Remote, StoreKit, or notification contracts.
- `public/downloads/Juno.dmg` and `latest.json` are legacy artifacts, not evidence that the requested new clients are ready.

## Proprietary blockers

- Valid GitHub authentication for push, PR, tag, and GitHub Release.
- Apple Developer Team, reserved bundle identifiers, signing certificates/profiles, App Store Connect/TestFlight access, Developer ID identity, and notarization credentials.
- Production StoreKit product identifiers/server mapping and APNs credentials.

## Next exact action

Finish the prototype audit, then generate the new package/project skeleton and run:

```bash
cd /Users/liammagnier/Desktop/workspace/juno
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path native/Packages/JunoNativeKit
```

Do not begin feature migration until `ARCHITECTURE.md`, `DECISIONS.md`, `PARITY_MATRIX.md`, `API_GAPS.md`, and `HANDOFF.md` agree on the source topology and trust boundaries.
