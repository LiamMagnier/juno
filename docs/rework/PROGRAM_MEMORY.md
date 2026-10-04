# Alevr memory milestone — 2026-10-04

> **Follow-up:** the next memory vertical is recorded in [`program/MEMORY.md`](program/MEMORY.md). It covers the full evaluation suite (summary injection included), the answer-style contradiction fix, transitions and denials, merges, full-history encrypted session recall, Orbit agent memory grants, procedural (skill) proposals and the provenance UX. The open items below marked as next verticals are addressed there, and that document says which still remain. This record is preserved as written.

The memory system already has substantial lifecycle and retrieval infrastructure. This milestone preserves it and fixes a reproduced correction/summary inconsistency. Production acceptance remains false in the existing canonical capability registry (`src/lib/capabilities.ts`).

## Current source audit

| Layer | Existing implementation | What is established / remaining limit |
| --- | --- | --- |
| Working context | Chat turn context and conversation transcript | Existing per-turn context; current-conversation find is `src/lib/conversation-search.ts`, not historical recall. |
| Durable profile | `src/lib/memory.ts`, `src/lib/memory-lifecycle.ts`, `MemoryEntry` / `MemorySummary` in Prisma | Categorized facts, confidence, provenance, timestamps, supersession, sensitivity controls, expiry and bounded retrieval already exist. Preserve them. |
| Historical recall | `src/lib/tools/specs/search-chats.ts`, `src/lib/search/index.ts`, `engine.ts`, `sql.ts` | Provider-neutral read tool uses existing unified search with user/project scoping, dates, excerpts and links; basic retrieval makes no LLM call. Encrypted message text is searched by bounded decryption of up to 50 recent conversations / 1,500 messages. This does **not** establish complete recall over all history. |
| Episodic context | `ConversationMemory` digests and message provenance | Digests and source anchors exist. Extraction anchors facts to the final message of a chunk, rather than proving per-fact attribution. A fully structured event/participant/artifact/outcome contract remains to be verified. |
| Project memory | `ProjectMemorySummary`, `memory-project-summary.ts`, scoped `getMemoryProfile` | Account and project summaries/facts are distinct. Project injection defaults to isolation. Summary freshness queries introduced here use exact user/project scope and return only dates. |
| Orbit memory | `src/lib/agents/prompt.ts`, agent memory and reflection paths | Agent-specific context already exists. Team/private inheritance needs explicit adversarial acceptance, not automatic account-wide access. |
| Procedural knowledge | Existing Skills and Work paths | Memory and Skills remain distinct. Automatically proposing/accepting procedural Skills requires a dedicated vertical and approvals. |
| Consolidation | `memory-dreamer.ts`, `memory-dreaming.ts`, timeline reconciliation | Bounded idle-account maintenance respects pause, policy, headroom, provenance and source observation time. This milestone adds a missing summary lifecycle invalidation signal. |
| Transparency | `src/components/memory/memory-manager.tsx`, memory routes, `memory-view.ts` | Existing source links, scope, history, edits/undo, forget/suppression, import/export, pause and sensitivity controls. This milestone changes what the model receives, not the memory page design. |

The schema already carries `sourceRef`, `sourceMessageId`, `category`, `projectId`, `confidence`, `status`, `reason`, `expiresAt`, `lastUsedAt`, `lastVerifiedAt`, `observedAt`, `supersededById` and embedding model identity. A generic vector database replacement would discard useful behavior. Hybrid fact ranking already combines lexical relevance, optional same-model semantic vectors, recency, confidence and category/project weights under a 600-token default fact budget.

## Reproduced failure and chosen change

A user previously lived in Madrid, then Valencia, then says they live in Madrid again. The existing ingestion rules correctly reactivate the original Madrid row and retire Valencia. There are still two FACT rows. The stored summary says Valencia; its old change detector sees the same count, no new forget and no expiry, and returns `fresh`. The profile can then inject that obsolete summary while omitting Madrid because its original `createdAt` predates the summary. The existing recall benchmark does not simulate summary injection and therefore misses this failure.

The implementation adds one narrow lifecycle reader, `src/lib/memory-summary-changes.ts`, bound to the existing Prisma `memoryEntry.findFirst` adapter. It reads the latest retained retirement (`superseded`, `suppressed`, `expired`) and latest elapsed expiry in the summary's **exact** account/project scope. It selects dates only, makes independent reads concurrently, and propagates database failures.

`summaryPredatesMemoryChange` in the existing lifecycle domain now has two uses:

1. `getMemoryProfile` immediately withholds obsolete prose and selects active ranked facts instead. The original forget guard remains, and the resolved project isolation flag is now passed explicitly to the second, domain-level scope check.
2. Both account and project `maybeConsolidate` paths notice lifecycle changes even when the row count stays unchanged and rebuild through their existing consolidation mechanisms. The five-minute throttle remains. While a rebuild is throttled or unavailable, stale summary prose stays out of model context.

Elapsed temporary facts also bench an old summary **before** the asynchronous expiry sweep retires their rows. A rebuilt summary becomes usable again once its timestamp incorporates the recorded lifecycle change. A harmless restatement of an active fact does not invalidate the summary.

No schema migration, new memory model, new provider, scheduler, embedding store or per-turn LLM call was introduced.

