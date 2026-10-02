# Tool calling, traced end to end: why it "doesn't work"

Internal audit for the chat rework (branch `web/tools-thinking-research`, base `d0997af2`, 2026-09-23).
Read-only diagnosis: no source file was changed. Two scratch probes were run against the
pure modules (appendix A); everything else is static tracing plus the unit-test run in §7.

---

## 0. TL;DR

The pipeline is well engineered at the wire level (block reassembly, usage folding, finish
reasons, resume/replay are all careful and tested). The complaint comes from five other places:

1. **Juno's own tools hang for 2 minutes and then fail.** Every call to `read_document`,
   `inspect_image`, `browser_agent` or `code_interpreter` is classified `unknown` by the approval
   broker. That means "ask" under every policy. But the runtime never forwards `onApprovalRequest`,
   so no approval card is ever shown. The tool loop polls the database until the 120 s stall
   watchdog aborts the turn with "Model stopped responding". This is the path a user hits most
   often: any turn with a file attached, an image on a vision model, or web on for Claude, Gemini
   or Grok. (§3, RC-1)
2. **Most models get no tools.** A normal turn carries no utility tool. At most it carries
   `start_task`. Web search exists only on Anthropic, Google and xAI: 11 of the 48 current chat
   models. Every OpenAI model, including the flagship GPT-6 line, and every other compat lab has
   the toggle greyed out. Juno's own multi-engine search is never exposed as a chat tool. (RC-2)
3. **Connector failures are silent.** A connector whose token fails, or whose MCP server doesn't
   answer, is dropped without a word. The panel has already said "Connected tools ready", and the
   model says "I don't have access to GitHub". (RC-3)
4. **Several provider paths fail at the second round.**
   - Gemini gets raw MCP JSON Schemas as `parameters`.
   - Pre-Gemini-3 models silently lose every function tool when search is on.
   - The compat adapter drops `reasoning_content` from the replayed assistant tool-call message,
     which DeepSeek and Kimi thinking modes document as required.
   - Gemini also gets connector output with its untrusted-content envelope stripped.
   (RC-4, RC-5, RC-7)
5. **Tool calls are nearly invisible and have no memory.**
   - A call is one row in a collapsed strip. It never shows a running state, and it carries a raw
     label such as `Using Web Browser Agent · browser_agent`.
   - Answer text from before and after a tool call is glued together: `Let me check.The answer…`.
   - Nothing about a call is kept in the model's history for the next turn.
   (RC-6, RC-8)

None of the 945 unit tests fail. All of them test pure helpers, and no test drives an adapter,
the broker and the route together. The e2e smoke provider bypasses `streamChat` entirely. (§7)

---

## 1. Direct answers to the brief's questions

**Does a normal chat turn (web off, no attachments) carry any tool?**
At most one: `start_task`, the hand-off to a background Work task. It requires all twelve
conditions in `chatTaskToolEnabled` (`src/lib/chat/task-tool.ts:158-175`): web client, not
private, not voice, not regenerate, a saved user message, no research, no canvas edit, kind
`chat`, `agenticTools`, function tools reach the model, the skill permits it, no lockdown, and the
plan has a Work model. There is no search, fetch, memory, image, canvas or calculator tool. With no
connector enabled, `chatRuntimeToolAllowlist` returns `[]` (`tool-policy.ts:78-85`), and
`streamChat` defaults to `NO_RUNTIME_TOOLS` (`llm.ts:176-179`). So yes: the model can almost never
call a tool unless the user flips something.

**Is web search provider-native everywhere?**
No. It is native on only three providers: `WEB_SEARCH_PROVIDERS = ["anthropic","google","xai"]`
(`src/lib/models.ts:204`).
- Anthropic: `web_search_20250305` with `max_uses: 5` (`anthropic.ts:278`).
- Gemini: `google_search` (`gemini-core.ts:377`).
- xAI: `search_parameters` Live Search (`openai-compat.ts:452-454`).

The OpenAI Responses adapter receives the flag as `_webSearch` and ignores it
(`openai-responses.ts:198`).

**What happens on a model without native search?**
The server forces `useWebSearch = false` (`route.ts:2099-2100`). That also removes `browser_agent`,
because the allowlist keys it off the same flag (`route.ts:2971-2974`). The composer disables the
toggle ("Not on this model", `composer.tsx:715-719, 2957-2963`), but the `/search` slash command
toggles the preference with no capability gate (`composer.tsx:1664-1673`). The result:
- no search tool;
- no fetch tool;
- no "Preparing web search" row;
- no web-search nudge.

The model answers from training data.

**Are tool errors surfaced or swallowed?**
Mixed.
- *Per-call errors* are surfaced. The row closes with `status: "failed"` and the model receives
  `Tool error: …`. They show only inside the collapsed panel, and the resting strip does not flag
  them (only `warning` events reach `run.note`).
- *Setup errors* are swallowed:
  - connector resolution (`mcp.ts:85-131`);
  - MCP connect or `listTools` (`mcp.ts:389-391`);
  - opening the whole toolset (`llm.ts:180-183`, `console.error` only).
- *Approval waits on runtime tools* surface as a misleading "Model stopped responding" (RC-1).

**Do tool calls show while streaming AND after reload?**
Yes, as activity rows persisted on `Message.activity`, but with gaps:
- A tool step is never marked running (`thought-process-model.tsx:690`).
- Approval cards vanish at `done`, even live, and never come back
  (`serializers.ts:156-197` has no `approvals`; `use-chat.ts:672` replaces the message).
- A turn that fails before any text persists no assistant row, so its tool rows disappear on
  reload (`route.ts:3383-3428`).
- `memoryReceipt` and `artifactVerification` are dropped by `serializeActivity`
  (`serializers.ts:72-113`), so they also vanish at `done`.

