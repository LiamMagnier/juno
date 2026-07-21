# Juno Native parity matrix

Initial handoff snapshot: 2026-07-21.

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
- Both projects compile in Debug and Stable with signing disabled; this verifies
  the source foundation, not functional product parity or distributable archives.
- Native CI, production persistence/auth composition, signed release inputs and
  most feature UI are still absent.
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
| Account creation, credentials, Google sign-in, password recovery, profile, export, deletion | **Implemented** through Auth.js and account/profile routes | **Partial**. PKCE bearer flow exists; general account routes require route-by-route bearer and response-shape verification | **Missing** | **Missing** | Web tests exist; no native UI tests | Build native account flows and add bearer contract tests |
| Native PKCE, access/refresh, logout, device list and revocation | **Implemented** in `/api/v1/auth/*`, `src/lib/native-auth*.ts`, and Prisma native-session models | **Partial**. Callback drift is resolved; Swift PKCE/token models and a tested single-flight coordinator exist, but production Keychain/browser/app composition does not | **Partial shell**. Canonical scheme registered; no auth UI/session composition | **Partial shell**. Canonical scheme registered; no auth UI/session composition | Swift auth tests pass; no database-backed route rotation/reuse suite or browser-return tests | Implement Keychain and system-browser adapters, wire both apps, add route/browser integration tests |
| Model catalog, availability, capabilities, reasoning effort | **Implemented** server-side through `/api/v1/models` and model discovery | **Partial**. OpenAPI exposes the manifest but generated Swift models are only a small handwritten subset | **Missing** | **Missing** | TypeScript model validation exists; no Swift decoding tests | Generate complete typed Swift catalog and validate contract drift in CI |
| Conversations and messages | **Implemented** Web routes for list/create/update/archive/pin/delete/fork, message edit, versions, feedback, encrypted persistence | **Partial**. Sync hydrates conversations/messages/versions; native mutations cover only part of conversation behavior | **Missing** | **Missing** | Server unit coverage is partial; no Swift or cross-surface tests | Complete typed native mutations and native persistence/UI |
| Chat generation and streaming | **Implemented** Web chat SSE, cancellation, receipts, reasoning, sources, tools, Markdown, multimodal inputs | **Partial**. General route may use dual cookie/bearer auth, but chat/upload/stream payloads are absent from OpenAPI and lack native contract tests | **Missing** | **Missing** | Web pipeline tests exist; no native reconnect/duplicate/scroll tests | Publish typed bearer contract and build native streaming engine |
| Composer and uploads | **Implemented** Web attachments, images, files, library reattach, dictation, model/effort and connectors | **Partial**. Upload routes exist but are not described in the native OpenAPI contract | **Missing** | **Missing** | Server upload validation exists; no native upload lifecycle tests | Add typed upload/attachment contract and native camera/photo/file flows |
| Folders and projects | **Implemented** Web CRUD, instructions, reference files and starring | **Partial**. Entities hydrate; mutations cover basic folder/project CRUD but not the complete file/reference lifecycle | **Missing** | **Missing** | Mutation helpers have partial tests | Extend mutations/contracts and add offline conflict coverage |
| Library, saved prompts, artifacts and Canvas | **Implemented** Web routes and sandboxed artifact rendering | **Partial**. Entities hydrate attachments, saved prompts, artifacts and versions; mutation coverage is incomplete | **Missing** | **Missing** | Web tests are feature-specific; no native sandbox/export tests | Define native mutation and secure rendering/export contracts |
| Memory | **Implemented** Web CRUD, natural-language edits and encrypted chat integration | **Partial**. Entity hydration and basic native mutations exist | **Missing** | **Missing** | Server memory tests exist; no Swift tests | Implement native store/UI and cross-device conflict tests |
| Connections, MCP and external tools | **Implemented** Web connector directory and server-held encrypted credentials | **Partial**. Connection metadata hydrates without credentials; native connect/callback contracts are not in OpenAPI | **Missing** | **Missing** | Server security coverage is partial | Define secure native browser handoffs and typed metadata/errors |
| Scheduled tasks | **Implemented** Web CRUD and server worker | **Partial**. Tasks hydrate through sync; native mutation contract is missing | **Missing** | **Missing** | Worker behavior has Web coverage only | Add typed native CRUD and notification behavior |
| Settings, profile, usage, subscription and announcements | **Implemented** Web routes and bootstrap data | **Partial**. Settings mutation exists; remaining account/billing behaviors are not fully contracted and bootstrap returns an empty feature-flag/announcement baseline | **Missing** | **Missing** | Server coverage is partial | Complete typed schemas, native screens and cross-device tests |
| Account synchronization | **Implemented** server bootstrap, cursor pages, SSE wakeups, hydration, revisions, tombstones, compaction and idempotent mutations | **Partial**. Tested cursor/outbox/account-scoping primitives exist; durable SQLite/migrations, persistence, reconnect actor, conflict UI, compaction recovery and production wipe are missing | **Missing integration** | **Missing integration** | Swift storage/sync unit tests pass; no Web-to-Swift or crash/offline E2E suite | Add durable adapters and run mandatory convergence scenarios |
| Global search | **Partial**. Current Web palette searches only chat titles and project names | **Partial**. A tested local-search contract and in-memory adapter cover normalization and wipe semantics; protected durable index and authorization integration are missing | **Missing UI** | **Missing UI** | Swift local-index tests pass; no production search-quality/privacy suite | Implement protected durable index, filters, recents and app UI |
| Native design system, motion, accessibility and localization | Web semantic tokens, coral accent, warm surfaces, dot/ASCII signature and flat transcript are **Implemented** references | **Partial**. Swift semantic tokens and EN/FR String Catalog foundations exist | **Partial shell** | **Partial shell** | Token and shell tests pass; no VoiceOver/Dynamic Type/contrast/motion audit | Extend `JunoDesignSystem` with full accessibility and visual-regression coverage |
| macOS desktop shell | Web shell is a behavioral reference only | Independent project and shared package boundary exist | **Partial**. Native split-view shell builds in Debug/Stable; feature flows are placeholders | N/A | Debug/Stable builds and 2 unit tests pass; UI tests not run | Compose auth/storage, then migrate real desktop feature slices |
| iOS/iPadOS adaptive shell | Web shell and reference screenshots are behavioral references only | Independent project and shared package boundary exist | N/A | **Partial**. Adaptive native split-view/navigation shell builds in Debug/Stable simulator; feature flows are placeholders | Debug/Stable builds and 2 unit tests pass; UI tests not run | Compose auth/storage, then implement sidebar/chat/search feature slices |
| Juno Code local on macOS | Agent core, task/event model and Web Code UI are **Implemented** server foundations | **Partial** protocols; no signed local helper or Mac-authoritative client engine in the active checkout | **Missing** | N/A | Agent-core tests exist; no native terminal/Git/diff/permission tests | Implement workspace trust, local engine/helper, Git, terminal, diff, tests and audit UI |
| Juno Code Remote Host | Device/task queue is **Implemented**; richer session relay is **Draft** in the working tree | **Partial** draft snapshots/events/idempotent commands/transcript policies; rich payloads are generic JSON and captures are absent | **Missing** | N/A | Pure planner tests only; no route/database/host tests | Review and commit relay, type payloads, add Mac host, kill switch and privacy UI |
| Computer Use | No server implementation is required for local capture/control, but policy/audit integration is needed | **Missing** native permission, selection, indicator, Stop/kill switch, allowlist and audit implementation | **Missing** | Remote viewing/control UI **Missing** | No permission or safety tests | Implement ScreenCaptureKit/Accessibility boundary and destructive-action gates |
| Juno Code Cloud | **Implemented** GitHub repository discovery, task queue, OIDC runner handoff, agent core, events, branch/PR creation | **Partial**. `/api/code/*` is outside OpenAPI; task creation lacks canonical model/effort/Ask-Plan-Code/permission fields and structured commits/checks | Web UI **Partial** | **Missing** | Server/agent tests exist; no native Cloud E2E | Type the Code contract and implement mobile task creation, monitoring and diff views |
| Juno Code Remote mobile | Session relay server is **Draft** and the older device task queue is **Implemented** | **Partial**. Existing-session message/approval/stop commands exist; no APNs, capture payload, or complete create-session contract | N/A | **Missing** | Planner tests only | Build mobile Remote client, notification pipeline and reconnect E2E |
| Realtime voice, dictation and read-aloud | **Implemented** Web routes and standalone relay | **Partial**. Voice endpoints/protocol are not in native OpenAPI | **Missing** | **Missing** | Relay smoke coverage exists; no native audio interruption/background tests | Define native voice contract and Apple audio-session behavior |
| Push notifications and deep links | Web deep-link/auth handoff is **Partial** | **Missing** APNs token registration, notification preferences/payload policy, associated domains and complete native routing | **Missing** | **Missing** | No APNs/deep-link UI tests | Add typed device-token APIs, redaction policy and routing tests |
| StoreKit 2 | Existing Stripe subscription is **Implemented** for Web | **Missing** product catalog, purchase/restore, server verification and double-subscription mapping | **Missing** | **Missing** | No StoreKit tests/configuration | Add configurable StoreKit products and server reconciliation |
| Native distribution and updates | Web deploy and a legacy DMG download are **Implemented** artifacts | **Partial** source foundation: independent projects, Stable configs, privacy manifests and unsigned builds exist; CI, archives, signing, notarization, TestFlight/App Store and provenance remain missing | **Partial source pipeline** | **Partial source pipeline** | Debug/Stable unsigned builds pass; no archive/signature/notarization gates | Add native CI/release jobs and verify signed artifacts before publication |

