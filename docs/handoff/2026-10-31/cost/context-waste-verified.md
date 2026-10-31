# Context-waste findings: verification

**Reviewer:** principal engineer, model quality. **Dimension:** context-waste. **Repo:** `/home/user/juno` at `e532983ea`, read-only.
**Input:** `scratchpad/cost/context-waste-findings.md` (CTX-1 to CTX-11, N1 to N5, X1 to X3).

**Rules I applied:**
- The user-chosen model, and what it is shown that it needs, stay the same.
- No added latency on an interactive turn.
- No new exposure across users.
- An item that changes a user-visible output ships behind an eval, or it is rejected.

**Scripts I wrote** (all in `scratchpad/cost/verify-ctx/`, run with `python3`):

| Script | What it does |
|---|---|
| `collapse_sim.py` | Simulates CTX-2 session by session, using the repo's real window rules. These are `historyWindowStart` (limit 24, step 8), `planTokenTrim` (60K budget, step 8, minVerbatim 8) and the summary block. It assumes all-or-nothing reuse of the message prefix and uses Sonnet 5.5 rates. It compares three collapse rules. Output: `collapse_sim.txt`. |
| `kept_calc.py` | Rolls up the kept items over the findings' own turn mix, at m = 0.15, 0.35 and 0.5. Output: `kept_calc.txt`. |

---

## 0. Verdict summary

