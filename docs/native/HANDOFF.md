# Juno Native — Operational Handoff

Updated: 2026-07-22 18:25 Europe/Paris

> **Read `docs/native/NEXT_PROMPT.md` first.** It is the self-contained
> continuation prompt: exact worktree, branch, head, first command, next task
> and live hazards. This file is the operational detail behind it.

## Resume here

- Worktree: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-claude`
- Branch: `agent/juno-native-claude-continuation` (PR #18 → `agent/juno-native`; PRs never target `main`)
- Head: `043051b` (`fix(auth): report the real Keychain status instead of an enum case index`) — pushed, tree clean
- `main` untouched; `origin/main` is `173be21`; production live and unchanged at `https://chat.liams.dev`
- Next task: **phase 5, backend reconciliation** — triage the uncommitted
  Remote-session work still sitting unstaged in the `main` checkout, then rebase
  PR #19 (`agent/juno-code-remote-backend`, `cedc264`) onto PR #18

## Corrections to what this file used to say

- `gh` auth **is valid** (`repo`, `workflow`). Pushing works. The earlier
  "stored token is invalid" note was wrong.
- `CODE_SIGNING_ALLOWED=NO` builds **cannot sign in** — no
  `application-identifier` means no Keychain access group, so iOS returns
  `errSecMissingEntitlement` (-34018). Those commands are compile gates only.
  Anything touching auth, tokens, sync or an authenticated screen needs a signed
  build. See `TESTING.md`.
- `JunoMacTests` was **failing**, not 2/2 — a count assertion against a
  seven-case enum. Now 5/5.
- The "hanging JunoAuthTests" **does not reproduce**; the suite passes in ~18 ms.

## Sandbox limitations that shape how to verify

- macOS `screencapture` returns black (no Screen Recording grant) and the
  macOS XCUITest runner cannot load its bundle. Verify macOS UI by walking the
  running app's **accessibility tree** (System Events, after setting
  `AXEnhancedUserInterface`). This found three real defects.
- iOS simulator screenshots **do** work: `xcrun simctl io … screenshot`.
- `timeout` does not exist on this host.
- Copying a signed `.app` into this worktree breaks its signature (Desktop/iCloud
  file provider attaches Finder metadata); run `xattr -cr` afterwards.

---

## Earlier handoff detail

## Resume here

- Branch: `agent/juno-native-claude-continuation` (PRs target `agent/juno-native`, never `main`)
- Current completed implementation commit: `37db1af` (`fix(code): correct five workbench defects found in the visual sweep`)
- Worktree: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-claude`
- Current phase: Block 1 (Juno Code preview harness + visual QA). Cloud/Remote Code still blocked on backend (GAP-021).
- Current task: Block 1A (fixture-backed DEBUG `SessionController`, ten scenarios, seventeen
  inertness/determinism tests) is **done** in `a571c3d`. Block 1B's macOS visual sweep found
  and fixed five real defects in `37db1af`.
- Next exact action: finish Block 1B's remaining matrix — narrow/wide sidebar widths,
  inspector open vs closed, full-screen, and the Git/Files/Context/Computer inspector tabs
  under the `error` and `disconnected` scenarios — then Block 1C (VoiceOver, Dynamic Type,
  keyboard focus, Reduce Motion, EN/FR) across JunoMobile and JunoMac.

### Reproducing the visual sweep

```bash
# Build once.
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild \
  -project native/macOS/JunoMac/JunoMac.xcodeproj -scheme JunoMac \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath /tmp/juno-mac-preview-dd CODE_SIGNING_ALLOWED=NO build

# Launch any scenario. All ten are in the sidebar; the argument only preselects one.
open -n /tmp/juno-mac-preview-dd/Build/Products/Debug/JunoMac.app --args \
  --juno-code-ui-preview --juno-code-preview-scenario diffs   # add --juno-preview-dark
