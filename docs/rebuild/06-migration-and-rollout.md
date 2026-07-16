# Migration and rollout plan

Status: proposed production plan based on the read-only Phase 0 audit on 2026-07-16. Nothing in this document records a production migration as completed.

Path convention: `juno-rebuild/...` refers to the website/API worktree and `juno-app-rebuild/...` refers to the native-app worktree. Line references are observed evidence at the Phase 0 revisions and must be refreshed when the cited code changes.

## Evidence and non-negotiable constraints

### Observed

- The current native handoff copies the Auth.js session cookie into a `juno://auth?token=...` URL (`juno-rebuild/src/app/app-auth/page.tsx:6-27`, `juno-rebuild/src/app/app-auth/handoff.tsx:5-19`). The app extracts that raw token and persists it as its session (`juno-app-rebuild/Juno/Services/Backend/WebAuthService.swift:9-14,33-68`, `juno-app-rebuild/Juno/Services/Backend/AuthSession.swift:188-214`).
- Native synchronization is explicitly upsert-only (`juno-app-rebuild/Juno/Services/Backend/SyncService.swift:5-10`). Failed creates can become permanent local UUID records, writes are fire-and-forget, deletes can resurrect, and project files remain device-local (`juno-app-rebuild/Juno/Services/Backend/SyncService.swift:201-267`).
- SwiftData currently uses an unversioned `Schema` and falls back to an in-memory store if opening the persistent store fails (`juno-app-rebuild/Juno/Models/PersistenceModels.swift:483-503`). That fallback can make a migration failure look like an empty but working app.
- The app still maintains a hand-curated static model registry. The runtime account list falls back to that registry on sign-out, direct-provider use, mock mode, and refresh failure (`juno-app-rebuild/Juno/Services/Backend/ModelStore.swift:3-8,15-43`; `juno-app-rebuild/Juno/Models/ModelCatalog.swift:116-140`). Native theme values are separately hard-coded (`juno-app-rebuild/Juno/DesignSystem/Theme.swift:50-84`).
- Production deployment currently reconciles the schema with `npx prisma db push --skip-generate` (`juno-rebuild/.github/workflows/deploy.yml:80-102`), even though a checked-migration command exists (`juno-rebuild/package.json:14-18`).
- The legacy TypeScript sidecar accepts an optional bearer token and otherwise serves any loopback client (`juno-app-rebuild/core/src/server.ts:48-74`). Its filesystem and shell tools are not a production security boundary (`juno-app-rebuild/core/src/tools/fs.ts:11-13,32-50,68-115`; `juno-app-rebuild/core/src/tools/bash.ts:24-38`).
- Release packaging states that it is not notarized, builds with signing disabled, and then uses a local self-signed identity when available (`juno-app-rebuild/scripts/package-dmg.sh:8-10,20-25,42-52`).

### Proposed invariants

1. The canonical signed-in account state lives on the server. Local state is a durable, explainable cache plus outbox, never a silent alternate truth.
2. Every rollout step is backward compatible until its measured rollback window has closed.
3. Database work follows expand, backfill, verify, cut over, observe, then contract. No destructive contract migration ships in the same release as its replacement.
4. Production data is never used to test a destructive migration. Rehearsals use sanitized snapshots or production-shaped generated data.
5. A rollback must not require reinstalling the app, deleting a SwiftData store, discarding an outbox, or restoring the whole production database for a routine application defect.
6. Authentication tokens, cookies, provider keys, source files, prompts, responses, screenshots, terminal output, and attachment contents are excluded from production telemetry by default.
7. Security gates for native auth, Code execution, the sidecar, signing, and update verification are release blockers, not cohort experiments.

## Feature-flag control plane

### Proposed

Flags are evaluated server-side by account and device, with a signed, short-lived client snapshot for offline UI decisions. Every flag has an owner, creation date, expiry date, default, cohort rule, and kill-switch runbook. Security enforcement remains server-side even when UI is hidden by a flag.

