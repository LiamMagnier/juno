# Context size: what each request carries, and what it can stop carrying

Dimension: context size. This covers history trimming and compaction, tool results in history, attachment text, images and PDFs, memory and retrieval blocks, artifact and Live UI source, the system prompt, and tool schemas.

Repo state: `e532983ea` (read-only audit, 2026-10-31).

Constraint: the user-chosen model and answer quality stay the same. Savings come only from sending less that the model does not need.

Scripts and raw output (reproducible), all in `docs/handoff/2026-10-31/cost/scripts/`:
- `sysprompt-size.ts` builds the real system prompt with `buildSystemPromptSections`.
- `tool-size.ts` serializes the native tool registry.
- `context_model.py` is the per-turn cost model. Run it with the miss rate `m` as an argument.
- `runner_model.py` simulates Code-session pruning.

---

## 0. What is already right (do not redo)

The October cost work (`docs/pricing/COST_ENGINEERING.md`) already fixed the big structural problems. They were verified in code:

| Area | State | Where |
|---|---|---|
| Tool results across turns | Not verbatim. Each earlier tool-using row carries a note of at most 1,200 chars (≤3 results, `Title — URL`), and the note is a function of that row only. | `src/lib/chat/history-notes.ts:39` |
| History token budget + rolling summary | min(60K, 40% of window), floor 8K, cut in 8-message blocks. A cheap-model summary is recomputed only when the window start moves. | `src/lib/chat/history-compaction.ts:45-63`, `history-summary-store.ts:170-245` |
| Per-question context out of the cached prefix | Ranked memory notes (600-token budget), retrieved passages (2,400 tokens, 8 max) and named references ride a volatile tail after the newest user message. | `turn-context-tail.ts`, `memory-lifecycle.ts:1426`, `knowledge/rank.ts:344-347` |
| Tool instructions only when the tool is attached | Task, routine, image, teach, search, document, image-inspection and code nudges are all gated on the tool actually being on the turn. | `system-prompt.ts:389-410`, `prompt-sections.ts:140-155` |
| Binary attachments age out | Images and PDF bytes are re-embedded only for the last 8–15 messages (block-anchored), then become placeholders. | `anthropic.ts:65,116-119`, `openai-compat.ts:73,92-95`, `openai-responses.ts`, `gemini-core.ts:52` |
| Research worker | Results are capped at 14K chars, and old results are elided in steps of 4 so the prefix holds. | `research/agents/worker-loop.ts:77-131` |
| Code runner | Layered prune, then offload, then summarize. | `runner/agent-core/src/harness/context.ts` |

Remaining waste is concentrated in five places:
1. **What the model wrote earlier**: superseded artifact versions, stale Live UI JSON, semantic JSON bodies.
2. **What the user attached earlier**: full text files, PDFs, high-res images.
3. **One genuine bug** in the project reference-file fallback.
4. **Connector schemas.**
5. **Output-side re-emission** of whole artifacts on every revision.

---

## 1. Measured sizes today

The system prompt was built with the real builder (`sysprompt-size.ts`), using chars/4, which is the estimate the repo's billing code uses.

| Configuration | Stable tier (shared, 1h cache) | Variable tier |
|---|---|---|
| Web, all toggles (canvas, Live UI + DO views, code run + sandbox, task, routine, image, untrusted rule, memory on) | **32,124 chars ≈ 8,031 tok** | 4,040 chars ≈ 1,010 tok (with a 4K-char memory summary) |
| Web, no task/routine/image tool | 27,740 ≈ 6,935 tok | — |
| Native md-only client | 25,421 ≈ 6,355 tok | — |
| Voice | 16,451 ≈ 4,113 tok | — |
| Minimal (no canvas, no Live UI, memory off) | 1,764 ≈ 441 tok | 0 |

Breakdown of the 8,031-token web head:

| Section | Tokens |
|---|---|
| Canvas | 3,055 (≈1,900 of it is the DESIGN, SPREADSHEET, DOCUMENT and PRESENTATION JSON contracts) |
| Live UI | 2,343, plus 500 for the "views people act on" section |
| Tasks | 610 |
| Memory rules | 528 |
| Untrusted-content rule | 360 |
| Reply intent | 314 |
| Images | 258 |
| Routines | 228 |
| Pre-answer clarification | 151 |
| Runnable code | 142 |

Native tool definitions (`tool-size.ts`): 12 tools, 14,892 chars ≈ 3,723 tokens if all are attached. The largest are `run_code` (510), `read_document` (426), `inspect_image` (420) and `start_task` (388).

Connector (MCP) tools are added on top, up to `MAX_CHAT_FUNCTION_TOOLS = 64` (`tools/toolset.ts:34`). Every tool of every sticky connector rides every turn (`turn/context.ts:96-100`). The router's own estimate is 1,200 tokens per connector (`router/chat-context.ts`).