**Are ids and labels consistent between live and replayed state?**
Activity ids: yes. It is the same object, persisted from `activityLog`, and the resume path
replays logged frames by `seq`. Other fields are not consistent: see the matrix in §5.

**Does the approval card flow deadlock the stream?**
- *Connectors and `start_task`:* no. The wait is bounded by the 15-minute receipt TTL, the stall
  watchdog is paused (`route.ts:2896-2908`), and Stop aborts it.
- *Runtime tools:* effectively yes. There is no card and no watchdog pause, so the stall watchdog
  kills the turn at 120 s (RC-1).

---

## 2. The pipeline, stage by stage

```
composer (webSearch pref, connectors, attachments)
  └─ use-chat.ts:1302-1320  POST /api/chat  { webSearch, connectors, workHandoff: true, … }
       └─ route.ts
            ├─ 911-920   requestedConnectorIDs → getActiveConnectors()          (silent drop)
            ├─ 2057-2078 attachmentToolToggles {documents, images, code}
            ├─ 2099-2100 useWebSearch = toggle && plan && model.webSearch && workspace
            ├─ 2229-2247 taskToolOn = chatTaskToolEnabled(…)
            ├─ 2270-2284 system = compose(nudges for webSearch/document/image/code)
            ├─ 2738-2744 activity "Connected tools ready"                      (before connecting)
            ├─ 2896-2908 requestApproval → watchdog.pause() + SSE {type:"approval"}
            └─ 2947-3001 streamChat({ webSearch, connectors, allowedTools, audit{onApprovalRequest}, nativeTools })
                 └─ llm.ts:163-185 openUnifiedAgentToolset(connectors, ctx, allowedToolIds)
                      ├─ runtime.ts:221-229 openMcpToolset (only if connectors)   (mcp.ts:332-528)
                      ├─ runtime.ts:232-252 registry tools filtered by allowlist
                      └─ llm.ts:57-75 withNativeTools (start_task)
                 └─ provider-routing.ts: anthropic→native | google→gemini-native |
                                         openai(api:"responses"|pro)→responses | else→compat
                      adapter: request(tools) → parse deltas → yield tool{call} → toolset.execute
                               → yield tool{result} → append result → next round (≤6 + 1 forced)
            ├─ 3002-3042 for await ev: acc.apply(ev) → toolActivity.open/close → SSE activity
            ├─ 379-423  createToolActivity: ONE row per call; completed in place; re-sent
            ├─ 3095-3107 persistAssistantTurn({content, reasoning, reasoningParts})   (no tool parts)
            ├─ 3172-3179 Message.activity = encrypt(activityLog)
            └─ 3185-3198 SSE done { message: serializeMessage(row) }
  └─ use-chat.ts:556-577 activity → upsertActivity (replace in place)
     use-chat.ts:579-600 approval → message.approvals[]
     use-chat.ts:658-677 done → message replaced wholesale by server row
  └─ message-item.tsx:1249-1273 ActivityTimeline strip + ApprovalCard(s)
     activity-timeline.tsx:56-98 liveCopy ("Using X · fn")
     thought-process-model.tsx:345-525 buildRun / 541-750 buildSteps → thought-process-panel.tsx
```

### 2.1 Per-provider trace

**Anthropic** (`anthropic.ts`, `anthropic-round.ts`)

| Stage | Behaviour |
|---|---|
| Tools declared | Client tools with `input_schema`, plus a cache breakpoint on the last one (262-273). `web_search_20250305` server tool, `max_uses: 5` (278). |
| Tool choice | `auto`; `none` on the forced final round (341). |
| Call event emitted | At `content_block_start`, before arguments arrive; `args` is absent from the call (anthropic-round.ts:200-217). |
| Arguments | Attached to the result event (anthropic.ts:456). |
| `execute` callId | `call.id`, the provider id (421). |
| Result appended | `tool_result` with images inline. No `is_error` flag on failure (429-445). |
| Reasoning replay across rounds | Correct: thinking and redacted_thinking replayed by wire index (anthropic-round.ts:161-277). |
| Server-tool blocks | Replayed, but see RC-11: the `server_tool_use` input (the query) is never accumulated. |
| Rounds | 6 + 1 forced. `pause_turn` continues (411-414). |
| History from earlier turns | Assistant messages sent as plain text only (101-103). |

**OpenAI Responses** (`openai-responses.ts`): 7 models, the gpt-*-pro and codex snapshots

| Stage | Behaviour |
|---|---|
| Tools declared | Flat `function` tools with `strict: false` (236-247). **No `web_search` tool, even when requested (`_webSearch`, 198).** |
| Call event emitted | After the whole round finishes streaming, when the loop dispatches (454). |
| Arguments | On the call. |
| `execute` callId | **Not passed** (461), so the broker falls back to `${toolName}:${ordinal}`. |
| Reasoning replay | Correct: reasoning items with `encrypted_content` are replayed before their calls (329, 381, 448). |
| Rounds | 6 + 1 forced. Usage is emitted once at the end (500-510), so the budget guard is blind mid-turn. |

**OpenAI-compatible** (`openai-compat.ts`): 93 of 121 chat models. OpenAI GPT on
`/chat/completions`, xAI, DeepSeek, Mistral, Zhipu, Moonshot, Qwen, MiniMax, Meta, MiMo, LongCat.

| Stage | Behaviour |
|---|---|
| Tools declared | `toWireTools` (455). Web search only for xAI `search_parameters` (452-454). |
| Delta parsing | `accumulateToolCallDeltas`, keyed by id, then index (openai-compat-round.ts:40-72). Tested. |
| Call event emitted | After the round completes (562). |
| `execute` callId | **Not passed** (569). |
| Replayed assistant message | `{content, tool_calls}` only. **Reasoning is not echoed back** (553-557): see RC-5. |
| Rounds | 6 + 1 forced (`tool_choice: "none"`). |