| Flag | Default before rollout | Purpose | Rollback behavior | Removal condition |
| --- | --- | --- | --- | --- |
| `native_api_v1_reads` | off | Read versioned DTOs and cursor pages | Return to legacy reads without changing writes | All supported app versions use v1 |
| `native_auth_code_exchange` | off | State/PKCE browser flow and one-time code exchange | Disable new exchanges; preserve valid device sessions | Raw-token handoff endpoint removed |
| `native_device_sessions` | off | Rotating device refresh tokens and revocation | Force safe reauthentication, never restore raw-cookie handoff | All active native sessions migrated |
| `sync_v2_outbox_writes` | off | Idempotent mutation outbox | Stop draining, retain queued operations, keep reads available | Convergence gate green at 100% |
| `sync_v2_cursor_reads` | off | Cursor/change-feed reconciliation | Full v1 refresh while retaining last cursor | Cursor repair exercised in production |
| `sync_v2_realtime` | off | Realtime invalidation/change feed | Poll cursor endpoint | Realtime stable through rollback window |
| `canonical_model_catalog` | off | Server-owned capabilities and availability | Use last-known-good signed cache | Static production registry removed |
| `generated_native_tokens` | off | Generated Swift design-token artifact | Use previous generated artifact | Drift check enforced in CI |
| `secure_code_engine` | off | New scoped Code runtime | Disable Code entry points; preserve sessions read-only | Adversarial matrix and release review pass |
| `secure_updates` | off in non-release builds | Signed manifest and notarized package | Stop publishing manifest; keep installed version | Self-signed updater deleted |

Flags must not select different database meanings. Schema compatibility is determined by deployed code and migration state, not a client flag.

## Database migration protocol

### Observed

The deployment workflow builds on `main` and runs `prisma db push` on the VM without a migration-validation, backup-verification, or application-test gate (`juno-rebuild/.github/workflows/deploy.yml:6-17,31-40,80-102`).

### Proposed order

| Stage | Allowed changes | Required proof | Rollback |
| --- | --- | --- | --- |
| Expand | Add nullable columns, new tables, indexes using safe/concurrent techniques, and non-enforcing constraints | Migration applies to empty DB and sanitized snapshot; old release still passes smoke tests | Roll back application; retain additive schema |
| Dual-read/dual-write | Write old and new representations with idempotency keys; read old as fallback | Shadow comparison has zero unexplained divergence | Disable new write flag; retain new data |
| Backfill | Bounded, resumable batches with checkpoint, rate limit, retry, and per-row error quarantine | Counts, checksums, ownership, null-rate, and referential-integrity report | Stop job; do not delete either representation |
| Verify | Read-only reconciliation and sampled content-level checks | Signed migration report and restore rehearsal | Repair/redo affected batches |
| Cutover | Read new representation while continuing compatibility writes | Error, latency, and divergence thresholds remain green through cohort soak | Flag reads back to old representation |
| Contract | Remove old reads/writes, then later obsolete columns/tables | 100% supported clients cut over; rollback window expired; verified backup retained | Forward fix or targeted restore; never depend on old clients |

Deployment changes from `npx prisma db push --skip-generate` to `npx prisma migrate deploy`. CI must run `prisma validate`, create a clean database from migrations, upgrade a production-shaped snapshot, run contract/integration tests against it, and fail on schema drift. The deploy job records migration IDs and pre/post checksums, verifies a restorable backup before applying, and holds application rollout if the migration job fails. `db push` remains limited to disposable local development databases.

No `DROP`, destructive type conversion, column rename without compatibility aliases, mass delete, or non-null constraint over unverified rows is allowed before the contract stage. A contract migration requires explicit database-owner and security/QA approval.

## Legacy auth and Keychain migration

### Observed

The website exposes the raw session cookie to client code and a custom-scheme URL (`juno-rebuild/src/app/app-auth/page.tsx:21-27`, `juno-rebuild/src/app/app-auth/handoff.tsx:11-19`). The native app installs and stores it (`juno-app-rebuild/Juno/Services/Backend/AuthSession.swift:188-214`).

### Proposed target

- `ASWebAuthenticationSession` starts with a random state and PKCE challenge bound to a pending server record, device installation identifier, redirect URI, and short expiry.
- The callback carries only a single-use authorization code and state. The app verifies state and exchanges the code plus verifier over TLS.
- The server atomically consumes the code and issues an app-scoped access token plus rotating, device-bound refresh credential. Neither credential is an Auth.js browser cookie.
- Refresh-token reuse revokes the token family and prompts the user to reauthenticate. Account settings list devices, last use, approximate platform, and revoke controls.

### Migration and sunset

1. A new app version recognizes the legacy Keychain item but does not send it through a new callback or silently convert it.
2. It backs up no token value and emits only a boolean `legacy_credential_present` diagnostic.
3. The user completes the new browser authorization. Only after the device session is validated and an initial server sync succeeds does the app delete the legacy Keychain value.
4. Cancellation or network failure leaves the old item untouched and the app in a clearly labelled migration-required state; it must not create signed-in local-only data.
5. During a time-boxed compatibility window, the existing website browser cookie remains valid for the website, but new native builds cannot receive it. The old `/app-auth` handoff is blocked for app versions at or above the migration version.
6. After active-version telemetry and support review show the legacy population below the approved threshold, the server disables the raw-token callback for every version. Remaining users reauthenticate. The handoff components and token-adoption code are then deleted.
7. Revocation testing and a customer recovery path are mandatory before sunset. Rollback re-enables only the new authorization endpoint or extends reauthentication support; it never re-enables raw-token delivery to the custom scheme.

