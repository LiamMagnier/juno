# Rebuild implementation ledger

Last updated: 2026-07-16 (Europe/Paris)

## Active integration state

| Repository | Main checkout | Isolated worktree | Branch | Main modified? |
|---|---|---|---|---|
| `juno` | `/Users/liammagnier/Desktop/workspace/juno` | `/Users/liammagnier/Desktop/workspace/.worktrees/juno-rebuild` | `codex/native-v3-integration` | No; clean after read-only build/runtime smoke |
| `juno-app` | `/Users/liammagnier/Desktop/workspace/juno-app` | `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild` | `codex/native-v3-integration` | No; clean |

The sibling worktrees are the only authorized write locations. The canonical program documents live in `juno/docs/rebuild/`; native-specific contributor rules live in `juno-app/AGENTS.md`.

## Milestone 0: baseline and forensic audit

Status: committed as web/backend `2937b86` and native `632c1cb`; production code unchanged at this milestone.

### Completed evidence

- Confirmed both repositories began clean on `main` and created isolated `codex/rebuild-phase0` worktrees.
- Read the actual package, project, route, schema, network, persistence, auth, sync, Code, design, deployment, and test sources; README/design claims are treated as hypotheses.
- Inventoried authenticated web routes/actions, API families, Prisma aggregates, native modules, competing app/Code implementations, mocks, TODOs, silent fallbacks, and duplicate truth.
- Dated the Code capability audit to 2026-07-16 and checked current official OpenAI Codex and Anthropic Claude Code documentation.
- Performed a local rendered smoke of the public landing and sign-in surfaces. Verified `/app-auth` sends an unauthenticated visitor to `/sign-in?callbackUrl=/app-auth`. No credentials were entered and no private content was captured.
- Preserved failures and contradictions in the audit instead of treating the successful production build as a correctness gate.

### Toolchain and test ledger

| Check | Result | Evidence/notes |
|---|---|---|
| Host | Node 24.18.0, npm 11.16.0, pnpm 11.7.0, Swift 6.4, macOS 27.0 arm64 | Both JS packages declare Node `>=20`; web CI currently mixes Node 20 and 22 and pins neither locally. |
| Web production build in main checkout | Passed, not yet reproducible in audit worktree | Ran `npm run build` in `/Users/liammagnier/Desktop/workspace/juno` using its pre-existing installed dependencies and local development environment; main remained clean. Next 15.5.19 generated approximately 70 page routes and explicitly skipped TypeScript/ESLint validation. The isolated worktree has no dependency install, so it remains dependency-blocked until a clean `npm ci` baseline is run. |
| Web lint | Failed | `npm run lint` entered interactive setup/no checked-in ESLint configuration; `next lint` is stale for this toolchain. This remains a baseline defect. |
| Web unified tests | Missing | No safe unified test script. Several scripts mutate a database or may call paid providers. |
| Web rendered smoke | Passed, public-only, with warnings | Landing and sign-in rendered locally; unauthenticated `/app-auth?...` redirected to `/sign-in?callbackUrl=/app-auth`. Raw-token flow was verified from source, not exercised with an account. Tailwind reported ambiguous `duration-[1800ms]`, `duration-[2200ms]`, and `motion-safe:duration-[2200ms]` classes; these remain baseline warnings. |
| Native macOS build | Passed | `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -scheme Juno -destination 'platform=macOS' build`. Bare `xcodebuild` fails because `xcode-select` targets Command Line Tools. |
| Native tests | Passed | Same Xcode selection with `test`; 29 tests in 7 suites. The Objective-C harness reported 0 tests before the Swift Testing suite ran; the 29 Swift tests are the valid count. |
| Native warnings | Open | Missing SwiftData import in `EngineComposerView.swift`; deprecated `Text + Text` in `EmptyStateView.swift`; unnecessary `await` in `UserMenuFooter.swift`. |
| TypeScript Code core | Passed with caveat | `npm ci`, `npm run build`, `npm test`: 16 tests after build. Running `npm test` before build can report zero, so the script is not self-contained. CLI/desktop/sidecar integration is untested. |

### Highest-priority verified risks

