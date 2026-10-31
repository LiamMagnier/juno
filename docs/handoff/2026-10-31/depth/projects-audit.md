# Projects: depth audit (Alevr vs ChatGPT Projects vs Claude Projects)

Date: 2026-10-31. Repo: `/home/user/juno` (read-only). Scope: project knowledge (capacity, chunking, embeddings, hybrid search, reranking, citations), Drive/GitHub sync, instructions, project memory isolation, collaboration, the project dashboard, and context shared across chats in one project. The full UI/motion redesign and the features already being built in parallel (share-with-people for chats/artifacts, per-chat memory off, Drive/OneDrive attach, connectors in voice, etc.) are not re-specified here.

---

## 0. Headline findings (read these first)

1. **Project RAG never runs in production. The index table it reads is always empty.**
   - Ingest writes `KnowledgeBlock` rows only (`src/lib/knowledge/index.ts:63-91`, `src/lib/knowledge/ingest.ts:238-251`).
   - Nothing in `src/` ever writes a `KnowledgeChunk` row or embeds a chunk:
     - `packDocumentChunks` is called only from `tests/knowledge-retrieve.test.ts`.
     - `embedTexts` is called only by `embedQuery` (`src/lib/knowledge/embed.ts:262-270`) and by memory.
   - Both retrieval legs query `"KnowledgeChunk"` (`src/lib/knowledge/lexical-query.ts:110`, `src/lib/knowledge/retrieve.ts:227`), so every project retrieval returns zero passages.
   - The chat turn therefore always takes the fallback (`src/lib/chat/turn/project-context.ts:136-142`). That fallback pastes **the full extracted text of every project file** (up to 200,000 characters per file, `index.ts:137`) into the first user turn on every turn. There is no cap (`src/lib/chat/context-assembly.ts:181-197`).
   - Consequences:
     - Project capacity is limited to the context window of the chosen model.
     - Large projects push the router onto long-context models, which are expensive, or make it throw `NoAutoCandidateError` (`src/lib/router/decide.ts:333,337`).
     - The project legs of Deep Research (`src/lib/research/private-retrieval.ts:117-127`) and of voice return nothing.
     - Every project turn still pays for one query-embedding call and two SQL queries, with nothing to find (`retrieve.ts:484-505`).
   - This is the single biggest quality, capacity and **cost** problem in this area.

2. **Shared projects work through the API only, and only partly.**
   - There are roles (`ProjectMember`, `src/lib/project-collaboration.ts:17`) and a members API (`src/app/api/projects/[id]/members/route.ts`). There is no member UI anywhere: no `/members` caller exists in `src/components` or `src/app`.
   - Shared projects never appear in the collaborator's project list (`src/app/api/projects/route.ts:15-16` reads owner rows only).
   - A collaborator cannot file a chat into the project: `src/lib/chat/turn/accept.ts:118-125`, `src/lib/chat/turn/identity.ts:106-112` and `src/app/api/conversations/[id]/route.ts:70-71` all require `userId: user.id` on the project. Even with a chat filed, the project context would be loaded under the conversation owner's id (`src/lib/projects/project-tree-server.ts:69-89`), so the collaborator gets no instructions or files.
   - A collaborator cannot upload to the project (`src/app/api/upload/route.ts:63-64`) or open its files (`src/app/api/attachments/[id]/document/route.ts:27`).
   - Viewers are sent the titles of the owner's chats in the project (`src/app/api/projects/[id]/route.ts:41-63`, unguarded).
   - The gap matrix row "Shared projects with roles: present" is misleading.

3. **There are no synced sources.** Project files come from upload or drop only (`src/components/projects/project-sources-list.tsx`). Claude syncs Google Drive files and GitHub repositories into projects, and ChatGPT adds Drive files/folders and Slack channels as project sources. Alevr already has the plumbing to build this: the Drive change feed (`src/lib/first-party-connectors/sync.ts:34-41`) and GitHub App installation tokens (`src/lib/github-app.ts:260`).

4. **There are no scheduled tasks inside a project.** `ScheduledTask` has no `projectId` (`prisma/schema.prisma:2604-2630`).

5. **Where Alevr is already ahead, on paper:**
   - Nested project folders that inherit instructions and files (`src/lib/projects/project-tree.ts:240-257`).
   - A project can act as an assistant, with persona, tool and connector allowlists and a preferred model (`src/lib/projects/workspace-config.ts`).
   - Per-file index status (`project-sources-list.tsx:72-90`).
   - Work defaults per project.
   - A retrieval design that keeps page/slide/cell locators (`src/lib/knowledge/chunk.ts`, `describeLocator`).
   - Language-neutral lexical search (`src/lib/knowledge/rank.ts:40`).
   - Untrusted-content envelopes around file text.

   The retrieval design is good, but none of it is switched on. Turning it on is mostly wiring, not invention.

---

## 1. Competitor baseline (late 2026)

**ChatGPT Projects**

- **Files.**
  - Per-project caps reported per plan: Free 5, Go/Plus 25, Pro/Business/Enterprise/Edu 40.
  - Upload limits: 10 files at a time, 512 MB per file.
  - These figures are third-party and partly inconsistent [O-files].
- **Sources.** Supported links can be added as project sources: Google Drive files and folders, and Slack channels. Drive folder sync has reported reliability problems [O-sources].
- **Instructions.** Project instructions exist [O24].
- **Memory.**
  - Project-only memory: chats can reference other conversations in the same project, but nothing outside it.
  - Since Aug 14, 2026, an existing unshared project can switch between default and project-only memory.
  - Shared projects are always project-only [O-rn][O-share].
- **Sharing.**
  - Roles are chat access and edit access. Editors can change instructions, manage files and invite others.
  - Visibility is "Only those invited" or "Anyone with a link".
  - Up to 100 collaborators on workspace plans.
  - Collaborators see the project's files, instructions and conversation history [O-share][O-vis].
- **Other.**
  - Voice in Projects (GPT-Live, Aug 7, 2026) reads recent project chats, sources and instructions [O-rn].
  - ChatGPT Work scheduled tasks (Jul 9, 2026) "keep projects moving" [O-rn].
  - ChatGPT Work is not available in project-only-memory projects [O-rn].

