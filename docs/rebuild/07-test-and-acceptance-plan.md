# Test and acceptance plan

Status: proposed quality and release gate based on the read-only Phase 0 baseline on 2026-07-16. “Observed” means the command or repository fact was verified during the audit. “Proposed” means required work or a future gate and must not be represented as passing yet.

Path convention: `juno-rebuild/...` is the website/API worktree; `juno-app-rebuild/...` is the native-app worktree. Tests must emit immutable evidence tied to commit SHA, toolchain, schema/migration version, server build, feature-flag snapshot, and sanitized fixture version.

## Phase 0 toolchain and test baseline

### Observed host

- macOS 27.0 arm64, Node `24.18.0`, npm/npx `11.16.0`, Swift `6.4`.
- Both JavaScript roots require Node 20 or newer (`juno-rebuild/package.json:99-101`, `juno-app-rebuild/package.json:14-16`). Deployment uses Node 20 (`juno-rebuild/.github/workflows/deploy.yml:21-24`) while nightly model sync uses Node 22 (`juno-rebuild/.github/workflows/sync-models.yml:40-43`); no repository version pin was found.
- Active `xcode-select` points to Command Line Tools, so bare `xcodebuild` is blocked. `/Applications/Xcode-beta.app` provides Xcode 27.0 and is also the path assumed by packaging (`juno-app-rebuild/scripts/package-dmg.sh:13`).

### Observed commands and results

| Surface | Command | Result on 2026-07-16 | Caveat/evidence |
| --- | --- | --- | --- |
| Native Swift | `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project Juno.xcodeproj -scheme Juno -destination 'platform=macOS' -derivedDataPath /tmp/juno-derived test` | Pass, 29 tests | Current scheme has one test target (`juno-app-rebuild/Juno.xcodeproj/xcshareddata/xcschemes/Juno.xcscheme:25-43`) |
| Legacy desktop | `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project apps/desktop/JunoDesktop.xcodeproj -scheme JunoDesktop -destination 'platform=macOS' -derivedDataPath /tmp/juno-desktop-derived build` | Pass | Xcode warned that the target's supported-platform list was empty |
| Swift syntax | `xcrun swiftc -parse $(rg --files Juno -g '*.swift')` | Pass | Parse-only; it does not replace the Xcode build/test |
| TypeScript core | `npx --no-install tsc -p core/tsconfig.json --noEmit` | Pass | Compile gate only |
| TypeScript CLI | `npx --no-install tsc -p apps/cli/tsconfig.json --noEmit` | Pass | No CLI tests were found |
| TypeScript core tests | `npm test` | Pass, 16 tests | Root script tests only `core` (`juno-app-rebuild/package.json:9-12`); core tests execute compiled `dist` (`juno-app-rebuild/core/package.json:10-13`) |
| Website install | `npm ls --depth=0` | Blocked: dependencies unmet | The worktree has no `node_modules`; run clean `npm ci` before claiming web results |

The successful Swift run retained warnings in `Juno/Features/CodeNext/EngineComposerView.swift:16`, `Juno/Features/Chat/EmptyStateView.swift:50`, and `Juno/Features/Shell/UserMenuFooter.swift:37,39`. They are baseline warnings, not approvals to add more.

### Observed zero-test and unsafe-test caveats

- The website has no aggregate `test` script. Available commands are individual scripts (`juno-rebuild/package.json:19-29`).
- `scripts/test-memory.ts` writes conversations/messages to its configured database and relies on best-effort cleanup (`juno-rebuild/scripts/test-memory.ts:17,54-65,78-191`); it is not safe against a shared or production database.
- Clarification, moderation, relay smoke, and provider/model sync commands may use network services, credentials, or paid inference. They require explicit live-test configuration and budgets.
- The relay has build/typecheck/smoke scripts but no unit/integration test script (`juno-rebuild/relay/package.json:7-12`).
- Native root `npm test` does not test the CLI, sidecar transport, Swift app, updater, or packaging.
- The app repository has no CI workflow. Website deploy CI runs build but no lint, type-check, unit, integration, migration, or security tests (`juno-rebuild/.github/workflows/deploy.yml:15-40`).
- Website builds ignore TypeScript and ESLint errors (`juno-rebuild/next.config.mjs:4-9`), so a green `next build` is not a correctness gate.
- No current suite proves auth state/PKCE, device revocation, two-client convergence, cursor/tombstone behavior, migration recovery, Code containment, updater authenticity, accessibility, or cross-surface parity.

