# Orchestration, observability and reliability of the chat turn

2026-10-04 · Branch `rework/route` · BRIEF §3.1, §47 and §48, applied to the chat turn pipeline and the research engine. Canonical maturity stays in `src/lib/capabilities.ts`. This file does not record status. It covers what changed, why, and how to check it.

## Decision (written before coding)

- Refactor incrementally and **characterise first**. One DB-backed suite drives the real `POST /api/chat` with only the session, provider config, `after()` and the model replaced. It must pass before and after every move.
- Move code verbatim into stage modules. Behaviour changes only where a test demonstrates a bug.
- Each stage returns either its resolution or the `Response` that ends the request (`StageResult<T>`). The route checks `instanceof Response` after every stage.
- Reuse the existing modules (`context-assembly`, `skill-runtime`, `tool-policy`, `post-processing`, `terminal-state`, `stream-accumulator`). This adds no second permission model, memory model or scheduler.
- Observability goes through what already exists: the `logSync` structured logger and the `observability` collector. That collector was unused until now. Redaction is enforced by the record's shape, not by a filter.

## Implemented

### Chat turn pipeline (`src/lib/chat/turn/`)

`src/app/api/chat/route.ts` is now an orchestrator. In order:

| Stage | Module | Owns |
|---|---|---|
| resolveTurnContext | `admission.ts` | admission, idempotent recovery, rate limit, private history, synchronous moderation |
| resolveAccount | `account.ts` | account + settings read, plan/period/ceiling, PLAN_REQUIRED |
| resolveAssistantIdentity | `identity.ts` | project assistant, thread agent, room speaker |
| resolveModel | `model.ts` | requested → agent → workspace → default, Auto routing, one capability snapshot, provider health, platform budget |
| resolveTurnTokens | `context.ts` | context tokens phase one, connectors opened |
| runPrivateTurn | `private-turn.ts` | the whole private turn (persists nothing) |
| acceptTurn | `accept.ts` | budget gate, durable acceptance transaction, user message, quota, regenerate/clarification/canvas-edit prep, room ledger |
| resolveHistory | `history.ts` | conversation window |
| resolveMemory ∥ resolveProjectContext | `memory.ts`, `project-context.ts` | memory recall; project/folder knowledge, attachments, tool notes, tokens phase two (now concurrent) |
| resolveCapabilities | `capabilities.ts` | research/web/fast/pro/canvas flags; `turnCarriesUntrustedContent` |
| resolveSkills | `skills.ts` | skill grant + audit row |
| resolveApprovals | `approvals.ts` | deterministic gates for acting tools; `createApprovalRequester` |
| resolveTools | `tools.ts` | execution entitlements from the verified verdict; `buildNativeTools` |
| composeTurnSystem | `prompt.ts` | system prompt composition |
| runTurn | `run-turn.ts` (+ `run-stream.ts`, `research-stage.ts`, `durable-receipt.ts`, `persist.ts`, `spend.ts`, `activity.ts`, `model-streams.ts`) | spend hold, stream log, generation, persistence, terminal states |
| finalizeOutputs | `finalize.ts` | moderation, citation audit, memory extraction/consolidation, log sweep (after the response) |

Provider-specific code stays behind `streamChat` (`src/lib/llm.ts`). Every permission decision is a pure function of account, plan, verified model capability, lockdown and the project assistant.

**Consolidated where copies had drifted:**

- One stream loop (`pumpTurnStream`) for the private and saved turns. The private copy had never learned `tool_status`/`tool_progress`.
- One spend-ledger record (`recordTurnSpend`), which replaced four field-by-field copies.
- One durable-receipt lease object with fenced writes.
- One model/reasoning preamble.

### Research engine (`src/lib/research/stages/`)

`createResearchEngine` was a 3,340-line closure. It is now built from `createEngineContext(deps)` (deps, event log, per-host fetch gate, advance/finish, budget helpers) plus six stage factories. Their code moved verbatim:

- `planning.ts`: clarify, size, plan
- `workers.ts`: scheduler, delegations, lead review, worker rounds
- `corpus.ts`: search, browse, link-hop, read
- `coverage-stage.ts`: claims/coverage, investigation
- `synthesis.ts`: writer
- `validation.ts`: citation audit

Rows, ports, limits, coverage computation, writer text and state sets moved to `types.ts`, `limits.ts`, `coverage.ts`, `writer-text.ts` and `states.ts`. `engine.ts` re-exports exactly its previous public surface, so no importer changed.

### Per-turn trace (§47)

`src/lib/chat/turn/trace.ts` is pure and does no I/O. Each record holds:

- run id (generation id), request id, account id, conversation id, surface, client, agent
- model/provider, plus the model asked for when routing changed it, and the reasoning effort
- feature flags
- total latency and time to first token
- attempts
- tool calls (name, ok, duration, status, error code, cached)
- approvals asked
- usage and cost
- finish reason, outcome (`completed | partial | stopped | failed`), failure code
- normalised error class/status/retryable
- cancellation cause (user stop, budget halt, stall, shutdown, lease lost)

No field can hold message text, reasoning, tool arguments or results, URLs, or raw provider error text. `tests/chat-turn-trace.test.ts` pins the field list.

`trace-sink.ts` emits each record once per turn in three ways:

- the structured `chat.turn` log line (`logSync`; `warn` on failure)
- `observability.recordLatency`, which gives per-model success rate and p95 latency/TTFT
- a 200-entry per-process ring

That ring feeds **`/admin/turns`**, the owner diagnostics page behind the Admin layout's owner and two-step gate. A fixture gallery is at `/dev/turns`. Captures are in `evidence/orchestration/turns-*.png` (light, dark and phone, with no horizontal overflow).

### Reliability (§48), verified behaviour

