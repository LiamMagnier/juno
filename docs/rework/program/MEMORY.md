# Memory vertical — 2026-10-04 (branch `rework/memory`)

Scope: master prompt §8 (layers A–G), §9 (memory quality), §10 (transparency UX and evaluation), §55 items 1–2. This builds on the earlier milestone in `../PROGRAM_MEMORY.md`, which fixed stale-summary reinjection and noted what the old bench missed. Canonical maturity is in `src/lib/capabilities.ts` (`memory_durable`, `memory_session_search`). Nothing is deployed or production-accepted. There is no claim that Alevr memory is better than any competitor.

## Decisions (written before implementing)

1. **Keep the existing system and measure it first.** The lifecycle (`memory-lifecycle.ts`), provenance columns, summaries, dreamer and memory page stay. A new evaluation suite scores them first, then the fixes are scored again. No vector-database replacement.
2. **Schema check.** `MemoryEntry` already had scope, category, source conversation and message, `observedAt`, `lastVerifiedAt` (= last confirmed), `lastUsedAt` (stamped by retrieval), confidence, status, reason, `expiresAt` (temporal validity) and `supersededById`. Sensitivity stays computed and is not stored (the existing documented choice in `memory-sensitive.ts`). So no new memory columns were added.
3. **Contradictions stay conservative and named.** Each new rule (style slots, denials, transitions, merges) is listed explicitly and has "keep both" counter-cases in the suite. It is not a general similarity guess.
4. **Session recall uses per-account blind tokens, not plaintext FTS.** Postgres FTS over decrypted text would store plaintext. Encrypted per-account index shards would hide even token co-occurrence, but every query would have to decrypt and parse megabytes, and every write would rewrite a shard. Blind HMAC tokens in a GIN array stay fast, incremental and plaintext-free. The leakage they add is written down below.
5. **Agents get an explicit grant, not inheritance.** `Agent.memoryAccess` takes `none`, `profile` or `full`, default `profile`. Only the person can set it, through a route that the agent's self-configuration path cannot reach.
6. **Procedural memory makes proposals only.** No model writes a skill. A repeated method becomes a candidate that the person accepts or dismisses.

## Implemented

