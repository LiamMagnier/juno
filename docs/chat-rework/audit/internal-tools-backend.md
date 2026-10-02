# Internal audit: the chat tool-calling backend

Scope: the web chat's tool-calling backend, from `POST /api/chat` to the SSE the client reads,
across all four provider adapters. Worktree `juno-tools` @ `d0997af2` (branch
`web/tools-thinking-research`). Read-only audit; nothing in `src/` was changed.

Method: read every file on the path (list in §1.2). Ran the tool unit tests (`tsx --test` on 9 files,
123 tests, all pass). Ran `classifyExternalAction` / `decideActionPolicy` on the exact inputs the
registry tools send (§5, C1). External API claims I could not check from the repo are marked
**(verify)**.

Companion reports in this folder: `internal-tools-e2e-trace.md` (per-request trace, same root cause
found independently), `internal-tools-ui.md` (panel and rows), `external-claude-tools.md`
(competitors).

---

## 0. TL;DR: the ten problems that matter

| # | Severity | Problem | Where |
|---|---|---|---|
| C1 | **Critical** | **None of Juno's 4 runtime tools work on a saved chat.** Each call to `read_document`, `inspect_image`, `browser_agent` or `code_interpreter` is classified `unknown`, which means "ask the user" under every policy. The ask is never shown, because the registry does not pass `onApprovalRequest`. The loop polls the DB until the 120 s stall watchdog aborts the turn ("Model stopped responding"). | `agent/runtime.ts:96-115`, `action-approval.ts:99-118,190-245`, `chat-stall.ts:22` |
| H1 | High | **Web search only exists on 3 of 14 providers (Anthropic, Google, xAI).** No OpenAI model can search, including the flagship GPT-5.x on chat completions and the Responses models (`_webSearch` is ignored). Search is a manual toggle that defaults to off. The URL reader rides the same toggle, so on OpenAI, DeepSeek, Mistral, Kimi, GLM, Qwen, MiniMax, Meta, MiMo and LongCat the model can never read a link. Juno already has a multi-engine search and a headless crawler (used by Research and Work), and chat never uses them. | `models.ts:204`, `route.ts:2099`, `composer.tsx:633`, `openai-responses.ts:198`, `tool-policy.ts:80` |
| H2 | High (security) | **Gemini receives connector output without the untrusted-content envelope.** It sends `exec.body` (unwrapped) where every other adapter sends `exec.text` (wrapped). | `gemini.ts:317-320` |
| H3 | High | **Gemini turns can fail with a 400 on third-party connectors.** Raw MCP JSON Schemas go into Gemini `functionDeclarations[].parameters`, which is an OpenAPI subset that rejects `additionalProperties`, `$schema`, `$ref`, `oneOf` and `const`. The code knows this: `task-tool.ts:77` says so. | `gemini.ts:56-63`, `mcp.ts:384` |
| H4 | High (verify) | **The compat tool loop drops the model's reasoning** between rounds. DeepSeek, Kimi, GLM and MiniMax thinking modes want it replayed. GPT-5.x on chat completions loses its chain of thought every round. | `openai-compat.ts:553-557` |
| H5 | High | **A tool call leaves no trace the model can see on the next turn.** `MessageForModel` is `{role, content, attachments}`, so a follow-up question about "the issue you just read" has nothing behind it. | `types/llm.ts:6`, every `to*Messages` |
| H6 | High | **The Responses replay keeps only `reasoning` and `function_call` items and drops assistant `message` items** (preambles). Reasoning→item pairing can break (verify), and the preamble is lost. | `openai-responses.ts:378-386` |
| H7 | High | **Unbounded, non-deterministic connector tool arrays.** There is no cap, so GitHub + Notion + Composio can pass OpenAI's 128-function limit. The array is built in `Promise.all` completion order, so it changes from turn to turn and the Anthropic tools cache and the OpenAI prefix cache miss. | `mcp.ts:346-393` |
| H8 | High | **Tool outputs never reach the user as outputs.** Code-interpreter charts and files, and `inspect_image` crops, are shown only to the model. The panel gets a 4 KB text head. | `agent/code.ts:200-243`, `tool-detail.ts` |
| M* | Medium | 25 more are listed in §5: approval UX, budgets, ids, Anthropic `server_tool_use` input loss, dropped citations, Gemini search-suggestion compliance, xAI Live Search deprecation, and others. | §5 |

**What does work end to end:**
- `start_task`, which is a native tool and skips the generic broker.
- Anthropic and Gemini native web search, when the toggle is on.
- xAI Live Search, if xAI still accepts it (verify).
- MCP connector calls, at the cost of an approval card for every unannotated read.

---

## 1. Architecture map

### 1.1 Flow

```
client (use-chat.ts:1302-1320)  body: webSearch?, connectors[≤5], deepResearch?, workHandoff:true, skillSlug?, …
   │
POST /api/chat  (route.ts)
   ├─ model resolution, budget, admission
   ├─ activeConnectors = getActiveConnectors(user, input.connectors ∩ workspace allow-list)      route.ts:910-921, mcp.ts:85
   ├─ PRIVATE branch (route.ts:923-1260): connectors: [] and NO audit → streamChat opens NO toolset
   └─ SAVED branch:
        attachmentToolToggles {documents, code, images}                                          route.ts:2057-2079
        researchActive / useWebSearch / canvasOn                                                 route.ts:2093-2111
        skill → narrowRuntimeToolsForSkill                                                       route.ts:2133-2195
        taskToolOn = chatTaskToolEnabled(...)                                                     route.ts:2229-2247
        system = composeSystemPrompt({webSearch, documentTool, imageTool, codeTool, canvasOn})   route.ts:2266-2285
        createStartTaskTool(...) if taskToolOn                                                    route.ts:2910-2938
        streamChat({ webSearch, connectors, allowedTools, audit{…onApprovalRequest}, nativeTools }) route.ts:2947-3001
            llm.ts:79  streamChat
              ├─ openUnifiedAgentToolset(active, ctx, {allowedToolIds})   (only if opts.audit)   llm.ts:164-184
              │     ├─ openMcpToolset (connect + listTools each connector)                       mcp.ts:332
              │     └─ registry tools filtered by allowlist                                       runtime.ts:232-252
              ├─ withNativeTools(toolset, [start_task])                                           llm.ts:57-75
              └─ providerAdapterFor(model) → anthropic-native | gemini-native | openai-responses | openai-compatible
                    each adapter runs ITS OWN tool loop (≤6 rounds + 1 forced answer)
                    yields LlmEvent: text | reasoning{part?} | sources | tool{call|result} | usage | finish
        for await ev: acc.apply(ev) → StreamEffect → SSE                                          route.ts:3002-3045
            text      → {type:"delta"}  (+ activity "write" once)
            reasoning → {type:"reasoning", part}
            tool_call → activity kind "tool" with tool.resultNote:"pending"   (createToolActivity.open)
            tool_result → same activity id re-sent with result/status/duration (createToolActivity.close)
            sources   → activity kind "visit" per new source + {type:"sources", sources: all}
            usage     → budget guard only (no SSE)
        approvals: onApprovalRequest → requestApproval → watchdog.pause + activity + {type:"approval"} route.ts:2896-2908
        after stream: artifacts parsed from text (<juno:artifact>), memories (<juno:memory>/<juno:forget>)
        persistAssistantTurn: content (concatenated text), reasoning, reasoningParts, activity (encrypted JSON)
```

### 1.2 Files on the path