| Case | Behaviour (pinned by test) |
|---|---|
| Client disconnect mid-stream | The generation continues. The answer, spend and stream log persist. |
| Page refresh / lost SSE | `GET /api/chat/stream/{id}?after=0` replays the log and ends on `done`. |
| Provider 429 | One provider call, no retry. The error frame carries no raw provider text. The message is refunded, the hold released and the durable receipt `failed`. The trace records `rate_limit`, retryable. |
| Provider silent | Stall watchdog aborts. The turn ends as `error`, never as the user's Stop, and is refunded (`terminal-state.ts`). |
| User Stop | Partial answer kept, charge kept, `user_stopped`. |
| Durable retry | Recovers the receipt, never re-calls the model, writes nothing new. |
| External writes | SDK retries off (Anthropic, OpenAI-compatible, Responses). Gemini retries only retryable statuses, at most 4 times, before the stream exists. Acting tool calls are idempotent on (generation, provider call id) via `actionIdempotencyKey`. `req.signal` never reaches the model. |

## Changed

**Bug fixed: spend-hold leak.** If the research leg (or anything else before `generate()`'s own `try`) threw, it skipped the `finally` that releases the spend hold and closes tool-provider sessions. The account carried an over-stated hold until the hourly sweep. The outer catch now releases the hold and closes the sessions. The test fails on the old code and passes on the new.

**Ordering change.** Memory recall and project context now resolve concurrently. They are independent reads.

**Structural tests.** About 20 tests asserted invariants by reading `route.ts`. They now read the whole turn through `tests/chat-turn-source.ts` (`chatTurnSource()` / `turnModule()`). Every invariant was kept, and some were tightened:

- the private turn must not mention any stream log at all
- no stage other than `persist.ts` may write `Message.activity`

## Removed

- About 4,170 lines out of `route.ts` and about 3,960 out of `engine.ts`. The code moved; it was not deleted.
- Four duplicate spend-record blocks.
- The duplicate private stream loop.
- The inline receipt closures.

`src/lib/observability.ts` was dead code; it now has a caller.

## Line counts

| File | Before | After |
|---|---|---|
| `src/app/api/chat/route.ts` | 4,587 (`handleChat` alone ≈ 3,840) | 414 |
| `src/lib/chat/turn/*.ts` (27 files) | — | 6,045. The largest are `run-turn.ts` (1,082), `accept.ts` (654) and `private-turn.ts` (537). |
| `src/lib/research/engine.ts` | 4,831 | 868 |
| `src/lib/research/stages/*.ts` (13 files) | — | 4,299. The largest are `workers.ts` (846), `types.ts` (753) and `corpus.ts` (675). |

## Tests

- `CHAT_TURN_TEST_DATABASE_URL=<throwaway db> NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/chat-turn-pipeline.integration.test.ts`: 15/15 pass (12 before the split, on the original route).
- `npx tsx --test tests/chat-turn-trace.test.ts tests/chat-turn-reliability.test.ts`: 12/12 pass.
- Existing route DB suites (`context-tokens-chat`, `chat-tool-runtime`, `artifact-lifecycle`, `artifact-reemit-guard`, `ownership-guard-routes`): 63/65 pass, the same as baseline. The 2 failures existed before this branch and are unrelated:
  - context-tokens expects the "Crew member" heading but the copy now says "Agent"
  - chat-tool-runtime expects an older history-note format
- 20 structural and chat unit suites: 608 pass, 0 fail.
- `npx tsx --test tests/research*.test.ts tests/deep-research-adapter.test.ts`: 364 pass, 3 skipped, 0 fail. This is unchanged from before the split.
- `tsc --noEmit`: clean for every touched file. The remaining errors are pre-existing build artifacts: `runner/agent-core/dist`, and the i18n catalog, which is generated by `npm run i18n:extract`.

## Security considerations

- Permission gates moved without being rewritten. Task, handoff and agent-config tools, execution entitlements and skill narrowing are still deterministic functions of server-side state. `tests/chat-task-tool.test.ts` and `tests/chat-handoff-tool.test.ts` still pin their exact shape.
- The trace is redacted by construction: tool names are sanitised, and error text is reduced to a class. It is account-scoped by opaque id.
- `/admin/turns` sits behind the owner and two-step Admin layout plus `requireOwnerPage`. The ring buffer is per-process memory and never leaves the server.
- The private turn's guarantee is unchanged. It has no stream log, no audit row and no conversation id in its trace.

## Remaining blockers / not verified

- No authenticated browser run against the dev server: the pane has no signed-in session. `/admin/turns` was verified only through `/dev/turns` with recorder-built fixtures.
- The trace ring is per-process. A multi-process or retained trace store (or a log shipper querying `chat.turn`) is an infrastructure decision.
- Not exercised against real persistence:
  - process restart mid-generation. Receipt leases and the receipt sweep exist; a restart test was not run.
  - persistence failure after streaming. The code path exists; a DB fault was not injected.
- Real-provider 429/timeout behaviour was exercised only with scripted errors.

## Next milestone

1. Split `run-turn.ts` further, into success persistence, partial persistence and failure settlement as `persistTurn` / `settleFailedTurn`, behind the same suite.
2. Correlate the trace with Work, Research and Code runs (§47 worker state, search backend, citations, deliverables).
3. Add a restart and lease-expiry acceptance test against a real process.
4. Apply the same characterise-then-split treatment to the composer and chat view (§3.1).

## Reference

The trace covers the same kinds of facts as the OpenTelemetry GenAI semantic conventions, which now live at https://github.com/open-telemetry/semantic-conventions-genai. The attribute list was not checked field by field: only the repository landing page was reachable. Field names follow this codebase's conventions. No exporter was added (no new dependency).
