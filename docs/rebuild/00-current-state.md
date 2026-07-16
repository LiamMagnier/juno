# Phase 0 current-state evidence

Date: 2026-07-16

Audit branch: `codex/rebuild-phase0`

## Purpose and evidence labels

This document records the system that exists before the production Mac rebuild. It is descriptive, not an endorsement of the current contracts.

- **Observed** means verified from source, repository metadata, or a captured command result in this Phase 0 run.
- **Declared** means stated by repository documentation or configuration but not independently exercised in this audit.
- **Proposed** means required for the rebuild and does not describe current behavior.

Source prefixes used below:

- **W** — web/backend repository, `/Users/liammagnier/Desktop/workspace/.worktrees/juno-rebuild`
- **M** — native repository, `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild`

No private development-account content was opened. No secret-bearing request/response trace, provider payload, OAuth token, session cookie, production database row, or production object was captured.

## Repository baseline

| Repository | Role | Phase 0 worktree / branch | Main checkout | Remote |
|---|---|---|---|---|
| `juno` | Next.js web product, canonical database, account/auth, provider proxying, relay and workers | `W`, `codex/rebuild-phase0` | `/Users/liammagnier/Desktop/workspace/juno`, `main` | `origin https://github.com/LiamMagnier/juno.git` |
| `juno-app` | Native SwiftUI Mac/iOS application plus TypeScript agent core and CLI workspace | `M`, `codex/rebuild-phase0` | `/Users/liammagnier/Desktop/workspace/juno-app`, `main` | `origin https://github.com/LiamMagnier/juno-app.git` |
| `@juno/agent-core` | TypeScript coding-agent protocol/runtime inside `juno-app/core` | Same Git repository and branch as `juno-app` | `M/core` | Inherits `juno-app` remote |

Both Phase 0 worktrees were clean at the start of the forensic audit.

## Toolchains and configuration

### Web/backend

- Observed shell toolchain: Node `v24.18.0`, npm `11.16.0`.
- Declared engine: Node `>=20` (`W/package.json:99-101`).
- The application declares Next `^15.5.0`, React `^19`, Prisma client `^6`, TypeScript `^5.7`, Tailwind `^3.4`, and ESLint `^9` (`W/package.json:56-97`). The captured successful build resolved Next `15.5.19`.
- The build command is Prisma generation followed by `next build` (`W/package.json:5-10`).
- Production build configuration ignores both ESLint and TypeScript failures (`W/next.config.mjs:4-9`).
- TypeScript excludes the voice relay (`W/tsconfig.json:21-22`); the relay has its own npm build in deployment (`W/.github/workflows/deploy.yml:37-40`).

### Native Mac

- Declared requirement: macOS 26+, Xcode 27 beta, no third-party Swift packages (`M/README.md:7-22`).
- Project settings target macOS/iOS 26 and Swift language mode 5 (`M/Juno.xcodeproj/project.pbxproj:336-350,380-394`).
- The active shell points `xcode-select` at Command Line Tools, so an unprefixed `xcodebuild` is unavailable. The repository explicitly documents selecting `/Applications/Xcode-beta.app/Contents/Developer` (`M/README.md:15-21`).
- Observed standalone Swift driver: Swift `6.4`, target `arm64-apple-macosx27.0.0`. This is not evidence that the Xcode project was built with the standalone driver.
- The app is intentionally not sandboxed on macOS so Code mode can execute shell/git and Computer Use can drive the Mac (`M/README.md:24,70-82`). That raises the required assurance level for workspace scoping, command policy, secret redaction, Accessibility, and Screen Recording.

### Agent core

- The root npm workspace builds `core` and `apps/cli`; root tests currently run only the core workspace (`M/package.json:5-16`).
- Core uses TypeScript `^5.7`, Node `>=20` via the root, and Node's built-in test runner (`M/core/package.json:10-25`).

## Build, test, and smoke baseline

