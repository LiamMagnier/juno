# Juno Native — Status

Last updated: 2026-07-21 23:55 Europe/Paris

## Repository state

- Branch: `agent/juno-native`
- Current completed implementation commit: `9bceb7ee3634f6bd32a9c3dbe05bfee0a8defed7` (`feat(native): add encrypted SQLite account storage`).
- Native worktree: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-primary`.
- Expected working tree at this handoff boundary: clean after the documentation commit.
- Main checkout: `/Users/liammagnier/Desktop/workspace/juno` remains independently on `main` at `e0d1285`, with pre-existing Remote Session changes untouched by this run.
- Remote: `origin https://github.com/LiamMagnier/juno.git`.
- GitHub CLI: installed, but the stored `LiamMagnier` token is invalid.

## Current phase

Phase 2 production auth and encrypted account storage are complete. The next
sequential unit is hydration and incremental synchronization over the existing
`/api/v1/entities`, `/changes`, and `/changes/stream` routes.

## Actually completed

- General repository/backend/OpenAPI/toolchain/prototype audit and official research; do not repeat while these documents remain current.
- Persistent native audit/handoff baseline in `1de5cda`.
- Canonical callback/version alignment and deterministic Swift contract generation in `b903159`.
- Acyclic Swift 6 package `JunoNativeKit` with ten products: Core, API, Auth, Storage, Sync, Search, DesignSystem, ChatKit, CodeKit, and VoiceKit.
- Strict-concurrency API validation, PKCE/token coordination, account-scoped storage abstractions, cursor/outbox logic, local-search contract, and chat/code/voice reducers.
- 96 focused Swift package tests, all passing with warnings treated as errors.
- Security.framework-backed token persistence with device-local accessibility,
  disabled Keychain sync, account/device validation, serialized rotation/removal,
  malformed-data failure, and an injectable Security client.
- System-browser PKCE-S256 auth on macOS/iOS, canonical callback/state/nonce checks,
  existing production auth-route transport, refresh-aware restore, logout, local
  account-switch purge, signed-in gates and EN/FR auth UI.
- Same-origin bearer requests with one bounded 401 refresh/retry and a typed
  checkpoint client for the existing `/api/v1/bootstrap` route; no backend route
  or duplicate service was added.
- Versioned SQLite repository with WAL/FULL durability, structural schema
  verification, AES-GCM account/context binding, optimistic atomic transactions,
  tombstones, protected files, per-account cascades and secure wipe.
- Device-local atomic Keychain database key creation, fail-closed missing-key
  recovery, and purge-before-credential-removal across sign-out, revocation,
  terminal refresh and account switching.
- Fully hydrated bootstrap records and their validated cursor/floor/manifest are
  installed in one transaction; the cursor is never advanced before hydration.
- Both app composition roots now open the production encrypted repository.
- Deterministic checked-in Swift contract plus `npm run native:contract:check` drift command.
- Independent `JunoMac.xcodeproj` and `JunoMobile.xcodeproj`, generated from separate XcodeGen specifications.
- Debug, Stable, and Next configuration layers; canonical callback scheme, EN/FR String Catalogs, privacy manifests, empty skeleton entitlements, and app icon catalogs.
- macOS Debug and Stable unsigned builds; Stable is universal `arm64` + `x86_64`.
- iOS Debug and Stable simulator builds for `arm64` + `x86_64`.
- macOS unit tests 2/2 and iOS unit tests 2/2.
- The three active implementation lots were reviewed and committed together as `0fb7cc3`.

The app shells are compile-verified foundations, not feature-complete production
applications and not downloadable releases.

## Remaining

- Interactive live-account browser completion and connected-device management UI.
- Production entity hydration, changes/stream consumption, durable offline outbox,
  crash/network/compaction recovery, backoff and conflict UI.
