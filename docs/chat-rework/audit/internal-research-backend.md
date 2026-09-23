# Internal audit — Deep Research backend

Scope: everything server-side behind Juno's "Deep research" on the web app, plus the
wire contracts the web and native clients depend on. Read-only audit of branch
`web/tools-thinking-research` (worktree `juno-tools`, HEAD `d0997af2`), 2026-09-23.

Files read in full: `src/lib/deep-research.ts`, `src/lib/research/{engine,run,domain,auto-effort,
plan-format,tools,corpus,crawler}.ts`, `src/lib/research/agents/{lead,protocol,scheduler,worker,worker-loop}.ts`,
every route under `src/app/api/research/**`, `src/app/api/chat/clarify/route.ts`,
`src/lib/preflight-{clarification,triage}.ts`, `scripts/research-worker.ts`, the `Research*` Prisma
models, `docs/research-workspace.md`, the research parts of `docs/JUNO.md`, and the research
integration in `src/app/api/chat/route.ts`. Read in part: `claims.ts`, `claim-analysis.ts`
(audit loop, passages, scoring, repair), the client hooks (`use-research-run.ts`,
`use-conversation-run.ts`, `effort-copy.ts`, the composer chip), native `NativeResearchEffort.swift`,
and the tests under `tests/research-*.test.ts` and `tests/deep-research-adapter.test.ts`.

Severity key: **critical** means the feature is broken for most users. **High** means it happens in
normal use and costs money or correctness. **Medium** means it happens under common conditions.
**Low** covers polish, drift or edge cases. Findings I derived by arithmetic, or that depend on
runtime configuration, are marked *(derived)* or *(config-dependent)*.

---

## 0. Summary

1. **There are three research products, not one.** Web chat parks at an editable plan, then a
   background *full engine* writes the report on the "lead" model. Native chat auto-confirms,
   gathers inside the chat HTTP request, then the *user's chat model* writes the report as an
   artifact. `POST /api/research` has a clarify gate and an unlimited budget, but nothing in the UI
   calls it. Each path has its own clarifier, writer, budget and failure semantics (§3.1).
2. **Leases are never released when a driver stops at a gate, on pause or on abort.** Every API
   trigger also drives under a fresh random `workerId`. So Start after the plan, answering the
   clarify gate, Resume, and the chat "yes" reply all stall until the old lease expires. The stall
   is up to 2 minutes, plus the PM2 tick or the 3-minute stale poll. On the chat "yes" path the
   user is told *"Research could not gather enough evidence"* while the run carries on later in
   the background (B1).
3. **Stages longer than 2 minutes get run twice.** Heartbeats happen only inside `investigating`.
   Synthesis (no timeout, up to 16k output tokens), the citation audit, planning (≤150 s) and the
   chat hand-off at `synthesizing` can all outlive the 2-minute lease. When they do, the PM2
   `juno-research` worker, or the stale-poll re-drive, adopts the run with the **full engine** and
   runs the same paid stage in parallel. The chat hand-off case produces a second report that races
   the chat's own report and audit (B2, B3).
4. **Citation accuracy.** Once the audit's fixed 24 judge calls are spent, every remaining claim is
   marked **unsupported, not unverified**. The report is rewritten to say *"The cited evidence is
   insufficient: …"*, which is a false accusation. The rewrite then triggers a paid second synthesis
   that cannot fix it. Only the first 40 claims are ever audited. The tier's `judgeCalls` and
   `MAX_UNVERIFIED_SHARE` are dead code (B4, B22).
5. **A truncated planner JSON becomes the plan.** Each JSON line (`"question": "…",`) is parsed as a
   web search query and an objective. No retry happens because `hasUsablePlan` says yes. Deep and
   max plans are sized close to the 2,048-token output cap (B5).
6. **A failed writer ends `completed` with an empty report** (B6). The synthesis prompt has **no
   context budgeting**: up to 250 sources × 12,000 chars go into one system prompt, because every
   Tavily/Exa hit with raw content counts as "citable" (B7). Investigation can also spend the money
   the writer needs, which ends the run with no report at all (B8).
7. **Follow-up sweeps override the lead.** When the lead says "synthesize", the coverage stage still
   turns every sub-question scored under 0.8 into a gap. It then runs up to `rounds−1` search-only
   sweeps that no worker or lead ever reviews. Each sweep re-fetches and re-bills pinned sources
   (B9, B10).
8. **The tier names mislead.** Deep and max share the same effective page ceiling (250, not
   320/480). Under the fixed $8 chat ceiling with Haiku workers, the worst-case reservation sends
   about 4 / 3 / 2 workers for standard / deep / max. So **max sends fewer researchers than
   standard**, while the plan gate advertises "12 researchers · up to 480 pages". Depth is derived
   from the *chat* model's price tier and thinking level, even though the web chat model does no
   research work (§5, B21).
