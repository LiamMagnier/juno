# Juno Native API gaps

Initial handoff snapshot: 2026-07-21.

This is a factual gap register for native delivery. It does not mark existing
server foundations as missing, and it does not treat an uncommitted route or a
Web-only implementation as production-ready native support.

## Foundations to preserve

- Native bearer authentication already has PKCE-S256 validation, short-lived
  access tokens, rotating refresh tokens, reuse detection, device revocation,
  ban and `sessionVersion` invalidation.
- `/api/v1` already supplies versioned request IDs/errors, bootstrap, cursor
  changes, SSE wakeups, entity hydration, revisions, tombstones, compaction and
  idempotent mutations.
- The Web backend already owns encrypted messages, uploads, chat streaming,
  projects, artifacts, memory, connectors, billing, scheduled tasks and voice.
- Cloud Code already has GitHub repository discovery, OIDC single-use runner
  handoff, scoped task tokens, a vendored agent core, event streaming, branches
  and pull requests.
- The current working tree contains a draft Remote Session index/snapshot/event/
  command relay with explicit tombstones, replay protection, optimistic versions
  and `metadata`/`recent`/`full` transcript policies.

These primitives should be audited and extended rather than independently
reimplemented for native clients.

## P0 — blocks a functional native foundation

### GAP-001 — callback URI contract drift

Status: resolved for backend/OpenAPI/generation in `b903159`; canonical
URL-scheme registration is present in both independent apps as of `0fb7cc3`.
Production `ASWebAuthenticationSession` composition and strict callback/state/
nonce/code validation are implemented in `7e80d8e`.

- `src/lib/native-auth-core.ts` declares
  `com.liammagnier.juno://auth/callback` as canonical and accepts
  `juno://auth/callback` as legacy.
- `contracts/openapi/juno-native-v1.yaml` now makes the canonical URI the
  default and enumerates only the canonical and legacy values.
- `docs/JUNO.md` describes the canonical `com.liammagnier.juno://` lineage.

Completed: the authentication/callback correction shipped in contract 1.0.1;
the current 1.1.0 contract and server still report the same version, generation
is deterministic and self-contained, focused tests verify the exact allowlist,
and new app configurations register only the canonical scheme.
Remaining project work: run an interactive signed-in browser return/cancellation
matrix on both platforms. Removing the legacy URI server-side would still break
existing builds.

### GAP-002 — native client source and topology foundation

Status: source/topology foundation resolved in `0fb7cc3`.

The repository now contains a ten-product Swift package, compile-verified API/auth/
storage/sync/search primitives, and independent macOS and iOS Xcode projects.
Both projects build in Debug and Stable unsigned. Production Keychain, SQLite,
transport/app composition and functional feature UI remain tracked by their
specific gaps; the existence of source does not make the clients release-ready.

### GAP-003 — OpenAPI does not represent native product parity

The OpenAPI file covers only auth, models, bootstrap, changes, entities and
mutations. It does not define the bearer-facing contracts for chat/streaming,
uploads, attachments, files, artifacts, voice, account lifecycle, subscriptions,
Code Cloud, Code Remote, notifications or StoreKit reconciliation.

Required resolution: verify which existing routes safely support authoritative
bearer auth, add versioned routes only where needed, and describe every important
request, response, error and stream in a typed contract. Preserve Web compatibility.

### GAP-004 — Swift generation is incomplete and not a drift gate

`scripts/generate-native-swift-contract.mjs` checks selected source fragments and
emits a small hand-authored model subset. It does not generate the full OpenAPI
schema and omits most request/response unions. As of `b903159`, its existing
output is deterministic, public, Sendable and self-contained; the undefined
`BackendUser` dependency is removed and its digest compiles under strict Swift.

