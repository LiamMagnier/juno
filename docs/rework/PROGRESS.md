# Juno Refoundation — progress

Branch `rework/refoundation`, worktree `../juno-refoundation`, started from
`main` @ `1feb392c` (Release Juno for Mac 1.9.3, build 94) on 2026-09-30.

This file is the running record: what each phase did, how it was verified, and
what it left open. `PRODUCT_REFOUNDATION.md` is the product decision;
`DECISIONS.md` is the log of individual decisions and their reasons.

## Baseline (main @ 1feb392c, before any refoundation edit)

Run with `.claude/local-tools/refoundation/gate.sh` (3 machine-wide slots) in
the fresh worktree after `npm ci`, `npm ci --prefix runner/agent-core`, the
agent-core build and `npm run i18n:extract`.

| Gate | Result | Notes |
|---|---|---|
| `npm run typecheck` | pass | |
| `npm run lint` | pass | |
| `npm test` | pass | 4,165 tests: 4,124 pass, 0 fail, the rest skipped (DB-gated) |
| `capabilities:check`, `work:contract:check`, `shell:contract:check` | pass | |
| `design:contract:check` | pass | |
| `design:tokens:check` | **FAIL (pre-existing)** | `globals.css` changed on main without regenerating `tokens.generated.ts` and `JunoGeneratedTokens.swift` |
| `native:parity:check` | **FAIL (pre-existing)** | 7 routes unclassified in `contracts/parity/features.json` (`/api/agents/[id]/starter`, `/api/agents/hire-draft`, `/api/mcp/servers*` ×4, `/api/skills/import/file`) and `/api/agents/[id]/duplicate` marked planned though Swift calls it |
| `native:sync:check` | **FAIL (pre-existing)** | fails because of the two gates above; its other 11 gates pass |
| `native:wire:check`, `native:contract:check`, `native:design:check`, `native:register:check` | pass | |
| `security:check` | **FAIL (pre-existing)** | 116/116 security tests and the secret scan pass; the dependency advisory step flags `brace-expansion`, `fast-uri`, `image-size`, `ip-address`, `nodemailer`, `pptxgenjs` |
| `models:capabilities:audit`, `work:sandbox:check` | pass | |
| `code:runtime:check`, `code:remote:check`, `code:preview:check` | pass | |
| `npm test --prefix runner/agent-core` | pass | |
| `npx prisma validate` | env-only failure | needs `DATABASE_URL` and `DIRECT_URL`; re-run with placeholder URLs |
| `npm run build` | _pending_ | |

## Phases

| # | Phase | State | Commits | Verification |
|---|---|---|---|---|
| 0 | Baseline, competitor research, current-state audit and screenshots | in progress | | |
| 1 | Product architecture and information architecture | | | |
| 2 | Design-system directions and the final decision | | | |
| 3 | Shared web primitives, shell, sidebar, composer, chat | | | |
| 4 | Native design-system adaptation and shell parity | | | |
| 5 | Connectors and Skills | | | |
| 6 | Crew | | | |
| 7 | Work, Research, Voice | | | |
| 8 | Artifacts lifecycle | | | |
| 9 | Juno Code runtime correctness and architecture | merged into `rework/refoundation` | lane merges `76e1accb` `90681ce7` `954fc35c` `84114901`; trunk merge `4c3e59f1` | see Phase 9 below |
| 10 | Juno Code on Mac | | | |
| 11 | Code on web and iOS: remote and cloud parity | | | |
| 12 | Accessibility, motion, responsive polish | | | |
| 13 | Security hardening | | | |
| 14 | Production release and CI hardening | | | |
| 15 | Visual QA and acceptance | | | |

## Phase 9 — Juno Code runtime correctness and architecture

Four lanes, each built and then reviewed on its own branch from
`rework/refoundation` @ `3e3040e6`, merged with `--no-ff` in this order onto
`rf/code-integration` (worktree `../juno-rf-code-integration`, started from
`rework/refoundation` @ `39fd9881`). Product decision: §11 of
`PRODUCT_REFOUNDATION.md` and D-014 (converge the protocol, not the engine).