| Layer | Files |
|---|---|
| Route | `src/app/api/chat/route.ts` (3730 lines). Tool-relevant: 379-423, 910-921, 1086-1192, 2057-2285, 2738-2766, 2896-3045 |
| Request | `src/lib/chat/request.ts` (`connectors` ≤5 at :125, `workHandoff`, `webSearch`, `deepResearch`) |
| Orchestrator | `src/lib/llm.ts` (`streamChat`, `NativeChatTool`, `withNativeTools`) |
| Adapters | `anthropic.ts` + `anthropic-round.ts` + `anthropic-thinking.ts`, `openai-responses.ts`, `openai-compat.ts` + `openai-compat-round.ts`, `gemini.ts` + `gemini-core.ts` + `gemini-round.ts` + `gemini-finish.ts`, `tool-result-images.ts`, `provider-routing.ts` |
| Tool runtime | `agent/runtime.ts` (registry + unified toolset), `agent/types.ts`, `agent/{browser,document,image,code}.ts`, `agent/attachments.ts`, `agent/attachment-match.ts`. Dead: `agent/computer.ts`, `agent/swarm.ts` |
| Connectors | `mcp.ts`, `tool-access.ts`, `tool-audit.ts`, `work/connectors.ts` (`truncateConnectorResult`), `app/api/mcp/[connector]`, `app/api/mcp/composio/[slug]` |
| Approval | `action-approval.ts` (classifier + policy), `action-approval-store.ts` (receipts, wait, consume) |
| Chat helpers | `chat/tool-policy.ts`, `chat/task-tool.ts`, `chat/skills.ts`, `chat/skill-runtime.ts`, `chat/tool-detail.ts`, `chat/stream-accumulator.ts`, `chat/stream-log.ts`, `chat/stream-replay.ts`, `chat/prompt-sections.ts`, `chat-stream.ts`, `chat-stall.ts` |
| Types | `types/llm.ts` (`LlmEvent`, `MessageForModel`), `types/chat.ts` (`StreamChunk`, `ClientActivityEvent`, `ClientToolDetail`) |
| Tests | `anthropic-round`, `chat-tool-detail`, `gemini-round`, `gemini-request`, `openai-compat-round`, `unified-agent-runtime`, `tool-access`, `chat-task-tool`, `code-interpreter`, `document-reading`, `action-approval-enforcement`, `untrusted-content`, `prompt-injection-defense` |

---

## 2. Inventory: everything a chat turn can carry

Gate legend:
- **T**: the user's composer toggle.
- **P**: plan flag (`PLANS[plan].webSearch` is false on FREE).
- **W**: workspace/assistant permission (`workspacePermits`).
- **M**: model capability flag.
- **A**: attachment present.
- **E**: env var.

"Actual approval" is what the broker really decides today, which is not what the tool declares.

### 2.A Provider-native (server-side) tools

| Id | What it does | Providers / models | Exact gate | Actual approval | How results come back | Limits |
|---|---|---|---|---|---|---|
| `web_search` (`web_search_20250305`) | Claude's server-side search, run inside Anthropic | anthropic-native only | `useWebSearch = !researchActive && input.webSearch(T, default off) && PLANS.webSearch(P) && modelInfo.webSearch(M: provider∈{anthropic,google,xai}) && workspacePermits("webSearch")(W)`, at `route.ts:2099-2100`. Private: `route.ts:939` | None; it never touches the broker (`anthropic.ts:275-278`) | `web_search_tool_result` blocks: URLs become a `sources` LlmEvent, which becomes one "Visited source" row per result plus the `sources` SSE. The blocks are replayed in-loop. `citations_delta` is dropped, and so is the query (§5 M1, M2) | `max_uses: 5` per request. Loop gets 7 rounds so `pause_turn` can continue (`anthropic.ts:333`). Billed as `webSearchRequests` |
| `google_search` grounding | Gemini's Google Search grounding | gemini-native | Same `useWebSearch`. Sent on every round, including the final one (`gemini-core.ts:368-379`). **On Gemini ≤2.5 it replaces every function tool** | None | `groundingMetadata.groundingChunks` are collected, redirect URLs are resolved **after the stream ends** (`gemini.ts:418-420`), then sent as one `sources` event. `searchEntryPoint` is parsed and never shown (§5 M13). `webSearchQueries` are never shown | None set |
| xAI Live Search | A body extension, not a tool: `search_parameters: {mode:"auto", return_citations:true}` | openai-compatible, provider `xai` only | Same `useWebSearch` (`openai-compat.ts:452-454`) | None | `chunk.citations[]` become `sources` with title = URL. Billing is estimated as `ceil(citations/10)` (`openai-compat.ts:611-613`) | Likely deprecated by xAI (§5 M15, **verify**) |
| (none) | No web search at all | openai (compat **and** responses), deepseek, mistral, moonshot, zhipu, qwen, minimax, meta, mimo, longcat, seedance | `modelInfo.webSearch=false`, so the composer hides the toggle (`composer.tsx:717-719`). The Responses adapter takes `_webSearch` and ignores it (`openai-responses.ts:198`) | n/a | n/a | n/a |

### 2.B Registry tools (`UnifiedAgentRegistry`, `agent/runtime.ts:20-40`)

All four are registered at module load. A turn only gets them through the explicit allowlist from
`chatRuntimeToolAllowlist` (`tool-policy.ts:78-85`), narrowed by any skill (`skills.ts:314-325`).
Dispatch path: `runtime.ts:271-293` → `executeToolCall` (`runtime.ts:78-192`) → `authorizeExternalAction`
with `connectorId:"juno_runtime"` → `tool.execute`.

| Id | What it does | Providers | Exact gate | Declared risk | **Actual approval** | How results come back | Limits |
|---|---|---|---|---|---|---|---|
| `browser_agent` | "Navigate, read, click, type, scroll, screenshot, extract". In reality it always does one GET of `url` (default `https://google.com`), regex-strips the HTML and returns the text | All adapters, but it only rides with `useWebSearch`, so **only Anthropic, Google and xAI** in practice | `useWebSearch` (T+P+M+W, not research). Never on FREE. Never in private | `read_only` | **`unknown` → ASK under every policy → invisible → turn dies (C1)** | `stdout` = the page in the untrusted envelope. Title and links are **not** included. No `sources` event | 15 s fetch timeout, 15,000 chars, 20 buttons / 30 links (unused), no PDF, no JS |
| `read_document` | `list` / `outline` / `read` (page range, offset) / `search` over the conversation's FILE attachments. Falls back to reading the bytes when unindexed | All adapters | `allAttachments.some(kind==="FILE")` over **message** attachments in the history window (`route.ts:2066`). Project-knowledge files do not count | `read_only` | **`unknown` → ASK → dies (C1)** | Enveloped text, with a continuation hint to use `offset` | 60,000 chars per read, 20 search hits, oldest 60 attachments only (`attachments.ts:25,52`) |
| `inspect_image` | Crop, magnify, grayscale, contrast or rotate an attached image, or render a PDF page, and return the pixels | All adapters. Pixels only when the model has vision and the image is jpeg/png/gif/webp | `modelInfo.vision && any IMAGE or application/pdf attachment` (`route.ts:2074-2078`) | `read_only` | **`unknown` → ASK → dies (C1)** | Anthropic: image inside `tool_result`. Responses and compat: a follow-up `user` turn with an intro line (`toolImageIntro`). Gemini: a separate user turn with `inlineData` | 1 image, output edge 768-1400 px |
| `code_interpreter` | Python in a remote microVM, with attachments copied into the working directory | All adapters | `isCodeInterpreterConfigured()` (E: `CODE_INTERPRETER_URL` + token) **and** `allAttachments.length > 0` (`route.ts:2073`) | `destructive_or_sensitive` | **`unknown` → ASK → dies (C1).** The declared class is ignored as well | stdout (30k), stderr (4k), up to 4 PNG/JPEG images go back to the model. **Nothing is persisted for the user** (H8). SVG charts are withheld | 120 s, 10 files × 32 MB, stateless per call, abort signal not forwarded |

### 2.C Native chat tools (`NativeChatTool`, `llm.ts:39-75`)

| Id | What it does | Gate | Approval | How results come back | Limits |
|---|---|---|---|---|---|
| `start_task` | Creates a Work session and run linked to the conversation (the background task) | `chatTaskToolEnabled` (`task-tool.ts:158-175`). Every one of these must hold: `workHandoff===true` (web sends it, `use-chat.ts:1320`), not private, not voice, not regenerate, has userMessageId, not research, not canvas edit, `conversation.kind==="chat"`, `model.agenticTools` (false only for `mistral-medium`), function tools reach the model (Gemini ≤2.5 + search excluded), skill permits, not lockdown, plan has a Work model | Its own logic: it asks through the broker only if the estimate `requiresConfirmation`, or `untrustedContent || attachments>0`. `JunoRules["juno_work:start_task"] = external_write` (`action-approval.ts:117`), with `onApprovalRequest` passed, so **the card shows**. Idempotent per user message | Plain text outcome (not enveloped). `onStarted` sends the `{type:"work", session}` SSE | One task per user message. Calls are serialized through a promise queue |

### 2.D MCP connector tools (`mcp.ts`)