| Surface | Observed Phase 0 result | What it proves | What it does not prove |
|---|---|---|---|
| Web production build | **Passed in the clean main checkout** with its pre-existing installed dependencies and local development environment; Next `15.5.19` enumerated **70 static pages**. The isolated audit worktree itself remained dependency-blocked and was not made reproducible with `npm ci`. | That exact clean main checkout can generate Prisma client and complete a production Next build under the captured environment | Not a clean-install/worktree result; no lint/type safety because the build explicitly suppresses both; no live database/provider/auth behavior |
| Web lint | **Failed** because the repository has no usable non-interactive ESLint configuration and the current lint path is interactive/incompatible | The documented lint command is not an enforceable gate | It is not evidence of source lint cleanliness |
| Web automated tests | No comprehensive runner or CI test job exists. Package scripts expose four probes (`W/package.json:19-22`); `scripts/test-message-crypto.ts` is not wired into them | Small helper/probe coverage exists | No route, database, browser, sync, authorization, or end-to-end regression suite |
| Native Mac build | **Passed** with the Xcode-beta developer directory selected | The native target compiles for Mac in the captured environment | No signing/notarization/update feed, live account, provider, or offline-conflict validation |
| Native Xcode tests | **29 passed** | Current Swift test target passes; coverage includes model helpers, parsing, formatting, provider errors, and response decoding (`M/JunoTests/JunoTests.swift`) | It does not exercise production auth, durable sync, deletion, retries, device revocation, live streaming, Code host impersonation, or UI accessibility |
| Root/core build | **Passed** | TypeScript agent core and CLI workspace compile through the root build script | No native integration or backend compatibility guarantee |
| Root/core tests | **16 passed** | Current Node tests for the agent core pass | No live provider/backend/network or filesystem-permission smoke |
| Web runtime smoke | Public landing and sign-in rendered locally; unauthenticated `/app-auth?...` redirected to `/sign-in?callbackUrl=/app-auth`. Tailwind warned that three arbitrary duration classes are ambiguous. No private signed-in runtime session was used. | Public compilation, navigation, and redirect behavior | Authenticated UI actions, production data integrity, OAuth, billing, provider calls, storage, relay, workers |
| Native runtime smoke | Build and test only; no private-account launch trace was captured | Compile/test baseline | Login, Keychain restoration, real sync, deep links, voice relay, Code remote host, update installation |

## CI and deployment reality

The production workflow installs dependencies and runs only `npm run build` before shipping (`W/.github/workflows/deploy.yml:31-40`). It does not run lint, `tsc --noEmit`, route tests, database tests, or browser tests. Because `next.config.mjs` suppresses type and lint errors, a green production build is not a quality gate.

The active GitHub deployment labels its remote step “migrate” but executes:

```text
npx prisma db push --skip-generate
```

at `W/.github/workflows/deploy.yml:80-101`. That contradicts:

- the schema instruction to use `prisma migrate deploy` in production (`W/prisma/schema.prisma:2`);
- the README's explicit distinction between maintainable production migrations and prototype `db push` (`W/README.md:138-140`);
- the standalone deploy script, which warns against `db push` and uses migrations (`W/deploy/deploy.sh:59-62`).

The model-sync workflow permits discovery and benchmark fetch failures, then deploys committed/generated fallbacks (`W/.github/workflows/sync-models.yml:64-77`). It also contains an explicit manual reminder to mirror catalog changes into native Swift (`W/.github/workflows/sync-models.yml:120-124`).

## Current architecture

### Web/backend

The web application is a Next.js application with Auth.js JWT sessions, Prisma/PostgreSQL storage, provider-specific streaming adapters, an S3-compatible/local-file storage abstraction, Stripe billing, a separate realtime voice relay, and a scheduled-task worker.

Authenticated page groups observed under `W/src/app/(app)`:

- chat/new chat, thread, compare, artifacts, library;
- projects and project detail;
- memory, tasks, connections;
- settings, profile, upgrade;
- roadmap and request detail;
- announcement, moderation, and user administration.

Public/authenticated-adjacent pages include landing, sign-in, sign-up, password recovery/reset, native auth handoff, suspended-account notice, public share, and three legal pages.