### What landed, per lane

**`rf/code-runtime` — the Swift loop** (18 commits, `a06f008c`…`b3f75574`;
merge `76e1accb`, clean).

- Stable cache prefix: goal, skills, date and branch leave the system prompt
  for a `<session_state>` block sent only when a section changes; the system
  prompt is built once per session and reused byte for byte; images stay until
  compaction under a 20-image / 12 MB cap; a fourth breakpoint marks the last
  request's tail; the compaction summary continues the cached request
  (`a06f008c`).
- Typed retry policy ported from the cloud runner: backoff with jitter,
  `retry-after`, fallback only after backoff and only when the reader opted in,
  refused requests (400/404/422) never retried, a stalled stream retried once
  (`c2aed791` `f28afee4` `68ce3975` `b627778c`; proxy `c1923284` `a9a6b320`).
- A tool batch is saved before it runs and a restored session is told what
  ran (`c6c38635`); malformed arguments are answered with the parse error and
  exact scalars coerced once, up front, so risk and scheduling see what runs
  (`f3e7f0f1` `74cebb51` `b3f75574`).
- Long `run_command` / `run_tests` output spills to the session folder and is
  paged back through `juno://command-output/` instead of being killed at 2 MB
  (`76ce5d95` `c507d0b1`).
- Replaceable goals (a completed goal no longer freezes later batches,
  `0cbef417`), path-keyed skill ids, ordered approvals, safe MCP names, moves
  checked at both ends (`7d9f406a`); a cache-aware usage ledger per session
  (`0ffe8083`); Mac-hosted Work turns through integrity repair and the retry
  policy (`63d7b878` `b7d4aa0c`).

**`rf/code-tools` — the Swift tool surface** (18 commits,
`de5d053d`…`2fb6a2a9`; merge `90681ce7`, 9 files in conflict).

- `multi_edit` and an atomic multi-file `apply_patch` with the Codex envelope
  (`de5d053d`); numbered `read_file` with images, PDFs and honest binaries
  (`76580461`); `grep` with context, counts, multiline and every `.gitignore`
  (`b2e414bf` `0d8a2a98`).
- Background shells (`shell_start/output/write/kill`) under run_command's
  sandbox and approvals, and a per-session working directory that survives a
  relaunch (`5d433841` `bcbdcbd8` `e47669d3` `2fb6a2a9`); typing into an
  interpreter always asks and newlines split commands (`74d93363`).
- `todo_write`, `ask_user` and Plan → approve → Code (`fd7bd661` `afdcc4a8`
  `379b13cf`); nested AGENTS.md / CLAUDE.md / JUNO.md delivered with tool
  results, after the result's bounds (`b017fce8` `f489f9af` `379b13cf`).
- Skills trusted before they are offered, loaded on demand with `use_skill`,
  identified by path (`b0374d47`); every file of a patch envelope meets the
  Edit hooks (`df44c420`); relay events for checklists, questions and plans
  bounded in bytes (`c8b8fdfc` `f3b855c9`).

**`rf/agent-core` — the cloud engine** (12 commits, `a0766a4b`…`3c19b79e`;
merge `954fc35c`, 1 file in conflict).

- The Mac's permission rules read by agent-core, one shared fixture pinning
  both engines, a repository only able to narrow them; the cloud runner reads
  no reader's settings file (`a0766a4b` `65769b30`).
- Typed failures (plan limit, over-long prompt, tool throw) (`e1934f89`);
  prompt caching with four breakpoints and a byte-stable prefix (`5a72e709`
  `06435618`); signed thinking kept and replayed in the tool loop
  (`2ede9ddc`); compaction at 80% of the window, a Stop during it stopping the
  run (`d2654f46` `bf756965` `3c19b79e`); proxied calls attributed to their
  task (`0349cee9`); an OpenAI Responses adapter replaying sealed reasoning
  (`42ecdab5`).