```

Scenarios: `transcript` `streaming` `approval` `terminal` `diffs` `tests` `longText`
`error` `disconnected` `empty`.

Two traps when scripting this: the app can take up to ~15s to create its window after
`open -n`, so poll `CGWindowListCopyWindowInfo` for a layer-0 window rather than sleeping a
fixed interval; and capture that window by its `CGWindowID` (`screencapture -l`) rather
than a screen region, which would otherwise photograph the user's desktop.

The main checkout at `/Users/liammagnier/Desktop/workspace/juno` is independently
on `main` at `e0d1285` with pre-existing Remote Session changes. Never reset,
clean, restore, stage, or commit those files from this native worktree.

## Actually completed

- General repository/backend/OpenAPI/toolchain/prototype audit; baseline commit `1de5cda`.
- Canonical callback and OpenAPI/backend/Swift-generation alignment; implementation commit `b903159`.
- `JunoNativeKit` Swift 6 package with ten acyclic products and 134 strict-concurrency tests.
- Security.framework-backed, device-local `KeychainAuthTokenStore` with active-account restoration, account-switch purge, serialized compare-and-swap, and ten focused tests.
- Canonical PKCE-S256 browser authorization, strict callback correlation, existing token/refresh/session/logout route client, authoritative session validation, and production app composition on macOS and iOS.
- Refresh-aware same-origin bearer transport and a fail-closed checkpoint client for the existing `/api/v1/bootstrap` route, with account, contract, cursor and model-manifest validation.
- Deterministic generated Swift contract and local drift command.
- Storage/sync/search foundations: account-scoped store protocol, deterministic in-memory test adapter, cursor application, mutation outbox, and local-search contract.
- Production encrypted SQLite repository with explicit schema checks, WAL/FULL
  durability, optimistic transactions, protected files, per-account wipe and an
  atomic device-local Keychain key.
- Atomic installation of fully hydrated bootstrap entities plus cursor/floor and
  model-manifest metadata; both apps open this repository and auth lifecycle
  purges it before credential removal.
- Production synchronization in `364f0f2`: persisted bootstrap/cursor, entity
  hydration, atomic pages, tombstones/revisions, real SSE wakeups, compaction
  rebuild, reconnect backoff/jitter, strict account isolation and encrypted
  durable mutation outbox/drainer.
- Real conversation/message projection and both native list/detail surfaces in
  `0cb44d8`, including durable create, rename, model, pin and archive mutations.
- Real chat in `6e20050`: native composer/model/effort controls, idempotent user
  append, production SSE, progressive response/reasoning/sources, cancellation,
  retry and sync-based reconnect without duplicate POSTs on ambiguous loss.
- Real projects and files in `35fce4a`: encrypted account-scoped projection,
  durable project mutations, linked conversations, bearer uploads, fresh file
  access hydration, preview/rename/delete, and native state handling on both apps.
- Real library and artifacts in `719db31`: encrypted synchronized file browsing,
  offline artifact/version history, direct bearer hydration, optimistic edit and
  restore conflicts, rename/delete, Office export and native previews on both apps.
  Existing routes were published in OpenAPI; no backend route was added.
- Real memory and settings in `778a47d`: encrypted synchronized memory/settings
  projection, optimistic durable mutations with conflict resolution and retry,
  summary hydration via existing `GET /api/memory`, explicit-acknowledgement
  permanent reset, and complete settings/memory forms on both apps. `/api/memory`
  published in OpenAPI 1.2.0 with `CONTRACT_VERSION` mirrored; no backend route
  was added.
- Real offline global search: query-time projection of encrypted synchronized
  entities through the JunoSearch contract in a throwaway index (no plaintext
  persistence), with debounce, cancellation, grouped ranked results and
  navigation on both apps.
- Mutation-conflict resolution across conversations and projects with keep-mine/
  use-server banners, plus a durable offline/reconnect proof: an offline-enqueued
  mutation survives relaunch, submits once on reconnect with its original
  idempotency key, and ambiguous loss replays the same key as a server-side
  no-op.
- Juno Code macOS integration (PR #17 merged in `677d781`): `JunoCode` package
  (Core/Local/Runtime/UI/Bridge, 179 strict tests), standalone `JunoCode` app,
  and a Code section in `JunoMac` via `JunoMacCodeView` on the authenticated
  model transport. Cloud/Remote Code stay disabled pending backend routes
  (GAP-021).
- Fixture-backed DEBUG Juno Code preview in `a571c3d`: `SessionController`
  gained `init(previewFixture:)`, which builds without the optional `Live`
  bundle holding `WorkspaceContext`, `CodeSessionStore`, `PermissionCoordinator`
  and `AgentOrchestrator`. `CommandExecutionService`, `GitService`,
  `CheckpointStore`, `WorkspaceIndexService`, `ToolRegistry` and the model
  transport are therefore **absent from the object graph**, not present and
  uncalled — inertness is a property of the type, and no production security
  check was weakened. Ten deterministic scenarios cover every renderable state,
  all reachable in one launch; seventeen tests assert unreachability,
  determinism and render-matrix coverage.
- Juno Code macOS visual sweep in `37db1af`: five real defects found by actually
  looking at all ten scenarios in light and dark at three window sizes —
  inspector vertical-centring on non-expanding tabs, terminal soft-wrapping,
  filename-destroying path truncation, "1 files" pluralisation, and
  tail-truncated sidebar workspace paths — plus a fixture bug that was masking a
  raw home-path leak in the sidebar and Context tab.
- Independent macOS and iOS projects with Debug/Stable/Next configs, EN/FR catalogs, privacy manifests, callback scheme, skeleton entitlements, unit/UI test targets, and app assets.
- Debug and Stable unsigned builds pass for both projects; macOS Stable is universal.
- macOS unit tests 2/2 and iOS unit tests 2/2 pass.
- All three active lots integrated in `0fb7cc3`.

This is a compile-verified foundation, not a feature-complete app or release.

## Open next

1. Block 1B remainder: narrow/wide sidebar widths, inspector open vs closed, full
   screen, and the Git/Files/Context/Computer inspector tabs under the `error`
   and `disconnected` scenarios
2. Block 1C accessibility: VoiceOver labels and order, keyboard focus, Dynamic
   Type, Reduce Motion, contrast, and EN/FR across JunoMobile and JunoMac
3. `agent/juno-code-remote-backend` (at `cedc264`, checked out in no worktree —
   the worktree still has to be created) for Phase 11
4. `docs/native/API_GAPS.md` GAP-021 (Cloud/Remote Code backend routes)
5. `docs/native/JUNO_CODE_HANDOFF.md` ("Not implemented yet" + "Backend needs")

## Commands to run next

```bash
cd /Users/liammagnier/Desktop/workspace/.worktrees/juno-native-claude
git status --short --branch
git log -3 --oneline
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test \
  --package-path native/Packages/JunoNativeKit \
  --scratch-path "$(mktemp -d)" \
  -Xswiftc -warnings-as-errors -Xswiftc -strict-concurrency=complete
