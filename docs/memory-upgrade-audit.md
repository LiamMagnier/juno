# Memory system — deep audit for the intelligence + trust-UI upgrade

READ-ONLY audit (2026-07-17). No code changed. Every claim cites `file:line`.
Repos: WEB = `juno/`, APP = `juno-app/`.

The goal is to PRESERVE the incremental per-conversation architecture (extraction →
resumable processing → dedup → consolidated summary → suppression/provenance →
memory-aware chat → account sync) and improve extraction quality, retrieval,
trust-UI, in-chat confirmation, and cross-platform consistency.

---

## 1. WHAT EXISTS — current architecture end to end

### 1.1 Storage (WEB, Prisma)
- `MemoryEntry` — `prisma/schema.prisma:460-477`: `content`, `source` (AUTO/MANUAL),
  `kind` (FACT/SUPPRESSION), `sourceRef` (`conversationId | "manual" | "edit"`),
  `createdAt/updatedAt`. Indexes `(userId, createdAt)`, `(userId, kind)`.
  **No** category/type, confidence, importance, embedding, or supersede pointer —
  a memory is just a string with a kind.
- `ConversationMemory` — `schema.prisma:483-497`: `conversationId @unique`,
  `processedAt` (high-water mark), `digest`, `factCount`. This is the incremental
  per-chat extraction state.
- `MemorySummary` — `schema.prisma:501-510`: per-user `content` (markdown), `entryCount`.
- `User.memoryEnabled` — `schema.prisma:282`.
- APP mirror: `juno-app/Juno/Models/PersistenceModels.swift:314-351` (`MemoryEntry`,
  plus a `project: Project?` relation that WEB lacks — see gap CP-2), `MemorySummary`
  `:353-364`, and `ConversationMemoryState`.

### 1.2 Extraction (trigger + pipeline)
- **Two extraction paths.**
  1. *Inline tags*: the model appends `<juno:memory>…</juno:memory>`; parsed by
     `parseMemories` (`src/lib/message-content.ts:108-117`, regex `:24`) and saved via
     `saveAutoMemories` → `saveCandidates` in the chat route (`src/app/api/chat/route.ts:1243`).
  2. *Background distillation*: after the answer persists, the chat route calls
     `extractConversationMemory` (`route.ts:1439`) then `maybeConsolidate` (`route.ts:1441`).
- `extractConversationMemory` — `src/lib/memory.ts:228-355`: reads USER messages after
  `processedAt`, chunks by 40 msgs / 12k chars (`:204-205,293-307`), runs the extraction
  prompt (`:319-323`), saves candidates, advances the high-water mark per chunk
  (`markProcessed :266-284`) so it is resumable; `maxChunks` bounds cost.
- Utility-model walk: `runUtilityPrompt` (`memory.ts:74-137`) over provider-diverse FREE
  models with per-attempt/total deadlines and a transient retry.
- APP port: `MemoryService.extract` (`MemoryService.swift:257-351`), `recordAssistantFacts`
  (`:236-239`), same prompt verbatim (`:319-325`).

### 1.3 Dedup + suppression filter
- `normalize()` lowercases and strips punctuation (`memory.ts:143-145`).
- `saveCandidates` (`memory.ts:169-193`): skips exact normalized-string dupes (Set
  membership) and anything `isSuppressed` (`:148-155`, exact-or-containment match on
  normalized text). Deterministic — this is what makes "forgotten things never come back."
- APP port: `saveCandidates` (`MemoryService.swift:400-419`), `MemoryText.normalize/isSuppressed`
  (`:1114-1146`).

### 1.4 Consolidation (facts + digests only — never raw chats)
- `gatherMemorySources` (`memory.ts:484-525`): all FACT entries newest-first within a
  45k-char budget, suppressions, ≤40 chat digests, project lines, and active GitHub repos
  (via connector token, 5s timeout, `:456-482`).
- `consolidateMemories` (`memory.ts:533-612`): LLM emits sectioned markdown; suppressions
  passed as a HARD RULE block (`:546`); upserts `MemorySummary`.
- `maybeConsolidate` (`memory.ts:646-660`): rebuild only when `factCount` changed,
  throttled to 5 min. `consolidateWithFallback` (`:630-636`) and the backfill loop.
