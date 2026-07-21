# Juno Native — Operational Handoff

Updated: 2026-07-21 21:45 Europe/Paris

## Resume here

- Branch: `agent/juno-native`
- Commit at audit start: `be6db2564c97a346739043b54b9b816bd8e582a3`
- Native worktree: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-primary`; only `docs/native/**` is uncommitted while this audit baseline is being finalized.
- Main checkout: independently on `main` at `e0d1285`, with pre-existing Remote Session changes. Never reset, restore, clean, or stage those files from native work.
- Current phase: audit and safe salvage of a local Swift prototype.
- Current task: split validated prototype capabilities into two independent apps and shared packages; do not ship the monolithic prototype.

## Actually completed

- Full master prompt and continuity addendum read.
- Repository/backend/OpenAPI/release/toolchain baseline captured.
- Web baseline passes (`npx tsc --noEmit`, `npm test`; lint has warnings only).
- Local prototype found at `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild`; Debug and Release macOS builds succeed with Xcode 27 beta/signing disabled, and 34/34 macOS tests pass.
- The same prototype fails its Debug iOS Simulator build at `AuthSession.swift:73` because it calls macOS-only `Host.current()` and sends `platform: "macOS"`; do not label it a functional iOS client.
- Official OpenAI/Apple/Anthropic research completed and summarized in `RESEARCH.md`.

No new production native application is complete yet. Do not describe the prototype or legacy DMG as the requested finished release.

## Open next

1. `docs/native/ARCHITECTURE.md`
2. `docs/native/DECISIONS.md`
3. `docs/native/PARITY_MATRIX.md`
4. `docs/native/API_GAPS.md`
5. `docs/native/STATUS.md`
6. `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild/Juno/Services/Backend/AuthSession.swift`
7. `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild/Juno/Services/Backend/SyncService.swift`
8. `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild/Juno/Services/Code/RemoteCodeHost.swift`
9. `contracts/openapi/juno-native-v1.yaml`

## Next exact work

1. Finish identifying prototype files that are safe to migrate and the code that must be rejected (demo data, direct provider keys, monolithic platform coupling).
2. Create `native/Packages/JunoNativeKit/Package.swift` with acyclic targets and tests.
3. Create independent `native/macOS/JunoMac/JunoMac.xcodeproj` and `native/iOS/JunoMobile/JunoMobile.xcodeproj` projects.
4. Migrate API/auth/sync first; run Swift tests before migrating UI.

## Commands to run next

```bash
cd /Users/liammagnier/Desktop/workspace/juno
git status --short --branch
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -version
rg -n 'mock|demo|BYOK|useDirectProviders|apiKey|ProviderClient|fatalError|TODO' /Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild/Juno
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
