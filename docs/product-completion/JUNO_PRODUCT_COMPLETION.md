# Juno Product Completion — execution ledger

**Audit commit:** `5447c1cf` (`feat/juno-work`, local production-hardening commit)
**Audit date:** 2026-08-08
**Method:** 12 parallel evidence-based subsystem readers over the source, then an
adversarial re-check of every claim of "implemented" in the P0 areas. Findings
cite `file:line`. Documentation was not accepted as evidence that anything is wired.

This file is an execution ledger, not a design document. It records what is
true, what was built, and what is next. `status.json` beside it is the
machine-readable form. The historical findings below are retained for
traceability; the reconciliation immediately below is the current source of
truth.

## Current reconciliation — 2026-08-08

The current source tree now has passing repository-wide automated checks:
**1,934 tests completed, 1,932 passed, 2 database-dependent tests skipped without a test
database, 0 failed**; full ESLint, TypeScript, Prisma validation/generation,
native/capability/Work contract checks, code wiring checks, sandbox checks, and
design-contract checks also pass. The production Next build renders 110/110
static pages successfully. The focused research evidence suite is 53/53,
including the deterministic 100-claim validator benchmark. The full
`JunoChatKitTests` target is 213/213, and unsigned JunoDesktop/JunoMobile
Simulator builds pass with warnings treated as errors.

Since the 2026-08-07 audit, the following slices are real and wired into
production entry points:

- Knowledge extraction and retrieval cover PDF, DOCX, PPTX, XLSX and text with
  durable document/block/chunk/index-job rows, bounded OCR fallback, versioning,
  bounded hybrid retrieval, citations and honest degraded states.
- Unified search fans out across the account corpus with snippets, marked terms,
  destinations and per-source coverage; Library versions, tombstones, quotas
  and revision restore are wired.
- Memory suppression/lifecycle gates every write path, with categories,
  deduplication, contradiction/supersession and expiry.
- Shared spend reservations and the ApiSpend ledger cover chat, voice, Work and
  research vendor fees; the personal account defaults to a finite €15 monthly
  ceiling.
- Artifact exports are re-opened and verified before Office/design bytes are
  served; package inflation, formula, asset, markup and preview-egress checks
  fail closed. Model sync opens a reviewed PR instead of deploying a
  bot-discovered model.
- Research now persists objectives, evidence requirements, coverage, conflicts,
  source snapshots and policy scores; it performs a bounded follow-up, stores a
  claim/citation graph, validates before terminal completion, and preserves both
  the delivered draft and repaired report revisions.
- Native chat approvals now decode non-terminal SSE approval frames, recover
  pending/recent receipts from `/api/approvals`, render a shared macOS/iOS
  approval card with exact redacted detail and expiry, and submit decisions only
  with the displayed `receiptDigest`. The focused native contract test covers
  the stream, recovery query, decision route and digest.
- Provider/Juno import ZIPs now fail closed on entry-count, per-entry/aggregate
  inflation, compression-ratio and case-folded-duplicate budgets; deliverable
  validators preflight package budgets before inflating XML or markup.
- Import restore now claims a per-account archive SHA-256, stages attachment
  objects in a durable ledger, commits relational state serializably, and has
  scoped cleanup/recovery plus a parser-lease sweeper for crash windows.
- Account-wide library quota writes are rechecked under a PostgreSQL account-row
  lock across web/native uploads, generated media, replacements and imports;
  newly written objects are compensated when relational persistence fails.

The core product slices are ready for a controlled production release, but the
release program is not fully closed. Remaining gates are explicit in
`status.json`: authenticated browser/native journeys and visual/accessibility
matrices; a tested database/object-storage restore drill; and signed/notarized
Apple artifacts. The production workflow now fails closed: protected
`PROD_ENV` must contain `JUNO_SMOKE_TOKEN` or `JUNO_SMOKE_COOKIE`, and the
authenticated smoke always runs catalog, provider-backed chat, durable receipt
and idempotent replay checks. The live server was checked read-only:
`https://chat.liams.dev/api/health` returned `ok`/`db: ok` for artifact
`546808a9eae0f5adc192b2a214bb8dbfeaecc6e3`. The remote production checkout and
database report 72 applied migrations and an up-to-date schema. The current
source at `5447c1cf` contains three import-recovery migration changes beyond
that live artifact; no production deploy or migration was executed in this run.