**`rf/agent-protocol` — one protocol** (12 commits, `1866e184`…`363b94ee`;
merge `84114901`, 2 files in conflict).

- Device tasks carry model and effort to the Mac (`1866e184`); the canonical
  agent session protocol v1 (31 events, 8 commands, 23 enums), generated for
  agent-core, the web and a Swift target, with one fold in TypeScript and a
  line-for-line Swift port held to golden transcripts (`65106905` `5ebed5d2`).
- The cloud runner speaks the protocol with legacy twins (`ab49461b`
  `a95d2a45` `363b94ee` `0b1c121f`); one projection of a Mac session spelled
  for the relay and the device-task wire, posted in bodies the server accepts
  (`bbdd2061` `8a99ddf9` `d305efdb` `7c1c0600`); dead remote-session and
  sandbox paths deleted (`5115655c`).

### What the integration itself changed

The conflicts were resolved by keeping both lanes' behaviour; the new code is
in the merge commits.

- `90681ce7`: skills are listed (name and description, trusted and switched
  on) in the `<session_state>` skills section rather than the system prompt,
  and `use_skill` is registered in every project session with a provider that
  reads the reader's switches and trust at call time (`SessionSkillProvider`),
  so trusting or switching a skill never changes the system prompt or the tool
  list. run_command keeps the session folder and `cwd` and streams through the
  spill capture; read_file keeps images/PDFs/numbering and still reads
  `juno://command-output/`. New test: a skill trusted mid-session loads through
  the existing tool with the prefix byte-identical.
- `954fc35c`: `shell_start` added to the shared Bash family in the Swift
  table, the fixture and agent-core's copy.
- `84114901`: the Mac's `todo_write` / `ask_user` / `exit_plan` entries map
  onto `plan.updated`, `question.asked/answered` and `plan.proposed/resolved`;
  the relay keeps the typed `canonical_session_event` for them with the
  protocol beside it, and a checklist no longer blanks the phone's goal line;
  the device-task status lines rf/code-tools had added to the deleted
  `DesktopCodeHost` mapping now come from `CodeTaskWireProjection`.
  agent-core's projector turns `context_compacted` into `item.compaction`,
  and `protocolUsage` reports uncached input (agent-core's `inputTokens` now
  includes the cached prefix, which the protocol reader adds back). Status
  file updated to match.

### Verification (on `84114901`, through `gate.sh`)