- APP port: `gatherSources` (`MemoryService.swift:431-485`, additionally re-applies the
  suppression filter to every source as defense-in-depth), `consolidate` (`:490-565`),
  `maybeConsolidate` (`:571-581`, gated on a 12h staleness window — see gap CP-3).

### 1.5 Retrieval into chat
- `getMemoryProfile` (`memory.ts:430-439`): returns `{ summary: <whole markdown>, recent:
  <FACTs newer than the summary, max 15; or 50 if no summary> }`.
- Chat route: `getMemoryProfile` (`route.ts:852`) → `buildSystemPrompt` (`route.ts:885-896`)
  → injects the **entire** summary + recent facts every turn (`src/lib/anthropic.ts:194-211`).
- Private/incognito turns short-circuit: `memories:[]`, `memoryEnabled:false`
  (`route.ts:341-344`).
- APP: identical whole-summary injection — `injectionFacts` (`MemoryService.swift:198-211`)
  + `SystemPromptBuilder.swift:50-57`.

### 1.6 Suppression / permanent-forget
- SUPPRESSION entries filter ingestion AND consolidation, and are never injected
  (`getMemoriesForContext :401-408`, `getMemoryProfile :432` both filter `kind:"FACT"`).
- NL "forget" writes a `suppress` add + removes matching facts (`edit/route.ts:57-71`,
  `edit/apply/route.ts:60-82`). APP additionally scrubs matching digest fragments so the
  next consolidation can't reintroduce them (`MemoryService.swift:802-826`) — **WEB has no
  digest scrub** (gap Q-6).
- Global reset (`api/memory/route.ts:31-54`): deletes entries + summary and stamps every
  conversation `processedAt = now` so backfill won't re-learn. APP `reset`
  (`MemoryService.swift:988-1015`) does the same and, in account mode, queues
  `DELETE /api/memory`.
- Proven by the integration test: suppression survives re-extraction, re-backfill, a
  different chat, and reaches the consolidator (`scripts/test-memory.ts:137-189`).

### 1.7 Provenance
- `sourceRef` stored per entry and returned by `GET /api/memory` (`api/memory/route.ts:16`).
  But the WEB UI never lists entries, so provenance is fetched yet **never shown** (gap TUI-2).
  APP shows facts grouped by project and a "Never remembered" list
  (`MemoryModeView.swift:263-347`) but no per-fact source/date either.

### 1.8 The trust UI
- WEB `memory/page.tsx`: `SummaryCard` (readable summary primary, sections, expand dialog,
  "Updated Xh ago", regenerate, pencil→composer NL editing — `summary-card.tsx`),
  `EditsPanel` (localStorage ledger of drafts with diffs + Accept/Undo/Delete —
  `edits-panel.tsx`), `PrivacyStrip` (pause / export JSON / two-click Reset→Confirm —
  `privacy-strip.tsx`). Raw facts are intentionally **not listed** (`page.tsx:28-29`).
  Auto-backfill + silent regenerate on first visit (`page.tsx:101-141`).
- APP `MemoryModeView.swift`: readable summary, project-scoped fact lists, suppression
  list, two-step destructive reset with an explicit warning panel (`:484-505`), NL composer,
  ledger Undo.

### 1.9 In-chat confirmation
- WEB: a "Memory updated" pill with an animated ping dot, shown 4s when `memoryUpdated`
  (created > 0 from the tag path only) (`chat-view.tsx:206-207, 319-328, 1426-1442`;
  flag set in `route.ts:1241-1244, 1282`).
- APP: toast "Memory updated — undo it below…" after an NL edit (`MemoryModeView.swift:442`).

### 1.10 Cross-platform sync
- Account-mode split: when signed in without BYOK the SERVER is canonical
  (`MemoryService.swift:158-172`). `serverOwnsMemory` skips local extraction for server
  chats; consolidate/edit/reset route through `/api/memory` (`:498-506, 606-616, 701-739,
  988-991`). Local extraction runs **only** for chats the server never sees
  (BYOK/local/private) (`:246-248, 908-918`).
- Pull sync: `syncMemory` (`SyncService.swift:754-760`) mirrors the server snapshot via
  `applyMemoryState` (`:766-785`): upsert cuid entries, delete server-cuid entries the
  server no longer has, keep local UUID (BYOK) entries, mirror the summary. Guarded by a
  pending `memory/reset` mutation so a queued reset isn't clobbered (`:757`).