---

## 1. Headline

Juno is a genuinely large, unusually well-built product with strong foundations
in the places that are hard to retrofit — a shared design token system spanning
web and Swift, generated capability/Work contracts that gate native drift, a
real per-turn budget guard, event-cursor resumability for Work runs, and a
codebase whose comments explain *why*. It is **not** yet the product the
completion program describes, and the gap is concentrated in five places:

1. **Knowledge.** There is no retrieval layer at all. No PDF, DOCX, PPTX or
   XLSX structured extraction; no chunking; no embeddings; no citations to a
   page or cell. Project context is extracted file text concatenated into the
   prompt. This is the single largest missing capability and it blocks the
   Notebook/Student product entirely.
2. **Cost.** The "one cost budget" premise does not hold. Work runs and voice
   sessions never write to the spend ledger, deep research never bills its
   search fees, and provider SDK auto-retries re-bill outside the guard's view.
   The personal owner account has no ceiling at all.
3. **Research.** Deep research is an in-request pipeline, not a durable job. It
   cannot survive a restart, be paused, steered, or resumed, and there is no
   claim-citation graph and no citation validator.
4. **Memory.** Suppression ("forget this") is enforced on the extraction path
   only and is bypassable through every manual write path. There is no
   contradiction detection, no supersession, no expiry, no typed categories.
5. **Search.** Global search is title-and-recent-message shaped, not the unified
   corpus the program describes.

The approval broker — the program's declared first slice — is **done in this
run** (§3 below).

Two findings are contractual/legal rather than technical and are the owner's
call, not an engineering one. They are recorded in §6.

---

## 2. Capability matrix

State vocabulary: `verified` (wired to a real entry point **and** covered by a
named test) · `implemented` (wired, untested) · `partial` · `unwired` (code
exists, nothing calls it) · `missing` · `unsafe` (exists, with a hole).

### §4 Universal approval broker — **now complete** (was: unwired)

| Requirement | State | Evidence |
|---|---|---|
| Five risk classes, `unknown` fails closed | verified | `src/lib/action-approval.ts:158` `classifyExternalAction`; `:218` `effectiveActionRisk` maps `unknown`→`external_write` |
| Receipt binds account/session/tool/args-hash/policy/provenance/expiry | verified | `src/lib/action-approval.ts:260` `ActionReceiptBinding`; `:320` `actionReceiptDigest` |
| Argument mutation invalidates the receipt | verified | `src/lib/action-approval-store.ts:413-420` re-hashes and re-resolves policy immediately before consumption |
| One-time atomic consumption | verified | `action-approval-store.ts:423-436` conditional `updateMany` → `executing`; `count !== 1` loses |
| **Every connector dispatch passes the broker** | verified | `src/lib/mcp.ts:294` `execute()`; gate `scripts/check-approval-dispatch.mjs` passes |
| Anthropic native-MCP bypass removed | verified | `mcp.ts` / `llm.ts` / `anthropic.ts` no longer reference `mcp_servers`; enforced by the gate |
| Policies, lockdown, per-connector blocklist | implemented | `action-approval.ts:226` `decideActionPolicy`; settings surface in `src/components/settings/permissions-section.tsx` |
| Approval API + web UI | implemented | `src/app/api/approvals/`, `src/components/chat/approval-card.tsx` |
| Unattended callers refuse rather than hang | verified | `action-approval-store.ts` `unattended`; used by `scripts/work-trigger-poller.ts` |
| Skill/plugin security scanning (§4.4) | **missing** | no scanner exists |
| Egress allowlists (§4.4) | **unwired** | CSP is `Report-Only` (`src/middleware.ts:111`) |