The API is not versioned and has no OpenAPI or generated shared client. Request validation is route-local, response shapes are TypeScript interfaces/serializers, and the native app manually duplicates DTOs.

### Native

The Mac app is SwiftUI with SwiftData local persistence, `@Observable` services, `AsyncThrowingStream` streaming, Keychain storage, native voice, local/BYOK provider transports, local Code tools, and a cookie-authenticated backend client (`M/README.md:37-62`).

Current account sync is explicitly **upsert-only** and never deletes local rows (`M/Juno/Services/Backend/SyncService.swift:5-10`). Full sync executes independent pulls for folders, conversations, projects, memory, and connectors; one failure does not stop later steps (`M/Juno/Services/Backend/SyncService.swift:28-46`). Some local mutations are pushed back fire-and-forget (`M/README.md:94-100`).

The app also exposes a seeded mock environment and BYOK/direct-provider mode (`M/README.md:94-106`). Those are useful development modes but are not evidence of production account parity.

### Data entities

The canonical database currently includes:

- identity/auth: `User`, `Account`, `Session`, `VerificationToken` (`W/prisma/schema.prisma:17-124`);
- connections/preferences: `Connection`, `SavedPrompt`, `Settings` (`:71-174`);
- workspace/chat: `Folder`, `Conversation`, `Project`, `Message`, `Attachment` (`:180-316`);
- voice: `VoiceTranscriptSession` (`:276-288`);
- memory: `MemoryEntry`, `ConversationMemory`, `MemorySummary` (`:322-372`);
- artifacts: `Artifact`, `ArtifactVersion` (`:378-409`);
- entitlement/accounting: `Subscription`, `Usage`, `RateLimit`, `ApiSpend` (`:415-455,545-559`);
- announcements/moderation: `Announcement`, `AnnouncementDismissal`, `ModerationFlag` (`:461-498,567-584`);
- roadmap: `FeatureRequest`, votes, comments, status events (`:609-667`);
- remote Code: `CodeDevice`, `CodeTask`, `CodeTaskEvent` (`:694-741`);
- sharing, scheduled tasks/runs, and message versions (`:755-852`).

No synced aggregate has a durable account cursor, record revision, client mutation ID, mutation receipt, or general tombstone. Most deletes are hard deletes.

## Confirmed contradictions and duplicate authorities

### Authentication

- The web native-handoff page reads the Auth.js session cookie (`W/src/app/app-auth/page.tsx:21-27`) and places it in `juno://auth?token=…` (`W/src/app/app-auth/handoff.tsx:14-18,42-56`).
- Native accepts that raw token, installs it as a cookie, and stores it in Keychain (`M/Juno/Services/Backend/AuthSession.swift:188-214`).
- Native also submits account passwords directly through the Auth.js browser-cookie credentials protocol (`M/Juno/Services/Backend/AuthSession.swift:4-17,92-123,265-312`).
- There is no PKCE/state-bound one-time authorization code, device session, scoped refresh token, or per-device revocation.
- The API middleware allows all mutation requests with no `Origin` header (`W/src/middleware.ts:10-12,56-58`), which makes possession of the exported cookie sufficient API authority.

### Sync

- Native documentation calls the current mirror “real sync,” but its implementation is periodic upsert-only pulls plus fire-and-forget writes (`M/README.md:94-100`; `M/Juno/Services/Backend/SyncService.swift:5-46`).
- Server lists are capped or filtered: conversation listing excludes archived rows, searches title only, and takes 200 (`W/src/lib/queries.ts:17-35`); library takes a bounded latest set.
- There is no cursor, outbox, idempotency, base revision, conflict response, deletion propagation, or resumable realtime stream.
- Consequently current behavior cannot prove that web and Mac converge under retries, offline edits, concurrent writes, or deletion.

### Models and reasoning