- Offline durability: `MutationQueue` only queues `("memory","reset")` → `DELETE /api/memory`
  (`MutationQueue.swift:166-167`). All other memory writes are direct online calls.

---

## 2. GAPS vs the upgrade goal

Severity: **P0** blocks the goal / correctness risk · **P1** important · **P2** polish.

### Quality

**Q-1 [quality] P1 — Extraction is not typed or gated beyond a prompt.**
Facts are opaque strings; the only "durable vs transient" gate is the prose instruction
"Ignore one-off task details" (`memory.ts:319`, `MemoryService.swift:320`). No structured
kinds (preference / personal-fact / goal / relationship / constraint / project /
comms-pref), no confidence, no importance. `MemoryEntry` has no columns for any of these
(`schema.prisma:460-477`; `PersistenceModels.swift:314-351`).
*Fix:* add `category`, `confidence`, `importance` columns; have extraction return typed,
scored candidates; drop low-confidence/transient ones before persistence.

**Q-2 [quality] P0 — No semantic dedup; only exact normalized string match.**
`saveCandidates` dedups by `normalize()` set membership + substring containment
(`memory.ts:176-186`, `:148-155`). "Lives in Paris" and "is based in Paris" are distinct
rows; both persist and both feed the summary. Duplicates accrete over time.
*Fix:* embed candidates, dedup/merge by cosine similarity above a threshold; keep the
higher-confidence/newer phrasing.

**Q-3 [quality] P0 — No contradiction detection or supersession.**
Contradiction handling is one prompt line — "most recent wins on contradictions"
(`memory.ts:549`) — applied only inside the consolidator's free-text synthesis. At the
entry level, "The user lives in Paris" and a later "The user lives in Berlin" are two
coexisting FACT rows; both are injected (`getMemoryProfile :432-437`) and both are handed
to the consolidator. There is no supersede link and no `updatedAt`-based winner.
*Fix:* on ingest, detect same-subject contradiction (embedding + LLM check), mark the old
entry superseded (new `supersededById` / `status`), exclude superseded from injection and
consolidation.

**Q-4 [quality] P1 — Explicit "remember this" / "forget this" / "only for this chat" is
not first-class.** "Remember" relies on the model choosing to emit a `<juno:memory>` tag
(`anthropic.ts:196-201`); it is not deterministically honored from the user's words.
"Forget" is first-class only on the Memory page's NL composer, not from within a normal
chat. "Only for this chat" exists solely as the all-or-nothing private/incognito mode
(`route.ts:341-344`) — there is no per-message ephemeral capture.
*Fix:* detect explicit imperatives in the chat turn and route them to deterministic
add/suppress/skip operations, independent of tag emission.

**Q-5 [quality] P1 — Sensitive-info restraint is prompt-only.** "Never extract secrets,
passwords, or API keys" (`memory.ts:319`) with no deterministic backstop; a distilled fact
like "The user's DB password is …" would persist if the model complied poorly. `saveCandidates`
has no sensitive-pattern reject (`memory.ts:169-193`).
*Fix:* add a deterministic sensitive-pattern filter at ingestion (keys, tokens, card/SSN
shapes), mirroring the existing suppression filter.

**Q-6 [quality] P1 — WEB never scrubs chat digests on forget (APP does).**
APP `scrubDigests` (`MemoryService.swift:802-826`) removes suppressed fragments from stored
digests inside the same transaction as the suppression. WEB has no equivalent — the
suppression blocks facts and the summary, but a forgotten topic can linger in
`ConversationMemory.digest` and be re-fed into consolidation as a "theme"
(`memory.ts:519, 565`). Divergent behavior + a small leak path.
*Fix:* port `scrubDigests` to the WEB apply route / suppression write.

### Retrieval

**R-1 [retrieval] P0 — Chat injects the WHOLE store, not relevant memories.**
`getMemoryProfile` returns the entire consolidated summary plus recent facts every turn
(`memory.ts:430-439`), injected wholesale (`anthropic.ts:203-210`; APP
`SystemPromptBuilder.swift:52-56`). No relevance ranking, no query-conditioning, no
balancing of relevance/recency/confidence/importance. There are **no** embeddings anywhere
in the memory or chat path (grep for embed/vector/cosine/relevance is empty). This is the
single biggest miss vs the goal.
*Fix:* embed facts; at chat time retrieve top-k by a blended score (relevance to the
current turn + recency + confidence + importance); keep the summary as a compact "profile"
backbone but stop dumping everything.