### Proposed reproducible baseline commands

Use a pinned Node version in both repositories and a checked Xcode/Swift requirement. Run in clean worktrees with dummy or dedicated test secrets; never inherit production `.env` values.

```sh
# Website/API: safe local/static gates
npm ci
npx tsc --noEmit
npm run lint
npm run test:auth
AUTH_SECRET='test-only-at-least-32-bytes-long' \
DATA_ENCRYPTION_KEY='0000000000000000000000000000000000000000000000000000000000000000' \
  npx tsx scripts/test-message-crypto.ts
npm run validate:models
npm run build
npm ci --prefix relay
npm run typecheck --prefix relay
npm run build --prefix relay

# Native TypeScript packages
npm ci
npm run build
npm test
npx tsc -p apps/cli/tsconfig.json --noEmit

# Native Swift
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcodebuild -project Juno.xcodeproj -scheme Juno \
  -destination 'platform=macOS' -derivedDataPath /tmp/juno-derived test
```

Live commands—database mutation tests, provider tests, relay smoke, upload tests, and live-dev contract tests—run only with an allowlisted development base URL, disposable account/database namespace, test storage bucket, capped provider budget, and a guard that rejects production host/database identifiers.

## Test pyramid and ownership

### Proposed

| Layer | Scope | Frequency | Primary owner | Required evidence |
| --- | --- | --- | --- | --- |
| Static and generation | Swift/TypeScript compile, lint, formatting, generated DTO/token/catalog drift, migration validation, secret scan | Every PR | Owning team | Logs plus zero diff after regeneration |
| Unit | DTO decoding, reducers/state machines, auth token family, outbox ordering, conflict rules, path policy, parsers, redaction | Every PR | Owning team | JUnit/xcresult with branch coverage on security state machines |
| Component | SwiftUI components, API handlers with mocked dependencies, DB repositories, upload chunks, Code approval UI | Every PR | Native or Web/API | Deterministic component report and snapshots |
| Contract | OpenAPI/JSON schema fixtures, generated Swift client, SSE events, upload protocol, error envelopes | Every PR | Web/API + Auth/sync | Fixture version and provider/consumer compatibility report |
| Integration | Real test database/object storage, auth exchange, migrations, sync engine, sidecar IPC, update verifier | Every PR where affected; nightly full | Security/QA integrator | Isolated environment manifest, JUnit/xcresult, database integrity report |
| Cross-surface end-to-end | Website plus two native clients through all ten scenarios | Nightly and release candidate | Security/QA integrator | Browser trace, xcresult/UI recording, redacted server/change log, final state digest |
| Adversarial/security | Auth replay, tenant isolation, Code escape, malicious package/manifest, secret/PII leakage | Every security change; release | Security lead | Threat-case matrix with denial evidence and no secret-bearing logs |
| Accessibility/visual/performance | Keyboard, VoiceOver, contrast/motion, screenshots, launch/scroll/stream/diff/load metrics | Nightly and release | Native/UI + QA | Accessibility report, approved visual diffs, signposts/traces and budget report |
| Recovery/operations | Rollback, backup restore, cursor repair, outbox replay, session revoke, bad update withdrawal | Release candidate | Release + service owners | Timestamped drill record and recovered-state checksum |

No end-to-end test substitutes for unit/contract coverage, and mocked tests do not count as live development-server acceptance.

## Contract fixtures and live development server

### Proposed fixture tests