**Claude Projects**

- **Knowledge and RAG.**
  - The knowledge base takes documents, code and other files.
  - On paid plans, RAG turns on automatically when knowledge nears the context limit. It gives up to 10× the capacity, uses a "project knowledge search tool" to pull only relevant parts, and shows a visual RAG indicator in place of the capacity bar. It can switch back when knowledge shrinks [C-rag][C-what].
- **Sharing.** Roles are Can view (see everything and chat) and Can edit (change instructions/knowledge, manage members). Sharing is by email, email list or the whole organization, with a "Shared with me" tab and email notifications (Team/Enterprise) [C-what]. Third-party reports say members' chats stay private [C-priv].
- **Memory.**
  - Each project has its own memory. Chats in a project use that memory plus non-project account memory, never another project's.
  - A "Use account memory" toggle keeps a project fully separate.
  - Past-chat search inside a project is scoped to the project.
  - Memory can be turned off per chat [C6].
- **Sources.**
  - Google Drive: Docs (as Markdown), Sheets (as CSV, all tabs) and Slides (as text) can be added to project knowledge and refresh periodically when the project is opened. Exports are capped at about 10 MB. Private projects only [C-drive].
  - GitHub: pick files and folders in a browser, then "Sync now"; several repositories allowed. Private projects only [C-gh].
- **Redesigned Projects (beta, Sep 17, 2026).** A coordinator chat splits work into parallel cloud threads. Memory is shared across threads, and a Library holds the files you add and the artifacts Claude makes. Existing projects will be migrated, scheduled tasks included [C-redesign][C-what].
- **Retrieval research.** Anthropic's Contextual Retrieval prepends 50-100 tokens of context to each chunk and pairs it with BM25 and reranking. In their tests, top-20 retrieval failures fell by 35% (contextual embeddings alone), 49% (adding BM25) and 67% (adding reranking). The post recommends taking about 150 candidates, reranking them, and passing about 20 to the model [A-cr].

---

## 2. Capability table

Gap key, from Alevr's side:
- **missing**: Alevr does not have it.
- **weaker**: Alevr has it, but it works worse.
- **equal**: on par.
- **ahead**: Alevr is better.
- **broken**: the code exists but does not work in production.

| # | Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|---|
| 1 | Knowledge capacity | 5–40 files/project; 512 MB/file [O-files] | Up to 10× the context window via auto-RAG [C-rag] | Bounded by the model window. Every file's text goes in whole (`context-assembly.ts:181-197`, up to 200k chars each per `index.ts:137`), because retrieval returns nothing (see row 3). Router refuses when it does not fit (`decide.ts:333,337`) | **broken / weaker** |
| 2 | Automatic switch between in-context and retrieval | Not documented | Yes, with an indicator; reversible [C-rag] | Intended: indexed files are dropped from the full dump when passages are found (`project-context.ts:136-142`, `context-assembly.ts:185-188`). Never triggers, because there are never passages | **broken** |
| 3 | Chunking | Not documented | Not documented | Good pure chunker (sentence-safe, overlap, heading breadcrumbs, CJK-aware token estimate) at `chunk.ts:77-82,102-118,232`. **Never called in production** (only in `tests/knowledge-retrieve.test.ts:65`) | **broken** (design ahead) |
| 4 | Embeddings | Not documented | Implied by the search tool [C-rag] | `embedTexts` is policy-aware, falls back across providers and is billed (`embed.ts:180-259`). Never run on chunks. Query side does not pin to the stored model's vector space (`retrieve.ts:311-318` passes no `preferModelId`, although `embed.ts:215-220` supports it). `google:text-embedding-004` is in the catalog (`embed.ts:71`), but the repo's own pricing note says Google no longer lists it (`src/lib/metering/unit-prices.ts:116-118`) | **broken** |
| 5 | Hybrid search | Not documented | "Project knowledge search tool" | Lexical (`ts_rank_cd`, OR-prefix query) plus semantic, merged with RRF (`retrieve.ts:320-415`, `rank.ts:151-176`). Correct design, empty table | **broken** (design equal) |
| 6 | Vector search at scale | n/a | n/a | The "vector leg" cosine-ranks only the **180 most recently created chunks** (`retrieve.ts:209-232`, `ORDER BY c."createdAt" DESC LIMIT`). It is not a nearest-neighbour search. No pgvector. The lexical side computes `to_tsvector` per row with no index (`lexical-query.ts:50-55`) | **weaker** |
| 7 | Reranking | Not documented | Not documented (Anthropic recommends a reranker [A-cr]) | Heuristic only: recency, scope and diversity nudges (`rank.ts:247-297`). No cross-encoder or model rerank | **weaker** |
| 8 | Query understanding (follow-ups) | Not documented | Agentic search tool, so the model writes its own queries | The query is the latest user message, verbatim (`project-context.ts:100-101`). A follow-up like "what about the second one?" retrieves nothing useful | **weaker** |
| 9 | Context budget for retrieved passages | n/a | ~20 chunks recommended [A-cr] | 2,400 tokens, 8 passages (`rank.ts:344-347`), the same for an 8k-window model and a 1M one | **weaker** |
| 10 | Citations to project files | File references in answers (not documented in detail) | Not documented in detail | Plain text "(file · page 4)" that the model is asked to copy (`context-assembly.ts:159-160,268`). No structured sources and no chips. Chips exist only for web and Deep Research private sources (`src/components/chat/source-chip.tsx`, `src/lib/research/private-sources.ts:84`) | **weaker** (could be ahead: block bboxes are already stored, `index.ts:86`) |
| 11 | Model-driven search across the knowledge base | ? | Yes [C-rag] | `read_document` lists, outlines, reads and searches **one file at a time**, using literal string search (`src/lib/agent/document.ts:46-54`). It reaches at most the 60 **oldest** project attachments (`src/lib/agent/attachments.ts:25,52-53`). No semantic search across files | **missing** |
| 12 | File types and OCR | Broad | Broad | Broad extractors (pdf, docx, pptx, xlsx, odt, rtf, text, OCR) in `src/lib/knowledge/extract/*`; parser versioning and supersede (`ingest.ts:45-87`) | **equal / ahead** |
| 13 | Same file in two projects | n/a | n/a | Dedupe is by `(userId, checksum)` and ignores the project (`index.ts:29-35`, reuse at `ingest.ts:192-195`). Project B's copy points at project A's document, so it is invisible to B's retrieval filter (`retrieve.ts:198-203`) and to B's file-status lookup (`projects/[id]/route.ts:70-77`) | **bug** |
| 14 | Project instructions | Yes | Yes | Yes. Uncapped (`projects/route.ts:52`, `[id]/route.ts:202`). Kept in the cached system-prompt section (`project-context.ts:151-154`) | **equal** |
| 15 | Instruction inheritance (folders) | No | No | Root-first merge of ancestors (`project-tree.ts:240-257`) | **ahead** |
| 16 | Project memory isolation | Project-only mode; default mode also available [O-rn] | Own memory per project, plus account memory unless toggled off [C6] | Always isolated when a `projectId` is set (`src/lib/memory.ts:2069`). The project's own summary is built from its facts and chat digests (`src/lib/memory-project-summary.ts`). Can be turned off entirely through workspace `memoryRecall` (`src/lib/chat/turn/memory.ts:32-33`) | **equal** |
| 17 | "Use account memory in this project" toggle | Default vs project-only switch (Aug 2026) | Yes [C6] | Not available: isolation is hard-coded as the default | **missing** (small) |
| 18 | Context from other chats in the project | Project-only memory references the project's chats automatically [O-share] | Chat search scoped to the project [C6] | `search_chats` is scoped to the project (`src/lib/tools/specs/search-chats.ts:86`), but the model must decide to call it. Digests feed the summary. Nothing automatically brings in relevant sibling chats | **weaker** |
| 19 | Moving chats in and out | Yes | Yes | PATCH `projectId` (`conversations/[id]/route.ts:43,70-71`); "Move to project" in the sidebar (`src/components/app/app-sidebar.tsx`) | **equal** (owner only) |
| 20 | Sharing roles | Chat / Edit [O-share] | Can view / Can edit [C-what] | OWNER / EDITOR / VIEWER (`project-collaboration.ts:17-83`) | **equal** (model only) |
| 21 | "Shared with me" discovery | Yes | Yes [C-what] | `GET /api/projects` lists owned projects only (`projects/route.ts:15-16`) | **missing** |
| 22 | Collaborator chats with project context | Yes | Yes | Refused at filing (`accept.ts:118-125`, `identity.ts:106-112`); context loaded owner-scoped (`project-tree-server.ts:69-89`) | **broken** |
| 23 | Collaborator adds files | Editors manage files [O-share] | Can edit [C-what] | Upload requires owner (`upload/route.ts:63-64`); file viewer is owner-scoped (`attachments/[id]/document/route.ts:27`) | **missing** |
| 24 | Chat visibility in shared projects | Shared history visible [O-vis] | Members' chats private (third-party) [C-priv] | Viewers receive every project chat title, the owner's included (`projects/[id]/route.ts:41-63`), but cannot open them | **inconsistent / leak** |
| 25 | Member management UI, invites, notifications | Yes | Yes | API only. Adding someone who has no account fails with "User not found." (`project-collaboration.ts:159-168`); no notification; no UI | **missing** |
| 26 | Google Drive as a project source | Files/folders [O-sources] | Docs/Sheets/Slides, auto-refresh, private projects only [C-drive] | None (Drive attach for chats is being built in parallel). The change feed exists (`first-party-connectors/sync.ts:34-41`) | **missing** |
| 27 | GitHub as a project source | Not documented | File browser + Sync now, private only [C-gh] | None. App tokens (`github-app.ts:260`) and a webhook route (`src/app/api/github/webhook`) exist | **missing** |
| 28 | Slack and URL sources | Slack channels [O-sources] | Connectors | None | **missing** |
| 29 | Scheduled tasks in a project | Via ChatGPT Work [O-rn] | Being migrated into redesigned projects [C-what] | `ScheduledTask` has no `projectId` (`schema.prisma:2604-2630`); results thread is unfiled | **missing** |
| 30 | Agent work threads in a project | ChatGPT Work | Coordinator + parallel threads (beta) [C-redesign] | WorkSessions carry `projectId` and are listed on the Tasks tab (`projects/[id]/page.tsx:310-330`); Work defaults per project | **equal / weaker** (no coordinator) |
| 31 | Deep Research uses project files | Not documented | Works with RAG [C-rag] | Wired to `retrieveProjectKnowledge` (`private-retrieval.ts:117-127`), which is always empty | **broken** |
| 32 | Voice in projects | Yes (Aug 2026) [O-rn] | Not documented | Voice context retrieves by attachment (`src/app/api/voice/context/route.ts:118-127`), also always empty | **broken** |
| 33 | Dashboard: capacity, retrieval mode, index health | Files list | Capacity bar / RAG indicator [C-rag] | Per-file label (`project-sources-list.tsx:72-90`); tabs Overview/Tasks/Code/Sources/Settings (`page.tsx:931-958`); memory rail (`project-overview-rail.tsx:294-366`). No capacity, mode or retry | **weaker** |
| 34 | Project as a custom assistant | GPTs being retired [gap matrix O9] | No | Persona, tool and connector allowlists, preferred model, knowledge-file subset (`workspace-config.ts:49-96`) | **ahead** |
| 35 | Cost per project turn | Not documented | RAG keeps the prompt small | Every turn sends the full text of every file. Prompt caching softens repeat turns, but cache misses, providers without caching and long-context surcharges pay full price | **weaker** |

---

## 3. Ranked improvements

The ranking weighs what users will feel against effort. PRJ-1 is a prerequisite for PRJ-2, PRJ-3, PRJ-4 and for the project legs of Deep Research and voice.

