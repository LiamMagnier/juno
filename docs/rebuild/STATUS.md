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

## 2026-07-16 integration and release-owner run

Status: **release candidate rejected**. Dependency-ordered integration is committed, but live-development, migration, parity, Code-isolation, accessibility, performance, signing and notarization gates are absent or failing. Full evidence is in `08-release-candidate-report.md`.

| Order | Repository | Commit | Scope |
|---|---|---|---|
| 1 | `juno` | `3de47b0` | OpenAPI sync contract, change revisions/tombstones, receipts and native endpoints |
| 2 | `juno-app` | `54d22f4` | Generated client, cursor cache, encrypted outbox and blocking cache failure |
| 3 | `juno` | `213d6fc` | Reasoning sanitization, dependency remediation and lint gate |
| 4 | `juno-app` | `1a5f8b4` | Updater/distribution hardening, filtered command environment and prototype removal |

Secure native authentication is in prerequisite commits `0969b57` and `564c848`. Web static/unit/build/relay/audit checks passed; Mac Release build, 32 Swift tests, 16 Code tests and audits passed. Hardened Runtime is enabled, but App Sandbox is disabled. No valid Developer ID identity exists on the host. The Mac remained locked, so real-account UI, accessibility and all cross-surface scenarios were not run. The only discovered database configuration was production-facing, so migrations were not executed.

Next blocking slice: unlock the reference Mac; supply a disposable PostgreSQL stack and development account; replace in-process Code execution with the signed XPC boundary and enable the UI sandbox; finish parity/sync vertical slices and convergence tests; then run accessibility/performance, signing/notarization, update/rollback and all ten acceptance scenarios on the exact candidate SHA.

## 2026-07-16 Juno Code workspace redesign

Status: **published for manual alpha evaluation, not promoted to production**.

- Native commit `a58209a` removes the persisted `junoClassicCode` selection path and deletes the retired `CodeModeView` and `CodeSidebarView` compatibility surfaces. Shared relative-time formatting moved to `CodeSupport.swift` because the activity and inspector views still consume it.
- The native Code surface now uses a dedicated Juno Code product header, project/task navigation, four workspace-first starter actions, and an anchored context-aware composer. Existing project selection, model choice, permission mode, Computer Use consent, plugins, artifacts, inspector, session history, and send/stop behavior remain wired to native state.
- Debug macOS build passed after the redesign. The complete Swift Testing run passed: 32 tests in 8 suites. The Objective-C harness still reports 0 before Swift Testing starts; that line is not the test count.
- A running Debug app was inspected at the default Mac window size in mock mode. The intended sidebar, landing actions, and composer rendered; the accessibility tree exposed the navigation rows, four starter buttons, composer field, context menu, Computer Use control, model button, and disabled empty-draft send button.
- Universal arm64/x86_64 Release build `3.0.0 (25)` passed and was ad-hoc signed for evaluation. GitHub prerelease `v3.0.0-alpha.3` contains `Juno-3.0.0-alpha.3-unsigned.dmg` with SHA-256 `ad24181b665fbdd50609e15b186d7d298ff5dac2b42857d3a78b566944792afb`.

Residual release status is unchanged: the installer is not Developer ID signed or notarized, the production updater does not point to it, and a real development account plus the cross-surface acceptance matrix have not been completed on this exact build.

## 2026-07-16 native browser sign-in repair and alpha 4

Status: **published for manual alpha evaluation; final live-account callback acceptance remains pending because the reference Mac locked**.