- Check in sanitized, versioned request/response/error/SSE fixtures for every native API route. Include minimum, full, unknown-enum, additive-field, null, expired-auth, pagination, tombstone, conflict, rate-limit, and malformed cases.
- Generate or validate the Swift DTO/client from the same schema. Decode every fixture in Swift and validate every server serializer response against the schema.
- Run backward compatibility against the oldest supported native schema and forward-tolerance tests against additive unknown fields. Required fields cannot change without an API version.
- Store fixture provenance and synthetic IDs; no production payloads, emails, prompts, messages, file names, or tokens enter the repository.

### Proposed live-dev tests

- Start a clean application server, database created exclusively from checked migrations, isolated object store, realtime transport, and two fresh accounts.
- Run the same contract assertions against the live development server, including authentication, ownership, pagination, streaming cancellation, uploads, and rate limits.
- Assert the base URL and database identity are development-only before mutation. Tests abort on redirect to, DNS match with, or credential match from production.
- Compare fixture and live response shapes. A difference requires either regenerated reviewed fixtures or a server fix; ad hoc Swift decoder changes are not accepted.

Pass evidence is a schema/fixture version, server SHA, migration list, Swift client SHA, request IDs, response-shape digest, and redacted JUnit report.

## Authentication, session, and authorization matrix

### Proposed

| Test | Expected result |
| --- | --- |
| State mismatch, missing state, wrong redirect URI, expired pending request | Callback/exchange denied; no device session created |
| Wrong/missing PKCE verifier | Exchange denied without revealing whether a code exists |
| Authorization-code replay and concurrent double exchange | Exactly one succeeds atomically; all later attempts fail |
| Code captured by another installation | Denied by verifier/device binding |
| Access-token expiry during request/stream/upload | One serialized refresh; safe retry only for idempotent operations |
| Refresh rotation | Old refresh credential becomes invalid after use; new family metadata persists atomically |
| Refresh-token reuse | Entire token family revoked; realtime closes; user sees reauthentication state |
| Revoke one device from web | That device's API, refresh, stream, and upload access cease promptly; other device remains signed in |
| Revoke all devices/password or security change | All device families and pending codes revoked according to policy |
| Account switch | Caches, outbox, files, Keychain items, and telemetry pseudonyms remain account-isolated |
| Cross-tenant IDs for every route | `404`/authorized denial with identical timing/envelope; no existence or metadata leak |
| CSRF/origin/cookie confusion | Native bearer and browser-cookie paths cannot be substituted; Origin-less browser mutations are denied unless explicitly non-cookie authenticated |
| Log capture on every failure | No cookie, code, verifier, access/refresh token, password, email, or provider key appears |

Fixtures use deterministic fake credentials. Live-dev revocation tests use disposable device sessions. Raw web-cookie handoff (`juno-rebuild/src/app/app-auth/page.tsx:21-27`) is a known failing legacy path until removed.

## Sync and convergence matrix

### Proposed harness

Run website client W and independent native clients A/B against one synthetic account. A deterministic proxy can drop, duplicate, delay, reorder, split, and reconnect HTTP/SSE/WebSocket traffic. Each operation carries an idempotency key; the harness records server revisions, client cursors, outbox states, and a content-free state digest.

For create, rename, pin, archive, move, message edit, branch, feedback, delete/restore, project instruction/file mutation, attachment, artifact, settings, memory, and connector state, cover:

| Fault/interleaving | Required invariant |
| --- | --- |
| Same mutation delivered 1, 2, or 10 times | One server effect and one canonical record |
| Response dropped after commit | Retry returns the original result; no duplicate |
| Realtime event arrives before mutation response | State converges without duplicate optimistic record |
| Events reordered or duplicated | Revision/cursor rules produce deterministic final state |
| Cursor page interrupted between items | Resume without gap or replay side effect |
| Cursor expired/compacted | Verified snapshot repair followed by incremental cursor |
| Delete offline, update elsewhere | Defined conflict result; tombstone prevents accidental resurrection |
| Concurrent rename/move/edit | Product conflict policy applied and explained; no timestamp-only guess |
| A and B create while offline then reconnect | Unique canonical IDs and relationship preservation |
| Token expires while draining outbox | Queue pauses/refreshes and resumes exactly once |
| App killed before/after local commit, send, server commit, or acknowledgement | Restart recovers the same durable state at every crash point |
| Stream disconnect or duplicate terminal event | No duplicate user/assistant message and terminal state reconciles |

