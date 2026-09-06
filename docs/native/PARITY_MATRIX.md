# Juno Native parity matrix

Initial handoff snapshot: 2026-07-21.

## Re-audit — 2026-09-03 (v1.5.0 Soft UI)

The product-parity table below (§Product parity) was written against the
2026-07-21 baseline and, until this pass, still marked shipped native UI as
**Missing**. Every macOS/iOS cell has now been re-checked against the source
tree — `native/iOS/JunoMobile/App/`, `native/macOS/JunoDesktop/App/`,
`native/Packages/`, and `src/app/api/v1/` — and corrected; rows that name
files are evidence-backed. The release-level state is
`docs/design/REVIEW_2026-09-02.md` (website / iOS / macOS findings +
resolutions) at release v1.5.0:

- iOS shipped since the baseline: date-grouped drawer with search, swipe
  pin/archive/delete and full context menu (`JunoMobileDrawer.swift`,
  `JunoMobileArchivedView.swift`); image parts + pinch-zoom viewer with share
  (`JunoMobileMessageImages.swift`); `sensoryFeedback` on
  send/stop/copy/pin/delete/approve/voice + zoom pushes + glass composer chrome;
  full-screen voice with background audio, interruption / route handling and a
  navigation-surviving session (`JunoMobileVoiceFullScreen.swift`); Code remote
  hosts strip → filtered sessions → thread with work-log groups, approval
  cards, hunk diff viewer, live terminal, queued steering, Stop and background
  approval notifications (`JunoMobileCodeRemote.swift`,
  `JunoMobileCodeNotifications.swift`); native `List`/`Form` Projects leaves
  with detail tabs + three-page onboarding (`JunoMobileWorkspaceViews.swift`,
  `JunoMobileOnboarding.swift`); App Intents + `AppShortcutsProvider`, quick
  actions and Spotlight indexing (`JunoMobileIntents.swift`,
  `JunoMobileSpotlight.swift`). Paired-Mac revocation is now implemented end
  to end: `DELETE /api/v1/code/devices/{deviceId}` is in the canonical OpenAPI
  contract, the phone offers a non-full-swipe Revoke action with confirmation,
  and the Mac Remote-hosting tile can revoke/re-pair itself. Widgets / Live
  Activities extension targets are being added on a separate branch and are
  not present in this tree, so they are not marked shipped here; a recorded
  iPad screenshot pass also remains open.
- macOS shipped since the baseline: project-grouped Code sessions column with
  All · Running · Needs you · Done filters; one New-task screen; review as a
  resizable split pane (`ReviewModel` single source of truth); approval queue
  with ⇧↵ / ⇧⎋, inline errors and work-log groups; Code settings (permissions,
  model, environment, MCP, hooks, skills, agents, remote), `/compact` +
  context meter, `gh pr create` sheet, real PTY, ⌘K palette, `MenuBarExtra`,
  ⌥Space quick entry, ⇧⌘1 screenshot to composer (`DesktopScreenshotCapture.swift`,
  `DesktopQuickEntry.swift`, `DesktopMenuBarExtra.swift`); one `JunoMotion`,
  one `JunoReadingMeasure`. Library / Artifacts / Connections / Tasks / Usage /
  Memory now use the raised/inset soft-UI vocabulary and Memory is a Chat
  sidebar destination. The target-size ratchet is 348 (down from 351). A manual
  run of the system screenshot picker is still required.
- Chat / conversations / projects / library / artifacts / memory / settings /
  search / sync all have production native UI backed by the encrypted store and
  the `/api/v1` + bearer chat/upload/stream contracts (see
  `docs/native/STATUS.md` "Actually completed" and `TESTING.md` gates); the
  table now reflects that. The remaining gaps are the per-row "Required next
  gate" items (typed Cloud/Remote contracts, APNs, StoreKit, signed release),
  not the absence of the screen.

## Current re-audit — 2026-08-08

The matrix below is the historical handoff baseline. This re-audit records the
state observed in the active checkout before the current native slice, so the
older rows are not mistaken for a live inventory.