### PRJ-1: Turn on the project knowledge index (chunk, embed, store, backfill)
- **What users get.** Ask about page 37 of the fourth PDF in a project and get an answer that quotes it, labelled "(Report.pdf · page 37)". Project chats stop slowing down and stop failing as files are added. Deep Research and voice in a project read the project's files.
- **Competitor evidence.** Claude turns RAG on automatically, with up to 10× the capacity [C-rag]. ChatGPT supports 40 files of up to 512 MB [O-files].
- **Current code.**
  - Blocks only: `src/lib/knowledge/index.ts:63-91`, `src/lib/knowledge/ingest.ts:238-251`.
  - Unused chunker: `chunk.ts:232`. Unused batch embedder: `embed.ts:180`.
  - Empty reads: `retrieve.ts:213-232`, `lexical-query.ts:98-115`.
  - Dedupe bug: `index.ts:29-35`, `ingest.ts:192-195`.
  - No vector-space pinning on the query: `retrieve.ts:311-318`.
- **Implementation sketch.**
  1. **Store.** Add `replaceChunks(userId, documentId, chunks)` to `KnowledgeStore` (`ingest.ts:122-134`) and to `prismaStore` (`index.ts`): `deleteMany`, then `createMany` in batches of 500.
     - Generate block ids client-side (cuid2/`randomUUID`) in `replaceBlocks`, so the packer can see the block ids without reading the rows back.
  2. **Pipeline.** In `runIngest` after `replaceBlocks`: `packDocumentChunks(blocks)`, then `embedTexts({ texts, userId, policy, preferModelId })`, then `replaceChunks`.
     - `preferModelId` is the dominant `embeddingModel` already in the project, so a project stays in one vector space.
     - On `ok:false`, still write the chunks with empty vectors, so lexical search works, and record why.
     - New `KnowledgeDocument` columns: `embeddingModel String?`, `embeddingState String` (`embedded | lexical_only | pending`) and `embeddingError String?`.
     - Order the state transitions so a document is `ready` only after its chunks are committed.
  3. **Durable job and backfill.** Extend `KnowledgeIndexJob` with an `embedding` stage. Add a sweep, a cron route or the existing import-recovery sweep that `index.ts:301-303` refers to, which:
     - chunks and embeds every `ready|degraded` document that has zero chunks;
     - retries `lexical_only` documents when the policy or provider changes;
     - is throttled per user and billed through `recordSpend`, which `embedTexts` already calls.
  4. **Query pinning.** In `retrieveKnowledge`, resolve the dominant `embeddingModel` in the filter scope (one `GROUP BY`) and pass it as `preferModelId` to `embedQuery`.
  5. **Dedupe across projects.** Scope reuse to `(userId, checksum, projectId)`. When an identical document exists elsewhere, copy its blocks, chunks and vectors into a new document row for this project and attachment (a database copy, with no extraction or embedding cost).
  6. **Skip wasted work.** `retrieveProjectKnowledge` should return `null` when the project has no chunks, so it does not embed the question (`retrieve.ts:484-495` checks documents, not chunks).
  7. **Embedding catalog.** Remove or replace `google:text-embedding-004` (`embed.ts:71`; the repo notes it is no longer listed in `unit-prices.ts:116-118`). Prefer `text-embedding-3-small` with `dimensions: 768` to cut storage roughly in half (12 KB to about 6 KB per row as float8).
- **Acceptance tests.**
  - (a) Unit, with a fake store and fake transport: `runIngest` produces chunks whose `blockIds` are a subset of the written block ids, with dense ordinals; `embeddingState` is `embedded`.
  - (b) DB test:
    - three PDFs in a project leave `KnowledgeChunk` with rows and a non-null `embeddingModel`;
    - a question answered only on page 37 of file 2 retrieves a passage with locator `page 37`;
    - `buildProjectReferenceFiles` then leaves out the indexed files.
  - (c) The same PDF uploaded to projects A and B is retrievable in both, and both file rows show `Indexed`.
  - (d) Policy `local_only`: chunks exist with empty vectors, mode is `lexical`, and `degradedReason` is `denied_by_policy`.
  - (e) Backfill: a document with blocks and no chunks has chunks after one sweep.
  - (f) `productionPrivatePorts().project` returns at least one passage on the fixture (Deep Research).
  - (g) A query embedded with provider X never compares against vectors from provider Y.
- **Size** M (the parts exist). **Impact** H.
- **Risks.**
  - Backfill spend. Small: text-embedding-3-small is $0.02 per million tokens per `unit-prices.ts:122`. Throttle it anyway.
  - Row size of `Float[]` (see PRJ-2 for pgvector).
  - Background-provider policy: an Anthropic-only account with `same_provider` gets lexical only, which must be visible in the UI (PRJ-9).

### PRJ-2: Retrieval quality v3 (real nearest-neighbour search, contextual chunks, rerank, query rewriting, eval)
- **What users get.**
  - Paraphrased questions find the right passage in a 500-file project, not only in the newest file.
  - Follow-up questions ("and for 2025?") work.
  - Answers draw on about 15-20 well-chosen passages instead of 8.
- **Competitor evidence.** Anthropic's Contextual Retrieval: 35%, 49% and 67% fewer top-20 retrieval failures for contextual embeddings, adding BM25, and adding reranking, with about 150 candidates reranked down to about 20 [A-cr]. Claude uses an agentic search tool [C-rag].
- **Current code.**
  - Newest-180 vector leg: `retrieve.ts:209-232`.
  - No full-text index: `lexical-query.ts:50-55`.
  - Heuristic rerank only: `rank.ts:247-297`.
  - Fixed pack size: `rank.ts:344-347`.
  - Raw last message used as the query: `project-context.ts:100-101`.