### §5 Knowledge engine — **the largest gap**

| Requirement | State | Evidence |
|---|---|---|
| PDF structured extraction | missing | only Anthropic receives PDFs (`src/lib/anthropic.ts:377-386`) |
| DOCX / PPTX / XLSX extraction | missing | `isTextExtractable` excludes them |
| OCR + confidence | missing | — |
| Knowledge entities (Document/Version/Block/Chunk/IndexJob) | missing | no such models in `prisma/schema.prisma` |
| Hybrid retrieval (lexical + vector + rerank) | missing | `src/lib/chat/context-assembly.ts` concatenates recent messages + full file text |
| Citations to page/slide/sheet/cell | missing | — |
| Indexing state machine | missing | — |
| **Projects UI shows an indexing state that does not exist** | **unsafe** | `src/app/(app)/projects/[id]/page.tsx:1197` a `setTimeout(…, 1900)` cosmetic progress bar with no server call behind it |
| **PDFs silently degrade on non-Anthropic models** | **unsafe** | `src/lib/openai-compat.ts:84`, `openai-responses.ts:84` emit a filename placeholder; `gemini-search.ts:23` drops it with no placeholder at all |
| Upload safety (MIME sniffing, neutral stored type) | verified | — |

### §6 Search and Library

Server-side conversation search is `unwired`; message-content search, snippets,
filters and jump-to-message are `partial`; semantic retrieval, file versions,
parser state, quotas and restore are `missing`. Cross-account isolation **is**
proven by test on both web and native. Search exists on macOS and iOS.

### §7 Memory

| Requirement | State | Evidence |
|---|---|---|
| Suppression survives reprocessing | verified | `saveCandidates` applies `isSuppressed` |
| **Suppression bypassable via manual writes** | **unsafe** | `src/app/api/memory/route.ts:63`, `memory/edit/apply/route.ts:64-73` write `MemoryEntry` directly with no suppression check |
| **Consolidation bypasses background-provider policy** | **unsafe** | `src/lib/memory.ts:697-713` calls `streamChat` with no `resolveBackgroundCandidates`; `maybeConsolidate` always supplies a model (`:770`) |
| **"Regenerate summary" and NL memory edit fail under the default policy** | **unsafe** | `memory/edit/route.ts:83-92` passes no policy/provider → `same_provider` against `null` → zero candidates, reported to the user as a rate-limit |
| Categories, dedup, contradiction, supersession, expiry | missing | — |
| Private mode never contributes to memory | verified | — |

### §8 Research

Durable job: `missing` (in-request pipeline). Editable plan, pause/resume/steer,
browser worker, claim-citation graph, citation validator, source snapshots: all
`missing`. **Citation URLs were rendered as clickable links with no scheme
check** — fixed in this run (§3).

### §10 Artifacts

Structured DOCX/XLSX/PPTX authoring from a typed spec is `verified`, and the
Work pipeline **does** re-open and validate what it produces. But XLSX formulas,
charts and named ranges are `missing`, and **the chat canvas export route
streams Office bytes nobody re-opened** (`src/app/api/artifacts/[id]/export/route.ts:107-113`
never imports `validateDeliverable`) — `unsafe`, and directly contrary to
program rule 15.

### §11 Agent experience

Strong. Steering, event-cursor reconnect, run detail derived from real state
(not a fake percentage), PR workflow, reviewable diffs, secret protection and
verification summaries are all implemented or verified. Missing: a unified
Home/Inbox across the four surfaces, shared files, LSP/symbol index/semantic
repo search, and auto-pause on repeated schedule failure.

### §12 Skills and connectors

Manifest, stable id, trust level and permission-request semantics are verified.
Missing: semver, security scanning, consent on permission expansion, a plugin
concept, and a sandboxed interactive host. **Imported skill instructions are
concatenated verbatim into the system prompt with no `wrapUntrusted` envelope**
(`scripts/work-runner.ts:1997-2003`) — `unsafe`, and the exact prompt-injection
shape §4.4 exists to prevent.