- Model authority is split among curated definitions (`W/src/lib/models.ts:23-49,127-133`), generated discovery, guessed metadata, pricing/reasoning caps (`W/src/lib/model-metrics.ts`), prose docs, and native `ModelCatalog.swift`.
- `/api/models` does not return exact supported reasoning-effort values (`W/src/app/api/models/route.ts:10-24`); web exposes only a coarse `reasoning` boolean (`W/src/lib/models.ts:23-49`).
- Web and scheduled tasks silently substitute unavailable/unauthorized models (`W/src/app/api/chat/route.ts:258-278`; `W/src/lib/scheduled-tasks.ts:189-203`).
- Native has its own resolution/fallback tests and catalog, so the same selection can resolve differently.
- Web types explicitly expose complete verbatim reasoning parts (`W/src/types/chat.ts:43-52,175-184`) and the database persists reasoning (`W/prisma/schema.prisma:245-272`). This conflicts with the rebuild requirement to expose only safe user-facing summaries, never hidden chain-of-thought.

### Preferences and design

- Accent options claim to be a single source while requiring manual CSS synchronization (`W/src/lib/accents.ts:1-3`). Coral preview is `hsl(15 63% 60%)` (`:5-10`), while the actual web primary is `15 54% 51%` (`W/src/app/globals.css:25,151-152`).
- Web tokens live in CSS/Tailwind and `design.md` (`W/src/app/globals.css:14-164`; `W/tailwind.config.ts:38-145`). Native hardcodes a different graphite palette, accent values, SF Pro/New York typography, radius, and motion (`M/Juno/DesignSystem/Theme.swift:40-193`).
- Project stars, composer preferences, onboarding completion, and memory-edit undo state are local browser state rather than canonical account data.
- Web `ReasoningEffort` includes `minimal` and `xhigh` (`W/src/types/chat.ts:7-14`), but composer preference sanitization discards both (`W/src/components/app/app-provider.tsx:67-83`).

### Product behavior

- The query layer says archived chats remain searchable (`W/src/lib/queries.ts:9-14`), while the API never accepts archive mode and defaults to excluding them (`W/src/app/api/conversations/route.ts:11-16`).
- Folder create/rename/move APIs exist, but the sidebar only exposes filtering/deletion.
- Saved-prompt CRUD and `PromptLibraryDialog` exist, but the dialog has no consumer.
- Message edit snapshots the edited row but deletes all later messages and artifacts with no revision check (`W/src/app/api/messages/[id]/route.ts:30-45`).
- Server branching omits attachments, artifacts, and prior versions (`W/src/app/api/conversations/[id]/fork/route.ts:17-26`), while a second web “fork” is an unsaved `sessionStorage` private transcript (`W/src/components/chat/chat-view.tsx:122-126,590-658`).
- Memory edit is documented as propose/review/accept but the page immediately applies it; its undo ledger is browser-local.
- Connections production UI imports fixture tools and generated call logs (`W/src/app/(app)/connections/page.tsx:13`; `W/src/lib/mcp-dashboard-fixture.ts:1-5`).

## Priority risks

### P0 — blocks a production rebuild

1. **Native auth bearer-cookie export.** A reusable web session token crosses an app URL without PKCE, one-time exchange, device binding, rotation, or per-device revocation.
2. **No real sync contract.** Upsert-only pulls and fire-and-forget writes cannot propagate deletion, detect conflicts, or provide exactly-once mutation effects.
3. **No canonical model/capability endpoint.** Web and Mac maintain separate model and reasoning-effort logic; silent substitution hides contract violations.
4. **Hidden reasoning exposure.** Persisted and streamed verbatim reasoning must not become a Mac parity requirement.
5. **Native agent accounting is client-trusted.** `/api/agent` forwards native bodies while `/api/agent/usage` separately trusts client start/record/refund phases (`W/src/app/api/agent/[...path]/route.ts:23-31,83-97`; `W/src/app/api/agent/usage/route.ts:43-83`).
6. **Code host identity is not secure.** Any account session can register/update a device, claim a task, append arbitrary events/status, or answer approvals; there is no device credential or state-machine enforcement.
7. **Destructive mutation semantics.** Message edit and hard deletes have no base revision, tombstone, recovery, or replay protection.
8. **Release gates are non-enforcing.** Production skips type/lint/tests and uses `prisma db push`.