| Aspect | Today |
|---|---|
| Ids | `<connectorId>__<tool>`, sanitized to `[a-zA-Z0-9_-]` and 64 chars. Collisions get `_1`, `_2`… depending on order (`mcp.ts:240-256`) |
| Sources | Native: GitHub (`api.githubcopilot.com/mcp/`), Figma, Notion (`mcp.notion.com`), and Apple Calendar/Mail/Music served by Juno's own `/api/mcp/[connector]`. Composio apps are proxied through `/api/mcp/composio/[slug]` (tool-router session) |
| Gate | `input.connectors` (≤5, `request.ts:125`). They come from composer chips or from client-side regex auto-detection (`connector-intent.ts`) of the app's name in the prompt. Then workspace `connectors` permission ∩ `allowedConnectorIds` (`route.ts:912-917`), not private (`route.ts:918-921`), linked and configured, token refreshable (`mcp.ts:85-131`), and `client.connect` + `listTools` succeeding (failures are swallowed, `mcp.ts:389-391`) |
| Providers | All four adapters. Gemini ≤2.5 with search on drops them (`gemini-core.ts:379`) |
| Approval | `classifyExternalAction`: Juno exact rules for the Apple tools. Otherwise destructive tokens → destructive. A read requires **both** `readOnlyHint:true` **and** a read-verb name. Otherwise `unknown` → ask. Default policy `ask_for_any_change` (`action-approval.ts:42`). Juno's own servers annotate every tool. GitHub annotates. Composio tool-router meta-tools (`COMPOSIO_*`, **verify**) and unannotated servers get a card for every call |
| How results come back | `text` parts joined, `resource` JSON-stringified, anything else `JSON.stringify(part)` (images and audio become base64 text). `isError` is ignored. The result is truncated to 30,000 chars with a notice, then wrapped in the untrusted envelope (`mcp.ts:269-300`). Every call gets a `ToolInvocation` audit row (`mcp.ts:425-435`) |
| Limits | 5 connectors. No per-connector or total tool cap. Descriptions cut at 1024 chars. No `listTools` pagination. No connect timeout (SDK default 60 s per request) |

### 2.E Pseudo-tools implemented as markup in the answer text (parsed after the stream)

| Capability | Protocol | Gate | Handling |
|---|---|---|---|
| Canvas / artifacts | `<juno:artifact identifier type=HTML\|REACT\|CODE\|SVG\|MARKDOWN\|MERMAID\|DESIGN title language>…</juno:artifact>` (`system-prompt.ts:240-300`) | `canvasOn` (not voice, `canvasEnabled ?? true`, W "canvas") | `prepareChatArtifactOutput` → verify, repair, or refuse → `persistArtifacts` (`route.ts:433-460`) |
| Canvas targeted edit | A patch protocol inside the text (`buildArtifactEditPrompt`, `parseArtifactPatch`) | `input.artifactEdit` | Server-internal. The text is suppressed from `delta` (`route.ts:3016`) |
| Memory write / forget | `<juno:memory>…</juno:memory>` / `<juno:forget>…</juno:forget>` (`system-prompt.ts:310-316`) | `memoryEnabled && !untrustedContentInTurn` (`route.ts:3122`) | `saveAutoMemories` / `forgetStatements` |
| Learning blocks, inline visuals | Inline markup rules in the system prompt (`system-prompt.ts:121-234`) | Always (not voice) | Rendered by the client |

None of these can return anything to the model within the turn. None can be called twice with feedback. All
are lost if the model forgets the exact tag grammar.

### 2.F Things that act like tools but run before the model (the model cannot invoke them)

| Capability | Where | Note |
|---|---|---|
| Deep research | `runDeepResearch` (`route.ts:2794-2855`) | Replaces native web search for the turn. The corpus is appended to the **system prompt**. It is a mode, not a tool. Research workers have their own tool protocol: `search`, `open_page`, `find_in_page`, `note_finding`, `done` (`research/agents/protocol.ts:98-193`) |
| Attachment passage retrieval / project knowledge | `buildAttachmentContext`, `projectKnowledge` (`route.ts:1960-2017`) | RAG into the prompt. The model cannot query project files (see M19) |
| Previous research report | Injected into the system prompt (`route.ts:2776-2791`) | Up to 48k chars |
| Memory recall | `memoryProfile` → system prompt | No search tool |
| Connector auto-enable | Client regex (`connector-intent.ts`) | Only when the app is named |
| Auto model routing, preflight clarification | Route | The model cannot ask the user mid-turn |
| Image and video generation | `/api/generate` (separate endpoint) | Only when the user picks an image model. The chat model cannot generate an image |

### 2.G Registered or declared but dead

| Item | Where | State |
|---|---|---|
| `computer_use` | `agent/computer.ts` | Not registered. Its `execute` returns **fake success** on darwin (`computer.ts:126-174`) |
| Host Python | `sandbox/python.ts` | Deliberately not registered |
| `AgentSwarmCoordinator` | `agent/swarm.ts` | Only tests use it |
| `detectAutomaticEscalation`, `toProviderToolSchemas` | `runtime.ts:57-73, 308-371` | Only tests use them |
| `AgentExecutionContext.onEvent` events | Every registry tool emits them | `llm.ts:166-175` never sets `onEvent`, so they are all dropped |
| `LlmEvent {type:"approval"}` | `types/llm.ts:102` | Never yielded. Approvals travel by callback |
| `McpToolset.accessFor` | | Nothing in chat reads it |

### 2.H Other tool stacks in the repo (divergent implementations)