Pass requires W/A/B state digests to match server canonical state, outboxes to be empty or explicitly conflicted, cursors to be strictly ordered with no server-page omissions (numeric gaps are allowed), expired cursors to force verified snapshot repair, no unexplained duplicates, and tombstones retained through the specified compaction floor/window. The current upsert-only behavior and delete resurrection documented in `juno-app-rebuild/Juno/Services/Backend/SyncService.swift:5-10,237-244` remain known failures.

## Migration tests

### Proposed database tests

1. Create a database from all migrations, validate Prisma schema parity, and run API tests.
2. Restore a sanitized production-shaped snapshot; apply expand migrations; verify the old release still works.
3. Interrupt/restart each backfill batch, duplicate jobs, and reorder workers; verify idempotent checkpoints.
4. Verify counts, ownership, checksums, null rates, foreign keys, tombstones, revisions, and encryption key versions.
5. Cut reads to new data, roll application reads back, then forward again.
6. Apply contract migration only to a copy after rollback-window criteria; prove the supported release set still works.
7. Rehearse isolated restore and targeted repair. Production is never the test target.

CI and deploy use `prisma migrate deploy`; the current production `db push` step (`juno-rebuild/.github/workflows/deploy.yml:99-102`) is a known release-gate failure.

### Proposed SwiftData tests

- Open every supported historical fixture store, migrate through each schema version, and verify record/relationship/content-hash digests.
- Exercise already-canonical, local-only, duplicate, tombstoned, corrupt, mixed-account, missing-attachment, retired-model, and partially migrated records.
- Crash at every migration checkpoint, outbox claim, relationship rewrite, server acknowledgement, and backup swap; restart must resume or restore without an empty store.
- Run migration twice and concurrently attempt launch; the result is identical and only one migrator writes.
- Verify account logout/switch never deletes another account's store or outbox.
- Force store-open failure and assert a recovery UI plus immutable backup; the current in-memory fallback (`juno-app-rebuild/Juno/Models/PersistenceModels.swift:493-503`) must not count as pass.

## Streaming and uploads

### Proposed streaming matrix

- SSE frames split at every byte boundary, multiple frames per read, CRLF/LF, UTF-8 multibyte splits, comments/heartbeats, unknown additive events, malformed JSON, oversized frames, duplicate sequence IDs, reordered terminal events, and server errors.
- Cancellation before request, during connect, mid-token, during tool event, and after terminal frame. Assert socket/task/process cleanup and one terminal UI state.
- App suspend, network change, token expiry, server restart, reconnect with last event ID, and kill/relaunch reconciliation.
- Backpressure tests for long reasoning/output and slow UI consumers; memory remains bounded and scroll interaction remains responsive.

### Proposed upload matrix

- Empty, boundary-size, over-limit, MIME/extension mismatch, polyglot, corrupt, malicious metadata, Unicode/confusable name, traversal name, duplicate content, and unsupported file.
- Multipart/chunk interruption at every boundary, retry after committed response loss, resume with wrong account/file/hash, concurrent duplicate upload, cancel, expiration, and garbage collection.
- Hash-based deduplication is account/authorization aware. Download and range requests enforce ownership; UUID knowledge alone is insufficient. The unauthenticated local-file route (`juno-rebuild/src/app/api/files/[...key]/route.ts:7-18`) is a known failing legacy path.
- Project reference files, chat attachments, avatar/media derivatives, and artifact files synchronize to both native clients and web with the same canonical metadata.

Pass evidence includes request IDs, byte/hash counts, object-store inventory, ownership assertions, resume offsets, cancellation resource checks, and client state digests—never file contents.

## Code safety adversarial matrix

### Observed risk baseline