**Gemini** (`gemini.ts`, `gemini-core.ts`, `gemini-round.ts`)

| Stage | Behaviour |
|---|---|
| Tools declared | `functionDeclarations` with raw `parameters` (gemini.ts:56-63). `google_search` rides every round. **Pre-Gemini-3 with search on: function tools are dropped** (gemini-core.ts:375-379). |
| Call event emitted | After the round (306-313). |
| `execute` callId | **A random `call_${Date.now()}_…` per call** (304), which breaks replay idempotency. |
| Result appended | `functionResponse { name, response: { result: exec.body } }`. **`body` is the envelope-stripped text** (319): see RC-7. |
| Thought signatures | Replayed (gemini-round.ts:187-192, 228-247). The `functionCall.id` is dropped (192). |

---

## 3. Root causes, ranked by user impact

### RC-1 (critical): runtime tools wait for an approval nobody can see, then the turn dies

**Symptom.** Attach a PDF and ask anything the model wants to verify, or turn web on for Claude,
Gemini or Grok and let it open a page. The strip shows `Using Read document · read_document`
(or `Using Web Browser Agent · browser_agent`), sits for about 2 minutes, then shows "Model
stopped responding". If the model wrote no preamble, the turn is not persisted, so on reload the
question has no answer at all.

**Evidence**

- **Always "ask".** `UnifiedAgentRegistry.executeToolCall` authorizes every registry tool through
  the broker (`src/lib/agent/runtime.ts:96-115`) with `connectorId: "juno_runtime"`.
  - It sends no `annotations` and no risk class. The tool's own `riskClass: "read_only"` is never
    consulted (`browser.ts:171`, `document.ts:221`, `image.ts:139`).
  - It sends no `onApprovalRequest`. `context.onApprovalRequest` is in scope and is not forwarded.
  - Its `callId` is a fresh `crypto.randomUUID()` (`runtime.ts:92`).

  Neither `classifyExternalAction` (`action-approval.ts:190-245`) nor `decideActionPolicy`
  (`action-approval.ts:258-284`) has a rule that treats these tools as reads.
  - There is no `JunoRules` entry for `juno_runtime:*` (`action-approval.ts:99-118`).
  - A read verb alone is not enough: `nameSaysRead && hintSaysRead` needs the missing hint
    (218-220).
  - The result is `unknown`, which `effectiveActionRisk` turns into `external_write` (250-252) and
    then `"ask"` (283).
  - Default policy: `ask_for_any_change` (`action-approval.ts:42`).

  **Probe output (appendix A.1): every runtime tool, under all five policies:**

  ```
  browser_agent    => unknown insufficient_metadata {"always_ask":"ask","ask_for_any_change":"ask","ask_for_important_actions":"ask","allow_selected_low_risk":"ask","block":"block"}
  read_document    => unknown insufficient_metadata {... all "ask" ...}
  inspect_image    => unknown insufficient_metadata {... all "ask" ...}
  code_interpreter => unknown insufficient_metadata {... all "ask" ...}
  ```

- **Invisible pending receipt.** In `authorizeExternalAction` (`action-approval-store.ts:449-452`),
  a pending receipt calls `request.onApprovalRequest?.(…)`. That is `undefined` here, so nothing is
  sent to the client. It then waits in `waitForDecision`, polling every 400 ms (`POLL_MS`, line 29),
  for up to `ACTION_APPROVAL_TTL_MS` = 15 min (`action-approval.ts:43`). The only side effect a
  person could see is an APNs push to the iOS app (`action-approval-store.ts:330-343`). The web
  client has no pending-approvals list: `/api/approvals` GET has no web caller.
- **Nothing pauses the watchdog.** Only `requestApproval` pauses it (`route.ts:2896-2908`), and
  that runs only for connector (`mcp.ts:479`) and `start_task` approvals. The watchdog fires after
  `PROVIDER_IDLE_TIMEOUT_MS` = 120 s (`chat-stall.ts:25`) and aborts. The abort resolves the wait
  as `superseded`, the tool returns "Action refused by policy: Generation stopped before approval.",
  and the next provider call throws on the aborted signal. The terminal state is `stalled`.
- **The code and docs assume the opposite.**
  - `tool-policy.ts:9` and `tests/unified-agent-runtime.test.ts:92,151` say "read_only, which the
    approval broker auto-allows".
  - `docs/JUNO.md:727-729` says "Both are read-only".
  - The test only asserts `accessFor() === "read"`, which is a different function that does read
    `riskClass` (`runtime.ts:261-269`).
- **The tools are pushed hardest exactly where they hang.**
  - `ATTACHED_DOCUMENT_NUDGE` tells the model to read or search before answering
    (`prompt-sections.ts:30-31`).
  - `documents` is true for any FILE anywhere in the history (`route.ts:2066`).

**Fix**

1. Give the broker the tool's own risk class. Either add exact rules for `juno_runtime:browser_agent`,
   `read_document` and `inspect_image` as `read_only`, and `code_interpreter` as whatever class the
   product wants to prompt for, or pass `riskClass` through a typed field instead of name
   heuristics.
2. Forward `onApprovalRequest: context.onApprovalRequest` and the provider `callId` into
   `authorizeExternalAction` from `executeToolCall`. This requires threading `callId` through
   `openUnifiedAgentToolset.execute` (`runtime.ts:271-277`).
3. Pause the stall watchdog for the duration of any tool dispatch, not only approvals (see RC-9).
4. Add an integration test: `openUnifiedAgentToolset([…], ctx, {allowedToolIds:["read_document"]})`
   → `execute()` against an in-memory broker port, asserting the call completes with no pending
   receipt under the default policy, and asserting a card event under `always_ask`.

---

### RC-2 (critical): most models have no tools, and web search is unavailable on every OpenAI model