- **Work runner** (`runner/agent-core/src/work/tools.ts`, `tools/*.ts`): `web_search`, `web_fetch`,
  `browser`, `bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `cloud_files`,
  `create_deliverable`. It has its own loop and its own injection scanner (`scanUntrusted`).
- **Research workers** (`research/agents/worker.ts:363`): an OpenAI-shaped loop with 5 tools.
- **Chat**: the registry plus four adapter loops (this document).

There are three tool stacks and three loops. Chat is the weakest of them.

---

## 3. The tool loop, adapter by adapter

### 3.1 Summary matrix

| | Anthropic (`anthropic.ts`) | OpenAI Responses (`openai-responses.ts`) | OpenAI-compatible (`openai-compat.ts`) | Gemini native (`gemini.ts`) |
|---|---|---|---|---|
| Who uses it | provider `anthropic` | `openai` with `api:"responses"` (the gpt-5.x-pro and codex lines), or pro mode | Everyone else, **including mainline GPT-5.x/6** | provider `google` |
| Tool wire shape | `{name, description, input_schema}`, with `cache_control` (1h) on the last tool (`:262-273`) | Flat `{type:"function", name, description, parameters, strict:false}` (`:236-247`) | `toWireTools` → `{type:"function", function}` (`:455`) | `functionDeclarations[{name, description, parameters}]` (`gemini.ts:56-63`) |
| Rounds | `MAX_TOOL_ROUNDS=6` + 1 forced (`:194,333`). Also 7 for web-search-only turns | 6+1 (`:47,303`) | 6+1 (`:172,479`) | `MAX_GEMINI_TOOL_ROUNDS=6` + 1 (`gemini-core.ts:31`). **Plus up to 2 continuation passes, each with a fresh 7-round budget** (`gemini-finish.ts:200`) |
| Forced final round | `tool_choice:{type:"none"}`, tools kept (`:341`) | `tool_choice:"none"` (`:341`) | `tool_choice:"none"` (`:483`) | Function declarations **withheld** and search kept (`gemini-core.ts:375`). No `toolConfig` |
| When a round runs tools | `stop_reason==="tool_use"` with at least one tool_use (`:416`). `pause_turn` replays the content unchanged (`:411-414`) | `calls.length>0` (`:445`). The finish reason is not checked | Calls exist and the finish reason is not `length` (`openai-compat-round.ts:89-96`) | `state.functionCalls.length>0` (`:295`) |
| How the call is parsed | `content_block_start(tool_use)` opens a partial. `input_json_delta` accumulates. `content_block_stop` runs `safeToolInput` (bad JSON becomes `{}`) (`anthropic-round.ts:197-261`) | Completed `function_call` items from `response.output_item.done` (`:378-386`) | Deltas keyed by id, then index, then last-opened (`openai-compat-round.ts:41-72`). Calls with no id or name are dropped (`:75-77`) | `part.functionCall{name,args}` (already an object) (`gemini-round.ts:188-192`) |
| Call id sent to `toolset.execute` | Provider `tool_use.id` | **None** (`:461`) | **None** (`:569`) | **Random `call_${Date.now()}_${rand}`** (`:304`) |
| Parallel calls | Collected per round, **run one after another**, and all results go in one `user` turn (`:419-462`) | Run one after another. One `function_call_output` per call, with images in an extra user turn | Run one after another. One `tool` message per call, with images in an extra user turn (`:575-591`) | Run one after another. All `functionResponse`s in one user turn, images in a second user turn (`gemini-round.ts:228-252`) |
| What goes back into the history | `messages.push({assistant, content: blocks})`: text (non-empty), thinking with signature, redacted_thinking, tool_use, server_tool_use, web_search_tool_result, ordered by wire index (`anthropic-round.ts:176-278`) | `reasoning` items (with `encrypted_content` via `include`) and `function_call` items only. **`message` items are dropped** (`:378-386`) | `{assistant, content: text\|null, tool_calls}`. **Reasoning is dropped** (`:553-557`) | Model parts replayed as they came, `thoughtSignature` included. `functionCall.id` is lost |
| Tool result payload | `tool_result{tool_use_id, content: exec.text (+images)}`. **No `is_error`** | `function_call_output{call_id, output: exec.text}` | `{role:"tool", tool_call_id, content: exec.text}` | `functionResponse{name, response:{result: exec.**body**}}`. **Unwrapped (H2)**, with no `id` |
| LlmEvent `tool.call` | At `content_block_start`, **before the args exist**, so args come on `result` | After the round, just before dispatch, with args | After the round, just before dispatch, with args | After the round, just before dispatch, with args |
| Usage events | **After every round** (cumulative) and a final one with `fast` (`:390-400, 483-501`) | **End only** (`:500-510`) | **End only** (`:615-627`) | **End only** (`:422-431`) |
| Sources | web_search results as they stream (`anthropic-round.ts:229-240`) | none | xAI `citations` | groundingChunks, at the end |
| Finish | A trailing `tool_use` or `pause_turn` is mapped to `max_tokens`, which becomes "length" (Continue) (`:471-473`) | A trailing `tool_calls` becomes "length" (`:513`) | A trailing `tool_calls` becomes "length" (`:630`) | `decideGeminiFinish` works from evidence. `MALFORMED_FUNCTION_CALL` becomes "unknown" (red "Stream ended unexpectedly") |
| Abort | The SDK gets the signal. `toolset.execute` gets the signal. The next `create` throws | Same | Same | `requestGeminiStream` gets the signal. A continuation is skipped if aborted |
| Errors during a tool | Whatever `execute` returns (MCP/registry/native catch their own errors). **A DB error inside `authorizeExternalAction` or `recordToolInvocation` throws out of the adapter and fails the whole turn** (`mcp.ts:425-481` has no try) | Same | Same | Same. A failed continuation keeps the answer so far |
| Stream errors | SDK throws | `response.failed` and `error` events throw (`:426-438`) | SDK throws | `GeminiProviderError`, with an empty-stream guard |
| Reasoning | `thinking_delta` → `reasoning` | `reasoning_summary_*` → `reasoning{part}`, with the part number carried across rounds | `reasoning_content` / `reasoning` / `reasoning_details` / Mistral typed chunks | `thought:true` parts |

### 3.2 Anthropic details worth knowing

- Thinking: adaptive for 4.6+/5.x, manual `budget_tokens` for Haiku 4.5, Sonnet 4.5 and Opus 4.5
  (`anthropic-thinking.ts:35-56`). Signatures are accumulated from `signature_delta` and replayed in
  wire order. That is correct. The `interleaved-thinking-2025-05-14` beta is **not** sent, so the
  manual-thinking models do not think between tool calls (L2). Adaptive models interleave on their own.
- Prompt-cache breakpoints: two system tiers (1h), the last tool (1h), and the last message (5m).
  That is exactly Anthropic's limit of 4. Appending `start_task` after the connector tools, and the
  non-deterministic MCP order (H7), both move the tools prefix.
- `pause_turn` handling is right in principle, but see M1: the replayed `server_tool_use` block has
  `input: {}`.
- The final round's `tool_choice:none` keeps the definitions, which is correct because the history has
  tool_use blocks.

### 3.3 OpenAI Responses details

- `store:false` plus `include:["reasoning.encrypted_content"]` makes the reasoning replayable. Good.
- **`message` output items are not replayed** (H6). Neither are any other item types.
- Web search is ignored, and so is every hosted tool (`web_search`, `file_search`,
  `code_interpreter`, `image_generation`, remote `mcp`).
- A `function_call_output.output` is always a string. The Responses API now accepts content arrays
  with `input_image` in tool outputs (**verify**), which would remove the extra "user" turn.

### 3.4 OpenAI-compatible details

- This one adapter serves 13 providers and the mainline OpenAI models. It has no per-model
  "supports tools" capability: tools are sent to every chat model (see L-series). `agenticTools` only
  gates `start_task`.
- `tool_choice:"none"` and `stream_options.include_usage` are sent without any per-provider checks.
  `NO_STREAM_USAGE` is empty.
- The only web search is xAI `search_parameters`.

### 3.5 Gemini details

- `thoughtSignature` is echoed correctly on function-call parts. A signature on an **empty-text**
  part is dropped (`gemini-round.ts:193`, `else if (part.text)`), which is harmless for function
  calls and loses the signature for text-only turns (L-level).
- `functionCall.id` and `functionResponse.id` are not carried (M12).
- Declarations are withheld on the final round, and there is no `toolConfig.functionCallingConfig`.
  `MALFORMED_FUNCTION_CALL` is not retried (M11).
- Built-in tools other than `google_search` (`url_context`, `code_execution`, maps) are unused.

---

## 4. Event pipeline and SSE shapes

### 4.1 `LlmEvent` (`types/llm.ts:9-149`) → `StreamEffect` (`stream-accumulator.ts:21-59`) → SSE (`types/chat.ts:333-408`)

| LlmEvent | Accumulator effect | SSE sent (saved path, `route.ts:3002-3045`) | Persisted |
|---|---|---|---|
| `text` | `acc.text += text` (**no separator between rounds**, M18) | `{type:"delta", text}`, plus `activity{kind:"write"}` once | `Message.content` (after artifact rewrite) |
| `reasoning{text, part?}` | Reasoning parts state | `{type:"reasoning", text, part}` | `reasoning`, `reasoningParts` |
| `tool{phase:"call"}` | `tool_call` | `createToolActivity.open`: `sendActivity({kind:"tool", title:"Using <server>" \| "Starting a task", detail:name, tool:{server, name, args?/argsNote, resultNote:"pending"}})`. The row is keyed by `callId` in a local Map | `Message.activity` (encrypted JSON) |
| `tool{phase:"result"}` | `tool_result` | The **same activity object is mutated and re-sent** with `tool.status ok\|failed`, `result` head (4k), `durationMs`. A result with no open row is dropped | Same |
| `sources` | Dedupe | One `activity{kind:"visit", title:"Visited source", url}` per new URL, plus `{type:"sources", sources: all}` | `sources` on the message |
| `usage` | `mergeUsage` | none (the budget guard reads it) | cost/tokens columns |
| `finish` | `finishReason`, `finishNote` | The `done` chunk carries `finishReason` | `finishReason` |
| (callback) approval | n/a | `activity{kind:"tool", title:"<Connector> needs approval"}` + `{type:"approval", approval}`. The watchdog is paused | Receipt row. **Not on the serialized message**: the `done` payload has no `approvals` (`serializers.ts`), so the card disappears on done and on reload (M26) |
| (callback) start_task started | n/a | `{type:"work", session}` | WorkSession |

Budgets applied to tool detail (`tool-detail.ts`): args 2,000 chars, result 4,000, **32,000 chars per run
in total**. After that every row says "over_budget". Lockdown disables detail entirely
(`route.ts:734`).

### 4.2 What the stream cannot express today

- No dedicated `tool_call` / `tool_result` chunk. Tools are generic `activity` rows whose `id` is
  `activity-${Date.now()}-${n}`, not the call id.
- No round boundaries. No text offset or position of a tool call inside the answer, so the client
  cannot interleave text → tool → text. The persisted content is the rounds' text glued together.
- No streamed tool arguments (Anthropic's `input_json_delta` exists but is not forwarded).
- No server-side search queries (Claude `server_tool_use.input.query`, Gemini `webSearchQueries`).
- No tool-produced images or files for the user.
- No per-round usage or cost, and no "waiting on tool" status. The client status stays `writing`
  once any text has streamed.

---

## 5. Defects

Format: **ID — title** · severity · location · code path → consequence · fix direction.

### Critical

**C1 — Registry tools deadlock on an invisible approval, and the stall watchdog then kills the turn**
- Location: `src/lib/agent/runtime.ts:92-115`, `src/lib/action-approval.ts:99-118,190-245,258-284`,
  `src/lib/action-approval-store.ts:385-452`, `src/lib/chat-stall.ts:22`.
- Code path:
  1. `openUnifiedAgentToolset.execute` (`runtime.ts:271-277`) calls `defaultAgentRegistry.executeToolCall`.
  2. That calls `authorizeExternalAction({connectorId:"juno_runtime", toolName, args, callId: randomUUID(), …})`
     **with no `onApprovalRequest` and no annotations**. `tool.riskClass` is never consulted.
  3. `classifyExternalAction`: there is no `JunoRules` entry for `juno_runtime:*`. The name's first
     token must be a read verb **and** `readOnlyHint` must be true. There are no annotations, so every
     tool lands on `"unknown"` / `insufficient_metadata`.
  4. `decideActionPolicy` treats unknown as external_write, which is `"ask"` under `always_ask`,
     `ask_for_any_change` (the default), `ask_for_important_actions` and `allow_selected_low_risk`.
  5. The receipt is created `pending`. `request.onApprovalRequest?.()` is undefined, so no SSE card
     is sent.
  6. `waitForDecision` polls every 400 ms for up to 15 min.
  7. No event is yielded, so the chat's stall watchdog (120 s idle, `route.ts:2884-2892`) aborts the
     generation. The receipt becomes `superseded`, the tool returns "refused", and the next provider
     request throws on the aborted signal. The user sees "Model stopped responding".
- Evidence: I ran the classifier on
  `browser_agent{action,url,reason}`, `read_document{action,file}`, `read_document{action,query}`,
  `inspect_image{file,x,y,width,height}` and `code_interpreter{code,files}` under all 4 non-block
  policies. The result was `unknown insufficient_metadata → ask` in 20 of 20 cases.
- Tests: none of them runs a registry tool through the broker. `unified-agent-runtime.test.ts` only
  checks attachment gating and schemas.
- Consequence: every feature built on these tools is non-functional on saved chats: reading long
  documents, zooming images or scans, URL reading and the code sandbox. This is almost certainly the
  user's "tool call doesn't work".
- Fix:
  - First-party tools declare their own risk, and the broker trusts code Juno owns: add `JunoRules`
    entries (`juno_runtime:read_document` / `inspect_image` / `browser_agent` → `read_only`,
    `code_interpreter` → a sandboxed class that auto-allows), or skip the connector classifier for
    registry tools.
  - Always forward `onApprovalRequest`.
  - Pass the provider call id.
  - Add a test that executes each registry tool under the default policy with a fake broker store.

### High

**H1 — Web search and URL reading are missing on most models, and hidden behind a default-off toggle**
- Location: `models.ts:204` (`WEB_SEARCH_PROVIDERS = {anthropic, google, xai}`), `route.ts:2099-2100`,
  `composer.tsx:633` (`webSearchEnabled = false`), `openai-responses.ts:198` (`_webSearch` unused),
  `tool-policy.ts:80` (browser only with webSearch), `plans.ts:56` (FREE: `webSearch:false`).
- Consequences:
  - No OpenAI model can search or read a URL. That covers the most-used provider, and the Responses
    models ignore the flag.
  - Ten other providers cannot either.
  - Even on Claude and Gemini, the model cannot decide to search. The person has to predict the need
    and flip a switch before sending. ChatGPT and Claude both let the model decide.
  - Pasting a link without the toggle gives nothing.
- Juno already has `executeMultiEngineSearch` (`search/search-engine.ts`, `isSearchEngineAvailable()` →
  `true`), `crawlResearchPage` with headless rendering and PDF extraction (`research/crawler.ts`,
  `search/pdf-text.ts`), and Work's `web_search` / `web_fetch`. None of it is available to chat.
- Fix:
  - Always attach a provider-neutral `web_search` and `web_fetch` pair (function tools backed by
    Juno's engine and crawler) on every tool-capable model.
  - Prefer the provider-native tool where one exists (Claude `web_search`/`web_fetch`, OpenAI Responses
    `web_search`, Gemini `google_search` + `url_context`).
  - Make search "auto" (the model decides), with the toggle as an override (force or never).

**H2 — Gemini gets connector results without the untrusted-content envelope (security)**
- Location: `gemini.ts:317-320`: `response: { result: withheldImagesNote(exec.body ?? exec.text, …) }`.
- `ToolExecution.body` is documented as "WITHOUT the untrusted envelope — for the panel"
  (`mcp.ts:191-196`). The other three adapters send `exec.text`.
- Consequence: prompt-injection text from GitHub issues, Notion pages, emails and so on reaches Gemini
  undefanged and unmarked. The system prompt's untrusted-content rule has no markers to key on.
- For registry tools `body === text`, so only connectors are affected.
- No test covers it.
- Fix: use `exec.text`. Add an adapter-level test that every tool result sent to a provider starts
  with `UNTRUSTED_OPEN` for MCP tools.

**H3 — Raw MCP schemas can 400 whole Gemini turns**
- Location: `gemini.ts:56-63` copies `t.function.parameters` straight into `functionDeclarations`.
  `mcp.ts:384` passes `inputSchema` through untouched.
- Gemini's `parameters` is an OpenAPI 3 subset. `additionalProperties`, `$schema`, `$ref`/`$defs`,
  `oneOf`, `const`, `exclusiveMinimum` and similar are rejected with a 400 on the whole request
  (**verify** per current API).
- The codebase knows this: `task-tool.ts:77` says "Gemini rejects `additionalProperties`".
- Juno's own MCP servers emit clean schemas. Third-party servers built with zod-to-json-schema
  (Notion, many Composio tools) usually emit `additionalProperties:false` and `$schema`.
- Consequence: enabling such a connector on a Gemini turn fails the turn outright.
- Other compat providers (Zhipu, Moonshot, Qwen, DeepSeek) have their own schema dialect gaps. Nothing
  is normalized anywhere.
- Fix:
  - Keep one canonical JSON Schema per tool and compile it per provider: Gemini `parametersJsonSchema`
    (full JSON Schema) or a sanitizer to the OpenAPI subset. Anthropic forbids top-level
    `oneOf`/`anyOf`/`allOf`. OpenAI strict mode is optional.
  - Validate the arguments against the canonical schema before dispatch.

**H4 — The compat loop drops reasoning between rounds (verify per provider)**
- Location: `openai-compat.ts:553-557` pushes `{role:"assistant", content: assistantText||null, tool_calls}`.
  The reasoning streamed in `reasoning_content` / `reasoning_details` is thrown away.
- Documented provider behaviour, **to verify against current docs**:
  - DeepSeek (thinking mode with tools) and Moonshot Kimi K2-thinking/K3 require `reasoning_content`
    on assistant tool-call messages within the same turn. Missing it can be a 400.
  - MiniMax M2.x interleaved thinking expects `reasoning_details` replayed.
  - GLM "preserved thinking" wants it back.
  - Mainline GPT-5.x run on chat completions, which cannot carry reasoning at all, so every tool
    round restarts the chain of thought. OpenAI recommends the Responses API for reasoning models with
    tools.
- Fix:
  - Per-provider "reasoning replay" capability. Keep reasoning on the assistant tool-call message
    (`reasoning_content`, `reasoning_details`, Gemini `extra_content.thought_signature`).
  - Move all OpenAI reasoning models to Responses.

**H5 — There is no tool memory across turns, and tool calls are not first-class message parts**
- Location: `types/llm.ts:6` (`MessageForModel = {role, content, attachments}`). Every adapter
  flattens assistant history to text (`anthropic.ts:101-103`, `openai-responses.ts:68-74`,
  `openai-compat.ts:87-90`, `gemini-core.ts` `toGeminiContents`).
- Consequence:
  - On the next turn the model has no record of the calls it made or what they returned (for example
    GitHub issue contents or a file it read). It re-calls, and every write re-asks for approval, or it
    answers from memory it does not have.
  - `Message.activity` keeps a 4k redacted head for the panel only.
- Fix: persist ordered message parts (text, reasoning, tool_call{id,name,args}, tool_result{id,
  summary, full-or-compacted body, images}, sources). Replay them to providers in the native shape,
  with a compaction policy for old rounds (for example, keep the last N tool results in full and
  summarize older ones).

**H6 — The Responses adapter drops `message` items when replaying a round**
- Location: `openai-responses.ts:378-386`. Only items of type `reasoning` and `function_call` go into
  `replayItems`.
- GPT-5.x emits preambles: an assistant `message` between reasoning and a function call.
- Dropping them loses the preamble. It can also leave a reasoning item without the item that followed
  it, which the API rejects with a 400 ("Item 'rs_…' of type 'reasoning' was provided without its
  required following item", **verify**).
- Fix: replay every output item from the round in order, including `message`, and ideally
  `output_text` annotations.

**H7 — The connector tool array is uncapped and non-deterministic**
- Location: `mcp.ts:346-393`. `Promise.all(active.map(async c => { …; for (t of listed.tools) tools.push(…) }))`
  appends in network-completion order.
- Consequences:
  1. The tool order changes from turn to turn whenever two or more connectors are on. The Anthropic
     breakpoint on the last tool (`anthropic.ts:271`) and OpenAI's prefix cache both miss, and the
     tool schemas get rewritten at the 1h-write price every turn. The `_1` collision suffix can also
     move between tools.
  2. There is no cap. GitHub's MCP alone exposes dozens of tools. Five connectors (Composio included)
     can pass OpenAI's 128-function limit (400) and cost tens of thousands of schema tokens per round,
     times 7 rounds.
- Also: no `listTools` pagination (`nextCursor` is ignored), and no connect timeout. A slow server
  delays the first token by up to the SDK's 60 s per request.
- Fix: sort deterministically by connector id then tool name. Cache `tools/list` per connection with
  a TTL. Enforce a tool budget with deferred loading, either a Juno "tool search" meta-tool or
  Anthropic `defer_loading` plus tool search (**verify**). Add connect and list timeouts of about 5 s,
  and report unreachable connectors truthfully (see M7).

**H8 — Tool outputs meant for the user are thrown away**
- Location: `agent/code.ts:200-243`. Charts and generated files go only to the model (≤4 images).
  SVG charts are withheld (`tool-result-images.ts:21`). `inspect_image` crops go only to the model.
- There is no artifact, attachment or download. The panel gets a 4k text head (`tool-detail.ts`).
- ChatGPT's defining data-analysis experience (a chart plus a downloadable CSV/XLSX) cannot happen here.
- Fix: a tool result can carry `artifacts` (the `ToolExecutionResult.artifacts` type already exists
  and is unused). Persist them as Attachments or Artifacts and stream them to the client as tool
  output parts.

### Medium

**M1 — Anthropic loses `server_tool_use.input` (the search query)**
- Location: `anthropic-round.ts:218-228` stores `server_tool_use` in `blockByIndex` at
  `content_block_start`, where `input` is `{}`. Its `input_json_delta` fragments look up
  `partial.get(index)`, find nothing, and are dropped (`:251-252`).
- The replayed block carries `input:{}`. When a `pause_turn` stops on a search that has not run yet
  (the case the code cites), the continuation sends an empty query (**verify** how the API treats it).
- The UI can never show "Searched for X". The test fixture never streams the query
  (`anthropic-round.test.ts:277,317`).
- Fix: treat `server_tool_use` like `tool_use`: accumulate its input, finalize at stop, and emit a
  `search` tool event with the query.

**M2 — Claude's inline citations are dropped, and every search hit becomes a "Visited source" row**
- `citations_delta` is not handled anywhere (`anthropic-round.ts:241-253`), so the text-to-source
  mapping is lost.
- Each `web_search_result` URL, up to 5×10 per request, becomes a "Visited source" activity row
  (`route.ts:3028-3040`), although nothing was visited.
- `WEB_SEARCH_NUDGE` (`prompt-sections.ts:12-13`) tells the model to "cite your sources", but the
  model does not know Juno's numbering, so any `[n]` it writes may point at the wrong source.
- Fix: build citations from `citations_delta` (Claude), `url_citation` annotations (OpenAI) and
  `groundingSupports` (Gemini) into the sources list. Separate "searched" rows from "read" rows.

**M3 — The budget guard is blind inside tool loops on 3 of the 4 adapters**
- Usage is emitted only at the end on Responses (`:500`), compat (`:615`) and Gemini (`:422`), versus
  every round on Anthropic.
- Every round re-sends the full context, so a 7-round loop over a 150k-token prompt is about 1M input
  tokens. `createStreamBudgetGuard` only projects from streamed text and reasoning characters until
  the final usage arrives.
- `route.ts:3019-3024` also skips the guard on tool results.
- Fix: yield cumulative usage after every round on every adapter, and check the budget before
  opening each round.

**M4 — The stall watchdog is not paused while a tool runs**
- It is paused only for approvals (`route.ts:2896-2900`).
- The code interpreter's timeout is 120 s (`code.ts:56`), equal to `PROVIDER_IDLE_TIMEOUT_MS`
  (`chat-stall.ts:22`). MCP calls can take up to 60 s, and slow connects add more.
- A legitimately long tool call is reported as "Model stopped responding" and the turn is aborted.
- Fix: pause the watchdog on dispatch (the `tool_call` effect) and resume on result. Enforce per-tool
  timeouts in the tool layer.

**M5 — Call ids do not match between providers, the broker and the UI, and the replay protection the comments promise does not exist**
- Responses (`:461`) and compat (`:569`) call `execute(name, args, signal)` without the provider
  `call_id`, so mcp.ts falls back to `${toolName}:${ordinal}` (`mcp.ts:468`).
- Gemini synthesizes a random id per attempt (`gemini.ts:304`). That directly contradicts the contract
  in `mcp.ts:211-216`: "a random value per attempt would defeat replay protection".
- The registry ignores `callId` and uses `crypto.randomUUID()` (`runtime.ts:92, 271-277`).
- Provider call ids are themselves fresh per response, so across a resumed durable generation (same
  `generationId`) no key is ever stable.
- Worse, the ordinal fallback can collide: on a resumed run, call #1 is `github__list_issues:1`. If its
  arguments differ from the previous attempt's call #1, the broker returns a **conflict**, and the
  model is told "The tool arguments changed after this approval was created."
- Fix: a Juno-owned `toolCallId` (for example `${generationId}:${round}:${index}`), used for the broker,
  the SSE rows and persistence, and mapped to and from each provider's id in the adapter. Base
  idempotency on args plus position, not on provider ids.

**M6 — MCP result handling**
- Location: `mcp.ts:269-282, 499-512`.
  - `res.isError === true` is ignored, so the call is reported `ok:true` and settled as executed.
  - `image`/`audio` content parts are `JSON.stringify`'d, so base64 floods the 30k budget and the
    model sees garbage instead of an image. They should map to `ToolResultImage`.
  - `structuredContent` and `resource_link` are ignored.
  - No injection scan, where Work uses `scanUntrusted` on connector output
    (`work/connectors.ts:763-817`).

**M7 — Unreachable connectors are dropped silently, and the UI says they are ready**
- `mcp.ts:389-391` swallows connect and list errors.
- The route still sends "Connected tools ready: GitHub · Notion" (`route.ts:2738-2743`), computed from
  `activeConnectors` before any connection was tried.
- The model's prompt never learns a connector is missing.
- Fix: report each connector's state (connected, N tools, failed with a reason) as a structured event
  and in the prompt.

**M8 — Approval fatigue, and meta-tools defeat classification**
- A read is `read_only` only when **both** `readOnlyHint:true` and a read-verb name agree
  (`action-approval.ts:218-220`). Unannotated servers get a card for every `list_*` or `search_*`.
- Composio's tool-router session (`composio.ts:1014`, `sessions.use(…, {mcp:true})`) is likely to
  expose meta-tools (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, **verify**). Their names
  carry no verb, so every call, searches included, needs approval. The real action is hidden inside
  the arguments, so the approval card cannot say what will happen.
- Parallel calls produce one blocking card at a time.
- Fix: batch approvals per round. Keep a per-connector "trust reads" standing grant. For meta-tools,
  unpack the inner tool slug for classification and preview.

**M9 — `browser_agent` is a stub that advertises abilities it does not have**
- Location: `agent/browser.ts:138-250`. The schema offers
  `navigate|read|click|type|scroll|screenshot|extract` plus a selector and text. Every action is the
  same GET (`:191-194`), and `https://google.com` is the default URL.