**R-2 [retrieval] P1 — "Recent" is purely chronological.** The `recent` slice is
newest-first by `createdAt` (`memory.ts:432-437`, `injectionFacts :204-210`); an old but
highly relevant fact is dropped once it's older than the summary, while a fresh trivial
fact is always injected.
*Fix:* fold into R-1's scored retrieval rather than a time cutoff.

**R-3 [retrieval] P2 — Suppressed never resurface (good), but confirm parity under new
retrieval.** Today FACT-only filters guarantee suppressions are never injected
(`memory.ts:401-408, 432`). Any embedding index added for R-1 must exclude SUPPRESSION and
superseded rows, or a relevance search could surface a forgotten statement.

### Trust-UI

**TUI-1 [trust-ui] P1 — Facts are not inspectable on WEB.** The page deliberately hides
raw notes (`page.tsx:28-29`); only the summary is readable. The goal asks for "facts
inspectable, search/filter without becoming a DB table." `GET /api/memory` already supports
a `?q=` search (`api/memory/route.ts:11-14`) that the UI never uses.
*Fix:* add a calm, quiet fact inspector (search/filter, source/updated/status on demand)
distinct from the summary — matching what APP already does (`MemoryModeView.swift:263-347`).

**TUI-2 [trust-ui] P2 — Provenance is fetched but never surfaced (WEB).** `sourceRef`,
`source`, `createdAt` are returned (`api/memory/route.ts:16`) yet nothing renders them.
*Fix:* show "from <chat> · updated <date> · auto/manual" on demand in the inspector.

**TUI-3 [trust-ui] P1 — Global reset warning is thin on WEB vs APP.** WEB reset is a
two-click inline Reset→Confirm that auto-reverts after 4s, with the explanation in a
footnote (`privacy-strip.tsx:50-77, 80-86`). APP shows a full destructive panel — "This
permanently deletes every saved fact, the summary, and your forget list… This can't be
undone." (`MemoryModeView.swift:484-505`). The goal wants an explicit warn-before-reset.
*Fix:* bring WEB up to the APP's explicit confirmation copy.

**TUI-4 [trust-ui] P2 — No delete-one vs suppress-topic choice in the UI.** Both platforms
express "forget" only through the NL composer, which always maps to remove-fact + add-
suppression (`edit/route.ts:66-68`). A user who wants to drop a single stale fact *without*
permanently block-listing the topic has no direct control; the `DELETE /api/memory/[id]`
route (`api/memory/[id]/route.ts:23-33`) exists but is unused by the UI.
*Fix:* offer both actions explicitly (delete this entry / never remember this topic).

**TUI-5 [trust-ui] P2 — "Fake success before backend confirm": mostly clean, one spot.**
WEB NL edits await the apply call before the success toast (`page.tsx:196-205, 213-224`) —
good. APP `performReset` shows "Memory erased" immediately while the server `DELETE` is only
*queued* for later (`MemoryModeView.swift:517-521` + `MutationQueue.swift:166`). Local data
is gone, but the "erased" claim precedes the server ack.
*Fix:* word the toast as locally-cleared / syncing, or confirm on ack.

### In-chat

**IC-1 [in-chat] P1 — The "Memory updated" pill only reflects inline tags, and can't be
inspected.** The flag is set solely from `saveAutoMemories(parseMemories(full))`
(`route.ts:1241-1244`); background `extractConversationMemory` saves (`route.ts:1439`) never
raise it, so the confirmation is inconsistent with what was actually learned. The pill is
non-interactive — no "see what changed," no inline undo/edit (`chat-view.tsx:1426-1442`).
*Fix:* drive the confirmation from the real persisted delta (both paths) and make it open
an inspect/undo affordance.

**IC-2 [in-chat] P2 — Animated ping dot borders on "noisy."** The pill uses
`animate-ping` + rise-in (`chat-view.tsx:1436-1437, 1432`). The goal explicitly wants
"not noisy… no big animated banner." De-emphasize to a static, quiet confirmation.