## SwiftData and canonical-ID migration

### Observed

The local schema has unique string IDs but no versioned schema/migration plan, and opening failure silently creates an in-memory container (`juno-app-rebuild/Juno/Models/PersistenceModels.swift:483-503`). Signed-in local UUIDs and server IDs coexist by design (`juno-app-rebuild/Juno/Services/Backend/SyncService.swift:5-10,203-220`).

### Proposed sequence

1. Introduce `VersionedSchema` and staged `SchemaMigrationPlan` versions before changing any stored model.
2. Add, without removing old fields: `localRecordID`, nullable `canonicalID`, `accountID`, `syncState`, `serverRevision`, `lastMutationID`, `deletedAt`, and migration provenance where applicable.
3. Before migration, close writers, checkpoint the durable outbox, copy the store plus sidecars to an app-private backup, verify it opens read-only, and record a non-content checksum.
4. Inventory every local record into one of: already canonical, linkable by verified server mapping, local unsynced, duplicate candidate, tombstoned, or corrupt/quarantined. A UUID shape is never used as proof of locality.
5. Resolve canonical IDs through idempotent server claim/import endpoints. The server returns the same canonical ID when the same migration key is retried.
6. Preserve the local stable identity used by SwiftData relationships while recording the canonical server identity separately. Rewire relationships transactionally and enforce uniqueness on `(accountID, canonicalID)` only after reconciliation.
7. Upload local-only records through the outbox, including project files and attachments. Do not mark them synced until content hashes and server revisions are acknowledged.
8. Quarantine ambiguous duplicates for explicit merge/recovery; never pick a winner from timestamps alone. Produce counts and redacted reason codes, not content.
9. On failure, reopen the verified backup read-only and offer retry/export/support recovery. Never substitute an empty in-memory store as successful startup.
10. After two releases and the full rollback window, remove temporary legacy-ID fields only in a later schema version.

Acceptance requires stable record counts after accounting for intentional tombstones, zero broken relationships, zero unexplained duplicate canonical IDs, successful crash-at-each-step recovery, and two-client convergence after the migrated outbox drains.

## Model and design catalogs

### Observed

`ModelStore` uses server results when available but preserves a separately curated native catalog and its metadata (`juno-app-rebuild/Juno/Services/Backend/ModelStore.swift:3-8,41-64`; `juno-app-rebuild/Juno/Models/ModelCatalog.swift:116-140`). Native theme values are also maintained directly in Swift (`juno-app-rebuild/Juno/DesignSystem/Theme.swift:50-84`).

### Proposed migration

- The website repository owns one versioned model/capability catalog. The native API returns account-filtered availability, capability flags, effort controls, retirement aliases, and an ETag/version. Swift decodes generated/validated DTOs and stores a last-known-good cache; it does not invent capabilities for unknown models.
- Offline mode uses the last validated account catalog with an age indicator. A minimal built-in recovery catalog may permit opening old content but cannot claim live availability or silently route requests.
- A compatibility report compares every stored model ID with aliases before any retirement. Unknown/retired selections remain visible and require an explicit supported replacement.
- One structured design-token source generates website CSS/Tailwind inputs and a checked Swift artifact. CI regenerates both and fails on drift. Platform-specific semantic mappings remain native and documented; duplicated numeric color/spacing/type constants do not.
- Catalog cutover happens under `canonical_model_catalog` and `generated_native_tokens`, with the previous signed/generated version retained for rollback. Runtime fetch failure never mutates the checked source.

## Code sidecar and updater release gates

### Observed

- The legacy sidecar's token is optional (`juno-app-rebuild/core/src/server.ts:48-74`), filesystem tools accept absolute paths (`juno-app-rebuild/core/src/tools/fs.ts:11-13`), and shell execution inherits the process environment without an OS sandbox (`juno-app-rebuild/core/src/tools/bash.ts:24-38`).
- Current DMG packaging is explicitly unnotarized and self/ad-hoc signed (`juno-app-rebuild/scripts/package-dmg.sh:8-10,20-25,42-52`).

### Proposed hard gates

