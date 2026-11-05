# Memory depth audit: Alevr vs ChatGPT vs Claude

Date: 31 October 2026. Repo `/home/user/juno`, read-only static reading (nothing executed against a running Alevr, no product code changed).
Area: saved memory, automatic learning, chat-history reference, project memory, temporary/incognito, transparency, forgetting, sensitive topics, latency and token cost.
Excluded because they are being built in parallel: per-chat memory off, locked chats (recall exclusion), connectors in voice, the UI/motion redesign.

## 0. Bottom line

Alevr's memory is already stricter than both competitors on **governance**:
- forget that cannot be relearned;
- topic exclusions;
- sensitive gates on the read side as well as the write side;
- agent memory grants;
- per-answer receipts that name each fact, with provenance, "Not relevant", Edit and Undo;
- an offline evaluation suite.

It is **behind** both in these areas:

1. **Past-chat recall is lexical-only and tool-only.** It uses blind-token BM25. A paraphrased question does not find the chat. Results are 240-character single-message excerpts, linked to the chat and not to the message. Nothing is referenced automatically.
2. **Open-world reconciliation.**
   - Contradictions are recognised only for 6 regex "slots", 2 style axes and 2 transitions, all in English.
   - Duplicates are found by exact normalised match or a Jaccard score of 0.75 or more.
   - The extractor is shown the 40 newest facts in scope, not the related ones.
   - Live-model precision has never been measured (`docs/rework/program/MEMORY.md`, "Remaining blockers").
3. **Visible saves.**
   - The post-turn extractor writes facts **silently**.
   - The answering model's inline `<juno:memory>` tags are **discarded on any turn that used web search, chat search, a document or a page**.
   - So "remember X, and find me Y" can save X with no notice at all.
4. **Project chats cannot see the account profile.** They do not know your name, language or answer style. Both competitors let project chats inherit account memory.
5. **Semantic memory only works for some models.** The default `same_provider` policy, together with embedding models from only OpenAI, Google, Mistral, Zhipu and Qwen, means a chat on a Claude, DeepSeek, xAI or Kimi model gets lexical-only memory selection.
6. **Scale and cost.**
   - Only the 400 newest facts are ever candidates.
   - There is one utility LLM extraction call after every answered turn, however trivial the turn.
   - The prose summary is rewritten in full (up to about 11k input tokens) whenever the fact count changes, at most every 5 minutes.
   - That summary is injected in full on every turn, which also bypasses the "no inferred sensitive fact rides along" rule.

The 12 improvements in section 5 are ranked by what users will feel. The top four:
- semantic past-chat recall with message citations and automatic reference;
- one visible in-stream memory writer;
- model-adjudicated reconciliation with a live precision gate;
- project memory that inherits the account profile.

Items 5, 7 and 9 also cut per-turn latency and the API spend on memory, which serves the owner's second goal (cheaper calls at the same quality).

---

## 1. Competitor baseline (late 2026)

### Source limitations
- `help.openai.com`, `knightli.com` and `notebookcheck.net` failed DNS from this session, because they are outside the session's network allow-list. To fetch them directly, `help.openai.com` has to be allowed in the session's network settings.
- **ChatGPT claims therefore come from web-search excerpts of official OpenAI help pages, plus press.** Treat them as lower confidence than the Claude claims.
- `support.claude.com` was fetched directly.

### ChatGPT

- **Two layers.**
  - "Reference saved memories": explicit facts kept until deleted.
  - "Reference chat history": ChatGPT uses past chats automatically. There is no tool call and no separate cap, and it "doesn't retain every detail" [O1][O2].
  - Turning off saved memories also turns off chat-history reference [O3].
- **Automatic memory management**: it keeps "the most relevant details prioritized" and moves less important ones "to the background", to avoid a "memory full" state. This is for Plus and Pro, on the web [O3][P1].
- **Dreaming (from 4 June 2026)**: memory is synthesised in the background from past chats, with a "Memory summary" page. Release notes say it "stays more up to date". On 12 June memories became deletable, with memory off available on the same page [O4][P2][P3].
- **Memory sources**: a book icon under the response lists the past chats, saved memories, custom instructions and files that shaped it. OpenAI says it "may not show every factor or source" [O5].
- **Project-only memory**: a project references only its own chats. One community report says switching an existing project over broke indexing of older chats [O6][P4].
- **Temporary chat**: by default it neither uses nor creates memories. Since 27 August 2026 you can choose at the start to personalise it with memory, plugins and custom instructions, and you can also save it [O4][P5].
- **Sensitive information**: the 2024 launch said ChatGPT would not proactively remember health details unless asked (press). The current FAQ only says sensitive info "may appear in memory if you share it" [O3][P6].
- **Deleting**: deleting a memory does not remove it from past chats. Full deletion means removing every source [O3].

### Claude (fetched)

- **Chat search**: a RAG tool call shown in the transcript. "Results include citations linking to the original chats." It searches all non-project chats, and project chats only within their project. Its control, "Search and reference chats", is separate from memory. Incognito chats are never searched [C1].
- **Memory is "a set of individual, categorized entries"**, updated during conversations. This replaced the 24-hour summary on 10 July 2026. Topics are listed and editable in Settings (25 August), and memory works across chat and cloud Cowork [C1][C2].
- **Sensitive topics**: health, race, ethnicity, religion, politics and gender identity are excluded by default, with an opt-in "Include sensitive topics in memory". **Never saved**: "Government ID numbers, criminal history, financial account numbers, and immigration status" [C1].
- **Per-project memory**: a project uses its own memory and account memory, but not other projects' memory. "Use account memory" can be turned off per project [C1].
- **Per-chat memory off** before the first message [C1]. This is being built in parallel and is not covered here.
- **Pause** keeps memory but stops using and creating it. **Reset** deletes everything [C1].
- **Incognito**: not saved to memory or history, and not searched [C1].
- **Import/export**: experimental, from other assistants [C1][C2].
- **Deleting a chat does not remove memories made from it**; they have to be deleted individually [C1].
- **Monthly recap** (beta, 9 July) [C2].

---

## 2. Capability table

Gap key:
- **missing**: Alevr does not have it.
- **weaker**: Alevr has it, but it is weaker.
- **equal**: on par.
- **ahead**: Alevr does better than both.

| Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|
| Explicit "remember X" | yes, "Memory updated" | yes, applies next convo | Two writers: answering-model `<juno:memory>` tags (`src/lib/chat/system-prompt.ts:413-418`, saved at `src/lib/chat/turn/run-turn.ts:1125-1136`) and the post-turn extractor. **Tags are dropped when the turn carried untrusted content or used `search_chats`, `web_search`, `web_fetch`, `read_document` and others** (`run-turn.ts:110-118`, `:1125`) | **weaker** (silent or lost on tool turns) |
| Automatic learning from chats | Dreaming, background | in-chat topic updates | After-turn extraction (`src/lib/chat/turn/finalize.ts:168-173`), dreamer at idle with Batch API (`src/lib/memory-dreaming.ts:33-82`, `src/lib/batch/dream.ts`), re-reads history when the extractor version changes (`src/lib/memory-extraction.ts:27`, `src/lib/memory.ts:1756`) | equal |
| Extraction precision (no junk) | unknown | unknown | Free-form prompt asking for "durable facts" (`memory-extraction.ts:49-53`). Sees **user messages only**, each cut to 1,200 chars (`memory.ts:1545`, `:1601`). Category, confidence and expiry come from regex (`src/lib/memory-lifecycle.ts:225-262`). Live-model precision **never run** (MEMORY.md "Remaining blockers") | **weaker** (unmeasured) |
| Dedup / contradiction | model-managed, "stays up to date" | model-managed topics | Deterministic: exact normalised dup (`memory-lifecycle.ts:339`), Jaccard 0.75 merge (`:1220`), 6 regex slots (`:359`), 2 style axes, 2 transitions (`:504`). English only. Known miss: `pet-died`. Extractor told only the **40 newest** facts in scope (`memory-extraction.ts:33`, `memory.ts:1637`) | **weaker** open-world, ahead on testability |
| Recency / prioritisation | auto-prioritise, background | n/a | 90-day half-life from last confirmation (`memory-lifecycle.ts:1429`, `:1819-1823`), category weights, "Not relevant" decay (`:1565-1576`), `lastUsedAt`. **But the candidate pool is the 400 newest by `createdAt`** (`memory.ts:2127`) | equal; **weaker at scale** |
| Relevance per turn | unknown | model reads topics | Relevance gate, lexical and semantic rank fusion, SD standouts, 3 ambient facts, 600-token budget, food implies dietary (`memory-lifecycle.ts:1656-1890`). Query is **the latest user message only** (`src/app/api/chat/route.ts:152`) | ahead on single turns, **weaker on follow-ups** |
| Semantic memory for every model | presumably | presumably | Embedding models from openai, google, mistral, zhipu, qwen only (`src/lib/knowledge/embed.ts:69-74`). Default `same_provider` (`src/lib/background-provider-policy.ts:36`, `:146-153`) gives **no vectors on Claude, DeepSeek, xAI and Kimi chats**, so selection is lexical | **weaker** |
| Chat-history reference / search | automatic reference + Sources | RAG tool + citations to chats | `search_chats` tool (`src/lib/tools/specs/search-chats.ts`). Blind-token BM25, no model call (`src/lib/recall/index-core.ts`, `src/lib/recall/service.ts`). 8 hits x 240 chars from one message; link `/chat/<id>` with no message anchor (`search-chats.ts:35`, `:113`). English stopwords and time phrases. No semantic leg (MEMORY.md "deliberately not added"). Never automatic | **weaker** |
| "What was used" | Sources panel (partial) | tool-call citations | Receipt names every **ranked** fact, with source chat, Edit, Forget, Not relevant (`src/components/chat/answer-memory.tsx`, `run-turn.ts:476-490`). **The always-on summary is not itemised**, and past chats are only a tool row, with no source chips | ahead on facts, **weaker** on summary and past chats |
| Memory updated notice | yes | visible in chat | View, Edit and Undo notice (`src/components/chat/memory-updated-notice.tsx`), **only for inline tags**. The extractor's `saveCandidates` gets no `onActivity` (`memory.ts:1693-1712` via `finalize.ts:172`) | **weaker** coverage |
| Project memory | project-only option | project + account, opt-out | Project chats **always isolated**: project facts and project summary only (`memory.ts:2069`, `:2109-2111`; `memory-lifecycle.ts:1636-1648`). Per-user project summaries for shared projects | **weaker** (no inheritance) |
| Temporary / incognito | yes; personalised option (Aug 2026) | incognito | Private chat: no memory read or write, not indexed (`src/lib/chat/turn/private-turn.ts:150`) | equal to Claude, **missing** ChatGPT's personalised mode |
| Sensitive topics | weak (FAQ) | opt-in + never-store list | 6 opt-in topics, read gates, a secret detector (`src/lib/memory-sensitive.ts:126-136`, `:210-213`). **English regex only**; extractor output language not fixed. **No never-store class** for criminal history or government ID; immigration status can be opted in (it sits under ethnicity) | ahead on gates, **weaker** multilingual and never-store |
| Topic exclusion ("nothing about my divorce") | no | no | yes (`src/lib/memory-topics.ts`) | ahead |
| Forgetting correctness | delete; memory stays in chats | Forget / Pause / Reset | Suppression block-list blocks relearning; summary benched until rebuilt (`memory.ts:2096-2107`); reset marks all chats processed. Deleting a chat leaves its facts (`src/app/api/conversations/[id]/route.ts:103-115`) | ahead; chat delete equal |
| Pause semantics | memory off also turns off history | separate chat-search toggle | Memory off does **not** detach `search_chats` (`src/lib/tools/entitlements.ts:259`) and there is no chat-search toggle | **weaker** |
| Import / export | export | experimental both ways | Import from text or JSON (`src/lib/memory-import.ts`, `src/app/api/memory/import/route.ts`), export on the memory page (`src/components/memory/memory-footer.tsx:78`), full chat ZIP import | ahead |
| Memory page / topics | Memory summary, search, sort | Topics list | Facts by topic or sort, natural-language edit with undo ledger (`MemoryEdit`), per-project summaries, recap | ahead |
| Memory across surfaces | chat | chat + Cowork | Voice (`src/lib/voice-memory.ts`), agents with none/profile/full grants (`src/lib/memory-scope.ts`), Code (`memory.ts:2198`) | ahead |
| Latency added per turn | unknown | tool round trip when searching | Memory waits for `resolveHistory` (`route.ts:135-152`). 4 parallel reads, then a 400-row read, then a query embed with a **4 s timeout on the TTFT path** (`memory.ts:1957`), then a vector load (`memory.ts:2012`), then an **awaited** `lastUsedAt` write (`memory.ts:2166-2172`) | **weaker** (unmeasured in prod) |
| Token cost | unknown | unknown | Summary of up to about 1,400 tokens in the cached system tier on every turn (`memory.ts:2458`, `system-prompt.ts:433-446`). Ranked notes average 163 tokens in the uncached tail (MEMORY.md). About 450 tokens of memory-tag instructions (`system-prompt.ts:413-426`). One extraction call per answered turn (`post-processing.ts:35-39`). Full summary rewrite from up to 45,000 chars on change (`memory.ts:2237`, `memory-lifecycle.ts:2019`) | **weaker** |
| Native (macOS/iOS) | full | full | Receipts decoded (`native/.../NativeActivityWire.swift:21`, `NativeRunTimeline.swift:804`). Native memory views lack provenance and clear-project (MEMORY.md). A separate rule-based extractor in Swift (`MemoryExtractionEngine.swift`) | weaker (redesign tracked separately) |