## Current competitor behavior and Alevr decision

Claude's current primary help describes searchable past chats and separate project memory spaces with project summaries. Users get continuity without mixing unrelated project contexts; the useful Alevr direction is to keep those boundaries and surface the actual source. Alevr already has the relevant storage/query contracts, but its encrypted-history window remains incomplete. [Claude chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context).

ChatGPT's current memory guidance distinguishes synthesized memory from chat history, provides summary corrections, and explains that deleting a chat does not itself remove saved memory. The useful lesson is that every copy of a belief needs a consistent lifecycle. Alevr's retained provenance and deterministic suppression already address much of that; this patch closes the stale-summary route for retained retirements/elapsed expiries. These sources describe behavior, not benchmark superiority. [ChatGPT Memory FAQ](https://help.openai.com/en/articles/8590148-memory-in-chatgpt-remembering-what-you-chat-about).

## Benchmarks and verification

Before implementation, the existing memory regression selection passed **226 tests**. The existing offline benchmark ran against five recorded histories, 80 current truth facts and 23 probes. Its current product configuration produced identical results for live-order ingestion, newest-first rereading and repaired history:

| Offline metric | Before | After |
| --- | ---: | ---: |
| Recall | 100% | 100% |
| Precision | 97.56% | 97.56% |
| Retrieval | 81.82% | 81.82% |
| Stale fraction | 28.57% | 28.57% |
| Forgotten facts resurrected | 0 | 0 |
| Probe leaks | 1 | 1 |

The before/after JSON outputs matched byte-for-byte. This is the expected result: the existing benchmark exercises extraction recordings, ingestion and fact retrieval, **not** summary persistence/injection. It demonstrates no regression, not an accuracy gain caused by this patch. The remaining leak is an outdated answer-style preference (`The user prefers short answers with examples.`), not a cross-account/project leak. The English conservative contradiction rules do not resolve that preference change. This remains a concrete next evaluation case.

Eight new regressions extend coverage to the missed summary behavior. They drive real ingestion plans, retained-row state changes, the injected production freshness query port, summary gating and actual lifecycle retrieval:

- Account and project reinstatement both show the old count-only decision returning `fresh`, then the new lifecycle decision returning `rebuild` and retrieval returning Madrid alone.
- Other-account, other-project, personal-scope and suppression-kind rows cannot affect a project's freshness result; fact content is not selected.
- An elapsed expiry excludes obsolete summary prose even when the row is still marked active.
- Throttling never makes stale prose usable; older retirements/unchanged active restatements remain fresh.
- Failed freshness persistence reads propagate, and profile/account/project production paths use the shared check.

Completed commands:

- `npx tsx --test tests/memory-summary-changes.test.ts tests/memory-bench.test.ts tests/memory-lifecycle.test.ts tests/memory-project.test.ts tests/memory-rejudge.test.ts tests/memory-forget.test.ts tests/memory-sensitive.test.ts tests/memory-suppression.test.ts tests/memory-dreaming.test.ts`: **234 passed**.
- `npx tsx scripts/memory-bench.ts --json`: **passed** before and after; exact existing benchmark results preserved.
- `npx tsx --test tests/memory-surfaces.test.ts tests/memory-recap.test.ts tests/memory-import.test.ts tests/voice-memory.test.ts tests/unified-search.test.ts tests/tool-search-chats.test.ts`: **97 passed** across adjacent memory consumers and historical-search contracts.
- ESLint on `memory.ts`, `memory-lifecycle.ts`, `memory-summary-changes.ts` and touched tests: **passed**.
- `git diff --check`: **passed** at this milestone checkpoint.

The parent worker owns full-repository typecheck, generated registry refresh and integration checks. Tests use an injected persistence port; they do not claim a live Postgres/provider/browser workflow was exercised.

## Cost, security and remaining acceptance

This adds two concurrent scalar timestamp lookups to profile reads and one retirement lookup beyond the previous expiry lookup during consolidation. It adds no LLM cost. Account/project filtering uses existing indexes; the retirement sort uses `updatedAt` within the scoped set. Production data sizes and query plans were not measured here, so no latency improvement is claimed. Profile reads propagate failure instead of presenting unchecked old prose as current.

The update closes retained-retirement and elapsed-expiry inconsistencies. Concurrent consolidation/ingestion snapshot races, direct deletion/move/edit paths, reactivation of an expired fact without a retained rival, old rows with incomplete provenance, and real process restart still need dedicated persistence acceptance. Existing explicit edit/delete/move refresh paths remain. A complete materialized revision/fingerprint contract can be considered once those measured races warrant it.

Historical recall must eventually cover the full account history while preserving encryption guarantees. Indexing plaintext message content into an unprotected global search table is not an acceptable shortcut. Choose a scoped encrypted/index strategy and benchmark actual large accounts before replacing the current bounded scan.

Next local verticals: resolve the benchmark's stale answer-style preference using conservative subject-aware contradiction fixtures; add summary persistence/injection to the existing recall benchmark; run a real account/project learn → correct → query → forget → reload workflow; measure history retrieval latency and token overhead. Live model accuracy, scope isolation under shared-team ownership, authenticated UI behavior and enabled deployment remain unaccepted. There is no claim that Alevr memory exceeds competitors.