9. **Cost control.** Chat research uses a fixed $8 per-run ceiling (PRO's monthly budget is €11) and
   never consults the monthly budget. It has no live-run cap and no rate limit. Estimates price the
   planner, lead and writer at $3/$15, while they run on the *most intelligent* configured model
   (e.g. Claude Fable 5.1 at $10/$50), so reservations are about 3.3× under (B15, B16).
10. **Cancel, Stop and Resume are weak.** Background drivers get no AbortSignal, so cancel pays for
    any in-flight synthesis or audit to finish. A native Stop leaves the run live, and the backstop
    finishes it with the full engine. Resume recomputes the stage from a progress snapshot that lacks
    the round fields: a run paused in `synthesizing` redoes investigation, and a run paused at the
    plan gate re-plans and bills again. Paused time counts against the tier's wall clock
    (B12, B13, B17, B18).
11. **Quality gaps a redesign should fix first:**
    - No current date reaches any prompt (planner, brief, workers, lead, writer).
    - The research goal in chat is the clarification wrapper text (*"Now answer the original request
      … Do not repeat the clarification questions."*). It has no conversation context, so
      "do the same for Germany" is planned literally.
    - Seed reading is ranked by host authority, not relevance.
    - Three incompatible passage segmentations exist.
    - The whole pipeline runs inside the Next.js web process.

---

## 1. Code map

| File | Lines | Role | Runs in |
|---|---:|---|---|
| `src/lib/research/domain.ts` | 1,769 | States, transitions, stages, event kinds, plan type and parser, **tier table**, cost constants and estimators, budget helpers | everywhere (no `server-only`) |
| `src/lib/research/engine.ts` | 3,922 | The state machine and every stage (clarify, plan, search, pinned, read/deepen, link hop, syndication, worker rounds and tools, coverage and follow-ups, synthesis, validation), plus `drive`, `decidePlan`, `answerClarifications`, `steer`, `pause`, `resume`, `cancel` | caller's process |
| `src/lib/research/run.ts` | 995 | Prisma store, `researchEngine()` (full), `gatheringOnlyEngine()` (chat), `readResearchRun` (API view), `driveResearchInBackground`, `finalizeChatResearchRun` | server |
| `src/lib/research/tools.ts` | 731 | Model and vendor calls: `clarifyResearchGoal`, `planResearchQueries` (brief + structured plan + retry), `searchTheWeb`, `fetchResearchPage`, `expandResearchQueries`, `writeResearchReport` | server |
| `src/lib/research/plan-format.ts` | 300 | Planner system prompt (tier-shaped) and the structured-plan JSON parser | pure |
| `src/lib/research/corpus.ts` | 230 | Writer contract and numbered corpus (`buildResearchCorpus`), findings ledger, evidence state | pure |
| `src/lib/research/agents/worker.ts` | 467 | Worker and lead model selection, worker prompt, Anthropic and OpenAI-compatible tool-loop adapters, billing | server |
| `src/lib/research/agents/worker-loop.ts` | 310 | Provider-agnostic worker tool loop (nudges, limits, elision) | pure |
| `src/lib/research/agents/lead.ts` | 265 | Lead round review (coverage, gaps, contradictions, decision) plus deterministic fallback | server |
| `src/lib/research/agents/protocol.ts` | 517 | Worker tool schemas, arg validation, `chunkText`, digest renderers, `compileFindPattern` | pure |
| `src/lib/research/agents/scheduler.ts` | 187 | `Semaphore`, `HostLimiter` (2 fetches per host), `runAll`, `timeboxSignal` | pure |
| `src/lib/research/claims.ts` | 1,019 | Citation audit persistence (`recordCitationAudit`), judge, inspector loader | server |
| `src/lib/research/claim-analysis.ts` | 1,471 | Claim extraction, passage split, deterministic evidence audit, claim status, report repair, source scoring, syndication | pure |
| `src/lib/research/crawler.ts` | 314 | Fast HTTP extraction, optional Playwright headless fallback | server |
| `src/lib/research/auto-effort.ts` | 46 | `researchEffortFor(cost, reasoningEffort, proMode)` → tier | shared (client and server) |
| `src/lib/deep-research.ts` | 413 | **Chat adapter**: start or confirm a run, drive to `synthesizing`, bridge events into chat activity, build the corpus for the chat model | chat request |
| `src/app/api/research/route.ts` | 148 | `POST` start (clarify-capable, `confirmation: "required"`), `GET` list per conversation | request plus background |
| `src/app/api/research/[id]/route.ts` | 66 | `GET` run view plus events since cursor; **re-drives a working run stale for >3 min** | request plus background |
| `.../[id]/plan`, `/clarify`, `/steer`, `/control` | 59/57/58/60 | Plan decision, clarify answers, steering, pause/resume/cancel; each may `driveResearchInBackground` | request plus background |
| `src/app/api/research/citations/route.ts` | 42 | Audit for a chat message (`loadCitationAuditForMessage`) | request |
| `src/app/api/research/protocol.ts` | 136 | Zod request shapes (`effort: z.enum(RESEARCH_EFFORTS)`) and refusal copy | shared |
| `src/app/api/chat/clarify/route.ts`, `src/lib/preflight-{clarification,triage}.ts` | 100/190/332 | **Chat preflight scoping** for research (≤4 questions, "DEFAULT TO ASKING") | request |
| `scripts/research-worker.ts` | 117 | PM2 `juno-research` backstop: adopts `accepted`/working runs whose lease is null or expired | worker process |
| `src/app/api/chat/route.ts` | — | Research gate (2093–2095), `runDeepResearch` call and effort derivation (2793–2844), prior report as context (2777–2792), post-stream audit and finalize (3546–3609) | chat request |

---

## 2. Data model and state machine

### 2.1 Prisma (`prisma/schema.prisma` 3423–3635)

- **`ResearchRun`**:
  - Fields: `goal`, `state` (TEXT), `plan` (Json: the whole `ResearchPlan`, including tier budget,
    rounds ledger, coverage, conflicts and clarifications), `queries[]`, `costMicroUsd`,
    `budgetMicroUsd?`, `report`, `reportRevision`, `assistantMessageId`, and the lease fields
    `workerLeaseOwner`, `workerLeaseUntil`, `lastHeartbeatAt`.
  - The schema comment's state list omits `clarifying` and `awaiting_clarification`.
- **`ResearchSource`**:
  - Unique on `(runId, canonicalUrl)`.
  - Holds `snapshot` (≤12,000 chars), `contentHash`, four scores plus `composite`, `sourceType`,
    `publishedAt`, and `duplicateOfId` (written only by the audit).
  - `summary` is documented as "the worker model's condensation… served to every later
    `open_page`" but is **never written**: no summariser exists.
- **`ResearchFinding`**: worker claim + verbatim quote + `locator` (`chunk:<n>`). The schema says the
  locator points "into the source's passages", but chunks and passages are different segmentations
  (§6.4).
- **`ResearchPassage`, `ResearchClaim`, `ResearchClaimLink`**: the audit graph.
- **`ResearchEvent`**: append-only, `@@unique([runId, seq])`.
- **`ResearchReportRevision`**: immutable report versions.

### 2.2 States (`domain.ts` 29–107) and transitions (174–236)

```
accepted → clarifying → (awaiting_clarification →) planning → (awaiting_plan_confirmation →)
investigating ⇄ reviewing → synthesizing → validating_citations (→ synthesizing once) → completed
                                                        any live state → paused / cancelled / failed
                                   budget stop → partially_completed (or failed if no sources)
```

- **Blocked** (a person must act): `awaiting_clarification`, `awaiting_plan_confirmation`,
  `awaiting_user_input`, `paused`.
- `awaiting_user_input` has **no producer**. Nothing ever enters it.
- **Stages shown to people** (`STAGE_OF`, 329–347): plan / investigate / review / write / done.
  Copy for them is in `RESEARCH_STAGE_LABEL` and `RESEARCH_STATE_MESSAGE`.

### 2.3 Event kinds (`domain.ts` 392–445)

**Emitted:**
- Run and plan: `run_started`, `clarification_requested`/`_answered`, `plan_drafted`,
  `plan_confirmed`, `state_changed`.
- Sources: `source_ranked`, `query_issued`, `source_found`, `source_read`, `passages_extracted`.
- Coverage: `coverage_checked`, `coverage_matrix_updated`, `follow_up_scheduled`, `conflict_found`.
- Citations: `citation_audit` (emitted by `claims.ts`), `citation_audit_started`/`_completed`,
  `report_repaired`, `report_revision`.
- Workers: `worker_lease_acquired`, `worker_spawned`, `worker_tool_call`, `worker_finished`,
  `round_reviewed`, `budget_checkpoint`.
- Control and money: `steering_applied`, `spend_recorded`, `budget_exhausted`, `paused`, `resumed`,
  `cancelled`, `error`, `report_ready`, `run_finished`.

**Never emitted:** `plan_revised`, `page_summarized`.

**Volume:** one `worker_tool_call` per tool call and one `source_found` per new search hit. A deep
run writes thousands of rows (12 workers × 80 calls, plus up to 40 hits per query).

---

## 3. Lifecycle of a run

### 3.1 The four entry paths

| | **Web chat** (default product) | **Native chat** (`client: "app"`) | **`POST /api/research`** | **Backstop / stale re-drive** |
|---|---|---|---|---|
| Trigger | Composer research chip → `/api/chat` with `deepResearch: true` | Same flag from iOS/macOS | Direct API; **no UI caller** (`use-conversation-run.ts` only lists) | PM2 `juno-research` tick (5–60 s); `GET /api/research/[id]` if `updatedAt` > 3 min |
| Clarify | Chat preflight `/api/chat/clarify` (`RESEARCH_TRIAGE_SYSTEM`, ≤4 option questions, 6 s) | Same (if the client does it) | Engine `doClarifying` → `awaiting_clarification` (`CLARIFY_SYSTEM`, ≤3 free-text questions, lead model, 20 s). Skipped on the quick tier | — |
| Engine | `gatheringOnlyEngine()` for the turn (no clarify, no writer, no validator) | `gatheringOnlyEngine()` | `researchEngine()` (full) | `researchEngine()` (full) |
| Plan gate | `confirmation: "required"` → parks at `awaiting_plan_confirmation` inside the chat request (`deep-research.ts:268`) | `"auto"` → no gate | `"required"` | — |
| After the gate | Panel `POST /[id]/plan` → `driveResearchInBackground` with the **full engine**. Or the user types "yes" in chat → `decidePlan` + gathering drive in the chat request (`deep-research.ts:273–289`) | Gathers in the chat request until `synthesizing` (`until`) | Background full engine | Continues whatever state it finds, with the full engine |
| Report writer | `writeResearchReport` on `researchLeadModel()` (strongest configured) against `buildResearchCorpus` | **The user's chat model**, streamed, with `RESEARCH_OUTPUT_CONTRACT` (chat answer plus `research-report` artifact) | `writeResearchReport` | `writeResearchReport` |
| Audit | Engine `doValidation` → `recordCitationAudit(runId)` → at most 1 paid revision | Post-stream `recordCitationAudit(messageId, runId)` (chat route 3546–3598), then `finalizeChatResearchRun` | Engine | Engine |
| Budget | `CHAT_RUN_BUDGET_MICRO_USD` = $8 (env `RESEARCH_CHAT_BUDGET_USD`, cap $40) | $8 | `budgetMicroUsd` from body, **else null = no per-run ceiling** | inherited |
| Where the answer appears | Research card and report dialog. **Not** an assistant message: the chat turn only gets the notice *"Here's the research plan…"*. The next turn gets the report as untrusted system context (chat route 2777–2792) | Assistant message plus artifact | Card | whichever |
| Tier | `researchEffortFor(chat model cost, reasoning effort, pro)` | same | `effort` field, default `"standard"` (engine.ts 3526) | frozen on the plan |

### 3.2 Pipeline, step by step

Each step lists: what it does, the model or vendor it uses, where it runs, what it persists, the
events it emits, and the cost gate.

**0. Preflight scoping (chat only).**
- The client calls `POST /api/chat/clarify` with `deepResearch: true` and aborts at 8 s
  (`use-chat.ts:1433`).
- `quickPreflightSkip` skips only for "don't ask", trivial math, or ≤8 chars. Research never skips
  for attachments or length (`preflight-clarification.ts:82–108`).
- `triagePreflightClarification` runs `RESEARCH_TRIAGE_SYSTEM` on a fast FREE-tier model with a
  6 s total and 4.5 s per-attempt deadline, up to 4 questions (`preflight-triage.ts:139–163,
  305–332`).
- The answers are **not** structured into the run. They become the user message
  (`formatPreflightClarificationModelMessage`), and that message becomes the run's `goal` (§6.2).
- **Unbilled**: `attemptTriage` records no spend (253–290).

**1. Create** (`engine.start`, 3523–3550).
- Inserts a `ResearchRun` in `accepted` with `plan = { effort, budget: budgetForEffort(effort),
  confirmation, constraints, pinnedSources }`.
- Emits `run_started`.
- Chat path: first cancels any older parked plans in the same conversation
  (`deep-research.ts:243–259`), via `finish(…"cancelled")`, **which sends an APNs "Research report
  complete" push** (B19).

**2. `accepted → clarifying`**: always passes through (3498–3504).

**3. `doClarifying`** (1563–1605).
- Skips when there is no `clarify` dep (the chat engine), when `confirmation: "auto"`, when the run
  is already clarified, or when the call is unaffordable.
- Otherwise one completion on the lead model. Questions → `awaiting_clarification`.
- `answerClarifications` (3700–3745) folds the answers into `constraints` as `"question answer"` →
  `planning`.

**4. `doPlanning`** (1607–1706) → `planResearchQueries` (tools.ts 375–474).
- **Brief expansion**: lead model, 600 output tokens, 30 s.
- **Structured planner**: lead model, 2,048 tokens, 60 s. JSON of approach, objectives (each with
  evidence requirements and queries), steps, criteria and risks (plan-format.ts 66–104). One retry
  when `hasUsablePlan` is false.
- Queries are taken round-robin from the objectives. The cap is 16, or 24 for deep/max
  (tools.ts 68–79).
- If zero queries come back → `failed: no_plan`. There is no template fallback (1648–1654).
- Saves the plan and the `queries` column. `auto` → `investigating` (events `plan_drafted` and
  `plan_confirmed{auto}`). `required` → `awaiting_plan_confirmation`.
- **The planner never receives today's date.**

**5. Plan gate** (`decidePlan`, 3616–3688).
- Cancel → `finish(cancelled)` (push, B19).
- Confirm with edited steps or queries → objectives rebuilt mechanically from the edited steps.
  This **throws away** the planner's evidence contracts.
- → `investigating`, event `plan_confirmed{by:user}`. The route then starts a *new* background
  driver (lease stall, B1).

**6. `investigating`** (`doInvestigating`, 3247–3263). This is one state machine step that holds the
lease with heartbeats.
- **6a. Sweep search** (`doSearching`, 1708–1842). Pending plan queries go out in waves of
  `SEARCH_CONCURRENCY = 4`. Each wave is budget-checked once (`affordableCount`).
  `searchTheWeb` runs a multi-engine fan-out; Tavily uses `include_raw_content`
  (search-engine.ts 553), and each query is billed a flat 1,000 µUSD. Every hit is upserted as a
  source. **A hit with a raw body is stored with a snapshot, which makes it "read" and "citable"
  without ever being fetched.** Events: `query_issued` (the first carries the provider roster) and
  `source_found` per new row. `issuedQueries` is saved after each query.
- **6b. Pinned sources** (`doBrowsing`, 1852–1920). Fetches every pinned URL. **No "already read"
  check** (B10). Stores with `authority: 1`.
- **6c. Read / deepen** (`doReading`, 2067–2310).
  - Ranks all rows by `composite` (authority 0.4, freshness 0.2, directness 0.25, independence
    0.15). **Relevance and search rank play no part.**
  - Takes the top `ceil(pages × 0.25)` (quick 5, standard 20, deep 80, max 120).
  - Fetches rows with no body (required) and "deepens" rows under 2,000 chars (max 40), in waves of
    8, with at most 2 fetches per host (`HostLimiter`). Fetches are 25 s each with one retry on
    429/503 (tools.ts 541–589).
  - Saves passages (`splitPassages`: ≤6 paragraphs of ≥80 chars, each cut to 1,200 chars).
  - Remembers permanently dead URLs.
- **6d. Link hop** (`doLinkHop`, 1941–2056). One hop from pages fetched this pass. Anchor and path
  tokens must overlap the objectives (≥0.34, +0.15 for off-host links). Allowance is
  `min(24, ceil(pages × 0.1))`.
- **6e. Syndication** (`markSyndicatedCopies`, 1311–1369). 5-gram Jaccard at 0.45 or wire markers.
  Copies get `independence = 0` and a `duplicate_source` conflict. O(n²) over ≤250 bodies, on the
  web server's event loop.
- **6f. Agent rounds** (`doWorkerRounds`, 2695–3092).
  - **Round 1 briefs** (`initialDelegations`, 2334–2385): one worker per objective by importance.
    Spare slots get axis workers for counter-evidence, recent developments and primary records.
  - **Gates before a round**: wall clock (measured from the first round's `startedAt`), worker
    token ceiling, and page ceiling `min(250, tier.pages)` minus pages already fetched.
  - **Reservation**: `affordableCount(workerEstimate)`, the worst-case whole tool loop at the
    worker model's rates. This can cut the worker count well below the tier (§5.4).
  - **Workers** (`runResearchWorker`, worker.ts 442–467):
    - Model: `researchWorkerModel()`, which prefers Haiku, else the cheapest agentic,
      non-training, non-Responses model.
    - Tools: `search`, `open_page` (fetch, store, passages, then return a digest: the first
      700 chars plus a chunk index), `find_in_page` (regex over chunks), `note_finding` (the quote
      must appear verbatim, 80-char probe), `done`.
    - Per-worker tool-call and wall-clock limits.
    - After every tool call, `stopAfter()` reloads the run to catch cancel or budget.
  - **Transcript**: the Anthropic SDK or OpenAI chat-completions, `max_tokens` 2,048, no prompt
    caching. The newest ≤10 results are kept up to 80k chars; older ones are elided.
  - **After the round**: each worker's model cost is billed (`bill(…"worker")`, 2865). All workers
    `model_unavailable` or `idle` → error event and stop.
  - **Lead review** (`reviewResearchRound`, lead.ts): lead model, 1,400 tokens, 45 s. Coverage 0–1
    per objective, gaps with new briefs, contradictions, and a decision. Falls back to a
    deterministic review.
  - The round is recorded on `plan.rounds`. The next round's briefs come from `review.gaps`.
  - Stops at `synthesize`, when no gaps remain, on saturation (new-claim share < 10%), or on any
    ceiling.
  - Then syndication again → `reviewing`.

**7. `reviewing`** (`doCoverage`, 3101–3236).
- `computeCoverage` (1005–1175) builds a requirement × source matrix from passage-level token
  overlap and source-type, freshness and jurisdiction policy.
- The lead's scores decide objective status. Every objective scoring under 0.8 becomes a gap,
  **regardless of the lead's decision** (B9).
- While `followUpRound < min(4, rounds−1)` (quick 0, standard 1, deep 2, max 2): follow-up queries
  are written by `expandResearchQueries` (lead model), falling back to templates → back to
  `investigating`. That pass is a search-only sweep: the workers are skipped because the last review
  said synthesize.
- Else → `synthesizing`.

**8. `synthesizing`** (`doSynthesis`, 3265–3314).
- **Chat engine:** no writer. Returns `blocked`, and `drive({until:"synthesizing"})` hands the
  corpus back to `runDeepResearch`, which builds `buildResearchCorpus` (findings ledger, evidence
  state, every citable source) for the chat model.
- **Full engine:**
  - Reserves `synthesisEstimate(corpus)` at the reference $3/$15 rates.
  - Calls `writeResearchReport`: lead model, corpus in the **system** prompt, goal in the user
    message, 16,384 output tokens, **no timeout**. Provider errors are swallowed and return `""`.
  - → `validating_citations` with the report. Event `report_ready`.

**9. `validating_citations`** (`doValidation`, 3325–3479).
- Reserves `CITATION_AUDIT_ESTIMATE` (24 judge calls).
- `recordCitationAudit` (claims.ts 261–580):
  - Extracts ≤40 load-bearing sentences.
  - Rewrites every source's passages (up to 24 per source, 40–900 chars; sequential DB work for up
    to 250 sources).
  - For each claim, ranks at most 2 passages per cited source by the deterministic audit, then calls
    the judge (background utility model, 200 tokens). A total cap of 24 calls applies.
  - Resolves status, repairs the report text in place, and writes two revisions plus a
    `citation_audit` event.
- Dangling `[n]` → error.
- If `repaired` or dangling, and `revisionRound < 1` → back to `synthesizing` for **one** paid
  rewrite, then audit again.
- Terminal state: `completed` unless dangling markers remain or the audit was degraded.
  **Unverified or unsupported claims do not downgrade the run.**

**10. Terminal** (`finish`, 1411–1451).
- Conditional state write plus `state_changed` and `run_finished`.
- APNs push: status `"completed"` for everything except `failed`.
- `TERMINAL_PATCH` clears the lease (run.ts 113–116).
- Chat path: `finalizeChatResearchRun` (run.ts 945–995) moves `synthesizing → validating_citations
  → completed | partially_completed` with the chat's (possibly repaired) report, but only if the
  post-stream audit block ran.

### 3.3 Where each step physically runs

```
Browser ──/api/chat (SSE)──► Next.js process
                               ├─ preflight triage (separate request, before)
                               ├─ runDeepResearch → engine.drive(gatheringOnly, until=synthesizing, signal=chat abort)
                               │     • web: clarify-less planning → parks at plan gate → notice text, turn ends
                               │     • native: ENTIRE investigation (minutes to an hour) inside the SSE request
                               ├─ chat model streams the report (native) → post-stream audit → finalize
                               │
Browser ──/api/research/[id]/plan|clarify|steer|control──► Next.js process
                               └─ driveResearchInBackground(researchEngine) — fire-and-forget promise in the
                                  WEB SERVER process (no AbortSignal, fresh workerId). Workers, fetches, optional
                                  headless Chromium, O(n²) syndication, synthesis and audit all run here.
Browser ──GET /api/research/[id] every 2.5 s (8 s idle)──► re-drive if a working row is untouched for 3 min
PM2 juno-research (scripts/research-worker.ts) ── every 5–60 s: adopt accepted/working rows with null or expired lease,
                                  drive with the FULL engine; awaits ALL claimed drives before the next tick.
```

The PM2 worker is described as a backstop, but in practice it is a second driver. Any stage longer
than 2 minutes without a heartbeat, and every chat hand-off longer than 2 minutes, is adopted by it
(B2, B3).

### 3.4 How progress is persisted and streamed

- **Durable**: every transition goes through `advance()` (conditional `moveState` plus a
  `state_changed` event). Plan mutations are read-modify-write of the whole JSON blob via `savePlan`.
  Sources, passages and findings are rows.
- **Event sequence**: `appendEvents` locks the run row (updates `updatedAt`), reads
  `max(seq)+1`, `createMany`, and retries up to 4 times. After that it **drops the events silently**
  (run.ts 220–268). Every event write therefore serializes on the run row: 12 parallel workers
  contend on one lock for each tool call.
- **Web panel**: polls `GET /api/research/[id]?after=cursor`:
  - 200 events per page, 2.5 s while working, 8 s when idle; immediate follow-up when
    `lastSeq < maxSeq`.
  - The response carries the **full run view, including every source row**. `readResearchRun`
    selects every `snapshot` just to compute `read: !!snapshot` (run.ts 808, 398–418), which is MBs
    per poll on a deep run.
  - Separately, every open conversation polls `GET /api/research?conversationId=` **every 4 s,
    forever** (`use-conversation-run.ts:57`).
- **Chat bridge**:
  - `runDeepResearch` polls its own event log every 700 ms and maps a subset to chat
    `ClientActivityEvent`s (`toActivity`, deep-research.ts 128–219). Examples: `query_issued` →
    *"Searching the web"* and `source_read` → *"Reading source"*.
  - **These titles are a de facto wire contract.** Native `DeepResearchActivityProjection` matches
    the literal `"Searching the web"`, and the thought-process panel parses titles.
  - Every `error` event is narrated as *"A source could not be read"*, including worker outages and
    audit failures (B25).
- **Cost on the turn**: `researchCostUsd` is the run row's odometer, added to the assistant message
  cost.

### 3.5 Concurrency, leases and fencing

- `claimRun` (run.ts 140–164) is a conditional `updateMany`. It succeeds when state is
  `accepted` or working AND (lease null OR expired OR owner = me). Lease length is 2 min
  (`RESEARCH_WORKER_LEASE_MS`).
- `drive()` claims at the top of **every** loop iteration. `heartbeat()` is passed **only** to
  `doInvestigating` (and inside it re-claims per wave, plus a 45 s interval during rounds).
- The lease is released **only** on terminal states. Blocked, paused, raced and aborted returns keep
  it (B1).
- Every API trigger uses `research-web:${runId}:${Date.now()}`, and the chat path uses
  `research-chat:${runId}:${Date.now()}`. A second trigger by the same user is therefore a
  *different* owner and is fenced out by the stale lease of the first.

---

## 4. Money: estimate, reserve, bill

### 4.1 Estimates and reservations

| Stage | Estimate (engine) | Rates assumed | Actual model |
|---|---|---|---|
| Search | `SEARCH_FEE 1,000 × 2` | vendor | flat 1,000 µUSD per query regardless of engine fan-out |
| Page fetch | `500 × 2` | vendor | flat 500 µUSD |
| Clarify | 6k chars in, 700 out | $3/$15 × 1.25 | **lead model** (strongest) |
| Plan | brief + planner | $3/$15 × 1.25 | **lead model** |
| Expansion | 10k chars, 512 out | $3/$15 | lead model |
| Worker | `(toolCalls+1) × call(84k chars, 700 out)` + `toolCalls × 2,000` | worker model rates (from the catalogue) | worker model; the real output cap is **2,048** |
| Lead review | 52k chars, 2,048 out | lead rates | lead; the real cap is **1,400** |
| Synthesis | corpus chars + 16,384 out | $3/$15 | lead model |
| Citation audit | 24 × judge call | $3/$15 | background utility model |

The reference rates are documented as "the dearest `utilityModelCandidates()` model"
(domain.ts 1480–1499). Since `researchPlannerModel()` became `researchLeadModel()` (tools.ts
127–134), that assumption is false. With Claude Fable 5.1 configured ($10/$50,
model-metrics.ts 57) every model stage is under-reserved about 3.3× (B15).

### 4.2 Ledgers

- The run odometer is `ResearchRun.costMicroUsd` (via `bill` → `addSpend`).
- The account ledger `ApiSpend` is written by:
  - vendor fees, via `addSpend` as `kind:"research", model:"deep-search"`
  - `utilityCompletion` and `writeResearchReport` as **`kind:"chat"`**
  - workers and lead as `kind:"research"`
  - the judge via its own `runUtilityPrompt` path

  Research spend is therefore split across kinds (B27). Preflight triage is not recorded at all.
- **The monthly budget is never consulted.** Chat research always gets $8 (deep-research.ts 91–95,
  266). PRO's monthly budget is €11 (spend.ts 59–65), so one run can use about 73% of a month, and
  a user with €1 left can still start an $8 run. The chat path has no `MAX_LIVE_RUNS` and no rate
  limit; both exist only on the dormant `POST /api/research` (route.ts 33, 67, 75–86) (B16).
- **No reserve for the writer.** Rounds reserve worker estimates against whatever is left, and
  worker model cost lands after the round. So the run can reach `synthesizing` with too little money
  to write (B8).

---

## 5. Effort tiers (`RESEARCH_EFFORTS` / `RESEARCH_TIERS`)

### 5.1 Nominal table (`domain.ts` 1026–1075) and what actually applies

| | quick | standard | deep | max |
|---|---:|---:|---:|---:|
| Workers per round | 1 | 4 | 8 | 12 |
| Worker rounds | 1 | 2 | 3 | 3 |
| Tool calls per worker | 25 | 40 | 60 | 80 |
| `pages` (nominal) | 20 | 80 | 320 | 480 |
| **Effective worker page ceiling** `min(250, pages)` (engine 2738) | 20 | 80 | **250** | **250** |
| Seed reads `ceil(pages × 0.25)` (count against the ceiling) | 5 | 20 | 80 | 120 |
| Link-hop fetches `min(24, ceil(pages × 0.1))` | 2 | 8 | 24 | 24 |
| Pages left for workers if every seed and hop fetch was needed *(derived)* | 13 | 52 | 146 | **106** |
| Results per query | 12 | 24 | 32 | 40 |
| Worker token ceiling (whole run) | 0.4M | 1.5M | 6M | 12M |
| Investigation wall clock | 5 min | 12 min | 30 min | 60 min |
| Per-worker wall clock | 4 min | 5 min | 8 min | 12 min |
| `judgeCalls` | 24 | 48 | 96 | 160 — **unused; the audit is always 24** |
| Follow-up sweeps `min(4, rounds−1)` | 0 | 1 | 2 | 2 |
| Planner objectives (plan-format 46–60) | 2–3 | 3–5 | 5–8 | 5–8 |
| Queries per objective / planned-query cap (tools 68–79) | 1–2 / 16 | 2 / 16 | 2–3 / 24 | 2–3 / 24 |
| Template fallback query count (domain 634) | 5 | 9 | 14 | 14 |
| Engine clarifier | skipped | yes | yes | yes |
| Planner prompt line | "Research depth: quick. Stay focused…" | "…standard" | "…deep" | "…max" |
| Worst-case worker reservation, Haiku $1/$5 *(derived: `workerEstimateMicroUsd`)* | $0.85 | $1.34 | $1.99 | $2.64 |
| **Round-1 workers under the $8 chat ceiling** (≈$7.75 left after plan and sweep) *(derived)* | 1 | 4 | **3** | **2** |
| Plan gate / composer copy (`effort-copy.ts`) | "1 researcher · up to 20 pages · ~3 min" | "4 researchers · up to 80 pages · ~6 min" | "8 researchers · up to 320 pages · ~15 min" | "12 researchers · up to 480 pages · ~30 min" |
| Native copy (`NativeResearchEffort.swift` 38–45) — **stale** | 1 · 40 · ~2 min | 3 · 120 · ~5 min | 5 · 220 · ~10 min | 8 · 320 · ~15 min |

The last copy row and the "Round-1 workers" row show the product lying in both directions. The
UI promises 8 or 12 researchers and 320 or 480 pages. On the default chat budget the run sends
fewer workers for max than for standard, and deep and max read the same maximum.

### 5.2 How the tier is chosen

`researchEffortFor` (auto-effort.ts 35–46):

- **score** = chat model `cost` (1–3; Auto counts as 2) + reasoning rung (minimal/low 0, none or
  medium 1, high 2, xhigh/max 3) + 1 for GPT Pro.
- **Mapping**: score ≥6 → max, ≥4 → deep, ≥2 → standard, else quick.
- The composer derives the same value client-side to label its chip (composer.tsx 755–763). The
  server re-derives it (chat route 2800–2808); for Auto it uses the server's `autoReasoningEffort`,
  so the chip and the run can disagree.
- **The coupling is wrong for the web path.** The chat model does no research work there. Workers
  are the cheapest agentic model, and planner, lead and writer are the strongest. The chat model
  only picks the depth label. The chip's tooltip tells users to *"Pick a stronger model or raise
  thinking for a deeper run"*.
- The defaults disagree: `DEFAULT_RESEARCH_EFFORT = "standard"` (domain 1078);
  `engine.start` hard-codes `"standard"` (3526–3527); `runDeepResearch` defaults to `"deep"`
  (deep-research.ts 267); JUNO.md says "Chat defaults to deep".

### 5.3 Every place effort or tier is referenced

**Backend**

| Location | Use |
|---|---|
| `domain.ts` 965–1116 | `RESEARCH_EFFORTS`, `isResearchEffort`, `ResearchTier`, `RESEARCH_TIERS`, `DEFAULT_RESEARCH_EFFORT`, `ResearchBudget`, `budgetForEffort` |
| `domain.ts` 614–645 | `fallbackResearchQueries(goal, effort)` count |
| `domain.ts` 918–921, 1304–1305, 1325–1327, 1413–1437 | `plan.effort` / `plan.budget` persist and parse, `planBudget` |
| `domain.ts` 1596–1598 | `judgeCallsForEffort` — **unused** |
| `engine.ts` | 486–491 (`clarify` dep gets effort), 497 (`plan` dep), 1195/3526–3527 (start default and freeze), 1577 (clarify default), 1715 (`resultsPerQuery`), 1859 (pinned slice by pages), 2117–2121 (seed share), 2278 (hop share), 2703–2795 (workers, rounds, tokens, clock, tool calls, pages), 3158 (follow-up rounds) |
| `tools.ts` 77–79, 315–320, 419, 429 | planned-query cap; clarifier skip for quick; planner prompt |
| `plan-format.ts` 46–104 | `plannerShape`, "Research depth:" line |
| `auto-effort.ts` | the derivation |
| `deep-research.ts` 227–228, 267 | chat default "deep" |
| `run.ts` 698–705, 867 | `ResearchRunView.plan.effort` on the wire |

**API and wire**

| Location | Use |
|---|---|
| `src/app/api/research/protocol.ts` 60–64 | `effort: z.enum(RESEARCH_EFFORTS).optional()` on `POST /api/research` |
| `src/lib/chat/request.ts` 116 | `researchEffort: z.enum(RESEARCH_EFFORTS).optional()` on `/api/chat`. Only a fallback when `modelInfo` is null, which is effectively never |
| `src/types/chat.ts` 422 | client type |
| `src/lib/preflight-clarification.ts` 48 | carried across the clarify interruption |
| `src/hooks/use-chat.ts` 104, 1226, 1308, 1420, 1458, 1473, 1601 | pass-through |
| `contracts/openapi/juno-native-v1.yaml`, `contracts/capabilities` | **no research surface at all** |

**Web UI**

| Location | Use |
|---|---|
| `src/components/research/effort-copy.ts` | labels Quick/Standard/Deep/Max, summaries, ETA = wall clock ÷ 2 |
| `src/components/chat/composer.tsx` 54–56, 755–763, 797, 2514–2525, 2840 | chip detail, tooltip, aria label |
| `src/components/research/run-controls.tsx` 8, 377, 393, 469–473 | plan gate "authorised" line |
| `src/components/research/use-research-run.ts` 135 | view type |
| `src/components/ui/composer-shell.tsx` 316 | comment referencing the copy |
| dev fixtures | `src/app/dev/*` |

**Native**

| Location | Use |
|---|---|
| `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeResearchEffort.swift` | enum, labels, stale summaries, `derived()` mirror |
| `native/iOS/JunoMobile/App/JunoMobileComposer.swift` 153–154 | chip depth |
| `native/iOS/JunoMobile/App/JunoMobileResearchProgress.swift` 15–17 | progress depth line |
| `NativeResearchEffortTests.swift` | tests |
| macOS `DesktopComposer.swift` | toggle only, no depth |
| Native request bodies | send `deepResearch: true` only, never `researchEffort` |

**Docs and tests**

| Location | Use |
|---|---|
| `docs/JUNO.md` 735–738 | tier numbers, "defaults to deep" |
| `docs/research-workspace.md` | "Depth is derived, not chosen", per-tier `resultsPerQuery` |
| `tests/research-auto-effort.test.ts`, `tests/research-agents.test.ts` | tier budget and reservation tests |
| `tests/research-run.test.ts` | effort passed to the planner |

**Billing and plan gating**: none by tier. `PLANS[plan].webSearch` (a boolean) is the only
entitlement check (plans.ts 32). No plan limits depth, count or per-run ceiling.

### 5.4 Removing named levels: what has to change

**Target.** There are no Quick/Standard/Deep/Max labels anywhere. The engine sizes a numeric
**budget** automatically, and the UI offers at most one optional "go longer" control, for example
an *Extended* toggle before the run or *Keep researching* after it.

1. **Replace the input to the derivation.**
   - Drop the chat-model price tier and thinking rung as the depth signal.
   - Size from: (a) the planner's decomposition (number of objectives, and evidence requirements
     that need primary or multiple sources); (b) the plan entitlement; (c) the **remaining monthly
     budget**; (d) the optional `extended` flag.
   - Proposed function `researchBudgetFor({ plan, remainingMicroUsd, objectives, extended }) →
     ResearchBudget`, with numeric fields only.
   - Keep `ResearchBudget`, which is already frozen per run. Keep the `effort` enum only as a
     legacy decoder in `parsePlan` for old rows.
2. **Make depth emergent, not preset.**
   - Workers = objectives (+ axis workers while money allows).
   - Rounds = until the lead says synthesize or new claims saturate, capped by money and time.
   - Pages = k × objectives.
   - Put a **writer and audit reserve** into every round's reservation (fixes B8).
   - Size the per-run ceiling from entitlement and remaining budget instead of the flat $8.
3. **Planner prompt.** Replace `"Research depth: ${effort}"` and `plannerShape(effort)` with explicit
   numbers from the budget: "plan 3–8 sub-questions; at most N searches". `plannedQueriesFor`,
   `fallbackResearchQueries` and the clarifier's quick skip must key on budget numbers.
4. **Wire.**
   - `/api/chat`: keep accepting `researchEffort` for old native builds but ignore it. Add
     `researchExtended?: boolean`.
   - `POST /api/research`: replace `effort` with `extended?: boolean`, or an explicit
     `budgetMicroUsd` for power users.
   - `ResearchRunView.plan.effort` → `plan.budget: { workers, rounds, pages, wallClockMs,
     ceilingMicroUsd }` so the gate can say "up to N researchers, about M minutes, stops at $X".
     Or say nothing numeric and just show the plan.
5. **UI.**
   - Composer chip: "Research", with no detail label.
   - Delete `effort-copy.ts`.
   - The plan gate's "authorised" line comes from `plan.budget`.
   - Remove the tooltip that points at model and thinking.
6. **Native.** Drop `NativeResearchEffort.label/summary/note` and `derived()` (it already lies,
   see §5.1). Show the server's budget or nothing.
7. **Tests and docs.** Rewrite `research-auto-effort.test.ts` as budget-sizing tests. Update the tier
   assertions in `research-agents.test.ts`, JUNO.md 735–738, research-workspace.md, and the Swift
   tests.
8. **Also fix while there.** The effective page ceiling must match the budget: stop clipping by
   `MAX_SOURCES` (a synthesis-corpus cap, not a fetch cap). Scale the audit judge budget with the
   report (use `judgeCalls`). Stop counting paused time against the clock.

---

## 6. Quality problems

### 6.1 Planning

- **No date awareness.**
  - None of the brief, planner, clarifier, worker, lead or writer prompts contains today's date
    (plan-format.ts 66–104, tools.ts 203–211 and 288–312, worker.ts 163–200, lead.ts 34–52,
    corpus.ts 204–229).
  - The planner is asked to set `freshness` rules ("within 12 months", "2025") and cover "the most
    recent developments" with no anchor. Workers are told to prioritise "the last twelve months"
    (engine 2362).
  - Only the template fallback uses `new Date().getUTCFullYear()`.
- **Output cap too tight for the requested shape.** 5–8 objectives × (question, rationale,
  evidence object, 2–3 queries) + approach + steps + criteria + risks ≈ 2k tokens against
  `PLANNER_OUTPUT_TOKENS = 2,048`. Truncation is silently turned into garbage queries (B5).
- **The lead model is chosen for intelligence alone** (worker.ts 140–157). Latency is ignored while
  every lead call has a 20–60 s timebox (tools.ts 45–53, lead.ts 30). The catalogue itself notes
  Fable's ~122 s to first answer (model-metrics.ts 57). With such a lead, brief, plan and review are
  all at risk of timing out *(config-dependent)*. The planner failing twice fails the run.
- **Editing the plan destroys its structure.** Any edit to steps or queries rebuilds objectives with
  `buildResearchObjectives` (engine 3659–3672). That replaces the planner's evidence contracts,
  rationale and importance with boilerplate ("Direct evidence answering: …", 1 source, no primary).
- **The goal is poorly defined in chat.** It is the last user message only, with no conversation
  context, wrapped in clarification boilerplate (B20). The brief expansion cannot resolve "the same
  for Germany".
- **Pinned sources reach the planner** as "Preferred source locations", but constraints from the
  preflight answers reach it only as prose inside the goal.

### 6.2 Clarifying step

- **Two clarifiers with opposite philosophies, and only one of them is live.**
  - Chat preflight: `RESEARCH_TRIAGE_SYSTEM`, "DEFAULT TO ASKING", up to 4 option questions, a fast
    FREE model, a 6 s deadline, fail-open.
  - Engine: `CLARIFY_SYSTEM`, "Return `{"questions": []}` for most", free text, lead model, 20 s,
    and a `ClarifyGate` UI. It is reachable only through `POST /api/research`, which no client
    calls. So `ClarifyGate`, `/api/research/[id]/clarify` and `answerClarifications` are dormant in
    the product.
- **The live clarifier's answers are not structured.** They are appended to the user message
  (`formatPreflightClarificationModelMessage`) and become the run's `goal`, including the
  instruction *"Now answer the original request using these answers. Do not repeat the
  clarification questions."* (preflight-clarification.ts 164–190). The corpus truncates the goal to
  300 chars in the writer's header (corpus.ts 205), which can cut the answers off. The panel shows
  this wrapper as "the question".
- **Timing is fragile.** The client aborts at 8 s and the server gives 6 s, with fail-open. Under
  load the scoping card silently never appears. Triage cost is unbilled.
- The clarifier never sees the attachments or connectors the research could use. Research ignores
  attachments entirely: "Uploaded files are not advertised as research sources".

### 6.3 Source diversity and ranking

- **Seed reading ranks by host authority**, not relevance or search rank (engine 2072–2096;
  `scoreSource` in claim-analysis 1342–1370). A tangential `.gov` page outranks the most relevant
  trade article. The authority table is Anglo-centric: `gouv.fr` and `bund.de` fall to 0.45.
- **Diversity controls are thin.**
  - There is no per-host cap in seed targets, worker reads or the corpus.
  - Monoculture is flagged only when *all* sources share one host (engine 1101–1111).
  - Independence counts hostnames, not organisations: `news.example.com` and `example.com/blog`
    count as two witnesses.
  - Syndication detection runs, and it works.
- **Everything with a raw body is "read".** Tavily `include_raw_content` makes every hit a citable
  snapshot. The corpus is dominated by whatever the index returned, and the "pages read" counters
  mean fetches, not documents seen.
- **The search provider's quality is reported but not acted on.** `providers.hasGoodIndex` rides the
  first `query_issued` event. A deployment on scraped keyless engines runs full-price research
  without telling the user.
- **Follow-up sweeps add unreviewed pages** (B9). They broaden the corpus without adding findings.

### 6.4 Citation accuracy

- **False "unsupported" past the judge cap** (B4). This is the single most damaging bug for trust.
- **Coverage is fixed regardless of report size.** 40 claims and 24 judge calls apply whatever the
  report length (claims.ts 60, domain 1587). A deep report has 100+ claims, and the rest are never
  checked. The summary reports "claims: 40", which reads as total coverage.
- **Uncited load-bearing sentences** (numbers or names with no `[n]`) get no candidates and are
  labelled "The cited evidence is insufficient: …" even though they cite nothing.
- **Three segmentations of one snapshot:**
  - engine `splitPassages`: ≤6 paragraphs, ≥80 chars, cut to 1,200 (engine 3888–3907)
  - audit `splitPassages`: 40–900 chars, ≤24 (claim-analysis 721–770)
  - worker `chunkText`: 1,200-char windows, ≤50 (protocol 46–67)

  Worker findings cite `chunk:n`, which maps to no `ResearchPassage`. Engine passages are
  overwritten by the audit anyway. The headless crawler flattens all whitespace (crawler 227), so
  its pages yield a single engine passage.
- **Only two passages per cited source** are considered (`perSource = 2`). A figure deeper in a long
  page can be missed, which yields "unsupported".
- **Repair text is injected in the prose.** "Unverified: … (this claim could not be checked within
  the run limits.)" appears inside the reader-facing report. Any repair triggers a full paid
  rewrite (engine 3439–3444).