Code is unavailable in production until the adversarial matrix in `docs/rebuild/07-test-and-acceptance-plan.md` passes. The production runtime must have authenticated IPC, origin rejection, per-session capability grants, canonical/symlink-safe workspace handles, a minimal environment allowlist, network/install/destructive-command policy, process-group cancellation, approval binding and expiry, audit events, and an OS-enforced sandbox. The legacy sidecar is removed from release packaging or disabled at build time; a UI flag alone is insufficient.

Updates are unavailable until packages use Developer ID signing, hardened runtime, notarization, stapling, and a release manifest signed by a pinned offline release key. The manifest binds version, channel, minimum version, package SHA-256, size, URL, and publication time. The app rejects unsigned, mismatched, replayed, or downgraded manifests and never treats an Authority display string as identity. Release CI verifies the downloaded artifact independently before publishing it.

## Device, session, and data recovery

### Proposed

- Device-session recovery: users can revoke one device or all devices; the server stops access and refresh promptly, realtime connections close, and the app preserves unsent local work encrypted and read-only until reauthentication.
- Lost-device response: revoke refresh family, rotate affected secrets, invalidate pending auth codes, and retain an auditable non-content security event.
- Sync recovery: pause outbox draining, export a redacted operation manifest, fetch a fresh cursor snapshot, replay idempotently, and quarantine conflicts. Never clear the outbox to “fix” sync.
- Local-store recovery: preserve the original store, migrate a copy, verify relationships and counts, and offer a user-initiated encrypted export. Support tooling receives IDs/revisions/reason codes only unless the user explicitly supplies content.
- Server-data recovery: restore to an isolated database, reconcile by canonical ID/revision, and selectively repair production. A whole-database restore requires incident command because it can roll back unaffected accounts.
- Encryption-key recovery: every encrypted payload carries a key version. Rotation is staged through dual-decrypt/new-key-encrypt, coverage verification, then retirement. The current `AUTH_SECRET` fallback warning (`juno-rebuild/src/lib/message-crypto.ts:22-39`) must be eliminated before routine rotation.

## Privacy-preserving rollout telemetry

### Proposed

Allowed by default: app/build/API schema version, coarse platform version, feature-flag cohort, operation type, status/reason code, duration bucket, retry count, cursor lag, queue depth, migration stage/count, crash signature, and random rotating installation/device pseudonym.

Disallowed by default: access/refresh tokens, cookies, passwords, provider keys, URLs containing credentials, source paths or file contents, prompts, responses, message/attachment bodies, screenshots, terminal output, clipboard data, project names, emails, and raw model tool arguments/results.

Telemetry is schema-allowlisted at compile time, redaction-tested, encrypted in transit, access-controlled, retention-limited, and documented in product privacy settings. Debug-content upload is separate, explicit, scoped, previewed, revocable, and expires automatically. Kill switches and auth revocation do not depend on telemetry availability.

## Cohorts, soak periods, and rollback triggers

### Proposed cohort order

1. Local and ephemeral development with generated data.
2. CI plus live development server contract tests using dedicated test accounts.
3. Internal staff devices, then 1% opted-in dogfood.
4. 5% beta for at least 48 hours.
5. 25% for at least 72 hours.
6. 50% for at least 72 hours.
7. 100%, followed by at least one full supported-app-version rollback window before contract cleanup.

Advancement requires the previous cohort's acceptance evidence, on-call readiness, support briefing, and migration/recovery drill. Cohorts are sticky by account and device so behavior does not oscillate.

| Trigger | Automatic action | Incident owner |
| --- | --- | --- |
| Any confirmed cross-account data exposure, Code scope escape, forged update acceptance, credential leak, or destructive migration | Stop rollout, disable affected capability, preserve evidence, start security incident | Security/QA lead |
| Any confirmed unrecoverable loss, duplicate canonical record, delete resurrection, or outbox operation applied more than once | Stop sync writes; retain outboxes; revert read flag if safe | Auth/sync lead |
| Auth exchange/refresh failure above 1% for 15 minutes or more than twice the established baseline | Stop cohort expansion; disable new exchange only if existing device sessions remain safe | Auth/sync lead |
| Crash-free sessions regress by more than 1 percentage point or migration crash occurs | Halt cohort; disable triggering flag; preserve local backup | Native lead |
| API 5xx or p95 latency exceeds twice baseline for 15 minutes | Halt cohort; roll back application/flag before database restoration | Web/API lead |
| Backfill verification, counts, checksums, or constraints diverge | Stop backfill/cutover; retain both representations | Database owner |
| Update signature, digest, notarization, or downgrade validation fails once | Unpublish manifest and disable updates | Release owner |

Thresholds are proposed initial gates. Phase 0 measurements may make them stricter; relaxing one requires written approval and rationale.

## Rollback runbooks

