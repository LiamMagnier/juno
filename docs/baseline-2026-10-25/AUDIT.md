# Capability audit — 2026-10-25

Phase 0 baseline of Juno (public name Alevr) against the master brief's
capability areas. **Each area gets exactly one status.** Nothing is marked
verified without evidence that names a run, a test or a check.

## 0. Snapshot

| Item | Value |
|---|---|
| `git rev-parse HEAD` | `a432a533d2d5aec37d0db3fcf125e4c6399ad95a` on branch `claude/premium-design-pass`. Pushed to origin, **no open PR**. 3 commits ahead of main (72 files, +3638/−788): Live UI "intelligent views" and design pass. |
| `git rev-parse origin/main` | `c1043052f4e82baf79383f4e630c411ab9f5aae3` ("unclean-exit sentinel… (REA 7) (#103)", 2026-10-18) |
| Last production deploy | Deploy-to-VM run [39143961786](https://github.com/LiamMagnier/juno/actions/runs/39143961786) on `c1043052`. Every step green, including "Verify production health", "Verify public production health externally" and "Run authenticated production smoke". |
| Working tree | Dirty while this audit was written: a parallel session is editing the in-progress P0s (Work dispatch, model sync, agent execution target). **The audit describes HEAD and origin/main, not those uncommitted edits.** |

**Status legend:**
- **Production verified**: an automated check exercised it against production
  on a commit that is deployed now.
- **Implemented and tested**: the code exists and named automated tests (unit,
  integration or CI) cover it.
- **Implemented but unverified**: the code exists, but no automated test covers
  its main behaviour.
- **Partial**: a material part of the area is missing or broken.
- **Missing**: no implementation.
- **Blocked**: implemented, but cannot run in production for an external or
  configuration reason.
- **Deprecated-redundant**: retired or superseded code that is still present.

## 1. Local test baseline (this session)

Run: `npx tsx --test tests/*.test.ts` on HEAD.

| Total | Pass | Fail | Skipped |
|---|---|---|---|
| 7823 | 7590 | 34 | 172 |

The same failures appear on a clean checkout of origin/main. They split into
four groups.

**Not built or installed in this sandbox (CI builds or installs them; CI passed
these shards on `c1043052`):**

| Test | Failures | Cause |
|---|---|---|
| `agent-computer-takeover` | 5 | `Cannot find module runner/agent-core/dist/work/index.js`. CI runs "Build the vendored runner core" first. |
| `agent-computer` | 3 | Same cause. |
| `computer-takeover-hardening` | 3 | Same cause. |
| `code-v2-env-link` | 1 | `Cannot find module 'ws'`. It is imported by `runner/env-server/src/server.ts:20`, and `ws` is not a root dependency. |

**Harness or timing:**

| Test | Failures | Cause |
|---|---|---|
| `wave2-p1-lint` | 16 | Eight rules fail with "test did not finish before its parent and was cancelled" (ESLint RuleTester under `node:test`). |

**Date-dependent (main would now fail CI if re-run):**

| Test | Failures | Cause |
|---|---|---|
| `video-gen` | 1 | `google:veo-3.1-lite-generate-preview` passed its `retiresOn` (2026-10-22). It now migrates to an Omni model, so `isGoogleOmniModel(veoLite)` returns true. |
| `model-catalog-curated` | 1 | "`loadAvailableModels is not a function`" in a child process. Root cause not isolated. It fails on clean main too and sits in the same overdue-retirement window. |

**Timing-flaky under load:** `local-folder-tools` and `tool-dispatch-adversarial`.

**Takeaway:** the local full suite is not a faithful gate. It needs the runner
build and env-server dependencies, which CI provides. The two date-dependent
tests are a real regression of main that only time exposes.

## 2. CI and workflow runs (GitHub Actions, read 2026-10-25)

| Workflow | Recent result | Evidence |
|---|---|---|
| **Deploy to VM** (`deploy.yml`): typecheck, lint, 4 unit shards, migrations plus real-DB integration steps, runner tests, deploy and production smoke | **Green on main `c1043052`** | Run 39143961786 (2026-10-18) |
| **Sync model benchmarks and radar** (`sync-models.yml`, daily) | **Failing 7 days in a row**, 10-19 → 10-25 | Run 40179392467 log: `FAIL: google:gemini-3.1-flash-image: replacedBy without retiresOn`. minimax/moonshot pricing pages also unparseable. |
| **native** (`native.yml`) on main | Last main run **cancelled**. The `macOS app` job hit `timeout-minutes: 40` after Debug (7m28s) + Stable (30m42s) builds, so **macOS unit tests did not run**. iOS app and all four Swift package jobs passed. | Run 39143961783. The PR #103 run 39143955698 passed with the macOS job at 37m38s, right at the limit. |
| **CodeQL** | Green on main (scheduled 10-19, push 10-18) | Run 39234997951 |
| **Juno Code cloud runner** (`code-runner.yml`, dispatched by production) | **Last 4 real tasks failed**: 2026-09-21, 10-12, 10-16, 10-18. Last success was 2026-08-10. | Runs 35641107898 and 39136937092: `FATAL: Cloud Code runner: no container sandbox configured; refusing to run agent-authored commands on the runner host`. `JUNO_RUNNER_SANDBOX_IMAGE: ` is empty because repo variable `vars.JUNO_RUNNER_SANDBOX_IMAGE` is unset (`.github/workflows/code-runner.yml:60`). |
| **macOS production release** (`release-macos.yml`) | Last runs failed or cancelled (latest 2026-09-01). Mac releases appear to ship through local scripts (commit "Alevr for Mac 1.12.2"). | Run 33553776443 |
| Playwright e2e | **Not run by any workflow.** No workflow file references Playwright. PR #99 would add it. | `grep playwright .github/workflows/*` → none |
| Every run | Warns "Node.js 20 is deprecated" for actions `checkout@v4`, `setup-node@v4` and `upload-artifact@v4`. Bumps are open in PRs #63, #64 and #66. | Job logs |

## 3. Open PRs (read 2026-10-25)

| PR | Title | Base / state | CI |
|---|---|---|---|
| **#99** | Safe production QA and cross-platform design gate harness | main · open · **mergeable_state `dirty`** (conflicts) · +8881/−86 | **Failing.** "Base gate" failed because main CI was not green at `92f676df` (macOS `in_progress`). "Web gates (production build)" failed. The "CodeQL" check failed, although the Analyze job passed, which suggests new alerts. Native Release gates passed. Unit shards passed. |
| **#97** | Broker account MCP tools into Code runtimes; review project hooks by hash | main · open · **`dirty`** · +1045/−27 | All checks green on its head `944b96de` (10-17): unit shards, migrations, CodeQL. Needs a rebase. |
| **#88** | Require real execution sandbox boundary checks | `codex/alevr-workflow-benchmark` · **draft** · `unstable` | New `boundary` job passed (run 38162761079). The stack's other runs were cancelled or superseded. |
| **#87** | Benchmark thirty product workflows | `codex/alevr-development-evidence` · draft · `unstable` | Unit and migration checks green. Records 0 real benchmark runs (210 rows, all `not_run`). |
| **#85** | Persist encrypted local-tool results across backend restarts | `codex/alevr-folder-containment` (#84) · draft · `unstable` | Unit and migration checks green. Stacked on #84 → #83. |
| #86, #84, #83 | Dev-evidence, folder containment, strict native builds | Stacked drafts (10-11) | Same stack. |
| Dependabot (about 25) | Includes #74 Next.js group (CI green), #77 jose, #93 @anthropic-ai/sdk 0.107→0.133, #71 openai 7.x in the runner, #67 TypeScript 7 in the runner, and Actions v7 bumps | main | #72 dev-deps failed "Deploy to VM" and "native"; #74 green. |
| Stale (Jul–Sep) | #1, #9, #17–#20, #22, #24, #25, #43–#45, #50–#56 | Various | Not re-run. #24 ("stop PR runs cancelling deploys") and #25 (Node 20 runtime) look relevant. |

## 4. Capability areas

Abbreviations: **T** = test files under `tests/` unless another path is given;
**CI** = a named step in `deploy.yml`.

| # | Area | Status | Key files | Evidence | Gaps / notes |
|---|---|---|---|---|---|
| 1 | **Chat streaming** (SSE, durable receipts, Stop, reconnect) | **Production verified** (origin/main `c1043052`) | `src/lib/chat-stream.ts`, `src/lib/chat/turn/*` (`run-stream.ts`, `durable-receipt.ts`, `accept.ts`), `src/lib/chat/stream-pacer.ts`, `src/lib/chat/follow-machine.ts`, `src/lib/net/tether.ts`, `src/lib/generation-cancel.ts` | Authenticated production smoke (`scripts/production-smoke.mjs`) in run 39143961786. It checks SSE reaches a terminal frame, `/api/chat/receipt` becomes `completed`, and an idempotent replay returns the same message. CI "Chat admission, routing, Stop and reconnect, against a real database". T: `chat-sse`, `chat-stream-resume`, `chat-turn-reliability`, `chat-terminal-state`, `chat-first-submission`, and 42 `chat-*` files in total. | **Stop is per-process** (`generation-cancel.ts:14-23`). The durable cancel poll covers only receipt-backed turns (`durable-receipt.ts:65-80`). HEAD's 3 design commits are not deployed. |
| 2 | **Auto routing** | Implemented and tested | `src/lib/auto-model.ts`, `src/lib/router/{decide,task-class,chat-context,provider-pressure,receipt,image-route}.ts` | T: `auto-model`, `auto-model-cheapest`, `router-decide`, `router-chat-context(.integration)`, `router-telemetry.integration`, `provider-routing`, `model-effort-wire`. CI "Auto context ownership and sizing" (real DB). | Production smoke pins a named model, not Auto. Provider pressure and health are in memory (`router/provider-pressure.ts:9`). |
| 3a | **Model comparison: side-by-side `/compare`** | Implemented but unverified | `src/app/(app)/compare/page.tsx`, `src/components/compare/{use-compare.ts,compare-view.tsx,compare-pane.tsx}` (parallel private `/api/chat` streams) | No test imports `use-compare` or `compare-view`. | Add pane state-machine and abort tests. |
| 3b | **Model comparison: public `/vs` pages** | Implemented and tested | `src/lib/compare/model-pairs.ts`, `src/app/vs/**` | T: `compare-pages` | Figures come from the catalog, pricing and benchmarks files. |
| 4 | **Live UI** (generated interactive answers) | Implemented and tested | `src/lib/live-ui/{spec,fence,expr,summary,legacy/*}.ts`, `src/lib/live-blueprint.ts`, `src/components/chat/live-ui/*`. Swift twin `JunoLiveUISpec.swift`, contract `contracts/live-ui/fixtures/*.json`. | T: `live-ui`, `live-ui-prompt`, `live-ui-legacy`, `live-ui-legacy-parser`, `live-blueprint`, and `live-ui-intelligent` (HEAD branch only). | No browser test of progressive rendering. No eval of when Auto chooses Live UI. Intelligent views are unmerged. |
| 5 | **Voice** (realtime relay, STT, TTS) | Implemented and tested | `relay/src/{server,session,protocol,voice-context,computer-view}.ts`, `relay/src/providers/{openai-realtime,gpt-live,gemini-live,gemini-delegate,minimax-composed,openai-voice}.ts`, `src/lib/voice-*.ts`, `src/lib/{stt,tts}.ts`, `src/components/voice/realtime-voice.tsx` | `relay/tests/*.test.ts` (11 files, run by CI through `scripts/local-gates.sh`). T: 12 `voice-*` files plus `realtime-voice-activity`, `tts-gemini`, `code-voice-auto-send`. Production smoke only checks `/api/voice/relay-token`. PM2 runs `juno-voice-relay`. | Historical, not re-checked: `docs/product-completion/status.json` records a Mac-hardware anti-loop check on 2026-08-21. No automated production audio round-trip. |
| 6 | **Research** (deep research) | Implemented and tested | `src/lib/research/*` (58 files: planner, engine, lease, claims, gap-audit, export), `src/lib/deep-research.ts`, `scripts/research-worker.ts`. Adopted by `juno-sweepers`. | T: 43 `research*` files. CI "The research inspector, against a real database". | Historical: status.json marks `research-durable` "verified" (2026-08-21, named tests, not production). |
| 7 | **Knowledge ingestion and retrieval** | Implemented and tested | `src/lib/knowledge/{ingest,chunk,embed,retrieve,rank,ocr,lexical-query,read-on-demand}.ts`, `src/lib/knowledge/extract/*` | T: `knowledge-extract`, `knowledge-ocr`, `knowledge-retrieve`, `retrieval-security`, `alevr-search-retrieve`, `document-reading` | status.json: slice `knowledge-ingestion` "implemented" (6 of 11 acceptance items not verified, 2026-08-21). |
| 8 | **Documents / spreadsheets / slides** | Implemented and tested | `src/lib/office-export.ts`, `src/lib/office-export-verify.ts`, `src/lib/work/deliverables/{document,presentation,spreadsheet,report,site,validate}.ts`, `src/lib/documents/reader*.ts` | T: `artifact-export-verification`, `work-deliverables`, `work-spreadsheet-preview`, `work-report-preview`, `semantic-document(-interactive)`, `document-viewer` | No round-trip open test in a real Office or Docs client. |
| 9 | **Artifacts** | Implemented and tested | `src/lib/artifact*.ts` (26 modules), `src/lib/artifacts-store.ts`, `src/lib/chat-artifact-verification.ts` | CI "The artifact lifecycle, against a real database". T: 18 `artifact*` files. e2e `projects-and-artifacts.spec.ts`, not in CI. | — |
| 10a | **Code: Mac and local** (agent-core, env-server, native JunoCode, device link) | Implemented and tested | `runner/agent-core/src/*`, `runner/env-server/src/*`, `src/lib/code-v2/*` (60 files), `native/Packages/JunoCode` | CI "runner" job: agent-core suite "including the adversarial containment suite" (42 test files under `runner/agent-core/src/test`). CI "Code link backend parity, against a real database". Swift JunoCode package tests green (run 39143961783). T: 61 `code-*` files. | Device-link hub is in memory by default. Queued commands and RPC receipts are lost on restart (`code-v2/env-link-hub.ts:28`). The Postgres store is opt-in through `ALEVR_LINK_STORE=postgres`, which `.env.example` does not document. |
| 10b | **Code: Cloud** (GitHub Actions runner) | **Blocked** | `scripts/cloud-code-runner.mjs:1083-1089`, `.github/workflows/code-runner.yml:60,94`, `src/lib/cloud-code.ts` | 4 consecutive production-dispatched runs failed closed on the missing sandbox image (§2). | The fail-closed behaviour is correct. The fix is ops: a pinned image plus the repo variable. A dispatch preflight should refuse honestly. |
| 11 | **Work** (cloud executor, schedules, triggers, approvals) | Partial | `src/lib/work/*` (75 files: `dispatch.ts`, `store.ts`, `broker.ts`, `approvals.ts`, `connectors.ts`), `scripts/work-runner.ts`, `scripts/work-scheduler.ts`, `scripts/work-trigger-poller.ts`, `scripts/sweepers.ts`, `deploy/ecosystem.config.js` (`juno-work`, `juno-sweepers`) | CI "The Work store's concurrency claims", "The relay's dispatch claims", "The cloud Work toolset admits no host tool", "Work contract is not stale". T: 58 `work-*` files. Cancel is durable: `work-runner.ts:4219-4245` polls `workRun.status`. | **P0, in progress:** `CLOUD_WORK_AVAILABLE = true` is hard-coded at HEAD in `src/lib/work/dispatch.ts:686`, `scripts/work-scheduler.ts:453`, `scripts/work-trigger-poller.ts:165` and **also `src/app/api/work/protocol.ts:1062`**, so cloud runs queue with no executor. `openMcpToolset` takes no AbortSignal (`work-runner.ts:3488`). |
| 11b | **Orbit agents** (persistent agents) | Partial | `src/lib/agents/{store,goal-runner,goals,reflect,team,rooms}.ts`, `scripts/agent-reflector.ts` | T: 24 `agent(s)-*` files (some `.integration`). e2e `agents.spec.ts`, not in CI. | **P0, in progress:** per-agent execution target, Cloud or This Mac (migration `20261025120000_agent_execution_target`, uncommitted). Agent runs inherit Work's cloud-queue bug. |
| 11c | **Agent computers** (Docker desktop per agent) | Implemented but unverified | `src/lib/computer/{docker,provider,takeover,sweep,live-view}.ts`, `deploy/agent-computers/{Dockerfile,setup-vm.sh,egress-proxy.py,firewall.sh,docker-broker.py}` | T: `agent-computer*` (needs the runner build), `computer-takeover-hardening`. CI "Agent computer sweep writes" (real DB). Python `tests/test_computer_infrastructure.py`. | Off by default (`AGENT_COMPUTER_PROVIDER=""`). Production status unknown. **P0, in progress:** `.env.example:522,524` uses `juno-agent-computer:1` / `juno-agent-net`, while `src/lib/env.ts:220-233` and `setup-vm.sh:11-12` use `juno-computer:1` / `juno-computers`. |
| 12 | **Connectors / MCP / skills** | Implemented and tested | `src/lib/mcp.ts`, `src/lib/user-mcp.ts`, `src/lib/mcp-{oauth,safe-fetch,config-store,probe}.ts`, `src/lib/custom-connectors.ts`, `src/lib/composio.ts`, `src/lib/first-party-connectors/*`, `src/lib/connectors/{google-drive,microsoft-365}.ts`, `src/lib/skills/*`, `src/lib/action-approval{,-store}.ts`, `src/lib/permissions/taxonomy.ts` | CI "First-party connector sync, ownership and rotating refresh tokens", "Unified MCP config migration and credential isolation", `scripts/check-approval-dispatch.mjs`, `test:custom-mcp`, `test:skill-package`. T: `mcp-ssrf`, `first-party-mcp-approval`, `action-approval-enforcement`, `permission-conformance`, `skill-*`, `work-skill-trust`. | Account MCP tools are **not available in Code runtimes** (PR #97, conflicting). Three enforcement points (chat broker, `runner/agent-core/src/permission-rules.ts`, Work taxonomy) are tied together only by a projection plus a conformance test. No connector intent taxonomy (`runner/agent-core/src/work/tools.ts:1455-1468`). |
| 13 | **Memory** | Implemented and tested | `src/lib/memory*.ts` (18 modules), `src/lib/recall/*`, `src/lib/procedural-memory*.ts`, `scripts/memory-dreamer.ts` | T: 24 files (`memory-*`, `recall-index-*`, `procedural-memory*`, including DB-backed ones). `test:memory:db` script. | status.json `memory-v2` "implemented" (3 of 7 items not verified, historical). |
| 14 | **Native macOS / iOS** | Implemented and tested | `native/macOS/JunoDesktop`, `native/iOS/JunoMobile`, `native/Packages/{JunoNativeKit,JunoCode,JunoWork,JunoScreenControl}`; contracts under `contracts/` | `native.yml`: Swift packages (4/4) and iOS app (build plus unit tests) green on `c1043052`. Web↔native contract and parity jobs green. | **macOS app unit tests did not run on main** (40-min timeout, §2). Physical-device and TestFlight acceptance is recorded as blocked in status.json (historical). |
| 15 | **Billing / quotas / spend** | Implemented and tested | `src/lib/billing/*`, `src/lib/{stripe,credits,plans,usage,spend,spend-ceiling,budgets,platform-budget}.ts`, `src/lib/metering/*` | T: `stripe-plan-transitions`, `stripe-webhook-plan-mapping`, `app-store-billing`, `usage-credits`, `spend-ceiling`, `usage-metering-*`, `code-turn-metering-db`, `work-run-budget`. CI "Images in chat through the shared media meter". | No automated live Stripe or App Store check. `platform-budget` and unit-price day counters are per-process (`metering/unit-prices.ts:183`). |
| 16 | **Security / sandbox** | Partial | `src/lib/sandbox*`, `src/lib/exec/*`, `deploy/exec-host/*`, `deploy/agent-computers/*`, `src/lib/{csrf,csp,trust-boundary,untrusted-content,mcp-safe-fetch,field-crypto,message-crypto}.ts`, `scripts/security-check.mjs` | CodeQL green. CI `security:check`, `check-approval-dispatch`, Python `test_exec_host.py` / `test_computer_infrastructure.py`, `work:sandbox:check`, runner adversarial containment suite. | **The real container boundary is not tested on main.** `tests/test_exec_host.py` replaces `docker run` with a fake (lines 6, 59). PR #88's real-Docker `boundary` job is an unmerged draft. Agent-computer egress (`egress-proxy.py`, `firewall.sh`) has no real-container negative test. |
| 17 | **Image / video generation** | Implemented and tested | `src/lib/media/{generation-pipeline,image-generation}.ts`, `src/lib/{image-gen,video-gen,video-gen-core}.ts`, `src/lib/chat/image-tool.ts` | CI "Images in chat through the shared media meter". T: `chat-image-*`, `video-gen` (date-failing, §1). | Catalog retirements on 10-22 affect Veo previews. |
| 18 | **Model catalog and sync** | Partial | `src/lib/models.ts`, `scripts/validate-models.ts`, `scripts/model-sync/*`, `.github/workflows/sync-models.yml` | `validate:models` FAILs on origin/main (§2). Seven curated rows are past `retiresOn` (2026-10-22/23): o1, gpt-4-turbo, gpt-3.5-turbo, gpt-image-1, veo-3.1 preview ×3. | **P0, in progress.** |
| 19 | **CI** | Partial | `.github/workflows/*.yml`, `scripts/local-gates.sh`, `scripts/release-gates.sh` | Deploy pipeline green, with real-DB integration and production smoke (§2). | Daily sync red. macOS timeout. No e2e. Node 20 action runtime warnings. A disabled step (`deploy.yml:877`, `if: ${{ false }}`) still lists retired PM2 apps (`deploy.yml:1033`). |
| 20 | **Tests / e2e** | Partial | `tests/` (725 `*.test.ts` files), `tests/integration/*`, `e2e/*.spec.ts` (13 plus `wave2/`), `playwright.config.ts` | Unit suite: 7823 tests locally. CI shards green on main. | e2e is not in CI. The local suite diverges from CI (§1). Date-dependent tests. |
| 21 | **Legacy ScheduledTask** (`/api/tasks`, `src/lib/scheduled-tasks.ts`) | Deprecated-redundant | `src/lib/scheduled-tasks.ts`, `src/app/api/tasks/**` | The file header says the feature is retired and its rows are adopted into `WorkSchedule` by `work-scheduler.ts`. | Only the read side remains. Remove once clients stop listing it. |

## 5. Docs that claim verification (historical evidence only)

| Doc | What it claims | How this audit treats it |
|---|---|---|
| `docs/product-completion/status.json` | Audit commit `3fff6385` (2026-08-21): 2258 tests passed; exact-SHA native and deploy runs; "authenticated production Qwen smoke" | Historical. That commit is about 2 months and hundreds of commits old. |
| `docs/production/JUNO_COMPETITIVE_PARITY_2026-08-27.md` | Competitor patterns as of August | Superseded by `COMPETITIVE_MATRIX.md`. |
| `docs/production/JUNO_CODE_PRODUCTION_PASS_2026-08-27.md` | Code production pass | Historical. Cloud Code has failed in production since 2026-09-21 (§2). |
| `docs/release/JUNO_1_2_PRODUCTION_ACCEPTANCE.md`, `JUNO_PHASE_2_*` | Phase 2 acceptance | Historical. |
| `docs/OPEN_DECISIONS.md` § "known scaling limit" | Per-process cancel and caches; one PM2 instance | **Current.** Confirmed in code (§4, row 1). |