- **The chat path has no dangling-marker check** before delivery. The audit runs after streaming,
  then rewrites the message and appends an artifact version (chat route 3564–3598). What the reader
  saw live differs from what is stored.
- **Findings are not reconciled with the report.** The ledger is given to the writer, but the audit
  does not use `ResearchFinding` quotes as pre-verified evidence. The worker already proved the
  quote was on the page.

### 6.5 Report structure and delivery

- The writer's contract is fixed at six sections (corpus.ts 208–215) regardless of the scoping
  answers. The preflight asks about *format* ("comparison matrix, annotated source list") and
  nothing downstream reads it except as goal prose.
- **Web and native get structurally different outputs.**
  - Web: a standalone Markdown report on the lead model, shown in a card and dialog. The chat turn
    has no answer, just a notice.
  - Native: a 100–200-word chat answer plus an artifact on the user's model
    (`RESEARCH_OUTPUT_CONTRACT`).
- **The corpus goes in the system prompt.** It is the highest-authority slot, although wrapped in
  untrusted envelopes. It is not cached, so a paid revision re-sends everything.
- **Prior research in later turns.** Only the newest completed run's report (≤48k chars) and its
  source list are injected (chat route 2778–2791). Earlier runs in the conversation are invisible.

### 6.6 Speed

