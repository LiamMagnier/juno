# Juno Native — Operational Handoff

Updated: 2026-07-21 22:00 Europe/Paris

## Resume here

- Branch: `agent/juno-native`
- Current completed implementation commit: `b903159ad678f773f5cdbe2e64a926ffa68e6564`
- Native worktree: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-primary`; shared package/project files under `native/**` are active uncommitted work from parallel builders.
- Main checkout: independently on `main` at `e0d1285`, with pre-existing Remote Session changes. Never reset, restore, clean, or stage those files from native work.
- Current phase: shared Swift foundation and independent project skeletons.
- Current task: implement and test `JunoNativeKit`, then generate separate `JunoMac.xcodeproj` and `JunoMobile.xcodeproj`; do not ship the monolithic prototype.

## Actually completed

- Full master prompt and continuity addendum read.
- Repository/backend/OpenAPI/release/toolchain baseline captured.
- Web baseline passes (`npx tsc --noEmit`, `npm test`; lint has warnings only).
- Local prototype found at `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild`; Debug and Release macOS builds succeed with Xcode 27 beta/signing disabled, and 34/34 macOS tests pass.
- The same prototype fails its Debug iOS Simulator build at `AuthSession.swift:73` because it calls macOS-only `Host.current()` and sends `platform: "macOS"`; do not label it a functional iOS client.
- Official OpenAI/Apple/Anthropic research completed and summarized in `RESEARCH.md`.
- Audit and handoff baseline committed as `1de5cda`.
- Callback/version drift resolved in `b903159`: server/OpenAPI are at 1.0.1, new clients use the canonical reverse-DNS callback, legacy remains an exact migration allowlist value, and generated Swift is self-contained.

No new production native application is complete yet. Do not describe the prototype or legacy DMG as the requested finished release.

## Open next

1. `native/Packages/JunoNativeKit/Package.swift`
2. `native/Packages/JunoNativeKit/Sources/`
3. `native/Packages/JunoNativeKit/Tests/`
4. `native/macOS/JunoMac/`
5. `native/iOS/JunoMobile/`
6. `docs/native/ARCHITECTURE.md`
7. `docs/native/API_GAPS.md`

## Next exact work

1. Create `native/Packages/JunoNativeKit/Package.swift` with the documented acyclic targets.
2. Add platform-neutral core/API/auth primitives and deterministic Swift tests.
3. Run package tests with strict concurrency enabled and correct introduced failures.
4. Create independent `native/macOS/JunoMac/JunoMac.xcodeproj` and `native/iOS/JunoMobile/JunoMobile.xcodeproj` projects.
5. Migrate storage/sync/search before feature UI.

## Commands to run next

```bash
cd /Users/liammagnier/Desktop/workspace/.worktrees/juno-native-primary
git status --short --branch
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -version
git show --stat b903159
```

After the package exists:

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path native/Packages/JunoNativeKit
```

## Test record

Passing:

- `npx tsc --noEmit`
- `npm run lint` (exit 0; three existing warnings)
- `npm test`
- prototype Debug macOS unsigned `xcodebuild build`
- prototype Release macOS unsigned `xcodebuild build`
- prototype macOS tests (34/34)
- native callback/contract tests
- Web TypeScript typecheck after contract version bump
- generated Swift contract strict-concurrency typecheck

Failed/blocked:

- restricted-sandbox `npm test` (`tsx` IPC `EPERM`); approved rerun passed.
- unqualified `xcodebuild` because `xcode-select` points at Command Line Tools; use `DEVELOPER_DIR`.
- simulator discovery in restricted sandbox; run Xcode commands with approved access.
- prototype Debug iOS Simulator build: `Host` unavailable in `AuthSession.swift`; fix by platform-specific device metadata during migration, not by patching the read-only prototype.

## Decisions not to reopen without evidence

- Preserve and extend the current Web backend; native clients never access PostgreSQL.
- Keep Mac-authoritative Remote sessions; the server is the authenticated registry/relay/snapshot index.
- Salvage the local prototype, but do not copy its monolithic topology or production demo/BYOK paths.
- Use system SwiftUI/AppKit navigation and controls; screenshots are interaction references, not pixel targets.
- Store native credentials in Keychain and use bearer device sessions; never convert Auth.js cookies into native identity.
- Keep decrypted full-text search local and wipe it on logout/revocation/account switch.
- Do not publish until independent Debug/Release builds, required tests, signing gates, and secret scans pass.

## Work not to repeat

- Do not repeat the general repository audit unless these docs become stale.
- Do not recreate the prototype from scratch; inspect and migrate it selectively.
- Do not re-research basic Codex/Claude Remote and Apple Liquid Glass principles; sources and conclusions are in `RESEARCH.md`.
- Do not treat `public/downloads/Juno.dmg` as a fresh validated build.

## Real blockers / user actions

- GitHub CLI token is invalid; user must complete `gh auth login -h github.com` before publication.
- Signed macOS/iOS distribution requires Apple developer identities/profiles and App Store/Notary access not present in the repository.
- StoreKit product mapping and APNs credentials need owner-provided production values.

Continue all non-proprietary implementation and validation before asking for those inputs.