The legacy filesystem accepts absolute paths (`juno-app-rebuild/core/src/tools/fs.ts:11-13`), its shell inherits the full environment (`juno-app-rebuild/core/src/tools/bash.ts:24-31`), and sidecar authentication is optional (`juno-app-rebuild/core/src/server.ts:48-74`). These paths cannot be production-enabled merely because happy-path tests pass.

### Proposed required cases

| Boundary | Adversarial cases | Pass condition/evidence |
| --- | --- | --- |
| Workspace paths | `..`, absolute path, `~`, Unicode separators, case aliases, alternate volumes, hard links, symlink inside→outside, parent swap after approval, delete/recreate race | Canonical handle remains inside granted root; denied event names policy reason; outside sentinel unchanged |
| Reads/search | `.env`, Keychain/SSH/browser paths, `/etc`, hidden files, ignored files, huge/binary/sparse/device files | Denied or separately approved by exact capability; no bytes enter model/session/log |
| Writes/patches | Outside path, symlink swap, binary, large file, chmod/xattr, atomic replace, patch traversal, checkpoint restore to changed target | Scoped atomic write; precondition/hash check; reversible checkpoint; no outside mutation |
| Commands | Chaining (`;`, `&&`, pipes), command substitution, aliases/functions, interpreters, `env`, `xargs`, `find -exec`, scripts/package hooks, `cd /`, encoded commands | Parser/classifier cannot turn untrusted compound work into an auto-approved command; runtime containment still enforces scope |
| Network/install | `curl`, DNS, sockets, package managers, Git hooks, remote scripts, dependency lifecycle hooks | Explicit destination/capability approval and policy; denied by sandbox when absent |
| Destructive operations | `rm`, overwrite, disk/process/account commands, fork bomb, resource exhaustion | Explicit high-risk approval or denial; quotas hold; workspace/user data unchanged |
| Environment/secrets | Provider keys, cookies, tokens, inherited environment, command args, stdout/stderr variants, encoded/fragmented secret | Minimal allowlist; canary never reaches child/model/UI/persistence/telemetry; redaction test passes |
| Approval lifecycle | Deny, timeout, edit command, stale approval, replay in another session/workspace/account, changed file after approval | Approval binds operation digest, scope, account, session, and expiry; denial resumes safely |
| Cancellation | Timeout, stop, emergency stop, app kill, child/grandchild daemon, detached process | Entire process group/tree exits within budget; ports/files/locks cleaned; terminal state persisted |
| Git/worktrees | Dirty user tree, concurrent branches, nested repo, submodule, symlink, conflicting subagents | No writes outside assigned worktree; user changes preserved; approvals/output never cross sessions |
| IPC/sidecar | Missing/wrong token, hostile Origin, oversized/malformed frames, invalid mode, replay, arbitrary backend URL/cookie | Connection/action denied before parsing secrets or starting a tool; bounded resources |
| Computer Use | Missing Accessibility/Screen Recording grant, wrong window, secure field, approval revoked mid-action, screenshot retention | OS permission plus per-session user grant; protected content excluded; stop is immediate and durable |

Tests run inside an isolated disposable account/container/VM with outside-workspace sentinel files and canary secrets. A single scope escape, surviving child process, approval bypass, or canary leak fails the release.

## Updater and release-package tests

### Proposed

- Build twice from the same source and compare declared reproducibility inputs; record Developer ID identity, hardened-runtime entitlements, notarization ticket, staple verification, and package hash.
- Verify the pinned release key over the canonical manifest, then verify version/channel/minimum version, URL policy, length, and SHA-256 before mounting or executing.
- Reject changed manifest byte, changed DMG byte, wrong key, same Authority name/different certificate, expired/replayed manifest, HTTP/redirect downgrade, wrong bundle/team ID, unstapled/notarization failure, truncated file, and version downgrade.
- Test interrupted/resumed download, insufficient disk, mount/copy failure, running app, rollback to previous known-good app, bad release withdrawal, and recovery from a crash at each install stage.
- Assert quarantine is not stripped before all authenticity checks and that no editable production URL bypasses the pinned channel.