| Layer / §  | What | Where |
| --- | --- | --- |
| §10 evaluation | `npm run memory:bench -- --suite`. Scores lifecycle recall, precision and contradiction resolution; corrections (15 cases, read in order and re-read newest-first); false memory; consolidation; scope leakage across 7 readers × 13 facts; sensitive filtering; summary persistence and injection; token overhead; latency; and session-recall quality on a 20k-message synthetic account. Baseline and current results are recorded in `tests/fixtures/memory-eval-record.json`. The gate test is `tests/memory-eval.test.ts`. | `src/lib/memory-eval.ts`, `src/lib/memory-eval-cases.ts`, `scripts/memory-bench.ts` |
| §9 contradiction | Subject-aware **style slots**: answer length (short vs detailed) and register (formal vs casual). This fixes the stale answer-style leak. A preference only joins a slot when it lands on exactly one pole, so "answers with code examples" still adds to the others. | `memory-lifecycle.ts` `exclusiveSlot`/`styleSlot` |
| §9 correction | **Denials** ("no longer works at X") conflict only with the value they deny. Reverse-order reading also works, so re-reading "is vegetarian" after "no longer vegetarian" no longer revives it. The re-judge pass now replays denials. | `slotsConflict`, `findContradiction`, `planTimelineReconciliation` |
| §9 temporal validity | **Transitions**: a later new job ends "looking for a new job", and "graduated" ends "studies at …". This only fires when the resolver was said after the state. It works in both reading orders and never retires a fact the person typed. | `TRANSITIONS`, `statesResolvedBy`, `laterResolverOf` |
| §9 consolidation / dedup | **Merges without invention**. Near-identical believed facts in one scope (Jaccard ≥ 0.75, same numbers, no slot conflict) are merged by retiring all but one. Nothing is rewritten. This runs inside the existing bounded dreamer re-judge pass. | `planDuplicateMerges` |
| §9 decay | Recency now decays from the **last confirmation** (`max(observedAt, lastVerifiedAt)`), so a fact the person keeps restating stays fresh. | `confirmedAtOf` in `selectMemoriesForContext` |
| §9 sensitive | The ethnicity rule now catches national-ethnic compounds such as "Black British" and "Asian American". | `memory-sensitive.ts` |
| D session recall | `MessageRecallIndex` holds one row per message: blind tokens only, per-account HKDF key derived from the message key, GIN index. Ranking is BM25-style IDF with length normalisation, plus entity, time-hint ("two weeks ago"), project and recency signals. Only the top 40 candidates are decrypted, to verify the match and cut the excerpt. It makes **no model call**. Unified search and `search_chats` now reach every conversation. The old bounded scan is kept for messages newer than the last index pass, and as a fallback if the index fails. | `src/lib/recall/*`, `src/lib/search/{engine,sql,index}.ts` |
| D upkeep | Each chat turn indexes 200 messages and each search catches up 300. `scripts/recall-index-backfill.ts` does bulk loads. Editing a message drops its index row. Deleting a message or conversation cascades. Key rotation re-indexes under the new key, and the old key keeps working meanwhile. | `src/app/api/chat/route.ts`, `src/app/api/messages/[id]/route.ts` |
| E project | Isolation is now proven against Postgres: a project reads only its own facts, and a member of a shared project reads only their own project memory. Per-person **Clear this project's memory** deletes that person's facts and summary for the project and marks its chats read. | `tests/memory-scope-db.test.ts`, `DELETE /api/memory?projectId=` |
| F Orbit agent | `Agent.memoryAccess`. `profile` means preferences, workflows and identity, minus sensitive facts and the prose summary. `none` means the agent's own notes only. `full` means what a chat in its scope reads. Chat turns, room turns and Work tasks all pass the agent's grant. It is set from the agent panel through `PATCH /api/agents/[id]/memory-access`, and `patchAgentSchema` strips the field. | `src/lib/memory-scope.ts`, `memory.ts getMemoryProfile`, `scripts/work-runner.ts`, `agent-panel.tsx` |
| G procedural | When 3 or more completed Work runs share a kind of task and a set of tools, they become a `SkillCandidate`. The title comes from the runs and the draft is built from the person's own requests. The Memory page shows "Methods you repeat" with **Make it a skill** (auto-select off) or **Not a skill** (permanent). The dreamer refreshes candidates. | `src/lib/procedural-memory*.ts`, `src/components/memory/skill-candidates.tsx`, `/api/memory/skill-candidates` |
| §10 UX | Each row now shows "Inferred" when confidence is below 0.6, "Confirmed …" when the fact was restated later, and "Used …" from the retrieval stamp. The source link goes to the exact message (`?m=`). These sit beside the existing edit, forget, delete, move to project, all chats (account-wide), pause, incognito, export, import, search, activity and reset. | `entry-row.tsx`, `memory-footer.tsx` |

## Changed

- The existing recall benchmark moved from **28.57% stale, 97.56% precision, 1 leak** to **0% stale, 100% precision, 0 leaks** in every setting. Its record (`tests/fixtures/memory-recall-record.json`) was re-recorded.
- `tests/memory-forget.test.ts` reads source text in a 2,500-character window. That window was widened to 4,000 because `getMemoryProfile` grew. The assertion itself is unchanged.
- The ownership guard (`src/lib/db.ts`) now also covers `MessageRecallIndex` and `SkillCandidate`.

## Removed

Nothing. The 50-conversation scan is no longer the only path, but it remains as the fallback.

## Benchmarks

### Evaluation suite (offline, deterministic)

The baseline was measured on the pre-change rules (HEAD `94f9911e`), with the agent boundary as it was then: an agent turn read what an ordinary chat read. Command: `npm run memory:bench -- --suite`.