- Complete generated API/chat/upload/account/Code/Remote/voice/notification contracts and native transport integration.
- Functional macOS and iOS/iPadOS chat, search, settings, Cloud Code, Remote, approvals, and accessibility behavior.
- Native CI, UI/E2E/accessibility/performance suites, Release/archive dry runs, dependency/secret scans, and artifact provenance.
- Production artwork: the current 1024 px icon is mechanically upscaled from the repository's 512 px source and must be replaced before release.
- Apple signing/provisioning/notarization/TestFlight/App Store work and GitHub publication.

## Passing commands

- `npm run native:contract:check`
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift build --package-path native/Packages/JunoNativeKit --configuration release --scratch-path /tmp/juno-native-kit-sqlite-release-final-3 -Xswiftc -warnings-as-errors`
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path native/Packages/JunoNativeKit --scratch-path /tmp/juno-native-kit-sqlite-final-3 -Xswiftc -warnings-as-errors` — 96/96 tests.
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project native/macOS/JunoMac/JunoMac.xcodeproj -scheme JunoMac -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/juno-mac-foundation-derived CODE_SIGNING_ALLOWED=NO build`
- Same macOS project/scheme with `-configuration Stable` and `/tmp/juno-mac-stable-derived`.
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/juno-mobile-foundation-derived CODE_SIGNING_ALLOWED=NO build`
- Same iOS project/scheme with `-configuration Stable` and `/tmp/juno-mobile-stable-derived`.
- `JunoMacTests` 2/2 and `JunoMobileTests` 2/2 through `xcodebuild test`.
- Earlier Web baseline: `npx tsc --noEmit`, `npm run lint` (warnings only), and `npm test`.

## Failed, unrun, and pre-existing

- Sign-in gate UI tests pass on macOS and iOS; live browser completion was not automated because it requires an authenticated interactive account session.
- Next-channel settings were generated and inspected but the Next configurations were not separately compiled.
- A package build using the default `.build` inside the Desktop/File Provider worktree can fail code signing because Finder metadata/resource forks are attached to products. The isolated `--scratch-path /tmp/...` commands above pass; this is an environment issue.
- Unqualified `xcodebuild` fails because `xcode-select` points to Command Line Tools; keep the explicit `DEVELOPER_DIR`.
- The read-only monolithic prototype's iOS target still fails at `AuthSession.swift:73` because it uses macOS-only `Host.current()` and hardcodes `platform: "macOS"`. Do not fix or ship that prototype.
- Three pre-existing Web React Hook lint warnings remain documented in `TESTING.md`.

## Decisions not to reopen without evidence

- Keep two independent app projects over acyclic local packages.
- Preserve the existing backend as source of truth; native clients never access PostgreSQL directly.
- Use canonical `com.liammagnier.juno://auth/callback`; retain the exact legacy callback server-side only during migration.
- Use bearer device sessions and Keychain; never reuse Web cookies or expose provider/BYOK keys in production clients.
- Treat in-memory storage/search implementations as deterministic test/development adapters only.
- Keep the Mac authoritative for local Remote sessions.
- Use native SwiftUI/AppKit navigation and restrained system Liquid Glass.
- Publish only after signed release gates pass; legacy DMG files are not release evidence.

## Real blockers and user actions

- Run `gh auth login -h github.com` before any push, PR, tag, or GitHub Release.
- Provide/confirm Apple Developer Team, reserved bundle identifiers, certificates/profiles, App Store Connect/TestFlight access, Developer ID identity, and notarization credentials.
- Provide production StoreKit mappings and APNs credentials when those phases start.

## Next exact action

Reuse the existing entity hydration and change-feed contracts to implement the
typed `/api/v1/entities` and `/api/v1/changes` clients, then compose atomic
bootstrap hydration and incremental page application over SQLite. Do not add a
server route: the required sync services already exist.

Open first:

1. `src/app/api/v1/entities/route.ts`
2. `src/app/api/v1/changes/route.ts`
3. `contracts/openapi/juno-native-v1.yaml`
4. `native/Packages/JunoNativeKit/Sources/JunoSync/CursorPageApplier.swift`
5. `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild/Juno/Services/Backend/SyncService.swift` (read-only)

Keep the backend unchanged unless route/contract/old-client inspection proves a
real gap and records it in `API_GAPS.md`.