### §13 Design, UX, motion, accessibility

The design token system and motion vocabulary are real, documented, and **shared
with Swift so web and native cannot drift** — a genuine asset, to be preserved.
Native reduced-motion handling is verified; web is `partial`, and the Work
surfaces are the hole (`DesktopWorkWorkspace.swift:734,816` animate
unconditionally). No Playwright/E2E/visual-regression layer exists at all.

### §15 Reliability and cost

| Requirement | State | Evidence |
|---|---|---|
| Per-turn mid-stream cost abort | verified | `src/lib/chat-budget-guard.ts` |
| Monthly ceiling per plan | implemented | `src/lib/spend.ts:28` |
| **Work runs are off the spend ledger** | **unsafe** | no `recordSpend` anywhere under `src/app/api/work/`, `src/lib/work/`, or `scripts/work-runner.ts`; cost lands only on `WorkRun.costMicroUsd`, which `checkBudget` never reads |
| **Voice is entirely off-ledger** | **unsafe** | `src/app/api/voice/relay-token/route.ts:29` checks budget at token mint only; the relay meters cost but never persists it |
| **Research search fees are free to the ledger** | **unsafe** | `src/lib/deep-research.ts:335` fans out Tavily calls in parallel; only the planner model is billed |
| **Retries bypass the guard** | **unsafe** | `maxRetries: 2` on all three adapters; the guard only sees the surviving stream. `checkBudget` is read-then-act with no reservation or row lock |
| **Personal/OWNER account has no ceiling** | **unsafe** | `BUDGET_EUR.OWNER = null` — this is precisely what §15.4 asks for and it does not exist |
| Capability probe runner | missing | capability is a static table |
| **Nightly model sync deploys to production unreviewed** | **unsafe** | `.github/workflows/sync-models.yml:108` commits and pushes to `main`; `deploy.yml` triggers on push to `main` |
| Canary / restore drill | missing | — |

---

## 3. What was implemented in this run

**Slice `approval-broker` — Universal trust, permissions and approval broker (§4, §19).**

The domain module, receipt store, migration and static gate already existed in
the working tree but were wired to nothing: `authorizeExternalAction` had no
callers outside its own test, and `scripts/check-approval-dispatch.mjs` failed
with five errors. This run closed that.

1. **Enforcement at the chokepoint.** `src/lib/mcp.ts` `execute()` now calls
   `authorizeExternalAction` before `client.callTool` and settles the receipt
   with `completeExternalAction` on both success and failure. Refused and
   replayed authorizations return before the network sink.
2. **The Anthropic bypass is gone.** Connectors used to be handed to Claude as
   native `mcp_servers` with a Juno-minted bearer token, so Claude called the
   connector server-side and Juno never saw the individual call — no policy, no
   receipt, no audit row could sit in front of it. One provider able to act on
   the user's accounts without passing the broker makes the broker advisory.
   `streamAnthropic` now declares connectors as ordinary client tools and runs a
   bounded tool loop (`MAX_TOOL_ROUNDS = 6` + one forced-answer round), matching
   the OpenAI adapters. `tool_choice: {"type":"none"}` on the final round is
   documented by Anthropic as compatible with manual extended thinking; thinking
   blocks and their signatures are preserved and replayed so the turn stays valid.
3. **Usage accounting corrected for the new loop.** The Anthropic accumulator
   took a maximum across the stream, which was right for one request and wrong
   for six: each tool round is a separately billed request that re-sends the
   whole conversation. Usage is now max-within-round, summed-across-rounds.
4. **Unattended callers fail fast.** A trigger poll or background sweep has
   nobody to answer an approval; it would have stalled for the receipt's full
   TTL and then failed anyway. `unattended: true` turns "ask" into an immediate,
   recorded refusal. `scripts/work-trigger-poller.ts` uses it.
