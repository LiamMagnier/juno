# Projects: verified build spec (ranked)

Date: 2026-10-31. Repo: `/home/user/juno` at `e532983ea`. This spec replaces `projects-audit.md` as the build document. Every claim below was re-checked against the code; the audit's claims that held, failed or needed correcting are listed in §0.

Sizes: **S** is 3 days or less, **M** is 1-2 weeks, **L** is 3 weeks or more, for one engineer. Each item is meant to be one focused PR, unless the item says it should be split.

Out of scope, because other people are building them in parallel:
- share-with-specific-people for chats and artifacts;
- per-chat memory off;
- Drive and OneDrive attach in the composer;
- AI-powered artifacts;
- exports;
- locked chats;
- connectors in voice;
- tone sliders;
- MCP Apps;
- plugins;
- the UI and motion redesign.

UI is described only where a feature cannot ship without it.

---

## 0. What the verification found

### 0.1 Confirmed (the audit's core finding holds)

**The project knowledge index is never populated.**
- Ingest writes `KnowledgeBlock` rows only (`src/lib/knowledge/ingest.ts:238-243`, `src/lib/knowledge/index.ts:63-91`).
- The only code anywhere in the repo that touches `KnowledgeChunk` is the tombstone `updateMany` (`src/lib/library-removal.ts:64`). That covers `src/`, `scripts/`, `runner/`, `native/` and the migrations.
- `packDocumentChunks` is called only from tests. `embedTexts` is called only by `embedQuery` and memory.

Both retrieval legs read `KnowledgeChunk` (`lexical-query.ts:110`, `retrieve.ts:227`), so every project retrieval returns zero passages. `resolveProjectContext` then falls through (`src/lib/chat/turn/project-context.ts:136-142`) to `buildProjectReferenceFiles` (`src/lib/chat/context-assembly.ts:181-197`). That function prepends the full extracted text of every project file to the first user turn: up to 200,000 characters per file (`index.ts:137`), with no budget.

The same empty index also hits other features:
- Deep Research's project and library legs (`src/lib/research/private-retrieval.ts:116-131`);
- voice context (`src/app/api/voice/context/route.ts:118-127`).

### 0.2 New findings the audit missed

