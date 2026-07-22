# Juno Native — Status

Last updated: 2026-07-22 03:05 Europe/Paris

## Repository state

- Branch: `agent/juno-native-claude-continuation` (continuation of `agent/juno-native`; PRs target `agent/juno-native`, never `main`).
- Current completed implementation commit: `778a47d` (`feat(native): add real memory and settings`).
- Native worktree: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-claude`.
- Known unstaged Xcode 27 project/scheme and String Catalog rewrites remain
  preserved outside the implementation commits; inspect rather than resetting them.
- Main checkout: `/Users/liammagnier/Desktop/workspace/juno` remains independently on `main` at `e0d1285`, with pre-existing Remote Session changes untouched by this run.
- Remote: `origin https://github.com/LiamMagnier/juno.git`.
- GitHub CLI: installed, but the stored `LiamMagnier` token is invalid.

## Current phase

All functional units are complete: production auth, storage, sync, chat, projects/
files, library/artifacts, memory/settings, offline search, mutation-conflict
resolution, the offline/reconnect proof, and the Juno Code macOS integration.
Cloud/Remote Code stays gated on backend routes (GAP-021, out of scope this run).

Current work is the **native UI/UX refresh** (owner-directed, option 2), designed
for the OS 27 SDK (Liquid Glass gen-27, newest SwiftUI) with iOS 18 / macOS 15
kept as minimum deployment targets via availability checks. Sequential units:

1. Navigation architecture + sidebar — **done** (`65bc78d`): grouped resizable/
   collapsible macOS sidebar with @SceneStorage selection restoration and context
   menus; adaptive iOS `TabView(.sidebarAdaptable)`; dead Tasks/Connections and
   GAP-021 Cloud/Remote sections removed so every destination is real; account/
   sign-out moved to Settings, sync to the Chat toolbar.
2. Chat & composer — in progress.
3. Product screens + real states.
4. Design system & Liquid Glass.
5. Responsive, motion, accessibility, visual validation.

## Actually completed

- General repository/backend/OpenAPI/toolchain/prototype audit and official research; do not repeat while these documents remain current.
- Persistent native audit/handoff baseline in `1de5cda`.
- Canonical callback/version alignment and deterministic Swift contract generation in `b903159`.
- Acyclic Swift 6 package `JunoNativeKit` with ten products: Core, API, Auth, Storage, Sync, Search, DesignSystem, ChatKit, CodeKit, and VoiceKit.
- Strict-concurrency API validation, PKCE/token coordination, account-scoped storage abstractions, cursor/outbox logic, local-search contract, and chat/code/voice reducers.
- 156 focused JunoNativeKit tests plus 179 JunoCode tests, all passing with
  warnings treated as errors and complete strict-concurrency checking.
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
- Persisted bootstrap and cursor catch-up use the existing entity inventory,
  `/entities`, `/changes` and real `/changes/stream` SSE routes.
- Atomic pages, tombstones, revisions, compaction rebuild, reconnect
  backoff/jitter, account isolation and an encrypted durable mutation outbox are
  composed into both apps in `364f0f2`.
- Real account conversations/messages are projected from encrypted SQLite in
  `0cb44d8`; both apps now provide native list/detail, loading/empty/error/offline
  states and durable create, rename, model, pin and archive actions.
- Real saved-conversation chat in `6e20050`: both apps compose the existing
  bearer-capable model catalog, idempotent message append and production
  `/api/chat` SSE stream with progressive answer/reasoning/sources, stop, retry,
  bounded reconnect reconciliation and duplicate prevention. OpenAPI 1.1.0
  publishes these existing routes; no chat service or route was added.
- Real projects and files in `35fce4a`: encrypted account-scoped projection,
  durable create/edit/favorite/delete, linked conversations, bearer uploads,
  fresh signed-file hydration, rename/delete/preview, global mobile file list,
  and loading/empty/error/offline states. The only server change extends the
  existing native `project.update` mutation with the already-supported
  `starred` field recorded as GAP-020; no route or project service was added.
- Real library and artifacts in `719db31`: synchronized encrypted attachment
  browsing and file actions, account-scoped offline artifact/version history,
  direct bearer refresh, optimistic edit/restore conflicts, rename/delete,
  detected Office export and native HTML/SVG/Markdown/source previews on both
  apps. Existing `/api/library` and `/api/artifacts` routes were published in
  the native OpenAPI contract; no backend route or service was added.
- Real memory and settings in `778a47d`: synchronized encrypted memory-entry
  and settings projection with strict account isolation, offline reads,
  optimistic `memory.create/update/delete` and `settings.update` mutations on
  the durable outbox, revision-conflict detection with keep-mine/use-server
  resolution, summary hydration through the existing `GET /api/memory`,
  explicit-acknowledgement permanent reset via `DELETE /api/memory`, and full
  settings/memory forms with loading/empty/error/offline/confirmation states
  on both apps. The existing `/api/memory` route was published in OpenAPI
  1.2.0 (mirrored in `CONTRACT_VERSION`); no backend route or service was
  added. Unknown stored preference values remain selectable rather than being
  silently rewritten.