- **Sequential DB chatter.**
  - Every search hit: `findFirst`, then `create` or `update`, plus an event.
  - Every worker tool call: `loadRun`, then `bill` (update plus read), plus an event (row lock).
  - The audit: 5 queries × 250 sources before the first judge call.
  - The research worker's own comment puts the DB at about 20 ms RTT away (research-worker.ts
    26–34), so hundreds of ms of overhead per tool call and minutes per run *(derived)*.
- **Barriers in the sweep.** Search waves of 4 and read waves of 8 are strict barriers. One slow
  25 s fetch holds its whole wave.
- **Serial writer and audit.** Synthesis is one 16k-token call with no streaming to the web user.
  The audit is sequential judge calls.
- **Workers have no prompt caching**, so input tokens grow with every turn.
- **The headless path launches a fresh Chromium per page** (crawler 125–134).
- **Stalls after every human action** (B1) add up to about 3 minutes.

### 6.7 Failures and retries

- **Errors are swallowed as empty results.** Provider errors in `utilityCompletion` and
  `writeResearchReport` become `""`. Search errors become `[]`. Fetch errors become `null`. The
  only visible failures are "no plan" and "no sources". An empty report passes as `completed` (B6).
- **No poison-run guard.** A deterministic exception inside a step leaves the run live with its
  lease. The backstop re-adopts it every ~2 min forever, re-paying the step prefix. `drive` has no
  try/catch-to-`failed` and no attempt counter (engine 3552–3614; research-worker 72–75).