### Proposed

1. **Application/flag rollback:** freeze cohort assignment, capture build/flag versions and redacted metrics, disable the smallest affected flag, verify old reads remain compatible, and run scenarios 1, 2, 6, 7, and 10 from the acceptance plan.
2. **Database rollback:** for additive migrations, roll application code back and leave schema/data in place. Stop backfills at their checkpoint. Use a forward repair migration for schema defects. Restore only after integrity analysis shows forward repair cannot recover data.
3. **Auth rollback:** stop new exchanges, revoke compromised code/token families, keep unaffected device sessions, and prompt scoped reauthentication. Never restore raw custom-scheme session-token handoff.
4. **Sync rollback:** stop outbox draining, retain queued mutations, fall back from realtime to cursor polling or read-only mode, snapshot cursors/revisions, repair server state, then replay idempotently.
5. **SwiftData rollback:** leave the original store immutable, reopen it read-only, restore the prior app build only when its schema is compatible, and offer retry/export. Do not delete the store or accept the in-memory fallback as recovery.
6. **Catalog rollback:** serve the previous signed model catalog or regenerate from the previous token source. Preserve stored IDs and capability truth; do not silently substitute a model.
7. **Code rollback:** cancel process groups, revoke workspace grants, disable new execution, keep event logs/checkpoints read-only, and verify no descendant process remains.
8. **Update rollback:** withdraw the manifest, revoke the release signing path if compromised, block the bad version server-side where safe, publish a higher-version fixed build, and never downgrade silently.

Every runbook records decision time, owner, build/migration/flag versions, affected cohorts, checks performed, recovery evidence, and the condition for resuming rollout. Production destructive changes remain prohibited throughout Phases 0-4 and require the explicit Phase 5 contract gate.

## Reversible implementation phases

### Phase 0 — Baseline and forensic audit

Observed: repository, toolchain, build/test, auth, sync, Code, release, and CI risks were inventoried without production writes. The current baseline and caveats are in `docs/rebuild/07-test-and-acceptance-plan.md`.

Proposed exit: evidence paths are current; baseline commands are reproducible in clean environments; security owners accept the threat model; backup/restore and telemetry schemas are designed. Rollback is unnecessary because no production behavior changes.

### Phase 1 — Contracts, auth, and sync foundation

Proposed: add versioned API DTOs, generated Swift client validation, one-time auth exchange, device sessions, revisions, idempotency, outbox, cursor/tombstones, realtime feed, additive database schema, and versioned SwiftData scaffolding. Website behavior remains backward compatible and all flags default off.

Exit: contract fixtures and live-dev tests pass; two-client convergence passes under drop/reorder/duplicate conditions; auth replay/revocation tests pass; expand/backfill rehearsal is reversible. Rollback disables new reads/writes while retaining additive data.

### Phase 2 — Native foundation and design system

Proposed: adopt actors/structured concurrency boundaries, account-scoped stores, generated design tokens, canonical model capabilities, native navigation/components, and accessible state restoration. No feature slice cuts over until its local-store migration is verified.

Exit: design/catalog drift tests, accessibility baseline, store migration crash recovery, and UI performance gates pass. Rollback selects the prior generated catalog/token artifact and compatible UI flag.

### Phase 3 — Account and website feature parity

Proposed: migrate vertical slices—account/settings, chat/history, projects/files, memory/connectors, usage/billing—each with server contract, offline behavior, sync, accessibility, tests, and recovery.

Exit: acceptance scenarios 1-7 and 10 pass across web plus two native clients; no signed-in local-only fallback remains. Rollback is per slice and preserves outboxes/canonical IDs.

### Phase 4 — Code workbench

Proposed: ship the event protocol, scoped worktrees, editor/diff/terminal/test/Git/preview surfaces, checkpoints, process-tree cancellation, approval resumption, subagent isolation, and hardened sandbox. Legacy sidecar is not packaged.

Exit: the full adversarial Code matrix and acceptance scenarios 8-9 pass, with an independent security review. Rollback disables execution while leaving sessions and diffs readable/exportable.

### Phase 5 — Migration, hardening, and release

Proposed: migrate legacy Keychain and SwiftData records, execute controlled database backfills/cutovers, roll through cohorts, complete privacy/accessibility/performance review, notarize/sign releases, and exercise every recovery runbook.

Exit: all ten acceptance scenarios and CI release gates pass; 100% cohort completes its rollback window; raw-token handoff, silent local-only fallbacks, static production catalogs, legacy sidecar, self-signed updater, `db push`, and temporary compatibility code are removed. Only then may separately reviewed contract migrations remove obsolete schema.