**Symptom.** On GPT-6 Astra/Sol/Luna, GPT-5.6, GPT-5.4 mini/nano, every DeepSeek, Kimi, Qwen, GLM,
Mistral, MiniMax, Meta and MiMo model, the web toggle is greyed out. With it off, as it must be,
the turn has no tool beyond `start_task`. "Tool calling doesn't work" and "it can't browse" are the
same complaint here.

**Evidence**

- Catalog capability: `WEB_SEARCH_PROVIDERS = new Set(["anthropic","google","xai"])`
  (`models.ts:204`). Probe (appendix A.2): 121 chat models; `webSearch=false` on 84 compat and all
  7 Responses models. **Current: 48 chat models, 11 with search.**
- Responses adapter: the parameter is named `_webSearch` and never used (`openai-responses.ts:198`),
  although the Responses API has a hosted `web_search` tool. OpenAI chat models route through
  `/chat/completions` unless `api:"responses"` (`provider-routing.ts:19-21`), and that endpoint has
  no general web search tool.
- Allowlist coupling: `browser_agent` is attached only when `useWebSearch` is true
  (`tool-policy.ts:80`, `route.ts:2970-2976`). A non-search model therefore does not even get a
  page fetcher.
- Juno already runs a multi-engine search: `webSearch()` in `src/lib/web-search.ts:15-28`, backed
  by `lib/search/search-engine.ts` and used by deep research. It is never exposed as a chat
  function tool.
- The allowlist has four registry tools in total (`runtime.ts:23-40`). None is general purpose.

**Fix**

1. Add a Juno `web_search` function tool backed by `webSearch()`, and a real `web_fetch` tool
   (see RC-10). Offer them on every model whose native search is absent, gated by the same toggle
   or, better, on by default with the model deciding.
2. Route every OpenAI model through the Responses adapter. That unlocks hosted `web_search`
   (and file search, code interpreter and image generation later) and preserves reasoning across
   tool rounds, which `/chat/completions` cannot do.
3. Where a lab has native search in its compat dialect, map the toggle to it. These are
   provider-documented features; verify each live before relying on it:
   - Kimi `$web_search` built-in;
   - Qwen `enable_search`;
   - GLM `web_search` tool;
   - xAI server-side `web_search`/`x_search`, see RC-12.
4. Stop coupling the page reader to the search toggle. Fetching a URL the user pasted is not
   "web search".

---

### RC-3 (high): connectors that fail are dropped silently, after "Connected tools ready" is shown

**Symptom.** The user enables GitHub and asks about an issue. The panel lists "Tools: GitHub", and
the model replies that it has no access to GitHub.

**Evidence.** A connector can disappear at three points, none of which says so:

1. `getActiveConnectors` silently `continue`s past a connector that is not configured, has no
   `mcpUrl`, fails to decrypt, or whose token refresh fails (`mcp.ts:90-129`). The route never
   compares requested with active (`route.ts:911-920`).
2. `openMcpToolset` wraps connect plus `listTools` per connector in a `catch {}`: "Connector
   unreachable/unauthorized — skip it; the chat proceeds without it." (`mcp.ts:389-391`).
3. `streamChat` catches any failure to open the whole toolset, logs it, and continues with
   `toolset = undefined` (`llm.ts:180-183`). That also drops the attachment tools.

Meanwhile the route emits "Connected tools ready: GitHub · Linear" from the *requested and
resolved* list, before any connection is attempted (`route.ts:2738-2744`).

There is also no connect timeout beyond the MCP SDK default request timeout. A slow server holds
the first token, bounded only by the 300 s startup watchdog (`chat-stall.ts:46`).

**Fix.** `openMcpToolset` returns a per-connector status (`ready | auth_expired | unreachable |
misconfigured`) with a reason. Then:
- The route emits "Connected tools ready" only for `ready` connectors.
- It emits one `warning` row per failed connector, with a "Reconnect" action.
- It adds one line to the system prompt: "GitHub is linked but unavailable this turn", so the model
  explains rather than denies.
- Give connect and `listTools` a hard 10–15 s budget.

---

### RC-4 (high): Gemini tool rounds break on real MCP schemas; pre-Gemini-3 silently loses every function tool when search is on

**Evidence**

- `toGeminiFunctionDeclarations` passes `t.function.parameters` straight into
  `functionDeclarations[].parameters` (`gemini.ts:56-63`). For connectors, that is the raw MCP
  `inputSchema` (`mcp.ts:384`).
  - The team's own note: "Gemini rejects `additionalProperties`" (`task-tool.ts:74-77`), which is
    why `start_task` was hand-written without it.
  - MCP servers built with zod or JSON Schema commonly emit `$schema`, `additionalProperties` and
    `anyOf`.
  - Nothing sanitizes them (grep finds no `$schema`, `additionalProperties` or
    `parametersJsonSchema` handling in `src/lib`).
  - Expected effect: the whole Gemini request is rejected whenever a connector with such a schema
    is enabled. Verify live with GitHub or Notion enabled.
- `geminiToolsPayload` returns `searchTools` only, dropping every function declaration, when search
  is on and the model is pre-3 (`gemini-core.ts:375-379`). `start_task` knows this
  (`route.ts:2239-2243`). Connectors, `read_document` and `inspect_image` do not, and the document
  and image nudges are still in the prompt.
- The forced final round withholds declarations while history still contains `functionCall`
  parts (`gemini-core.ts:375`). `tool_config: {functionCallingConfig: {mode: "NONE"}}` with the
  declarations kept is the documented way. Verify that the current behaviour is accepted.

**Fix.** Send connector schemas through `parametersJsonSchema`, or a sanitizer that keeps
`type/properties/required/items/enum/description` and drops the rest. On pre-3 models with search
on, either drop search in favour of Juno's `web_search` tool (RC-2) or strip the tool nudges and
tell the user which tools are off.

---

### RC-5 (high, verify live): compat tool rounds drop the model's reasoning; thinking models on DeepSeek and Kimi are documented to reject that