| Area | Web/source of truth | Native state observed | Current session result |
|---|---|---|---|
| Semantic design system | `src/app/globals.css`, `tailwind.config.ts`, app icons and motion tokens | `JunoDesignSystem` already has semantic colors, typography, spacing/radius tokens, native material policy, motion tiers, Dynamic Type and reduced-motion handling | Reused the existing token/material/motion layer; no parallel palette or glass recipe added |
| Chat and composer | `ChatView`, message list, attachment/model/reasoning controls and progressive composer | `JunoChatKit` owns native conversations, streaming/composer behavior and server-backed state | Kept ownership in `JunoChatKit`; the new slice only projects activity and routes back to the source model |
| Recents and attention | `src/lib/work/recents.ts` and `/api/recents` merge chat/work/code/projects; attention excludes running | Native clients had product-local navigation and Work/Code lists, but no cross-product projection | Added the shared native projection, pure parity rules, and attention rails on macOS/iOS |
| macOS shell | Web sidebar has Home/Work/Code modes and source-backed recents | `JunoDesktop` has a native split-view shell; `JunoMac` and standalone `JunoCode` remain separate audited surfaces | Added attention entry points to `DesktopChatSidebar`; did not duplicate the slice in `JunoCode`/`JunoMac` |
| iPhone/iPad shell | Web uses adaptive sidebar/sheet behavior | `JunoMobileRootView` has compact drawer and iPad split-view paths | Added the same attention projection and native deep links to Work/Code |
| Native Code workbench | Web and native code surfaces exist, but the native workbench needs real-data stress work | `WorkbenchView` is the canonical package route; the audit found eager whole-review loading, non-virtualized diffs/output, collapsed activity, and weak diagnostics/retry surfaces | Recorded those as follow-up blockers; the current slice does not pretend to solve them |

See the evidence-backed session report in
[`docs/native/SESSION_REPORT_2026-08-08.md`](SESSION_REPORT_2026-08-08.md).

This document separates server capabilities that already exist in the active
checkout from work that is still required in the native clients. A server route
or Web screen is not evidence that the corresponding macOS or iOS/iPadOS
experience exists.

## Status legend

- **Implemented**: present in the active server checkout and backed by concrete code.
- **Partial**: useful foundation exists, but the native contract, tests, or full
  product behavior is incomplete.
- **Missing**: no production implementation exists in the active checkout.
- **Draft**: present only as uncommitted working-tree work and must be reviewed,
  tested, and committed before it can be treated as a foundation.

## Current baseline

- Commit `0fb7cc3` adds the `native/` source tree, a ten-product Swift 6
  package, exactly one independent Xcode project per platform, configuration
  layers, String Catalogs, privacy manifests, skeleton entitlements, and tests.
- Commits `7e80d8e` and `9dad2a1` connect production browser authentication,
  refresh-aware bearer requests and the existing bootstrap checkpoint contract.
- Both projects compile in Debug and Stable with signing disabled; this verifies
  the source foundation, not functional product parity or distributable archives.
- Native CI exists (`.github/workflows/native.yml`) alongside signed release
  workflows (`release-ios.yml` TestFlight, `release-macos.yml` Developer ID
  notarization); durable SQLite persistence is composed into both app roots;
  most feature UI has shipped. What is still open is stated per row below
  (APNs, StoreKit, typed Cloud contracts, a published signed artifact).
- The Web product and backend are the current server source of truth.
- Native authentication, account synchronization, Cloud Code, and a draft
  Remote Session relay provide substantial server foundations.
- A pre-existing `public/downloads/Juno.dmg` is a release artifact, not evidence
  that reproducible native source is present in this checkout.
- Native code found in other local worktrees or prototype directories is not
  counted as implemented here until it is audited and intentionally integrated.

## Product parity