---

## 3. How it works today (short)

1. **Turn start.**
   - `resolveMemory` (`src/lib/chat/turn/memory.ts:16-60`) runs alongside `resolveProjectContext`, but only after `resolveHistory` (`route.ts:135-170`).
   - It calls `getMemoryProfile` (`memory.ts:2047-2190`), which:
     - reads the summary (account or project), the block-list, summary changes and the sensitive switches;
     - loads up to 400 active in-scope facts;
     - embeds the query (only when stored vectors exist in a space the policy allows);
     - runs `selectMemoriesForContext`;
     - stamps `lastUsedAt`.
2. **Prompt placement.**
   - The summary goes in the per-user system tier (`system-prompt.ts:433-446`).
   - Ranked notes go in the volatile tail after the newest user message (`src/lib/chat/turn-context-tail.ts`, `route.ts:271-278`). This is cache-correct and well done.
3. **During generation.** The answering model may emit `<juno:memory>` and `<juno:forget>`. These are honoured only on untainted turns (`run-turn.ts:1125-1150`).
4. **After the answer.**
   - `extractConversationMemory` (`memory.ts:1515-1730`) reads the new user messages and sends one utility prompt per chunk; `saveCandidates` then dedupes, supersedes and expires (`memory.ts:971-1160`).
   - `maybeConsolidate` (`memory.ts:2557`) rewrites the summary when the count or lifecycle changed, at most every 5 minutes.
   - The recall index is updated for up to 200 messages (`finalize.ts:187-194`).
5. **Background.** The dreamer reads older history at idle under a usage budget (`memory-dreaming.ts`), through the Batch API where possible.

---

## 4. Depth findings by dimension

**Extraction precision**
- The prompt (`memory-extraction.ts:49-53`) has no negative examples. It has no "explicit vs inferred" output, no evidence pointer and no expiry date.
- Category and confidence come from keyword rules (`memory-lifecycle.ts:225-232`).
- The extractor sees user messages without the assistant turn they answer. So "yes, the second one" or "that works for me" is either junk or lost.
- Provenance points at the **last message of the chunk** (`memory.ts:1702`), not the message that said the fact.
- The offline bench uses a scripted "reader" that returns the planted facts (`src/lib/memory-bench.ts:11-18`). Its 100% precision measures the rules, not a model. The `--live` run is listed as not done.

**Dedup and contradiction**
- The rules are strong on their enumerated cases (MEMORY.md: 14 of 15 corrections, 0 false contradictions).
- They are blind outside them:
  - "moved to Berlin" does not match the location slot pattern (`lives|based|located|resides in`, `memory-lifecycle.ts:360`);
  - paraphrases ("prefers concise answers" / "likes brief replies") are not duplicates;
  - nothing works in French, Spanish or German.
- The extractor's "Already known" list is the 40 newest facts in scope, so for an account with hundreds of facts it re-extracts older ones in new wording.

**Recency and priority.** The decay model is sound. The 400-newest-by-`createdAt` cap (`memory.ts:2125-2128`) is a correctness problem for heavy or backfilled accounts: dreaming writes old facts with a new `createdAt`, so a typed allergy from two years ago can fall out of the candidate pool entirely.

**Retrieval relevance**
- The single-turn gate is excellent (`memory-lifecycle.ts:1790-1850`).
- Gaps:
  - the query is just the latest message (`route.ts:152`), so follow-ups get only ambient facts;
  - the model has no way to ask for more when facts were dropped for budget;
  - semantic evidence is missing for every non-OpenAI/Google/Mistral/Zhipu/Qwen conversation under the default policy.

**Chat-history reference quality**
- Lexical full-history search works: 6 of 6 planted decisions found, p50 25-29 ms (MEMORY.md).
- But:
  - the planted queries share words with their answers;
  - it is only reachable through a model tool call with "keywords, not questions" (`search-chats.ts:52`);
  - excerpts are one message, without the reply that settled the question;
  - the link lands at the top of the chat;
  - results are not first-class citations.
- Any successful `search_chats` also taints the turn (`turn-stream.ts:730-731`, `run-turn.ts:110-118`), which disables inline memory writes for that turn.

**Transparency.** Fact receipts are best-in-class. Two gaps:
- the summary (up to about 1,400 tokens) shapes answers but is never named in a receipt;
- background-extracted facts never produce a notice.

**Latency.** Pre-generation memory work is serial behind history and includes a network embed of up to 4 s, a vector load (thousands of floats per row) and an awaited bookkeeping write. None of it has been measured on production.

**Token cost**
- Per answered turn: about 1.0-1.3k input tokens plus up to 500 output tokens of extraction. This is an estimate from the code constants: about 240 tokens of instructions, 40 facts at about 15 tokens, plus the new user text.
- Consolidation: up to 45,000 chars of facts (about 11k tokens), plus 40 digests, plus project lines, written out as up to 1,400 tokens. It runs whenever anything changed and 5 minutes have passed, separately for the account and for each active project.
- Every summary rebuild changes the system tier, so the next turn re-writes the conversation's cached prefix.

**Forgetting.** Excellent: suppression, topic exclusion, summary benching, reset that is not undone by backfill. Two holes:
- deleting a chat keeps what was learned from it;
- pausing memory does not stop chat search.