**Evidence.** The replayed assistant turn is `{ role:"assistant", content: assistantText || null,
tool_calls }` (`openai-compat.ts:553-557`). Reasoning deltas are streamed to the UI (505-519) but
never kept for the replay.
- DeepSeek's thinking-mode docs (V3.2 and later) require `reasoning_content` to be passed back on
  assistant tool-call messages within the same turn.
- Moonshot's Kimi thinking models reject a missing one ("thinking is enabled but reasoning_content
  is missing in assistant tool call message").
- MiniMax M2 and later, and GLM "preserved thinking", degrade without it.

Affected current models: `deepseek-v4-pro`, `deepseek-flash`, `kimi-k3`, `glm-5.3`, `MiniMax-M3`
and the Qwen thinking line. Separately, GPT reasoning models on `/chat/completions` re-derive their
reasoning every round.

**Fix.** Keep a per-round `reasoningText` (and MiniMax's `reasoning_details`) and attach it to the
replayed assistant message for providers that document it. Add a replay test per provider in
`openai-compat-round`. Route OpenAI models through Responses (RC-2).

---

### RC-6 (high): a tool call leaves no trace in the conversation, and answer text is glued across rounds

**Evidence**

- Persistence: `persistAssistantTurn({content, reasoning, reasoningParts, …})`
  (`route.ts:3095-3107`). There is no tool-call or tool-result part; the call survives only as a
  UI activity row.
- History: every adapter turns an `ASSISTANT` row into plain text.
  - Anthropic: `{role, content: msg.content}` (`anthropic.ts:101-103`).
  - Compat: (`openai-compat.ts:87-90`).
  - Responses: (`openai-responses.ts:68-73`).
  - Gemini: (`gemini-core.ts:58`).

  A follow-up ("what did page 3 say?", "open the second result") forces the model to call again
  or to hallucinate. It also cannot know it already filed the Linear ticket.
- Concatenation: `GenerationAccumulator.apply` does `this.text += event.text` across rounds
  (`stream-accumulator.ts:164-169`). A preamble ("I'll look that up.") and the post-tool answer
  become one string with no separator. The client does the same (`use-chat.ts:640-645`).
- Placement: tool calls are never interleaved with text. The transcript cannot show "text → tool →
  text" the way Claude and ChatGPT do.

**Fix.** This is the core of the redesign. Store the assistant turn as ordered **parts**: `text`,
`reasoning`, `tool_call{id,name,args}`, `tool_result{id,ok,summary,body_ref}`, `source`,
`approval`.
- Stream them as part-level SSE events (`part.start/delta/end`).
- Render them inline.
- Rebuild provider-native history from them, with old tool results truncated or summarized, so the
  model remembers what it did.

---

### RC-7 (high, security): Gemini receives connector output without the untrusted-content envelope

`responseParts.push({ name, response: { result: withheldImagesNote(exec.body ?? exec.text, …) } })`
(`gemini.ts:319`). For MCP connectors, `body` is the envelope-free panel projection. The model
copy is `text = wrapUntrusted(label, body)` (`mcp.ts:293-300`). Anthropic, compat and Responses all
send `exec.text`.

On Gemini, the untrusted-content rule is in the system prompt (`route.ts:2201-2203`) but the
markers it reads are missing, so prompt-injection defence is off for every connector result.
Registry tools are unaffected, because their `text === body` already contains the envelope.

**Fix.** Use `exec.text`. Add an adapter-parity test that asserts every adapter hands the model
`exec.text`.

---

### RC-8 (medium): tool UX is nearly invisible and inconsistent

- **No running state.** Every tool step is built with `running: false`
  (`thought-process-model.tsx:690`), even while `tool.resultNote === "pending"`. The only running
  row is the generic phase row (733-746). Once any preamble text exists it says "Writing the
  answer" while a connector is still being waited on.
- **Raw labels.** The row title is `Using ${label}` and the detail is the function id
  (`route.ts:395-396`), for example "Using Web Browser Agent · browser_agent" or
  "Using GitHub · github__search_issues". The strip copies it verbatim
  (`activity-timeline.tsx:73-76`). There is no verb ("Searching GitHub issues for …"), no target,
  and no favicon.
- **Calls hide in the collapsed strip.** The resting strip says "3 tool calls". A failed call does
  not mark the strip, because only `kind:"warning"` feeds `run.note`
  (`thought-process-model.tsx:404-424`).
- **Approval rows never resolve, and the strip lies while waiting.** The approval row ("GitHub
  needs approval", `route.ts:2901-2906`) is never updated to allowed, denied or expired. Its title
  does not start with `Using `, so `buildRun` ignores it and the strip falls back to "Thinking…" /
  "Still thinking" while the turn is blocked on the person.
- **Approval cards vanish at completion.** `done` replaces the message with `serializeMessage(row)`
  (`use-chat.ts:668-677`), which has no `approvals` field (`serializers.ts:156-197`).
- **Chronology is lost.** `buildSteps` puts all reasoning parts first, then all calls
  (`thought-process-model.tsx:535-540, 622-694`), whatever the real order was. Once preamble text
  starts, `write` fires and the calls afterwards are still filed under Think.
- **Two routes to one tool, two shapes.** `start_task` rows are titled "Starting a task" and so are
  excluded from `calls` (406). The panel under-counts tool calls.

**Fix.** Tool calls become first-class parts (RC-6) with a lifecycle: `queued → awaiting_approval
→ running → ok | failed | denied | expired`. Each has a human label built from a per-tool
`present(args)` function, is rendered inline in the transcript, and shows its own spinner, duration
and failure state. The approval card is anchored to its own tool part and persisted with the
receipt state.

---

### RC-9 (medium): the stall watchdog treats a running tool as a silent provider

The watchdog is touched only by adapter events (`route.ts:3003`) and paused only for approvals.
- `code_interpreter` has `TIMEOUT_MS = 120_000` plus a 10 s transport margin (`code.ts:56`,
  `code-interpreter.ts:238`).
- `PROVIDER_IDLE_TIMEOUT_MS = 120_000` (`chat-stall.ts:25`).

A script that uses its full budget kills the turn as "Model stopped responding". Any slow connector
near 120 s does the same. The MCP SDK's own default request timeout (60 s) also bounds `callTool`,
with no product decision behind the number.

**Fix.** `watchdog.pause()` on `tool_call`, resume on `tool_result`, with a separate per-tool
timeout that is shown in the row.

---

### RC-10 (medium): `browser_agent` advertises actions it does not have

The schema offers `navigate | read | click | type | scroll | screenshot | extract`
(`browser.ts:139-171`). `execute` ignores `action` and fetches `params.url || "https://google.com"`
(`browser.ts:191`). A model that "clicks" or "types" receives the same page back and believes the
action happened. There is no search action, which is why models without native search could not
fall back to it even if it were attached.

**Fix.** Replace it with honest tools:
- `web_fetch(url)`: read and extract;
- `web_search(query)`: Juno multi-engine, see RC-2;
- later, a real browser tool behind the Work runtime, which already has `tests/work-browser.test.ts`.

---

### RC-11 (medium, verify live): Anthropic `server_tool_use` blocks are replayed with an empty input, and the query is never shown

`readAnthropicRound` stores `server_tool_use` at `content_block_start` with `input: {}`
(`anthropic-round.ts:218-230`) and creates no `partial` for it. The search query that streams in
afterwards as `input_json_delta` is therefore discarded (251-252 only appends to open partials).

The unit test fixtures never send that delta (`tests/anthropic-round.test.ts:277, 317`). Result:
- the replayed block (next tool round or `pause_turn`) carries `{}`;
- the UI never learns what Claude searched for, because native search emits only "Visited
  source" rows;
- `T_SEARCHING` rows come only from deep research.

**Fix.** Accumulate `input_json_delta` for server tool blocks too. Emit a `search` activity or part
with the query.

---

### RC-12 (medium, verify live): Grok web search uses the older Live Search body parameter

`params.search_parameters = { mode: "auto", return_citations: true }` (`openai-compat.ts:452-454`).
xAI has moved web and X search to server-side tools. If Live Search is retired or ignored on the
current Grok models, "Grok Live Search" is announced (`chat-responses.ts:28`) and nothing searches.
Check `webSearchRequests` and citations on a live `grok-4.7` call.

---

### RC-13 (medium): idempotency ids are not the provider's on three of four paths

| Path | callId handed to the broker | Consequence |
|---|---|---|
| Anthropic | Provider `tool_use.id` | Correct. |
| Compat | Omitted (`openai-compat.ts:569`) | Falls back to `${toolName}:${ordinal}`: stable only if order is stable. |
| Responses | Omitted (`openai-responses.ts:461`) | Same fallback. |
| Gemini | Random per attempt (`gemini.ts:304`) | Replay protection defeated. |
| Runtime tools | Random UUID (`runtime.ts:92`) | Replay protection defeated. |

`McpToolset.execute`'s own contract says "a random value per attempt would defeat replay
protection" (`mcp.ts:211-217`). The random paths create a new receipt row on every retry.

**Fix.**
- Pass `call_id` / `tool_call.id`.
- For Gemini, use `functionCall.id` when present, otherwise `${round}:${index}` hashed with the
  generation id.

---

### RC-14 (low–medium): smaller loop defects

- `MAX_TOOL_ROUNDS = 6` on every adapter (`anthropic.ts:194`, `openai-compat.ts:172`,
  `openai-responses.ts:47`, `gemini-core.ts:31`), and Claude web search `max_uses: 5`. Agentic
  search and read loops in Claude and ChatGPT routinely run 10–30 steps. When the cap hits, the
  turn is forced to answer and reports `length`.
- Malformed tool arguments become `{}` silently (`anthropic-round.ts:142-150`,
  `openai-compat.ts:563-568`, `openai-responses.ts:455-460`). The model is never told its JSON
  was invalid, so the tool is run with no arguments.
- Anthropic `tool_result` never sets `is_error: true` on failures (`anthropic.ts:429-445`).
- Parallel calls in one round run sequentially in every adapter.
- No per-model "accepts `tools`" flag exists. `agenticTools` gates only `start_task`
  (`route.ts:2238`), while attachment, connector and browser tools attach to every model. A model
  that rejects `tools` fails the whole turn whenever a file is attached.
- A turn that errors before any text (`persistsPartial` false) persists no assistant row
  (`route.ts:3383-3428`). Its tool rows are lost on reload, and the provider rounds it already
  consumed are refunded rather than recorded.
- The `/search` slash command toggles the preference without the `canWebSearch` gate
  (`composer.tsx:1664-1673`).
- `code_interpreter` output built from attached files is returned unwrapped
  (`code.ts:212-240`), unlike `read_document`.

---

## 4. Approval flow: can it deadlock?

| Caller | Card shown? | Watchdog paused? | Bounded by | Verdict |
|---|---|---|---|---|
| MCP connector (`mcp.ts:456-481`) | Yes (`onApprovalRequest` → `route.ts:2896` → SSE `approval`) | Yes | 15-min TTL, Stop | OK |
| `start_task` (`task-tool.ts`, via `requestApproval`) | Yes | Yes | TTL, Stop | OK |
| Runtime tools (`runtime.ts:97-115`) | **No** | **No** | Stall watchdog, 120 s | **Hangs, then fails** (RC-1) |

Other edges:
- Approval frames are logged (`stream-log.ts:45-47`), so a reconnect replays the card.
- If the frame log was disabled mid-turn, a reload shows no card while the server still waits for
  up to 15 min. There is no web pending-approvals surface to recover from, because
  `GET /api/approvals` has no web caller.
- Cards are removed at `done` (RC-8).

---

## 5. Live vs reload consistency matrix

| Datum | Live | After `done` (same session) | After reload |
|---|---|---|---|
| Activity row ids | Server id | Same | Same |
| Tool row `tool.resultNote` | `pending` | Final | `pending` rewritten to `unfinished` (tool-detail.ts:319): intended |
| Tool step "running" | Never (RC-8) | n/a | n/a |
| Approval cards | Shown | **Gone** | **Gone** |
| "X needs approval" row | Shown | Stale title | Stale title |
| `memoryReceipt` on "Remembered about you" | Shown | **Gone** (serializeActivity drops it, serializers.ts:72-113) | Gone |
| `artifactVerification` | Shown | **Gone** | Gone |
| Answer text around tool calls | Glued | Glued | Glued |
| Tool calls in model history next turn | n/a | n/a | **Absent** (RC-6) |
| Failed-before-text turn | Rows shown | Error card | **No assistant row; tool rows lost** |

---

## 6. What the redesign must change (ordered)

**P0: small, independent, unblock "it doesn't work" (about a day)**

1. RC-1: exact broker rules for `juno_runtime:*`; forward `onApprovalRequest` and `callId`; pause
   the watchdog around dispatch.
2. RC-7: Gemini sends `exec.text`.
3. RC-3: per-connector status, warning rows, honest "Connected tools ready".
4. RC-4: sanitize connector schemas for Gemini, or use `parametersJsonSchema`.
5. RC-13: pass provider call ids.

**P1: make tools exist and be seen**

6. RC-2: Juno `web_search` and `web_fetch` for every model without native search. Route OpenAI
   through Responses with hosted `web_search`. Map native search per lab.
7. RC-6 and RC-8: an ordered **parts** model for assistant turns (text, reasoning, tool_call,
   tool_result, approval, source), with part-level SSE, inline rendering, a tool lifecycle, human
   labels, and history reconstruction.
8. RC-5: reasoning replay on compat tool rounds.

**P2: breadth, the separate audit of Claude and ChatGPT tools**

9. More tools, each a registry `ToolDefinition` with a risk class, a `present(args)` label and a
   result renderer: memory read/write, image generation, canvas create/edit, conversation and
   project search, a calculator (or code), a date/time and timezone tool, and a URL-context reader.
   Raise the round cap to about 20, with a budget-based stop.

---

## 7. Test results

Command, per file: `cd juno-tools && npx tsx --test tests/<file>.test.ts`. The runner retried with
`NODE_OPTIONS=--conditions=react-server` on failure; no file needed it.

**75 files, 945 tests: 936 pass, 0 fail, 9 skipped.**
- 8 skipped in `work-browser`: "no Chromium is installed on this machine".
- 1 skipped in `research-inspector-db`: no `RESEARCH_TEST_DATABASE_URL`.

| File | Tests | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| action-approval-enforcement | 13 | 13 | 0 | 0 |
| action-approval | 12 | 12 | 0 | 0 |
| anthropic-round | 16 | 16 | 0 | 0 |
| anthropic-thinking | 10 | 10 | 0 | 0 |
| chat-client-state | 4 | 4 | 0 | 0 |
| chat-context-assembly | 24 | 24 | 0 | 0 |
| chat-responses | 10 | 10 | 0 | 0 |
| chat-skills | 13 | 13 | 0 | 0 |
| chat-sse | 9 | 9 | 0 | 0 |
| chat-stages | 19 | 19 | 0 | 0 |
| chat-stall | 12 | 12 | 0 | 0 |
| chat-stream-accumulator | 15 | 15 | 0 | 0 |
| chat-stream-log | 12 | 12 | 0 | 0 |
| chat-stream-resume | 15 | 15 | 0 | 0 |
| chat-task-tool | 27 | 27 | 0 | 0 |
| chat-terminal-state | 15 | 15 | 0 | 0 |
| chat-tool-detail | 24 | 24 | 0 | 0 |
| code-activity-persistence | 4 | 4 | 0 | 0 |
| event-streams | 16 | 16 | 0 | 0 |
| gemini-continuation | 13 | 13 | 0 | 0 |
| gemini-request | 10 | 10 | 0 | 0 |
| gemini-round | 11 | 11 | 0 | 0 |
| gemini | 7 | 7 | 0 | 0 |
| multi-agent-orchestration | 4 | 4 | 0 | 0 |
| openai-compat-round | 11 | 11 | 0 | 0 |
| openai-prompt-cache | 6 | 6 | 0 | 0 |
| realtime-voice-activity | 3 | 3 | 0 | 0 |
| run-receipt-tools | 38 | 38 | 0 | 0 |
| search-ssrf | 2 | 2 | 0 | 0 |
| tool-access | 7 | 7 | 0 | 0 |
| unified-agent-runtime | 11 | 11 | 0 | 0 |
| unified-search | 30 | 30 | 0 | 0 |
| work-agentic-models | 9 | 9 | 0 | 0 |
| work-approval-modes | 22 | 22 | 0 | 0 |
| work-approval-plane | 8 | 8 | 0 | 0 |
| work-in-chat | 24 | 24 | 0 | 0 |
| work-tools | 27 | 27 | 0 | 0 |
| code-interpreter | 6 | 6 | 0 | 0 |
| connector-result-truncation | 9 | 9 | 0 | 0 |
| connectors-lifecycle | 2 | 2 | 0 | 0 |
| document-reading | 11 | 11 | 0 | 0 |
| message-append | 8 | 8 | 0 | 0 |
| work-browser | 25 | 17 | 0 | 8 |
| work-connectors | 27 | 27 | 0 | 0 |
| deep-research-adapter | 7 | 7 | 0 | 0 |
| work-approval-digest | 3 | 3 | 0 | 0 |
| work-timeline-attribution | 3 | 3 | 0 | 0 |
| design-panels | 8 | 8 | 0 | 0 |
| bubble-editor | 3 | 3 | 0 | 0 |
| split-layout | 4 | 4 | 0 | 0 |
| memory-forget | 28 | 28 | 0 | 0 |
| chat-admission | 10 | 10 | 0 | 0 |
| chat-first-submission | 8 | 8 | 0 | 0 |
| chat-submission-recovery | 12 | 12 | 0 | 0 |
| chat-usage | 8 | 8 | 0 | 0 |
| chat-origin | 7 | 7 | 0 | 0 |
| chat-budget-guard | 12 | 12 | 0 | 0 |
| chat-moderation | 3 | 3 | 0 | 0 |
| chat-artifact-verification | 3 | 3 | 0 | 0 |
| gemini-network | 7 | 7 | 0 | 0 |
| gemini-thinking-budget | 11 | 11 | 0 | 0 |
| research-run | 45 | 45 | 0 | 0 |
| research-agents | 30 | 30 | 0 | 0 |
| research-auto-effort | 4 | 4 | 0 | 0 |
| research-citations | 27 | 27 | 0 | 0 |
| research-corpus | 2 | 2 | 0 | 0 |
| research-plan-format | 8 | 8 | 0 | 0 |
| research-run-clock | 6 | 6 | 0 | 0 |
| research-worker | 5 | 5 | 0 | 0 |
| research-inspector-db | 1 | 0 | 0 | 1 |
| research-crawler | 8 | 8 | 0 | 0 |
| agent-proxy | 14 | 14 | 0 | 0 |
| search-fusion | 41 | 41 | 0 | 0 |
| conversation-search | 12 | 12 | 0 | 0 |
| backup-tools | 4 | 4 | 0 | 0 |

**Why a green suite missed every root cause above**

- Each test targets one pure seam: round reassembly, usage folding, allowlist arithmetic,
  classifier rules, SSE framing.
- No test runs `openUnifiedAgentToolset().execute()` through `authorizeExternalAction`. The only
  runtime test asserts `accessFor()`, a different function from what the broker reads.
- No test runs a full adapter tool round against a fake provider stream. `streamAnthropic`,
  `streamOpenAICompat`, `streamOpenAIResponses` and `streamGemini` are all `server-only`, and only
  their pure halves are tested.
- `anthropic-round` fixtures omit `input_json_delta` for `server_tool_use`.
- There is no adapter-parity test ("every adapter hands the model `exec.text`").
- The Playwright suite (`e2e/*.spec.ts`) never exercises a tool. The deterministic smoke provider
  replaces `streamChat` wholesale (`route.ts:2943-2946`).

**Tests the rework should add**

1. A broker integration test with an in-memory port: runtime tool, default policy, completes with
   no card.
2. A fake-stream harness per adapter: a tool round, then replay, checking the reasoning and callId
   carried forward.
3. Adapter parity: envelope, callId, and error flag.
4. Gemini schema sanitization.
5. Connector failure produces a warning row.
6. A parts-model round trip: live SSE, then persisted, then reloaded, then provider history.

---

## Appendix A: probes (scratch only, not committed)

**A.1: broker classification of the runtime tools** (`classifyExternalAction` and
`decideActionPolicy`, imported from `src/lib/action-approval.ts`):

```
browser_agent {"action":"read","url":"https://example.com","reason":"check"} => unknown insufficient_metadata {"always_ask":"ask","ask_for_any_change":"ask","ask_for_important_actions":"ask","allow_selected_low_risk":"ask","block":"block"}
browser_agent {"action":"navigate","url":"https://example.com"} => unknown insufficient_metadata {… same …}
read_document {"attachment":"report.pdf","query":"revenue"} => unknown insufficient_metadata {… same …}
read_document {"document":"x","pages":"1-3"} => unknown insufficient_metadata {… same …}
inspect_image {"image":"a.png","region":{…}} => unknown insufficient_metadata {… same …}
code_interpreter {"code":"print(1)"} => unknown insufficient_metadata {… same …}
```

**A.2: catalog routing and search** (`MODEL_LIST` × `providerAdapterFor`):

```
total chat models 121 { anthropic-native: 12, openai-compatible: 93, openai-responses: 7, gemini-native: 9 }
webSearch by adapter: anthropic 12/12, gemini 9/9, compat 9/93 (xAI only), responses 0/7
current chat total 48, with search 11
current w/o native search: gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-terra, gpt-5.5-pro, gpt-5.4-mini,
  gpt-5.4-nano, gpt-5.3-codex, muse-spark-1.3(+contributor), glm-5.3, glm-4.7-flash(x), glm-4.6v-flash(x),
  kimi-k3, kimi-k2.7-code(+highspeed), deepseek-flash, deepseek-v4-pro, mistral-* (7), MiniMax-M3,
  MiniMax-M2.7-highspeed, mimo-* (4), qwen3.8-max, qwen3.7-plus, qwen3.8-flash, qwen-long
non-agentic: mistral:mistral-medium-latest
```

## Appendix B: items that need a live call to confirm

These are provider-behaviour claims taken from provider documentation, not reproduced here:

- RC-4: Gemini's rejection of `$schema` / `additionalProperties` in `parameters`, and whether
  dropping declarations on the forced final round is accepted.
- RC-5: `reasoning_content` echo requirements on the current DeepSeek, Kimi, GLM and MiniMax
  models.
- RC-11: that `server_tool_use` input arrives as `input_json_delta`.
- RC-12: whether xAI Live Search still works on current Grok models.

RC-1, RC-2, RC-3, RC-6, RC-7, RC-8, RC-9, RC-10 and RC-13 are established from the code alone.
RC-1 and RC-2 are additionally confirmed by the probes in appendix A.
