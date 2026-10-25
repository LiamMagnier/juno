# Implementation ledger — 2026-10-25

This ledger is built from [AUDIT.md](./AUDIT.md) and
[COMPETITIVE_MATRIX.md](./COMPETITIVE_MATRIX.md). The baseline commits are HEAD
`a432a533` and origin/main `c1043052`.

**Priority:**
- **P0:** broken in production or on main, or blocks Phase 1.
- **P1:** highest-value gaps in durability, security or verification, or a
  competitive headline gap.
- **P2:** hygiene and lower-impact gaps.

**Effort:** S ≤ 1 day · M ≤ 1 week · L > 1 week.

**Status:** `in progress` · `ready` · `blocked (owner)` · `not started`.

## Summary

| ID | Item | Effort | Status |
|---|---|---|---|
| P0-1 | Model-sync validator failure and overdue retirements | S | in progress |
| P0-2 | Cloud Work/Orbit runs queue forever without an executor; per-agent execution target | M | in progress |
| P0-3 | `.env.example` agent-computer image and network values are wrong | S | in progress |
| P0-4 | Cloud Code blocked in production (sandbox image variable unset) | M | blocked (owner) |
| P1-1 | Cross-process Stop and single-instance state | L | ready |
| P1-2 | Real container sandbox boundary tests as a required check | M | ready |
| P1-3 | Account MCP in Code runtimes; consistent permissions; cancellable MCP open | M–L | ready |
| P1-4 | macOS app CI job exceeds its 40-minute timeout | S–M | ready |
| P1-5 | Playwright e2e in CI; land the QA harness (PR #99) | M | ready |
| P1-6 | Generated-UI parity with ChatGPT Intelligent UI (measured) | L | not started |
| P1-7 | Run the 30-workflow product benchmark | L | not started |
| P1-8 | Dependency and Actions-runtime backlog | M | ready |
| P2-1 | Local test gate matches CI | S | not started |
| P2-2 | Tests for side-by-side `/compare` | S | not started |
| P2-3 | Synthetic production voice round-trip | M | not started |
| P2-4 | Verify agent computers on the production VM | S | blocked (owner) |
| P2-5 | Work connector intent taxonomy | M | not started |
| P2-6 | Repo hygiene: stale PRs, design branch, dead deploy step, legacy ScheduledTask | S | not started |
| P2-7 | Provider resale terms and LICENSE | — | blocked (owner) |

---

## P0

### P0-1 — Model-sync validator failure and overdue retirements · S · in progress

- **Problem:** `validate:models` fails on main. Curated rows have passed their
  `retiresOn` date. Catalog tests that depend on the date fail as time passes,
  so main would be red in CI if re-run today.
- **Evidence:**
  - `sync-models.yml` has failed every day from 10-19 to 10-25. Run
    40179392467 shows `FAIL: google:gemini-3.1-flash-image: replacedBy without retiresOn`.
  - On origin/main, `src/lib/models.ts:754` has `replacedBy` and no `retiresOn`.
  - Seven curated rows are past `retiresOn` (2026-10-22/23): o1, gpt-4-turbo,
    gpt-3.5-turbo, gpt-image-1, and three veo-3.1 previews.
  - `tests/video-gen.test.ts:9` fails. `model-catalog-curated` fails.
- **Impact:** brings back the daily catalog/benchmark sync, removes a time bomb
  in CI, and stops serving retired models.
- **Dependencies:** none.
- **Files:** `src/lib/models.ts`, `scripts/validate-models.ts`,
  `scripts/model-sync/{apply,compare,report,types,lifecycle}.ts`,
  `tests/video-gen.test.ts`, `tests/model-catalog-curated.test.ts`.
- **Acceptance:**
  1. `npm run validate:models` exits 0 with no `FAIL` line.
  2. The next scheduled `sync-models` run is green.
  3. `video-gen` and `model-catalog-curated` pass.
  4. A unit test fails when any curated row's `retiresOn` is before "today" and
     the row is still curated, so CI catches this before the calendar does.

### P0-2 — Cloud Work/Orbit runs queue forever without an executor; per-agent execution target · M · in progress

- **Problem:** cloud availability is a constant, so runs are accepted for an
  executor that is not there. Agents cannot choose between Cloud and This Mac.
- **Evidence:** at HEAD, `CLOUD_WORK_AVAILABLE = true` appears in four places:
  - `src/lib/work/dispatch.ts:686`
  - `scripts/work-scheduler.ts:453`
  - `scripts/work-trigger-poller.ts:165`
  - **`src/app/api/work/protocol.ts:1062`**, which the in-progress diff does
    not touch. Include it.

  The uncommitted work so far: `src/lib/work/executor-{heartbeat,presence}.ts`
  and migration `20261025120000_agent_execution_target`.
- **Impact:** an honest refusal or a visible "waiting for executor" state
  instead of silent queueing. It also lets Orbit agents run on the person's Mac.
- **Dependencies:** none. P1-1 reuses the heartbeat.
- **Files:** the four files above, `src/lib/work/{store,domain,fire-now,relay}.ts`,
  `src/lib/agents/{domain,store,creation,goal-runner}.ts`,
  `prisma/schema.prisma`, `contracts/work/juno-work-v1.json` plus the
  generated Swift.
- **Acceptance:**
  1. With no executor heartbeat for more than N seconds, `selectTarget` reports
     cloud unavailable in dispatch, scheduler, trigger poller **and**
     protocol admission. A unit test injects a stale heartbeat.
  2. A cloud-required schedule gets a refusal or degraded event, not a queued
     run.
  3. An agent's execution target (cloud or mac) is persisted, round-trips
     through the API and contract, and dispatch respects it (test).
  4. `work:contract:check` and `capabilities:check` are green.

### P0-3 — `.env.example` agent-computer image and network values are wrong · S · in progress

- **Problem:** following the example disables agent computers, because the
  image is reported missing.
- **Evidence:**
  - `.env.example:522` has `AGENT_COMPUTER_IMAGE="juno-agent-computer:1"`.
  - `.env.example:524` has `AGENT_COMPUTER_NETWORK="juno-agent-net"`.
  - `src/lib/env.ts:216-233` defaults to `juno-computer:1` and
    `juno-computers`. `deploy/agent-computers/setup-vm.sh:11-12` builds and
    creates those same names.
- **Impact:** a correct self-host and production setup.
- **Dependencies:** none.
- **Files:** `.env.example`, a new test.
- **Acceptance:** the values match `setup-vm.sh`. A test parses `.env.example`
  and `setup-vm.sh` and asserts that the image tag and network name are equal.

### P0-4 — Cloud Code blocked in production (sandbox image variable unset) · M · blocked (owner)

The owner must publish the image and set the repo variable. The code part is
ready.

- **Problem:** every production-dispatched Cloud Code task fails within
  seconds.
- **Evidence:**
  - The last four `code-runner.yml` runs failed: 35641107898 (09-21),
    38301938431 (10-12), 38952920700 (10-16) and 39136937092 (10-18). Each
    shows `FATAL: Cloud Code runner: no container sandbox configured`.
  - `scripts/cloud-code-runner.mjs:1083-1089` is the fail-closed check.
  - `.github/workflows/code-runner.yml:60` reads `JUNO_RUNNER_SANDBOX_IMAGE`
    from `vars.JUNO_RUNNER_SANDBOX_IMAGE`, which is empty.
- **Impact:** brings back cloud Code, the competitive equivalent of Codex Cloud
  and Claude Code cloud sessions. Users currently see failures.
- **Dependencies:** a pinned sandbox image (by digest) in a registry the runner
  can pull. The owner sets the repo variable.
- **Files:** `.github/workflows/code-runner.yml`,
  `scripts/cloud-code-runner.mjs`, `src/lib/cloud-code.ts` (dispatch
  preflight), `src/lib/code-runs.ts`.
- **Acceptance:**
  1. A real dispatched task finishes green in `code-runner.yml`.
  2. Dispatch refuses before creating a run, with an honest message, when the
     server-side config says the cloud sandbox is not provisioned (unit test).
  3. The image is referenced by digest, not tag.

---

## P1

### P1-1 — Cross-process Stop and single-instance state · L · ready

- **Problem:** Stop and several kinds of runtime state live in process memory.
  With more than one backend process, or across a restart, Stop silently does
  nothing and results are lost.
- **Evidence:**
  - `src/lib/generation-cancel.ts:14-23`: an in-memory map; the comment says
    "with a second [instance] … silently returns `cancelled: false`".
  - `src/lib/chat/turn/durable-receipt.ts:65-80`: the durable `cancelRequestedAt`
    poll runs only for receipt-backed turns.
  - `src/lib/chat/local-folder-bridge.ts:5`: in memory "on purpose". PR #85
    fixes it, but it is a draft stacked on #84 and #83.
  - `src/lib/code-v2/env-link-hub.ts:27-30`: queued commands and RPC receipts
    are lost on restart. The Postgres store is opt-in
    (`env-link-select.ts`, `ALEVR_LINK_STORE`) and not in `.env.example`.
  - `docs/OPEN_DECISIONS.md` §"known scaling limit".
- **Impact:** a durable-execution baseline. It allows zero-downtime restarts
  and a second instance, and means the Stop button always works.
- **Dependencies:** rebase and land the stack #83 → #84 → #85.
- **Files:** `src/lib/generation-cancel.ts`, `src/lib/chat/turn/{durable-receipt,accept,admission}.ts`,
  `src/app/api/chat/cancel/route.ts`, `src/lib/chat/local-folder-bridge.ts`,
  `src/lib/code-v2/env-link-select.ts`, `.env.example`, `prisma/schema.prisma`.
- **Acceptance:**
  1. An integration test with two Node processes against a real DB: Stop sent
     to process B cancels a turn streaming in process A within 3 s. Cover a
     turn without a first-submission receipt.
  2. The local-tool result survives a backend restart (PR #85 tests in CI).
  3. `ALEVR_LINK_STORE` is documented, and the Postgres hub suite runs in CI.
  4. A lint/test fails when new `globalThis` or module-level `Map` state
     appears in `src/lib/**` server code outside an allowlist.

### P1-2 — Real container sandbox boundary tests as a required check · M · ready

- **Problem:** the execution sandbox has never been tested against a real
  container on main.
- **Evidence:**
  - `tests/test_exec_host.py:6,59` replaces `docker run` with a fake.
  - PR #88's `boundary` job passed (run 38162761079), but #88 is a draft based
    on #87.
  - The agent-computer egress code (`deploy/agent-computers/egress-proxy.py`,
    `firewall.sh`) has no real-container negative test.
- **Impact:** evidence for the main safety claim: model-authored code cannot
  reach metadata or private networks, and cannot see secrets.
- **Dependencies:** a Docker-capable CI runner, which `ubuntu-latest` provides.
- **Files:** `deploy/exec-host/*`, `deploy/agent-computers/*`, a new CI job in
  `deploy.yml`, PR #88's test file.
- **Acceptance:** a required CI job on main builds the pinned exec image and
  asserts:
  1. ENETUNREACH or refusal for 169.254.169.254 and RFC1918 addresses.
  2. No provider or database environment variable names inside the container.
  3. A read-only root and a non-root UID.
  4. Cancel kills the container before a delayed write.
  5. The same checks for an agent-computer container behind the egress proxy.

### P1-3 — Account MCP in Code runtimes; consistent permissions; cancellable MCP open · M–L · ready

- **Problem:** account MCP tools reach Chat and Work but not Code. Permission
  decisions are made in three places. Opening MCP cannot be cancelled.
- **Evidence:**
  - PR #97: all checks green on its head, but `mergeable_state: dirty`.
  - The three enforcement points: the chat broker
    (`src/lib/action-approval-store.ts`, `src/lib/mcp.ts`), Code
    (`runner/agent-core/src/permission-rules.ts`) and Work
    (`runner/agent-core/src/work/tools.ts`). They are tied together only by the
    taxonomy projection (`src/lib/permissions/taxonomy.ts`) and
    `tests/permission-conformance.test.ts`.
  - `scripts/work-runner.ts:3488`: "`openMcpToolset` takes no signal".
- **Impact:** competitive parity with Claude Code and Codex plugins, and one
  permission story across surfaces.
- **Dependencies:** none. Rebase onto current main.
- **Files:** PR #97's 25 files, `scripts/work-runner.ts`, `src/lib/mcp.ts`,
  `tests/permission-conformance.test.ts`.
- **Acceptance:**
  1. #97 is merged with green CI.
  2. The conformance matrix gains MCP-tool cases run through the Code broker:
     the same tool and arguments give the same tier and decision in chat, Work
     and Code.
  3. `openMcpToolset(signal)`: a cancelled run closes its MCP sockets within 2 s
     (test).
  4. A disabled or removed server is refused on the next Code call (test).

### P1-4 — macOS app CI job exceeds its 40-minute timeout · S–M · ready

- **Problem:** macOS app unit tests did not run on main.
- **Evidence:**
  - `native.yml:360` sets `timeout-minutes: 40`.
  - In run 39143961783 the Debug build took 7m28s and the Stable build 30m42s,
    then "Unit tests" was cancelled.
  - PR run 39143955698 passed at 37m38s.
- **Impact:** native regressions surface on main instead of in production.
- **Dependencies:** none.
- **Files:** `.github/workflows/native.yml`.
- **Acceptance:** the Stable build is split into its own job, or DerivedData is
  cached. The macOS unit tests finish on 5 consecutive main pushes, with at
  least 10 minutes of headroom.

### P1-5 — Playwright e2e in CI; land the QA harness (PR #99) · M · ready

- **Problem:** no end-to-end browser journey runs in CI.
- **Evidence:**
  - No workflow references Playwright.
  - `e2e/*.spec.ts` holds 13 specs, plus `wave2/`.
  - PR #99 is `dirty`. Its "Base gate" failed because main CI was not green,
    "Web gates (production build)" failed, and the CodeQL check failed.
- **Impact:** catches UI and streaming regressions. It also measures the
  "feels better" gap against competitors.
- **Dependencies:** P1-4. The base gate needs green main CI.
- **Files:** `playwright.config.ts`, `e2e/**`, PR #99's files.
- **Acceptance:**
  1. A PR job runs the deterministic journey (`JUNO_E2E_SMOKE_PROVIDER=1`,
     disposable DB) covering chat streaming, Stop, regenerate, artifacts and
     MCP add.
  2. #99 is rebased with all its checks green, including CodeQL.

### P1-6 — Generated-UI parity with ChatGPT Intelligent UI (measured) · L · not started

- **Problem:** ChatGPT shipped Intelligent UI to every tier on 10-07: it picks a
  layout, renders progressively and builds tools on the fly. Juno's Live UI
  exists, but its quality and selection rate are not measured, and the newest
  views are unmerged.
- **Evidence:**
  - Matrix row "Interactive generated UI".
  - `src/lib/live-ui/spec.ts`, `src/components/chat/live-ui/live-ui-intelligent.tsx`,
    which is only on `claude/premium-design-pass`.
  - Live UI has no browser test.
- **Impact:** closes the headline competitive gap.
- **Dependencies:** P1-5 for the browser harness, and a decision on the design
  branch (P2-6).
- **Files:** `src/lib/live-ui/*`, `src/lib/live-blueprint.ts`,
  `src/lib/auto-model.ts`, `src/components/chat/live-ui/*`,
  `contracts/live-ui/fixtures/*`.
- **Acceptance:**
  1. A browser test streams a Live UI spec and asserts that the first component
     paints before the stream ends.
  2. Swift fixture parity passes.
  3. An eval set of at least 50 prompts with expected answers ("UI or text")
     records Auto's selection precision and recall in CI.
  4. The design branch is merged or explicitly parked.

### P1-7 — Run the 30-workflow product benchmark · L · not started

- **Problem:** there is no head-to-head evidence. PR #87's harness records 0 of
  210 runs.
- **Evidence:** PR #87 body: "A generated 210-row matrix contains only
  `not_run` rows".
- **Impact:** a real Phase 0 product baseline instead of claims from code.
- **Dependencies:** #87 merged, and a funded test account.
- **Files:** PR #87's files, `docs/quality/WORKFLOW_BENCHMARK.md` (in PR).
- **Acceptance:** at least 30 Alevr runs are recorded with artifacts and
  independent review, plus at least one competitor column per category. Report
  the first-attempt success rate.

### P1-8 — Dependency and Actions-runtime backlog · M · ready

- **Problem:** about 25 Dependabot PRs are open, and every run warns that the
  Actions Node 20 runtime is deprecated.
- **Evidence:**
  - #74 (Next.js, CI green), #77 (jose), #93 (@anthropic-ai/sdk 0.107 to
    0.133), #71 and #67 (runner: openai 7, TypeScript 7), #63, #64 and #66
    (Actions v7).
  - #72 failed both Deploy to VM and native.
- **Impact:** security patches, and new provider SDK features such as current
  Claude and OpenAI API surfaces.
- **Dependencies:** green main CI.
- **Files:** `package.json`, `runner/agent-core/package.json`,
  `.github/workflows/*`.
- **Acceptance:** the Next.js and jose bumps are merged with green CI. No
  "Node.js 20 is deprecated" warning in the deploy or native runs. The SDK
  bump either passes `model-effort-wire` or has a written reason to defer.

---

## P2

| ID | Problem | Evidence | Files | Acceptance | Effort | Status |
|---|---|---|---|---|---|---|
| P2-1 | The local full suite differs from CI: 11 failures from the missing runner build, `ws` absent, RuleTester timing. | AUDIT §1 | `package.json` (add a `test:prepare` script), `tests/wave2-p1-lint.test.ts` | `npm run test:prepare && npm test` gives the same pass/fail as the CI shards on a clean clone. | S | not started |
| P2-2 | Side-by-side `/compare` has no tests. | No test imports `use-compare` | `src/components/compare/use-compare.ts` | Unit tests cover pane status transitions, abort per pane, error mapping and cost computation. | S | not started |
| P2-3 | Voice is production-checked only up to token issuance. | `scripts/production-smoke.mjs` (`/api/voice/relay-token`) | `scripts/production-smoke.mjs`, `relay/src/providers/mock.ts` | A flagged smoke opens a relay session, sends an audio fixture and receives a transcript and a reply event. | M | not started |
| P2-4 | Agent computers are off by default; production status unknown. | `.env.example:521` `AGENT_COMPUTER_PROVIDER=""` | `deploy/agent-computers/*`, `scripts/dev/computer-smoke.ts` | `computer-smoke` passes on the VM, and the result is recorded with date and SHA. | S | blocked (owner) |
| P2-5 | Work has no connector intent taxonomy. | `runner/agent-core/src/work/tools.ts:1455-1468` | the same file, `src/lib/permissions/taxonomy.ts` | Connector tools map to shared intents. A Work plan prefers a connector over browser automation for the same intent (test). | M | not started |
| P2-6 | Repo hygiene. 17 stale PRs from Jul–Sep (#1, #9, #17–#25, #43–#56). Design branch `claude/premium-design-pass` has no PR. A disabled step (`deploy.yml:877`, `if: false`) lists retired PM2 apps (`deploy.yml:1033`). Legacy ScheduledTask read side remains (`src/lib/scheduled-tasks.ts`). | AUDIT §3 and §4 (row 21) | the listed files | Stale PRs are closed or rebased. The design branch has a PR. The dead step is removed. A dated removal plan exists for `/api/tasks`. | S | not started |
| P2-7 | Provider resale terms and repository license are unresolved. | `docs/OPEN_DECISIONS.md` §5, §6 | `LICENSE`, `docs/SUBPROCESSORS.md` | The owner records a decision. | — | blocked (owner) |

## Recommended next slices, after the in-progress P0s

1. **P0-4:** unblock Cloud Code. Pin the image, set the variable, add a
   dispatch preflight.
2. **P1-1:** cross-process Stop and single-instance state. Land #83 → #85, add
   a cancel row or LISTEN/NOTIFY, add the two-process test.
3. **P1-2:** real container boundary tests as a required check (#88), extended
   to agent-computer egress.
4. **P1-3:** rebase and merge #97. Add MCP rows to the permission conformance
   matrix. Make `openMcpToolset` cancellable.
5. **P1-4 + P1-5:** make CI truthful. Fix the macOS timeout, then run
   Playwright e2e in CI (#99).