5. **The approval reaches the person.** New `{ type: "approval" }` on both
   `LlmEvent` and `StreamChunk`; the chat route forwards it while the tool loop
   is blocked; `use-chat.ts` attaches it to the live message, replacing by id so
   a stale card cannot be answered.
6. **API and UI.** `src/app/api/approvals/` (list + decide, digest-bound,
   typed refusal codes mapped to HTTP status), `src/components/chat/approval-card.tsx`
   (exact redacted arguments, untrusted-provenance warning, live expiry, scope
   allow only where `canAllowScope`), `src/components/settings/permissions-section.tsx`
   (policy, lockdown, per-connector blocklist).
7. **Private mode made honest.** The private path announced "Connected tools
   ready" while `streamChat` silently disabled them. An approval receipt is a
   durable security record and writing one is exactly what a private chat
   promises not to do, so private mode now declines the capability and says so.
8. **Untrusted source URLs cannot become links.** Deep research passed
   Tavily-supplied URLs straight to `href`. `isRenderableSourceUrl` now gates
   both the inline chip and the source list at the render chokepoint — the one
   place every producer converges — showing non-http(s) sources as inert text
   rather than dropping the citation.
9. **Native chat approval parity is now wired.** `NativeChatAPIClient` decodes
   approval SSE frames as non-terminal events, recovers recent receipts from
   `/api/approvals`, and verifies the server echoes the displayed receipt
   digest before accepting a decision. `NativeConversationStore` keeps the
   approval state account/session scoped, and the shared
   `NativeChatApprovalCard` is rendered by both macOS and iOS with exact
   redacted detail, expiry, Allow once, scoped allow when permitted, and Deny.
   `NativeChatAPIClientTests.testChatApprovalStreamRecoveryAndDigestBoundDecision`
   covers the wire contract; the full JunoChatKit target and both app builds
   pass.

---

## 4. Architectural decisions

- **One chokepoint, defended statically.** `scripts/check-approval-dispatch.mjs`
  is an AST-level gate, not a grep: it pins the `client.callTool` inventory to
  exactly one file, asserts the ordered sequence (await authorize → inspect
  `.kind` → handle `refused`/`replay` → dispatch → settle both outcomes), and
  forbids the provider-native MCP identifiers by name. A comment, a string or a
  reformat cannot make a missing gate look present. This is what makes the slice
  a permanent regression test rather than a one-time review.
- **Speed was traded for auditability on Anthropic.** Native MCP was faster.
  It is gone because a permission system with one provider-shaped hole in it is
  not a permission system.
- **Reads need no receipt; writes always get one.** A `read_only` action under an
  allowing policy returns early with no row. Every write or `unknown` call gets a
  receipt even when policy auto-allows it, so the audit can name the policy that
  admitted it.
- **Provenance defaults to untrusted.** Model-authored tool arguments are marked
  `derivedFromUntrusted` unconditionally rather than only when taint can be
  proven — by the time a tool loop composes its second call it has already read
  connector output.
- **Idempotency is `(sessionId, callId)`.** Chat uses the generation id, Work the
  run id. A reconnected or resumed run recognises an action it already brokered
  instead of asking twice and executing twice.

---

## 5. Migration and rollback

`prisma/migrations/20260807213000_universal_action_approvals/migration.sql`