Progress in `0fb7cc3`: the selected self-contained Sendable output is checked in
under `JunoAPI/Generated`; `npm run native:contract:check` regenerates it in a
temporary directory and fails on drift, and the package compiles/tests under
strict concurrency. Remaining resolution: generate the complete model/client
layer and enforce regeneration in native CI.

### GAP-005 — no native storage, outbox or synchronization engine

Server sync primitives exist, but no client implements a transactional migratable
cache, account separation, cursor persistence, offline mutation queue, optimistic
rollback, conflict resolution, compaction recovery, reconnect backoff/jitter,
crash recovery, corruption rebuild or secure cache wiping.

Progress in `0fb7cc3`: account-scoped storage protocols, a deterministic
in-memory transactional test adapter, cursor-page application, and mutation
outbox state/retry/conflict primitives have focused Swift tests. They are not a
production database or complete sync actor.

Progress in `9bceb7e`: the native clients now have a versioned encrypted SQLite
store, account-scoped atomic records/cursors, production Keychain key custody,
secure wipe and bootstrap-baseline installation. Durable outbox and the complete
network coordinator remain.

Proven server contract gap (2026-07-21): a fresh client cannot discover the ids
needed by `GET /api/v1/entities`. `/bootstrap` returns only a current cursor,
`/entities` requires caller-supplied ids, and starting `/changes` at the current
cursor intentionally omits historical rows. The old native app works around this
with several feature-specific list routes, but those routes are capped and do not
cover all sync entity types. Rows created before change capture also have no
`EntityRevision`, so a revision-table-only inventory would be incomplete.

Resolution in this unit: backfill live pre-capture rows at revision zero and
expose an owner-scoped, keyset-paginated entity inventory adjacent to the
existing `/entities` hydration route. Payload hydration stays in the existing
loader; clients replay `/changes` from the bootstrap cursor so concurrent writes
are not lost.

Progress in `364f0f2`: both production app roots now compose the encrypted
SQLite cache, persisted bootstrap/cursor, authoritative hydration, atomic change
pages, tombstones/revisions, real SSE wakeups, compaction rebuild, reconnect
backoff/jitter and a durable account-scoped mutation outbox/drainer. Remaining:
conflict UI and Web-to-Swift live-account offline/reconnect proof.

Proven conversation-mutation gap (2026-07-22): the existing bearer
`conversation.update` mutation supports title, pin, project and folder, but not
the conversation's sticky `model`. The Web route and old native app both persist
that field, and the sync entity already returns it. Resolution is limited to
accepting and validating `patch.model` in the existing mutation; no route or
service is added.

### GAP-006 — route error behavior is inconsistent outside `/api/v1`

`/api/v1` returns typed request-ID/versioned error envelopes. Many reusable
general and Code routes return ad hoc `{ error: string }` bodies without contract
version, retryability, typed details or consistent rate-limit metadata.

Required resolution: define a native error envelope and adapters for every route
used by native clients without breaking existing Web callers.

### GAP-007 — native chat and upload contracts are not explicit

Status: chat contract and transport resolved in the current native chat unit;
upload/attachment contract work remains.

The Web has production chat SSE, receipts, cancellation and uploads, and its
session gate can support bearer requests. The exact native request headers,
idempotency behavior, SSE resume semantics, attachment claim flow, cancellation
and typed event schema are not captured in OpenAPI or tested as native contracts.

Required resolution: publish and test the authoritative bearer flow before
building native chat transports.

Resolution for chat: OpenAPI 1.1.0 now publishes the existing bearer-capable
transcript append, `/api/chat` SSE, cancellation and receipt routes with typed
request/response/event schemas. The Swift transport uses the old application's
production SSE protocol, idempotently appends an existing-conversation user turn,
then regenerates from that persisted row. It never automatically re-POSTs after an
ambiguous stream loss; it reconciles the persisted assistant through the account
change feed. Focused transport tests cover fragmented SSE, the regenerate envelope
and exactly-one-POST recovery behavior. No backend chat route or service was added.