**IC-3 [in-chat] P2 — Dupe suppression is correct.** `memoryUpdated` is gated on
`created > 0` and `saveCandidates` returns 0 for dupes/suppressed
(`memory.ts:179-192`, `route.ts:1244`), so repeated identical facts don't re-notify. Keep
this property under any redesign.

### Cross-platform

**CP-1 [cross-platform] P1 — Per-entry memory edits have no offline queue (APP).**
Only `("memory","reset")` is queued (`MutationQueue.swift:166`). NL add/update/suppress in
account mode are direct online calls (`applyOperationsRemote :730-739`); offline, they throw
and are lost (no pending row). Cross-surface consistency depends on being online at edit
time.
*Fix:* add queued memory ops (add/update/remove/suppress) so edits made offline sync later.

**CP-2 [cross-platform] P0 — Project-scoped memory exists on APP only and cannot sync.**
APP `MemoryEntry.project: Project?` (`PersistenceModels.swift:325-326`) backs the
"Project memory" UI (`MemoryModeView.swift:263-296`). WEB `MemoryEntry` has **no** project
relation (`schema.prisma:460-477`) and the sync DTO carries none (`SyncService.swift:766-778`).
Project-scoped memories created on APP silently cannot round-trip to WEB.
*Fix:* add the project relation to the WEB model + `/api/memory` payloads, or explicitly
scope project memory as local-only.

**CP-3 [cross-platform] P2 — Consolidation freshness differs.** WEB rebuilds whenever
`factCount` changed, throttled 5 min (`memory.ts:646-660`, after the fix noted in its
comment). APP still gates on a 12h staleness window AND a count change
(`MemoryService.swift:571-581, 144`). APP summaries can read stale relative to WEB.
*Fix:* align APP to the count-changed + short-throttle heuristic for chats it owns.

**CP-4 [cross-platform] P1 — Native cache correctly avoids resurrecting deleted/suppressed
— preserve it.** `applyMemoryState` deletes mirrored cuid entries absent from the server
snapshot and keeps local UUID entries (`SyncService.swift:779-783`); the reset guard blocks
a stale server list from re-mirroring (`:757`); suppression entries themselves sync as rows.
No resurrection path found today. Any move to embedding-indexed retrieval (R-1) or partial
sync must keep this invariant and add a regression test (see E-7).

### Evals

**E-1 [evals] P1 — Coverage is mechanical only.** `scripts/test-memory.ts` proves backfill,
incremental high-water mark, suppression-survives-backfill, and chunking (`:1-13`) with a
*deterministic token extractor* (`:38-52`) — it never exercises extraction QUALITY,
dedup semantics, contradiction, relevance retrieval, or sensitive restraint. There are no
fixtures for any of the quality/retrieval behaviors this upgrade targets.

---

## 3. Ranked implementation plan

Preserves the incremental architecture, the suppression guarantees, and all stored data.
Each milestone is shippable on its own.

### M1 — Retrieval relevance (addresses R-1, R-2, R-3) — highest leverage
- Schema: add `MemoryEntry.embedding` (or a sibling `MemoryEmbedding` table) + backfill job
  reusing the existing resumable batch pattern (`memory.ts:362-394`).
- New `retrieveRelevant(userId, queryText, k)` in `memory.ts`: blended score
  (cosine relevance + recency decay + confidence + importance); **must** filter
  `kind:"FACT"` and exclude superseded (protects R-3).
- `getMemoryProfile` returns `{ summary, relevant }` where `relevant` is query-conditioned;
  chat route passes the current user turn (`route.ts:852`); `buildSystemPrompt` keeps the
  summary backbone but injects `relevant` instead of a raw recency slice
  (`anthropic.ts:203-210`).
- Backend contract: unchanged for clients; APP mirrors facts + summary as today, then runs
  the same scored selection locally in `injectionFacts` (`MemoryService.swift:198-211`).
- Files: `prisma/schema.prisma`, `src/lib/memory.ts`, `src/app/api/chat/route.ts`,
  `src/lib/anthropic.ts`; APP `MemoryService.swift`, `SystemPromptBuilder.swift`.

### M2 — Extraction quality: typing, confidence, sensitive filter (Q-1, Q-5)
- Schema: `category`, `confidence`, `importance` on `MemoryEntry` (+ APP model).
- Extraction prompt returns typed, scored candidates; `parseExtraction` (`memory.ts:207-221`)
  parses them; `saveCandidates` (`:169-193`) drops low-confidence/transient and runs a
  deterministic sensitive-pattern reject before persist.
