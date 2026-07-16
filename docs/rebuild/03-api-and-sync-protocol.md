# API and synchronization protocol

Status: proposed v1 contract, informed by the Phase 0 audit on 2026-07-16. Nothing in this document claims the current `/api/*` routes already provide revisions, cursors, tombstones, or idempotency. Observed legacy evidence is called out explicitly.

## Observed incompatibilities

- Existing web handlers are unversioned under `src/app/api/**` and primarily authenticate through `src/lib/session.ts` using the Auth.js cookie.
- `src/app/app-auth/page.tsx` and `handoff.tsx` currently return that cookie in a custom-scheme URL. There are no app authorization, refresh, or device-session endpoints.
- `prisma/schema.prisma` has no account change sequence, per-entity revision, mutation receipt, or general tombstone model.
- `juno-app/Juno/Services/Backend/SyncService.swift` pulls full lists by timestamp, guesses identical messages from role/content, silently retains local IDs after failed creates, discards mutation failures, and does not propagate deletion.
- Swift DTO knowledge is handwritten across `BackendModels.swift`, `SyncModels.swift`, `BackendClient.swift`, `ChatTransport.swift`, and Remote Code types.
- `/api/models` is backed by `src/lib/models.ts` and discovery, while exact effort rules remain separate in `src/lib/model-metrics.ts`.

The following is the target contract. Existing web endpoints remain supported while domain logic is extracted behind compatible handlers.

## Protocol conventions

### Base, media types, and versions

- Base path: `/api/v1`.
- JSON: `application/json`; timestamps are UTC RFC 3339 with fractional seconds.
- Streaming: `text/event-stream; charset=utf-8` with an explicit terminal event.
- Contract version is the URL major version. Additive optional fields and new enum values are compatible. Removing/renaming a field, changing meaning, or narrowing accepted input requires a new major version.
- Every response includes `X-Juno-Request-Id`; authenticated responses include a non-secret `X-Juno-Contract-Version`.
- Clients preserve unknown enum strings and expose a safe unavailable state rather than failing an entire payload.

### Authentication

Web routes retain cookie authentication. Native `/api/v1` calls use `Authorization: Bearer <short-lived-access-token>`. Refresh tokens appear only in token endpoint bodies over TLS and Keychain, never in URLs, logs, cookies, analytics, crash metadata, or model/sidecar processes.

Access claims include `iss`, `aud=juno-native`, `sub=userId`, `sid=deviceSessionId`, `iat`, `exp`, token type, and a session/account version. Server verification also checks the user exists, is not banned, and the device session has not been revoked.

### Mutation envelope

All account mutations accept:

```json
{
  "clientMutationId": "018f...uuid-v7",
  "baseRevision": 7,
  "operation": { "type": "conversation.rename", "title": "Release notes" }
}
```

`clientMutationId` is stable across retries. The device-session identity comes exclusively from the verified access token's `sid`; the mutation body cannot select it. The uniqueness boundary is `(accountId, authenticatedDeviceSessionId, clientMutationId)`. The server stores a receipt in the same transaction as the mutation and returns the original outcome for a byte-semantically equivalent replay. Reuse with a different operation returns `409 idempotency_key_reused`.

Create operations may include `clientEntityId`, a device-generated UUID used for dependency references before the canonical ID is known. The receipt contains the mapping.

### Entity envelope

Synchronizable resources expose:

```json
{
  "id": "canonical-server-id",
  "revision": 8,
  "createdAt": "2026-07-16T03:00:00.000Z",
  "updatedAt": "2026-07-16T03:02:00.000Z",
  "deletedAt": null,
  "data": {}
}
```

Revision is an opaque monotonically increasing integer for that record. A delete writes a tombstone with a new revision and minimal identity metadata. The account change log publishes a `compactionFloorCursor`. Physical purge occurs only after the documented retention period and after the floor has advanced beyond the row. A client older than the floor receives `410 cursor_expired` plus a reconciliation token and must install a cursor-consistent snapshot before it may push dependent mutations; it cannot infer deletion from absence.

### Typed errors