| # | Item | Verdict | Saving (share of chat-turn spend, m = 0.35, findings' mix) | Ships |
|---|---|---|---|---|
| K0 | Segment-size instrumentation (findings §6) | **KEPT** (enabler) | 0 direct | First |
| K1 | CTX-2: collapse superseded artifact versions, **with a corrected anchor rule**, semantic artifacts included (absorbs CTX-7's history part) | **KEPT (amended)** | **1.5 / 4.7 / 7.9 %** (short / median / long build sessions). Per build turn $0.005–0.027. Findings said 6.1% | Behind a flag, after the revert eval |
| K2 | CTX-3: patch revisions in ordinary turns, **the model's choice, not forced** | **KEPT (eval-gated)** | **3.8 / 5.7 / 8.6 %** at a 40 / 60 / 90 % patch-adoption rate. $0.046 per patched revision on Sonnet 5.5, about $0.09 on Opus 5.5. Findings said 9.8% | Flag per artifact type, after the patch eval |
| K3 | CTX-5: correct the image/PDF token estimate, **for measurement only** | **KEPT (narrowed)** | 0 direct | With K0 |
| K4 | CTX-8: Anthropic tool search for connector schemas, **only for large connector sets** | **KEPT (narrowed)** | ≈0.2% overall; about 30% of a heavy-connector turn | Low priority, after a connector-selection eval |
| R1 | CTX-1: project reference-file fallback | **REJECTED**: the premise is wrong, and the fix as written would remove every project document from every project turn | — | Residue goes to retrieval lane RS-5 |
| R2 | CTX-4: stale text attachments become outline + head | **REJECTED** (quality and latency) | — | — |
| R3 | CTX-6: downscale re-sent images; OpenAI `detail:"high"` | **REJECTED** (cuts the resolution the chosen model sees) | — | — |
| R4 | CTX-7: stub the *latest* semantic body | **REJECTED**; the superseded bodies are covered by K1, and the outline churn by cache lane F10 | — | — |
| R5 | CTX-9: stub old Live UI JSON | **REJECTED** (no recovery path; saving about 0.7%, and assumed) | — | — |
| R6 | CTX-10: Claude web search dynamic filtering | **REJECTED for now** (it would land on voice and private turns) | — | — |
| R7 | CTX-11: realtime truncation | **MERGED into voice lane V9**. Its `token_limits.post_instructions: 8000` part is **REJECTED** | — | — |
| N1–N5 | "Not recommended" list | **AGREE** | — | — |
| X1–X3 | Caching notes | **Belong to cache lane** F1, F4, F5, F7 and F10. X3 is confirmed by my simulation: K1 stays positive at m = 0.15 | — | — |

**Roll-up of the kept items** (`kept_calc.txt`):

| m | Low | Central | High |
|---|---|---|---|
| 0.15 | 5.9% | 11.3% | 18.2% |
| 0.35 | 5.5% | **10.6%** | 16.7% |
| 0.5 | 5.3% | 10.3% | 15.9% |

The findings claimed **≈23%**. The difference has three causes:
- **Rejected items.** CTX-1, CTX-4, CTX-6, CTX-9 and CTX-10, and the CTX-7 body stub: about 6.9 points.
- **Corrected anchor rule for CTX-2.** Versions above the anchor stay verbatim.
- **CTX-3 counted only where the model chooses a patch.**

**Caveat.** Every overall share rests on the findings' unmeasured mix: 12% build turns, of which 70% are revisions. Only the per-site numbers are firm. K0 replaces the mix with production numbers.

---

## 1. What I confirmed and what I corrected

### Confirmed in code (file:line at `e532983ea`)

**Artifacts in history (CTX-2 and CTX-3)**
- **The canvas rule says "output the complete updated content".** `src/lib/chat/system-prompt.ts:316,508-509`. The findings dropped the `chat/` segment of this path.
- **History replays the persisted reply verbatim.** The only rewrite is `describeHeldArtifactsForModel`, at `src/lib/chat/turn/history.ts:73-75` and `src/lib/message-content.ts:249`.
- **A selection patch is persisted as the full artifact.** `buildArtifactEditMessage` (`src/lib/artifact-edit.ts:190`, used at `run-turn.ts:1008`).
- **Patch deltas are not streamed** on edit turns: `forwardDeltas: !artifactEditTarget` (`run-turn.ts:948`).
- **New: every successful ops edit of a semantic artifact persists a full JSON copy.** `resolveArtifactOps` rewrites each successful block into `artifactTagFor(done)` with the whole new body (`src/lib/artifact-ops.ts:110-115,183-200`). A workbook edited 5 times therefore carries 6 full JSON bodies. CTX-7 said only "the original body" stays, so it under-counted. K1 covers these copies.
- **Held and refused versions are not real versions.**
  - Held re-emits are persisted as empty tags. `parseArtifacts` skips empty bodies (`message-content.ts:118`).
  - Refused artifacts are replaced by a plain notice with no tag (`rewriteArtifactMarkup`, `message-content.ts:159`).
  - So every closed, non-empty `<juno:artifact>` in a persisted reply is a real version. That makes K1's supersession test safe.
- **Hand edits and restores do not touch the transcript** (`src/app/api/artifacts/[id]/route.ts` writes versions only). The model is not told about them today. This staleness already exists, and K1 does not make it worse.

**Attachments and images (CTX-4, CTX-5 and CTX-6)**
- **Binary lookback.** `binaryFrom = floor((n−8)/8)·8` (`src/lib/anthropic.ts:116-119`).
- **Extracted text is kept for the whole window** (`anthropic.ts:186-187`).
- **Older Claude PDFs with no extracted text become a placeholder** (`anthropic.ts:166-167`).
- **The history estimate is off for images and PDFs.**
  - `estimateMessageTokens` counts 1,600 per image and only `extractedText` for files (`src/lib/chat/history-compaction.ts:55,84-93`).
  - The runner uses the same 1,600 (`runner/agent-core/src/compaction.ts:97`). Provider-reported usage is preferred there when known.
- **No chat upload is downscaled.** `src/lib/uploads.ts` has no resize. `sharp@0.35.5` is a dependency.
- **The nudge is inaccurate on Claude 4.7 and later.** `ATTACHED_IMAGE_NUDGE` says "the copies of images you are shown are downscaled" (`src/lib/chat/prompt-sections.ts:41`). On those models images up to 2,576 px are sent natively.
- **OpenAI image detail settings.** Responses sends `detail: "auto"` (`openai-responses.ts:140`). Chat Completions sends none.

**Connector tools (CTX-8)**
- **Sticky connectors ride every turn.** All connectors of the conversation are loaded (`src/lib/chat/turn/context.ts:96-100`), up to 64 tools (`src/lib/tools/toolset.ts:34`).
- **Every connector tool is declared, with `cache_control` on the last one** (`src/lib/anthropic.ts:301-312`).

**Native web search (CTX-10)**
- **The live adapter uses the basic search tool.** `streamAnthropic` sends `web_search_20250305` with `max_uses: 5` (`anthropic.ts:317`).
- **New: the 2026 tool versions are wired only in dead code.**
  - `anthropicWebSearchTool` in `src/lib/llm/anthropic-loop.ts:274-289` already picks `web_search_20260318`. That is what the capability record says for Opus 5.5 and Sonnet 5.5 (`src/lib/model-tools.ts:163-166`).
  - It also sets `allowed_callers: ["direct"]` under ZDR.
  - But `anthropic-loop.ts` is **not imported anywhere** (only mentioned in a comment in `anthropic-cache.ts`).
- **When native search runs.** Only on voice turns, private turns, or when Alevr Search is unavailable or the operator prefers native (`planTurnSearch`, `src/lib/search/alevr/policy.ts:57-64`; `turn/capabilities.ts:40-50`).

### Corrected

1. **CTX-1's premise is wrong.**
   - `KnowledgeChunk` is never written: no `create`, `createMany` or raw `INSERT` anywhere in `src/`, `runner/`, `relay/` or `scripts/`. `packDocumentChunks` has no caller. This is also retrieval lane §1.2.
   - So `retrieveProjectKnowledge` returns `{passages: [], indexedFileNames: [...]}` on **every** project turn with ready documents. `projectKnowledge` stays null (`project-context.ts:136`), and `buildProjectReferenceFiles` sends every file whole on **every** project turn.
   - The dump is therefore **cache-stable**: it sits in the first user turn of the window and changes only when the window moves. It does not flip on 10% of turns, and the "+293% dump turn" arithmetic does not apply.
   - The fix as written (keep `indexedFileNames` when passages are empty) would turn every project turn into "no passage matched". There would be no read path either: `read_document` is attached only when a *message* in the window carries a FILE (`project-context.ts:274`). Project files are not message attachments, even though the tool could read them (`src/lib/agent/attachments.ts:42`).
   - Its lexical zero-match analysis is also off. Retrieval ORs prefix terms (`term:*`, `knowledge/rank.ts:82-95`) and has no score floor (`rerankPassages`). Once chunks exist, a zero-match needs every non-stopword term to miss the corpus, so it happens mainly on acknowledgements.
2. **CTX-2's anchor rule does not do what it claims.** It says "the collapsed set changes only when the block anchor moves". But it collapses any version below the anchor that has a later version *anywhere*, so a new version **above** the anchor collapses an older one below it on the next turn. That is a prefix rewrite that is not aligned with any window move. The corrected rule decides supersession **only among messages below the anchor**: both versions must be below it. The two rules compare as follows (`collapse_sim.txt`, m = 0.35):

   | Rule | Change in message-prefix input |
   |---|---|
   | Findings' rule | −21% to −48% |
   | Corrected rule | −21% to −46% |

   The corrected rule is cheaper at m = 0.15 and cheaper on long sessions. It keeps the newest 1–8 messages' versions verbatim, which protects "undo that". It is also byte-stable between anchors by construction.

   Below 24 messages the anchor moves at counts 8 and 16 while the window does not, so those two moves add rewrites. The simulation includes them and the result stays positive: −11% at m = 0.15 for a 6-turn session.

   Placement: the findings said "next to line 78" and also "before `compactHistoryWindow`". Line 78 is *after* compaction. It must run on the decrypted window **before** `compactHistoryWindow` (`history.ts:59-66`), so the 60K budget sees the collapsed size.
3. **CTX-5's image formula is outdated.**
   - The current Anthropic formula is `⌈w/28⌉·⌈h/28⌉` visual tokens.
   - High-resolution tier (Claude 4.7 and later): 2,576 px and 4,784 tokens.
   - Standard tier: 1,568 px and 1,568 tokens, not "w·h/750" or 1,600.
   - Example: a 1179×2556 screenshot is 43×92 = **3,956** tokens on the high-resolution tier and about 1,456 on standard.
4. **CTX-6: OpenAI is no longer ambiguous.**
   - OpenAI's guide says `auto` = `original` on gpt-5.5 and GPT-5.6: up to 10,000 patches or 6,000 px.
   - `high` is 2,500 patches or 2,048 px.
   - GPT-5.6 "uses the original patch count without resizing".
   - So `high` is a real resolution cut for the chosen model, not a free fix. The source is a search snippet, because `developers.openai.com` does not resolve from this session.
5. **CTX-10: the version upgrade is partly built** (dead code, see above).
6. **CTX-11 duplicates voice lane V9.** `token_limits.post_instructions` is an absolute cap on post-instruction tokens, so 8,000 would make a long call forget well before the model's window fills.

### Provider rules and prices (official documentation, read 2026-10-31)

**Anthropic prompt caching**
- Multipliers: 5m write 1.25x, 1h write 2x, read 0.1x, with **0.05x for Opus 5.5 and Sonnet 5.5** and 0.025x for Fable/Mythos 5.1.
- Sonnet 5.5: $2 input, $2.50 5m write, $4 1h write, $0.10 read, $10 output. Opus 5.5: $4 / $5 / $8 / $0.20 / $20.
- At most 4 breakpoints. Lookback of 20 positions.
- Invalidation order is tools → system → messages, and an image change invalidates messages.
- Minimum cacheable length is 512 tokens on 5.5 models.
- Caches are isolated per organization, and per workspace on the Claude API.
- These match `src/lib/pricing.ts:197-205,809-814`.

**Anthropic vision:** the high-resolution tier and patch formula above. The docs recommend downsampling when the extra fidelity is not needed.

**Anthropic PDF support:** 1,500–3,000 text tokens per page, plus the image cost per page. At most 600 pages (100 below a 1M context window).

**Anthropic tool search**
- Versions: `tool_search_tool_bm25_20251119` and the `regex` variant, on all 5.x models.
- Deferred tools are excluded from the prefix, so caching is preserved.
- `cache_control` on a deferred tool returns a 400.
- At least one tool must be non-deferred. The docs recommend keeping the 3–5 most-used tools loaded.
- "Typically reduces [~55K tokens] by over 85 percent". Selection "degrades once you exceed 30–50 available tools".
- Not metered separately. ZDR-eligible, **not HIPAA-eligible**.

**Anthropic web search**
- Dynamic filtering is in `web_search_20260209` and later, and code execution is free when used this way.
- **Dynamic filtering is not ZDR- or HIPAA-eligible.**
- $10 per 1,000 searches. Results count as input tokens.

**OpenAI** (search snippets only; `developers.openai.com` does not resolve here)
- Images: detail levels as in correction 4.
- Realtime `truncation`: `retention_ratio` 0–1, plus an optional `token_limits.post_instructions` cap.

---

## 2. Kept items

### K0. Per-segment size instrumentation (enabler, first)

Every share in the findings, and in this file, is a scenario until these numbers exist. No content is logged, only sizes, and the request body is already read for hashes, so there is no new privacy surface.

**Files**
- `src/lib/llm/prefix-diagnostic.ts`: `snapshotPrefix` adds byte or char sizes next to the hashes:
  - tools, split into native and connector, by name prefix;
  - each system tier;
  - messages;
  - the volatile tail.
- `src/lib/llm/request-meter.ts`: carry these sizes in the `llm.request` record (`prefix.sizes`).
- `src/lib/chat/turn/trace.ts`: turn-level counters:
  - `artifactChars`, split into current and superseded, plus `artifactCharsCollapsed` once K1 ships;
  - attachment text inside and beyond the binary lookback;
  - PDF pages, image count and pixels;
  - Live UI chars;
  - `projectWholesaleChars`, which is the number RS-5 needs.
- Feed all of this into metering lane M3's `ProviderRequestDaily` rollup. Do not build a separate table.

**Tests:** extend `tests/prefix-diagnostic.test.ts`:
- the sizes sum to the serialized prefix size;
- the volatile tail is excluded;
- no field carries text.

**Measure:** a one-week sample replaces the findings' profile weights: build share, revision share, artifact size and m.

### K1. Collapse superseded artifact versions in the model's history (CTX-2, amended)

**Rule**
- `anchor = floor(totalShown / HISTORY_STEP) · HISTORY_STEP`, from the same `totalMessages` that `resolveHistory` already counts (`history.ts:49`).
- A version in message *i* is collapsed only when *i* < anchor **and** a later closed, non-empty version with the same `identifier` exists at index *j*, where *i* < *j* < anchor.
- The rule covers all types, including SPREADSHEET, DOCUMENT and PRESENTATION.
- It applies to the conversation's own messages only: not cross-conversation entries, and not the regenerated answer.
- Artifacts whose identifier was derived from a hash (no `identifier` attribute) never collapse.

**Stub**

```
<juno:artifact identifier="x" type="HTML" title="…">[earlier version, superseded by a later version below; read it with read_artifact_version]</juno:artifact>
```

**Why the quality holds**
- The model still has, verbatim:
  - the newest version;
  - every version in the last 1–8 messages;
  - the latest version below the anchor.
- What it loses are copies it was told to replace.
- The 60K budget now holds more *real* conversation, so fewer messages drop into the summary. That is a recall gain, plus fewer summarizer calls.

**Required parity guard (the findings had it as optional).** Add a small `read_artifact_version(identifier, version | "list")` tool.
- It is attached only when the window contains a stub. That changes the tools block once per conversation, and only at an anchor move that already rewrites the prefix from the collapsed message.
- Without it, "go back to the version before the redesign" can no longer be reproduced byte for byte. Today the model can re-emit it from history.

**Files**
- New `src/lib/chat/history-artifacts.ts`, holding the pure `collapseSupersededArtifacts(messages, { anchor, absoluteOffset })`. Reuse `ARTIFACT_RE`/`parseAttrs` (export them from `src/lib/message-content.ts:46,69`). Skip incomplete (unclosed) blocks.
- `src/lib/chat/turn/history.ts`: apply it to `countWindow` after decryption and **before** `compactHistoryWindow` (lines 59-71, the call starts at :64), with `absoluteOffset = countStart`.
- New `src/lib/tools/specs/read-artifact-version.ts`. Register it in `src/lib/chat/tool-policy.ts`. The read is `prisma.artifactVersion` by `(artifactId, version)` scoped to `userId` and `conversationId`; `loadOpsTarget` in `src/lib/chat/turn/semantic.ts:48` reads only the latest.
- Add a flag `HISTORY_ARTIFACT_COLLAPSE` in the style of `HISTORY_COMPACTION_ENABLED` (`history-summary-store.ts:34-36`).

**Tests** (new `tests/history-artifacts.test.ts`, plus an extension of `tests/history-compaction.test.ts`):
1. Collapses only versions superseded below the anchor.
2. Keeps the latest version below the anchor, and everything above it, verbatim.
3. Held empty tags (`suggestion=`) and refusal notices never count as a later version.
4. An unclosed trailing block never supersedes.
5. Hash-id artifacts never collapse.
6. In a message with several artifacts, each collapses on its own.
7. Semantic ops rewrites (`artifactTagFor`) collapse like re-emits.
8. **Prefix stability.** For totals *t* and *t+1* in the same anchor block, the collapsed output for indexes below the anchor is byte-identical. Pin it with `comparePrefix` from `prefix-diagnostic.ts`, ideally as part of metering lane M5's prefix-stability suite.
9. `planTokenTrim` sees the collapsed size.

**Eval (blocks the flag):** about 30 build conversations with a version below the anchor collapsed, and these requests:
- "undo that";
- "go back to the version before X";
- "bring back the header from the first version";
- an ordinary next revision.

Score how faithful the restore is (diff against the stored version) and the quality of the revision. Run once with `read_artifact_version` and once without, and require parity with the uncollapsed baseline.

**Measure**
- `artifactCharsCollapsed` per turn.
- `llm.request` input, cache-read and cache-write tokens on turns with artifacts.
- `prefix.verdict = stable` between anchors.
- Regenerate and thumbs-down rate on build conversations (`scripts/cost-per-accepted.ts`), flag on against flag off.

**Saving**
- Per build turn: $0.005 (6-turn session) to $0.027 (24-turn session), median $0.016, at m = 0.35 on Sonnet 5.5.
- Of the message-prefix input: −21% to −46%; at m = 0.15: −10% to −43%.
- Overall: ≈1.5–7.9% of chat spend, if build turns are 12% of all turns.

### K2. Patch revisions in ordinary turns (CTX-3, eval-gated)

**Scope**
- Code, HTML, React, SVG and Mermaid artifacts, when the stored current version is over about 4K chars.
- Only for an identifier the conversation already has.
- **The model chooses.** The canvas rule changes from "output the complete updated content" to "for a targeted change to an existing artifact, emit `<juno:artifact-patch identifier=…>` with search/replace edits; for a rewrite or a broad change, emit the complete artifact".
- Nothing is forced, so broad rewrites keep today's path. The existing guards already reject a patch that is too broad (`applyArtifactPatch`: more than 60% of the source covered, or too much added).

**Base and fallback**
- The patch applies to the **stored current version**, as the selection path does.
- When the stored version is newer than the latest copy in history (the person edited it by hand), the current source rides the volatile tail, not the system prompt. This also preserves hand edits that today's full re-emission sends to the re-emit guard as a held suggestion.
- On any `ArtifactPatchError`, retry once in the same turn with "emit the complete artifact".
- The persisted message stays `buildArtifactEditMessage(...)`, the full new artifact, so history and K1 are unchanged.

**Quality and latency**
- **Faster.** About 5K fewer output tokens, which is about a minute less streaming at typical speeds.
- **Byte-exact outside the edit.** No drive-by regressions in untouched code.
- **Risks:**
  - Failures add a patch attempt before the full emission.
  - Users no longer watch the source stream into the canvas.

**Acceptance gates**
- Patch-apply success ≥ 95%.
- Regenerate and thumbs-down on revision turns no worse than control.
- Median time-to-done on revision turns lower.

**Files**
- `src/lib/chat/system-prompt.ts:316,508-509`. This is a byte change to the shared stable head: ship it once, and not together with another head change.
- `src/lib/artifact-edit.ts`: a `parseArtifactPatch` variant that takes an `identifier` attribute and allows prose around the tag.
- `src/lib/chat/turn/run-turn.ts:985-1030`: a third branch for ordinary turns, beside the existing ops branch, plus the same-turn fallback.
- `src/lib/chat/turn-context-tail.ts`: current source when the stored version is newer than history.
- Hide the in-progress patch tag while streaming. Model it on `ARTIFACT_OPS_TAIL_RE` (`message-content.ts:67`), in both:
  - web: `src/lib/message-content.ts`;
  - native: `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeMessageContent.swift`.
- Move the selection path's `CURRENT SOURCE` out of the system tier at the same time (cache lane F1).

**Tests**
- Extend `tests/artifact-edit.test.ts`:
  - prose + patch, parsed and applied to the stored version;
  - ambiguous or too-broad patch leads to the fallback;
  - the persisted text equals the full artifact;
  - the patch applies over a hand-edited version and is not held.
- Add the native parser tests next to `SemanticArtifactTests.swift`.

**Eval:** about 40 revision prompts across artifact sizes. Score:
- patch success;
- diff fidelity (only the requested change);
- judge preference against full re-emission;
- choice rate (patch against full) on "rewrite" prompts. It should be about 0.

**Measure**
- `llm.request.tokens.output` on revision turns.
- Patch success, fallback rate and choice rate.
- Regenerate and thumbs-down rate.
- Time-to-done.

**Saving:** $0.046 per patched revision on Sonnet 5.5 (5K output saved, minus 20% hand-edit tail and 10% failure waste); about $0.09 on Opus 5.5. That is ≈3.8–8.6% overall at 40–90% adoption, nearly independent of m.

### K3. Correct the image and PDF token estimate, for measurement only (CTX-5, narrowed)

**Change**
- Add `estimateAttachmentTokens(model, attachment)`:
  - Claude 4.7 and later: `⌈w/28⌉·⌈h/28⌉`, capped at 4,784 and 2,576 px.
  - Other Claude models: capped at 1,568 tokens and 1,568 px.
  - PDFs on wires that receive bytes: page count × (2.25K text + per-page image estimate).
- Store `pageCount` and image dimensions at read time.

**Where it is used**
- K0's trace and the request records.
- Optionally, the router's fit check. That is a reliability fix: it prevents picking a window that then rejects the request.

**What it does not change:** `planTokenTrim`'s behaviour. Using the real counts there would trim more verbatim history on image and PDF turns. That is the same trade N4 rejects, and it would need its own eval.

**Files**
- `src/lib/chat/history-compaction.ts` (new export; `estimateMessageTokens` left as is).
- `src/lib/chat/turn/trace.ts`.
- `runner/agent-core/src/compaction.ts:97`: same estimator, used only where no provider usage exists yet.

**Tests**
- Formula cases from the vision docs' table: 1000×1000 = 1,296; 1920×1080 = 2,691 on high-resolution; 3840×2160 = 4,784.
- The existing `tests/history-compaction.test.ts` passes unchanged.

**Measure:** the ratio of estimate to actual `input_tokens` on attachment turns should be within 0.8–1.2.

### K4. Tool search for large connector sets (CTX-8, narrowed)

**Gate**
- Anthropic models in the tool-search compatibility table.
- At least **30 connector tools** or at least **15K tokens of connector schema** on the turn. The findings said 10, but Anthropic's own accuracy claim starts at 30–50 tools. Below that, the search step is latency for no accuracy gain.
- Not on voice turns.
- Never on a deployment flagged HIPAA. Tool search is not HIPAA-eligible. Today there is no such flag, so add a deployment env.

**Shape**
- Native Juno tools and the 3–5 most-used connector tools are not deferred. Rank by the user's connector call counts, which are stable per conversation.
- Add `tool_search_tool_bm25_20251119`.
- `cache_control` goes on the last **non-deferred** tool.
- Add one system line naming the connected apps.

**Extra benefit:** a connector added mid-conversation no longer rewrites the cached prefix, because deferred tools are outside it.

**Files**
- `src/lib/anthropic.ts:301-318`.
- `streamAnthropic`'s round loop already passes assistant blocks back unchanged for `pause_turn` (`anthropic.ts:491-494`). Verify that `server_tool_use` and `tool_search_tool_result` survive the accumulator, and that no `tool_result` is ever sent for a `srvtoolu_` id.
- The run record and activity: do not render search blocks as connector calls.

**Tests:** request-builder unit tests:
- the threshold is respected;
- `defer_loading` is set only on connector tools beyond the top N;
- no `cache_control` on a deferred tool;
- at least one tool is not deferred;
- a mocked stream with a search block round-trips.

**Eval:** a connector tool-selection set at 30, 60 and 64 tools, with and without deferral. Score correct-tool rate, failed calls, rounds per turn, and time to the first connector call.

**Saving:** about 0.2% overall at the narrower gate. On qualifying turns, about 85% of the connector schema drops out of the prefix.

---

## 3. Rejected items and why

**R1. CTX-1: project reference files "dumped on zero-match turns".**
- The mechanism is wrong. Chunks are never written, so retrieval never returns a passage, so the dump happens on **every** project turn, and it is cache-stable (§1, correction 1).
- Shipping the proposed step 1 would remove every indexed project file from every project turn. The model would get a "no passage matched" note and no tool to open the files.
- That is the worst possible regression for projects, which is a feature the owner wants to beat Claude and ChatGPT on.
- **What survives** belongs to retrieval lane **RS-5** (build the index), as preconditions on it:
  - never let the fallback flip per turn: below the size threshold always send whole, above it always send passages;
  - attach `read_document` to project chats that have indexed documents, so a no-match turn has a read path. The tool's scope already includes `projectId`;
  - add a total cap on `buildProjectReferenceFiles` relative to the model's window. Today a large library can overflow the window, and the router's estimate assumes the files were replaced (`router/chat-context.ts:128-135`).
- No saving is counted here.

**R2. CTX-4: older text attachments become outline + head.**
- **Where it bites.** The cut lands 4–7 turns after upload, inside document-centric conversations: contract review, a report discussed for a while. These are exactly where people keep asking detail questions.
- **The model then has two choices, both bad:**
  - answer from the outline, which is lower quality;
  - call `read_document` before answering, which adds one tool round to an interactive turn.
- **Product position.** Claude.ai keeps whole documents in context, and matching or beating that is the product goal.
- **The saving shrinks** to about 75% of the claimed figure once the read-backs are paid for.
- **The cost is mainly miss re-writes, not reads.** Carrying 37K tokens costs about $0.004 per turn on a cache hit and $0.09 on a miss. That cost belongs to cache lane F7 (1h TTL for large histories), which removes it without removing content.
- **A note on precedent.** The existing Claude-PDF placeholder after the lookback (`anthropic.ts:166-167`) is itself a quality gap to fix, not a standard to extend.

**R3. CTX-6: downscale re-sent images; OpenAI `detail:"high"`.**
- On Claude 4.7 and later, a re-sent image would go from up to 2,576 px to 1,568 px. Follow-up questions on dense screenshots and documents ("fix the error on line 12 of the screenshot") are asked on exactly those turns.
- They would get worse, or need an `inspect_image` round.
- For about 0.5% of spend.
- On OpenAI, `auto` is `original` on gpt-5.5 and 5.6, so `high` cuts the chosen model's resolution on every image.
- The only defensible follow-up is a quality/latency decision for the product: an outlier cap for GPT-5.6's no-resize behaviour on very large photos, behind an eval. It is not a free saving and is not counted.
- Separately, fix the inaccurate "copies are downscaled" nudge: wording only, no cost effect.

**R4. CTX-7: stub the latest semantic JSON body when the outline lists it.**
- The outline is lossy and bounded: 24K chars shared by up to 4 artifacts, as little as 6K each (`turn/semantic.ts:23-45`).
- Stubbing the newest body would drop values and structure the model can only read there.
- The superseded bodies (one per ops edit, see §1) are collapsed by **K1**.
- The outline churn in the system tier is cache lane **F10**. Not counted twice.

**R5. CTX-9: stub old Live UI JSON.**
- Unlike artifacts, Live UI views have no versioned store, so a stub has no recovery path.
- "Change the slider max on the earlier calculator" would get a rebuilt view, not the same one.
- Grading also needs quiz answers. The existing `liveUISummaryLines` deliberately drops them.
- The saving is about 0.7%, on an assumed 8% share. The risk to reward is not worth it.

**R6. CTX-10: web search dynamic filtering.**
- Native search runs only on voice turns (latency-critical; dynamic filtering adds code-execution steps), on private turns (dynamic filtering is **not ZDR- or HIPAA-eligible**, which conflicts with what private mode promises), and on fallback deployments.
- The saving is unquantified.
- Revisit only if the operator sets native search to `prefer` or `also`, using the existing `anthropicWebSearchTool`.
- Also note `anthropic-loop.ts` is dead code: either wire it or delete it.

**R7. CTX-11: realtime truncation.**
- It is the same item as voice lane **V9** (`retention_ratio` on the legacy OpenAI realtime fallback). Count it once, there.
- Reject the extra `token_limits.post_instructions: 8000`. It is an absolute cap that makes long calls forget early context well before the model's window fills.

**N1–N5: agreed.**
- **N2 is right on cost.** The 8K head is shared and 1h-cached: about $0.0008 per turn on Sonnet 5.5.
- **N3 and N1 are right on mechanics.** Mid-turn elision rewrites the suffix at 1.25x, against reads at 0.05x.
- **N4 is right on quality.**

**X1, X2 and X3** are cache-lane items (F1, F4, F5, F7 and F10), not counted here.
- **X3 checked.** Re-running K1 at m = 0.15 keeps it positive: −10% to −43% of message-prefix input.
- Don't add K1 to F7's savings without re-running `collapse_sim.py` at F7's resulting m.

**Cross-user safety.**
- None of K0–K4 shares a cache entry across users that is not already shared today.
- Anthropic caches are isolated per organization and workspace, and a hit requires an identical prefix.
- K1 and K2 operate within one conversation. K4's deferred schemas are the same per-user tools already sent.

---

## Sources

- Anthropic prompt caching (multipliers, 0.05x for Opus/Sonnet 5.5, price table, 4 breakpoints, 20-position lookback, invalidation table, isolation): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic vision (`⌈w/28⌉·⌈h/28⌉`; high-resolution tier 2,576 px / 4,784 tokens on Claude 4.7+; standard tier 1,568 px / 1,568 tokens; size table; downsample advice): https://platform.claude.com/docs/en/build-with-claude/vision
- Anthropic PDF support (1,500–3,000 text tokens per page plus per-page image cost; page limits): https://platform.claude.com/docs/en/build-with-claude/pdf-support
- Anthropic tool search (`defer_loading`, prefix exclusion, no `cache_control` on deferred tools, 30–50-tool accuracy threshold, ~55K tokens reduced by >85%, not HIPAA-eligible): https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- Anthropic web search (versions, dynamic filtering, not ZDR/HIPAA-eligible, $10/1K, results billed as input): https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- OpenAI images and vision (`auto` = `original` on gpt-5.5/5.6; `original` 10,000 patches or 6,000 px; `high` 2,500 or 2,048; GPT-5.6 no resize). Search snippets only, because the host does not resolve from this session: https://developers.openai.com/api/docs/guides/images-vision
- OpenAI Realtime costs and truncation (`retention_ratio`, `token_limits.post_instructions`). Search snippets only: https://developers.openai.com/api/docs/guides/realtime-costs and https://www.rubydoc.info/gems/openai/OpenAI/Models/Realtime/RealtimeTruncationRetentionRatio/TokenLimits
