# Juno Native — Operational Handoff

Updated: 2026-07-22 01:26 Europe/Paris

## Resume here

- Branch: `agent/juno-native`
- Current completed implementation commit: `6e20050da149ee7bc057a637274edc8e06d7ac8f` (`feat(native): stream real Juno chat`)
- Worktree: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-primary`
- Working tree: known unstaged Xcode 27 project/scheme and String Catalog rewrites are preserved outside implementation commits.
- Current phase: projects and files.
- Current task: production chat streaming is complete.
- Next exact action: reuse the existing project/file routes, sync entities and old native clients for native project and file surfaces.

The main checkout at `/Users/liammagnier/Desktop/workspace/juno` is independently
on `main` at `e0d1285` with pre-existing Remote Session changes. Never reset,
clean, restore, stage, or commit those files from this native worktree.

## Actually completed

- General repository/backend/OpenAPI/toolchain/prototype audit; baseline commit `1de5cda`.
- Canonical callback and OpenAPI/backend/Swift-generation alignment; implementation commit `b903159`.
- `JunoNativeKit` Swift 6 package with ten acyclic products and 119 strict-concurrency tests.
- Security.framework-backed, device-local `KeychainAuthTokenStore` with active-account restoration, account-switch purge, serialized compare-and-swap, and ten focused tests.
- Canonical PKCE-S256 browser authorization, strict callback correlation, existing token/refresh/session/logout route client, authoritative session validation, and production app composition on macOS and iOS.
- Refresh-aware same-origin bearer transport and a fail-closed checkpoint client for the existing `/api/v1/bootstrap` route, with account, contract, cursor and model-manifest validation.
- Deterministic generated Swift contract and local drift command.
- Storage/sync/search foundations: account-scoped store protocol, deterministic in-memory test adapter, cursor application, mutation outbox, and local-search contract.
- Production encrypted SQLite repository with explicit schema checks, WAL/FULL
  durability, optimistic transactions, protected files, per-account wipe and an
  atomic device-local Keychain key.
- Atomic installation of fully hydrated bootstrap entities plus cursor/floor and
  model-manifest metadata; both apps open this repository and auth lifecycle
  purges it before credential removal.
- Production synchronization in `364f0f2`: persisted bootstrap/cursor, entity
  hydration, atomic pages, tombstones/revisions, real SSE wakeups, compaction
  rebuild, reconnect backoff/jitter, strict account isolation and encrypted
  durable mutation outbox/drainer.
- Real conversation/message projection and both native list/detail surfaces in
  `0cb44d8`, including durable create, rename, model, pin and archive mutations.
- Real chat in `6e20050`: native composer/model/effort controls, idempotent user
  append, production SSE, progressive response/reasoning/sources, cancellation,
  retry and sync-based reconnect without duplicate POSTs on ambiguous loss.
- Independent macOS and iOS projects with Debug/Stable/Next configs, EN/FR catalogs, privacy manifests, callback scheme, skeleton entitlements, unit/UI test targets, and app assets.
- Debug and Stable unsigned builds pass for both projects; macOS Stable is universal.
- macOS unit tests 2/2 and iOS unit tests 2/2 pass.
- All three active lots integrated in `0fb7cc3`.

This is a compile-verified foundation, not a feature-complete app or release.

## Open next

1. `src/app/api/projects`
2. `src/lib/sync-entities.ts`
3. `native/Packages/JunoNativeKit/Sources/JunoSync`
4. the old native project's project/file clients (read-only source lineage)

## Commands to run next

```bash
cd /Users/liammagnier/Desktop/workspace/.worktrees/juno-native-primary
git status --short --branch
git log -3 --oneline
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test \
  --package-path native/Packages/JunoNativeKit \
  --scratch-path "$(mktemp -d)" \
  -Xswiftc -warnings-as-errors -Xswiftc -strict-concurrency=complete
npm run native:contract:check
```

After durable storage is composed into the apps, rerun the package suite and both Debug builds:

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild \
  -project native/macOS/JunoMac/JunoMac.xcodeproj -scheme JunoMac \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath /tmp/juno-mac-next-derived CODE_SIGNING_ALLOWED=NO build

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild \
  -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/juno-mobile-next-derived CODE_SIGNING_ALLOWED=NO build
```

## Test record

Passing:

- `npm run native:contract:check`.
- Strict Release package build with `-warnings-as-errors`.
- Strict package suite: 119/119 tests, including Auth 35/35, Storage 11/11, Sync 37/37 and ChatKit 11/11.
- JunoMac Debug and Stable unsigned builds.
- JunoMobile Debug and Stable simulator builds.
- JunoMac unit tests: 2/2.
- JunoMobile unit tests: 2/2.
- Earlier Web typecheck/lint/test baseline and callback contract tests.

Failed, unrun, or pre-existing:

- Live account completion was not run because it requires an interactive browser session; the sign-in gate UI tests pass 1/1 on macOS and 1/1 on iOS.
- Next configurations were generated/inspected but not compiled separately.
- The default package `.build` path inside the Desktop/File Provider worktree can fail product signing due Finder metadata/resource forks; use an isolated `/tmp` scratch path.
- `xcodebuild` without `DEVELOPER_DIR` selects Command Line Tools and fails.
- The separate monolithic prototype's iOS build has the pre-existing macOS-only `Host.current()` error. Do not patch or ship the prototype.
- Three pre-existing Web React Hook warnings remain.

## Uncommitted changes

Known preserved changes: iOS Xcode 27 project/scheme rewrites and both generated
String Catalog rewrites. They are not part of `6e20050`; inspect before staging
and do not reset them or the independent main checkout.

## Decisions not to reopen without evidence

- Two independent app projects; shared code only through acyclic local packages.
- Existing backend remains authoritative; native never accesses PostgreSQL.
- Canonical reverse-DNS callback, exact legacy callback retained server-side only.
- Bearer device sessions plus Keychain; no Web-cookie identity, direct provider credentials, demo/BYOK production paths, or token logging.
- In-memory store/search implementations are test/development adapters, not production persistence.
- Mac-authoritative Remote sessions and native system navigation/materials.
- No publication before CI, archive, signature, privacy, secret, and notarization/TestFlight gates pass.

## Work not to repeat

- Do not repeat the general repository audit or basic OpenAI/Anthropic/Apple research while these docs are current.
- Do not rebuild the package/project skeletons or reintroduce a monolithic multiplatform project.
- Do not recreate the generated contract manually; use the generator and drift command.
- Do not treat the local prototype or `public/downloads/Juno.dmg` as release-ready.
- Do not rerun or modify the three completed lots unless a concrete regression is demonstrated.

## Remaining work

- Projects/files and mutation conflict UI.
- Production search persistence and live-account offline/reconnect proof.
- Full typed chat/upload/account/Code/Remote/voice/push contracts.
- Functional feature UI on macOS and iOS/iPadOS.
- UI/E2E/accessibility/performance/secret/dependency gates and native CI.
- Production artwork, signed archives, notarized macOS distribution, and TestFlight/App Store delivery.

## Real blockers / user actions

- GitHub CLI token is invalid; `gh auth login -h github.com` is required before push/release.
- Apple bundle-ID reservation, Team/signing/provisioning, App Store Connect, Developer ID, and notarization inputs are unavailable.
- StoreKit product mapping and APNs credentials require owner-provided production values.

Continue non-proprietary implementation sequentially. Ask for these inputs only
when the corresponding release/commerce/notification gate is reached.