Errors share one non-sensitive structure:

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "This conversation changed on another device.",
    "requestId": "req_...",
    "retryable": false,
    "retryAfterMs": null,
    "details": { "currentRevision": 9 }
  }
}
```

Required codes include `invalid_request`, `unauthenticated`, `token_expired`, `device_revoked`, `forbidden`, `plan_required`, `quota_exceeded`, `not_found`, `revision_conflict`, `idempotency_key_reused`, `dependency_pending`, `rate_limited`, `stream_interrupted`, `upload_incomplete`, `unsupported_capability`, and `server_unavailable`. Details never contain tokens, raw prompts/responses, provider keys, or storage paths.

## Native authorization and device sessions

### Browser authorization

`GET /app-auth?state=...&code_challenge=...&code_challenge_method=S256&nonce=...&redirect_uri=juno%3A%2F%2Fauth%2Fcallback`

Requirements:

- `state`, `nonce`, and verifier have at least 256 bits of randomness where applicable.
- Only S256 PKCE is supported; plain PKCE is rejected.
- Redirect matching is exact against an allowlist. Query fragments and alternate hosts/paths do not widen it.
- The normal Auth.js email/password and Google UI is used inside `ASWebAuthenticationSession`; the app never receives the password or provider token.
- After successful web authentication, the server stores only a hash of a random authorization code plus user, challenge, nonce, redirect, expiry, and unused state.
- Callback: `juno://auth/callback?code=<one-time>&state=<original>&nonce=<original>`. No session token is present.

### `POST /api/v1/auth/token`

Request: authorization `code`, PKCE `codeVerifier`, exact `redirectUri`, `deviceName`, platform, app version, and an installation identifier that is random and non-hardware-derived. The code is atomically consumed before credentials are returned. A mismatch, reuse, or expiry is indistinguishable through `invalid_grant`.

Response:

```json
{
  "tokenType": "Bearer",
  "accessToken": "opaque-or-signed-app-token",
  "accessTokenExpiresAt": "2026-07-16T03:15:00Z",
  "refreshToken": "random-rotating-secret",
  "refreshTokenExpiresAt": "2026-08-15T03:00:00Z",
  "deviceSession": { "id": "dev_...", "name": "Liam's Mac", "createdAt": "..." }
}
```

### `POST /api/v1/auth/refresh`

Consumes the current refresh token and returns a new access token plus a new refresh token in the same family. Token hashes, parent linkage, used time, expiry, and revocation state are stored. Concurrent use has one winner. Reuse of an already rotated token revokes the token family/device session and returns `token_reuse_detected`; no descendant remains valid.

### Session endpoints

- `GET /api/v1/auth/session`: current profile/session/expiry and minimum supported app/contract version.
- `POST /api/v1/auth/logout`: revoke current device session; idempotent.
- `GET /api/v1/auth/devices`: user-visible sessions with name/platform/app version/created/last seen/current/revoked; never token hashes.
- `DELETE /api/v1/auth/devices/{id}`: revoke a device owned by the account and emit an account change/audit event.

Access-token validation checks revocation on every privileged request. A short access lifetime bounds cache delay; the realtime stream also emits a non-secret session-revoked terminal event.

### Legacy migration

The new app may read only whether the legacy Keychain Auth.js item exists. It does not transmit or silently exchange that bearer for a longer-lived device session. The user completes a fresh trusted-browser authorization; after the new device session validates and initial sync succeeds, the legacy item is deleted. Cancellation/failure leaves it untouched in a clearly labelled migration-required state. New `/app-auth` requests never use `juno://auth?token=`.

## Bootstrap and authoritative capabilities

`GET /api/v1/bootstrap` returns one consistent account snapshot: profile, plan/subscription/entitlements, quota and spend window, synchronized settings, feature flags, minimum client versions, current change cursor, model-manifest version, and safe announcement summaries. It does not embed all account content.

`GET /api/v1/models` returns:

```json
{
  "manifestVersion": "2026-07-16.1",
  "generatedAt": "...",
  "models": [{
    "id": "provider/model",
    "provider": { "id": "openai", "displayName": "OpenAI" },
    "displayName": "...",
    "lifecycle": "active",
    "availability": "available",
    "minimumPlan": "pro",
    "modalities": { "input": ["text", "image"], "output": ["text"] },
    "contextWindowTokens": 200000,
    "pricing": { "class": "premium", "inputPerMillion": null, "outputPerMillion": null, "currency": "USD" },
    "supportedReasoningEfforts": ["minimal", "low", "medium", "high", "xhigh"],
    "capabilities": { "tools": true, "webSearch": true, "attachments": true, "streaming": true }
  }]
}
```

Unknown effort/capability values are retained. The UI shows only returned effort values. A requested unavailable model/effort returns a typed error with allowed values; chat and scheduled tasks must not silently substitute a different model. The offline manifest is a generated artifact bearing `manifestVersion` and contract digest.