| Gate | Result | Notes |
|---|---|---|
| `npm run native:test JunoCode` | pass | 1,278 XCTests (12 skipped), 78 Swift Testing, 0 failures (lanes' baseline 1,073 / 77) |
| `npm run native:test JunoNativeKit` | 3 failures, pre-existing | 1,673 XCTests, 58 Swift Testing. `PreviewWorldTests` (fixture email) and two `JunoTokenConsumptionTests` (unread `JunoGeneratedRadius.stage`, hand-typed colours in `JunoMobileIncognito/Premium.swift`); no lane touched these files |
| `npm run native:test JunoWork` | pass | 298 XCTests |
| `xcodebuild … -scheme JunoDesktop -configuration Debug CODE_SIGNING_ALLOWED=NO build` | pass | DerivedData `/private/tmp/juno-rf-dd-integ`. The strict warnings-as-errors build was not re-run here; the swift-loop lane reported it stopping on pre-existing macOS 26 deprecations in files no lane touched |
| `npm test --prefix runner/agent-core` | pass | 236 tests |
| `npm run typecheck` | 4 errors, environment | all in artifact files: the shared `node_modules` Prisma client was regenerated for `rework/refoundation` @ `a10b8237` (nullable `Artifact.conversationId`), which this branch predates |
| `npm test` | 1 failure, environment | 4,335 tests: 4,284 pass, 50 skipped. `imapflow no longer pulls nodemailer`: the shared install has imapflow 1.4.3, the lockfile 1.7.8 |
| `npm run lint` | pass | 0 errors, 7 warnings in `src/app/dev/design/*` |
| `npm run agent:protocol:check`, `code:task-wire:check` | pass | |
| `npm run native:sync:check` | 14 of 15 | `design:tokens:check` and `native:parity:check` now pass; `native:parity:label` wants a PR label for `src/app/api/chat/route.ts`, changed by the base (`20c902ed`), not by this phase |
| `code:remote:check`, `code:runtime:check`, `work:sandbox:check` | pass | |

### Merged into the trunk (`4c3e59f1`, through `gate.sh`)

`rf/code-integration` @ `c22d4016` merged with `--no-ff` into
`rework/refoundation` @ `6ac9b383` (after artifacts-core, chat-context and the
design round 3 commits). One conflict, `src/lib/serializers.ts`: both sides
added an import beside `readToolDetail`; both kept, so an activity row carries
the integration's `toolStatus` and the trunk's `contextReceipt`, each only when
set. `package.json` auto-merged (the trunk's `artifacts:maintenance`, the
integration's `agent:protocol` and `code:task-wire` scripts). No generated
contract needed regenerating: chat wire, parity ledger, agent protocol and
task-wire checks all passed on the merge as committed. `2adf8e75` then fixed
the three JunoNativeKit failures that predate the refoundation.

| Gate | Result | Notes |
|---|---|---|
| `npm run native:test JunoCode` | pass | 1,278 XCTests (12 skipped), 78 Swift Testing, 0 failures |
| `npm run native:test JunoWork` | pass | 298 XCTests |
| `npm run native:test JunoNativeKit` | pass | 1,673 XCTests, 58 Swift Testing, 0 failures with `2adf8e75`, which fixes the three pre-existing failures |
| `xcodebuild … -scheme JunoDesktop -configuration Debug CODE_SIGNING_ALLOWED=NO build` | pass | DerivedData `/private/tmp/juno-rf-dd-trunk` |
| `npm test --prefix runner/agent-core` | pass | 236 tests, after `npm run build --prefix runner/agent-core` (the test script runs `dist/`, which was stale: 176 tests) |
| `npm run typecheck` | pass | 0 errors; the environment errors above went away with the trunk's Prisma client |
| `npm test` | pass | 4,485 tests: 4,418 pass, 67 skipped, 0 failures (also re-run after the agent-core build) |
| `npm run lint` | pass | 0 errors, 8 warnings, all in `src/app/dev/design/*` |
| `agent:protocol:check`, `code:task-wire:check`, `native:wire:check`, `native:parity:check`, `native:contract:check` | pass | |
| `npm run native:sync:check` | 14 of 15 | `native:parity:label` flags `src/app/api/chat/route.ts`, `src/lib/chat/request.ts` and `app-sidebar.tsx` against `origin/main`, all changed by earlier trunk work; on the merge's own diff (`--base 6ac9b383`) no watched file changed |
| `code:remote:check`, `code:runtime:check`, `code:preview:check`, `work:sandbox:check` | pass | |

### Still open

- No host accepts protocol commands yet (slice 2): a question or plan on the
  Mac can be seen from the phone and the web but only answered on the Mac;
  `turn.failed` and the Mac's `usage.updated` are still planned.
- On the Mac both the goal's steps and the `todo_write` checklist are
  `plan.updated`; a protocol reader shows whichever snapshot came last.
- agent-core: the proxy does not store the run id yet, and the OpenAI
  Responses adapter is unreachable until `isWorkCapableModel` and the catalog
  let Responses-only models through (a product decision).
- The strict (warnings-as-errors) JunoDesktop build (as the swift-loop lane
  reported it) is a pre-existing failure outside Phase 9. The three
  JunoNativeKit tests above are fixed on the trunk (`2adf8e75`).

## Phase 10 — Juno Code autonomous agent (`docs/rework/CODE_AGENT_SPEC.md`)

### Step 0: the seams commit (`rf/code-agent-seams`, §6.0)

The shared types and hook points every lane builds on, merged before the
lanes start. Behaviour is unchanged: nothing records the new events yet, the
default stop check finishes every run as before, and every lane model and
tool provider starts empty.

| Seam | Where | Owner after this |
|---|---|---|
| `RunEndReason`, `GateReason`, `TurnOrigin`, `RuntimeNote` (fenced `<juno_runtime>`), `Budget`, `BudgetUsage` | `JunoCodeCore/RunOutcome.swift` | Lane A |
| `VerificationRecord`, `UIVerificationRecord`, `ReviewRecord`, `CheckKind`, `VerificationLedgerReading` / `Writing`, `VerificationSnapshot` | `JunoCodeCore/VerificationRecords.swift` | Lane B |
| 12 `SessionEventPayload` cases (`runContinued`, `runOutcome`, `verificationRecorded`, `uiVerificationRecorded`, `reviewCompleted`, `goalSet`, `goalEdited`, `goalVerdict`, `goalStatus`, `checkInDue`, `ciStatus`, `budgetReached`), projected to protocol v1.1 | `SessionEvents.swift`, `AgentProtocolProjection.swift` | Lane A |
| `CompletionGating` (default `ReportOnlyCompletionGate`), `resume(note:origin:)`, PreCompact / PostCompact / PostToolBatch / PostToolUseFailure | `CompletionGating.swift`, `AgentOrchestrator.swift`, `AgentLifecycleHooks.swift`, `ToolScheduler.swift` | Lane A (gate, resume), Lane F (hooks) |
| `goal`, `verification`, `screen`, `previewLease`, `reviewQueue`, `commands` on `SessionController` | one file per lane in `JunoCodeUI/Models/` | each lane |
| Thread items `.continued`, `.goalVerdict`, `.verification`, `.uiCheck`, `.reviewFindings`, `.screenStep`, `.ciStatus`, `.runReport` with placeholder rows | `StudioThreadItems.swift`; rows in `StudioLoopRows`, `StudioVerificationRows`, `StudioRunReport`, `Views/Preview/PreviewCheckRow`, `StudioScreenStepRows`, `StudioCIBar` | each lane |
| `CodeToolProvider` and one empty provider per lane | `CodeToolProvider.swift`, `JunoCodeUI/Models/CodeToolProviders.swift` | each lane |
| Protocol v1.1 (12 events, 7 commands, new enum values) | `contracts/agent/*`, regenerated outputs, `autonomous-loop` fixture | Lane A |

Deviation from §6.0: the review queue is `SessionController.reviewQueue`,
because `review` already holds the document-review model.

Gates on the branch (through `gate.sh`): `native:test JunoCode` 1,322
XCTests (13 skipped) + 78 Swift Testing, 0 failures (44 new tests, among
them: a continued turn cannot write in a read-only session, and Stop during
the stop check sends no continuation);
`native:test JunoNativeKit` 1,673 + 58, 0 failures; JunoDesktop Debug
`xcodebuild` succeeded; `typecheck` 0 errors; agent-core 236/236;
`agent:protocol:check`, `code:task-wire:check`, `code:runtime:check`,
`code:preview:check`, `code:remote:check`, `native:contract:check`,
`native:parity:check`, `check-approval-dispatch` pass. `npm test`: 4,485
tests, 4,416 pass, 67 skipped, 2 fail, both outside this change and failing
on the trunk too since 2026-10-01: `google:gemini-omni-flash-preview` passed
its `retiresOn: 2026-09-30` and left the catalog
(`tests/model-catalog-fidelity.test.ts`, `tests/video-gen.test.ts`).

### Lane D: Preview and browser (`rf/code-preview`, §4, §5.15, §6.4)

Worktree `../juno-rf-code-preview`, branched from the trunk at `e1fde2fa`.
Nine commits, `d473d57c`…`f051bfa1`; nothing pushed. The Preview now belongs
to the session, not the view: a registry owns every dev server and sessions
lease them; one hardened page per preview is re-parented between the dock and
the window and kept in a host window when neither shows it; the agent drives
it with `preview_server` and `preview_browser`; UI edits are checked in the
running page before a Code run may end, and the runtime mints the evidence.

#### Offscreen-host spike (measured before the registry work, §6.4)

Harness: `swift test` (xctest process), a fixture page from
`StaticPreviewServer` with an rAF counter, a 16 ms `setInterval` counter and
capture-phase listeners recording `isTrusted`; synthesized `NSEvent`s
delivered to the `WKWebView` (never posted to the window server).

| Host window | `visibilityState` | rAF / s | timer ticks / s | `takeSnapshot` | NSEvent click → page events |
|---|---|---|---|---|---|
| never ordered | hidden | 0 | 1 | 800×600 | pointerdown, mousedown, pointerup, mouseup, click, all `isTrusted: true` |
| ordered at −20000,−20000 | hidden | 0 | 1–2 | 800×600 | same |
| 1-pt on screen, alpha 0.01, floating | hidden | 0 | 1 | 800×600 | same |
| 800×600 with 1 pt on screen | hidden | 0 | 1 | 800×600 | same |
| any of the above with `inactiveSchedulingPolicy = .none`, or as an accessory app | hidden | 0 | 1 | works | same |

Findings: WebKit hides and throttles an offscreen page (no rAF, timers at
1 Hz), while snapshots, script evaluation and trusted synthesized input keep
working. The HMR-socket analogue (the static server's SSE live-reload stream)
stays connected and delivers reloads (`StaticPreviewServerTests`). The xctest
process never sees an occlusion state of "visible", even for an on-screen
window, so the harness cannot show whether the 1-pt host un-throttles. Per
D-025 the fallback applies: the app calls `PreviewHost.configureForApp()`,
which sets `PreviewPage.backgroundHostMode = .onePoint`; tests keep
`.offscreen` and never put a window on screen. Settling is polled from Swift
(page timers are throttled), and the snapshot says when the page is hidden.
**Manual probe before release:** with a background session's preview, turn on
"Allow inspection scripts" and run `preview_browser eval document.visibilityState`
(expect `visible` with the 1-pt host).

#### Spec items

| Item | Status | Notes |
|---|---|---|
| §4.8 P0: PV-29/30/31 static server | DONE | dotfiles, `node_modules`, `.git`, `*.pem`, `*.key`, `.env*` → 404 on the asked and the symlink-resolved path; no `Access-Control-Allow-Origin`; foreign `Host` → 421; `SO_NOSIGPIPE`; `poll` writes, 64 KB streaming, single byte `Range`; SSE live reload via `WorkspaceChangeDetector` |
| §4.8 P0: PV-33 show the command | DONE | start card and `PreviewConfigApprovalCard`: argv, folder, env keys, port, network, source, warnings |
| §4.8 P0: PV-2, PV-3, PV-4, PV-38, PV-39 | DONE | honest `open_preview` alias; restart and stop tools; one page re-parented on appear; reload keeps the route; wiring check rewritten |
| §4.8 P0: PV-11 (`&&`, `vitest`) | SKIPPED | Lane B owns `CommandAndTestTools.swift` (§4.5, §6.2); not touched here |
| §4.1 registry, leases, idle stop, sharing, worktrees | DONE | `JunoCodeLocal/PreviewRegistry.swift`; a view never stops a server; a deleted session's leases end; 30 min idle with no lease and no view |
| §4.1 one page per preview, offscreen host + 1-pt fallback (D-025) | DONE | `PreviewPage`, `PreviewPageRegistry`, `PreviewHost.configureForApp()`; see the spike |
| §4.1 PGID ledger and orphan reaping | DONE | `PreviewServerLedger`: start-time check before any signal; reaped at the shared registry's first use; SIGTERM to this process's servers on quit |
| §4.1 `DevServerService.start` async | DONE | `start(_ launch:) async`; the old synchronous API stays for its tests |
| §4.1 durable shells as the process layer | PARTIAL | `preview_server attach shell_id` promotes a shell whose process group listens on the printed loopback port; servers Juno starts still run under `DevServerService`, not as `role: server` shells |
| §4.2 `.juno/launch.json` + read-only `.claude/launch.json` import | DONE | Claude's fields plus `network`, `ready`, `autoVerify`, `allowedExternalOrigins`; `${workspaceFolder}` and `${port}`; issues in words |
| §4.2 discovery writes the first file | DONE | Node (nested, root lockfile), Django, Flask, FastAPI, Rails, PHP/Laravel, Hugo, Go, static from the folder holding `index.html` (PV-16); "Save as .juno/launch.json" in the pane |
| §4.2 URL truth (PV-8, PV-9) | DONE | `ListeningSocketOwnership` (libproc); every printed URL is a candidate, only a port the group listens on counts; LAN rewritten to loopback only when the group listens there |
| §4.2 ports (PV-15) | PARTIAL | `autoPort: true` picks a free port and passes `PORT`; a fixed taken port fails naming its owner. "Unset asks once and saves" is not built: unset behaves as fixed and the message suggests `autoPort` |
| §4.2 network ask (PV-7), ready, logs (PV-12) | DONE | blocked outbound host read from the log, asked once per configuration hash, stored on this Mac; `ready.path`/`timeoutSeconds`; 5,000-line ring buffer with cursors, level and search |
| §4.2 env secrets from the Keychain | DONE | `PreviewSecrets`: server secrets injected into that configuration's child only and scrubbed from its log; the pane's Secrets sheet shows names only |
| §4.3 `preview_server` | DONE | list, start, stop, restart, logs, attach |
| §4.3 `preview_browser` (~20 actions) | DONE | navigate, snapshot, find, text, click, hover, drag, type (with `secret`), key, select, scroll, scroll_to, wait_for, screenshot, zoom, resize (presets, dark mode), console, network (body by id), dialog, upload, eval, batch; legacy `wait`, `assert_text` |
| §4.3 effects per action, snapshot, real input, diagnostics | DONE | isolated world `juno-preview`, shadow roots and same-origin iframes, on-screen first, 300 refs, overlays; NSEvent input (JS only for `select`); console/fetch/XHR/WebSocket/resource diagnostics accepted only from preview-origin frames |
| §4.4 permissions table | DONE, one deviation, one gap | `eval` is `.destructive` (spec: `.critical`) so no saved tool-wide "Always allow" can silence page script that can reach any host. "Always for this preview, offered once per session" is not built; the standard Always-allow rule applies to non-floor input |
| Always-confirm floor in the Preview | DONE (beyond §4.4) | a seen send/delete/buy/sign-in control, accepting such a page question, or typing a credential is `.destructive`; clicks by coordinates, Enter and covering elements are checked when they run and refused unless approved so |
| §4.5 WebKit hardening | DONE | navigation policy, UI delegate (dialogs, same-origin popups in place, open panel only via `upload`), downloads cancelled, `file:`/`javascript:`/top-level `data:` refused, Keep sign-in per checkout with Clear site data |
| §4.6 autoVerify loop | DONE | trigger rules, settle and compile-error scan, `PreviewUIGate` (rule 8) with ≤ 3 rounds and the repeated-failure stop, evidence minted as the browser tool's `uiVerificationRecorded` side effect, `PreviewCheckRow` |
| §4.7 pane | DONE | one chrome (servers, back/forward, reload, address, device, appearance, log, Keep sign-in, Secrets, inspection scripts, annotate), state in words, no capsule or badges, agent glow + Stop (Esc), Simulator copy points to its pane. Visual redesign waits for the new design system |
| §5.15 annotate | PARTIAL | pick, note, cropped screenshot as an image attachment and the element details as composer text; not a structured `CodeAttachment` kind (Lane F owns that file) |
| `scripts/check-code-preview-wiring.mjs` | DONE | see commit `2afa69ec` |

#### Integration notes for the other lanes

- **Lane A**: `SessionController` now passes
  `completionGate: previewLease.completionGate(wrapping: ReportOnlyCompletionGate(), …)`
  for Code turns. Swap the base for `CompletionGate` and keep the wrapper, or
  call `PreviewSessionHub.shared.entry(…).verify.uiDecision(for:)` at rule 8.
  UI freshness is "at or after the last UI edit" (a later test-file edit does
  not stale UI evidence); the revision is one per `fileChanged`, counted by
  `PreviewVerifyState` from the store, until the run ledger lands.
- **Lane B**: UI records reach the transcript as the tool's side effect; when
  `VerificationLedger` lands it should absorb `uiVerificationRecorded`
  side effects (or the hub can call `recordUIVerification`).
- **Shared files touched, additively**: `CodeToolProvider.swift` (optional
  `shells`), `SessionController.swift` (three tool lines removed, `shells`
  passed, the gate wrapper), `WorkspaceContext.swift` (the preview sentence of
  the Code prompt), `CommandClassifier.swift` (the preview-server refusal names
  `preview_server` and exposes its marker), `DesktopCodeWorkspace.swift`,
  `DesktopCodePreviewDock.swift`.
- Test runs use throwaway ledger and settings files and never reap or signal
  the reader's processes.

#### Tests (new or rewritten)

`StaticPreviewServerTests` 12, `LaunchConfigurationTests` 12,
`PreviewServerLedgerTests` 5, `PreviewRegistryTests` 15,
`PreviewVerificationTests` 14 (runtime), `PreviewBrowserTests` 18 (offscreen
WebKit), `PreviewVerifyLoopTests` 4 (scripted model end to end),
`PreviewToolPermissionTests` 7, `PreviewSnapshotTests` 5 (rendered with
`JUNO_SNAPSHOT_DIR`, reviewed by eye: pane stopped and running, config card,
banners, check rows, annotate toolbar, light and dark; toolbar glyphs are
asset symbols SwiftPM does not compile, so they are blank in these PNGs only),
`CodePreviewHarnessTests` (preview-tool cases rewritten). The spike is kept as
`testTheOffscreenHostTakesSnapshotsAndTrustedInput`.

#### Gates (on `f051bfa1`, through `gate.sh`)

| Gate | Result |
|---|---|
| `npm run native:test JunoCode` | pass: 1,409 XCTests (18 skipped, snapshot tests among them), 78 Swift Testing, 0 failures (seams baseline 1,322 / 78) |
| `xcodebuild … -scheme JunoDesktop -configuration Debug CODE_SIGNING_ALLOWED=NO build` | BUILD SUCCEEDED (DerivedData `/private/tmp/juno-rf-dd-code-preview`) |
| `JUNO_SNAPSHOT_DIR=… JUNO_SWIFT_FILTER=PreviewSnapshotTests npm run native:test JunoCode` | 5 tests, 12 PNGs reviewed by eye |
| `node scripts/check-code-preview-wiring.mjs`, `check-code-runtime-wiring.mjs`, `check-tracked-secrets.mjs` | pass |
| `npm run typecheck`, `npm test` | not run: no TypeScript changed in this lane |

#### Risks

- The 1-pt background host is unverified in a real app session (the
  harness never reports a visible occlusion state); manual probe above.
- `wasApprovedAnywhere`: an approved start card covers the same bytes in
  every session of the same checkout for the rest of the app run.
- Floor words are a list (English plus French); a control named otherwise
  ("Nuke it") is input at `.execute`. Clicks by coordinates are resolved to
  their element and checked, never trusted.
- Merge points with Lanes A and B listed above (`SessionController` gate
  wrapper, UI records as side effects, `CommandClassifier` copy).
