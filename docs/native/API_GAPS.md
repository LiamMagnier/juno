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

- `src/lib/native-auth-core.ts` declares
  `com.liammagnier.juno://auth/callback` as canonical and accepts
  `juno://auth/callback` as legacy.
- `contracts/openapi/juno-native-v1.yaml` currently constrains token exchange to
  the legacy `juno://auth/callback` only.
- `docs/JUNO.md` describes the canonical `com.liammagnier.juno://` lineage.

Required resolution: keep both callbacks accepted server-side for compatibility,
make the canonical URI the default emitted/used by new apps, and align OpenAPI,
generated Swift, Xcode URL schemes, browser handoff tests, universal/custom links
and release configuration. Removing the legacy URI would break existing builds.

### GAP-002 — no native client source in the active checkout

There is no `native/` directory, Swift package, Xcode project, Keychain client,
local database, API client, sync engine, macOS app, or iOS/iPadOS app in the active
repository tree.

Required resolution: create two independent app projects plus shared packages,
then make the generated contract compile independently. Any native code found in
other local worktrees must be audited for security and topology before reuse.

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
schema, omits most request/response unions, and references `BackendUser` from
outside the generated file.

Required resolution: generate a self-contained Sendable Swift model/client layer,
check the contract digest, and add CI that regenerates and fails on any diff.

### GAP-005 — no native storage, outbox or synchronization engine

Server sync primitives exist, but no client implements a transactional migratable
cache, account separation, cursor persistence, offline mutation queue, optimistic
rollback, conflict resolution, compaction recovery, reconnect backoff/jitter,
crash recovery, corruption rebuild or secure cache wiping.

Required resolution: implement these in shared Swift packages and prove them with
Web-to-Swift contract tests and the mandatory offline/reconnect scenarios.

### GAP-006 — route error behavior is inconsistent outside `/api/v1`

`/api/v1` returns typed request-ID/versioned error envelopes. Many reusable
general and Code routes return ad hoc `{ error: string }` bodies without contract
version, retryability, typed details or consistent rate-limit metadata.

Required resolution: define a native error envelope and adapters for every route
used by native clients without breaking existing Web callers.

### GAP-007 — native chat and upload contracts are not explicit

The Web has production chat SSE, receipts, cancellation and uploads, and its
session gate can support bearer requests. The exact native request headers,
idempotency behavior, SSE resume semantics, attachment claim flow, cancellation
and typed event schema are not captured in OpenAPI or tested as native contracts.

Required resolution: publish and test the authoritative bearer flow before
building native chat transports.

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

Required resolution: build a protected local index for authorized decrypted
content, define searchable entity metadata and wipe rules, and keep server APIs to
non-sensitive metadata unless an explicit security decision says otherwise.

### GAP-013 — bootstrap and compatibility metadata are incomplete

`/api/v1/bootstrap` currently reports a macOS minimum version only, empty feature
flags and no effective announcement data. It does not express separate stable/next
iOS, iPadOS and macOS compatibility or capability negotiation.

Required resolution: add typed per-platform minimum/recommended versions,
contract/protocol capabilities, feature flags and maintenance/update messaging.

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

Required resolution: add macOS and iOS simulator jobs on appropriate macOS runners
and archive all test/build diagnostics.

## P2 — completeness and robustness

### GAP-017 — integration and end-to-end coverage is insufficient

Native-auth, sync and Remote tests currently focus mainly on pure helpers. There
is no database-backed refresh reuse/concurrency suite, route ownership/replay suite,
Swift decoding/storage tests, UI tests, accessibility suite, or real Web↔Mac↔iPhone
end-to-end environment.

Required resolution: implement the complete test matrix before claiming parity.

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
