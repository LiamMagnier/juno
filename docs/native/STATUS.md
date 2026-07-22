# Juno Native — Status

Last updated: 2026-07-22 17:05 Europe/Paris

## Concurrent-session recovery (head `d48f41f`)

A second agent session was editing this worktree in parallel and was stopped. The
in-flight work was inspected and recovered rather than discarded:

- **Kept** — `WorkbenchModel.swift` + `JunoMacApp.swift`: the `--juno-code-ui-preview`
  harness, committed as `d48f41f` after two corrections. Session IDs were derived from
  `hashValue`, which is seeded per process and handed out different IDs on every launch;
  they are now slugged from the title. `context(for:)` fell through to the workspace
  reopen path under preview and surfaced a reopen error the user cannot act on; it now
  returns nil.
- **Reverted** — `JunoMobile.xcodeproj/project.pbxproj`: Xcode serialization churn
  (`lastKnownFileType` → `explicitFileType`, key reordering) **plus a leaked local
  `DEVELOPMENT_TEAM` signing identity**, which must never be committed.
- **Reverted** — `JunoMobile/Resources/Localizable.xcstrings`: an Xcode String Catalog
  rewrite that reformatted all 518 lines, marked 24 real translated keys
  `extractionState: "stale"`, and injected 242 auto-extracted keys with **no French
  values**. Committing it would have damaged the EN/FR catalog that Phase 7 must validate.

Both reverted diffs are preserved outside the repository in the session scratchpad.
Xcode is open against this worktree and will re-dirty `project.pbxproj`; stage by explicit
path and re-check `git status` before every commit.

### Preview harness — what it does and does not cover

`--juno-code-ui-preview` (macOS, DEBUG only, `--juno-preview-dark` for dark mode) is inert
by construction: throwaway temp storage, `bootstrap()` short-circuits so the session store
is never read, fixture workspaces are never registered and carry no security-scoped
bookmark — so `context(for:)` yields nil, `SessionController` is never built, and
`CommandExecutionService` is unreachable. The model client throws immediately.

It currently exercises the **sidebar only**: workspaces, tilde-abbreviated paths, git vs
non-git glyphs, favorites, all six status glyphs, and Today/Yesterday/This week/Earlier
grouping. Because no controller is ever created, it does **not** yet cover transcript,
reasoning, tool calls, terminal output, stderr, diffs, tests, checkpoints or approvals —
those need fixture-backed controllers and are the next Block 1 unit.

**Known open defect:** the session list scrolls under the pinned "New Code Session" button
without a bottom content inset, clipping the last row mid-height. Reproduced in both light
and dark at 1180×760.

## Mobile UI refresh — session log (head `b5dbc98`)