Caps that bound the big context items:

| Item | Cap | Where |
|---|---|---|
| Attachment text stored per file | 200,000 chars ≈ 50K tok | `knowledge/index.ts:137` |
| Attachment text sent per file | min(400K chars, ⅓ of window) | `knowledge/document-text.ts:180-183` |
| Files read per turn | 8 | `knowledge/index.ts:195` |
| Newest user message with files | never trimmed while among the last 12 messages | `history-compaction.ts:53,128-135` |
| Project reference files (non-indexed) | **no total cap** | `context-assembly.ts:181-197` |
| Semantic artifact outlines | 24,000 chars across ≤4 artifacts, in the system tier | `turn/semantic.ts:23-29` |
| `web_fetch` | 16K chars default, 40K max | `tools/specs/web-fetch.ts:36-38` |
| Any tool result | 100K chars | `tools/dispatch.ts:108` |
| Image estimate in the history budget | 1,600 tok | `history-compaction.ts:55` |

The 1,600-token image estimate is wrong for current Claude models. Claude 4.7 and later (Sonnet 5.5, Opus 5.5) use a high-resolution tier: up to 2,576 px on the long edge and **4,784 visual tokens** (Anthropic vision docs).

## 2. A typical turn (cost model, `context_model.py`)

Prices are Claude Sonnet 5.5 (`pricing.ts:205`, confirmed on Anthropic's prompt-caching page):
- $2 input and $10 output per M tokens.
- Cache read 0.05x = $0.10.
- 5m write 1.25x = $2.50.
- 1h write 2x = $4.

`m` is the share of turns that arrive after the 5-minute conversation cache entry has expired. The baseline is m = 0.35; m = 0.15 and m = 0.5 were also run. The October doc assumed about half for long chats.

The expected cost of carrying one prefix token for one turn is EXP = (1−m)·$0.10 + m·$2.50 per M tokens, which is **$0.94/M at m = 0.35**. The cost of context is dominated by re-writes after a cache miss, not by cache reads.

| Profile (share of turns) | Tools | Cached history | Fresh tail | Output | $/turn (m = 0.35) |
|---|---|---|---|---|---|
| Plain chat (55%) | 1.5K | 8K | 0.8K | 0.9K | $0.0222 |
| Build: an artifact being iterated (12%) | 1.5K | 34K, of which ~22K is superseded artifact copies | 0.5K | 6.5K (full re-emission) | $0.1165 |
| Text attachment in window (8%) | 2.5K | 48K (40K attachment) | 0.5K | 1K | $0.0603 |
| PDF on Claude, inside lookback (4%) | 2.5K | 98K (~25 pages × 3.5K text + image) | 0.5K | 1K | $0.1073 |
| Project chat (9%) | 1.5K | 8K | 3.0K (passages + notes) | 0.9K | $0.0266 |
| Tool/search turn (10%) | 3.5K | 10K | 0.8K | 1K | $0.0253 |
| Connector turn (2%) | 15.5K | 10K | 0.8K | 1K | $0.0264 |
| **Weighted** | | | | | **$0.0407/turn** (300 turns ≈ $12.2/month) |

Every profile also carries the 9K system tiers (8K stable + 1K variable), always read from the 1h cache.

A plain turn is about 20.5K input tokens and 0.9K output. Its cost splits as follows:

| Component | Share |
|---|---|
| Output | 41% |
| Conversation-prefix writes (mostly miss re-writes) | 45% |
| Cache reads of system + tools + history | 7% |
| Fresh tail | 7% |

The 8K system head costs about $0.0008 per turn on Sonnet 5.5, roughly 4% of a plain turn. Cutting the system prompt is therefore **not** a lever on Claude (see N2).

Not modeled: research, Code, voice and media spend. They are handled separately below where they touch context size.

---

## 3. Findings, ranked by expected saving × confidence

Saving percentages are of chat-turn spend under the section 2 mix at m = 0.35, unless they say "per site". The m = 0.15 and m = 0.5 figures come from the same script.

### CTX-1. Project reference files are dumped wholesale whenever retrieval finds no passage (bug)

**What happens today.** `resolveProjectContext` only keeps the retrieval result when it has at least one passage:

```ts
// src/lib/chat/turn/project-context.ts:136
if (retrieved && retrieved.passages.length > 0) {
  projectKnowledge = { passages, indexedFileNames: retrieved.indexedFileNames, degraded };
}
// :290
const projectReferenceFiles = buildProjectReferenceFiles(assistantProjectRow, projectKnowledge);
```

`buildProjectReferenceFiles` (`context-assembly.ts:181-197`) excludes only the files listed in `knowledge.indexedFileNames`. When `projectKnowledge` is null, every project file with `extractedText` is sent whole, with no total cap, prepended to the **first user turn** of the window (`project-context.ts:313-316`). Indexing writes up to 200K chars back onto every project file (`knowledge/index.ts:159-191`).

This null case happens on four paths:
- zero passages;
- a retrieval exception (the catch at `:139-145`);
- an empty `knowledgeQuery`, as with an attachment-only message;
- a lexical-only mode with no hit.

Lexical-only is the **default for Claude conversations**: `same_provider` is the default policy (`background-provider-policy.ts:36`), and Anthropic has no embeddings endpoint (`knowledge/embed.ts:23-27`). Short follow-ups such as "make it shorter", "continue" or "thanks", and questions in a different language from the documents, match nothing lexically.

The router even names this path: "the downstream no-match/error wholesale fallback remains an estimate limit" (`router/chat-context.ts`).

Because the dump sits in the first user turn, a dump turn rewrites the whole conversation prefix. The next turn, which has a match again, rewrites it a second time.

**Saving.** Assumptions:
- W = 30K tokens of project text (for example 3 files × 40K chars);
- the dump hits z = 10% of project turns (about 50% of project traffic in lexical mode × 20% zero-match).

Extra cost per dump: W·$2.50 + H·($2.50 − $0.10)·(1−m) + ½·H·$2.40·(1−m) = $0.075 + $0.0125 + $0.006 ≈ **$0.078**. That is +293% on a $0.027 turn.

Averaged over the mix this is **≈1.7% of chat spend** (1.5% to 2.2% across m). It is much larger for heavy project users with big libraries. On a 200K-window model, a 10-file library can push the turn into a context-length error.

**Quality risk: low.** The dump is an accident, not a design: indexed files are meant to arrive as located extracts, and the dump arrives exactly on turns where nothing was relevant. The guard below keeps a pointer to the documents.

**Implementation.**
1. `project-context.ts:136`: keep `indexedFileNames` even when `passages` is empty. Set `projectKnowledge = { passages: [], indexedFileNames, degraded }`.
2. On a retrieval error, read the indexed names with a separate cheap `knowledgeDocument.findMany({select:{fileName}})` instead of falling back to null.
3. In `buildProjectPassages`, render a no-match note in the volatile tail: "Project documents: a.pdf, b.docx … no passage matched this message; ask, or quote what you need." This mirrors the existing attachment no-match note in `context-assembly.ts:321-324`.
4. Add a hard total cap to `buildProjectReferenceFiles`, for example 12K tokens with the existing `attachedFileText` truncation note. It now applies only to genuinely unindexed (pending or failed) files.
5. Update `router/chat-context.ts` and `tests/chat-context-assembly.test.ts:273`.

**Measure.** Add `projectWholesaleChars` and `knowledgeMode` to the turn trace (`chat/turn/trace.ts`). Count project turns with wholesale > 0, and check the `llm.request` `prefix.verdict = history_rewritten@0` rate on project chats before and after.

---

### CTX-2. Every superseded version of a code/HTML/React/SVG/Markdown artifact stays verbatim in history

**What happens today.** The canvas contract says: "To revise an existing artifact, REUSE its identifier and output the complete updated content" (`system-prompt.ts:316`). The full answer text, including `<juno:artifact>…</juno:artifact>`, is persisted as the assistant `Message.content` (`turn/persist.ts:70-96`). History replays it unchanged.

The only rewrite is for held (pending-review) artifacts (`message-content.ts:249-258`). A canvas selection edit does not avoid this either: the model writes a small patch, but the persisted message is replaced with the full new artifact (`buildArtifactEditMessage`, `artifact-edit.ts:190-200`, used at `run-turn.ts:1003-1006`). A site iterated five times therefore carries five full copies. At 4–8K tokens each, that is 20–40K tokens of dead source per turn. Those copies also eat the 60K history budget, which pushes real conversation into the summary earlier.

**Saving.** Assume 22K tokens removed on build turns:
- per site: 22K × $0.94/M = $0.021 per build turn, **18% of a build turn** (10% at m = 0.15, 22% at m = 0.5);
- overall: **≈6.1% of chat spend** (3.8% to 7.3%).

**Quality risk: low.** The model keeps the current version, the latest full copy, verbatim. Earlier versions are what it was told to replace.

The one regression is "go back to the version from before": the model can no longer reproduce the old code byte for byte. The stub tells it the version exists in the canvas version history. Optionally, add a small `read_artifact_version(identifier, version)` tool; `loadOpsTarget` in `turn/semantic.ts` already reads versions.

**Implementation.**
1. Add a pure helper `src/lib/chat/history-artifacts.ts` with `collapseSupersededArtifacts(messages, anchor)`. It uses `ARTIFACT_RE` and `parseArtifacts` (`message-content.ts:46,112`).
2. Replace the body of every artifact version that has a later version of the same identifier, but only in messages whose absolute index is below `anchor = floor(count / HISTORY_STEP) × HISTORY_STEP`. The collapsed set then changes only when the block anchor moves. Above 24 messages that is the same turn `historyWindowStart` moves (`context-assembly.ts:37-44`), which already rewrites the prefix, so the change adds no cache rewrite of its own.
3. Use the stub `<juno:artifact identifier="x" type="HTML" title="…">[version 2 — superseded by a later version below; the full text is in the canvas history]</juno:artifact>`.
4. Call it in `turn/history.ts` next to `describeHeldArtifactsForModel` (line 78), before `compactHistoryWindow`, so the token budget sees the collapsed size.

**Measure.** Count stub characters removed per turn in the trace, and confirm `prefix.verdict = stable` between anchors. For quality, compare the regenerate and thumbs-down rate on build conversations with `scripts/cost-per-accepted.ts`, before and after, behind an env flag in the style of `HISTORY_COMPACTION_ENABLED`.

---

### CTX-3. Revisions re-emit the whole artifact; a patch protocol already exists but is used only for canvas selections

This is output-side. It is included because it is the root of CTX-2, and the same text becomes next turn's context.

**What happens today.**
- A chat-requested change to a 6K-token page is a 6K-token output at $10/M = $0.06, plus that copy in history from then on.
- The search/replace patch protocol (`<juno:artifact-patch>`, `artifact-edit.ts:147-183`, at most 12 edits, `applyArtifactPatch` at `:112`, wired in `run-turn.ts:1004`) runs only for a canvas *selection* edit.
- Even that path pastes `CURRENT SOURCE` into the system prompt (`artifact-edit.ts:179-182`), so the system prompt changes on that turn.
- After a patch is applied, the persisted message is rewritten to the full new artifact (`artifact-edit.ts:190-200`). The next turn's history therefore already holds the current source, and a patch protocol needs no extra context, except when the person has edited the canvas by hand since.

**Saving.** Assumptions:
- 70% of build turns are revisions;
- output drops from 6.5K to 1.5K tokens (patch plus prose);
- the current source is already the latest full copy in history (see above); in about 20% of revisions the person has edited the canvas by hand, and then 6K fresh tokens of current source ride the volatile tail.

Net saving: 5K × $10 − 0.2 × 6K × $2 = **$0.048 per revision turn**. That is 29% of a build turn, and **≈9.8% of chat spend** (8.5% to 12.5%; nearly independent of m because it is output). Latency also falls: a much shorter stream.

**Quality risk: medium.** The risks are a failed patch application (ambiguous anchors) and models that make cosmetic drive-by edits.

Mitigations:
- Apply the patch to the stored current version server-side (as the selection path does). On any `ArtifactPatchError`, retry once in the same turn with "emit the complete artifact".
- Use patches only for artifacts above about 4K chars and not for "rewrite/redo" intents.
- Ship behind a flag, per artifact type.

**Implementation.**
1. Change the canvas rule in `system-prompt.ts:316,508-509`. This is a byte change to the shared head, so ship it once.
2. Extend the artifact parsing in `run-turn.ts` (around `:990-1010`) to accept `<juno:artifact-patch identifier=…>` outside the selection flow.
3. When the stored current version is newer than the latest copy in history (a hand edit), put the current source in the volatile tail (`turn-context-tail.ts`), not the system prompt. Move the selection path's `CURRENT SOURCE` there too, so it no longer flips the system tier.

**Measure.**
- output tokens on revision turns (`llm.request.tokens.output`);
- patch success rate;
- retry rate;
- regenerate and thumbs-down rate on revision turns;
- `system@1` prefix verdicts on selection edits.

---

### CTX-4. Text attachments ride in full for the whole window, not just while they are "active"

**What happens today.** The comment says "Extracted document text (cheap) is always kept" (`anthropic.ts:64`). The other adapters behave the same: `anthropic.ts:186-187`, `openai-compat.ts:168`, `openai-responses.ts:181`, `gemini-core.ts:128`.

That cheap text can be 50K tokens per file (200K stored chars), up to 8 files per turn. It is re-sent on every turn while the message is in the 24–31-message count window. It is protected from budget trimming for 12 messages and counted with a 400K-char cap (`history-summary-store.ts:186`).

PDFs behave differently on Claude: after the 8–15-message lookback they become `[PDF … shared earlier]` (`anthropic.ts:166-167`), because their text is never extracted for Claude (`project-context.ts:249-252`). So the product already accepts "older file → placeholder plus `read_document`" for its most common file type.

**Saving.** Beyond the lookback, send outline + first ~2K tokens + a "read_document for more" note, about 3K tokens instead of 40K. Assume half of attachment-bearing turns are beyond the lookback but still in the window.
- per site: 37K × $0.94/M = $0.035, **58% of such a turn**;
- overall: **≈3.4% of chat spend** (2.1% to 4.1%).

**Quality risk: medium-low.** Within the lookback (the 4–7 turns after upload, where most questions about a file are asked) nothing changes. After it, the model has the outline, the head, and the `read_document` tool. The tool stays attached for any file in the window (`project-context.ts:265-285`), and `ATTACHED_DOCUMENT_NUDGE` already tells the model to read before asserting absence.

The residual risk is a model that answers a late detail question from the outline without calling the tool. Gate the change with an eval: 20 long-document Q&A traces asked 6–10 turns after upload, scored on accuracy and on `read_document` call rate.

**Implementation.**
1. Add an `options.stale` mode to `attachedFileText` (`attachment-context.ts:37-62`). It renders `documentOutline(...)` (`knowledge/document-text.ts:138`), plus the head, plus the existing "continues past what is shown" note.
2. Use it in each adapter's `!embedBinary` branch for text longer than about 24K chars. It is block-anchored for free, because `binaryFrom` already moves in 8-message steps.
3. Mirror the same rule in `estimateMessageTokens`, so the budget sees the smaller size.

**Measure.**
- input tokens on attachment turns, split by inside or outside the lookback;
- `read_document` calls per such turn;
- the accuracy eval;
- acceptance rate per `scripts/cost-per-accepted.ts`.

---

### CTX-5. The history token budget cannot see PDFs and under-counts images by up to 3x

This is an accounting fix that makes the 60K budget real.

**What happens today.** `estimateMessageTokens` (`history-compaction.ts:84-93`) adds `extractedText` for files and 1,600 tokens per image. On Claude:
- A PDF `document` block has no `extractedText` (it is skipped on purpose for Claude), so a 25-page PDF of about 90K tokens counts as **0**.
- An image costs up to **4,784** tokens on the 4.7+ high-resolution tier, not 1,600. A 1179×2556 phone screenshot is about 4.0K (Anthropic vision docs).

The runner's compaction uses the same 1,600 constant (`runner/agent-core/src/compaction.ts:97`). The budget therefore does not trim anything on exactly the turns that are 5x larger than normal.

**Saving.** Small and indirect, **≤0.5%**. On PDF turns the budget would drop old verbatim messages into the summary. Its main value is correctness, and it is a prerequisite for CTX-4 and CTX-6 to be measured.

**Quality risk: low-medium.** On those turns more older messages go to the summary. That is the budget working as designed.

**Implementation.**
- Store a page count on the attachment at read time.
- Estimate a PDF per wire: Claude about 1.5–3K text plus image per page; Gemini 3 560 per page at default media resolution; OpenAI `input_file` text plus image per page.
- Use a per-model image estimate: Claude ≥4.7 at w·h/750 capped at 4,784, others 1,600.
- Mirror both in the runner's `estimateTokens`.

**Measure.** Compare the estimated against the actual `input_tokens` ratio per request on attachment turns (`llm.request`). Aim for 0.8–1.2.

---

### CTX-6. Images are re-sent at native resolution on every turn of the lookback, and OpenAI images default to `detail: "auto"`

**What happens today.**
- Chat uploads are not downscaled anywhere: there is no resize in `uploads.ts`, and only Code's composer compresses (`components/code/v2/use-composer-attachments.ts:50`).
- Claude 5.5 models take up to 2,576 px and 4,784 tokens per image. The same image is re-sent at full size for up to 15 messages (`anthropic.ts:148-161`).
- OpenAI Responses sends `detail: "auto"` (`openai-responses.ts:140`), and Chat Completions sends none (`openai-compat.ts:124`).
- OpenAI's guide is contradictory on whether `auto` equals `original` for gpt-5.5 and later. `original` allows up to 10,000 patches on gpt-5.4, versus 2,500 for `high`. A 12 MP photo at `original` would be about 10K patches; `high` caps it at 2,500 (OpenAI images-vision guide, image-cost calculator; secondary sources conflict).
- Gemini 3 defaults to 1,120 tokens per image and 560 per PDF page.

**Saving.**
- Claude: re-send older images (not the newest message's) at the standard tier, at most 1.15 MP, which is about 1.56K instead of about 4K tokens. That is 1.5 images × 2.44K × $0.94/M ≈ $0.0034 per image turn, **≈0.5% of chat spend**.
- OpenAI: if `auto` is `original` on GPT-6 or 5.5+, an explicit `"high"` cuts a large photo by about 75% on every send. Verify before counting: send the same photo with `auto` and with `high` and read `usage.input_tokens`.

**Quality risk: low-medium.** The image attached this turn keeps full resolution. Re-sends are follow-ups, and `inspect_image` crops from the original bytes for fine detail. The system nudge already says "the copies of images you are shown are downscaled" (`prompt-sections.ts`, `ATTACHED_IMAGE_NUDGE`).

The resolution switch on the turn after upload rewrites only the short suffix after that message, which is cheap.

**Implementation.**
1. Add a derived-image cache in storage, keyed by `storageKey` and tier, built with sharp (already a dependency, `lib/computer/*.ts`).
2. In each adapter's image branch, use the derived bytes when `i < lastUserIndex`.
3. Set `detail: "high"` once the token-count test confirms the difference.
4. For Gemini, send per-part `media_resolution` MEDIUM on re-sent images.

**Measure.** Compare `llm.request` input tokens for image turns before and after. Separately, eval screenshot Q&A asked on the second and third turn after upload.

---

### CTX-7. Semantic artifacts (sheets, docs, decks) are carried twice, and the copy in the system tier churns

**What happens today.**
- The original JSON body stays in history verbatim.
- The current outlines (up to 24K chars ≈ 6K tokens, top 4 artifacts) are appended to the system prompt's second cached tier (`route.ts:301`, `turn/prompt.ts:159`, `turn/semantic.ts:23-45`).
- After the first edit, the history body is stale by definition: the canvas rule says "EDITING one of these later: never re-emit it" (`system-prompt.ts:376`).
- Every ops edit changes the outline. The next turn then rewrites the system tail at the 1h premium (2x) and the whole history behind it at 1.25x.

**Saving.**
- Stubbing the history bodies (about 8K tokens on ~3% of turns) saves **≈0.55%** of chat spend.
- On edit-heavy sessions the churn is the larger cost: per edited turn, 6K × $4 + H × $2.50 ≈ $0.074 at H = 20K. Moving the outline out of the system tier would bring that near $0.014, but it is a placement change; see cross-lane note X1.

**Quality risk: low.** The outline is the addressable current state the ops act on. The stale body can only mislead.

**Implementation.**
- In `turn/history.ts`, replace `<juno:artifact type="SPREADSHEET|DOCUMENT|PRESENTATION">` bodies with a stub ("current outline in 'Editable spreadsheets, documents and decks'") whenever `semanticArtifactSection` lists that identifier.
- Apply it at the block anchor, as in CTX-2.

**Measure.** Characters removed, and the `system@1` verdict frequency on chats with semantic artifacts.

---

### CTX-8. All connector tool schemas ride every turn; use Anthropic tool search with `defer_loading`

**What happens today.** Every tool of every sticky connector is declared on every turn, up to 64 (`turn/context.ts:96-100`, `tools/toolset.ts:150-209`, `anthropic.ts:301-318`). The block is cached at 1h, but:
- it is rewritten at 2x whenever a user returns after more than an hour;
- it is written per conversation on OpenAI, where `prompt_cache_key` is the conversation id (`run-turn.ts:900`).

Anthropic's docs put a typical multi-server setup at about 55K tokens. Tool search "typically reduces this by over 85 percent" and improves selection accuracy past 30–50 tools. Deferred tools are excluded from the prefix, so caching is preserved.

**Saving.** Assume 14K tokens of connector schemas on 2% of turns:
- 0.85 × 14K × ($0.10 + $4/6) ≈ $0.009 per connector turn (one 1h rewrite amortized over a 6-turn session);
- **≈34% of a connector turn, ≈0.45% of chat spend**.

It is much larger for users with GitHub- or Notion-sized servers, and it adds an accuracy gain.

**Quality risk: low-medium.** Tool search adds one search step before the first use of a connector tool, which costs latency.

Mitigations:
- Keep Juno's native tools and the 3–5 most-used connector tools non-deferred.
- Use BM25 (natural-language) search.
- Add a system line naming the connected apps.

**Implementation.**
- In `anthropic.ts:301-318`, when connector tools number more than 10 or exceed 10K tokens, add `{type:"tool_search_tool_bm25_20251119", name:"tool_search_tool_bm25"}` and `defer_loading: true` on the connector tools.
- Move `cache_control` to the last non-deferred tool: a deferred tool cannot carry it, and the API returns a 400.
- Teach the run record and broker the `server_tool_use` and `tool_search_tool_result` blocks.
- OpenAI: `tool_search` reportedly exists for gpt-5.4+, but only a secondary source says so; verify in OpenAI docs before building.

**Measure.**
- tools tokens per request (count_tokens);
- wrong-tool and failed-call rates;
- rounds per connector turn;
- first-token latency.

---

### CTX-9. Old Live UI views stay as raw JSON in history

**What happens today.** Assistant replies keep their ```` ```live-ui ```` fences verbatim. The section's own examples run 1–3K chars each (`system-prompt.ts:154-188`). A teaching or practice chat with a view per reply carries about 4K tokens of stale layout JSON.

**Saving.** Assume 4K tokens on about 8% of turns: **≈0.7% of chat spend**.

**Quality risk: low-medium.** "Change the slider max on the earlier calculator" needs the JSON. Mitigations:
- Keep the newest 2 views verbatim.
- Stub only views older than the block anchor (as in CTX-2).
- Have the stub keep the title, component types, quiz questions and answers, and exercise prompts. Exercise grading needs those.

**Implementation.** A Live UI stub helper next to CTX-2's, using the existing Live UI parser (`docs/design/LIVE_UI.md`, renderer types).

**Measure.** Characters removed, plus a spot eval on "modify the earlier view" prompts.

---

### CTX-10. Claude native web search runs the basic tool version

**What happens today.** `web_search_20250305` with `max_uses: 5` (`anthropic.ts:317`) is used when the turn's search plan is native rather than Alevr Search (`turn/capabilities.ts:50-51`). Every result's content is loaded into context. The results are counted as input in later iterations of the same turn.

**Saving.** Unquantified: it depends on the native-search share. Anthropic says dynamic filtering (`web_search_20260209` and `web_search_20260318`, Claude 4.6+) "reduces token use on search-heavy requests".

**Quality risk: low** for quality, but there is a **policy flag**: dynamic filtering is *not* ZDR- or HIPAA-eligible. Gate it on the account's data-handling settings.

**Implementation.** Change the tool version and `allowed_callers` default; handle the code-execution blocks in the stream parser.

**Measure.** Input tokens per native-search turn, before and after.

---

### CTX-11. Realtime fallback dialects have no truncation policy

**What happens today.** The default voice path is GPT-Live (per-minute, so audio context does not apply). Gemini Live already sets `contextWindowCompression: { slidingWindow: {} }` (`relay/src/providers/gemini-live.ts:314`).

The OpenAI Realtime fallback (`gpt-realtime-2.1`), xAI and Qwen session configs set no truncation (`relay/src/providers/registry.ts:26-38,58-66,90-99`). Every response therefore re-bills the whole audio conversation.

OpenAI's realtime cost guide recommends `retention_ratio` < 1 with `token_limits.post_instructions`, for example 0.8 and 8,000, to cap long sessions and keep the cached prefix useful.

**Saving.** Small, because it applies only on the fallback paths. It grows linearly with call length.

**Quality risk: low-medium.** The model remembers less of very long calls.

**Implementation.** Add `truncation: { type: "retention_ratio", retention_ratio: 0.8, token_limits: { post_instructions: 8000 } }` to the OpenAI dialect `sessionUpdate`. Verify the GA field names, and check whether xAI and Qwen accept the field.

**Measure.** Per-response input audio tokens versus call minute in the relay spend reports.

---

## 4. Checked and not recommended

| ID | Idea | Why not (arithmetic) |
|---|---|---|
| N1 | Lower the Code runner's compaction trigger. It is 80% of the window, so 800K tokens on Claude 1M models (`runner/agent-core/src/harness/context.ts:38-41`). | Simulated (`runner_model.py`) on Opus 5.5 ($4/$20, reads 0.05x, writes 1.25x) for a 150-step session with 3 cache misses. A prune trigger of 160K saves only **10%** ($17.61 → $15.80). It **costs 12% more** at 40 steps and about 1% more at 80 steps: each prune rewrites the suffix at 1.25x, which only pays back after about 25 × suffix/removed steps at 0.05x reads. Price tiers are already handled: GPT-6 defaults to the 272K tier (trigger 199K), Grok to 200K (trigger 127K) (`code-v2/context-tiers.ts:76-120`). Leave it. Revisit only for models with read ratios ≥0.1x. |
| N2 | Shorten the system prompt, or move the Canvas JSON contracts and Live UI examples behind a tool. | The head is 8,031 tokens but shared and 1h-cached: about $0.0008 per turn on Sonnet 5.5. Removing about 3K tokens saves about $0.0003 per turn on Claude and about $0.0075 per *new conversation* on GPT-6.1 Sol. The risk is medium, because format adherence for DESIGN, SPREADSHEET, DOCUMENT, PRESENTATION and Live UI depends on those examples. The OpenAI per-conversation write is better fixed by the cache key (X2). The tool-gated sections are already conditional. |
| N3 | Elide earlier tool results inside one chat tool loop. | There are at most 7 rounds, and the cache marker moves every round (`anthropic-cache.ts:48-70`), so earlier rounds are re-read at 0.05x. Eliding mid-turn rewrites the suffix at 1.25x: the same negative return on investment as N1. The research worker already elides in steps, where loops are long. |
| N4 | Lower `HISTORY_TOKEN_TARGET` below 60K. | It directly trades away verbatim recall, which is the quality the brief forbids touching. CTX-2, CTX-4, CTX-7 and CTX-9 remove *dead* tokens from the same budget instead. |
| N5 | Shrink memory notes or retrieved passages. | They are already bounded: 600 and 2,400 tokens, in the fresh tail. Together they are about 3K fresh tokens, roughly $0.006 per turn on project turns, and they are the useful context. |

## 5. Cross-lane notes (caching), seen while tracing context assembly

These are not counted above.

- **X1. One-turn text still lands in the system prompt.** Each item below changes the system tail, or even the shared head, for one turn. That forces a history rewrite on that turn, and on the next turn too if the earlier entry has expired:
  - `imageHint` and `backgroundHint` (`turn/prompt.ts:152-188`);
  - the per-turn search, document and image nudges (`prompt-sections.ts`, `composeSystemPrompt`);
  - the regenerate instruction (`turn/prompt.ts:39-42`);
  - the semantic outlines (CTX-7);
  - the selection-edit `CURRENT SOURCE` (CTX-3);
  - `UNTRUSTED_CONTENT_RULE` inserted *right after the identity line* whenever untrusted content is in the turn (`system-prompt.ts:277`).

  Moving one-turn hints into the volatile tail would stop it.
- **X2. OpenAI's `prompt_cache_key` is the conversation id** (`run-turn.ts:900`), so the shared 8K head is written once per conversation (8K × 1.25 × $2/M ≈ $0.02 on GPT-6.1 Sol).
- **X3. The miss rate `m` multiplies every context saving here.** EXP = $0.065 + $1.25·m per M at Sonnet 5.5 rates. If the caching lane adopts a 1h conversation TTL or keep-warm and m falls to about 0.15, CTX-2, CTX-4, CTX-6, CTX-7 and CTX-9 shrink by about 40–50%. They stay positive. Don't add the two lanes' savings together without re-running `context_model.py` at the new m.

## 6. Totals and rollout order

Overall at m = 0.35: **≈23% of chat-turn spend** (22.3% at m = 0.15, 23.8% at m = 0.5).

| Group | Items | Share of chat spend |
|---|---|---|
| Low risk | CTX-1, CTX-2, CTX-6 (Claude), CTX-7, CTX-8, CTX-9 | ≈10% |
| Medium risk, gated by evals | CTX-3 (output), CTX-4 | ≈13% |

Rollout order:
1. **CTX-1** (bug, low risk) and **CTX-5** (accounting; needed to measure the rest).
2. **CTX-2** and **CTX-7** (same helper and anchor).
3. **CTX-6**, after the OpenAI `detail` token test.
4. **CTX-8**.
5. **CTX-4** and **CTX-3**, behind flags with the evals above.
6. **CTX-9**, **CTX-10** and **CTX-11** as small follow-ups.

**Instrumentation first.** Add per-segment sizes to the `llm.request` record (`src/lib/llm/request-meter.ts`):
- system stable and variable chars;
- tools chars, split native and connector;
- history chars, split into artifacts (current and superseded), attachment text (inside and beyond the lookback), PDF pages, image count and pixels, and Live UI JSON;
- tail chars;
- project-wholesale chars.

Without these, none of the shares in section 2 can be replaced by production numbers. With them, a one-week sample replaces every assumption in `context_model.py`: the profile weights, W, z, the 22K, the 37K and m.

## Sources

- Anthropic prompt caching (multipliers incl. 0.05x reads for Opus/Sonnet 5.5, 4 breakpoints, 20-block lookback, invalidation table): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic vision (high-resolution tier 2,576 px / 4,784 tokens on Claude 4.7+; advice to downsample): https://platform.claude.com/docs/en/build-with-claude/vision
- Anthropic PDF support (1,500–3,000 text tokens per page plus image cost per page): https://platform.claude.com/docs/en/build-with-claude/pdf-support
- Anthropic context editing (`clear_tool_uses_20250919`, `clear_at_least`, cache interaction; `compact_20260112`): https://platform.claude.com/docs/en/build-with-claude/context-editing
- Anthropic tool search (`defer_loading`, ~55K tokens of definitions reduced by over 85%, cache preserved, no `cache_control` on deferred tools): https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Anthropic web search (dynamic filtering in `web_search_20260209`/`20260318`; not ZDR/HIPAA eligible): https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- OpenAI image inputs, from search results only (`developers.openai.com` does not resolve from this session):
  - images-vision guide (detail low/high/original/auto, patch limits): https://developers.openai.com/api/docs/guides/images-vision
  - image-cost calculator: https://developers.openai.com/api/docs/guides/image-cost-calculator.md
  - patch-billing multiplier (unverified community figure): https://multimodalcalc.pages.dev/blog/openai-image-token-calculation-explained
- OpenAI tool_search on gpt-5.4+ (secondary source, unverified): https://docs.apiyi.com/api-capabilities/openai/native
- OpenAI Realtime cost guide and notes (`retention_ratio`, `token_limits.post_instructions`): https://developers.openai.com/docs/guides/realtime-costs and https://developers.openai.com/blog/realtime-api
- Gemini media resolution (Gemini 3 default 1,120 tokens per image and 560 per PDF page), from search results only (`ai.google.dev` does not resolve from this session): https://ai.google.dev/gemini-api/docs/media-resolution