| Dimension | Before | After |
| --- | ---: | ---: |
| Recall (live / re-read) | 100% / 100% | 100% / 100% |
| Precision | 97.56% | 100% |
| Contradiction resolution (1 − stale) | 71.4% | 100% |
| Probe leaks | 1 | 0 |
| Corrections passed, in order / re-read (of 15) | 8 / 7 | 14 / 14 |
| False contradictions (true facts wrongly retired) | 2 | 0 |
| False memory: believed but not true (all histories, both orders) | 4 / 164 | 0 / 160 |
| Facts invented by consolidation | 0 | 0 |
| Near-duplicates merged / different facts merged | 0 of 4 / 0 of 5 | 4 of 4 / 0 of 5 |
| Scope leaks (7 readers × 13 facts) | 11 (all to agents) | 0 |
| Sensitive stored without opt-in / benign refused | 1 of 12 / 2 of 10 | 0 of 12 / 2 of 10 |
| Summary injection: stale facts injected next turn, lifecycle gate | 0 | 0 |
| Summary injection: same history under the pre-2026-10-04 count-only gate | 1 | 3 |
| Memory tokens injected per question, mean / p95 / max (budget 600) | 167 / 318 / 320 | 163 / 318 / 320 |
| Fact selection over 2,000 facts, p50 / p95 | 2.5 / 3.3 ms | 2.3 / 2.8 ms |

Notes on reading this table:

- The summary row is the case the earlier milestone said the old bench missed. A summary written mid-history plus a later correction that leaves the row count unchanged is never injected stale under the current gate. Under the old count-only gate the count *rises* after this work (1 → 3), because the new rules retire more stale beliefs without adding rows. That is why the lifecycle gate matters.
- **Remaining failures, kept in on purpose:**
  - `pet-died`: no rule links a pet's death to "has a dog".
  - Two benign false flags ("politics podcasts", "church architecture"), which come from the sensitive classifier's deliberately inclusive rules.
  - Lifecycle retrieval stays at 81.8%: four crowded-memory questions need semantic vectors, which the offline run does not have.

### Session recall on Postgres

Command: `RECALL_BENCH_DATABASE_URL=<loopback> npx tsx scripts/recall-bench.ts --messages 100000`. Setup: a synthetic account with 100,016 AES-GCM messages in 5,008 chats over two years, and six planted decisions including near-duplicates. Run three times on this Mac; the local cluster is shared with other sessions.

| | Full-history index | Old bounded scan |
| --- | ---: | ---: |
| Right conversation first | **6 of 6** (and 6 of 6 in the top 5) | **0 of 6** found (it only sees the newest 50 chats) |
| Query latency p50 / p95 | 25–29 / 36–44 ms | 13 / 14–15 ms |
| Time split (p50) | candidates ~1 ms, ranking under 0.1 ms, verify/decrypt ~0.5 ms, stats + pending count ~24 ms | — |
| Indexing throughput | 7,600–8,600 messages/s | — |
| Index size | ~58 MB fresh (~0.6 KB per message) | — |

- The first runs showed p50 values around 145 ms. Two causes were identified: a plan regression on stale statistics, which the `MATERIALIZED` hit set now pins (47 ms vs 1.4 ms on the candidate query, measured with EXPLAIN ANALYZE), and an un-analyzed `Conversation` table.
- The remaining ~24 ms is two full scans of this account's index and messages, which in this test database is the whole table. The cost on real multi-tenant data has not been measured.
- The offline suite's 20k-message in-memory corpus gives the same result: 6 of 6 right conversation first; the old window could see 1 of 6.
- Basic retrieval makes no model call. Results from `search_chats` are bounded to 8 hits × 240-character excerpts.

## Tests

All of these passed locally on 2026-10-04:

- `npx tsx --test tests/memory-*.test.ts tests/voice-memory.test.ts tests/unified-search.test.ts tests/conversation-search.test.ts tests/search-fusion.test.ts tests/recall-index-core.test.ts tests/procedural-memory.test.ts tests/ownership-guard.test.ts tests/ownership-guard-callsites.test.ts tests/capabilities-registry.test.ts`
- Real Postgres tests, run against a throwaway `juno_memory_test` database:
  - `MEMORY_TEST_DATABASE_URL=… npx tsx --test tests/recall-index-db.test.ts`: 3 tests, covering
    - finding a decision that sits behind 60 newer chats;
    - no plaintext in any token, and no shared tokens across accounts;
    - account and project isolation;
    - edit re-indexing and delete cascade;
    - key rotation;
    - unified search before and after the index.
  - `NODE_OPTIONS=--conditions=react-server … tests/memory-scope-db.test.ts`: `getMemoryProfile` with account, project, shared-project member, and agent `profile`/`none`/`full` readers.
  - `tests/procedural-memory-db.test.ts`: propose, refresh idempotently, accept (skill with auto-select off), cross-account refusal, permanent dismissal.
  - `--experimental-test-module-mocks tests/memory-clear-project-db.test.ts`: the real `DELETE /api/memory?projectId=` handler.
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`, ESLint on all changed files, and `npm run capabilities:check` are clean. The only remaining tsc errors are the pre-existing ones for a missing `runner/agent-core/dist`.
- UI was checked in `/dev/memory` (full, project and clear-dialog states; light, dark, 390 px) and `/dev/agents?view=thread` → About. Screenshots are in `docs/rework/program/evidence/memory/`.

## Security considerations

- **Recall index leakage.** Someone who holds the database but not the key cannot read any word. They can see which of one account's messages share (unknown) words and how common each token is within that account. That is a frequency side channel, on top of what timestamps and lengths already reveal.
  - Mitigations: per-account keys (nothing correlates across accounts); tokens deduplicated per message, with no counts or positions; common function words never indexed; tokens truncated to 96 bits; every hit verified after decryption.
  - The index key derives from the message key, so rotation and revocation follow it.
- **Scoping.** The raw SQL is scoped by `userId` on the index row *and* on the joined conversation, and lives in one file (`search/sql.ts`).
- **Agents cannot widen their own memory access.** `memoryAccess` is not in `patchAgentSchema`, which `update_agent` and setup changes write through. Only the person-only route changes it. Unknown values read as `profile`, never `full`.
- **Procedural proposals** are model-free, need the person's acceptance, land with auto-select off, and pass through the existing skill scanner and audit.
- **Clearing a project** deletes only the caller's own rows.

## Remaining blockers

- **Live-model accuracy:** `--live` mode with a real extraction model has not been run.
- **Authenticated real-UI workflow:** learn → correct → query → forget → reload has not been run on a signed-in account (no signed-in browser here).
- **Production backfill and latency:** the recall backfill on production and latency on real multi-tenant data are unmeasured. The stats and pending-count queries scan the account each search; cache them if real accounts show it.
- **Native parity:** macOS and iOS memory views do not yet show the new provenance tokens, methods, clear-project or agent grant. Native search does not use the recall index.
- **Semantic leg for session recall:** deliberately not added, since it would need query embeddings. Lexical + entity + time ranking found every planted case.
- **Undetected cases:** concurrent consolidation/ingestion races and the transitions no rule covers (`pet-died` and similar).

## Next milestone

Run the signed-in learn → correct → query → forget → reload workflow and `--live` suite. Then run the production recall backfill with latency on real accounts, and bring the native Memory views to parity.

## Comparison with current public documentation (behaviour, not benchmarks)

- **ChatGPT** ([Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq), [Projects](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt)):
  - Saved memories are kept separate from chat-history reference, and deleting a chat does not delete a saved memory.
  - "Sources" under a reply show the past chats or memories that personalised it.
  - Alevr's equivalents are the per-reply memory receipt and the row links to the exact source message, with deletion and forgetting handled as separate lifecycle states.
- **Claude** ([chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)):
  - Chat search is a RAG tool call over past chats, scoped to non-project chats or one project.
  - Each project has its own memory and summary; incognito chats are not saved; sensitive topics are excluded by default.
  - Alevr's design matches these boundaries and adds per-agent grants. Its recall needs no embedding or model call.
- **Gemini** ([memory of past chats](https://support.google.com/gemini/answer/16598469?hl=en)): personalisation from past chats sits under Personal Intelligence, can be switched off, and is tied to Gemini Apps Activity, where deleting chats stops their use (with a short delay).
- **Hermes Agent**:
  - Its curated memory is bounded: `MEMORY.md` at 2,200 characters and `USER.md` at 1,375. The agent must consolidate when full rather than truncate silently ([memory docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)).
  - `session_search` runs SQLite FTS5 over all sessions, makes no model call and returns actual messages ([sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions), [repo](https://github.com/nousresearch/hermes-agent)).
  - Alevr follows the same two ideas: a 600-token budget for injected facts, and model-free recall that returns real messages. It does this over ciphertext-at-rest, which FTS5 over plaintext does not have to deal with.

None of these sources publish comparable accuracy numbers, so no ranking is implied.