Screenshot-driven mobile corrections, all on `agent/juno-native-claude-continuation`
(PR #18), each built Debug+Stable, package strict, and visually inspected in the
iOS 27 simulator (light + dark) before commit:

- `feat(mobile): replace tab bar with adaptive sidebar` → reveal-style drawer
  (fixed sidebar layer; the full-size chat plate slides right with the iPhone
  corner radius, no scale, no veil). Custom dense sidebar (no List/Form), Juno
  header + glass Search, Projects/Library/Artifacts, pinned/recents, footer with
  a glass profile button and a translucent accent "Chat" capsule. Fixes the
  Library/Artifacts TabView-switch crashes (regression tests added).
- `feat(mobile): present settings in native modal sheet` → large sheet from the
  profile button, single NavigationStack, glass X (no root Back), Memory pushes
  with one Back.
- `feat(mobile): dock a liquid glass send button and humanize model names` →
  Send inside the composer (coral glass, → Stop on stream); model shown as
  "Claude Sonnet 4.6", never the raw id.
- `fix(mobile): rebuild compact composer actions popover` → small glass popover
  anchored to a "+" (morphs to ×). Only the wired **Add to project** action
  (server-validated `conversation.update` projectId patch; new
  `NativeConversation.projectId` + `setProject`). Camera/Photos/Files and Deep
  Research/Canvas are omitted, documented as **GAP-022 / GAP-023**.
- `feat(mobile): surface reasoning inline and above the answer` → "Thinking about
  your request" status during generation; collapsible coral "Reasoning" control
  above the answer.

### Phase 5 product-screen pass (head `1f9c27d`)

Continued on PR #18, each built Debug+Stable and inspected in the iOS 27
simulator (light + dark):

- `feat(mobile): redesign the projects list and detail` — compact plain list
  (no inset-grouped card), favorite star, human counts, Favorite/Rename/Delete
  context menu; detail gains a dedicated multiline "Edit instructions" editor
  sheet with a saving indicator. Realistic fixture project/file names.
- `feat(mobile): redesign the memory page around the web architecture` —
  "What Juno remembers", Memory summary + refresh, Pause memory toggle,
  collapsible "Manage edits", destructive Reset; single Back; no fabricated
  Work/Personal split (native summary is one string) and no Export (none exists).
- `feat(mobile): redesign library and artifacts lists` — plain lists with a
  searchable filter and coral type glyphs; Library rows show the resolved
  project name, not the raw `proj-…` id.
- **Search** reviewed and left unchanged: already a compliant debounced,
  grouped, accent-insensitive global search with all empty/error/loading states
  and VoiceOver hints.

### Juno Code macOS review + Phase 6 motion (head `cbd19cf`)

- **Juno Code macOS** (`JunoCodeUI` `WorkbenchView` + `SidebarView`,
  `AgentCanvasView`, `InspectorView`) was fully code-reviewed and found already
  compliant and high-quality: native resizable three-pane split, every run state
  (idle/running/waiting/failed/completed/cancelled), approvals with keyboard
  shortcuts, gutter diffs, stderr-coloured terminal, test detection/re-run,
  Git/Files/Context/Computer tabs, tilde-abbreviated paths (no raw paths/ids),
  no fake actions, full accessibility labels and ⌘N/⌘./⌘⏎/⌘⇧O/⌘⌥I shortcuts.
  **No changes warranted** (churning good code would risk regressions).
  Validated: JunoMac Debug ✓, JunoMac Stable ✓, JunoCode strict compile ✓.
  Populated-session visual QA needs a live workspace/runtime (the preview
  harness ships no Code workspaces), so it was validated by review + builds.
- `feat(native): add a shared JunoMotion token system` — `JunoMotion`
  (fast/standard/emphasized/spring + Reduce-Motion `reduced(_:when:)`) in the
  design system, applied across every mobile interaction (sidebar reveal,
  +→×, Send/Stop, reasoning disclosure, scroll-to-latest).

**Still open on PR #18:** Phase 7 (full a11y/Dynamic Type/keyboard + device
matrix across iPhone sizes, iPad split, macOS windows, FR/EN) and Phase 8 (a
complete visual-QA sweep of every surface × every preview scenario × light/dark).
Substantial per-surface visual QA was already done inline for each unit this
session, but the exhaustive matrix remains. **Phases 9–13** (attachments/parity
resolving GAP-022/023, Deep Research, Canvas, Juno Code Remote Host, Cloud
isolation, security threat model, release integration) are untouched on PR #18;
Remote/Cloud belong on the stacked backend branch (PR #19), not here.

`prisma/` untouched all session; the release MUST take the backfill migration
verbatim from `origin/main` (typed `NULL::timestamp`) — see RELEASE.md.

**Exact next step:** Phase 7/8 exhaustive QA on the mobile surfaces (start by
capturing `empty`, `offline`, `error`, `conflict`, `longText` scenarios for
chat/projects/memory/library/artifacts in light+dark and fixing any truncation/
overlap/contrast found), then move to the backend worktree
`/Users/liammagnier/Desktop/workspace/.worktrees/juno-code-remote-backend`
(branch `agent/juno-code-remote-backend`, PR #19) and rebase it onto
`origin/agent/juno-native-claude-continuation` before resuming Phase 9.

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
2. Chat & composer — **done**: follow-the-stream auto-scroll with a floating
   scroll-to-latest control, Liquid Glass composer capsule on OS 26+, ⌘↩ send on
   macOS, explicit disabled/streaming states, crude free-text model editor
   removed. Attachments left out (no transport payload — recorded, not faked).
3. Design system & Liquid Glass — **done** (`b1ed73c`): coral accent in both
   apps' AccentColor assets (light/dark), adaptive `junoCanvas`/`junoSurface`/
   `junoHairline`/`junoAccent` semantic colors, an SF Pro type hierarchy, and a
   shared `JunoGlassBackground`/`junoFloatingGlass` helper (OS 26+ glass with a
   material fallback) now used by both composers. Six design-system tests.
4. Product screens + real states — in progress. Chat surface done (`214849a`):
   redesigned message rows (assistant spark + `junoSurface` bubble, user accent
   bubble, design-system typography, grouped sources, per-message Copy,
   VoiceOver labels) on a `junoCanvas` transcript. Remaining screens (projects/
   files, library, artifacts, memory, settings, search, Juno Code) already carry
   real loading/empty/error/offline/conflict states from the functional units;
   they still need the same design-system visual pass — best done with a signed
   build so each can be inspected, since the states live behind the auth gate.
5. Responsive, motion, accessibility, visual validation.

**Visual QA is now unblocked** by the debug-only UI Preview mode (`69f0463`):
`--juno-ui-preview` renders the real authenticated screens over an isolated
in-memory store with synthetic fixtures — no auth, network, token, Keychain, or
production data. Launch a specific state headless with
`--juno-preview-scenario <normal|manyItems|empty|loading|offline|error|conflict|mutating|longText|streaming>`
and `--juno-preview-tab <chat|search|projects|library|artifacts|settings>`.
Chat, projects, artifacts and settings inspected on iOS 27 and look native.
Known minor issue: with six iOS sections the tab bar highlights "More" when an
overflow tab (e.g. artifacts) is selected.

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