## Account resources covered by v1

The published OpenAPI schemas cover the entire authenticated end-user surface discovered in `01-parity-matrix.md`:

- account/profile/avatar, settings/onboarding/preferences, subscription/entitlements/quota/spend;
- folders, conversations, messages, message versions, feedback, shares, sources, activity, safe reasoning summaries;
- attachments, upload sessions, downloads, project files, artifacts/versions/preview/export, library views;
- projects and instructions;
- memory entries/summaries/suppression/backfill/edit proposals/apply/undo;
- saved prompts, connectors/MCP, scheduled tasks/runs, announcements/dismissals, roadmap feedback;
- Code devices/projects/workspaces/session/task metadata, events, approvals, usage, and explicit artifacts.

Public/legal routes remain normal web routes. Billing checkout/portal and connection OAuth may use a secure browser handoff. Privileged admin routes require durable RBAC/audit before native support; until product-approved, they use an explicit authenticated web handoff and are not represented as ordinary native user parity.

## Change log and cursor API

### Storage invariants

Proposed additive tables/models:

- `AccountChange(accountId, cursor, entityType, entityId, revision, operation, changedAt, mutationReceiptId, payloadVersion)`
- `MutationReceipt(accountId, authenticatedDeviceSessionId, clientMutationId, requestHash, status, entityMappings, result, createdAt)`
- revision/tombstone fields on synchronized aggregates, or a rigorously equivalent aggregate-version table during migration;
- `NativeAuthorizationCode`, `NativeDeviceSession`, and hashed refresh-token family rows.

Cursor allocation and mutation data commit transactionally. A mutation cannot be visible without its change event or receipt. Change payloads are minimal and versioned; sensitive content may require a follow-up authorized resource fetch.

### `GET /api/v1/changes?after=<cursor>&limit=<n>`

Returns cursor-ordered changes scoped to the current account:

```json
{
  "after": "1042",
  "changes": [
    { "cursor": "1043", "entityType": "conversation", "entityId": "c1", "revision": 4, "operation": "upsert" },
    { "cursor": "1044", "entityType": "attachment", "entityId": "a9", "revision": 2, "operation": "delete", "deletedAt": "..." }
  ],
  "nextCursor": "1044",
  "compactionFloorCursor": "900",
  "hasMore": false
}
```

The client durably commits applied entity updates and the new cursor in one local transaction. It never advances past a failed change. Duplicate pages/events are harmless. Cursors are opaque and strictly ordered but need not be numerically contiguous; the server, not client arithmetic, identifies page completeness. When `after` predates `compactionFloorCursor`, the endpoint returns `cursor_expired` and the client performs the mandatory reconciliation snapshot before replaying its outbox.

### `GET /api/v1/changes/stream?after=<cursor>`

SSE is a wakeup channel. Events include `ready`, `cursor`, `heartbeat`, `session-revoked`, `error`, and terminal `done`. `cursor` contains only the latest available cursor; the client then calls the paged endpoint. Reconnect uses the durable cursor, not an in-memory event ID. Unknown event types are ignored and logged only as schema metadata; EOF without terminal/reconnect semantics is an interruption, not success.

### `POST /api/v1/sync/reconcile`

Accepts bounded entity types and known cursor/cache digests. Returns or schedules a cursor-consistent authoritative snapshot with tombstones and a new baseline. Repeating it is safe. It never treats local absence as a server delete.

## Conflict rules

| Case | Rule |
|---|---|
| Identical mutation retry | Return stored receipt; do not execute twice. |
| Update with current base revision | Apply, increment revision, write receipt/change. |
| Stale update to scalar semantic field | Return `revision_conflict` with current state and allowed resolution actions. |
| Mergeable set membership | Server may perform a documented set merge and return `merged=true`; never infer merge for free text. |
| Update after tombstone | Conflict; offer explicit restore if the entity supports it. |
| Delete retry | Return original tombstone receipt. |
| Create dependency still local/pending | Hold behind dependency in client outbox or return `dependency_pending`; never drop. |
| Same-content messages | Distinct canonical/client IDs remain distinct. Content equality is never identity. |
| Stream interrupted mid-turn | Reconcile by stable turn/message IDs and server status; never append a duplicate user/assistant message. |

User-facing conflict records persist until resolved. Resolution itself is a new idempotent mutation with the current base revision; original unsynced content is retained for export/recovery.

## Native outbox state machine

Each row contains account, authenticated device-session binding, mutation ID, operation schema version, target/client IDs, base revision, dependencies, encrypted/safely stored payload, creation time, attempt count, next attempt, send lease expiry, and state.