- Files: `src/lib/memory.ts`, `PersistenceModels.swift`, `MemoryService.swift`.

### M3 — Semantic dedup, contradiction + supersession (Q-2, Q-3)
- Reuse M1 embeddings: on ingest, find near-duplicates (merge) and same-subject
  contradictions (mark prior `supersededById`, exclude from injection + consolidation).
- Update `gatherMemorySources` (`memory.ts:484-525`) and injection to skip superseded.
- Files: `src/lib/memory.ts`, `schema.prisma`; APP `MemoryService.swift`.

### M4 — In-chat explicit intents + honest confirmation (Q-4, IC-1, IC-2)
- Detect "remember/forget/don't save this" in the turn; route to deterministic
  add/suppress/skip. Drive the confirmation from the real persisted delta across BOTH the
  tag path and background extraction (`route.ts:1241-1244, 1439`); make the pill quiet and
  inspectable; drop `animate-ping` (`chat-view.tsx:1436`).
- Files: `src/app/api/chat/route.ts`, `src/lib/message-content.ts`,
  `src/components/chat/chat-view.tsx`.

### M5 — Trust-UI parity + calm inspector (TUI-1..4, Q-6, CP-3)
- WEB: fact inspector using the existing `?q=` search (`api/memory/route.ts:11-14`) with
  quiet source/updated/status + provenance on demand; explicit delete-one vs suppress-topic;
  strengthen reset warning to APP's copy (`privacy-strip.tsx`); port `scrubDigests` to the
  WEB suppression write (Q-6). APP: align consolidation freshness (CP-3).
- Files: `src/app/(app)/memory/page.tsx`, `src/components/memory/*`,
  `src/app/api/memory/*`; APP `MemoryService.swift`, `MemoryModeView.swift`.

### M6 — Cross-platform durability (CP-1, CP-2)
- Queue per-entry memory ops in `MutationQueue` (`MutationQueue.swift:153-181`) so offline
  APP edits sync; decide project-scoped memory: add the relation to the WEB model + payloads
  or scope it local-only (`schema.prisma:460-477`, `SyncService.swift:766-785`).

### M7 — Eval fixtures (E-1) — land alongside M1–M4
Extend `scripts/test-memory.ts` (keep the `UtilityLlm` injection) with:
- **durable-preference extraction** — "I always use pnpm" ⇒ a preference fact persists.
- **transient rejection** — "what time is it in Tokyo?" ⇒ nothing persists.
- **correction/supersession** — "Actually I moved to Berlin" ⇒ Paris superseded, Berlin
  wins in injection + summary.
- **semantic dedup** — "based in Paris" after "lives in Paris" ⇒ one merged entry.
- **contradiction** — conflicting facts ⇒ deterministic resolution, not both injected.
- **explicit remember / forget** — imperative in a normal chat ⇒ deterministic add/suppress.
- **suppression-survives-backfill** — already covered (`test-memory.ts:137-189`); extend to
  the embedding index (R-3) so relevance search never returns a suppressed/superseded row.
- **relevance retrieval** — a query surfaces the on-topic fact ahead of newer off-topic ones.
- **sensitive restraint** — a distilled "password is …" candidate is rejected at ingestion.

---

## Top findings (one-liners)
- **Retrieval dumps the whole store** every turn; no relevance/embeddings anywhere (R-1).
- **Dedup is exact-string only**; no semantic merge (Q-2) and **no contradiction/supersession**
  at the entry level (Q-3).
- **Suppressions never resurface** — including on the native cache — and reset marks
  conversations processed; this core guarantee is solid (CP-4, `test-memory.ts`).
- **No "Memory updated" noise from dupes** (gated on `created > 0`), but the pill misses
  background-extracted memories and uses an animated ping (IC-1, IC-2).
- **UI does not fake success** on the write paths (WEB awaits apply); the one soft spot is
  APP's reset toast preceding the server ack (TUI-5).
- **Project-scoped memory is APP-only and can't sync** to WEB (CP-2); **WEB lacks the digest
  scrub** APP has on forget (Q-6).
- **Evals are mechanical only** — no quality/retrieval/contradiction fixtures (E-1).