1. `src/app/app-auth/page.tsx` and `handoff.tsx` return the reusable Auth.js cookie in `juno://auth?token=...`; native `WebAuthService.swift`/`AuthSession.swift` persist it. There is no state, PKCE, nonce, one-time code, scoped access/refresh token, reuse detection, or device revocation.
2. `Juno/Services/Backend/SyncService.swift` is upsert-only, advances through failures, guesses message identity from content, silently retains local IDs, and permits failed deletes to resurrect. The server schema has no general revision/cursor/tombstone/receipt substrate.
3. `core/src/server.ts` plus the prototype `SidecarClient.swift` expose an unauthenticated loopback Code service. `core/src/tools/fs.ts`, `bash.ts`, session paths, backend configuration, and mode parsing allow workspace escape, inherited-secret exposure, process survivors, SSRF/cookie forwarding, and permission bypass.
4. Production web build/deploy skips type, lint, and tests; active deploy uses `prisma db push` despite repository guidance requiring migrations.
5. `/api/files/[...key]` and public S3 URLs rely on object-key secrecy; the updater trusts a forgeable self-signed display name; both block production release.
6. Model, reasoning-effort, design, usage, settings, and Code protocol truth are duplicated. Several server and native paths silently substitute, swallow, or fall back.
7. Persistence can silently fall back to an in-memory SwiftData store, risking loss on quit.

### Limitations and evidence still required

- No disposable private development account or sanitized production-like database was supplied. Authenticated UI mutation scenarios and secret-bearing network traces were deliberately not captured. They remain required before feature-parity claims.
- No destructive migration, real token rotation, billing action, paid provider call, connector OAuth, upload, account deletion, remote Code dispatch, Computer Use action, signing, notarization, or updater install was exercised.
- Startup time, memory, scrolling, stream latency, large-history/diff/terminal performance, network volume, accessibility, and visual-regression baselines are not yet instrumented. Successful builds are not performance evidence.
- The current app targets macOS/iOS 26.0 with Xcode beta tooling and disables key release protections; the supported production OS/Xcode matrix needs a product/release decision after CI evidence.

## Architecture decisions

- `juno` is the canonical account/backend/database and owns versioned contracts, model truth, and semantic token sources.
- The native `Juno/` target is the migration host. The prototype desktop shell is not a second product.
- SwiftData is an account-scoped cache/outbox; signed-in server data remains authoritative.
- Native auth is trusted-browser + S256 PKCE + hashed one-time code + short access + rotating refresh family + per-device revocation. A new app may detect a legacy cookie's presence but requires fresh browser authorization and deletes the old Keychain item only after the new session and initial sync succeed; it never silently converts the legacy bearer.
- Sync uses stable mutation IDs, receipts, revisions, tombstones, a monotonic cursor, SSE wakeups, visible conflicts/failures, and idempotent reconciliation.
- The model endpoint supplies explicit ordered effort values and capabilities; the native offline manifest is generated.
- Code execution is capability-based and local. Account tokens/source/paths are not handed to a sidecar. The current unauthenticated sidecar is a release blocker.
- Hidden chain-of-thought is excluded; only safe user-facing summaries and observable actions are represented.

## Current slice and merge order

1. Commit Phase 0 documents and both `AGENTS.md` files without production-code changes.
2. Phase 1A: publish the initial OpenAPI contract and implement native authorization/device-session schema, endpoints, replay/rotation tests, server bearer verification, and a legacy migration boundary.
3. Phase 1B: implement canonical bootstrap/model capability response and validated Swift DTO/client, then remove new raw-token callbacks.
4. Phase 1C: add account change/mutation-receipt/revision/tombstone foundation with settings + conversation metadata as the sync canary; add durable Swift outbox/cursor and two-client convergence tests.
5. Separately gate the unauthenticated sidecar from release while its protected transport and Code safety test suite are built.

Shared migrations, OpenAPI sources, generated Swift DTOs, shared domain models, and design tokens have one integration owner. Release integration is now single-owner and dependency-ordered; no parallel writer may merge competing contract or migration changes.

## Milestone acceptance rule

An item moves to complete only when its contract/code/migration is committed, required checks in `07-test-and-acceptance-plan.md` pass, web compatibility is demonstrated, known failures are documented or fixed, and rollback/recovery exists. This ledger does not claim the rebuild or Phase 1 is complete.