## API and contract coverage

`getCurrentUser()` treats an `Authorization` header as authoritative and otherwise
uses the Web cookie. The table below records contract status, not merely whether a
route can happen to authenticate a bearer today.

| Surface | Methods | Cookie auth | Native bearer | OpenAPI | Idempotence / realtime | Backend tests | Generated Swift / Swift tests |
|---|---|---|---|---|---|---|---|
| `/api/v1/auth/token` | POST | No | Grant exchange | Yes | Authorization code consumed atomically | Core helpers only | Sendable token DTO, PKCE/coordinator tests; app transport not wired |
| `/api/v1/auth/refresh` | POST | No | Refresh grant | Yes | Rotating family with reuse revocation | Core helpers only | Sendable token DTO and single-flight coordinator tests; Keychain/route integration missing |
| `/api/v1/auth/session`, `/logout`, `/devices`, `/devices/{id}` | GET/POST/DELETE | No | Yes | Yes | Device revocation | No route integration suite | Partial DTO / none |
| `/api/v1/models` | GET | No | Yes | Yes | ETag model manifest | Server model tests | Manifest schema incomplete / none |
| `/api/v1/bootstrap` | GET | No | Yes | Yes | Authoritative sync baseline | No cross-contract suite | Cursor fields only / none |
| `/api/v1/changes` | GET | No | Yes | Yes | Ordered pages; 410 on compacted cursor | Pure cursor tests | Basic DTO / none |
| `/api/v1/changes/stream` | GET SSE | No | Yes | Yes | Wakeup channel only; pages remain authoritative | No native reconnect suite | No generated SSE client / none |
| `/api/v1/entities` | GET | No | Yes | Yes, loose entity payload | Owner-scoped hydration and tombstones | No exhaustive loader contract suite | Generic envelope only / none |
| `/api/v1/mutations` | POST | No | Yes | Yes, response is generic | Serializable transaction, revision check and per-device idempotency | Partial mutation tests | Operation/result union incomplete / none |
| General chat/conversation/project/file/artifact/voice/account routes | Mixed | Yes | Often via dual-mode session gate; must be verified per route | No | Route-specific behavior | Mixed | None |
| `/api/code/tasks*`, `/api/code/github/*`, `/api/code/devices*` | Mixed | Yes | Via dual-mode user gate or scoped task token | No | Task idempotency, SSE events, OIDC Cloud runner | Partial | None |
| Draft `/api/code/devices/{deviceId}/sessions*` and commands | GET/PUT/PATCH/DELETE/POST/SSE | Yes | Via dual-mode user gate | No | Version checks, explicit tombstones, ordered replay-safe events, idempotent commands | Pure planner tests only | None |

## Completion evidence still required

The two independent native projects now build in Debug and Stable unsigned, but
parity is not complete until Release/archive gates and the mandatory Web/Mac/iPhone
scenarios pass: cross-surface creation
and streaming, offline mutation and revision conflict, single refresh, device
revocation, project/file convergence, real Cloud branch and pull request, Remote
discovery/instruction/approval/reconnect/revocation, untrusted-workspace safety,
light/dark, extreme text, Reduce Motion, Reduce Transparency, and binary secret
scanning.