## P1 — blocks complete Juno Code and mobile behavior

### GAP-008 — Remote Session API is draft and outside OpenAPI

The Remote Session migration, routes and helpers are currently uncommitted
working-tree changes. Important snapshot fields (`transcript`, `changes`,
`terminal`, `tests`, `git`, `approvals`, `subagents`, `usage`) accept generic JSON,
which prevents reliable generated Swift models and version evolution.

Required resolution: review ownership/rate limits/privacy/migration behavior,
commit the server foundation, define versioned typed payloads, and add database
and route integration tests before treating it as production.

### GAP-009 — Code task creation omits canonical execution controls

`POST /api/code/tasks` can select device versus Cloud and repository/base branch,
but it does not accept the complete canonical model, reasoning effort, Ask/Plan/
Code mode, role preset or permission level required by the product. Existing
Remote-session messages expose some differently named fields.

Required resolution: define one typed execution-options model shared by Cloud,
Remote, host, event snapshots and native UI, with server-side capability validation.

### GAP-010 — captures and several Code result types are not first-class

Remote snapshots and event kinds do not currently expose screenshot/capture
records. Cloud tasks do not expose commits, checks and all diff/test/log data as
stable typed resources; some information can only ride generic event payloads.

Required resolution: add typed paginated capture, diff, terminal, test, Git,
commit, pull-request and check schemas with retention and redaction rules.

### GAP-011 — no push notification registration or APNs pipeline

There is no native push-token model/API or server delivery pipeline for approval
requests, agent questions, completion/failure, test failure, pull request creation,
Mac disconnection or session stop.

Required resolution: add account/device-scoped token registration, revocation,
preferences, minimal redacted payloads and foreground resynchronization behavior.

### GAP-012 — global search has no native protected index contract

The current Web palette searches only chat titles and project names. Message bodies
are encrypted on the server, so server-side plaintext message search would change
the security model.

Progress in `0fb7cc3`: a local-search protocol and deterministic in-memory adapter
cover normalized account-scoped indexing/querying and wipe behavior in tests.

Remaining resolution: add a protected durable index for authorized decrypted
content, define complete entity metadata/filters/recents, integrate authorization
and logout/revocation wiping, and keep server APIs to non-sensitive metadata
unless an explicit security decision says otherwise.

### GAP-013 — bootstrap and compatibility metadata are incomplete

`/api/v1/bootstrap` currently reports a macOS minimum version only, empty feature
flags and no effective announcement data. It does not express separate stable/next
iOS, iPadOS and macOS compatibility or capability negotiation.

Client progress in `9dad2a1`: the existing bearer route is reused without backend
changes. The native checkpoint validates account ownership, contract version,
canonical cursors and the model-manifest version; it intentionally does not invent
missing compatibility metadata.

Required resolution: add typed per-platform minimum/recommended versions,
contract/protocol capabilities, feature flags and maintenance/update messaging.

### GAP-020 — project favorites are absent from the native mutation union

Targeted project-route inspection confirmed that the synchronized `project`
entity and the existing bearer-capable `PATCH /api/projects/{id}` route both
support `starred`, while `project.update` in `/api/v1/mutations` accepts only
`name` and `instructions`. That prevents an offline native favorite change from
using the same revision and idempotency guarantees as other project edits.

Status: resolved in the current projects/files lot. The existing
`project.update` operation now has an optional boolean `starred` field, applies
it in the current transaction, mirrors it in OpenAPI, and has acceptance/rejection
coverage in the mutation contract tests. No new route or duplicate project
service was added.

### GAP-021 — no backend routes exist for Juno Code Cloud/Remote sessions