- **`MAX_STEPS = 40` resets on every adoption.**
- **Event appends give up after 4 tries and drop the event** (run.ts 259–267). Loss is logged only.
- **Whole-round worker failures are caught**, but `error` workers are not retried within a round,
  and their error messages are not persisted.
- **The lead review is fragile.** A 1,400-token cap and JSON-only output mean truncation drops
  silently to the deterministic review (B23).

### 6.8 Cancellation

- **Nothing is aborted on cancel.** Background drives have no signal (run.ts 927–932). Cancel flips
  the row. Workers notice at the next tool boundary. Planning, synthesis, audit, expansion and
  review calls finish and are billed (B18).
- **Chat Stop does not cancel the run** (B17). No code in the chat route calls `cancel` on abort.
  Native backgrounding a long run's SSE therefore leaves a live run, which the backstop completes
  with the full engine.
- **Discarding a plan sends a "report complete" push** (B19).

### 6.9 Resumability

- **The progress snapshot lacks the round ledger.** `resumeStateFor` depends on `roundsCompleted`,
  `pendingReview`, `elapsedMs` and `wallClockMs`, but the Prisma `progress()` never sets them
  (run.ts 279–297). Consequences (B12):
  - paused in `synthesizing` → resumes to `investigating`, repeating the sweep, pinned reads, seed
    reads and possibly rounds and follow-ups
  - paused at the plan gate → resumes to `planning` and re-plans
  - paused at the clarify gate → `planning`, dropping the questions