```text
queued -> sending -> acknowledged
   |         |
   |         +-> retry_wait -> sending
   +------------> blocked_dependency
   +------------> conflict -> resolved/replaced
   +------------> failed_permanent -> user retry/export/discard
```

`sending` is a durable lease, not a terminal state. On launch/foreground, any lease whose deadline passed returns to `retry_wait` with the same mutation ID; a receipt lookup or idempotent replay determines whether the server committed before the crash. The UI surfaces pending, offline, retrying, conflicted, and failed states. Bounded exponential backoff uses jitter and honors `Retry-After`; authentication expiry pauses replay for refresh. A revoked session locks the account and never converts signed-in work to private/local mode. Outbox and cache changes commit atomically where one depends on the other.

## Upload and attachment protocol

1. `POST /api/v1/uploads` with mutation ID, filename/display metadata, size, content type, and strong content digest creates or resumes an upload session.
2. Chunks use stable offsets/part IDs and checksums; duplicate parts are idempotent.
3. `POST /api/v1/uploads/{id}/complete` verifies digest/size, commits storage metadata, attachment/project-file row, mutation receipt, and account change.
4. Incomplete sessions expire and storage cleanup is retried/audited. A database failure cannot leave an unowned public object.
5. Downloads require account authorization or a deliberate revocable share capability. Object-key secrecy and permanent public S3 URLs are not authorization.

Account project reference files sync. Local workspace bookmarks and repositories never upload implicitly.

## Streaming chat and cancellation

Turns and messages have stable IDs before streaming. Each event carries a monotonically ordered per-turn `sequence`; the client persists the last applied sequence. Events include `turn.started`, `message.delta`, `reasoning.summary.delta`, `source`, `artifact`, `usage`, `turn.status`, `error`, and exactly one terminal event. `GET /api/v1/turns/{id}` returns authoritative status and durable message IDs; `GET /api/v1/turns/{id}/events?afterSequence=` replays retained events or returns a snapshot-required marker. SSE reconnect sends `Last-Event-ID`/the last sequence, then reconciles through these endpoints. Hidden chain-of-thought is neither transported nor persisted; only an explicitly safe user-facing summary is allowed. Cancellation is a server-persisted idempotent command, not only an in-process map. Restart/reconnect never treats bare EOF as `.stop` and cannot append a second user/assistant message for the same stable turn.

## Code session event protocol

The shared schema covers:

- session/task lifecycle and lead/subagent ownership;
- user and assistant turns with safe summaries;
- plan steps and status;
- tool request/result with redacted, scoped metadata;
- approval requested/resolved/expired with policy snapshot;
- command start/output-summary/exit/cancel (raw terminal output device-local by default);
- file diff/checkpoint/review comment/accept/reject;
- test/build/lint and Git/PR/CI summaries;
- usage reservation/settlement tied to the model invocation;
- error and completion.

Events are ordered and idempotent per session. Local path values are represented by device-scoped handles in account-visible data. A remote approval is bound to the requesting device/session/action digest and cannot be answered with a bare unrelated Boolean.

## Schema generation and compatibility tests

The OpenAPI/JSON Schema source is canonical. Generated Swift files carry a header with contract digest and are never manually edited. CI performs:

- schema validation and breaking-change detection;
- deterministic Swift generation or decoding validation;
- fixture tests for success, every typed error, unknown enums/fields, pagination, SSE fragmentation/cancellation, and large/empty payloads;
- route tests against representative database fixtures;
- live development-server contract smoke using a disposable test account and redacted traces;
- legacy web compatibility tests;
- sync model/property tests with duplicate, reordered, dropped, and retried requests.

Contract examples contain synthetic identifiers and content only. Captured traffic is scrubbed before storage and never includes authorization, cookies, provider keys, real prompts, messages, attachments, or account PII.

## Initial implementation slices

1. App authorization/device sessions and bearer verification, with raw-callback removal and legacy migration.
2. Bootstrap/model manifest with explicit effort values and typed availability errors.
3. Change/receipt foundation plus settings and conversation-metadata canary, including tombstone/cursor tests.
4. Swift cache/outbox/realtime client and two-client convergence harness.
5. Messages/turn streaming, uploads/attachments, projects/files, then remaining parity aggregates.

No production migration, token rotation, or irreversible data change is authorized until `06-migration-and-rollout.md` gates and `07-test-and-acceptance-plan.md` evidence are satisfied.