Current self/ad-hoc packaging (`juno-app-rebuild/scripts/package-dmg.sh:8-10,20-25,42-52`) is a known release blocker. Evidence is the notarization log, signature/designated-requirement report, signed manifest, package hash, malicious-fixture rejection report, and clean install/rollback result.

## UI, accessibility, visual, and performance acceptance

### Proposed UI/accessibility matrix

- Core flows have deterministic UI tests on macOS and supported iOS/iPadOS targets, including keyboard-only navigation, command/menu equivalents, focus restoration, drag/drop alternatives, undo, errors, offline/reconnect, and account revocation.
- VoiceOver labels, values, actions, grouping, headings, rotor order, announcements, and focus order are verified manually and with automation where available.
- Verify Reduce Motion, Reduce Transparency, Increase Contrast, Differentiate Without Color, Dynamic Type/content size, full keyboard access, focus rings, 200% zoom, and light/dark/accent states.
- Controls meet platform hit-target and contrast requirements; destructive and approval actions remain explicit. Sensitive content is not exposed in accessibility labels or notification previews without user choice.

### Proposed visual evidence

Maintain reviewed snapshots for representative chat, sidebar, composer/model picker, projects/files, settings/account, offline/conflict, streaming/tool activity, Code workbench/diff/terminal/approval, updater, and migration/recovery screens across light/dark, accent variants, increased contrast, reduced transparency, and largest supported content size. Diffs require named design-owner approval; pixel threshold alone cannot approve clipping or incorrect hierarchy.

### Proposed performance gate

Phase 0 first records release-build baselines on a named reference Mac/iPhone for cold/warm launch, 10,000-message history, long stream, 10,000-file tree, large diff, sustained terminal output, rapid sync updates, memory, CPU, energy, disk, and network. Until product-specific absolute budgets are ratified, every release must be no worse than 10% from that frozen baseline and must meet these provisional floors:

- cold launch to interactive p95 at or below 2 seconds on the reference Mac;
- scrolling/streaming interaction p95 at or above 55 rendered frames per second with no main-thread stall over 100 ms;
- cancellation acknowledgement within 250 ms and complete process-tree termination within 2 seconds;
- bounded memory under long stream/terminal/file-tree tests with no monotonic leak after quiescence;
- sync catch-up and web→Mac visibility p95 at or below 2 seconds on the controlled development network.

A budget change requires a recorded baseline, trace, rationale, and performance-owner approval.

## Ten cross-surface acceptance scenarios

### Proposed release gate

Every scenario runs against the live development stack with browser W and independent native clients A/B. The Security/QA integrator owns orchestration and final sign-off; the named primary owner fixes failures and attests evidence. IDs/content are synthetic and reports are redacted.

| # | Scenario and required assertions | Primary owner | Required pass evidence |
| --- | --- | --- | --- |
| 1 | Create on web; Mac receives the same title, model, project/folder, messages, sources, activity, attachments, artifacts, and metadata within the latency budget | Web/API + Auth/sync | Browser trace, cursor/event log, A/B/server state digest, attachment hashes, UI capture |
| 2 | Create on Mac; web receives one canonical conversation with no local/server duplicate and either surface continues it | Auth/sync | Outbox/idempotency trace, canonical-ID mapping, W/A/B state digest, continuation transcript hash |
| 3 | Rename, pin, archive, move, edit, branch, feedback, delete from W/A/B under reordered/drop traffic; all converge and deletion never resurrects | Auth/sync | Deterministic fault seed, revision/tombstone log, matching final digest, zero duplicate report |
| 4 | Create/edit/delete project, instructions, and files on either surface; chat context uses the same canonical project everywhere | Web/API | API/upload trace, content hashes, ownership assertions, W/A/B project/context digest |
| 5 | Model availability/selection/effort, settings, profile/avatar, memory, connectors, plan, and usage match the account | Web/API + Native/UI | Catalog/version IDs, entitlement fixture, W/A/B screenshots and normalized account-state digest |
| 6 | Work offline on Mac; reconnect; every queued change applies once, conflicts are explained, and no data is lost | Auth/sync | Durable outbox before/after, fault trace, conflict UI capture, server/client digests, restart replay proof |
| 7 | Interrupt stream and separately kill app at each turn checkpoint; restart reconciles with no duplicate user/assistant messages | Auth/sync + Native | Stream sequence log, crash-point matrix, restored UI capture, duplicate detector, task/resource cleanup |
| 8 | Start Code task in isolated worktree, review/partially accept diff, run tests, use Git, stop command, restart/resume without state loss | Code lead | Worktree/branch status, approval/event log, diff hashes, test output digest, process-tree proof, resumed-state capture |
| 9 | Run parallel Code sessions/subagents; branches/workspaces, approvals, output, secrets, and checkpoints never cross | Code lead + Security | Concurrent deterministic run, outside/cross-session sentinels, separate event logs, Git graph, canary-secret report |
| 10 | Revoke Mac device from account; API/refresh/realtime/upload access ceases promptly while other device remains valid | Auth/sync + Security | Revocation audit ID/time, failed old-token requests, closed stream, successful unaffected-device request, UI reauth capture |