- Extraction is regex-based (`:66-110`): no content-type check (a PDF comes back as binary text), no
  JS rendering, and the 30 links it extracts are **not returned to the model** (`stdout` is the
  content only, `:226`). The model cannot follow links.
- It uses `AbortSignal.timeout(15000)` rather than the chat's signal (`:55`), so Stop does not cancel
  the fetch.
- It emits no `sources`, so pages it read never appear in citations.
- It duplicates `crawlResearchPage`.
- Fix: replace it with `web_fetch(url, {prompt?, max_chars?})` on the research crawler (PDF, headless
  fallback, readability, links list), return `{title, url, content, links}`, and emit it as a
  source. Offer a real browser agent separately if it is wanted.

**M10 — Malformed tool arguments silently become `{}` and the tool still runs**
- `safeToolInput` (`anthropic-round.ts:143-151`), Responses (`:455-460`) and compat (`:563-568`) all
  turn a parse error into `{}` and dispatch anyway. `read_document({})` becomes a full read. A write
  goes to approval with empty arguments.
- The model never learns its JSON was bad.
- Fix: return a structured tool error ("arguments were not valid JSON: …") without dispatching, and
  validate against the schema.

**M11 — Gemini forced round and malformed calls**
- Withholding declarations on the final round (`gemini-core.ts:375`) while the history holds
  `functionCall` parts invites `UNEXPECTED_TOOL_CALL`, which normalizes to "tool_calls" and shows
  "Tool call requested" with no answer (**verify**). Use `toolConfig.functionCallingConfig.mode:"NONE"`
  with the declarations kept.