- **The wall clock includes paused time** (B13).
- **Lease stall on every resume** (B1).
- **Rounds are resumable** because the review is recorded with the round, which is good. A worker
  killed mid-round loses its transcript, but its findings persist.

### 6.10 Cost control

- A flat $8 per chat run that ignores the monthly budget, with no live-run cap and no rate limit on
  the chat path (B16).
- Reservations at the wrong rates for lead-model stages (B15).
- Worker output cap 2,048 vs an estimate of 700 (B30).
- No writer reserve (B8).
- Duplicate paid stages from lease expiry (B2, B3).
- Re-billed pinned fetches (B10).
- Follow-up sweeps the lead declined (B9).
- A paid revision triggered by false "unsupported" labels (B4).
- `POST /api/research` defaults to **no** per-run ceiling (route.ts 95).
- The worker model is Haiku with no prompt caching. Caching would cut input cost roughly 5–10× on
  long transcripts *(derived)*.

### 6.11 Observability and the UI contract

- The chat activity titles are consumed by native as string contracts.
- There is no typed "phase" or "progress" object. The UI reconstructs everything from raw events
  plus the full run view.
- There is no ETA and no "what is happening right now" field beyond the last event. Wall-clock
  budget and elapsed time only appear in `budget_checkpoint` at round boundaries.
- Worker lanes exist in the timeline (`worker_spawned/tool_call/finished`), but nothing summarises
  "N sources found, M read, K cited" as a single object.

---

## 7. Bugs, with evidence

### B1 — high — A stale lease stalls every post-gate action, and chat "yes" misreports failure

**Evidence**
- `drive()` claims at the top of each iteration and returns on `blocked`, `raced` or `aborted`
  without releasing (engine.ts 3571–3598, 3594).
- Only terminal moves clear the lease (run.ts 113–116).
- `claimRun` requires the lease to be null, expired, or already held by this owner (run.ts 147–153).
- Each trigger gets a new owner: run.ts 931 (`research-web:${runId}:${Date.now()}`) and
  deep-research.ts 356.
- The callers are `plan/route.ts` 52–54, `clarify/route.ts` 55, `control/route.ts` 53–55, and the
  chat confirm path at deep-research.ts 275–277 then 351–357.
- The PM2 worker skips runs with a live lease (research-worker.ts 54). The GET re-drive fires only
  after 3 minutes of no writes (`[id]/route.ts` 38, 52–62).

**Scenario.** The planning step claims at T0. The plan appears at T0+20 s. The user presses Start
at T0+60 s. `decidePlan` moves to `investigating`, and the new driver's claim fails because the
lease is valid until T0+120 s. Nothing runs until the lease expires and a PM2 tick lands (up to
60 s at idle backoff), or until the 3-minute stale poll.

**Chat "yes" path.** The drive returns immediately. `sources.length === 0`, so it returns `EMPTY`
with `state: "investigating"`. The chat route then prints *"Research could not gather enough
evidence…"* and *"Research did not complete"* (chat route 2837–2843). Later the backstop completes
the run with the full engine, and the report never reaches the chat.

**Tests miss it**: they call `drive` without a `workerId` (deep-research-adapter.test.ts 311–339,
398–415).

**Fix.** Release the lease (set it to null) whenever `drive` returns non-terminally. Or key the owner
on the run and allow a claim when `lastHeartbeatAt` is older than a short idle window. Or have the
gate endpoints hand work to the single worker queue.

### B2 — high — The chat hand-off is adopted by the full engine, giving two reports and a racing audit

**Evidence**
- The chat drive claims, then returns at `until` (engine.ts 3572–3595). The run stays in
  `synthesizing`, a working state, with a lease worth 2 minutes.
- The chat model then streams the report and the audit runs; only then does
  `finalizeChatResearchRun` execute (chat route 3546–3609).
- The PM2 worker adopts `synthesizing` runs whose lease has expired (research-worker.ts 51–58), and
  so does the GET stale re-drive. Both use `researchEngine()`, which has `synthesize` and
  `validateReport` (run.ts 589–643).
- Adoption produces a second `writeResearchReport` on the lead model and a second
  `recordCitationAudit(runId)`. That audit does `deleteMany` of the run's claims (claims.ts 310–322)
  and sets `run.report` through `createRevision`.
- `finalizeChatResearchRun` returns early if the run is already terminal (run.ts 954). The durable
  run's report then differs from what the user read.

**Also.** A native chat stream that errors, or is stopped before any text, never reaches the finalize
block. That run is always adopted and completed in the background.

**Fix.** Give the hand-off its own terminal-ish state (`handed_off`), which is not claimable. Or keep
the chat lease alive while streaming.

### B3 — high — Stages longer than the lease are executed twice

**Evidence**
- `step()` passes `heartbeat` only to `doInvestigating` (engine.ts 3506–3519).
- Planning can take brief 30 s + plan 60 s + retry 60 s (tools.ts 45–53, 393–438).
- `writeResearchReport` has no timebox and 16,384 output tokens (tools.ts 693–699).
- Validation is sequential: 250 × 5 DB operations plus 24 judge calls (claims.ts 641–730, 395–431).
- `doCoverage` may call the expander (60 s).
- Any of these crossing 2 minutes lets PM2 or the GET re-drive claim the expired lease and run the
  same stage concurrently. The loser's `advance` fails, but both are billed. The duplicate audit
  races `deleteMany` and `create` on `ResearchClaim`.

**Fix.** Heartbeat inside every model-call stage (a timer while awaiting), and timebox the writer.

### B4 — high — Claims past the judge cap become "unsupported", the report is falsely rewritten, and a paid revision follows

**Evidence**
- claims.ts 408: `if (!settledByText && judgeCalls >= MAX_JUDGE_CALLS) break;` leaves `verdicts = []`.
- claim-analysis.ts 1198: `verdicts.length === 0` → `"unsupported"`.
- claims.ts 435–436: the "unverified" override applies only when `verdicts.length > 0`.
- `repairReportFromClaims` then prefixes *"The cited evidence is insufficient: "* and appends *"(the
  cited passage does not establish this.)"* (claim-analysis.ts 658–700).
- `repaired=true` triggers `shouldRevise` → a second paid synthesis (engine.ts 3439–3464). The
  re-audit hits the same cap.
- `finish` still says `completed` (3466).
- claims.ts 66–68 and domain.ts 1582–1586 claim these are recorded as `unverified`.
- Also: only 40 claims are extracted (claims.ts 60, 277). Tier `judgeCalls` is ignored.

**Fix.** Treat an empty verdict list caused by the cap as `unverified` without repair. Scale the cap
with the tier or the report. Never rewrite prose for `unverified`.