Juno Code macOS (PR #17, merged in `677d781`) runs its **local** agent loop
against the authenticated backend model transport, but Cloud and Remote Host
Code sessions have no server contract. `docs/native/JUNO_CODE_HANDOFF.md`
records this explicitly: the event model (`JunoCodeCore.SessionEventPayload`)
and the `JunoCodeBridge` adapters are ready, and the new-session sheet shows
both Cloud and Remote modes disabled because nothing in
`contracts/openapi/juno-native-v1.yaml` can back them.

What is missing (documented, not yet designed or built):

- Create/resume a Code session bound to an account and workspace.
- Ordered, resumable session events (a cursor-addressable event log so a
  reconnecting client replays from its last seen sequence).
- Idempotent session commands: prompt, approve, deny, stop.
- Remote Host addressing by opaque workspace ID (Mac-authoritative), so a
  mobile client can drive a session hosted on the user's Mac.

Why this is not resolved in this branch: unlike GAP-020, this is not a minimal
extension to an existing route or mutation — it is a new backend surface
(routes, Prisma migrations, auth scoping, streaming/event durability, and a
Remote Host addressing/relay model). The native continuation mandate is to
extend existing contracts minimally and never duplicate services, so this gap
needs an explicit owner-approved backend design before native Cloud/Remote Code
can be built. The local Code experience is fully functional without it.

Status: **substantially reframed** by the Phase-11 audit
(`docs/native/CODE_REMOTE_AUDIT.md`, branch `agent/juno-code-remote-backend`).
The earlier assessment was wrong: the Code control plane already exists in the
web backend AND already accepts the native bearer. Every `/api/code/*` owner
route authenticates a native bearer via `getCurrentUser()`, and
`CodeDevice`/`CodeWorkspace`/`CodeTask`/`CodeTaskEvent` already model hosts,
opaque-keyed workspaces, sessions (with a `lastSeq` event cursor + one-time
cloud handoff), and an append-only `(taskId, seq)` event journal, with
claim/respond/cancel/queue and a GitHub-Actions cloud runner. So this is not a
missing backend service.

Remaining work (native integration, not backend invention):
- Publish the `/api/code/*` surface in the native contract. **Done** for the
  read surface (`0719f59`, contract 1.3.0: devices, workspaces, sessions,
  session+events). The mutating command surface (create/respond/cancel) is next.
- Build the native clients: the `JunoCodeBridge` typed transport, the macOS
  Remote Host coordinator on the existing runtime/permissions, and the mobile
  Remote controller/screens.

### GAP-022 — the Code task/workspace serializers leak the device-local path

`serializeTask` returns `workspacePath` and `serializeWorkspace` returns `path`,
both device-local absolute paths. Native mobile clients must never surface these
(address by `workspaceKey`/`id`). The native contract marks these fields as
must-not-surface, but the correct fix is a path-free native projection on the
server — a minimal, additive change (a native-bearer serialization variant), not
a new route or service.

Status: open. Low-risk minimal server extension, to land with the native Remote
mobile client so the path never crosses to the phone.

## P1 — blocks commerce, release and production download

### GAP-014 — StoreKit 2 and server reconciliation are absent

Stripe-backed Web subscriptions exist, but there is no StoreKit product mapping,
purchase/restore verification, App Store server notification handling, account
association or double-subscription policy.

Required resolution: use configurable product identifiers, add server-side
verification/reconciliation, and test expiration, renewal, revocation and restore.

### GAP-015 — native release API/configuration is absent

The repository contains a legacy `public/downloads/Juno.dmg` and update manifest,
but no reproducible native archive/notarization/TestFlight pipeline, privacy
manifest checks, dSYM handling or signed release workflow tied to current source.

Required resolution: separate CI from signed release, generate verified macOS
DMG/PKG and iOS archives, update download metadata only after validation, and
publish only with real Apple/GitHub credentials.

### GAP-016 — native CI and contract verification are absent

Existing workflows cover the Web deployment, model sync and Cloud Code runner.
They do not run Swift tests, Xcode builds/tests, Release dry archives, OpenAPI
Swift regeneration drift checks, entitlement/privacy validation, dependency
license review or native binary secret scans.

Progress in `0fb7cc3`: local strict package build/tests, a deterministic contract
drift command, independent Debug/Stable builds, privacy manifests and native test
targets exist. No workflow runs them yet.

Required resolution: add macOS and iOS simulator jobs on appropriate macOS runners,
enforce project/contract regeneration drift, validate entitlements/privacy,
perform dependency/license/binary-secret checks, and archive diagnostics.

## P2 — completeness and robustness

### GAP-017 — integration and end-to-end coverage is insufficient

Native-auth, sync and Remote tests currently focus mainly on pure helpers. There
is no database-backed refresh reuse/concurrency suite, route ownership/replay suite,
Swift decoding/storage tests, UI tests, accessibility suite, or real Web↔Mac↔iPhone
end-to-end environment.

Required resolution: implement the complete test matrix before claiming parity.

Progress in `9dad2a1`: strict package coverage reaches 74 tests, including a
single-flight concurrent-401 rotation test and typed bootstrap failure cases.
Database-backed route and cross-surface scenarios remain open.

### GAP-018 — native account and connector handoffs need explicit contracts

Google sign-in, password recovery, connector OAuth, account export/deletion and
privacy/legal navigation exist for Web, but their native browser callback, bearer
authorization and deep-link behavior are not fully specified.

Required resolution: define secure system-browser handoffs and exact deep-link
routes, keeping cookies and bearer credentials strictly separated.

### GAP-019 — transcript retention and privacy semantics need product definition

The server recognizes `metadata`, `recent` and `full`, but the duration/size of
`recent`, defaults, deletion behavior, offline visibility, notification redaction
and user-facing disclosures are not fully defined.

Required resolution: document and enforce these policies consistently in host,
server, mobile UI and deletion/export flows.

### GAP-022 — chat message attachments are absent from the native contract

The Web composer attaches images and files to a message, but the native chat
send path (`POST /api/v1/chat`, projected by `NativeConversationModel.sendMessage`)
accepts only `conversationId`, `prompt`, `modelId` and `reasoningEffort`, and
`NativeChatMessage` has no attachment fields. Uploads exist only at the **project**
level (`/api/attachments`, `NativeProjectModel.uploadFile`), not per-message.

Consequence: the composer "+" popover deliberately does **not** show Camera,
Photos or Files. They are omitted (not shown disabled) until the contract exists.

Required resolution (stacked backend branch): add a native message-attachment
contract — signed upload, per-message attachment references on send, attachment
projection on `NativeChatMessage` — then wire native pickers and previews.

### GAP-023 — Deep Research and Canvas have no native contract surface

Web exposes Deep Research and Canvas modes, but there is no native `/api/v1`
route, request flag or manifest capability for either. They are therefore
**omitted** from the production composer menu (never shown as disabled rows) and
belong in a DEBUG-only panel at most.

Required resolution: define native request flags / capability manifest entries
for these modes (reusing the existing artifact/canvas model for Canvas) before
any native UI enables them.

The one composer action that **is** wired today is **Add to project**: it reuses
the server-validated `conversation.update` mutation with a `projectId` patch
(ownership-checked; `null` clears the association), surfaced through the new
`NativeConversation.projectId` projection and `NativeConversationModel.setProject`.

## Contract exit criteria

The API gap phase is complete only when:

1. canonical and legacy auth callbacks are aligned and tested;
2. every native-used route has authoritative bearer behavior and typed errors;
3. OpenAPI and generated Swift compile independently and CI detects drift;
4. important chat, upload, sync, Cloud and Remote payloads are typed and versioned;
5. idempotency, ownership, retry, ordering, compaction and revocation have negative
   integration coverage;
6. native storage/sync can pass offline, conflict, reconnect and account-switch
   scenarios without lost or duplicated data; and
7. remaining gaps require only genuine proprietary release inputs rather than
   missing product or engineering work.