- **Implementation sketch.**
  1. **Real ANN.** Migration: `CREATE EXTENSION IF NOT EXISTS vector`, column `embeddingVec halfvec(768)` on `KnowledgeChunk`, and an HNSW index (`halfvec_cosine_ops`). The deploy guides already name Neon/Supabase, which ship pgvector (`deploy/VM_SETUP_GUIDE.md:131`).
     - Query: `ORDER BY embeddingVec <=> $q LIMIT 150`, with `userId`/`projectId` predicates and `hnsw.iterative_scan` for filtered recall.
     - Fallback when the extension is absent: a batched scan over every chunk in scope (`Float32Array`, streamed 2,000 rows at a time), never newest-N.
  2. **Full-text index.** `CREATE INDEX ... USING gin (to_tsvector('simple', text))` on `KnowledgeChunk`. The statement already matches it.
  3. **Contextual chunks.** At index time, one cheap utility-model call per document (`runUtilityPrompt`) writes a document synopsis. Each chunk's embedding input becomes `fileName › breadcrumb › synopsis-line + chunk`. Store the extra text as `contextPrefix`, so the stored chunk text stays clean for citations.
     - Cost is bounded: one call per document, cached by checksum.
  4. **Query rewriting.** When the latest message is short or anaphoric (heuristic: under 12 tokens, or it starts with "and", "what about", or uses pronouns), one fast utility call turns the last three turns into a standalone query plus up to two variants. Run the hybrid search for each and merge with RRF.
  5. **Reranking.** Over the top 60-150 fused candidates, use a cross-encoder rerank provider if the background policy allows one (new `rerank.ts`, policy-gated like `embed.ts`), or else a listwise rerank by a cheap LLM. Keep the heuristic nudges as tie-breakers.
  6. **Model-aware packing.** `tokenBudget = clamp(0.08 × modelWindow, 2,400, 24,000)`, `maxPassages` up to 20, and extend each hit with its ±1 neighbouring chunk (by ordinal) before packing. `packContext` already stitches adjacent chunks.
  7. **Evaluation.** A golden set under `bench/` (question → document + page), with recall@5/10/20, MRR and the citation-accuracy metric from PRJ-4. CI runs with deterministic fake embeddings; nightly runs use real ones.
- **Acceptance tests.**
  - In a corpus of 5,000 chunks, a pure paraphrase of a chunk created first (oldest) is in the top 10.
  - "And the second one?" after a question about option lists retrieves the second option's section.
  - recall@20 at least 0.9 on the golden set; no regression versus a baseline snapshot.
  - Without the pgvector extension the fallback still finds the oldest chunk.
  - The rerank provider is never called when the policy denies it.
- **Size** L. **Impact** H.
- **Risks.**
  - pgvector migration on managed Postgres; keep the `Float[]` fallback.
  - Rewrite and rerank latency on the critical path: run them in parallel with the memory and history stages, set a hard timeout of about 800 ms, and fall back to the raw query.

### PRJ-3: Adaptive context: whole files when they fit, retrieval plus a `search_project` tool when they don't
- **What users get.**
  - Small projects keep the best possible quality, because every file is in context.
  - Large projects never fail or slow down.
  - A "Retrieval mode" indicator and a capacity meter replace the guesswork.
  - The model can search the whole knowledge base itself, with several queries in a row.
  - Project chats cost a fraction of what they cost today.
- **Competitor evidence.** Claude switches to RAG near the context limit, shows an indicator, and switches back when knowledge shrinks; it uses a project knowledge search tool [C-rag].
- **Current code.**
  - Uncapped dump: `context-assembly.ts:181-197`.
  - Router estimate includes the dump: `src/lib/router/chat-context.ts:128-137`.
  - Router refusal: `decide.ts:333,337`.
  - `read_document` cap of the 60 oldest attachments: `agent/attachments.ts:25,52-53`.
  - Folder-lineage retrieval cut to 20 files: `retrieve.ts:534`.