- `MALFORMED_FUNCTION_CALL` is not retried, and it shows as a red "Stream ended unexpectedly"
  (`finish-reason.ts:57`, `gemini.ts:448-456`). Retry the round once.

**M12 — Gemini id and signature fidelity**
- `functionCall.id` is discarded (`gemini-round.ts:188-192`), and `functionResponse` carries no `id`
  (`:246-248`). The two are matched by order and name only, which is ambiguous for parallel calls to
  the same function.
- Error results go back as `{result: "Tool error…"}` rather than `{error: …}`.

**M13 — Google Search suggestions are never displayed (compliance)**
- `searchEntryPoint.renderedContent` is captured (`gemini-round.ts` `state.searchEntryPoint`) and only
  used in a log flag (`gemini.ts:275`).
- Google's "Grounding with Google Search" terms require the suggestions to be shown alongside
  grounded answers (**verify** current terms).
- Fix: forward it as a structured `search_suggestions` event.

**M14 — Gemini ≤2.5 with search on silently drops every function tool**
- `gemini-core.ts:377-379`. `start_task` checks for this (`route.ts:2239-2243`), but the document,
  image and code prompt nudges (`route.ts:2271-2279`) still tell the model it has `read_document` and
  the others. Connectors are still connected and billed for nothing.