**Sensitive topics.** The gates are applied consistently, on write, on read and on the summariser's input. Three weaknesses:
- English-only patterns (`memory-sensitive.ts:126-136`);
- no never-store class;
- the summary carries opted-in inferred sensitive facts into every turn, because `consolidationMayUse` admits them (`memory-lifecycle.ts:2156-2163`). That contradicts the ambient rule at `memory-lifecycle.ts:1845-1856`, which keeps such facts out "just in case" contexts.

---

## 5. Ranked improvements

Sizes, for one engineer: **S** is 3 days or less, **M** is 1-2 weeks, **L** is 3 weeks or more.

### MEM-1: Past chats that are actually found: semantic recall, exchange excerpts, message citations, automatic reference
- **Impact H. Size M.**
- **What users see**
  - "What did we settle on for the paid tier?" finds the chat that said "Let's make Pro $20/month", even with no shared words.
  - The answer shows **Past chats** source chips like web citations. Each chip opens the exact message, highlighted.
  - On a new chat that clearly continues an old one ("let's pick up the Lisbon itinerary"), Alevr brings in the relevant earlier exchange with no visible tool round trip, and the receipt says which chats it used.
- **Competitor evidence**
  - ChatGPT references chat history automatically and lists past chats under Sources [O1][O5].
  - Claude's chat search is RAG "with citations linking to the original chats" [C1].
- **Current code**
  - `src/lib/recall/index-core.ts` (lexical only, English stopwords and time phrases);
  - `src/lib/recall/service.ts:150-243`;
  - `src/lib/tools/specs/search-chats.ts:34-35`, `:52`, `:113`;
  - `ConversationMemory.digest` already exists, one line per chat (`prisma/schema.prisma`, `ConversationMemory`);
  - message anchors already exist (`src/lib/chat/memory-receipts.ts:96`, `?m=`).
- **Implementation sketch**
  - **Data.** New table `ConversationRecallVector`:
    - fields `id`, `userId`, `conversationId`, `projectId?`, `kind` ("exchange" or "digest"), `messageId?`, `embedding Float[]`, `embeddingModel`, `createdAt` (the message time), `indexedAt`;
    - cascades on Conversation and Message;
    - indexes `(userId, embeddingModel)` and `(conversationId)`.
    - An "exchange" is a user message of 20+ chars plus the first 400 chars of the assistant reply that followed. Use pgvector if available; otherwise an in-process cosine over an LRU of the account's vectors, the same pattern as `MemoryEntry.embedding`.
  - **Indexer.** Extend the finalize recall pass (`finalize.ts:187-194`) and `scripts/recall-index-backfill.ts`:
    - embed new exchanges and updated digests with the MEM-5 local embedder, so there is no API spend and no provider exposure;
    - never index private chats; respect locked chats when that ships.
  - **Search.** `searchRecall` (lexical) runs alongside a vector top-50 → RRF fusion (k=60, as `src/lib/knowledge/rank.ts`) → verify → return **exchange excerpts**:
    - user message, up to 200 chars;
    - assistant head, up to 300 chars;
    - title, date and `href=/chat/<id>?m=<messageId>`.
  - **Citations.** The `search_chats` result carries `citations: [{kind:"chat", conversationId, messageId, title, date}]`. The client renders them with the existing sources pill under a "Past chats" label. Change the description so the model may pass a natural question, not only keywords.
  - **Automatic reference**, in the turn pipeline next to `resolveMemory`:
    - reuse the turn's query vector (MEM-7);
    - if the account has `chatSearchEnabled` (MEM-11) and memory is on, check two triggers:
      - the top exchange stands out (the `semanticStandouts` rule, `memory-lifecycle.ts:1580`);
      - and either the chat is in its first 2 turns or the message has back-reference cues ("last time", "we discussed", "as before", "that plan", in each supported locale);
    - when both hold, put up to 2 exchanges (350 tokens or fewer) in the volatile tail under "## From your past chats (relevant to this message)";
    - emit a `context` activity "Referenced past chats" with the chips. This is cache-safe and needs no extra model call.
- **Acceptance tests**
  - New paraphrase set: 60 planted decisions, each query sharing at most 1 content word with its answer, in `scripts/recall-bench.ts` and in the memory-eval `recall` section.
    - hit@1 of 80% or more, hit@5 of 95% or more;
    - the lexical baseline recorded beside it;
    - the existing 6/6 cases stay 6/6.
  - Every hit has `?m=`. A Playwright test opens a chip and asserts the target message is in view and highlighted.
  - Isolation, by extending `tests/recall-index-db.test.ts`:
    - a project chat sees only that project's chats;
    - private chats are never indexed;
    - account A never sees B.
  - p95 search time of 120 ms or less on the 100k-message bench.
  - Automatic reference fires on 10% or fewer of a 300-prompt generic replay, and on 70% or more of a labelled back-reference set.
- **Risks**
  - Embeddings are derived from chat text (inversion risk). This is the same posture as `MemoryEntry.embedding` today; record it in MEMORY.md.
  - Over-referencing: gate on the standout rule and track the fire rate.
  - Storage of about 384 floats per exchange: use a compact dimension.

### MEM-2: One visible memory writer, in-stream, that never loses "remember this"
- **Impact H. Size M.**
- **What users see**
  - Every fact Alevr learns shows the "Memory updated" notice in the same answer, with View, Edit and Undo, including on turns that searched the web or read a file.
  - "Remember that…" always confirms.
  - No duplicate facts in two wordings from the same turn.
- **Competitor evidence**
  - ChatGPT shows "Memory updated".
  - Claude updates topics visibly during the chat and confirms "remember / forget" [C1].
- **Current code**
  - Inline tags: `src/lib/chat/system-prompt.ts:413-418`; saved only when untainted at `run-turn.ts:1125-1136`; taint list at `run-turn.ts:110-118`.
  - The extractor runs after the answer with no `onActivity` (`finalize.ts:168-173` → `memory.ts:1693-1712`).
  - The notice component is ready (`src/components/chat/memory-updated-notice.tsx`).