### B5 — high — A truncated planner JSON becomes queries and objectives, with no retry

**Evidence**
- `parseStructuredPlan` returns null on unbalanced JSON (plan-format.ts 136–158, 169–180).
- `parsePlanSections` finds no headings, so the whole text becomes the queries section
  (tools.ts 150–166).
- `parsePlanLines` accepts any 8–400-char line, so `"question": "What …?",` is accepted
  (tools.ts 168–181).
- `hasUsablePlan` returns true, so no retry happens (353–357, 434–438).
- `doPlanning` stores those "queries" and builds objectives from them (engine.ts 1655–1660). They
  are shown at the gate and searched.
- Output cap: `PLANNER_OUTPUT_TOKENS = 2,048` (domain.ts 1531) for the deep/max shape.

**Fix.** Raise the cap (4–6k). Use a provider's structured-output or tool mode. Treat JSON-looking
text as unusable for the legacy parser.

### B6 — high — A failed writer ends the run `completed` with an empty report

**Evidence**
- `writeResearchReport` catches and returns `report: ""` (tools.ts 706–711, 730).
- `doSynthesis`: `const report = written.report.trim() || revision?.report || ""` (engine.ts 3306),
  then advances.
- `doValidation` skips the audit on an empty report (3333). No dangling markers are found, and
  `auditDegraded` is false → `completed` (3466–3477).

**Fix.** An empty or too-short report → retry once, then `failed`/`partially_completed` with a
reason.

### B7 — high (likely, config-dependent) — The synthesis prompt can far exceed any context window

**Evidence**
- `citableSources` = every row with a snapshot, up to 250 (engine.ts 788–790).
- Search hits with a raw body are stored with a snapshot (1796–1817). Tavily sends
  `include_raw_content: true` (search-engine.ts 553).
- The corpus inlines each body up to 12,000 chars (corpus.ts 187–198). 250 × ~12.7k ≈ 3.2M chars,
  about 800k tokens.
- This goes to `writeResearchReport` (tools.ts 674–699) and, on native, into the chat model's
  system prompt (deep-research.ts 387, chat route 2819).
- `SYNTHESIS_FINDINGS_CHARS` (domain.ts 1688) is declared for this purpose and never used.
- Result: provider rejection → B6 (web) or a failed chat turn → B2 (native).

**Fix.** Rank and pack the corpus to a token budget per model: findings first, then passages
relevant to each objective, then the rest by relevance.

### B8 — high — Investigation can starve the writer, leaving no report

**Evidence**
- Round reservation checks only the worker estimate against what is left (engine.ts 2771–2776).
- Worker model cost is billed after the round (2865).
- `step()` stops for budget as soon as spend ≥ ceiling (3495–3497).
- Synthesis stops if its estimate is unaffordable (3285–3289).
- Both paths end `partially_completed` with `report = null` for full-engine runs, meaning every
  web-confirmed run.

**Fix.** Reserve the synthesis and audit estimate before each round.

### B9 — medium-high — Follow-up sweeps override the lead's decision to synthesize

**Evidence**
- `computeCoverage` turns every objective whose lead score is under 0.8 into a gap, whatever
  `review.decision` or `review.gaps` say (engine.ts 1127–1151).
- `doCoverage` schedules follow-ups while `followUpRound < min(4, rounds−1)` (3158–3233).
- The next `investigating` pass skips workers because the last decision was `synthesize` (2711–2712).
- The result is a search-only sweep plus seed re-read that nobody reviews, up to 2 times on deep/max.
- The lead prompt explicitly says to leave hopeless gaps out (lead.ts 49).

### B10 — medium — Pinned sources are re-fetched and re-billed on every investigating pass

**Evidence.** `doBrowsing` loops over all `plan.pinnedSources` with no snapshot check
(engine.ts 1859–1918). Every follow-up pass, every steer to `investigating` (3772–3775) and every
resume repeats every fetch, fee and event.

### B11 — medium — Duplicate `source_read` narration, and passages rewritten on every pass

**Evidence**
- A fetched target emits `source_read` at 2236–2238 or 2260–2262, and **again** at 2270–2272 for
  every ranked target, including ones not fetched this pass.
- `savePassages` does `deleteMany` + `createMany` for every target on every pass (2265–2269,
  run.ts 385). Claim links cascade on passage delete (schema `ResearchClaimLink.passage onDelete:
  Cascade`), so a re-read after an audit orphans the claim graph.
- Chat shows duplicate *"Reading source"* rows (deep-research.ts 152–161).

### B12 — medium — Resume computes the wrong stage

**Evidence**
- `progress()` omits `roundsCompleted`, `pendingReview`, `elapsedMs` and `wallClockMs`
  (run.ts 279–297), so `resumeStateFor`'s round and clock branches never fire (domain.ts 292–298).
- A run paused in `synthesizing` with no report yet → `investigating`.
- A run paused at `awaiting_plan_confirmation` or in the clarify states → `planning`. The planner
  runs again, is paid again, and overwrites the reviewed plan (`planConfirmed` is false).

### B13 — medium — Paused time consumes the investigation wall clock

**Evidence.** `investigationElapsedMs = now − budget.startedAt` (domain.ts 1330–1333). There is no
pause accounting. The round gate at engine.ts 2726 checks it, so a run paused longer than its tier
clock resumes with no investigation. research-workspace.md claims paused time is not counted
(that claim is about the UI clock only).

### B14 — medium — Head-of-line blocking in the PM2 backstop

**Evidence.** `tick()` awaits `Promise.all` of every claimed drive before returning
(research-worker.ts 61–80), and `main` awaits `tick` (95–108). One 30–60-minute run blocks adoption
of every other stranded run for its whole duration.

### B15 — medium — Model-stage reservations use the wrong rates

**Evidence**
- `PLAN_ESTIMATE`, `EXPANSION_ESTIMATE`, `CLARIFY_ESTIMATE`, `synthesisEstimateMicroUsd` and
  `CITATION_AUDIT_ESTIMATE` all use `REFERENCE_MODEL_RATES` of $3/$15 (engine.ts 694–767,
  domain.ts 1498–1499, 1628–1637).
- The planner, clarifier, expander and writer run on `researchLeadModel()`, which picks the maximum
  intelligence (worker.ts 140–157; tools.ts 127–134, 316, 619, 669). With Claude Fable 5.1 that is
  $10/$50 (model-metrics.ts 57, pricing.ts 137).
- Under-reservation of about 3.3× → the ceiling is crossed by the writer.

### B16 — medium — Chat research bypasses the monthly budget and the concurrency and rate caps

**Evidence**
- Fixed `CHAT_RUN_BUDGET_MICRO_USD` (deep-research.ts 91–95, 266). No `checkBudget` anywhere in the
  research code.
- The PRO monthly budget is €11 (spend.ts 59–65).
- `MAX_LIVE_RUNS`, the rate limit and the plan check live only in `POST /api/research`
  (route.ts 33, 51–86).

### B17 — medium — Chat Stop or disconnect does not cancel the run, and the backstop finishes it

**Evidence.** `drive` returns on `signal.aborted` (engine.ts 3594), leaving a working state. There is
no cancel in the chat route (grep: no `cancel`/`decidePlan` near 2793–2844). The backstop adopts the
run with the full engine (research-worker.ts 51–58).

### B18 — medium — Cancel does not abort in-flight calls

**Evidence**
- `driveResearchInBackground` passes no signal (run.ts 927–932), so `writeResearchReport`, the
  audit, the planner and the lead run to completion after a cancel.
- Workers poll the state only between tool calls (engine.ts 2472–2480).

### B19 — medium — Plan discard sends a "Research report complete" push

**Evidence**
- `finish` pushes `status: to === "failed" ? "failed" : "completed"` with the summary *"Research
  report complete"* (engine.ts 1438–1448).
- `decidePlan(cancel)` calls `finish(run, "cancelled")` (3627).
- `runDeepResearch` cancels parked plans on each new research turn or non-yes reply
  (deep-research.ts 254–259, 279, 284).

### B20 — medium — The chat research goal is the clarification wrapper and has no conversation context

**Evidence**
- `researchPrompt` = last `USER` message in `modelHistory` (chat route 2794–2795). With a preflight
  answer, that message is `formatPreflightClarificationModelMessage` (route 1666, 1825, 1868;
  preflight-clarification.ts 164–190).
- The goal is persisted (up to 8,000 chars) and shown as the question in the panel.
- It is truncated to 300 chars in the writer header (corpus.ts 205).

### B21 — medium — The effective tier differs from what is advertised

**Evidence**
- The page ceiling is `Math.min(MAX_SOURCES, budget.pages)` with `MAX_SOURCES = 250`
  (engine.ts 770, 2738), so deep = max = 250.
- Seed and hop fetches count against it (2737).
- The worker reservation caps round-1 workers (2771–2776). §5.1 derives ≈4/3/2 workers for
  standard/deep/max under $8 with Haiku.
- The UI copy promises `RESEARCH_TIERS` numbers (effort-copy.ts 35–45, run-controls.tsx 469–473).
  The native copy is different again (NativeResearchEffort.swift 38–45).

### B22 — low-medium — `judgeCalls` and `MAX_UNVERIFIED_SHARE` are dead

**Evidence**
- `judgeCallsForEffort` (domain.ts 1596–1598) and the tier `judgeCalls` field have no caller. The
  audit uses the constant `MAX_JUDGE_CALLS` (claims.ts 408).
- `MAX_UNVERIFIED_SHARE` (domain.ts 1608) is never read. `doValidation` ignores unverified
  (engine.ts 3466). Both doc comments describe behaviour that does not exist.

### B23 — low-medium — The lead review is truncation-prone and falls back silently

**Evidence.** `REVIEW_OUTPUT_TOKENS = 1,400` locally (lead.ts 31), while the estimate uses 2,048
(domain.ts 1686). A JSON with a paragraph brief per gap for up to 8 objectives overflows. Parse
failure → `deterministicReview` (lead.ts 262–263). Nothing records that the fallback happened.

### B24 — low — Steering has narrow effect