npm run native:contract:check
```

After durable storage is composed into the apps, rerun the package suite and both Debug builds:

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild \
  -project native/macOS/JunoMac/JunoMac.xcodeproj -scheme JunoMac \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath /tmp/juno-mac-next-derived CODE_SIGNING_ALLOWED=NO build

DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild \
  -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/juno-mobile-next-derived CODE_SIGNING_ALLOWED=NO build
```

## Test record

Passing:

- `npm run native:contract:check`.
- Strict Release package build with `-warnings-as-errors`.
- Strict JunoNativeKit suite: 156/156 tests, including fifteen memory/settings, five search, and two offline/reconnect proof tests.
- Strict JunoCode suite: 198/198 tests, including the seventeen preview-harness
  inertness, determinism and coverage tests.
- Strict JunoCode Release build, which confirms the DEBUG preview harness is
  compiled out of shipping builds entirely.
- JunoCode standalone Debug unsigned build.
- Web `npx tsc --noEmit` and `tsx --test tests/native-contract.test.ts` (3/3).
- JunoMac Debug and Stable unsigned builds.
- JunoMobile Debug and Stable simulator builds.
- JunoMac unit tests: 2/2.
- JunoMobile unit tests: 2/2.
- Earlier Web typecheck/lint/test baseline and callback contract tests.