- **Implementation sketch**
  - **(a) Run the extractor concurrently with generation.**
    - The new user message is persisted in `acceptTurn`, and the extractor reads only USER messages, which are trusted. This is the argument the code already makes at `run-turn.ts:1124`. So start `extractConversationMemory({ ..., onActivity: sendActivity })` when generation starts.
    - If it finishes first, the activity rides the open stream.
    - If not, wait up to 1.5 s before `done`, then persist the activity onto the assistant message's stored activity so a reload or poll shows it.
  - **(b) Remove the `<juno:memory>` save instruction** from the system prompt. That is about 300 cached tokens on every turn, plus the frontier model's tag output, and it removes the second writer.
  - **(c) Deterministic explicit-intent parser** over the user's own text, in `src/lib/memory-intent.ts` (pure, with a locale table): `remember (that)…`, `don't forget…`, `keep in mind…`, `forget (that)…`, `stop remembering…`.
    - An explicit save is written immediately with `origin:"explicit"` and confidence 0.85, and announced as "Saved because you asked".
    - Forget keeps `<juno:forget>` as the way to name *which* stored statement, but it is honoured only when the user's message matches a forget intent. That closes the injection path without blocking it on tainted turns.
  - **Data.** `MemoryEntry.origin` is a TEXT column: explicit, inferred, manual, import, default inferred. `source` stays for compatibility.
- **Acceptance tests**
  - "Remember I'm vegetarian, and find restaurants in Lisbon" with web search on: the fact is saved and the notice appears in that answer. Today the tag is dropped and the fact is saved silently later.
  - 100% of facts the extractor creates produce a `memory` activity, asserted in a turn test with a fake LLM.
  - A fixture web page saying "remember the user wants X" produces 0 facts.
  - A pinned system-prompt size test shows the tag section is gone.
  - On a 200-turn replay, facts written twice in different wordings within one turn drop to 0.
- **Risks**
  - The answer may finish before the extractor on very short replies (handled by the grace window and late persistence).
  - Losing the frontier model's judgement on subtle facts (offset by MEM-3's structured extraction and live evaluation).

### MEM-3: Model-adjudicated reconciliation and structured extraction, gated by a live precision benchmark
- **Impact H. Size L.**
- **What users see**
  - No junk ("The user is asking about Python decorators").
  - "I moved to Berlin", "je vis à Lyon maintenant" and "my dog passed away" retire the old belief, each with a visible reason and Restore.
  - Paraphrases merge instead of piling up.
  - "Learned in" opens the exact message.
  - "Flying to Lisbon on Friday" expires after Friday, not after 30 days.
- **Competitor evidence**
  - ChatGPT's Dreaming "stays more up to date", with automatic management [O4][O3].
  - Claude's model-maintained, categorised topics [C2].
- **Current code**
  - `memory-extraction.ts:35-80` (bare-string output);
  - `memory.ts:1545`, `:1601` (user-only, 1,200-char cap), `:1621-1640` (40 newest known), `:1702` (chunk-end provenance);
  - `memory-lifecycle.ts:339`, `:359-372`, `:504-525`, `:1220`;
  - `memory-categories.ts:102` (30-day TTL);
  - bench reader stand-in at `memory-bench.ts:11-18`.
- **Implementation sketch**
  - **Output schema**, parsed with zod in `memory-extraction.ts`:
    ```
    {facts:[{text, gloss_en, category, origin:"explicit"|"inferred", evidence:<message index>, expires_on?:ISO date, sensitive?:topic|null, replaces?:["k7"], confirms?:"k3"}], digest}
    ```
    - `gloss_en` is shared with MEM-10.
    - Bump `EXTRACTOR_VERSION` to 3, so the dreamer re-reads.
  - **"Known" list.** Up to 25 facts nearest to the chunk (MEM-5 vectors; lexical fallback), plus the same-slot or same-category facts, plus the 10 newest. Each has a short id `k1..`.
  - **Assistant context.** For each user message, include the preceding assistant message, cut to 300 chars, fenced as "context only, never a source of facts".
  - **Apply in `saveCandidates`.**
    - Deterministic gates run first: suppression, sensitive, secret, scope.
    - The model's `replaces` is accepted only within the same scope, and never over a newer MANUAL fact.
    - Otherwise the existing rule path decides.
    - Model-driven supersessions write the `reason` "Replaced because you said: …" and set `sourceMessageId` to the evidence message.
    - `expires_on` sets `expiresAt`, capped at 365 days.
  - **Live evaluation.**
    - `npm run memory:bench -- --suite --live --model <id>` with two utility models.
    - A new **junk corpus** in `memory-eval-cases.ts`: at least 150 negative turns (task requests, code pastes, hypotheticals, quoting others, role-play, one-off logistics) and at least 100 positives.
- **Acceptance tests**
  - Live suite:
    - precision of 97% or more;
    - stale of 3% or less;
    - 0 false contradictions;
    - `pet-died` passes;
    - **junk rate (facts from negative turns) of 3% or less**;
    - positive recall of 90% or more.
    - Recorded in `tests/fixtures/memory-eval-record.json` under `live`, with a CI gate on the offline part.
  - 20 non-English correction cases (fr/es/de/pt) supersede correctly.
  - 30 paraphrase pairs merge; 30 near-but-different pairs do not.
  - The provenance link opens the stating message for 95% or more of bench facts.
- **Risks**
  - A model could retire true facts. Mitigations:
    - MANUAL protection;
    - same-scope-only replacement;
    - Restore on the memory page;
    - the bench gate;
    - a confidence floor of 0.6 for `replaces`.
  - About 400 more input tokens per call (offset by MEM-9's gating).

### MEM-4: Project chats inherit your profile ("Use account memory")
- **Impact H. Size S.**
- **What users see**
  - In a project, Alevr still knows your name, language and answer style, and still respects your allergy, while project notes stay inside the project.
  - Shared projects default to isolated, with one switch on the project page.
- **Competitor evidence**
  - Claude: a project uses its own memory "alongside account memory", with "Use account memory" as an opt-out [C1].
  - ChatGPT: projects use memory by default, with project-only memory as an option [O6].
- **Current code**
  - `memory.ts:2069` (`isolate` defaults to true whenever `projectId` is set), `:2109-2111`;
  - `memory-lifecycle.ts:1630-1648`;
  - project summary path `memory.ts:2592-2810`.
- **Implementation sketch**
  - `Project.memoryMode` TEXT: "inherit" or "isolated".
    - Migration default: "inherit" for projects with no other members; "isolated" for shared ones (`src/lib/project-collaboration.ts`).
  - In `getMemoryProfile`, inherit mode loads `projectId IN (null, this)`.
    - Account facts are admitted only as ambient (identity and preferences, the existing `AMBIENT_LIMIT`) or with evidence (lexical, semantic standout, or dietary implication).
    - `scopeBoost` (`memory-lifecycle.ts:1823`) keeps project facts first.
    - The system tier gets the project summary plus the MEM-8 core profile.
  - Writes stay project-scoped. Add "Use everywhere" on a project fact (sets `projectId` to null) on the memory page.
  - `PATCH /api/projects/[id]` accepts `memoryMode`. There is a toggle in project settings and a native mirror.
- **Acceptance tests**
  - In inherit mode, "write me a short bio" in a project uses the account name fact.
  - In isolated mode, no account fact is even loaded (extend `tests/memory-scope-db.test.ts`).
  - A shared project defaults to isolated.
  - Member B never reads A's facts in either mode.
  - The eval scope section stays at 0 leaks.
- **Risks**
  - Personal facts surfacing in work a collaborator sees. Mitigated by the isolated default for shared projects and ambient-only inheritance.

### MEM-5: Semantic memory for every model: a local embedder with no API cost
- **Impact H. Size M.**
- **What users see**
  - Memory relevance and past-chat recall work the same whichever model you chat with. Today Claude, DeepSeek, xAI and Kimi chats fall back to word matching.
  - Faster turns.
- **Competitor evidence.** Both competitors run semantic retrieval for every user (inferred from RAG chat search [C1] and Dreaming [O4]).
- **Current code**
  - `src/lib/knowledge/embed.ts:69-80` (remote models only; `isLocal` is supported but nothing is registered);
  - `src/lib/background-provider-policy.ts:146-153` (`same_provider` denies any other provider);
  - `memory.ts:1966-2025` (the query embed returns null, which means lexical);
  - MEMORY.md: lifecycle retrieval is 81.8% without vectors in crowded memory.
- **Implementation sketch**
  - Register `local:multilingual-e5-small` (384 dimensions, multilingual), served by either:
    - an in-process ONNX model (for example `@huggingface/transformers` in Node), with lazy load and a worker thread; or
    - a sidecar text-embeddings service on the deploy VM (`deploy/ecosystem.config.js`), marked `isLocal: true`.
  - Policy: local candidates are permitted under every mode, because content never leaves the deployment.
  - Re-embed through the existing organic backfill (`memory.ts:846-940`) and a one-off script.
  - Remote models remain optional for accounts that choose `any_allowed_provider`.
- **Acceptance tests**
  - A chat on an Anthropic model gets `hasSemantic` true in `selectMemoriesForContext`.
  - Lifecycle retrieval in `memory:bench --suite` with local vectors is 95% or more (against 81.8% lexical).
  - p95 query embed of 30 ms or less on the production instance class.
  - Added RSS of 300 MB or less.
  - In a network-isolated test, no outbound request is made for memory or recall embeddings.
  - The ApiSpend ledger shows 0 spend for memory and recall embedding purposes.
- **Risks**
  - CPU and RAM on the VM (use a worker or sidecar).
  - Quality below `text-embedding-3-large` (measure with the MEM-1 paraphrase set).
  - Mixed vector spaces during migration: already handled, because comparison is only within one `embeddingModel`.

### MEM-6: Retrieval that works at scale and across turns, plus an on-demand `recall_memory` tool
- **Impact M-H. Size M.**
- **What users see**
  - Long-time users stop being "forgotten": an old but important fact still applies.
  - Follow-ups like "and dinner options?" still respect the allergy.
  - When a question needs more than the budget, the assistant looks it up, and the lookup appears in the receipt.
- **Competitor evidence**
  - ChatGPT's auto-prioritisation keeps relevant memories in the foreground [O3].
  - Claude reads memory through tools during the chat [C1].
- **Current code**
  - `memory.ts:2112-2128` (`take: 400`, newest `createdAt`);
  - `route.ts:152` (latest message only);
  - `memory-lifecycle.ts:1426` (600-token budget);
  - `droppedForBudget` is reported but never acted on (`run-turn.ts:480-482`).
- **Implementation sketch**
  - Candidate pool = all active in-scope facts. The rows are light (`LIFECYCLE_SELECT` has no vectors), and they are cached per user (MEM-7).
  - Query = current message, plus the previous user message at half weight, plus the first 300 chars of the last assistant reply at quarter weight. This applies to both the lexical token set and the single embed (one call with segment markers).
  - New read tool `recall_memory(query)` → up to 8 facts with ids, using the same gates as `selectMemoriesForContext`.
    - It is attached when memory is on and the account has more than 150 facts or the turn dropped facts for budget.
    - Its results append to the receipt's `used` list, so transparency holds.
    - It is not a taint source, because it is Alevr's own data.
- **Acceptance tests**
  - In an account with 2,000 facts, a question that needs the oldest MANUAL fact selects it. Today it is not even loaded.
  - The follow-up case selects the dietary fact.
  - `recall_memory` hits show in the receipt.
  - The eval `tokens` section's mean injected tokens stays within 10% of today's.
  - Selection p95 is 10 ms or less over 5,000 facts.
- **Risks**
  - Bigger pools cost CPU (the bench shows 2.8 ms p95 for 2,000 facts).
  - Tool overuse: attach only above the thresholds.

### MEM-7: Take memory off the time-to-first-token path
- **Impact M. Size S.**
- **What users see.** Answers start sooner, and a slow embeddings provider can no longer delay the first token by up to 4 s.
- **Competitor evidence.** None published; this is a pure quality and speed win.
- **Current code**
  - `route.ts:135-152` (memory waits for `resolveHistory`);
  - `memory.ts:1957` (4 s embed timeout);
  - `memory.ts:2012-2020` (vectors loaded per turn);
  - `memory.ts:2166-2172` (awaited `lastUsedAt`).
- **Implementation sketch**
  - Start `resolveMemory` right after `acceptTurn`, alongside `resolveHistory`. It needs only `input.message`, plus the previous turn for MEM-6, which can be read cheaply.
  - Per-process LRU of `{facts, vectors, summary, blockList, sensitiveTopics}` keyed by `userId` plus a `memoryVersion` counter. Bump the counter on any `MemoryEntry` or summary write (`Settings.memoryVersion Int`); one indexed single-row read validates the cache.
  - Embed timeout 700 ms, with a lexical fallback and a counter. Skip the embed when the query has fewer than 2 significant tokens (ambient only).
  - Move the `lastUsedAt` stamp into `after()`.
  - Share the query vector with MEM-1 automatic reference.
- **Acceptance tests**
  - The turn trace's `memory` stage: p50 of 15 ms or less and p95 of 60 ms or less, excluding the embed; p95 of 120 ms or less including the local embed.
  - With a hung embeddings fake, the added time to first token is 0.75 s or less (today up to 4 s).
  - A cache test shows a write invalidates the next read.
- **Risks**
  - A stale cache across processes. The version check prevents it.

### MEM-8: A small "core profile" in place of the always-on prose summary; every fact in context named
- **Impact M. Size M.**
- **What users see**
  - The receipt explains everything memory contributed.
  - Unrelated questions no longer get "since you're in Lisbon…" asides.
  - A **Pin** ("Always use") control on facts, which ChatGPT's automatic prioritisation does not give users.
- **Competitor evidence**
  - ChatGPT's Sources panel "may not show every factor" [O5]. Being exact here is a way to be ahead.
  - Claude moved from a summary to individual entries on 10 July [C2].
- **Current code**
  - `system-prompt.ts:433-446` (summary always in the system tier);
  - `memory.ts:2388-2510` (full rewrite, `maxTokens: 1400`, 45,000-char facts);
  - `memory-lifecycle.ts:2019-2068` (rebuild after any change, 5 minutes apart);
  - `memory-lifecycle.ts:2156-2163` against `:1845-1856` (sensitive inconsistency);
  - `run-turn.ts:476-490` (the receipt lists only ranked facts).
- **Implementation sketch**
  - **Core profile.** Up to 12 facts and up to 200 tokens: name, language, location, role, answer-style facts, plus any `pinned` fact. It never includes an inferred sensitive fact. It is rendered with ids in the per-user system tier, which is stable and cached.
  - Everything else is ranked into the tail, as today. Chat digests become rankable notes ("Earlier: you were planning the Lisbon trip"), each with its conversation link.
  - `MemoryEntry.pinned Boolean @default(false)`, with a Pin action on the memory page and in receipts.
  - The prose summary stays as the memory page overview and voice context. It is rebuilt by the dreamer through the Batch API (`src/lib/batch/dream.ts`), at most daily or when the page is opened, and no longer after chat turns.
  - Gate the switch behind a flag, with an A/B on blind preference.
- **Acceptance tests**
  - Eval `tokens` section: "what is 17 x 23?" receives 200 tokens of memory or fewer (today: the whole summary plus ambient).
  - A new `personalisation` probe: inferred sensitive facts reach off-topic context 0 times, including through the summary path.
  - The receipt names 100% of the facts in context.
  - The consolidation calls on the turn path drop to 0.
  - A 100-prompt blind A/B is at parity or better.
- **Risks**
  - Losing the synthesis in "Top of mind" (kept through digest notes; A/B gate).
  - Users of today's summary view (unchanged on the page).

### MEM-9: Cheaper memory work: signal-gated, batched extraction
- **Impact M. Size S.**
- **What users see.** Nothing changes in quality. Memory's share of usage and spend falls, which leaves more usage headroom for real questions.
- **Competitor evidence.** The owner's requirement (cheaper calls at the same performance). Claude also saves "during chat" only when there is something to save [C1].
- **Current code**
  - `src/lib/chat/post-processing.ts:35-39` (extracts after every answered turn);
  - `finalize.ts:168-185` (extraction plus consolidation on the turn);
  - the dreamer and batch layer already exist (`memory-dreaming.ts:41-46`, `src/lib/batch/dream.ts`).
- **Implementation sketch.** A pure `memorySignal(text, locale)` in `src/lib/memory-intent.ts` returns one of three values:
  - `"now"`: explicit intent (MEM-2), or first-person self-disclosure cues ("I'm", "I am", "my", "I work", "I live", "I prefer", "call me", "we're building", "our team", in locale tables);
  - `"defer"`: anything else with substance;
  - `"skip"`: acknowledgements, under 15 chars, or pure code or paste blocks.
  - Only `"now"` runs the in-stream extractor.
  - `"defer"` leaves the conversation pending; the dreamer distils it at idle through the Batch API.
  - Consolidation leaves the turn path entirely (MEM-8).
  - The ApiSpend ledger already separates purposes (`memory_extraction`, `memory_consolidation`), so savings are measurable.
- **Acceptance tests**
  - On a labelled 1,000-turn replay: synchronous extraction calls fall by 50% or more; the signal's recall on fact-bearing turns is 98% or more (misses are still caught at idle).
  - `memory:bench --live` recall within 1 point of before.
  - Deferred facts land within 30 minutes of inactivity.
  - Ledger spend for memory purposes per 100 turns falls (record before and after).
- **Risks**
  - Late notices for deferred facts. Show "Learned since your last chat" on the memory page and in the next chat's first receipt.

### MEM-10: Safety that holds in every language, plus a never-store class
- **Impact M. Size M.**
- **What users see**
  - A Spanish or French speaker's health or religion details are not stored without opt-in.
  - Criminal history, government ID numbers and immigration status are never learned automatically.
- **Competitor evidence.** Claude's opt-in list and its never-saved list ("Government ID numbers, criminal history, financial account numbers, and immigration status") [C1].
- **Current code**
  - `src/lib/memory-sensitive.ts:126-136` (English regex), `:128` (immigration under ethnicity, which can be opted in), `:210-213` (secret patterns);
  - `memory-extraction.ts:49-53` (no output language);
  - `memory-lifecycle.ts:1531-1541` (English dietary and food lists);
  - `index-core.ts:51-58`, `:150-165` (English stopwords and time phrases).
- **Implementation sketch**
  - The extractor emits `gloss_en` and `sensitive` per fact (MEM-3).
  - Every gate (sensitive, suppression, topic, slots, dedup) runs on the **union** of `content` and `gloss_en`. Store `gloss` in a new nullable `MemoryEntry.gloss` column; display stays in the user's language.
  - A `NEVER_STORE` rule set: convictions, arrests and criminal record; passport, national ID, national insurance and SSN numbers; visa or immigration status. It is refused on every AUTO path; MANUAL writes are allowed after a confirm.
  - Pattern packs for the top UI locales for food and time phrases.
- **Acceptance tests**
  - The eval `sensitive` section gains 60 non-English cases: stored without opt-in = 0.
  - Never-store cases = 0 across extractor, import and native sync.
  - Benign false flags no worse than today's 2 of 10.
  - Recall time phrases work in fr/es/de.
- **Risks**
  - Over-refusal (the existing inclusive-pattern trade-off; measure benign refusals).

### MEM-11: Controls that mean what they say: a chat-search switch, pause stops everything, and deleting a chat can forget it
- **Impact M. Size S.**
- **What users see**
  - **Settings → Memory**: a "Search and reference past chats" switch, plus "Pause memory", which really stops every memory read, including chat search.
  - The delete dialog offers "Also forget the N things Alevr learned in this chat". Neither competitor offers this; both say such memories have to be deleted one by one.
- **Competitor evidence**
  - Claude's separate chat-search toggle; Pause; "Deleting a conversation doesn't remove memories" [C1].
  - In ChatGPT, turning saved memory off also turns off chat-history reference [O3].
- **Current code**
  - `src/lib/tools/entitlements.ts:259` (`search_chats` ignores `memoryEnabled`);
  - `src/app/api/conversations/[id]/route.ts:103-115`;
  - `MemoryEntry.sourceRef` is a plain string.
- **Implementation sketch**
  - `Settings.chatSearchEnabled Boolean @default(true)`. Gate `search_chats` and MEM-1 automatic reference on `memoryEnabled && chatSearchEnabled`.
  - `DELETE /api/conversations/[id]?forgetLearned=1` retires facts with `sourceRef = id` and `source = AUTO` (status `deleted_source`), then calls `refreshSummaries`. Bulk delete gets the same option.
  - The memory page labels orphaned provenance "from a deleted chat".
- **Acceptance tests**
  - Entitlement tests: memory off, or chat search off, means `search_chats` is not attached.
  - Deleting with the option retires the facts, the next turn's receipt cannot show them, and the summary is rebuilt.
  - Deleting without the option changes nothing.
- **Risks**
  - A fact learned in that chat but restated elsewhere. Keep it if `lastVerifiedAt` points to another chat's message.

### MEM-12: Personalised temporary chat (reads memory, writes nothing)
- **Impact M. Size S.**
- **What users see.** When starting a private chat, a "Use my memory" option. Answers are personalised and show the receipt, but nothing from the chat is learned, stamped or indexed.
- **Competitor evidence.** ChatGPT, 27 August 2026: personalise a Temporary Chat with memory, plugins and custom instructions, chosen at the start [O4][P5].
- **Current code.** `src/lib/chat/turn/private-turn.ts:150` (`memoryEnabled: false`); `src/components/chat/private-chat-toggle.tsx:28`.
- **Implementation sketch**
  - `getMemoryProfile(..., { readOnly: true })` skips the `lastUsedAt` stamp.
  - The private turn passes the profile and custom instructions when the per-chat option is set (client state only, never persisted).
  - The memory system section omits write instructions; the extractor and recall indexing never run.
- **Acceptance tests**
  - In a personalised private chat the answer uses the facts and the receipt shows them.
  - A database diff after the chat shows 0 writes to `MemoryEntry` (including `lastUsedAt`), `ConversationMemory` and `MessageRecallIndex`.
  - The default private chat is unchanged.
- **Risks**
  - User confusion about what "private" means. Name the option in plain words and show a read-only badge.

---

## 6. Sequencing and measurement

1. **Foundations.**
   - MEM-5 (local embedder) and MEM-7 (latency and cache), which together carry one query vector per turn.
   - MEM-4 and MEM-11, which are small and independent.
2. **Write path.** MEM-2, then MEM-3, then MEM-9.
   - MEM-3's live bench is the gate for turning off the inline-tag writer for all users.
   - MEM-9 depends on MEM-2's intent parser.
3. **Read path.** MEM-1 (needs MEM-5), MEM-6, MEM-8 (A/B), MEM-10 (rides MEM-3's schema), MEM-12.
4. **Measured in one place.**
   - Extend `npm run memory:bench -- --suite` with: live precision and junk rate, paraphrase recall (hit@1 and hit@5), automatic-reference fire rate, non-English sensitive cases, and memory-stage latency.
   - Record ledger spend per 100 turns for `memory_extraction`, `memory_consolidation` and the embedding purposes, before and after.
   - The MEMORY.md "Remaining blockers" items (live accuracy, signed-in learn → correct → query → forget → reload, production recall latency) become exit criteria for this wave.

---

## 7. Sources

OpenAI. `help.openai.com` could not be fetched, so these come from web-search excerpts:
- [O1] How does Reference saved memories work: https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work
- [O2] How does memory use past conversations: https://help.openai.com/en/articles/10303002-how-does-memory-use-past-conversations
- [O3] Memory FAQ: https://help.openai.com/en/articles/8590148-memory-faq
- [O4] ChatGPT release notes (4 Jun, 12 Jun and 27 Aug 2026 entries): https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- [O5] Memory sources (book icon), described in the Memory FAQ and the past-conversations article above (O2, O3)
- [O6] Projects and project-only memory, community thread: https://community.openai.com/t/switching-an-existing-project-to-project-only-memory-seems-to-break-memory-and-indexing-of-older-chats/1393627

Anthropic (fetched directly):
- [C1] Use Claude's chat search and memory to build on previous context: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- [C2] Claude release notes (2 Mar, 9 Jul, 10 Jul and 25 Aug 2026 entries): https://support.claude.com/en/articles/12138966-release-notes

Press and secondary (lower confidence):
- [P1] ChatGPT can now automatically manage saved memories: https://eastleighvoice.co.ke/chatgpt%20plus/227223/chatgpt-can-now-automatically-manage-saved-memories
- [P2] Gigazine, ChatGPT memory Dreaming (June 2026): https://gigazine.net/gsc_news/en/20260605-chatgpt-memory-dreaming-v3
- [P3] The AI Track, Dreaming: https://theaitrack.com/?p=36878
- [P4] Unite.ai, how to use ChatGPT's project memory: https://www.unite.ai/how-to-use-chatgpts-project-memory/
- [P5] Notebookcheck, temporary chat can now use saved memories (search excerpt only): https://www.notebookcheck.net/ChatGPT-Temporary-chat-can-now-use-your-saved-memories.1382374.0.html
- [P6] What does ChatGPT remember about you? (independent analysis): https://kirangarimella.substack.com/p/what-does-chatgpt-remember-about
- TechRadar on referencing past chats: https://www.techradar.com/ai-platforms-assistants/chatgpt/after-todays-big-memory-upgrade-chatgpt-can-now-remember-conversations-from-a-year-ago-and-link-you-directly-to-them

Alevr internal:
- `docs/rework/program/MEMORY.md` (benchmarks, remaining blockers);
- the gap matrix at `docs/handoff/2026-10-31/parity-gap.md` (section F, rows 134-146).