- Native commits `fc416bf`, `36883e8`, and `86c7986` repair the Safari-to-app handoff. Root cause: build 25 did not register the `juno` URL scheme in its final `Info.plist`, and the client still used Apple's deprecated callback initializer. Build 26 has an explicit `CFBundleURLTypes` declaration for `juno://auth/callback`, uses `ASWebAuthenticationSession.Callback.customScheme`, and has a hosted-app regression test that fails if the release bundle drops the scheme.
- Release builds now set `CODE_SIGN_INJECT_BASE_ENTITLEMENTS = NO`; the final ad-hoc Release signature has no development `get-task-allow` entitlement. This is defense in depth only and does not replace Developer ID signing or notarization.
- Exact native check passed: `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project Juno.xcodeproj -scheme Juno -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/juno-v3-test26 test`. Swift Testing ran 33 tests in 8 suites with zero failures.
- Exact universal build passed: `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project Juno.xcodeproj -scheme Juno -configuration Release -destination 'generic/platform=macOS' -derivedDataPath /tmp/juno-v3-release26-final ARCHS='arm64 x86_64' ONLY_ACTIVE_ARCH=NO build`. `lipo -archs` returned `x86_64 arm64`; `codesign --verify --deep --strict` passed; the final bundle reported version `3.0.0 (26)` and a `juno` URL scheme.
- `hdiutil verify` passed for `Juno-3.0.0-alpha.4-unsigned.dmg`. GitHub prerelease `v3.0.0-alpha.4` targets `codex/native-v3-integration`; SHA-256 is `7ab022240065ffc2c4d14f2dec2a16dd7f04f653de19431fc1efc833066ebde6`.
- Build 26 was installed at `/Applications/Juno.app`. Build 25 remains at `/Applications/Juno 3.0.0 build 25 Backup 20260716-185300.app` for rollback. Because ad-hoc rebuilds change identity and caused Keychain authorization stalls, the legacy cookie slot and old installation identifier were removed before the clean retry; no native device credentials existed to migrate. Server data was not deleted, and no endpoint, schema, or database migration changed in this repair.
- Before the final build was installed, the browser authorization action reached the waiting state but could not be accepted as evidence for the repaired binary. The Mac then locked before the final installed build could complete a real account callback. Do not mark browser sign-in or cross-surface acceptance complete until build 26 returns from Safari, exchanges the one-time code, displays the signed-in account, and completes first sync.

Production blockers remain: Developer ID signing, Apple notarization, a signed production update feed, the exact-candidate real-account flow above, and the complete cross-surface acceptance matrix.

## 2026-07-16 native browser sign-in fallback and alpha 5

Status: **published for manual alpha evaluation; exact-candidate browser authorization and session restoration passed, while full V3 sync acceptance remains gated**.

- Native commit `a8e17d2` replaces the hanging macOS `ASWebAuthenticationSession` path with an ordinary Safari launch and a SwiftUI `onOpenURL` receiver for the registered `juno://auth/callback`. The one-time grant still requires the exact callback route, state, nonce and PKCE verifier; the pending request expires after five minutes. The AuthenticationServices path remains available for non-macOS builds.
- Exact native check passed: `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project Juno.xcodeproj -scheme Juno -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/juno-v3-test27 test`. Swift Testing ran 33 tests in 8 suites with zero failures.
- Exact universal build passed: `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project Juno.xcodeproj -scheme Juno -configuration Release -destination 'generic/platform=macOS' -derivedDataPath /tmp/juno-v3-release27 ARCHS='arm64 x86_64' ONLY_ACTIVE_ARCH=NO build`. `lipo -archs` returned `x86_64 arm64`; strict code-signature verification passed; the bundle reports `3.0.0 (27)` and registers the `juno` scheme.
- `hdiutil verify` passed for `Juno-3.0.0-alpha.5-unsigned.dmg`. GitHub prerelease `v3.0.0-alpha.5` targets `codex/native-v3-integration`; SHA-256 is `999840e8eef52f92b282bac2653f30f7e514325dec2567f4af9613f2f7362b3c`.
- Build 27 is installed at `/Applications/Juno.app`. Duplicate app bundles were removed from `/Applications` and preserved under `/Users/liammagnier/Desktop/Juno Backups` so LaunchServices has one installed owner for the callback scheme. The disposable ad-hoc installation identifier was cleared before the retry; no server data or native device credentials were removed.
- Build 26 reproduced the macOS embedded-session hang: Juno entered its waiting state but Safari did not open the authorization URL. The fallback was implemented from that evidence.
- Production still served the legacy reusable-cookie callback after build 27 first opened Safari. A narrowly scoped production hotfix was rebased on current `main`, validated, and merged as `juno` PR `#10` (`0ff3255`). GitHub Actions deployment `29519415441` completed successfully, including the additive schema reconciliation and PM2 reload. An unauthenticated production probe then preserved every V3 authorization parameter through the sign-in redirect, and `/api/v1/auth/session` returned the versioned `1.0.0` unauthenticated envelope.
- Live build-27 acceptance passed for browser launch, the one-time `juno://auth/callback`, PKCE code exchange, Keychain credential persistence, real-account/profile and plan display, explicit sign-out availability, and session restoration after a full quit/relaunch. Safari required its standard one-time “Allow this website to open Juno” confirmation; selecting Allow returned focus to Juno and dismissed onboarding.
- Do not mark the complete initial sync or cross-surface matrix accepted. Production `/api/v1/bootstrap` still returns 404 because the broader revision/change-feed slice remains behind its migration and convergence gates; the installed app can restore the native session and access bearer-compatible existing endpoints, but its full V3 cursor bootstrap has not passed.

Production blockers remain: Developer ID signing, Apple notarization, a signed production update feed, production bootstrap/change-feed rollout after migration rehearsal, and the complete cross-surface acceptance matrix.