- **Implementation sketch.**
  1. Keep `Project.knowledgeTokens` updated: the sum of `KnowledgeChunk.tokens` across the lineage, recomputed on ingest and delete.
  2. **Decision**, in `resolveProjectContext`.
     - If `knowledgeTokens ≤ min(0.35 × window of the selected model, 60k)` and caching is available, send whole files (today's path, which caches well).
     - Otherwise use retrieval mode: packed passages from PRJ-2 plus a new tool, `search_project_knowledge({ query, files?, k })`, in `src/lib/tools/specs/`. It is read-only, parallel-safe, scoped to the conversation's project lineage, and returns enveloped passages with citation ids (PRJ-4).
     - Feed the decision into the router estimate, so a big project no longer forces long-context models.
  3. Retrieve the lineage by `projectId IN (lineage ids)` instead of the 20-attachment slice. `read_document` resolves files by name through `KnowledgeDocument` across the whole project, not the 60 oldest attachments.
  4. Record the mode in the turn's receipt; the turn receipt already counts `documentPassages` (`run-turn.ts:469`).
- **Acceptance tests.**
  - A project with 10 × 40-page PDFs (about 250k tokens) answers on a 128k-window model with no `NoAutoCandidateError`. Prompt input tokens are under 30k on that turn, against about 250k today.
  - A 3-file, 8k-token project still sends whole files, byte-identical to today's prefix, so the cache is preserved.
  - The model calls `search_project_knowledge` twice for a comparison question that spans two files, and cites both.
  - File number 61 in a project is reachable through `read_document`.
- **Size** M. **Impact** H, both on quality and on API cost.
- **Risks.**
  - A threshold that is too low hurts small-project quality. Tune it with the PRJ-2 eval.
  - Tool-call loops: cap at 4 calls per turn.

### PRJ-4: Clickable, verifiable citations to project files (page, slide or cell, highlighted)
- **What users get.** Each claim drawn from a project file carries a numbered chip. Clicking it opens the file at the exact page, slide or sheet range, with the cited text highlighted. Citations that point at nothing are caught before the user sees them.
- **Competitor evidence.** Neither competitor's documentation describes deep links into project files at page level, so this is a chance to pull ahead. Alevr already has the data for it.
- **Current code.**
  - Text-only labels: `context-assembly.ts:159-160,268`.
  - Chips exist for web and research only: `source-chip.tsx`, `private-sources.ts:40-43,84` (a `"project"` kind already exists).
  - Block geometry is stored: `index.ts:86` (`bbox`), with `describeLocator` in `chunk.ts`.
  - Document viewer route: `src/app/api/attachments/[id]/document/route.ts`.
- **Implementation sketch.**
  - Give each packed passage a short id `[P1]…[Pn]` in the prompt (`buildProjectPassages`).
  - Emit `sources[]` with `privateSourceUrl({ kind: "project", id: documentId, locator, blockIds })` on the assistant message, using the same channel research sources use.
  - Map `[Pn]` markers to the existing chip and footer UI (`src/components/aicss/citation-footer.tsx`).
  - The document viewer accepts `?at=page:37&blocks=…`, scrolls to the spot and highlights by `bbox` (PDF) or block id (Office).
  - **Post-hoc check.** After generation, drop any `[Pn]` with no matching passage. Optionally run a cheap entailment check of the cited sentence against the passage on the "strict citations" setting.
- **Acceptance tests.**
  - An answer that uses two passages renders two chips; clicking chip 2 opens `Report.pdf` at page 37 with the block highlighted.
  - A model-invented `[P9]` (when only 5 passages exist) is removed and logged.
  - Citation accuracy on the PRJ-2 golden set is at least 95%.
- **Size** M. **Impact** H (trust).
- **Risks.**
  - Highlight geometry for OCR'd scans: fall back to page-level.
  - Collaborators need viewer access (PRJ-5).

### PRJ-5: Shared projects that work end to end
- **What users get.**
  - Invite a teammate by email as **Can chat** or **Can edit**. They see the project under "Shared with me", chat with the project's instructions, files and knowledge, and, if editors, add files.
  - Their chats are private unless they share them to the project.
  - Each person's memory stays their own.
- **Competitor evidence.**
  - ChatGPT: chat and edit roles, up to 100 collaborators, link or invite visibility, shared history [O-share][O-vis].
  - Claude: Can view and Can edit, "Shared with me" tab, email notifications; members' chats private [C-what][C-priv].
- **Current code.**
  - List: `projects/route.ts:15-16`.
  - Filing: `accept.ts:118-125`, `identity.ts:106-112`, `conversations/[id]/route.ts:70-71`.
  - Context: `project-tree-server.ts:69-89`.
  - Retrieval scoped to the viewer's `userId`: `retrieve.ts:484-494`, `lexical-query.ts:67-68`.
  - Upload: `upload/route.ts:63-64`. Viewer: `attachments/[id]/document/route.ts:27`.
  - Title leak: `projects/[id]/route.ts:41-63`.
  - No-account invite fails: `project-collaboration.ts:159-168`.
  - Memory is already per member: `projects/[id]/memory/route.ts:15-19`.
- **Implementation sketch.**
  1. **Listing.** `GET /api/projects?scope=shared` lists projects joined through `ProjectMember`; add the sidebar section, and native list parity.
  2. **Filing.** Replace the owner-only project lookups with `checkProjectAccess(user.id, projectId, "VIEWER")`.
  3. **Shared context loader.** New `loadSharedProjectContext(viewerId, projectId)`: authorize first, then read the project and its files by `projectId` through `prismaUnguarded`. Include the folder lineage only for the owner, matching the existing folder-privacy rule at `projects/[id]/route.ts:95-105`.
  4. **Knowledge scope.** Introduce `KnowledgeScope { ownerUserId, projectId }`, resolved only after the access check. Retrieval SQL binds the owner's id; it never binds the viewer's. Extend `tests/retrieval-security.test.ts` to show that a viewer of project A cannot reach B's chunks even with a forged `projectId`.
  5. **Uploads.** An EDITOR can upload. The attachment row is owned by the project owner (quota is charged to the owner and capped per project), with `addedByUserId` for attribution.
  6. **Chat visibility.** Add `Conversation.projectVisibility` (`private | project`), default `private`. The project route lists the viewer's own chats plus `project`-visible ones. Members get a read-only view of shared chats, with a fork action to continue one.
  7. **Members UI.**
     - Invite by email, including pending invites for people without an account (a `ProjectInvite` table with token and expiry).
     - Change role, remove, leave.
     - Notifications through the existing `Notification` model (`schema.prisma:823`).
     - Reuse the email and invite flow being built for "share with specific people".
  8. **Role semantics.** VIEWER means "Can chat"; EDITOR can edit instructions, files and sources; only the OWNER can delete or move the project.
- **Acceptance tests.**
  - An invited viewer sees the project under "Shared with me". Their first message in it uses the project instructions (a test instruction "reply in French" is honoured) and can cite an owner's file.
  - A viewer cannot upload (403); an editor can, and the file is indexed and retrievable for both.
  - The owner's private chat titles never appear in the viewer's `GET /api/projects/[id]`.
  - A removed member loses access immediately: 404 on the project, the files and retrieval.
  - Memory facts learned in the viewer's chats never appear for the owner.
- **Size** L. **Impact** H.
- **Risks.**
  - Security: this adds unguarded reads, so every one needs a preceding access check and tests.
  - Quota abuse by editors: cap per project.
  - Storage ownership semantics.

### PRJ-6: Synced project sources: Google Drive files and folders, GitHub repo paths, web URLs (shared projects too)
- **What users get.**
  - Attach a Drive folder or a GitHub repository subfolder to a project once. The project stays current on its own and shows "Synced 4 min ago · Sync now".
  - Old citations still open the version they quoted.
  - Unlike Claude, this works in shared projects.
- **Competitor evidence.**
  - Claude: Drive Docs/Sheets/Slides in project knowledge, refreshed periodically on open; GitHub file browser plus "Sync now"; both limited to private projects [C-drive][C-gh]. Users report not being able to see a sync timestamp [C-drive-reddit].
  - ChatGPT: Drive files/folders and Slack channels as sources; Drive-folder sync failures reported [O-sources].
- **Current code.**
  - Upload only: `project-sources-list.tsx`.
  - Drive change feed: `first-party-connectors/sync.ts:34-41`; Drive client: `src/lib/connectors/google-drive.ts`.
  - GitHub App tokens: `github-app.ts:260`; webhook: `src/app/api/github/webhook`.
  - Versioned re-ingest: `ingest.ts:45-87`.
  - Tombstones: `src/lib/library-removal.ts:64`.
- **Implementation sketch.**
  1. **Data.** New model `ProjectSource { id, projectId, ownerUserId, addedByUserId, kind (drive_file | drive_folder | github_repo | url), externalId, selection Json (paths/globs, branch), cursor Json, status (ok | syncing | error | revoked), lastSyncedAt, lastError }`, plus `Attachment.sourceId` and `externalRevision`.
  2. **Sync worker**, a cron plus webhook-driven job:
     - **Drive.** Native files go through `files.get` for binary files. Docs export as `.docx` or Markdown, Sheets as `.xlsx` so every tab is kept, Slides as `.pptx`, all fed to the existing extractors. A changes feed per source, tracked by `startPageToken`.
     - **GitHub.** Tree API filtered by the selection globs. Re-ingest only blobs whose SHA changed, triggered by push webhooks for the tracked branch.
     - **URL.** Fetch through the existing `src/lib/search/fetch-safe.ts`, with ETag/Last-Modified checks daily.
  3. **Ingest.** Run through `runIngest`. Checksum changes supersede (old versions stay resolvable for citations). Deleted upstream means tombstoned.
  4. **UI.** "Add source" on the Sources tab: Drive and GitHub pickers (reuse the Drive picker being built for chat attach), status chip, "Sync now", error and reconnect states.
  5. **Shared projects.** The sync runs on the credentials of the person who added the source. Members see the content, never the account. If that person leaves or revokes access, the source becomes `revoked` and its content is tombstoned, with a notice to the owner.
- **Acceptance tests.**
  - Editing a Google Doc in a synced folder makes the next answer (within one sync interval, or immediately with "Sync now") quote the new text, and the old citation still opens the old version.
  - A push to `main` touching two files re-ingests exactly those two.
  - Revoking Drive access marks the source `revoked` and removes its passages from retrieval.
  - A shared project's member can retrieve from a source the owner added.
- **Size** L. **Impact** H.
- **Risks.**
  - API quotas: back off, keep per-source rate limits.
  - Large repositories: enforce selection limits plus PRJ-3 retrieval mode.
  - OAuth scopes: Drive read-only is enough.

### PRJ-7: Project memory and cross-chat context ("project brain")
- **What users get.**
  - A new chat in a project knows what was decided in last week's chats in the same project, without being asked, and links to them.
  - An optional "Use my account memory here" switch.
  - An editable project brief at the top of the project page.
- **Competitor evidence.**
  - ChatGPT project-only memory automatically references other conversations in the same project [O-share][O-rn].
  - Claude: project memory plus account memory, a "Use account memory" toggle, and chat search scoped to the project [C6].
- **Current code.**
  - Isolation hard-coded: `memory.ts:2069`.
  - Summary from facts and digests: `memory-project-summary.ts:67-103`.
  - Model-invoked search only: `search-chats.ts:86`.
  - The recall index has no project column: `schema.prisma:1358-1380`.
  - Memory rail: `project-overview-rail.tsx:294-366`.
- **Implementation sketch.**
  - (a) **Sibling-chat recall leg** in `resolveMemory` / `resolveProjectContext`, for project chats only.
    - Pick the top 3 message snippets from other conversations in the same project, through `MessageRecallIndex` joined to `Conversation.projectId`, or using the project's chat digests when the recall index is cold.
    - Only above a relevance threshold, within a 600-token budget, rendered as "From earlier chats in this project" with `/chat/<id>` links.
    - Respect PRJ-5 visibility, so a viewer gets only their own chats and chats shared to the project.
  - (b) **Account-memory switch.** `ProjectWorkspace.config.accountMemory?: boolean`; absent means isolated, today's behaviour. Pass `isolateProjectMemory: !accountMemory`.
  - (c) **Project brief.** Show `ProjectMemorySummary` at the top of the Overview, with edit, "pin decision" and "forget".
  - (d) **Shared notes for editors.** A small shared notes block, separate from personal memory, that editors maintain and every member's chat reads.
- **Acceptance tests.**
  - Chat A decides "we use Postgres 17". New chat B is asked "which DB version did we settle on?" without the model calling `search_chats`; B answers 17 and links chat A.
  - With the toggle off, an account fact ("I live in Lyon") is not used inside the project. With it on, it is.
  - A shared viewer's chat never recalls the owner's private chat.
- **Size** M. **Impact** M-H.
- **Risks.**
  - Prompt bloat: keep a strict budget and threshold.
  - Privacy in shared projects: test-gated.

### PRJ-8: Scheduled tasks and triggers inside a project
- **What users get.**
  - "Every Monday, summarise what changed in this project's sources and update the brief" runs with the project's instructions, files and memory.
  - Results land as chats in the project.
  - Triggers can fire when a synced source changes (PRJ-6).
- **Competitor evidence.**
  - ChatGPT Work scheduled tasks keep projects moving (Jul 9, 2026) [O-rn].
  - Claude's redesigned projects are migrating scheduled tasks into projects [C-what].
- **Current code.**
  - `ScheduledTask` has no `projectId` (`schema.prisma:2604-2630`).
  - WorkSessions carry `projectId` and are already listed (`projects/[id]/page.tsx:310-330`).
  - Connector-event triggers: `src/lib/work/triggers.ts`.
- **Implementation sketch.**
  - Add `projectId String?` (SetNull) to `ScheduledTask`. Create the results conversation filed in the project, so it inherits everything through the normal turn pipeline (`resolveProjectContext`).
  - Add a "Schedules" section to the Tasks tab.
  - New trigger kind `project_source_changed`, fired by the PRJ-6 sync worker.
  - Collaborators: schedules are owned by their creator and run with that person's permissions.
- **Acceptance tests.**
  - A weekly task created from a project runs, its conversation has the right `projectId`, and its answer cites a project file.
  - Deleting the project disables the task and keeps its runs.
  - A source change fires the trigger once (idempotent).
- **Size** M. **Impact** M.
- **Risks.** Spend from unattended runs: reuse the existing per-task budget and spend warnings.

### PRJ-9: Knowledge health and capacity panel
This is the one piece of UI the features above need.
- **What users get.**
  - A Sources header shows "128k tokens · Retrieval mode" (or "Whole files"), how many files are indexed, partly readable or failed, and the semantic-search status: "Keyword-only: your background-provider policy allows no embedding provider".
  - Failed files offer one-click Retry or Read with OCR.
  - A "Test a question" box shows which passages, with locators and scores, a question would retrieve.
- **Competitor evidence.** Claude replaces the capacity bar with a RAG indicator [C-rag]. Neither competitor offers a retrieval preview, so that part is an "ahead" opportunity.
- **Current code.**
  - Per-file labels only, with no actions: `project-sources-list.tsx:72-90`.
  - `LexicalOnlyReason` is computed but never shown: `retrieve.ts:96-103`.
  - Status shape in the project route: `projects/[id]/route.ts:156-172`.
- **Implementation sketch.**
  - `GET /api/projects/[id]/knowledge` returns `{ tokens, mode, counts, embeddingState, degradedReason }`.
  - `POST /api/projects/[id]/knowledge/reindex` re-indexes one file or all.
  - `POST /api/projects/[id]/knowledge/preview` runs `{ query }` through `retrieveKnowledge` in an explain mode that returns ranks per leg.
  - Native parity, as a sheet on macOS and iOS.
- **Acceptance tests.**
  - A failed PDF shows Retry; after Retry it becomes Indexed.
  - With a `local_only` policy the banner names the reason.
  - The preview returns the same top 3 as the chat turn for the same query.
- **Size** S-M. **Impact** M.
- **Risks.** Exposing scores invites over-reading them: show ranks, not raw numbers.

### PRJ-10: Instructions that scale
- **What users get.**
  - A token meter and a warning for very long instructions.
  - Version history with restore.
  - An "effective instructions" preview that shows what a chat in a subfolder actually receives.
  - "Draft instructions from this project's files".
- **Competitor evidence.** Both competitors have plain instruction fields [O24][C-what]. Alevr's folder inheritance is unique, so making it visible is a quality win.
- **Current code.**
  - Uncapped: `projects/route.ts:52`, `[id]/route.ts:202`.
  - Lineage merge: `project-tree.ts:240-257`.
  - Instructions dialog: `project-instructions-dialog.tsx`.
- **Implementation sketch.**
  - `ProjectInstructionRevision { projectId, authorId, text, createdAt }` written on PATCH.
  - Show `estimateTokens` in the dialog.
  - Read the preview from `mergeInheritedProjectContext`.
  - Drafting is one utility-model call over the project synopsis from PRJ-2 step 3.
- **Acceptance tests.**
  - Edit, then restore the previous version, and the chat uses the restored text.
  - A subfolder's preview shows the parent's section first.
- **Size** S. **Impact** L-M.
- **Risks.** None of note.

---

## 4. Cost note (this area and the "make API calls cheaper" goal)

Today every turn in a project chat sends the full extracted text of every project file (§0.1). Rough figures:
- A modest project of 10 reports, each around 25k tokens, is about **250k input tokens per turn**.
- With PRJ-1 and PRJ-3, a large-project turn sends about **8-24k tokens of passages** instead.
- That is a 10-30× cut in project input tokens on cache misses and on providers without prompt caching.
- It also stops the router from being forced onto expensive long-context models (`decide.ts:333`).

The extra costs are small:
- one query embedding (about $0.02 per million tokens, `unit-prices.ts:122`);
- an optional rewrite or rerank call on a cheap utility model, only when needed (PRJ-2).

Small projects keep the whole-file path, whose prefix caches well, so their quality does not change.

---

## 5. Notes on the gap matrix

These rows in `docs/handoff/2026-10-31/parity-gap.md` §F should be downgraded:
- "Projects: instructions + files: present". Correct for small projects. Large projects are broken, because of RAG (rows 1-6 above).
- "Shared projects with roles: present". Should be "partial: API-only, collaborators cannot chat with project context" (rows 21-25).
- "Project-scoped memory: present". Correct, but cross-chat recall within the project is weaker (row 18).

---

## 6. Sources

Some OpenAI pages could not be fetched: `help.openai.com` and `intercom.help` are outside this session's allowed network domains. The OpenAI facts above therefore come from search-engine summaries of the official pages plus secondary reports, and carry lower confidence. To verify them directly, those two hosts need to be allowed in the session's network settings. The Anthropic pages were fetched directly.

- [O24] Projects in ChatGPT: https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- [O-rn] ChatGPT release notes (project memory switch Aug 14 2026; Voice in Projects Aug 7 2026; ChatGPT Work scheduled tasks Jul 9 2026; search summary): https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- [O-share] OpenAI Academy, Projects (shared projects, project-only memory): https://openai.com/academy/projects ; https://academy.openai.com/public/clubs/work-users-ynjqu/resources/projects
- [O-vis] Shared projects coverage (visibility, history shared with collaborators): https://www.searchenginejournal.com/openai-releases-shared-project-feature-to-all-users/559136/ ; https://geekflare.com/news/you-can-now-share-chatgpt-projects-with-your-team
- [O-sources] Project sources (Drive files/folders, Slack channels; folder sync reports): https://help.openai.com/en/articles/10169521 ; https://reddit.sentinel-team.org/posts/1ri5h9k/snapshots/2026-03-04T15%3A12%3A29.220995Z
- [O-files] File limits (third-party, inconsistent): https://elephas.app/resources/chatgpt-projects-limits-files-size-and-how-many-projects ; https://fast.io/resources/chatgpt-projects-file-limit/ ; https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-file-upload-limits-2026
- [C-rag] RAG for Projects: https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects
- [C-what] What are projects (sharing roles, Shared with me, redesign beta, scheduled tasks migration): https://support.claude.com/en/articles/9517075-what-are-projects
- [C6] Chat search and memory (project memory, Use account memory toggle, scoped search, memory off per chat): https://support.claude.com/en/articles/11817273-using-claude-s-chat-search-and-memory-to-build-on-previous-context
- [C-drive] Google Drive connector (project knowledge, refresh, private projects only, export formats): https://claude.com/docs/connectors/google/drive
- [C-drive-reddit] User report of no visible sync timestamp: https://reddit.sentinel-team.org/posts/1sbc2a0/snapshots/2026-04-03T23%3A00%3A15.436463Z
- [C-gh] GitHub integration (file browser, Sync now, private projects only): https://claude.com/docs/connectors/github
- [C-redesign] Projects redesigned (Sep 17 2026): https://claude.com/resources/articles/projects-redesigned
- [C-priv] Third-party: members' chats in shared projects stay private: https://wotai.co/blog/claude-projects
- [A-cr] Anthropic, Introducing Contextual Retrieval (Sep 19 2024): https://www.anthropic.com/news/contextual-retrieval