Failed, unrun, or pre-existing:

- **`JunoAuthTests` hangs in this session.** `swift test` on `JunoNativeKit` reaches
  `JunoAuthTests` and stops there: a `sample` of the process shows the main thread parked in
  `XCTWaiter._synchronouslyWaitForTimeInterval` inside `waitForExpectations`, with
  `KeychainCircle` loaded — an expectation that never fulfils, most likely a Keychain-backed
  test that cannot complete in a non-interactive context. 99 tests pass before it hangs.
  Re-running with `--skip JunoAuthTests` passes **134/134, exit 0**, so the hang is confined
  to that one suite and the rest of the package is green. This is unrelated to the
  Juno Code work in `a571c3d`/`37db1af`, which touches only the `JunoCode` package and the
  two app entry points. **Diagnose before trusting the "156/156" figure recorded earlier.**

- Live account completion was not run because it requires an interactive browser session; the sign-in gate UI tests pass 1/1 on macOS and 1/1 on iOS.
- Next configurations were generated/inspected but not compiled separately.
- The default package `.build` path inside the Desktop/File Provider worktree can fail product signing due Finder metadata/resource forks; use an isolated `/tmp` scratch path.
- `xcodebuild` without `DEVELOPER_DIR` selects Command Line Tools and fails.
- The separate monolithic prototype's iOS build has the pre-existing macOS-only `Host.current()` error. Do not patch or ship the prototype.
- Three pre-existing Web React Hook warnings remain.

## Uncommitted changes

Known preserved changes: iOS Xcode 27 project/scheme rewrites and both generated
String Catalog rewrites. They are not part of `719db31`; inspect before staging
and do not reset them or the independent main checkout.

## Decisions not to reopen without evidence

- Two independent app projects; shared code only through acyclic local packages.
- Existing backend remains authoritative; native never accesses PostgreSQL.
- Canonical reverse-DNS callback, exact legacy callback retained server-side only.
- Bearer device sessions plus Keychain; no Web-cookie identity, direct provider credentials, demo/BYOK production paths, or token logging.
- In-memory store/search implementations are test/development adapters, not production persistence.
- Mac-authoritative Remote sessions and native system navigation/materials.
- No publication before CI, archive, signature, privacy, secret, and notarization/TestFlight gates pass.

## Work not to repeat

- Do not repeat the general repository audit or basic OpenAI/Anthropic/Apple research while these docs are current.
- Do not rebuild the package/project skeletons or reintroduce a monolithic multiplatform project.
- Do not recreate the generated contract manually; use the generator and drift command.
- Do not treat the local prototype or `public/downloads/Juno.dmg` as release-ready.
- Do not rerun or modify the three completed lots unless a concrete regression is demonstrated.

## Remaining work

- Juno Code Remote Host, Cloud Code, and Remote mobile (blocked on GAP-021 backend routes).
- Live-account interactive completion (device browser, connected-device management).
- Full typed chat/upload/account/Code/Remote/voice/push contracts.
- Functional feature UI on macOS and iOS/iPadOS.
- UI/E2E/accessibility/performance/secret/dependency gates and native CI.
- Production artwork, signed archives, notarized macOS distribution, and TestFlight/App Store delivery.

## Real blockers / user actions

- GitHub CLI token is invalid; `gh auth login -h github.com` is required before push/release.
- Apple bundle-ID reservation, Team/signing/provisioning, App Store Connect, Developer ID, and notarization inputs are unavailable.
- StoreKit product mapping and APNs credentials require owner-provided production values.

Continue non-proprietary implementation sequentially. Ask for these inputs only
when the corresponding release/commerce/notification gate is reached.