- Real offline global search: query-time projection of the encrypted
  synchronized conversations, messages, projects, files, artifacts and
  memories through the JunoSearch normalization/scoring contract in a
  throwaway in-memory index — nothing searchable is persisted in plaintext.
  Both apps compose a real Search section with debounce, cancellation,
  grouped ranked results, diacritic-insensitive matching and navigation into
  chats, projects, library/files, artifacts and settings.
- Mutation-conflict resolution across conversations and projects, matching the
  memory/settings pattern: `resolveConflicts(keepLocalChanges:)` retries every
  conflicted outbox item against the freshly synced revision or discards it in
  favor of the server version, with keep-mine/use-server banners in both apps.
- Durable offline/reconnect proof: a package test shows a mutation enqueued
  while offline survives an app relaunch (new outbox/drainer over the same
  repository), submits exactly once on reconnect with its original idempotency
  key, and that ambiguous response loss replays the same clientMutationId so
  the server receipt makes it a no-op rather than a duplicate.
- Juno Code macOS integration (PR #17 merged in `677d781`): the `JunoCode`
  Swift package (Core/Local/Runtime/UI/Bridge, 179 strict tests), the
  standalone `JunoCode` app, and a Code section composed into `JunoMac` via
  `JunoMacCodeView` driven by the authenticated `NativeChatRequestSending`
  transport. The merge kept both sides' additive wiring
  (`memorySettingsModel`/`searchModel` and `chatTransport`/`accountID`) and
  regenerated `JunoMac.xcodeproj` from the merged `project.yml`. No
  JunoNativeKit, backend, iOS, prisma, or contract file was changed by PR #17.
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
- Juno Code Remote Host, Cloud Code, and Remote mobile — all gated on backend Code-session routes that do not yet exist (see `API_GAPS.md` GAP-021).
- Complete generated API/chat/upload/account/Code/Remote/voice/notification contracts and native transport integration.
- Functional macOS and iOS/iPadOS chat, search, settings, Cloud Code, Remote, approvals, and accessibility behavior.
- Native CI, UI/E2E/accessibility/performance suites, Release/archive dry runs, dependency/secret scans, and artifact provenance.
- Production artwork: the current 1024 px icon is mechanically upscaled from the repository's 512 px source and must be replaced before release.
- Apple signing/provisioning/notarization/TestFlight/App Store work and GitHub publication.

## Passing commands

- `npm run native:contract:check`
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift build --package-path native/Packages/JunoNativeKit --configuration release --scratch-path "$(mktemp -d)" -Xswiftc -warnings-as-errors -Xswiftc -strict-concurrency=complete`
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path native/Packages/JunoNativeKit --scratch-path "$(mktemp -d)" -Xswiftc -warnings-as-errors -Xswiftc -strict-concurrency=complete` — 156/156 tests.
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project native/macOS/JunoMac/JunoMac.xcodeproj -scheme JunoMac -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/juno-mac-foundation-derived CODE_SIGNING_ALLOWED=NO build`
- Same macOS project/scheme with `-configuration Stable` and `/tmp/juno-mac-stable-derived`.
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path native/Packages/JunoCode --scratch-path "$(mktemp -d)" -Xswiftc -warnings-as-errors -Xswiftc -strict-concurrency=complete` — 179/179 tests.
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project native/macOS/JunoCode/JunoCode.xcodeproj -scheme JunoCode -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/juno-code-standalone-debug CODE_SIGNING_ALLOWED=NO build`
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

Juno Code Remote Host and Cloud/Remote Code are gated on backend Code-session
routes that do not exist yet (GAP-021): create/resume a Code session, ordered
resumable session events, idempotent commands (prompt/approve/deny/stop), and
Remote Host addressing by opaque workspace ID. The local `JunoCodeCore`
`SessionEventPayload` model was shaped for a 1:1 mapping when those routes land.

Because this exceeds the "minimal extension to an existing route/mutation"
constraint and needs a real backend design (routes, migrations, auth,
streaming) plus owner sign-off, do not invent it unilaterally. Either:

1. escalate GAP-021 to the owner for a backend contract decision, then map the
   existing `JunoCodeBridge` payloads onto the new routes; or
2. proceed to the UI/UX refresh (macOS + iPhone) and accessibility work, which
   is unblocked, and return to Cloud/Remote Code once the routes exist.

Open first:

1. `docs/native/JUNO_CODE_HANDOFF.md` ("Not implemented yet" + "Backend needs")
2. `docs/native/API_GAPS.md` GAP-021
3. `native/Packages/JunoCode/Sources/JunoCodeBridge`
4. `contracts/openapi/juno-native-v1.yaml`

Keep the backend unchanged unless route/contract/old-client inspection proves a
real gap and records it in `API_GAPS.md`.