**Evidence**
- A URL is re-fetched only when steered during `reviewing` (`REFETCH_FROM`, engine.ts 3875–3877).
- A URL steered mid-investigation after browsing is not read unless a follow-up pass happens.
- Constraints do not reach running workers.
- Steering during `synthesizing` returns `ok` but changes nothing.
- The composer steering heuristic treats any http text as a source (use-conversation-run.ts 78–79).

### B25 — low — All `error` events are narrated as "A source could not be read"

**Evidence.** deep-research.ts 210–215 versus error payloads for no worker model, idle round, audit
failure and dangling citations (engine.ts 2907–2940, 3381–3426).

### B26 — low — Polling cost

**Evidence**
- The run view loads every snapshot on each poll (run.ts 808 → 398–418) at a 2.5 s cadence.
- Conversation discovery polls every 4 s indefinitely for every open conversation
  (use-conversation-run.ts 43–58).

### B27 — low — The research spend ledger is split and incomplete

**Evidence**
- `kind:"chat"` for clarify, brief, plan, expand and writer (tools.ts 260–270, 719–729).
- `kind:"research"` for workers and lead (worker.ts 223–231, lead.ts 249–259) and vendor fees
  (run.ts 525–533).
- Preflight triage is unbilled (preflight-triage.ts 253–290).

### B28 — low (config-dependent) — Headless crawler hardening

**Evidence**
- `--no-sandbox` Chromium on arbitrary pages (crawler.ts 125–134).
- Only media resource types are blocked. Redirects and subresources are not host-filtered, which is
  an SSRF surface with `RESEARCH_HEADLESS=1`.
- `data:` URLs bypass the host check (105, 293).
- Whitespace is flattened (227).
- A new browser is launched per page.

### B29 — low — Regex denial of service in `find_in_page`

**Evidence.** `compileFindPattern` accepts alternation groups with quantifiers such as `(a|aa)+$`
(protocol.ts 506–517). These run on 1.2k-char chunks inside the web process.

### B30 — low — Worker estimates versus reality

**Evidence.** Adapter `max_tokens: 2048` (worker.ts 268, 373) versus `WORKER_OUTPUT_TOKENS = 700` in
the reservation (domain.ts 1674). There is no `cache_control` on the Anthropic worker transcript
(worker.ts 265–275).

### B31 — low — Relevance-blind seed ranking

**Evidence.** engine.ts 2091–2096 sorts by `composite`, then authority, then fetch time. The query
match and search engine rank are discarded.

### B32 — low — Parked plans never expire

**Evidence.** There is no TTL on `awaiting_plan_confirmation`. The chat path only cleans them per
conversation (deep-research.ts 243–259). They count toward `MAX_LIVE_RUNS` on the POST route
(route.ts 75–77).

### B33 — low — Poison runs retry forever

**Evidence.** There is no attempt counter and no fail-on-exception in `drive`
(engine.ts 3552–3614). `driveResearchInBackground` and the PM2 worker only log
(run.ts 933–935, research-worker.ts 72–75).

### B34 — low — Engine clarifier, `ClarifyGate` and `/clarify` are dormant

**Evidence.** Only `POST /api/research` creates runs that reach `doClarifying` with a clarifier
wired. No client calls it; `use-conversation-run.ts` and `use-research-run.ts` never POST to
`/api/research`.

---

## 8. Dead code, drift and documentation mismatches

**Code that exists but never runs**
- **Never emitted or used**: `awaiting_user_input`, `plan_revised`, `page_summarized`,
  `ResearchSource.summary`.
- **Never used by production code**: `SummarizePageInput`, `pageOpenEstimateMicroUsd`,
  `SUMMARY_PROMPT_CHARS`, `SUMMARY_OUTPUT_TOKENS`, `REVIEW_PROMPT_CHARS`,
  `SYNTHESIS_FINDINGS_CHARS`, `PAGE_DIGEST_CHARS`, `SEARCH_DIGEST_CHARS`, `FIND_DIGEST_CHARS`,
  `judgeCallsForEffort`, `MAX_UNVERIFIED_SHARE`, and `citedMarkers` (a duplicate of engine
  `citationMarkersOutsideCode`, with a different fence regex).
- `wallClockExceeded`, `roundsCompleted` and `pendingReview` only feed `resumeStateFor`, and nothing
  supplies them.

**Constants whose names or comments overstate what happens**
- `MAX_FOLLOW_UP_ROUNDS = 4` ("Increased to 4 for OpenAI-style deep recursive research"), but the
  effective maximum is `rounds−1`, which is at most 2.
- The per-tier `pages` of 320/480 is clipped to 250.

**Documentation that is out of date**

| Where | Says | Code does |
|---|---|---|
| `docs/research-workspace.md` | Planning runs on a "capable-but-cheap model (`researchPlannerModel`, Claude Haiku when configured)" | Uses the strongest model (tools.ts 127–134) |
| `docs/research-workspace.md` | The sweep uses `fallbackResearchQueries` "when the planner fails" | The run fails (engine.ts 1648–1654) |
| `docs/research-workspace.md` | Paused and parked time "is not counted" | True for the UI clock only; the engine clock counts it |
| `docs/JUNO.md` 735–738 | Tier numbers (480 pages) and "Chat defaults to deep" | Effective ceiling is 250; the chat tier is derived |
| Prisma comments | State list; `ResearchFinding.locator` "into the source's passages" | List omits clarify states; the locator is a chunk index |
| `claims.ts` 66–68 | Cap → "unverified" | Cap → unsupported (B4) |
| `deep-research.ts` header | "native clients retain their existing streaming hand-off" | True, but the hand-off is not protected (B2) |

---

## 9. Test coverage gaps

- **Lease semantics across a gate, pause or abort with real worker ids** (B1). All adapter tests
  drive without a `workerId`.
- **The chat hand-off with an expired lease adopted by a full engine** (B2), and any stage outliving
  the lease (B3).
- **Audit behaviour at and past the judge cap** (B4), and more than 40 claims.
- **A planner reply truncated mid-JSON** (B5).
- **An empty writer result → terminal state** (B6).
- **Corpus size or token budget per model** (B7).
- **Writer reserve under a tight budget with worker overspend** (B8).
- **Follow-ups after a lead `synthesize`** (B9), and pinned re-fetch across passes (B10).
- **Resume from paused in synthesizing, plan gate or clarify gate against the Prisma-shaped
  progress** (B12). The current test feeds synthetic progress.
- **Push semantics on cancel or discard** (B19).
- **The clarification-wrapped goal** (B20).

---

## 10. Recommendations for the rebuild

### P0: fix before or alongside any UI work (small, high impact)

1. **Leases.**
   - Release on every non-terminal return.
   - Heartbeat during every stage: a timer while awaiting a model.
   - Make the chat hand-off non-claimable (a `handed_off` flag, or keep renewing while streaming).
   - Stop spawning drivers from the web process: enqueue and let one worker own execution.
   - Fix `research-worker` to run adopted drives concurrently without blocking the tick.
2. **Audit correctness.**
   - A cap-induced empty verdict → `unverified` with no rewrite.
   - Do not trigger a revision for `unverified`.
   - Scale the judge calls. Audit all claims, or sample and say so.
3. **Planner.**
   - Structured output (tool or JSON mode) with a 4–6k cap.
   - Reject JSON-looking text in the legacy parser.
   - Inject today's date and the user locale into every research prompt.
4. **Writer.**
   - Pack the corpus to a model-specific token budget (findings → relevant passages → the rest).
   - Timebox the call.
   - An empty report → retry, then `failed`.
   - Reserve writer and audit money before each round.
5. **Cost.**
   - Per-run ceiling = f(plan, remaining monthly budget).
   - Live-run cap and rate limit on the chat path.
   - Price lead stages at the lead's actual rates.
   - Anthropic prompt caching for workers.
   - Consistent `kind: "research"` ledger rows; bill triage.
6. **Cancel, Stop and Resume.**
   - Wire an AbortController per run, triggered by cancel through a DB flag polled by the driver.
   - Chat Stop cancels, or explicitly detaches to the background with user-visible copy.
   - Persist the round and clock fields for resume; subtract paused time.
   - Never re-plan a paused plan-gate run.

### P1: architecture for the redesign

- **One execution path.**
  - Every run, from web or native, goes through the durable engine in the worker process.
  - Chat turns subscribe to its event stream.
  - The report is written once, by one writer policy. Either the user's selected model (Claude and
    ChatGPT both answer in-thread) or a dedicated research writer, but the same on all clients.
  - Stream the report tokens as events so the web chat shows it live and the thread gets a real
    answer message plus the document.
- **Scoping.**
  - One clarifier, preflight style with option questions, whose answers are stored as structured
    `constraints` and a `deliverable` (audience, format, timeframe, geography) on the plan.
  - Keep `goal` as the user's original words, plus a resolved goal that uses conversation context.
- **Budget, not tiers** (§5.4). Size from the decomposition, entitlement and remaining budget, with
  one optional *Extended* or *Keep researching* control. Show plain facts at the plan gate from the
  frozen budget.
- **Ranking and diversity.**
  - Relevance first: search rank fusion + passage relevance + authority.
  - Per-host caps in reads and the corpus.
  - Treat raw-content hits as candidates, not "read", until ranked.
- **One segmentation** (chunks = passages = citation units), shared by workers, the audit and the
  inspector. Findings should seed the audit as pre-verified quote links.
- **A typed progress contract for the UI.** A single SSE, or the poll view, carrying:
  - `phase`: understanding | planning | searching | reading | analyzing | writing | verifying | done
  - `activeWorkers[]`: objective, current tool, current URL
  - `counts`: sources found / read / cited, findings, rounds
  - `clock`: elapsed and budget, excluding pauses
  - `spend` against the ceiling
  - `lastActivity`

  This lets the redesigned thinking animation and right sidebar render smoothly without
  reconstructing from raw events. Freeze and version the chat activity titles that native parses,
  or move native to the typed contract.
- **Performance.**
  - Batch source upserts and event appends (one transaction per wave).
  - Stop loading snapshots in the run view (use a computed `read` column or `length()`).
  - Move syndication off the request process.
  - Reuse one headless browser with a context pool, if kept.