1. **Deleted project files are still sent to the model.**
   - Deleting a project file goes through `DELETE /api/attachments/[id]`, which calls `tombstoneAttachment` (`src/lib/library-removal.ts:86-91`). That sets `deletedAt` but keeps `projectId` and `extractedText`.
   - `loadProjectLineage` selects `files: { select: { id, fileName, extractedText } }` with no `deletedAt` filter (`src/lib/projects/project-tree-server.ts:82`).
   - So a file the user removed keeps being pasted into every turn of that project and its subfolders. It is also counted in the router estimate, because `src/lib/router/chat-inputs.ts:109` uses the same loader.
   - `scripts/work-runner.ts:946-950` (the names of a Work run's files) and `src/app/api/projects/route.ts:24` (`_count.files`) have the same missing filter.
   - This is a privacy and correctness bug, and it is live today. → **PRJ-0**.
2. **A replaced file never supersedes its old knowledge document.**
   - `POST /api/attachments/[id]/versions` swaps the bytes and calls `scheduleIngest` (`src/app/api/attachments/[id]/versions/route.ts:141`). The new bytes have a new checksum, so `planIngest` creates a fresh document, and the old document for the same attachment stays `ready`. The restore route behaves the same way (`.../versions/[version]/restore/route.ts:73`).
   - This is harmless today only because there are no chunks. Once chunks exist, retrieval would answer from both the old and the new version. → fixed in **PRJ-1**.
3. **The router under-estimates indexed projects, it does not over-estimate them.**
   - For files with a `ready|degraded` document, `estimateAutoContext` assumes retrieval succeeded. It reserves only `2,400 × 8/3 + 1,024 ≈ 7.4k` tokens (`src/lib/router/chat-context.ts:128-137`, `chat-inputs.ts:124-131`).
   - The turn then sends the whole dump. Auto can therefore pick a model whose window the real prompt overflows, which ends in a provider context-window error (`src/lib/provider-error.ts:133`).
   - The audit's `NoAutoCandidateError` only happens for text that is not indexed.
4. **The default background-provider policy blocks embedding at ingest.**
   - The default mode is `same_provider` (`src/lib/background-provider-policy.ts:36`; `Settings.backgroundProviderMode @default("same_provider")`, `schema.prisma:570`). With no conversation provider it returns no candidates (`background-provider-policy.ts:146-153`).
   - Ingest runs in `after()` with no conversation, so the audit's PRJ-1 sketch ("embed in `runIngest`") would produce **lexical-only indexes for nearly every account**, not only Anthropic users.
   - PRJ-1 below is designed around this. Semantic coverage for everyone needs the local embedder from MEM-5 (memory spec).
5. **Work runs in a project are blind to the project's file contents.** The run is told: "Their contents are not in front of you. If the task turns on what one of them says, say so rather than guessing" (`scripts/work-runner.ts:972-977`). → **PRJ-2** gives the agent runtime the project search tool.
6. **The vector leg binds the owner only on the chunk.**
   - `vectorCandidates` binds `c."userId"` and never `d."userId"` (`src/lib/knowledge/retrieve.ts:188-196`). The lexical statement binds both (`lexical-query.ts:67-68`).
   - The file's own header calls double binding the safety property. Shared projects (PRJ-5) depend on it. → fixed in **PRJ-1**.
7. **Collaborator leaks run in both directions, and the status lookup is wrong for collaborators.**
   - Owner to viewer: viewers receive every chat title in the project (`src/app/api/projects/[id]/route.ts:41-63`).
   - Viewer to owner: once collaborators can file chats, owners would see the collaborators' titles through the same query.
   - The per-file knowledge status lookup uses the **viewer's** `userId` (`route.ts:66-79`), so a collaborator always sees "no index".
   - A collaborator who sends `projectId` on a new chat gets an **unfiled** chat with no error (`src/lib/chat/turn/accept.ts:118-125`), not a refusal.
8. **The full text is loaded twice per Auto turn.**
   - `loadProjectLineage` is called by the router (`chat-inputs.ts:109`) and again by the turn (`project-context.ts:87`). Each call reads every file's full `extractedText` from Postgres.
   - For a 50-file project that is about 10 MB read twice, even when none of it will be sent.

### 0.3 Corrections to the audit

| Audit claim | Verdict | Evidence / correction |
|---|---|---|
| "Every project turn pays for one query-embedding call" | Partly wrong | The embed runs only when the policy permits one for the chat's provider. The two SQL queries always run. |
| "The lexical statement already matches a GIN index on `to_tsvector('simple', text)`" | **False** | The text-search config is a bound parameter (`$n::regconfig`, `lexical-query.ts:57-59`) and can be overridden from the environment (`rank.ts:40`). An expression index will not match reliably in generic plans. Use a stored generated column, as `WebPageCache.searchVector` already does (`schema.prisma:5361,5366`). |
| "Dedupe fix: copy blocks/chunks into a new document row for this project" | Unbuildable as written | It violates `@@unique([userId, checksum, version])` (`schema.prisma:4333`). The unique key has to change (PRJ-1). Also, deleting project A cascades project B's reused document today (`KnowledgeDocument.project onDelete: Cascade`). |
| "Use `text-embedding-3-small` with `dimensions: 768`" | Rejected | The transport sends no `dimensions` (`embed.ts:137-141`). Memory already stores 1536-dimension vectors under the id `openai:text-embedding-3-small`. A shorter variant needs its own catalog id, or the two vector spaces mix. |
| "`ScheduledTask` has no `projectId` → add one" | Wrong target | `ScheduledTask` is retired (`deploy/ecosystem.config.js:217-224`). The live model is `WorkSchedule` → `WorkSession.projectId` (`schema.prisma:3129`, relation `:3236`). The real gap is that `createScheduleSchema` (`src/lib/work/schedule.ts:2125`) has no `projectId`. The route says so in a comment (`src/app/api/work/schedules/route.ts:290-297`). |
| "Extend `tests/retrieval-security.test.ts`" for knowledge scoping | Wrong file | That suite covers web-fetch SSRF. Knowledge SQL scoping is tested statement by statement in `tests/knowledge-retrieve.test.ts`. DB suites follow the `tests/*-db.test.ts` pattern with a loopback URL guard (`tests/memory-scope-db.test.ts:14-25`). |
| "Collaborators cannot open files" | Confirmed, and more | `/api/files/[...key]` authorizes by `attachment.userId === user.id` only (`src/app/api/files/[...key]/route.ts:24-33`). Private source chips are deliberately not links at all (`src/components/chat/source-chip.tsx:64`). PRJ-3 needs an in-app open handler, not an `href`. |
| Claude redesigned projects have a "coordinator chat" | Not on the official page | `support.claude.com/.../9517075` (fetched 2026-10-31) says "Claude breaks the work into parallel threads", with a Library, and that scheduled tasks migrate. It does not mention a coordinator. Not used for any decision here. |
| ChatGPT "Drive folder sync reliability problems" | Weak evidence | OpenAI help, via a search summary, says the Drive app in a project "does not support sync … content will not be synced in advance". Synced Drive sources would therefore be ahead of ChatGPT, not just equal. |

### 0.4 Competitor bar, re-verified 2026-10-31

**Claude, from official pages fetched directly.**
- **Project RAG**: "automatically activates when your project approaches or exceeds the context window limits", "up to 10x", a visual indicator, converts back when knowledge shrinks, uses the "project knowledge search tool", paid plans only [C-rag].
- **Sharing**: roles are Can view ("see project contents, knowledge, and instructions, and chat") and Can edit ("modify project instructions and knowledge, add/remove members"). There is a "Shared with me" view and email notification. Sharing is Team/Enterprise only [C-what].
- **Drive in project knowledge**: Docs as Markdown, Sheets as CSV with every tab, Slides as plain text, about a 10 MB export cap, "refreshes … periodically when you open the project", **private projects only** [C-drive].
- **GitHub in projects**: file and folder browser, "Sync now", several repositories, **private projects only** [C-gh].
- **Memory**: project memory "alongside" account memory, with a "Use account memory" off switch; chat search is scoped to the project [C6].

**ChatGPT, from search summaries of OpenAI help (help.openai.com is not reachable from this session) plus third-party sources.**
- Projects take Drive files/folders and Slack channels as sources. Drive is not pre-synced.
- Shared projects can invite people.
- Project-only memory; shared projects are always project-only [O24][O-mem].

---

## 1. Ranked list

| Rank | ID | Title | Size | Impact | Depends on |
|---|---|---|---|---|---|
| 1 | PRJ-0 | Stop sending deleted project files to the model | S | H | — |
| 2 | PRJ-1 | Turn on the project knowledge index | M | H | — (MEM-5 for universal vectors) |
| 3 | PRJ-2 | Adaptive project context and a `search_project_knowledge` tool (chat and Work) | M | H (quality + cost) | PRJ-1 |
| 4 | PRJ-3 | Clickable citations into project files (page, slide or cell, highlighted) | M | H | PRJ-1; CC-3 registry if landed |
| 5 | PRJ-4 | Knowledge status and capacity on the Sources tab (web and native) | S-M | M | PRJ-1, PRJ-2 |
| 6 | PRJ-5 | Shared projects that work: access layer, context, retrieval scope, files | L | H | PRJ-1 |
| 7 | PRJ-6 | Members, invites and "Shared with me" (web and native) | M | M-H | PRJ-5; parallel share-with-people mailer |
| 8 | PRJ-7 | Retrieval quality: pgvector ANN, neighbours, follow-ups, contextual input, golden-set eval | M-L | M-H | PRJ-1 (MEM-5 recommended) |
| 9 | PRJ-8 | Synced GitHub sources (repo paths, Sync now, push webhooks) | M | M-H | PRJ-1 |
| 10 | PRJ-9 | Synced Google Drive sources (files and folders, shared projects allowed) | M | H | PRJ-8 (`ProjectSource`), parallel Drive attach |
| 11 | PRJ-10 | Project routines (schedules filed in a project, with project knowledge) | S-M | M | PRJ-2 |
| 12 | PRJ-11 | Instructions that scale: meter, cap, inherited preview, revisions | S | L-M | — |

---

## 2. Items

### PRJ-0: Stop sending deleted project files to the model
**Size S · Impact H · No dependencies · Ship first, on its own.**

**Problem (verified)**
- Deleting a file from a project tombstones the attachment: it sets `deletedAt` and `parserState: "deleted"`, and keeps `projectId` and `extractedText` (`src/lib/library-removal.ts:86-91`, called from `src/app/api/attachments/[id]/route.ts:84`).
- `loadProjectLineage` loads `files` with no `deletedAt` filter (`src/lib/projects/project-tree-server.ts:82`). Every later turn in the project, and in its subfolders, therefore still gets the deleted file's full text (`context-assembly.ts:181-197`). The router counts it too (`src/lib/router/chat-inputs.ts:109`).
- The project page hides the file (`src/app/api/projects/[id]/route.ts:60` filters `deletedAt: null`), so the user believes it is gone.

**Build**
1. In `loadProjectLineage`, change the files select to `files: { where: { deletedAt: null, fileName: { not: "__cover__" } }, select: { id, fileName, extractedText } }`.
2. In `scripts/work-runner.ts:946-950`, add `where: { deletedAt: null, fileName: { not: "__cover__" } }`.
3. In `src/app/api/projects/route.ts:24`, change `_count: { select: { conversations: true, files: { where: { deletedAt: null, fileName: { not: "__cover__" } } } } }`. The tree query in `[id]/route.ts:116` already does this.

**Tests**
- `tests/project-folders.test.ts`, or a new `tests/project-lineage-db.test.ts` in the `*-db` style with `KNOWLEDGE_TEST_DATABASE_URL`: a project with files A and B; delete B through `tombstoneAttachment`. Then:
  - `loadProjectLineage(...).merged.files` has A only;
  - `buildProjectReferenceFiles` output does not contain B's text;
  - a subfolder's lineage also omits B.
- A static regression in the repo's existing style (`tests/library-removal.test.ts:324`): assert that the `project-tree-server.ts` source contains `deletedAt: null` inside the `files:` select.
- Restore (`POST /api/attachments/[id]/restore`) puts B back into the lineage.

---

### PRJ-1: Turn on the project knowledge index
**Size M · Impact H · Depends on none · Semantic coverage for default-policy accounts needs MEM-5.**

**What users get**
- In a project with dozens of files, questions are answered from the relevant passages, each labelled "(Report.pdf · page 37)", instead of the whole library being pasted in.
- Deep Research and voice in a project start reading the project's files.
- A replaced file stops answering with its old text.
- The same file in two projects works in both.

**Problem (verified)** See §0.1 and §0.2 items 2 and 4. Also:
- dedupe is per account, not per project (`index.ts:29-35`, `ingest.ts:192-195`);
- the query is embedded even when the scope has no vectors (`retrieve.ts:311-318`);
- the query embed does not pin the stored vector space (`embed.ts:213-224` supports `preferModelId`, and nothing passes it);
- `google:text-embedding-004` is still in the catalog (`embed.ts:69`), but the repo's own pricing note says Google no longer lists it (`src/lib/metering/unit-prices.ts:113-118`).

**Data model** — one migration, `prisma/migrations/20261101xxxxxx_project_knowledge_index/migration.sql`:
- `KnowledgeDocument`:
  - add `embeddingState String @default("pending")`, one of `pending | embedding | embedded | lexical_only`;
  - add `embeddingModel String?`, `embeddingReason String?`, `embeddingClaimedAt DateTime?`, `chunkCount Int @default(0)`, `tokenCount Int @default(0)`;
  - **drop** `@@unique([userId, checksum, version])`;
  - **add** `@@unique([attachmentId, version])`, `@@index([userId, checksum])`, `@@index([userId, embeddingState])`;
  - no code uses the old compound key (grep `userId_checksum_version`: no hits).
- `KnowledgeChunk`:
  - add `textHash String?`: sha256 of the embedding input, used to reuse vectors;
  - add `searchVector Unsupported("tsvector")? @default(dbgenerated("to_tsvector('simple'::regconfig, text)"))` with `@@index([searchVector], type: Gin)`. This is the `WebPageCache` pattern at `schema.prisma:5361-5366`.
  - Add `@@index([documentId, textHash])`.
- `KnowledgeBlock`: no change. Ids are now generated client-side.

**Build**
1. **Store** (`src/lib/knowledge/ingest.ts:122-134` interface and `index.ts` `prismaStore`):
   - `replaceBlocks` assigns `id: randomUUID()` to each block and returns the ids.
   - New `replaceChunks(userId, documentId, chunks)`: `deleteMany`, then `createMany` in batches of 500, every row with `userId`.
   - `latestByChecksum` becomes `latestForAttachment(userId, attachmentId)`.
   - New `findReusable(userId, checksum, parser, parserVersion)` returns a settled document with the same bytes, from any attachment.
2. **Ingest** (`runIngest`), in this order:
   - extract;
   - `replaceBlocks`;
   - `packDocumentChunks(blocks)` (`chunk.ts:232`), then `replaceChunks` (empty vectors);
   - update the document with `chunkCount`, `tokenCount`, `embeddingState: "pending"`, `state: ready|degraded`.
   - The `state` flip is last, so a half-written document is never retrievable: retrieval filters on `RETRIEVABLE_STATES`.
3. **Reuse without cross-project coupling.**
   - When `findReusable` hits, create a **new** document row for this attachment and copy blocks and chunks, vectors included, with `INSERT … SELECT` in raw SQL. Both statements bind `userId`, and the block ids are remapped through a temporary mapping (`gen_random_uuid()`).
   - There is no extraction and no embedding spend. Each attachment owns its document, so deleting project A no longer cascades away project B's knowledge.
4. **Supersede by attachment.** After a successful ingest, mark every other live document for the same `attachmentId` as `state: "stale"` with `supersededById` set. This fixes §0.2 item 2 for replace and restore, and old citation ids keep resolving.
5. **Embedding sweep, off the upload path.** New `src/lib/knowledge/embed-sweep.ts`, started from a new `scripts/knowledge-indexer.ts` that is imported by `scripts/sweepers.ts` (the same pattern as `./sweep-import-runs`). Every 30 s:
   - **Claim:** up to 2 documents with `embeddingState = 'pending'`, or `'embedding'` with a claim older than 15 minutes, using a conditional `updateMany` (the lease pattern of `src/lib/import-recovery.ts:140-186`).
   - **Policy:** `embedTexts({ texts, userId, policy: loadBackgroundProviderPolicy(userId), conversationProvider: null, preferModelId: <dominant embeddingModel in this project> })`. With no conversation provider, `same_provider` yields no remote candidates by design (§0.2 item 4). Local candidates (`isLocal`, MEM-5) and `any_allowed_provider` / `selected_provider` accounts get vectors. Every other account gets `lexical_only` with `embeddingReason` set to the denial reason.
   - **Reuse:** before calling the provider, copy vectors from any chunk with the same `textHash` and `embeddingModel`. Chunking is deterministic (`chunk.ts:225-228`), so a re-index after a parser bump costs nothing.
   - **Write:** one `UPDATE "KnowledgeChunk" c SET embedding = v.e, "embeddingModel" = $m FROM (VALUES …) v(id, e) WHERE c.id = v.id AND c."userId" = $u`, batched 200 at a time.
   - **Throttle:** at most 2,000 chunks per user per hour. Spend is already recorded by `embedTexts` (`embed.ts:231-239`).
   - **Re-check:** `lexical_only` documents are retried when `Settings.updatedAt > embeddingClaimedAt` or once a day.
6. **Backfill.** The same sweep picks up `ready|degraded` documents with `chunkCount = 0` and at least one block. It chunks them from the stored `KnowledgeBlock` rows, with no re-extraction. It also picks up project attachments with `parserState in (ready, degraded)` that have no live document for their id: these were the old cross-project reuses. They are cloned from their checksum sibling (step 3), or re-queued.
7. **Query side** (`src/lib/knowledge/retrieve.ts`):
   - Move the vector statement into a pure builder, `vectorCandidateQuery` in `lexical-query.ts`, that binds **both** `c."userId"` and `d."userId"`. That makes it statement-testable like the lexical query.
   - The lexical leg uses `c."searchVector" @@ to_tsquery('simple', $expr)` with the config inlined as a constant (`Prisma.raw` of a whitelisted literal). When `KNOWLEDGE_TSCONFIG` is not `simple`, keep the computed path.
   - Resolve the scope's vector space first, with one `GROUP BY "embeddingModel"` over the scope's chunks. If it is null, **skip `embedQuery` entirely**. If not, call `embedQuery` with a new `requireModelId` option, which tries only that model. If the policy does not permit that model, the result is lexical with reason `query_model_not_permitted`, and no provider call is made.
   - `retrieveProjectKnowledge` returns `null` when the scope has no document with `chunkCount > 0`, before any embed. This replaces the document-only check at `:484-495`.
8. **Catalog.** Remove `google:text-embedding-004` from `EMBEDDING_MODELS`. Register the Google model that `unit-prices.ts:113-118` actually prices, after checking its id against the provider's model list, under a **new** id. Do not change `text-embedding-3-small` dimensions in place (§0.3).
9. **Labels.** The project file label "Indexed" (`src/components/projects/project-sources-list.tsx:72-90`) means `chunkCount > 0`. Expose `chunkCount` and `embeddingState` from `GET /api/projects/[id]` (`route.ts:66-79`); the full panel is PRJ-4.

**Security**
- Every new raw statement binds the owner on chunk **and** document.
- The clone `INSERT … SELECT` reads and writes only rows of the same `userId`.
- `tests/knowledge-retrieve.test.ts` gains assertions on the vector builder of the kind it already makes for the lexical one: the account appears twice and no user text reaches the SQL.

**Acceptance tests**
- **Unit** (fake store and fake transport, extending `tests/knowledge-retrieve.test.ts`):
  - every chunk's `blockIds` is a subset of the ids `replaceBlocks` returned;
  - ordinals are dense;
  - `state` is written after `replaceChunks`;
  - the outcome is `embeddingState: "pending"`.
- **New DB suite `tests/project-knowledge-db.test.ts`** (`KNOWLEDGE_TEST_DATABASE_URL`, loopback guard as in `memory-scope-db.test.ts:14-25`, added to a new `test:knowledge:db` script):
  - (a) Three fixture documents in a project, then one sweep with a fake transport → chunks carry vectors and `embeddingModel`. A question whose answer is only on page 37 of file 2 returns a passage with locator `page 37`.
  - (b) Policy `same_provider` with no local model → `embeddingState = lexical_only` and `embeddingReason = no_candidate_for_conversation_provider`. A keyword question still retrieves the passage, and the embed spy is called **0** times on the query.
  - (c) The same bytes in projects A and B → two documents, each retrievable only in its own project. Deleting A leaves B's passages intact.
  - (d) Replace a file's bytes → the old document is `stale` and retrieval returns only the new text. `GET /api/knowledge/documents/<old id>` still resolves.
  - (e) A document with blocks and no chunks is chunked after one sweep, and the extractor spy is not called.
  - (f) A re-index with an unchanged chunk text → the transport is called 0 times (vectors reused by `textHash`).
  - (g) With `SET enable_seqscan = off`, `EXPLAIN` of the lexical statement shows the `KnowledgeChunk_searchVector_idx` index.
  - (h) `productionPrivatePorts().project` (Deep Research) returns at least one passage on the fixture.
  - (i) A query embedded with model X never compares against vectors from model Y.

**Rollout**
- Flag `KNOWLEDGE_CHUNKING=1`, default on in development and off in production for one deploy while the backfill drains. Watch `knowledge.ingest` logs and `ApiSpend` rows with `model like 'embedding:%'`.
- No behaviour change for the turn until PRJ-2, except that retrieval may now return passages. That works with today's code, because `buildProjectReferenceFiles` drops indexed files when passages exist (`project-context.ts:136-142`). Note that today's logic is all-or-nothing, so PRJ-2 should land close behind.

**Not in this PR:** pgvector (PRJ-7), the mode switch (PRJ-2), UI beyond labels (PRJ-4).

---

### PRJ-2: Adaptive project context and a `search_project_knowledge` tool (chat and Work)
**Size M · Impact H, on both quality and API cost · Depends on PRJ-1.**

**What users get**
- Small projects keep today's best-quality "every file in context" behaviour, byte-identical, so the prompt cache still holds.
- Large projects stop failing and stop being expensive: the model gets a bounded set of relevant passages plus a tool to search the whole knowledge base itself, several times if it needs to.
- Work tasks and routines filed in a project can finally read its files.

**Bar to meet.** Claude switches to RAG near the context limit and uses a project knowledge search tool [C-rag]. Alevr switches earlier, chosen on cost, and gives the Work agent the same tool. Neither competitor documents that.

**Problem (verified)**
- The dump is unbounded (`context-assembly.ts:181-197`).
- The router under-estimates (§0.2 item 3).
- When retrieval comes back empty, the turn falls back to the whole dump (`project-context.ts:136-142, 290`).
- `read_document` reaches only the **60 oldest** attachments of the project itself, not its folder lineage (`src/lib/agent/attachments.ts:25,41,52-53`).
- Folder lineage retrieval is cut to 20 files (`retrieve.ts:534`, mirrored at `chat-inputs.ts:127`).
- Full text is loaded twice per turn (§0.2 item 8).
- Work runs see file names only (`scripts/work-runner.ts:972-977`).

**Build**
1. **Pure decision module** `src/lib/projects/context-mode.ts`:
   ```ts
   export type ProjectContextMode = "whole" | "retrieval";
   export const WHOLE_FILES_MAX_TOKENS = Number(process.env.PROJECT_WHOLE_FILES_MAX_TOKENS ?? 40_000);
   export function decideProjectContextMode(i: { knowledgeTokens: number; retrievableDocs: number; modelWindow?: number }): ProjectContextMode
   // "whole" when knowledgeTokens <= min(WHOLE_FILES_MAX_TOKENS, 0.25 * (modelWindow ?? Infinity)) or retrievableDocs === 0
   ```
   Why 40k:
   - Above it, a turn costs more than retrieval on every provider without prompt caching, and on every cache miss.
   - On Anthropic with a warm cache the break-even point is higher, but cache misses (TTL expiry, a model switch) and long-context surcharges make 40k the cost-safe default.
   - PRJ-7's eval tunes the number.
2. **Cheap size probe.**
   - New `loadProjectContextMeta(ownerUserId, projectIds)` in `src/lib/projects/project-tree-server.ts`. It runs one `$queryRaw` with `SELECT a.id, a."fileName", char_length(a."extractedText") AS chars …`, binding `userId` and `"projectId" = ANY($ids)`, with `deletedAt IS NULL`.
   - It also counts documents with `chunkCount > 0`.
   - Full text is loaded through `loadProjectFileTexts(ownerUserId, ids)` **only** in whole mode.
   - `loadProjectLineage` splits into the meta loader and the text loader. The router (`chat-inputs.ts:109`) uses the meta loader only, and estimates whole-mode tokens as `ceil(chars / 3)`, which errs high for CJK.
3. **Router estimate** (`src/lib/router/chat-context.ts:128-137`).
   - Replace the `indexedFileNames` heuristic with the mode:
     - in whole mode, today's computation;
     - in retrieval mode, `retrievalBudget + 1_024 + SEARCH_TOOL_SCHEMA_TOKENS`.
   - The turn then calls `decideProjectContextMode` again with the selected model's window. It may only move from whole to retrieval, never back, so the estimate stays an upper bound.
4. **Turn assembly** (`src/lib/chat/turn/project-context.ts`).
   - In **whole** mode, run no retrieval at all: no embed and no SQL, which saves the futile call on every small-project turn. `buildProjectReferenceFiles` is unchanged, which keeps the prefix byte-identical.
   - In **retrieval** mode:
     - pre-retrieve with `tokenBudget = clamp(0.05 × window, 3_000, 10_000)` and `maxPassages = 12` (`PackOptions`, `rank.ts:325-334`);
     - **never** call `buildProjectReferenceFiles`;
     - if passages come back empty, say so: the prompt names the files (at most 50, with a "+N more" count) and says "search them with search_project_knowledge". It never falls back to the dump.
   - Files in the scope that are not yet chunked are listed with their state: "still being indexed; use read_document".
5. **Scope type.** New `src/lib/projects/knowledge-scope.ts`: `KnowledgeScope { ownerUserId: string; projectIds: string[] }`.
   - Built from the lineage for the owner. PRJ-5 extends it to collaborators.
   - Retrieval gains a `filters.projectIds` filter (`d."projectId" = ANY(...)`) in both legs. This replaces attachment-id slicing for lineage (`project-context.ts:118-126`, `retrieve.ts:534`, `chat-inputs.ts:121-131`).
6. **Tool `search_project_knowledge`.**
   - Agent tool in `src/lib/agent/project-search.ts`, registered in `src/lib/agent/runtime.ts` next to `readDocumentTool` (`:159`).
   - Chat spec in `src/lib/tools/specs/search-project.ts`, wrapping the agent tool as `read-document.ts` does, with a `.prompt.ts` holding its description.
   - Args: `{ query: string; files?: string[] (names); k?: number (default 8, max 20) }`.
   - The scope always comes from `AgentExecutionContext` (userId, conversationId, projectId) through `KnowledgeScope`. **No argument can name a project.**
   - Returns passages inside `wrapUntrusted`, each with `fileName · locator`. Once PRJ-3 lands, it returns citation numbers instead.
   - Read-only, parallel-safe, `risk: read`, at most 4 calls per turn.
   - Entitlement: attached in `src/lib/tools/entitlements.ts` (next to `read_document`, `:248`) only when the mode is retrieval and the model has `agenticTools`.
7. **`read_document` reach** (`src/lib/agent/attachments.ts`).
   - When `file` is given, resolve by name within the scope (all lineage project ids), with no 60-oldest window.
   - `list` returns the newest 100 plus a total count.
8. **Work runtime.**
   - Replace the sentence at `scripts/work-runner.ts:972-977` with: "Search them with search_project_knowledge or open one with read_document."
   - Ensure the agent context carries `projectId`, which `runtime.ts:228,360,397` already passes.
9. **Receipt.** Add `projectContextMode`, `knowledgeTokens` and `projectSearchCalls` to the turn trace next to `documentPassages` (`src/lib/chat/turn/run-turn.ts:469`).

**Security**
- The tool's scope is derived only from the conversation. The SQL binds `ownerUserId` on chunk and document and `projectId = ANY(scope)`.
- A Work run filed in project A cannot reach project B: the scope comes from `WorkSession.projectId`, which `dispatch.ts:430-436` checks for ownership.

**Acceptance tests**
- `tests/project-context-mode.test.ts` (pure): the decision table at the boundaries (39,999 / 40,001; a 128k window; a 32k window; zero retrievable documents → whole).
- **Golden prefix:** a 3-file, 8k-token project → `modelHistory[firstUser].content` is byte-identical to the pre-change output (a snapshot), and the embed spy and SQL spy are called **0** times.
- DB suite (PRJ-1's), a 12-document fixture of about 300k tokens with a 128k-window fake model:
  - `estimateAutoContext` stays under 20k;
  - `decide` throws no `NoAutoCandidateError`;
  - the assembled prompt is under 20k tokens;
  - the tool is attached;
  - no file text envelope appears in the first user turn.
- Zero-passage retrieval in retrieval mode → the prompt lists the file names and contains no file text.
- The tool finds a passage in file 61 and in the oldest file. A context with no `projectId` returns `not_permitted`. A comparison question across two files triggers two calls in a fake-model harness, capped at 4.
- A Work runtime unit test with a fake context in a project: the tool returns a passage. A context for project A never returns B's chunk.
- Cost fixture (`bench/` script): input tokens for the 300k-token fixture are under 20k per turn, against about 300k before, logged in the PR.

**Rollout.** Ship behind `PROJECT_ADAPTIVE_CONTEXT=1`. Default it on once the PRJ-1 backfill has drained.

---

### PRJ-3: Clickable citations into project files (page, slide or cell, highlighted)
**Size M · Impact H (trust) · Depends on PRJ-1, plus CC-3's per-turn `SourceRegistry` if it has landed (if not, this PR adds a minimal one).**

**What users get**
- Each claim drawn from a project file carries a numbered pill.
- Clicking it opens the file in the side viewer at the exact page, slide or sheet, with the passage highlighted.
- Older versions open with an "older version" note; deleted files say so.

**Bar to meet.** Neither competitor documents page-level deep links into project files. Alevr already stores block locators and geometry (`KnowledgeBlock.page/slide/sheet/cellRange/bbox`, `schema.prisma:4339-4374`). This would put Alevr ahead.

**Problem (verified)**
- Citations are plain text, "(file · page 4)" (`context-assembly.ts:159-161, 268-275`).
- Private sources render as labels and never as links (`source-chip.tsx:14-17, 64`).
- `Message.sources` holds web sources only (`schema.prisma:952`).

**Build**
1. **Register sources.**
   - Each packed passage (`buildProjectPassages`) and each `search_project_knowledge` result is registered in the turn's source registry as a `ClientSource` (`src/types/chat.ts:189-206`):
     - `url: privateSourceUrl({ kind: "project", id: <chunkId of the run's first chunk>, locator })` (`src/lib/research/private-sources.ts:84-88`);
     - `title: fileName`;
     - `snippet`: the first 200 characters;
     - `cited: true`.
   - The prompt label becomes `[n] fileName · locator`, and the instruction says "cite as [n]".
   - Sources persist through the existing `sources` path (`src/lib/chat/turn/persist.ts:99`).
2. **Unresolved markers.** A `[n]` with no matching registered source is stripped when the message is finalized and logged as `citation.unresolved`. This reuses CC-3's resolver if it exists.
3. **Locate endpoint.** `GET /api/knowledge/chunks/[id]/locate` returns:
   - `{ attachmentId, documentState, page?, slide?, sheet?, cellRange?, blocks: [{ id, page, bbox }], quote }`.
   - Authorization: the chunk's document's `userId === viewer`, or (after PRJ-5) `checkProjectAccess(viewer, document.projectId, "VIEWER")`. Anything else is a 404, following the no-oracle rule of `src/app/api/attachments/[id]/document/route.ts:12-16`.
   - Rate limit: 600 per hour.
4. **Chip interaction.**
   - In `source-chip.tsx`, private sources of kind `project` (and `file`) render as a `<button>`, never an `<a>`, so `isRenderableSourceUrl` stays as it is.
   - The button dispatches the existing document-viewer open event with `{ chunkId }`.
   - `DocumentViewer` (`src/components/documents/document-viewer.tsx:343-355`) gains `initialLocation?: { page?; slide?; sheet?; blockIds?; quote? }`.
   - The PDF path calls `goToPage` (`pdf-view.tsx:656`) and highlights by `bbox`. If there is none, as with OCR'd or older blocks, it falls back to the existing find highlighter (`src/components/documents/find.ts`) with `quote`.
   - Office documents scroll to `[data-loc-page|slide|sheet]` (`document-viewer.tsx:111-117`).
   - A stale document shows "This is an older version of the file"; a tombstoned one shows "This file was deleted".
5. **Native (same PR, small).**
   - The chip resolves the same endpoint, then opens PDFKit at `page - 1` and highlights through `PDFSelection` on `quote`.
   - Other formats open QuickLook at the file.
   - Files: `native/Packages/JunoNativeKit/Sources/JunoChatKit/` (source decoding) and the macOS/iOS message source views.

**Acceptance tests**
- Unit: a turn with two passages persists two `project` sources with `cited: true`. After persist and reload, `[2]` resolves to `Message.sources[1]`.
- Unit: a model-written `[9]` with 5 registered sources is removed and logged.
- Playwright: click pill 2 → the viewer opens `Report.pdf` at page 37, `[data-cite-highlight]` is visible, and focus moves to the viewer.
- Locate endpoint DB test:
  - the owner gets 200;
  - another account gets 404;
  - a stale document returns `documentState: "stale"`;
  - a tombstoned one returns `"tombstoned"` with no text.
- Native unit: source decoding of a `private.invalid/project/...` URL yields a project citation.

---

### PRJ-4: Knowledge status and capacity on the Sources tab (web and native)
**Size S-M · Impact M · Depends on PRJ-1 and PRJ-2.**

**What users get**
- The Sources header reads, for example, "128k tokens · Searching relevant passages" or "Whole files (12k tokens)".
- It shows counts of indexed, partly readable, failed and indexing files, and the semantic-search state in plain words, for example: "Keyword search only: your privacy setting sends file text to no embedding provider. Change it in Settings → Privacy."
- Failed files offer a one-click Retry.

**Bar to meet.** Claude shows a RAG indicator in place of its capacity bar [C-rag].

**Problem (verified)**
- Labels exist per file only, with no actions (`project-sources-list.tsx:72-90`).
- `LexicalOnlyReason` is computed and never shown (`retrieve.ts:96-103`).
- The status lookup is viewer-scoped (§0.2 item 7).

**Build**
- `GET /api/projects/[id]/knowledge` (VIEWER+) returns:
  ```
  { mode, knowledgeTokens, wholeFilesLimitTokens,
    files: { indexed, partial, failed, pending },
    semantic: { state: "on"|"keyword_only"|"pending", model?, reason?, reasonText? } }
  ```
  It reuses the PRJ-2 meta loader and the existing denial-message helper in `background-provider-policy.ts` (`:218`).
- `POST /api/projects/[id]/knowledge/reindex { attachmentId? }` (EDITOR+) sets `parserState: "queued"` on the owner's attachment, owner-scoped. The PRJ-1 sweep, extended to claim queued project attachments the way `sweepQueuedImportIngests` does but without the `origin: "import"` filter, picks it up. Rate limit: 10 per hour per project.
- Fix the per-file lookup in `src/app/api/projects/[id]/route.ts:66-79` to bind the **project owner's** id (`project.userId`), not `user.id`.
- Web: a status strip and per-file Retry in `src/components/projects/project-sources-list.tsx`.
- Native:
  - a status row and a retry action in the macOS Sources tab (`native/macOS/JunoDesktop/App/DesktopProjectPage.swift`, `sourcesTab`) and in the iOS project page (`native/iOS/JunoMobile/App/JunoMobileProjectPage.swift`);
  - a client method in `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeProjectStore.swift`;
  - knowledge tables are not in the sync feed (`native/desktop-electron/docs/SYNC.md:461`), so the status is fetched over the API.
- Optional, behind a flag: `POST .../knowledge/preview { query }` returns the top 5 passages with their locators and per-leg ranks, no raw scores. Rate limit: 30 per hour. Ship it only if it fits the budget.

**Acceptance tests**
- A failed PDF shows Retry; after the sweep it becomes Indexed.
- A `same_provider` account with no local embedder sees `keyword_only` with the reason text.
- A collaborator (after PRJ-5) sees the same counts as the owner.
- Reindex by a VIEWER → 404; by an EDITOR → 202.
- Native decoding test for the response shape.

---

### PRJ-5: Shared projects that work (access layer, context, retrieval scope, files)
**Size L · Impact H · Depends on PRJ-1. Step 1 can ship alone, immediately.**

**What users get**
- A teammate given **Can chat** (VIEWER) or **Can edit** (EDITOR) can chat in the project with its instructions, files and knowledge, and open and cite its files.
- Editors can add files.
- Everyone's chats stay private to them, and each person's memory stays their own.

**Bar to meet.** Claude's Can view / Can edit: viewers "see project contents, knowledge, and instructions, and chat", and editors modify knowledge and members [C-what]. ChatGPT shared projects [O24].

**Problem (verified)**
- Shared projects are not listed for the collaborator (`src/app/api/projects/route.ts:15-16`).
- New chats are silently unfiled (`accept.ts:118-125`).
- Workspace config, filing and the PATCH move are owner-only (`src/lib/chat/turn/identity.ts:106-112`, `src/app/api/conversations/[id]/route.ts:70-71`).
- Context is loaded only for the owner (`project-tree-server.ts:69-89`).
- Retrieval is bound to the viewer's id.
- Files are owner-only (`src/app/api/files/[...key]/route.ts:24-33`, `src/app/api/attachments/[id]/document/route.ts:27`).
- Uploads are owner-only (`src/app/api/upload/route.ts:63-64`, plus `src/app/api/v1/attachments/route.ts`).
- Chat titles leak (`projects/[id]/route.ts:41-63`).

**Build**
1. **Title leak (ship first, S).** In `GET /api/projects/[id]`, change the `conversations` include to `where: { userId: user.id }`. Each member sees only their own chats, including the owner. A test asserts that a viewer gets none of the owner's titles.
2. **Access resolver.** `src/lib/projects/project-access.ts`: `resolveProjectAccess(viewerId, projectId)` returns `{ role, ownerUserId, scope: KnowledgeScope }`, or null.
   - It uses `getProjectRole` (`src/lib/project-collaboration.ts:35-63`).
   - The scope covers the full lineage for the owner, and the shared project id only for others. Collaborators never inherit the owner's parent-folder instructions or files, the same folder-privacy rule as `projects/[id]/route.ts:95-105`. This is stated in the project Settings for the owner.
   - It is the **only** way new code may reach `prismaUnguarded` for project data, and every unguarded read sits right after it.
3. **Listing.** `GET /api/projects?scope=shared` lists `projectMember.findMany({ where: { userId } })` joined to the project (name, owner name, role, counts).
4. **Filing.**
   - `accept.ts:118-125`, `identity.ts:106-112` and `conversations/[id]/route.ts:70-71` use `resolveProjectAccess(…, "VIEWER")`.
   - When it fails: 404 "Project not found" instead of silently unfiling.
   - `identity.ts` reads `ProjectWorkspace` by `ownerUserId`, so the project's persona and its tool and connector allowlists (which only narrow) apply to collaborators too.
5. **Context loader.** `resolveProjectContext` and `chat-inputs.ts` call the PRJ-2 meta and text loaders with `access.scope`. `loadProjectLineage(conversation.userId, …)` no longer decides access.
6. **Retrieval and tools.**
   - `retrieveProjectKnowledge`, `search_project_knowledge` and `read_document` (`src/lib/agent/attachments.ts`) all take a `KnowledgeScope`. The SQL binds `scope.ownerUserId` on both chunk and document plus `projectId = ANY(scope.projectIds)`, and never the viewer's id.
   - `ensureAttachmentText` (`index.ts:221-273`) writes only to attachments the conversation owner owns. Project files already carry their text.
7. **File access.**
   - `canReadObject` (`files/[...key]/route.ts:24-33`), `attachments/[id]/document`, `attachments/[id]/preview|thumbnail` and the PRJ-3 locate endpoint also allow `attachment.projectId && checkProjectAccess(viewer, projectId, "VIEWER").allowed`.
   - The check runs per request with no caching, so removal takes effect immediately.
8. **Editor uploads.**
   - `upload/route.ts` and `v1/attachments` accept `projectId` for EDITOR+.
   - The row's `userId` is the **project owner**, and a new `Attachment.addedByUserId String?` records the uploader. The owner's library quota applies through the existing `LibraryQuotaExceededError`, and the message says "the project owner's storage is full".
   - Editors may delete files they added; the owner may delete any.
9. **Roles.**
   - VIEWER: chat, read and cite files.
   - EDITOR: also instructions, files, sources and work defaults (`PATCH` is already EDITOR, `projects/[id]/route.ts:240`).
   - OWNER: also delete, move and members.
10. **Memory.** No change. Facts are keyed by `(userId, projectId)`, and summaries are per member (`schema.prisma:1432`, `projects/[id]/memory/route.ts`). MEM-4 owns the account-memory toggle; shared projects default to isolated.

**Security**
- The new DB suite `tests/project-sharing-db.test.ts` (loopback guard) must cover:
  - (a) a viewer's `GET /api/projects/[id]` contains no owner chat titles, and the owner's contains none of the viewer's;
  - (b) a viewer's chat in the project gets the project instructions (test instruction: "reply in French") and retrieves a passage from the owner's file;
  - (c) a viewer upload → 404, an editor upload → 201, and the file is retrievable by both;
  - (d) after removal: project, `/api/files/<key>`, locate and retrieval all return 404 or empty **on the next request**;
  - (e) a forged `projectId` for a project the user is not a member of → 404, and no chat is created;
  - (f) the viewer's memory facts never appear in the owner's `getMemoryProfile`;
  - (g) parent-folder instructions are absent from the viewer's prompt;
  - (h) a viewer of A cannot reach B's chunks through any tool, even with B's attachment id in `file`.
- Statement tests: the scoped retrieval binds `ownerUserId` twice.

**Not in this PR:**
- members UI and invites (PRJ-6);
- sharing a chat with the project (reuse the parallel share-with-specific-people feature later);
- Work tasks filed by collaborators (`dispatch.ts:430-436` stays owner-only).

---

### PRJ-6: Members, invites and "Shared with me" (web and native)
**Size M · Impact M-H · Depends on PRJ-5; reuses the mailer and invite UI of the parallel share-with-specific-people work.**

**What users get.** A Share button on the project lets the owner:
- invite people by email as Can chat or Can edit, including people with no account yet;
- change roles, remove members and see pending invites.

Members can leave. Invited people get an email and an in-app notification, and the project appears under "Shared with me" on web, macOS and iOS.

**Problem (verified)**
- There is a members API (`src/app/api/projects/[id]/members/route.ts`) and no caller in `src/components`, `src/app` or `native/`.
- Adding an email with no account fails with "User not found." (`project-collaboration.ts:159-168`).
- There is no notification.

**Data model**
- `ProjectInvite { id, userId (project owner, so it fits OWNER_COLUMN), projectId, email, role, tokenHash, invitedById, expiresAt, acceptedAt?, revokedAt?, createdAt }`.
- `@@unique([projectId, email])`, `@@index([tokenHash])`.
- Add it to `OWNER_COLUMN` in `src/lib/db.ts`.

**API**
- `POST /api/projects/[id]/members { email, role }` (OWNER):
  - an existing user → upsert `ProjectMember` (the current path) plus a `Notification` with the new type `project_shared` (`schema.prisma:823-840`);
  - otherwise → create `ProjectInvite` with a random 32-byte token (stored as sha256, 14-day expiry) and send email.
  - Caps: 50 members per project; 20 invites per day per owner.
- `GET /api/projects/[id]/invites`, `DELETE /api/projects/[id]/invites/[inviteId]` (OWNER).
- `POST /api/project-invites/accept { token }` requires a signed-in user whose **verified** email equals the invite email, so a forwarded link does not grant access. It creates `ProjectMember` and marks the invite accepted.
- A new user signing up with that email sees pending invites on first load.
- `DELETE /api/projects/[id]/members/[userId]` already allows leaving (`removeProjectMember`, `project-collaboration.ts:220-236`).

**UI**
- Web: a Share button in `src/components/projects/project-workspace-header.tsx` opens a members dialog: list, role select (Can chat / Can edit), remove, pending invites with revoke.
- Web: a "Shared with me" group in the projects section of `src/components/app/app-sidebar.tsx` and on `/projects`, fed by `GET /api/projects?scope=shared`.
- Native: a "Shared with me" section in `native/macOS/JunoDesktop/App/DesktopProjectsScreen.swift` and `native/iOS/JunoMobile/App/JunoMobileProjectTiles.swift`, fetched over the API. Shared projects belong to another account and are not in this account's sync feed.
- Native: a read-only members sheet plus Leave. Inviting from native is optional for v1.

**Acceptance tests**
- Inviting a non-user then signing up with that email → accept → member. Accepting with a different signed-in email → 403.
- An expired or revoked token → 410.
- An existing user gets a `project_shared` notification.
- The 51st member → 400.
- Playwright: owner invites → member's sidebar shows the project under "Shared with me" → the member opens it and chats.
- Native decoding test for `scope=shared`.

---

### PRJ-7: Retrieval quality (pgvector ANN, neighbours, follow-ups, contextual input, golden-set eval)
**Size M-L · Impact M-H · Depends on PRJ-1. Most valuable once MEM-5's local embedder gives every account vectors.**

**What users get**
- Paraphrased questions find the right passage in a 500-file project, not only among the newest chunks.
- Follow-ups such as "and for 2025?" retrieve the right section.
- The answer reads a passage with its neighbouring context, not a cut-off fragment.

**Bar to meet**
- Anthropic's Contextual Retrieval: contextualised chunks, BM25 and reranking cut top-20 retrieval failures by 35%, 49% and 67%, taking about 150 candidates and passing about 20 [A-cr].
- Claude's project search tool [C-rag].

**Problem (verified)**
- The vector leg ranks only the 180 newest chunks (`retrieve.ts:211, 230`).
- The query is the raw latest message (`project-context.ts:100-101`).
- There is no neighbour expansion; packing stitches only chunks that were both selected (`rank.ts:375-420`).

**Build**
1. **pgvector.**
   - Production is Supabase (`deploy/ecosystem.config.js:116`), which ships pgvector 0.8.
   - CI and e2e switch `postgres:16` → `pgvector/pgvector:pg16` in `.github/workflows/deploy.yml:245`, `e2e.yml:77` and `design-gates.yml:86`.
   - Migration: `CREATE EXTENSION IF NOT EXISTS vector;`, plus `KnowledgeChunk.embeddingVec Unsupported("vector")?`, written next to `embedding Float[]` for one release.
   - Partial HNSW index per active model: `CREATE INDEX … USING hnsw ((("embeddingVec")::vector(1536)) vector_cosine_ops) WHERE "embeddingModel" = 'openai:text-embedding-3-small'`, plus one for the local model when MEM-5 lands.
   - Query, inside `prisma.$transaction`: `SET LOCAL hnsw.iterative_scan = relaxed_order`, then `ORDER BY ("embeddingVec"::vector(1536)) <=> $q::vector(1536) LIMIT 150`, binding owner (×2) and `projectId = ANY($ids)`.
   - Fallback when the extension is missing: an exact scan over the scope's chunks, streamed in batches of 2,000 using `Float32Array` and capped at 20k chunks. Above the cap it goes lexical-only with reason `vector_scan_capped`. Never newest-N.
   - MEM-1 can reuse this column pattern for chat recall.
2. **Neighbour expansion.** For the top 8 hits, also fetch the chunks at `ordinal ± 1` (one query on `(documentId, ordinal)`, index `schema.prisma:4398`). `packContext` merges them.
3. **Follow-up query, no extra model call.**
   - When the latest user message is under 12 estimated tokens, or starts with a back-reference cue ("and", "what about", "the second", "that one", "et", "y", "und", "e", …, in `src/lib/knowledge/followup.ts` with tests per locale), the query is the previous user message plus the current one.
   - The tool path needs nothing: the model writes its own queries.
4. **Contextual embedding input, deterministic.**
   - The embedding input becomes `fileName › heading breadcrumb\n chunk text`. `textHash` covers this input.
   - Stored `text` stays clean for citations.
   - Optional LLM synopsis per document (`runUtilityPrompt`, cached on a new `KnowledgeDocument.synopsis`), behind `KNOWLEDGE_CONTEXTUAL_SYNOPSIS=1`. It runs only when the policy allows a utility model without a conversation provider, and is enabled only if the eval below shows at least +3 points of recall@10.
5. **Eval harness.**
   - `bench/project-retrieval/`: a generated, licence-clean fixture corpus (40 documents across PDF, DOCX, XLSX and PPTX) and 150 labelled questions (file and page). 30% are paraphrases, 20% follow-ups, 10% non-English.
   - `scripts/project-retrieval-bench.ts` reports recall@5/10/20, MRR and citation accuracy against `bench/project-retrieval/baseline.json`.
   - CI runs it with deterministic hash embeddings as a lexical regression gate. A `workflow_dispatch` nightly runs it with real or local embeddings.
   - It also tunes `PROJECT_WHOLE_FILES_MAX_TOKENS` (PRJ-2).

**Acceptance tests**
- A 5,000-chunk corpus: a pure paraphrase of the **oldest** chunk is in the top 10, with pgvector and with the fallback.
- "And the second one?" after a question about a list retrieves the second item's section.
- Golden set: recall@20 ≥ 0.90 with vectors, and lexical-only recall at or above the recorded baseline, with no regression.
- p95 retrieval ≤ 150 ms at 50k chunks with pgvector, on CI hardware.

**Not in this PR:** cross-encoder or LLM rerank (see §3).

---

### PRJ-8: Synced GitHub sources (repo paths, Sync now, push webhooks)
**Size M · Impact M-H · Depends on PRJ-1. Introduces the `ProjectSource` model that PRJ-9 reuses.**

**What users get**
- Add a repository subfolder to a project once. The project shows "Synced 4 min ago · Sync now" and stays current on pushes.
- Old citations still open the version they quoted.
- Unlike Claude, this works in shared projects too.

**Bar to meet.** Claude: file browser, Sync now, several repositories, **private projects only** [C-gh].

**Problem (verified)**
- Project files come only from upload (`project-sources-list.tsx`).
- App installation tokens exist (`src/lib/github-app.ts:260`), as does a verified webhook route (`src/app/api/github/webhook/route.ts`, signature check `github-app.ts:384`).
- GitHub OAuth connections are stored as `Connection` rows with provider `"github"` (`schema.prisma:228`).

**Data model**
- `ProjectSource { id, userId (project owner, for OWNER_COLUMN), projectId, addedByUserId, kind ("github_repo"), externalId ("owner/repo"), selection Json ({ branch, paths: string[] }), cursor Json ({ treeSha }), status ("ok"|"syncing"|"error"|"revoked"), lastSyncedAt?, lastError?, fileCount Int, createdAt, updatedAt }`.
- `@@unique([projectId, kind, externalId])`. Add it to `OWNER_COLUMN`.
- `Attachment`: add `sourceId String?`, `externalPath String?`, `externalRevision String?` (the blob sha), with `@@unique([sourceId, externalPath])`.

**Build**
1. **Authorization: the escalation `userCanPushToRepo` exists to stop (`github-app.ts:286-306`).**
   - New `userCanReadRepo(oauthToken, target)` requires `permissions.pull === true` from `GET /repos/{o}/{r}` with the **adder's** OAuth token.
   - It is checked when the source is added and at the start of every sync.
   - Reads use the adder's OAuth token. An installation token is used only after this check passes, so it narrows access and never widens it.
   - A failure → `status: revoked`, and every attachment of the source is tombstoned through `tombstoneAttachment`. That removes it from retrieval and keeps citations resolvable as deleted. The owner is notified.
2. **Sync worker.** `src/lib/projects/source-sync.ts`, ticked by `scripts/knowledge-indexer.ts`:
   - `GET /repos/{o}/{r}/git/trees/{branch}?recursive=1`, filtered by the selection paths and globs.
   - Only files the text extractor claims (`selectExtractor`, `src/lib/knowledge/extract/index.ts:81-104`), each ≤ 1 MB. At most 2,000 files and 50 MB per source.
   - A blob sha different from `externalRevision` → fetch the blob and replace the attachment's bytes through a shared `replaceAttachmentBytes()`, extracted from `src/app/api/attachments/[id]/versions/route.ts`, so versions and supersede (PRJ-1) apply. Then `scheduleIngest`.
   - A path removed upstream → tombstone.
   - Triggers:
     - push webhooks for a tracked branch enqueue a sync, when the App is installed;
     - otherwise a sync every 6 hours;
     - "Sync now" (`POST /api/projects/[id]/sources/[sid]/sync`, EDITOR+, at most 1 per minute).
3. **API**:
   - `GET|POST /api/projects/[id]/sources` (EDITOR+ to add);
   - `PATCH` to change the selection;
   - `DELETE` (the adder or the owner), which tombstones the source's files.
4. **UI.** "Add source → GitHub" on the Sources tab:
   - a repository picker over the user's repositories;
   - a path tree with checkboxes;
   - a source row with status, last sync, Sync now, and error and reconnect states.
   - Native shows read-only source rows.
5. **Shared projects.** An editor adds the source with their own credential. Members see the content, never the account. The UI warns: "Everyone in this project will be able to read these files."

**Acceptance tests**
- A user with no access to a repository where the App **is** installed cannot add it (403).
- A push touching two tracked files re-ingests exactly those two (fetch spy).
- An untracked path is ignored.
- Revoking the adder's access → `revoked`, and passages disappear from retrieval.
- An old citation to a superseded blob opens as an older version.
- The 2,001st file is refused with a clear `lastError`.

---

### PRJ-9: Synced Google Drive sources (files and folders, shared projects allowed)
**Size M · Impact H · Depends on PRJ-8 (`ProjectSource`) and on the parallel Drive attach work (picker, Drive client and export).**

**What users get**
- Add a Drive file or folder to a project once. Edits in Drive reach the next answer within one sync interval, or at once with Sync now.
- Sheets keep every tab with cell-level citations, which beats Claude's CSV.
- Works in shared projects, unlike both competitors.

**Bar to meet**
- Claude: Docs as Markdown, Sheets as CSV, Slides as text; "refreshes … periodically when you open the project"; about 10 MB export cap; private projects only [C-drive].
- ChatGPT: Drive in projects is not synced in advance [O24].

**Problem (verified)**
- There are no synced sources.
- A Drive change feed exists (`src/lib/first-party-connectors/sync.ts:34-41`), as does a Drive client (`src/lib/connectors/google-drive.ts`).

**Build**
- `ProjectSource.kind` gains `drive_file | drive_folder`; `externalId` is the Drive file id.
- Export formats:
  - Docs → `.docx` (headings become breadcrumbs);
  - Sheets → `.xlsx` (every tab, `Sheet!A1` locators, `src/lib/knowledge/extract/xlsx.ts`);
  - Slides → `.pptx` (slide locators);
  - binary files through `files.get?alt=media`.
- Drive's export cap applies, about 10 MB: an oversized file gets `lastError` and keeps its previous version.
- Folders are non-recursive by default; recursive is opt-in. At most 500 files.
- Change detection: one Drive changes cursor per connection (reuse `readSyncPage`), filtered to tracked file ids and to children of tracked folders. `externalRevision` is Drive's `version`.
- Authorization: the adder's own Drive connection, read-only scope, checked at every sync. Revocation and tombstoning work as in PRJ-8.
- UI: the Drive picker (reused from the parallel attach work) under "Add source → Google Drive", with the same status row as PRJ-8.

**Acceptance tests**
- Edit a synced Doc → after "Sync now", the next answer quotes the new text, and the old citation opens the older version.
- A 12 MB Sheet → `lastError` and no partial content.
- A shared project member retrieves from a source an editor added.
- Disconnecting Drive → `revoked`, and passages are gone.

---

### PRJ-10: Project routines (schedules filed in a project, with project knowledge)
**Size S-M · Impact M · Depends on PRJ-2, so the run can read the files. PRJ-8 and PRJ-9 are needed only for the optional trigger.**

**What users get.** "Every Monday, summarise what changed in this project and update the brief" runs with the project's instructions, defaults and knowledge. Its results land in a chat filed in the project.

**Bar to meet**
- ChatGPT Work scheduled tasks keep projects moving [O-rn].
- Claude's redesigned projects keep their scheduled tasks [C-what].

**Problem (verified)**
- `createScheduleSchema` has no `projectId` (`src/lib/work/schedule.ts:2125`).
- `createScheduleSession` mints an unfiled session and conversation (`src/app/api/work/schedules/route.ts:298-321`). Its own comment names the helpers to use (`:290-297`).

**Build**
1. Add `projectId: z.string().cuid().optional()` to `createScheduleSchema`.
2. In `POST /api/work/schedules`:
   - verify the project with `prisma.project.findFirst({ id, userId })` (owner only in v1; EDITOR after PRJ-5);
   - set `projectId` on the new `WorkSession` and `Conversation`;
   - apply `inheritFromProjectDefaults` and `resolveSessionFields` (`src/lib/work/projects.ts:375, 488`).
3. In a project chat, `propose_routine` passes the conversation's `projectId` into the proposal (`src/lib/work/routine-proposal.ts`, `src/lib/chat/routine-tool.ts`), and the accept card sends it.
4. Add a `projectId` filter to `GET /api/work/schedules` (`route.ts:37-43`), and a "Routines" section in the project's Work tab (`src/components/projects/project-work-list.tsx`).
5. Project delete (`DELETE /api/projects/[id]`) **disables** schedules whose session is in the deleted subtree, in the same transaction as `deleteProjectFolder`, and notifies the owner. Without this, `WorkSession.projectId` is `SetNull` (`schema.prisma:3236`) and the routines would keep spending unfiled.
6. Optional, if PRJ-8 or PRJ-9 has merged: a `WorkTrigger` kind `project_source_changed` (`src/lib/work/triggers.ts`), fired once per `(sourceId, revision)`.

**Acceptance tests**
- A routine created from a project chat has `session.projectId` and `conversation.projectId` set. Its run's context includes the project instructions, and the run can call `search_project_knowledge` (fake runtime).
- Another account's `projectId` → 404.
- Deleting the project disables the schedule and keeps its run history.
- A source change fires the trigger once (idempotent).

---

### PRJ-11: Instructions that scale (meter, cap, inherited preview, revisions)
**Size S · Impact L-M · No dependencies.**

**What users get**
- A live token count while editing instructions, with a warning above 8k tokens.
- A visible list of the folder instructions a chat here also follows.
- Version history with restore, showing who changed what. This matters once editors can edit (PRJ-5).

**Problem (verified)**
- Instructions are uncapped (`src/app/api/projects/route.ts:52`, `[id]/route.ts:202`) and are re-sent in the system prompt on every turn.
- Inheritance exists (`src/lib/projects/project-tree.ts:240-257`), and the API already returns `inherited` (`projects/[id]/route.ts:203-211`), but the instructions dialog does not show it.

**Build**
- Show `estimateTokens` (`src/lib/knowledge/chunk.ts:102`) in `src/components/projects/project-instructions-dialog.tsx`, with a warning above 8k tokens.
- Server cap: 100,000 characters on create and on change. Existing longer values stay readable; only a PATCH that grows them is refused.
- An "Also applies here" collapsible in the dialog, from `inherited`. Owner only, as today.
- `ProjectInstructionRevision { id, userId (project owner), projectId, authorId, text, createdAt }`, written on PATCH when the text changes, keeping the last 50. Add it to `OWNER_COLUMN`.
- `GET /api/projects/[id]/instructions/revisions` and `POST …/revisions/[rid]/restore` (EDITOR+).

**Acceptance tests**
- Edit → restore the previous version → the next turn's system prompt contains the restored text.
- A PATCH over 100,000 characters → 400. An existing 120,000-character value is still served.
- A revision records the editor's id in a shared project.

---

## 3. Dropped or merged, and why

| Audit item | Decision | Reason |
|---|---|---|
| PRJ-7 "project brain" (a) automatic sibling-chat recall | Merged into **MEM-1** (memory spec) | MEM-1's automatic reference already scopes project chats to their project and adds citations to past chats. One project-specific note for MEM-1: inside a project, the back-reference cue is not required for the first 2 turns, because the project is a declared shared context. A second note: a collaborator's recall covers only their own chats (`userId`-keyed). |
| PRJ-7 (b) "Use account memory here" | Duplicate of **MEM-4** | MEM-4 specifies `Project.memoryMode` with an isolated default for shared projects. |
| PRJ-7 (c) editable project brief | Dropped | It already exists: the project summary with an edit affordance on the Overview rail (`src/components/projects/project-overview-rail.tsx:294-366`) and the project memory screens on native. |
| PRJ-7 (d) shared notes for editors | Dropped | Functionally the same as project instructions, which editors can already edit (`PATCH` is EDITOR). |
| PRJ-2 LLM query rewriting | Dropped | It adds a model call to the time-to-first-token path. Under the default `same_provider` policy, Anthropic-chat turns have no utility model. The `search_project_knowledge` tool (PRJ-2) lets the model write its own queries for free, and PRJ-7 handles follow-ups with a heuristic. |
| PRJ-2 cross-encoder or LLM rerank | Deferred | It needs a new vendor or utility calls that the policy blocks for default accounts, and it adds latency. Revisit only if PRJ-7's eval shows recall@20 well above recall@5. |
| PRJ-1 `text-embedding-3-small` at 768 dimensions | Rejected as written | It would mix vector spaces with memory under the same model id (§0.3). If wanted later, register it as a separate catalog id. |
| PRJ-3 `Project.knowledgeTokens` denormalised column | Replaced | An aggregate query per turn (PRJ-2 meta loader) cannot drift from the files. |
| PRJ-5 `Conversation.projectVisibility` (share a chat to the project) | Deferred | Not needed to make sharing work; Claude keeps members' chats private. Reuse the parallel share-with-specific-people feature afterwards. |
| PRJ-4 entailment check on citations | Dropped | It costs a model call per answer. The deterministic citation-audit tiers (CC-3) and unresolved-marker stripping (PRJ-3) cover the realistic failure. |
| PRJ-6 URL and Slack sources | Dropped for now | `web_fetch` covers ad-hoc URLs. Slack channel sources are ChatGPT-only and lower value than Drive and GitHub. Revisit after PRJ-9, through the first-party Slack read tools. |
| PRJ-8 "add `projectId` to `ScheduledTask`" | Retargeted | `ScheduledTask` is retired; PRJ-10 targets `WorkSchedule`. |
| PRJ-10 "draft instructions from this project's files" | Dropped | Low value, and it depends on the optional synopsis. |
| Row 30, coordinator and parallel threads | Not specced here | Agents and tasks area. The official Claude page does not describe a coordinator (§0.3). |

---

## 4. Cross-area dependencies

- **MEM-5 (local embedder)** makes PRJ-1's semantic leg work for every privacy policy at zero API cost. Until then, default-policy accounts are lexical-only, but they still have the search tool, which recovers much of the paraphrase gap because the model chooses its own keywords.
- **MEM-1 and MEM-4** own cross-chat recall and the account-memory toggle in projects (§3).
- **CC-3** owns the per-turn `SourceRegistry` and `[n]` pills. PRJ-3 registers project passages into it, and adds a minimal one if CC-3 has not landed.
- **Parallel builds:**
  - Drive attach supplies PRJ-9's picker and Drive export client.
  - Share with specific people supplies PRJ-6's mailer and invite UI patterns.
- **FV-6 (files area: OCR)** is needed for scanned PDFs to produce blocks, and with them chunks.
- **Deep Research:** PRJ-1 fixes its project and library legs. The research audit's "ahead" rating for project sources is wrong today (§0.1).

---

## 5. Cost model (this area's part of "make API calls cheaper")

**Today**
- Every project turn sends every file's full text, deleted files included.
- Ten reports of about 25k tokens each come to about **250k input tokens per turn**.
- The text is loaded from Postgres twice.
- The query may be embedded for nothing.

**After PRJ-0, PRJ-1 and PRJ-2**
- Projects at or under 40k tokens: unchanged and byte-identical, with no retrieval call, so the cached prefix is kept.
- Larger projects send **3-10k tokens of passages** in the uncached tail, plus about 2-4k per optional tool call.
- Expected savings:
  - **10-30× fewer input tokens** on providers without prompt caching and on cache misses;
  - about 2-3× on warm Anthropic caches;
  - no long-context surcharges;
  - no context-window failures.
- Added cost:
  - a one-time embedding per chunk, **$0** with MEM-5's local embedder or about $0.02 per million tokens on `text-embedding-3-small` (`unit-prices.ts:119-123`);
  - one query embedding only when the scope has vectors.
- PRJ-2's cost-fixture test records the before and after figures in the PR.

---

## 6. Sources

- [C-rag] Claude Help, RAG for Projects (fetched 2026-10-31): https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects
- [C-what] Claude Help, What are projects (fetched 2026-10-31): https://support.claude.com/en/articles/9517075-what-are-projects
- [C-drive] Claude docs, Google Drive connector (fetched 2026-10-31): https://claude.com/docs/connectors/google/drive
- [C-gh] Claude docs, GitHub integration (fetched 2026-10-31): https://claude.com/docs/connectors/github
- [C6] Claude Help, chat search and memory (fetched 2026-10-31): https://support.claude.com/en/articles/11817273-using-claude-s-chat-search-and-memory-to-build-on-previous-context
- [O24] OpenAI Help, Projects in ChatGPT (via search summary; help.openai.com not reachable from this session): https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- [O-mem] Project-only memory switch (third-party, unconfirmed by official notes): https://memx.app/blog/chatgpt-project-only-memory-control/ ; https://community.openai.com/t/switching-an-existing-project-to-project-only-memory-seems-to-break-memory-and-indexing-of-older-chats/1393627
- [O-rn] ChatGPT release notes (as cited in the audit; not re-fetched): https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- [A-cr] Anthropic, Introducing Contextual Retrieval: https://www.anthropic.com/news/contextual-retrieval