Additive and idempotent throughout: `ADD COLUMN IF NOT EXISTS`,
`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and constraints
wrapped in `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$`. It can be
replayed safely.

- Adds `Settings.actionApprovalPolicy` (default `'ask_for_any_change'`),
  `Settings.lockdownMode` (default `false`), `Settings.blockedConnectors` (default `{}`).
- Adds tables `ActionApprovalReceipt`, `ActionApprovalGrant`, both
  `ON DELETE CASCADE` from `User`.
- Adds nullable `ToolInvocation.approvalReceiptId`, `ON DELETE SET NULL` so the
  audit row keeps its own lifetime.

**Rollback:** drop the two tables, drop `ToolInvocation.approvalReceiptId`, drop
the three `Settings` columns. No data is transformed and nothing is destroyed, so
an older build ignores the new columns and runs unchanged. Both new models are
registered in `src/lib/db.ts` `OWNER_COLUMN` as `userId`-scoped.

---

## 5b. Verification actually performed

Run against the exact commits pushed, in a **detached worktree off a fresh
`origin/main`** rather than the working checkout. That distinction matters here:
this repository is worked by several agent sessions at once, and a gate run
against the live tree is a reading of whatever every session had half-written at
that instant. Two readings during this run disagreed by 209 type errors purely
because a concurrent edit was mid-flight.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx eslint .` | clean |
| `npx tsx --test tests/*.test.ts` | 1591 tests, 1589 pass, **0 fail**, 2 skipped |
| `npm test --prefix runner/agent-core` | 152 pass, 0 fail |
| `npm run build` | compiled, 104 static pages |
| `npx prisma validate` | valid |
| `node scripts/check-approval-dispatch.mjs` | pass (was 5 failures at the start of this run) |
| `npm run capabilities:check` | pass |
| `npm run work:contract:check` | pass |
| `npm run work:sandbox:check` | pass |
| `npm run design:contract:check` | pass |
| `npm run design:editor:check` | pass (bundle was stale; rebuilt) |
| `npm run native:contract:check` | pass |
| `swift build` / `swift test` (JunoNativeKit) | builds; suites run 0 failures |
| `npm run i18n:extract` | no-op against its own sources |

**Not proven, and worth saying plainly:**

- **No live Anthropic connector round trip was made.** The tool loop is covered
  by `tests/anthropic-round.test.ts` (12 tests over hand-written stream events:
  block reassembly, thinking-signature preservation, interleaved indices,
  malformed JSON, usage arithmetic) but no request has been sent to the real API
  with a real connector attached. This is the largest single risk in the slice,
  because it is the primary provider's main path.
- **No end-to-end click-through of the approval card.** It typechecks, lints and
  builds; nobody has watched a real receipt appear and be answered. There is no
  E2E layer in this repository to have done it with — see slice `product-e2e`.
- **Local green is not CI green for timing-shaped failures.** This machine is
  Node 24 on 12 cores; CI pins Node 20 on a 2–4 core runner. Nothing in this
  slice is timer- or event-loop-shaped, but the rule stands.

---

## 6. Decisions for the owner — not engineering calls

1. **The published Terms promise more API budget than the code grants.**
   `src/app/(legal)/legal/cgu/page.tsx:70-80` advertises Pro 15 € / Max x5 75 € /
   Max x20 150 € monthly API budget. `src/lib/spend.ts:28` enforces 11 / 55 / 110.
   The code's own comment explains the 11 € figure as a deliberate margin
   calculation (20 € HT → ~15.80 € net of URSSAF cotisations → 11 € budget). The
   two resolutions are opposite — raise enforcement to match the contract and
   lose ~4 €/subscriber of margin, or correct the Terms, which that same document
   says requires 30 days' notice. **Nothing was changed.**
2. **The §15.4 personal ceiling is a separate matter.** `BUDGET_EUR.OWNER = null`
   means Liam's own account is genuinely uncapped. That *is* the §15.4
   requirement and it is unambiguous engineering work — it is the next slice.

---

## 7. Next slice

`personal-budget-ceiling` (P0). Every path that can spend must debit one ledger
and respect one hard ceiling: Work runs, voice sessions and research search fees
currently do not, provider auto-retries are unaccounted, `checkBudget` is
read-then-act with no reservation, and the owner account has no ceiling at all.
Until that holds, "one cost budget" is not true and the program's central premise
for Juno replacing paid subscriptions does not stand up.

Then, in order: `knowledge-ingestion` (§5, the largest gap and the blocker for
Notebooks/Student), `unified-search` (§6), `memory-v2` (§7, starting with the
suppression bypass), `research-durable` (§8).

Acceptance criteria for each are in `status.json`.