| Capability | Web/server foundation | Native contract and offline behavior | macOS | iOS/iPadOS | Verification state | Required next gate |
|---|---|---|---|---|---|---|
| Account creation, credentials, Google sign-in, password recovery, profile, export, deletion | **Implemented** through Auth.js and account/profile routes | **Partial**. PKCE bearer flow exists; general account routes require route-by-route bearer and response-shape verification | **Missing** | **Partial**. Settings › Account has sign-out, data export and the delete-account sheet (`JunoMobileSettingsView.swift`); sign-up and recovery stay web-mediated | Web tests exist; no native UI tests | Build the macOS account screens and add bearer contract tests |
| Native PKCE, access/refresh, logout, device list and revocation | **Implemented** in `/api/v1/auth/*`, `src/lib/native-auth*.ts`, and Prisma native-session models | **Partial**. Production Keychain, PKCE browser planning, auth-route client, single-flight refresh, restore and logout are implemented; device-list UI is not | **Partial**. Real auth gate and system-browser adapter are wired | **Partial**. Real auth gate and system-browser adapter are wired | 26 Swift auth tests plus macOS/iOS sign-in-gate UI tests pass; live browser completion and database-backed route reuse suite remain | Run live browser matrix, then add connected-device management |
| Model catalog, availability, capabilities, reasoning effort | **Implemented** server-side through `/api/v1/models` and model discovery | **Partial**. The full manifest is decoded in `JunoChatKit/NativeChatAPIClient.swift` (`NativeChatModelOption`: capabilities, modalities, reasoning effort, superseded ordering) with the presentation vocabulary in `JunoDesignSystem/JunoModelCatalog.swift`; the OpenAPI-*generated* subset is still small | **Implemented UI** | **Implemented UI** | Model selector and Thinking control in both apps; Swift tests (`NativeModelCapabilityTests`, `ModelTierRouterTests`) pass | Generate the remaining typed catalog from OpenAPI and fail CI on drift |
| Conversations and messages | **Implemented** Web routes for list/create/update/archive/pin/delete/fork, message edit, versions, feedback, encrypted persistence | **Partial**. Sync hydrates conversations/messages/versions; native mutations cover only part of conversation behavior | **Implemented UI** | **Implemented UI** | Native UI is present; cross-surface/offline convergence remains unverified | Complete typed native mutations and convergence tests |
| Chat generation and streaming | **Implemented** Web chat SSE, cancellation, receipts, reasoning, sources, tools, Markdown, multimodal inputs | **Partial**. General route may use dual cookie/bearer auth, but chat/upload/stream payloads are absent from OpenAPI and lack native contract tests | **Implemented UI** | **Implemented UI** | Native UI is present; reconnect/duplicate/scroll stress coverage remains | Publish typed bearer contract and add reconnect coverage |
| Composer and uploads | **Implemented** Web attachments, images, files, library reattach, dictation, model/effort and connectors | **Partial**. Upload routes exist but are not described in the native OpenAPI contract | **Implemented UI** | **Implemented UI** | Native attachment, dictation and composer flows exist; lifecycle contract coverage remains | Add typed upload/attachment contract and offline lifecycle tests |
| Folders and projects | **Implemented** Web CRUD, instructions, reference files and starring | **Partial**. Entities hydrate; mutations cover basic folder/project CRUD but not the complete file/reference lifecycle | **Implemented UI** | **Implemented UI** | Native project list/detail UI exists; conflict/reference-file coverage remains | Extend mutations/contracts and add offline conflict coverage |
| Library, saved prompts, artifacts and Canvas | **Implemented** Web routes and sandboxed artifact rendering | **Partial**. Entities hydrate attachments, saved prompts, artifacts and versions; mutation coverage is incomplete | **Implemented UI** | **Implemented UI** | Native library, artifact and Canvas UI exists; sandbox/export coverage remains | Define native mutation and secure rendering/export contracts |
| Memory | **Implemented** Web CRUD, natural-language edits and encrypted chat integration | **Partial**. Entity hydration and basic native mutations exist | **Implemented UI** | **Implemented UI** | Native memory manager UI exists; cross-device conflict coverage remains | Add memory conflict and convergence tests |
| Connections, MCP and external tools | **Implemented** Web connector directory and server-held encrypted credentials | **Partial**. Connection metadata hydrates without credentials; catalog, categories, connect (web handoff) and disconnect render natively (`DesktopConnectionsScreen.swift`, `JunoMobileConnectionsView.swift`); native connect/callback contracts are still not in OpenAPI | **Implemented UI** | **Implemented UI** | Server security coverage is partial | Define secure native browser handoffs and typed metadata/errors |
| Scheduled tasks | **Implemented** Web CRUD and server worker | **Partial**. Full CRUD renders and mutates natively (`DesktopTasksScreen.swift`, `JunoMobileTasksView.swift`); the worker stays server-side and a run is deliberately started only by the server | **Implemented UI** | **Implemented UI** | Worker behavior has Web coverage only | Add typed native CRUD contract tests and notification behavior |
| Settings, profile, usage, subscription and announcements | **Implemented** Web routes and bootstrap data | **Partial**. Settings mutation exists; remaining account/billing behaviors are not fully contracted and bootstrap returns an empty feature-flag/announcement baseline | **Implemented UI** (`DesktopSettingsScreen.swift`, `DesktopSettingsModal.swift`, `DesktopUsageScreen.swift`) | **Implemented UI** (`JunoMobileSettingsView.swift`, `JunoMobileSettingsPages.swift`, `JunoMobileUsageView.swift`) | Server coverage is partial | Complete typed billing/subscription schemas and cross-device tests |
| Account synchronization | **Implemented** server bootstrap, cursor pages, SSE wakeups, hydration, revisions, tombstones, compaction and idempotent mutations | **Partial**. Durable SQLite storage and the persistent mutation outbox exist (`JunoStorage/SQLiteDatabase.swift`, `JunoSync/PersistentMutationOutbox.swift`) and are composed into both app roots (`SQLiteAccountRepository` behind every root model); reconnect, conflict UI and compaction recovery remain | **Partial integration** | **Partial integration** | Sync tests pass; no Web-to-Swift or crash/offline E2E suite | Run the mandatory convergence and conflict scenarios end to end |
| Global search | **Partial**. Current Web palette searches only chat titles and project names | **Partial**. The local index runs on the durable account store (`NativeSearchModel<SQLiteAccountRepository>`); normalization and wipe tests pass | **Implemented UI** (`DesktopSearchScreen.swift`, the drawer's search row) | **Implemented UI** (`JunoMobileSearchView.swift`) | Swift local-index tests pass; no production search-quality/privacy suite | Add filters, recents and the search-quality/privacy suite |
| Native design system, motion, accessibility and localization | Web semantic tokens, coral accent, warm surfaces, dot/ASCII signature and flat transcript are **Implemented** references | **Partial**. Swift semantic tokens and EN/FR String Catalog foundations exist | **Partial shell** | **Partial shell** | Token and shell tests pass; no VoiceOver/Dynamic Type/contrast/motion audit | Extend `JunoDesignSystem` with full accessibility and visual-regression coverage |
| macOS desktop shell | Web shell is a behavioral reference only | Independent project and shared package boundary exist | **Implemented**. Real Chat/Projects/Library/Artifacts/Connections/Tasks/Usage/Memory/Search/Settings surfaces plus the Code and Work products over the composed SQLite/bootstrap stack | N/A | Debug/Stable builds, package and app tests pass; the signed UI suite is still outstanding | Run signed `JunoDesktopUITests` and the per-row gates below |
| iOS/iPadOS adaptive shell | Web shell and reference screenshots are behavioral references only | Independent project and shared package boundary exist | N/A | **Implemented**. Drawer with pinned/date-grouped recents and swipe actions, full chat, search, projects, library, artifacts, connections, tasks, usage, settings (with the memory page), Code, Work and onboarding over the composed SQLite/bootstrap stack | Debug/Stable simulator builds and app tests pass; iPad screenshot pass outstanding | Record iPad screenshots and clear the per-row gates below |
| Juno Code local on macOS | Agent core, task/event model and Web Code UI are **Implemented** server foundations | **Implemented** as the `JunoCode` package (Core → Local → Runtime → UI/Bridge/Simulator) with workspace containment, a real PTY (`InteractiveTerminalSession.swift`), Git publication, hunk review and settings; the signed production helper boundary remains the open gate (see `ARCHITECTURE.md` "macOS workspace and agent") | **Implemented UI** | N/A | 214 JunoCode package tests pass | Adversarial helper/IPC audit before local Code is un-gated in production |
| Juno Code Remote Host | Device/task queue is **Implemented**; session relay routes are committed (`/api/code/devices/[deviceId]/sessions`, `commands`) | **Partial**. Ordered events, idempotent commands and transcript policies are typed end to end; capture payloads are absent | **Implemented** (`DesktopCodeHost.swift`: the claim loop, revoking its own pairing, pair-again) | N/A | Route tests (`code-remote-sessions.test.ts`, `code-session-command-compat.test.ts`) plus JunoCodeBridge tests pass | Capture payloads and the reconnect E2E |
| Computer Use | No server implementation is required for local capture/control, but policy/audit integration is needed | **Partial**. `JunoWorkAutomation` implements the permission gate, accessibility/browser/visual control, emergency stop, screenshot policy, sensitive-surface policy and audit (`JunoWork/Sources/JunoWorkAutomation/`), wired behind `policy.allowsComputerUse` (`DesktopWorkExecutorAdapter.swift`) | **Implemented** behind the Work permission gate, with the kill switch (`DesktopWorkHost.swift`) | Remote viewing/control UI **Missing** | JunoWorkAutomationTests exist; no adversarial/destructive-action audit | Run the destructive-action and audit gates end to end |
| Juno Code Cloud | **Implemented** GitHub repository discovery, task queue, OIDC runner handoff, agent core, events, branch/PR creation | **Partial**. `/api/code/*` is outside OpenAPI; task creation lacks canonical model/effort/Ask-Plan-Code/permission fields and structured commits/checks | Web UI **Partial** | **Implemented UI** (`JunoMobileCodeView.swift`: Cloud dispatch, repository selection, task list, launch composer) | Server/agent tests exist; no native Cloud E2E | Type the Code contract and run the mobile Cloud E2E |
| Juno Code Remote mobile | Session relay is committed (`/api/code/devices/[deviceId]/sessions`, `commands`); the older device task queue is **Implemented** | **Partial**. Message/approval/stop/steer commands exist end to end; no APNs or capture payload | N/A | **Implemented UI**. Hosts strip → filtered sessions → thread with work-log groups, approval cards, hunk diff viewer, live terminal, queued steering and Stop (`JunoMobileCodeRemote.swift`); local background approval notifications (`JunoMobileCodeNotifications.swift`); swipe-to-revoke of a paired Mac over `DELETE /api/v1/code/devices/{deviceId}`, confirmed, non-full-swipe | Route + CodeKit/Bridge tests pass | APNs, reconnect E2E, capture payloads |
| Realtime voice, dictation and read-aloud | **Implemented** Web routes and standalone relay | **Partial**. Voice endpoints/protocol are not in native OpenAPI | **Implemented UI** (`DesktopVoice.swift`: the dock call over `JunoRealtimeVoiceController`; `DesktopDictation.swift`) | **Implemented UI** (`JunoMobileVoiceFullScreen.swift`: full-screen call; `JunoMobileVoiceAudioSession.swift`: interruption and route handling; `UIBackgroundModes=audio` in Info.plist) | Relay smoke coverage exists | Add the voice contract and native audio interruption/background stress tests |
| Push notifications and deep links | Web deep-link/auth handoff is **Partial** | **Missing** APNs token registration, notification preferences/payload policy, associated domains and complete native routing | **Missing** | **Partial**. Local background approval notifications and their settings toggle exist (`JunoMobileCodeNotifications.swift`, `JunoMobileSettingsPages.swift`); APNs registration and deep-link routing do not | No APNs/deep-link UI tests | Add typed device-token APIs, redaction policy and routing tests |
| StoreKit 2 | Existing Stripe subscription is **Implemented** for Web | **Missing** product catalog, purchase/restore, server verification and double-subscription mapping | **Missing** | **Missing** | No StoreKit tests/configuration | Add configurable StoreKit products and server reconciliation |
| Native distribution and updates | Web deploy and a legacy DMG download are **Implemented** artifacts | **Partial**. Native CI (`.github/workflows/native.yml`) and signed release workflows exist — TestFlight upload (`release-ios.yml`) and Developer ID notarization (`release-macos.yml`) behind protected environments; provenance and a published signed artifact from this checkout remain unproven | **Partial pipeline** | **Partial pipeline** | Debug/Stable builds and package tests pass in CI; signed releases have not been run from this tree | Exercise the release workflows on a protected tag and verify the signed artifacts |

## API and contract coverage

`getCurrentUser()` treats an `Authorization` header as authoritative and otherwise
uses the Web cookie. The table below records contract status, not merely whether a
route can happen to authenticate a bearer today.

| Surface | Methods | Cookie auth | Native bearer | OpenAPI | Idempotence / realtime | Backend tests | Generated Swift / Swift tests |
|---|---|---|---|---|---|---|---|
| `/api/v1/auth/token` | POST | No | Grant exchange | Yes | Authorization code consumed atomically | Core helpers only | Production request/response client plus PKCE/runtime contract tests |
| `/api/v1/auth/refresh` | POST | No | Refresh grant | Yes | Rotating family with reuse revocation | Core helpers only | Production rotation client, single-flight coordinator, Keychain CAS and failure-mapping tests |
| `/api/v1/auth/session`, `/logout`, `/devices`, `/devices/{id}` | GET/POST/DELETE | No | Yes | Yes | Device revocation | No route integration suite | Session/logout client and tests; device list/revoke client/UI missing |
| `/api/v1/models` | GET | No | Yes | Yes | ETag model manifest | Server model tests | Typed manifest client in JunoChatKit with capability/tier tests (handwritten, not generated) |
| `/api/v1/bootstrap` | GET | No | Yes | Yes | Authoritative sync baseline | No cross-contract suite | Cursor fields only / none |
| `/api/v1/changes` | GET | No | Yes | Yes | Ordered pages; 410 on compacted cursor | Pure cursor tests | Basic DTO / none |
| `/api/v1/changes/stream` | GET SSE | No | Yes | Yes | Wakeup channel only; pages remain authoritative | No native reconnect suite | No generated SSE client / none |
| `/api/v1/entities` | GET | No | Yes | Yes, loose entity payload | Owner-scoped hydration and tombstones | No exhaustive loader contract suite | Generic envelope only / none |
| `/api/v1/mutations` | POST | No | Yes | Yes, response is generic | Serializable transaction, revision check and per-device idempotency | Partial mutation tests | Operation/result union incomplete / none |
| `/api/v1/code/devices/{deviceId}` | DELETE | No | Yes | Yes | Account-scoped Code-host pairing revocation | Route + CodeKit tests | Generated request client plus revoke-model/UI coverage |
| General chat/conversation/project/file/artifact/voice/account routes | Mixed | Yes | Often via dual-mode session gate; must be verified per route | No | Route-specific behavior | Mixed | None |
| `/api/code/tasks*`, `/api/code/github/*`, `/api/code/devices*` | Mixed | Yes | Via dual-mode user gate or scoped task token | No | Task idempotency, SSE events, OIDC Cloud runner | Partial | None |
| `/api/code/devices/{deviceId}/sessions*` and commands | GET/PUT/PATCH/DELETE/POST/SSE | Yes | Via dual-mode user gate | No | Version checks, explicit tombstones, ordered replay-safe events, idempotent commands | Route tests (`code-remote-sessions.test.ts`, `code-session-command-compat.test.ts`) plus JunoCodeBridge tests | Typed client/model on the phone (`JunoCodeKit` `CodeRemoteBrowserModel`/`CodeRemoteThread`, tested) and the Mac host loop in `JunoCodeBridge` |

## Completion evidence still required

The two independent native projects now build in Debug and Stable unsigned, but
parity is not complete until Release/archive gates and the mandatory Web/Mac/iPhone
scenarios pass: cross-surface creation
and streaming, offline mutation and revision conflict, single refresh, device
revocation, project/file convergence, real Cloud branch and pull request, Remote
discovery/instruction/approval/reconnect/revocation, untrusted-workspace safety,
light/dark, extreme text, Reduce Motion, Reduce Transparency, and binary secret
scanning.