- Fix: make "which tools actually reach the model" one computed set that the prompt, the UI and the
  adapter all read.

**M15 — xAI Live Search is probably deprecated (verify)**
- `openai-compat.ts:452-454` sends `search_parameters`.
- xAI announced the Live Search API's retirement in favour of server-side Agent Tools (`web_search`,
  `x_search`) on its Responses endpoint (**verify** the date and status).
- If it has been retired, Grok's web toggle either 400s or quietly does nothing, and the citation-count
  billing heuristic (`:611-613`) never fires.

**M16 — Parallel calls run one at a time**
- All four adapters loop `for (const call of calls) await execute(...)`.
- Read-only calls (searches, fetches, document reads) could run concurrently, with results kept in
  call order. Approvals should be batched per round.

**M17 — Round budget and "length" mislabelling**
- `MAX_TOOL_ROUNDS = 6` is copy-pasted four times (`anthropic.ts:194`, `openai-responses.ts:47`,
  `openai-compat.ts:172`, `gemini-core.ts:31`).
- Six rounds is small for browse-then-read-then-verify work. Competitors allow dozens of calls per
  turn with cost guards.
- When the budget runs out, the finish is reported as `length` ("Response hit the token limit · Use
  Continue") even though tokens were not the problem.
- Gemini alone gets up to 3×7 rounds through continuations.
- Fix: one loop with a configurable round and call budget (for example 20-40 calls), a time budget and
  a cost budget, plus a distinct finish reason (`tool_budget`).

**M18 — Answer text is glued together across rounds, and tool positions are lost**
- `stream-accumulator.ts:167` (`this.text += event.text`). A round-1 preamble ("Let me check.") and the
  round-2 answer are persisted as "Let me check.Here is…". No separator, no part boundary, no offset.
- The client cannot render tool calls inline where they happened. Everything goes to the side panel.
- Fix: message parts (H5), or at minimum a part break per round.

**M19 — Attachment-tool gating and reach**
- `read_document` turns on only if a FILE is attached to a **message** in the history window
  (`route.ts:2066`).
- Project-knowledge files are reachable by the tool's `projectId` scope (`attachments.ts:42`) but do
  not turn it on. A project chat with 40 reference PDFs and no per-message file never gets the reader.
- `conversationAttachments` takes the **oldest** 60 (`attachments.ts:25,52` `orderBy asc, take 60`), so
  in big projects the newest upload is unreachable.
- Fix: gate on "any readable file in scope". Order by newest, or page and search by name.

**M20 — Code interpreter scope**
- It is only attached when a file is present (`route.ts:2073`), so "plot y=sin(x)", "compute this
  IRR" or "simulate…" can never run code.
- It is stateless per call: a new sandbox every call, with files re-uploaded (up to 10, `code.ts:152`)
  and no kernel persistence.
- The chat signal is not forwarded (`code.ts:180-187`), so Stop does not cancel the run.
- `userId` and `sessionId` are passed to the adapter but not sent to the runner.

**M21 — Lockdown leaves tools attached**
- Lockdown blocks every broker call but does not remove connectors or runtime tools from the turn
  (`route.ts:2970-2976`, `route.ts:918-921`). The model burns rounds on refusals.
- Native web search still runs in lockdown. That is arguably in scope, since lockdown's copy says
  "every action".

**M22 — Failed tool results are not marked as errors**
- Anthropic `tool_result` never sets `is_error` (`anthropic.ts:429-445`).
- Gemini returns failures in `result`.
- Models then treat error strings as data.

**M23 — Compat call edge cases**
- Hosts that stream tool calls with no `id` lose them silently (`openai-compat-round.ts:75-77`).
  Synthesize an id instead.
- The image turn after `tool` messages (`openai-compat.ts:580-591`) puts a `user` message right after
  `tool`. Mistral is known to reject "Unexpected role 'user' after role 'tool'" (**verify**).
- The dynamic-context `system` message is spliced mid-conversation (`:296-305`), which some hosts
  reject (**verify**).

**M24 — There is no "supports function calling" capability flag**
- Tools are sent to every chat model. `agenticTools` (`models.ts:54`; false only for
  `/mistral-medium/`) gates only `start_task`, and MCP and registry tools still go to `mistral-medium`.
- Models with limited or no tool support (candidates to verify: `grok-4.20-multi-agent-0309`,
  `moonshot-v1-128k`, `deepseek-reasoner` depending on its alias) would 400 or ignore them.
- Fix: per-model `tools: {supported, parallel, maxTools, schemaDialect, reasoningReplay, forcedNone}`.

**M25 — Registry and native tools have no audit row**
- Only MCP calls write `ToolInvocation` (`mcp.ts:425-435`).
- Registry calls only leave approval receipts, and those currently end `superseded` because of C1.
  `start_task` logs to the console.

**M26 — Approvals are not persisted on the message**
- `ClientMessage.approvals` exists (`types/chat.ts:83-88`), but `serializers.ts` never fills it.
- The live card is replaced when `done` swaps in the server message, and it is gone on reload.
- The approval activity row ("X needs approval") is never updated to allowed, denied or expired.
  See `internal-tools-e2e-trace.md` RC-8.

**M27 — A failed toolset open removes every tool, but the prompt still promises them**
- `llm.ts:180-183` logs and continues with `toolset = undefined`. Native tools survive.
- The system prompt still carries the document, image and code nudges.

### Low

- **L1 — Dead code on the tool path** (listed in §2.G): `computer.ts` returns fake success on darwin,
  plus `swarm.ts`, `detectAutomaticEscalation`, `onEvent` emits, the `LlmEvent` approval type and
  `accessFor`. Remove them, or wire them up, before the redesign so nobody builds on them.
- **L2 — No interleaved thinking on manual-thinking Claude models** (Haiku, Sonnet and Opus 4.5): the
  `interleaved-thinking-2025-05-14` beta header is not sent (`anthropic.ts:298-303`).
- **L3 — Dangling pending rows**: Anthropic emits `tool.call` at `content_block_start`. If the round
  then ends on `max_tokens` (a truncated tool_use), no result ever closes the row. It shows "pending"
  live and "unfinished" after reload.
- **L4 — Private chats get zero function tools** (`llm.ts:164`: no `audit`, so no toolset). Even the
  read-only fetch is gone. Deliberate, but not stated in the UI.
- **L5 — Row titles read badly**: "Using Web Browser Agent", "Using Read document", "Using Run code"
  (`route.ts:395`, where `labelFor` returns the registry `name`). Search queries never appear.
- **L6 — Skill narrowing covers registry tools only**: connectors are not narrowed by a skill's
  `allowed-tools`, and the skill capability grant omits `code` (`route.ts:2139-2145`).
- **L7 — Description handling**: MCP descriptions get a `[Label] ` prefix and a 1024-char cut, and the
  schema's own `title` and `description` fields are not used. Registry tool descriptions (`browser`)
  overclaim.
- **L8 — Anthropic web search defaults**: `max_uses: 5`, no `user_location`, no
  `allowed_domains`/`blocked_domains`, and the tool version is `web_search_20250305` (newer versions
  and the `web_fetch` server tool exist, **verify**).
- **L9 — Gemini signature on an empty text part is dropped** (`gemini-round.ts:193`).
- **L10 — Tool-detail budget**: 32k chars per run with a 4k result head. After roughly 8 calls, every
  later row says "over_budget" and nothing else.

---

## 6. Tools a modern assistant has that Juno chat lacks

List only; the competitor reports cover how others build them. Items marked (exists in repo) already
have a backend somewhere in Juno.

**Information**
- `web_search` for **every** provider, model-invoked (exists in repo: multi-engine search).
- `web_fetch` / open URL, with PDF and headless support and follow-able links (exists in repo:
  research crawler, Work `web_fetch`).
- `find_in_page`.
- Automatic reading of URLs pasted into the message.
- Provider-native: Claude `web_fetch`, OpenAI Responses `web_search`, Gemini `url_context`, Google
  Maps grounding.
- News, weather, finance/stocks, sports, maps/places widgets (ChatGPT). Unit, time-zone and currency
  conversion (can be code).

**Files and knowledge**
- `search_project_files` / `file_search` over project knowledge and the library (retrieval exists in
  repo as a pre-step).
- `read_document` for project files (M19).
- `conversation_search` / "recall past chats" (exists in repo: `conversation-search.ts`).
- `memory_search`, plus `memory_save` / `memory_forget` as confirmed tools rather than text tags
  (Claude memory tool, ChatGPT memory).

**Computation and output**
- Code interpreter for any question, not only with attachments, with a persistent kernel.
- Downloadable file outputs (CSV/XLSX/PNG/PDF).
- A chart renderer.
- `create_document` / export to docx/pptx/xlsx/pdf (exists in repo: `office-export.ts`).

**Creation**
- `generate_image` / `edit_image` from inside the chat (exists in repo: `/api/generate`,
  `image-gen.ts`).
- Canvas as tools: `create_artifact`, `update_artifact` (patch), `read_artifact`, instead of
  `<juno:artifact>` markup. This gives structured edits and validation errors the model can react to.

**Action**
- `schedule_task` / reminders (exists in repo: `scheduled-tasks.ts`).
- `ask_user` (structured multiple-choice clarification mid-turn; exists in repo as the preflight
  wizard).
- `start_research` (deep research as a tool with plan approval).
- `update_plan` / todo for long turns.
- First-party mail, calendar and drive connectors with drafting.
- A real browser agent / computer use in a hosted VM.
- Sub-agents / parallel tasks (swarm is dead code).

**Platform**
- Tool search / deferred loading for large connector catalogs.
- Skill discovery and auto-invocation (Claude Skills).
- Remote MCP passthrough on providers that support it natively (OpenAI Responses `mcp`, Anthropic MCP
  connector), kept behind Juno's broker.
- Programmatic tool calling / code-mode.
- Streaming tool arguments to the UI.
- A per-call cost display.

---

## 7. Suggested target architecture

Input to the redesign, derived from the defects above.

1. **One tool registry, one definition type.** `{id, title, description, inputSchema (canonical JSON
   Schema/zod), outputKind, risk (first-party declared | connector-classified), concurrency:
   "parallel-safe"|"serial", timeoutMs, resultPolicy {maxChars, envelope:boolean, persist:
   "full"|"summary"|"none"}, ui {icon, verb, summary(args)}}`. Registry tools, native tools, MCP tools
   and provider-hosted tools all become instances of it. Provider-hosted ones are marked `hosted` and
   compiled to the provider's server-tool shape.
2. **One provider-neutral loop.** Adapters shrink to four functions: `compileTools(defs, model)`,
   `request(state)`, `parseStream → normalized events` (text, reasoning, tool_call_start / args_delta /
   end, hosted_tool, citation, usage, stop), and `appendRound(state, calls, results)`, which keeps
   reasoning, signatures and ids. The shared loop owns:
   - round, call, time and cost budgets;
   - parallel dispatch of parallel-safe calls;
   - batched approvals;
   - watchdog pause;
   - the forced final answer;
   - retries for malformed calls;
   - per-round usage.
3. **A Juno-owned call id** (`gen:round:idx`) used for the broker, the SSE, persistence and resume.
   It is mapped to provider ids in the adapter.
4. **Message parts as the source of truth.** Ordered `text | reasoning | tool_call | tool_result |
   citation | artifact | image` parts are persisted, replayed to models on later turns with
   compaction, and streamed to the client as typed SSE events (`part_start`, `part_delta`, `part_end`,
   `tool_status`), so the UI can render tool blocks inline.
5. **Search and fetch are always available, and the model decides.** Provider-native search where it
   exists, Juno's engine and crawler everywhere else. The toggle becomes a force or never override.
6. **Broker semantics.** First-party read tools are auto-allowed by exact rule. Sandboxed code is
   auto-allowed with notice. Connector reads that carry a hint are allowed. Unknown connector tools
   ask once per tool per conversation (a standing grant). Writes ask per call, batched per round. Cards
   are persisted on the message and resolve in place.
7. **Per-model tool capabilities** in the catalog (supported, parallel, maxTools, schema dialect,
   reasoning replay mode, hosted tools available, forced-none support). The capability probe verifies
   them live.
8. **Connector hygiene.** Cache `tools/list`, sort deterministically, cap the count with tool search,
   add timeouts, report per-connector status, handle `isError` and images, scan for injection.

---

## 8. Test coverage gaps

These are the tests to write before, or alongside, the rework.

- A registry tool executed through `authorizeExternalAction` under every policy (it would have caught
  C1), plus an assertion that `onApprovalRequest` is forwarded.
- Per adapter, against a fake stream: a full tool loop covering parallel calls, the forced round,
  abort mid-tool, and malformed args. Only `anthropic-round` and `openai-compat-round` pieces are
  covered today.
- Envelope invariant: every provider receives `UNTRUSTED_OPEN…CLOSE` for MCP results (H2).
- Schema compile: real-world MCP schemas (Notion, GitHub, a Composio sample) compiled for Gemini,
  Anthropic and OpenAI, with no forbidden keywords (H3).
- Deterministic tool order across two opens with shuffled connector latency (H7).
- `server_tool_use` with `input_json_delta` (M1); `citations_delta` (M2).
- Responses round replay that includes `message` items (H6); compat reasoning replay per provider (H4).
- Watchdog paused during a long tool (M4); per-round usage emitted by all adapters (M3).
- MCP `isError` and image content (M6).

---

## 9. To verify live before designing around it

| Claim | Why it matters | How to check |
|---|---|---|
| Gemini rejects `additionalProperties` / `$schema` in `parameters`, and accepts `parametersJsonSchema` | H3 | Enable the Notion connector on a Gemini 3.x turn |
| DeepSeek, Kimi and MiniMax require reasoning replay on tool-call messages in thinking mode | H4 | One 2-round tool turn per provider at non-zero effort |
| Responses 400s when a reasoning item loses its following `message` item | H6 | A GPT-5.3-codex turn with preamble plus a tool |
| xAI `search_parameters` status | M15 | One Grok turn with web search on. Look for citations and `server_side_tool_usage` |
| Composio tool-router tool names and annotations | M8 | `listTools` on a connected Composio app |
| Gemini behaviour when declarations are withheld but the history has calls | M11 | Force 6 tool rounds on Gemini |
| Mistral rejecting `user` after `tool` | M23 | `inspect_image` on a Mistral vision model (once C1 is fixed) |
| Current Anthropic server-tool versions (`web_search_2026…`, `web_fetch`, tool search) | L8, §6 | Anthropic docs, via the `claude-api` skill |