“Looks correct” is not pass evidence. Each run attaches machine-readable state comparison plus the human-facing behavior evidence appropriate to the scenario.

## CI and release gates

### Proposed pull-request gates

1. Pinned Node/Xcode toolchain check and clean dependency install.
2. TypeScript/Swift compile with warnings treated according to the ratcheted baseline; lint and formatting.
3. Unit/component tests for affected packages and native targets.
4. Generated DTO, fixture, model-catalog, and design-token drift check.
5. Prisma validation, clean migration build, sanitized-snapshot upgrade, and schema-drift check.
6. Contract tests for all API versions and the generated Swift client.
7. Auth/sync integration suites when shared contracts change.
8. Secret/dependency/license/static-security scans and telemetry allowlist/redaction tests.
9. Code adversarial subset when execution/IPC/filesystem/process code changes.
10. Required code-owner review for auth, migration, sync, Code safety, update, signing, telemetry, and generated-source changes.

### Proposed nightly gates

- Full live-dev contract suite, two-client convergence fault matrix, all ten cross-surface scenarios, relay/stream/upload matrix, Code adversarial suite in isolation, Swift UI/accessibility smoke, visual diffs, and performance regressions.
- Nightly provider/model discovery remains advisory until generated changes pass validation/review; provider fetch failures cannot be hidden with `|| true` on a release path (`juno-rebuild/.github/workflows/sync-models.yml:64-77`).

### Proposed release-candidate gates

- All PR/nightly gates green on the exact release SHA.
- Zero unresolved critical/high security findings and zero unexplained data divergence.
- Database and SwiftData migrate/rollback/recovery drills completed.
- Device revocation, telemetry privacy, accessibility, visual, and performance reports approved.
- Developer ID signature, hardened runtime, notarization/stapling, signed manifest, updater malicious-fixture rejection, and clean install/rollback pass.
- Cohort flags, owners, dashboards, support plan, rollback triggers, and runbooks in `docs/rebuild/06-migration-and-rollout.md` are current.
- Deployment runs checked `prisma migrate deploy`, never production `db push`.
- Production contains no raw custom-scheme session token, signed-in silent local-only fallback, unprotected upload fetch, insecure sidecar, or self-signed updater.

### Evidence retention and sign-off

CI stores JUnit/xcresult, schema/fixture compatibility reports, sanitized state digests, migration integrity reports, accessibility/visual/performance artifacts, security matrices, SBOM/signature/notarization evidence, and recovery drill records for the approved retention window. Secret-bearing raw network/terminal/model content is not retained.

The final acceptance ledger records each gate as `pass`, `fail`, or `not run`; `not run` is never green. It names the owner, commit, environment, command, evidence link, date, and approved exception with expiry. The current website dependency blocker, missing web aggregate suite, missing app CI, untested surfaces, Swift warnings, production `db push`, raw-token handoff, upsert-only sync, insecure Code boundaries, and self-signed updater remain explicit failures until replaced and evidenced.