### P1 — required for parity and operational integrity

1. Complete folders, archive/restore/search, saved prompts, library, artifacts, media generation, compare, roadmap, scheduled tasks, shares, account export/deletion, connectors, and billing behavior.
2. Move browser-only account preferences to canonical storage.
3. Replace production fixtures and silent capability fallbacks with explicit states.
4. Make account export complete; it currently claims a full snapshot but omits numerous entities and caps messages at 50,000 (`W/src/app/api/account/export/route.ts:10-27`).
5. Make scheduled task claiming recoverable; the worker advances `nextRunAt` before execution (`W/scripts/scheduled-task-runner.ts:54-73`).
6. Make generation cancellation durable; it is an in-process global map (`W/src/lib/generation-cancel.ts:12-17,35-49`).
7. Close storage/privacy gaps: unauthenticated bearer-key local files, optional public CDN URLs, local-disk production fallback, incomplete external cleanup.
8. Generate one shared design-token artifact for web and native instead of hand-copying values.

## Observed versus proposed target

| Area | Observed current state | Proposed rebuild contract |
|---|---|---|
| Native auth | Auth.js cookie persisted in Keychain; raw cookie deep-link handoff; direct credential callback also supported | System-browser auth with state + PKCE, hashed short-lived one-time code, atomic exchange, rotating device refresh token, scoped access token, device list/revocation, session-version binding |
| API contract | Unversioned route-local schemas and manually duplicated Swift DTOs | Versioned OpenAPI/JSON Schema, generated clients/types, explicit error and capability envelopes, backward-compatibility policy |
| Sync | Pull lists, upsert SwiftData, selected fire-and-forget pushes; no deletes/conflicts/cursor | Transactional change log/outbox, monotonically increasing account cursor, record revisions, tombstones, idempotent mutation receipts, base-revision conflicts, cursor paging, resumable notification stream |
| Models | Multiple registries; endpoint omits supported efforts; silent fallback | Backend-only authority returning exact availability, entitlement, modalities, lifecycle, prices/cost class, context, and ordered supported effort values; typed rejection instead of substitution |
| Chat reasoning | Verbatim reasoning persisted/streamed/displayed | User-safe progress and concise reasoning summaries only; never expose provider-hidden chain-of-thought |
| Preferences | Split among Settings, localStorage, SwiftData, Swift settings, and prose tokens | Canonical account preferences plus device-local settings explicitly labeled and modeled |
| Code/agent | Account cookie authorizes host/viewer roles; client reports spend; native Mac unsandboxed | Device-bound host credential, scoped task authority, signed/validated transitions, approval request identity, idempotency, server-correlated usage reservation/finalization, audited local permission engine |
| Quality gate | Green build can contain type/lint errors; no comprehensive tests; `db push` in CI | Migration-only production deploy; lint/type/schema drift/unit/integration/contract/UI gates; auth replay and sync conflict/deletion test suites |
| Design | Web CSS/Tailwind/prose and native Swift values diverge | Generated cross-platform color/type/spacing/radius/motion tokens with visual regression coverage |

## Audit limitations

- No private development-account content was inspected.
- No production database, Stripe account, S3 bucket, Composio account, provider account, OAuth consent, or voice relay was exercised.
- No secret-bearing network trace was recorded; therefore cookie flags, proxy behavior, TLS termination, provider payloads, and production response headers were assessed from code/configuration rather than packet evidence.
- Build/test results are point-in-time results for the Phase 0 worktrees and do not establish production runtime health.
- The successful Next build is weakened by configured type/lint suppression.
- The successful native build/tests do not cover live authentication, production sync, concurrency, deletion, device revocation, notarization, auto-update, accessibility audit, or offline recovery.
- Static inspection can identify missing invariants and reachable risk paths; it cannot prove that every path is exercised in production.
