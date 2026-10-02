# Gap audit: provider tool capabilities

Follow-up to `internal-tools-e2e-trace.md` (RC-2, RC-4, RC-5, RC-11, RC-12, RC-13, appendix A.2/B) and
`internal-tools-backend.md` (§3, H3, H4, H6, M11, M15, M23, M24, §9). It resolves the provider behaviours
those audits left as "verify live" and gives the per-model tool capability matrix that the adapter
design (DECISIONS T1, T3, T5) depends on.

- Worktree `juno-tools`, branch `web/tools-thinking-research`. Read-only research; only this file was
  written. No paid or live provider call was made. Every item the documentation leaves open carries a
  minimal probe in §5, marked **needs live probe**, and was not run.
- All pages were read on **2026-09-23**. Where a page shows its own date, it is given.
- Source tags:
  - **[Docs]**: the provider's official documentation or API reference.
  - **[Changelog]**: the provider's release notes or migration notices.
  - **[3P]**: third-party issue trackers or community threads that quote a provider error verbatim.
  - **[Unverified]**: inference, or an item no source settles.
- Anthropic items come from the `claude-api` skill (bundled reference, cached 2026-06-24) and were
  re-checked against platform.claude.com on 2026-09-23.

---

## 0. What changes the plan

These are the findings that alter the plan, most severe first.

1. **GPT-6 and GPT-5.6 cannot call tools on `/chat/completions` at any effort other than "none".**
   - Only the Responses-routed models escape this (gpt-5.5-pro and gpt-5.3-codex).
   - OpenAI's GPT-6 guide says Astra "supports Chat Completions, but its tool calling requires
     Responses", and that Sol and Luna support function calling there "only with
     `reasoning_effort: "none"`" [Docs, Sep 2026].
   - The same restriction hits the GPT-5.6 family, gpt-5.6-terra included. The exact error text is
     reported publicly [3P, Jul–Sep 2026].
   - Juno routes gpt-6-astra/sol/luna and gpt-5.6-terra through `/chat/completions`
     (`provider-routing.ts:19-24`). It also attaches `start_task` on most saved chat turns
     (`route.ts:2229-2247`).
   - The likely result: most tooled turns on these models return a 400 at any effort except
     Instant. This is a probable new root cause beyond RC-2. Confirm it with probe P10.
   - Consequence: routing **every** OpenAI model through Responses (RC-2 fix 2) is not an
     optimisation. It is required.
2. **Grok web search is a hard failure, not a silent no-op.**
   - xAI retired Live Search (`search_parameters`) on **12 Jan 2026** [3P, Dec 2025 announcement].
   - Since then `/v1/chat/completions` returns **HTTP 410** with "Live search is deprecated. Please
     switch to the Agent Tools API" [3P, Feb 2026].
   - xAI's docs now list Chat Completions as a deprecated endpoint with "function calling only" and
     no reasoning content [Docs, Sep 2026].
   - With T4 (web on by default), every Grok turn would fail. RC-12 must land before T4.
3. **`grok-4.20-multi-agent-0309` does not work on Chat Completions at all.** It also accepts no
   client-side function tools [Docs, multi-agent guide]. Juno sends it both, so the model is
   broken in chat today.
4. **Reasoning replay is a hard 400 on three compat labs, not a quality nicety.**
   - **DeepSeek**:
     - Thinking is on by default for both current models, **deepseek-flash included**, which the
       catalog marks `reasoning:false` (`models.ts`).
     - When a request carries `tools`, the `reasoning_content` of all earlier turns "must be fully
       passed back … even for turns where the model did not perform a tool call", or the API
       returns 400 [Docs].
   - **MiMo**: `reasoning_content` must be passed back on assistant tool-call messages, or the API
     returns 400 [Docs].
   - **Kimi K2.5/K2.6**: 400 with "thinking is enabled but reasoning_content is missing in assistant
     tool call message at index N" [3P, 2026]. For K3 and K2.7 Code the docs say to return the
     message unchanged; whether they enforce it needs a live probe.
5. **`tool_choice:"none"` (T5's forced final round) is rejected or unsupported on some labs.**
   - Meta Muse Spark returns HTTP 400 for anything but `"auto"` [Docs].
   - Z.ai documents `tool_choice` as "only supports `auto`" [Docs].
   - MiniMax's chat schema has no `tool_choice` field [Docs].
   - The final round needs a per-adapter mechanism, not one flag.
6. **Gemini, confirmed from the API reference:**
   - `parameters` is "a select subset of an OpenAPI 3.0 schema object". The subset has no
     `additionalProperties`, `$schema`, `$ref`, `oneOf`, `allOf` or `const`.
   - `parametersJsonSchema` exists, takes real JSON Schema, and is mutually exclusive with
     `parameters`.
   - `functionCallingConfig.mode: NONE` behaves "same as when not passing any function
     declarations".
   - `UNEXPECTED_TOOL_CALL` means "Model generated a tool call but no tools were enabled in the
     request".
   - `FunctionCall.id` must be echoed in `FunctionResponse.id`.
   - All three current Gemini models are 3.x, so the pre-Gemini-3 drop no longer affects a current
     model [Docs, Sep 2026].
7. **Gemini's terms require the Search Suggestions to be displayed with the grounded answer**
   [Docs, terms updated 2026-04-28]. The same terms forbid using grounding Links "to identify
   destination pages for crawling or scraping". That limits feeding Gemini grounding URLs into
   Juno's `web_fetch` or Research crawler.
8. **Anthropic.**
   - Confirmed:
     - `server_tool_use` input streams as `input_json_delta`.
     - The current tool versions are `web_search_20260318` and `web_fetch_20260318`.
     - Dynamic filtering needs no declared code-execution tool.
     - Forced `tool_choice` (`any`/`tool`) returns 400 on Opus 5.5 and Fable 5.1.
     - Interleaved thinking on Haiku 4.5 is unsupported (the beta header is ignored).
   - Anthropic introduced one new constraint: when Claude calls a server tool and a client tool in
     the same batch, the follow-up user message must contain **only** `tool_result` blocks. A
     trailing text note (T5's "answer from what you have") then returns a 400.

---

## 1. The current catalog (48 callable chat models)

Computed with `MODEL_LIST` × `providerAdapterFor` (scratch script run through `tsx`, nothing
committed). The result is 49 current chat models. One of them, LongCat-2.0, is `comingSoon`, which
leaves 48 callable.

| Lab | Current models (provider id) | Adapter today |
|---|---|---|
| Anthropic (4) | `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5` | anthropic-native |
| OpenAI (8) | `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.4-mini`, `gpt-5.4-nano` | **openai-compatible** (`/chat/completions`) |
| | `gpt-5.5-pro`, `gpt-5.3-codex` | openai-responses |
| Google (3) | `gemini-3.8-flash`, `gemini-3.1-pro-preview`, `gemini-3.5-flash-lite` | gemini-native |
| xAI (4) | `grok-4.7`, `grok-4.1-fast`, `grok-build-0.1`, `grok-4.20-multi-agent-0309` | openai-compatible (+ `search_parameters`) |
| DeepSeek (2) | `deepseek-v4-pro`, `deepseek-flash` | openai-compatible |
| Moonshot (3) | `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed` | openai-compatible |
| Zhipu (5) | `glm-5.3`, `glm-4.7-flash`, `glm-4.7-flashx`, `glm-4.6v-flash`, `glm-4.6v-flashx` | openai-compatible |
| MiniMax (2) | `MiniMax-M3`, `MiniMax-M2.7-highspeed` | openai-compatible |
| Mistral (7) | `mistral-medium-latest` (agenticTools:false), `mistral-large-latest`, `mistral-small-latest`, `codestral-latest`, `ministral-14b/8b/3b-latest` | openai-compatible |
| Meta (2) | `muse-spark-1.3`, `muse-spark-1.3-contributor` | openai-compatible |
| MiMo (4) | `mimo-v2.6-pro`, `mimo-v2.6-pro-ultraspeed`, `mimo-v2.6-flash`, `mimo-v2.5` | openai-compatible |
| Qwen (4) | `qwen3.8-max`, `qwen3.7-plus`, `qwen3.8-flash`, `qwen-long` | openai-compatible |
| LongCat (1, coming soon) | `LongCat-2.0` | openai-compatible |

Search today is on 11 of the 48: 4 Anthropic, 3 Gemini and 4 xAI. The 4 xAI entries are the 410
path described in §0.

Two catalog facts the matrix depends on:

- **`grok-4.1-fast` has no xAI model page (404).** It is not on the pricing page either.
  xAI retired the `grok-4-1-fast-*` slugs on 15 May 2026 and redirects them to `grok-4.3`
  [Changelog]. Whether `grok-4.1-fast` resolves, and to what, needs live probe P14.
- **`deepseek-flash` is marked `reasoning:false`.** DeepSeek's own docs say thinking is enabled
  by default on both `deepseek-flash` and `deepseek-v4-pro` [Docs]. Juno never sends
  `reasoning_effort:"none"` or `thinking:{type:"disabled"}` to DeepSeek
  (`openai-compat.ts:227-240`), so these turns always think.

---

## 2. Per-model capability matrix

Legend:

- **Tools**: whether the model accepts function tools *on Juno's current transport*. Where
  the target transport differs, it is named.
- **Forced none**: whether the final round's "no tools" request works.
- **Replay**: what must go back on assistant tool-call messages in thinking mode.
  - **MUST-400**: documented 400 if missing.
  - **SHOULD**: documented quality loss.
  - **n/a**: nothing to replay.
- **Native search**: the lab's built-in search that Juno could map the web toggle to, with its
  price.
- **Max tools**: the documented cap per request.
- **N/D**: not documented.

### 2.1 Anthropic (adapter: anthropic-native, keep)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `claude-fable-5-1` | Yes. `tool_choice` `any`/`tool` → **400** [Docs] | Yes, default. All results go in one user message [Docs] | `tool_choice:{type:"none"}` OK, tools kept [Docs] | JSON Schema; `strict:true` needs `additionalProperties:false` + `required` [Docs] | Thinking blocks back unchanged in-turn. "Preserved thinking": blocks are bound to model and conversation; editing the prefix (system, tools, earlier messages) invalidates them [Docs] | `web_search_20260318` (dynamic filtering + `response_inclusion`), $10/1k searches; `web_fetch_20260318`, free (tokens only) [Docs] | No hard cap documented [Unverified]. ≤10,000 `defer_loading` tools with tool search [Docs] | 2026-09 |
| `claude-opus-5-5` | Yes. `any`/`tool` → **400** [Docs] | Yes | none OK | same | same as Fable 5.1 [Docs] | `web_search_20260318` shown on opus-5-5 in the docs, $10/1k. `web_fetch_20260318`: the web-fetch page's dynamic-filtering list omits Opus 5/5.5 → **needs live probe (P15)** | same | 2026-09 |
| `claude-sonnet-5` | Yes. Forced tool use allowed [Docs] | Yes | none OK | same | Thinking blocks back unchanged | `web_search_20260318`, `web_fetch_20260318` [Docs] | same | 2026-09 |
| `claude-haiku-4-5` | Yes. With manual thinking only `auto`/`none` [Docs] | Yes | none OK | same | Thinking blocks back unchanged. **No interleaved thinking**: header ignored [Docs] | Basic only: `web_search_20250305` ($10/1k), `web_fetch_20250910`. Newer versions need `allowed_callers:["direct"]` (no programmatic tool calling) [Docs] | same | 2026-09 |

### 2.2 OpenAI (target adapter: **openai-responses for all**)

| Model | Tools on Chat Completions | Tools on Responses | Parallel | Forced none | Schema | Replay (Responses, `store:false`) | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|---|
| `gpt-6-astra` | **No.** "Tool calling requires Responses" [Docs]. Effort `none` → 400 [Docs] | Yes; plus web search, file search, code interpreter, shell, computer use, MCP, `tool_search` [Docs] | Yes. Built-in tools are never in a parallel function batch [Docs] | `tool_choice:"none"` [Docs] | JSON Schema; `strict` optional; namespaces [Docs] | Reasoning items carry `encrypted_content` by default in stateless mode. Replay every output item; keep assistant `phase` (`commentary`/`final_answer`) [Docs] | Hosted `web_search` $10/1k calls + search content tokens [Docs] | 128 (`array_above_max_length`) [3P] | 2026-09 |
| `gpt-6-sol` | **Only with `reasoning_effort:"none"`** [Docs] | Yes, same tool set incl. `tool_search` [Docs] | Yes | none | same | same | same | 128 [3P] | 2026-09 |
| `gpt-6-luna` | Only with effort `none` [Docs] | Yes, same | Yes | none | same | same | same | 128 [3P] | 2026-09 |
| `gpt-5.6-terra` | **Function tools + reasoning → 400**: "Function tools with reasoning_effort are not supported for gpt-5.6-… in /v1/chat/completions" [3P]. Model page silent [Docs] | Yes; `reasoning.context:"all_turns"` default on the 5.6 family [Docs] | Yes | none | same | same, plus cross-turn reasoning replay | same | 128 [3P] | 2026-07..09 |
| `gpt-5.5-pro` | Not served (Responses and Batch only) [Docs] | Yes: function, web search, file search, image gen, code interpreter, shell, MCP. **No** `tool_search` [Docs] | Yes | none | same | same; `phase` recommended for 5.5 [Docs] | same | 128 [3P] | 2026-09 |
| `gpt-5.4-mini` | Yes. No restriction documented; 3P says ≤5.4 unaffected [3P] | Yes, incl. `tool_search` [Docs] | Yes | none | same | same | same | 128 [3P] | 2026-09 |
| `gpt-5.4-nano` | Yes, same | Yes. No `tool_search`, no computer use listed [Docs] | Yes | none | same | same | same | 128 [3P] | 2026-09 |
| `gpt-5.3-codex` | Not served (Responses only) [Docs] | Function, web search, shell, skills [Docs] | Yes | none | same | same | same | 128 [3P] | 2026-09 |

On Chat Completions the only search path is `gpt-5-search-api`, which always searches and returns
no source lists. The `gpt-4o-*-search-preview` models shut down on 2026-07-23 [Docs]. No current
catalog model can search on Chat Completions.

### 2.3 Google Gemini (adapter: gemini-native, keep)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `gemini-3.8-flash` | Yes; plus built-ins `google_search`, `url_context`, `code_execution`, maps, file search, `mcpServers` [Docs] | Yes [Docs] | `toolConfig.functionCallingConfig.mode:"NONE"`, "same as when not passing any function declarations" [Docs] | `parameters`: OpenAPI 3.0 subset. `parametersJsonSchema`: JSON Schema, mutually exclusive with `parameters` (details §3.1) [Docs] | `thoughtSignature` on every part, required on Gemini 3 (`MISSING_THOUGHT_SIGNATURE` finish reason exists). `functionResponse.id` = `functionCall.id` [Docs] | `google_search`: 5,000 free queries/month shared across Gemini 3, then **$14/1k queries**. `url_context` and `code_execution`: no tool fee, tokens only [Docs] | 128 per Vertex/Firebase [Docs]; API error text says 512 [3P]; guide recommends 10–20 active [Docs] | 2026-09-17..23 |
| `gemini-3.1-pro-preview` | Yes (also a `-customtools` endpoint) [Docs] | Yes | same | same | same | same | same | same |
| `gemini-3.5-flash-lite` | Yes | Yes | same | same | same | same | same | same |

Combining a built-in tool with function declarations is **Preview, Gemini 3 only** [Docs]. When
tool-context circulation is on, the docs say to default to `VALIDATED` mode because `AUTO` "is not
supported". On generateContent the switch is `toolConfig.includeServerSideToolInvocations`, and the
server-side `toolCall`/`toolResponse` parts must then be echoed back [Docs]. Whether Juno's current
combo request (built-in + declarations, no flag, `AUTO`) is honoured needs live probe P3.

### 2.4 xAI (target adapter: Responses at `api.x.ai/v1/responses`)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `grok-4.7` | Function calling on Chat Completions (legacy) and Responses. Server-side tools **only on Responses** [Docs] | Yes, default; `parallel_tool_calls:false` to disable [Docs] | `auto`/`required`/`none`/named [Docs] | Root must be `type:"object"`; a root `anyOf`/`oneOf` of objects is allowed [Docs] | Responses: `reasoning.encrypted_content` is **always** returned for grok-4.7 → replay. Chat Completions returns no reasoning [Docs] | `web_search` **$5/1k**. `x_search` **$5/1k posts, $10/1k profiles** (per item since 2026-09-21). Usage in `server_side_tool_usage` / `web_search_call` items [Docs] | **350** [Docs] | 2026-09-21 |
| `grok-4.1-fast` | Slug undocumented (404). The retired `grok-4-1-fast-*` redirect to `grok-4.3` [Changelog] → **needs live probe (P14)** | – | – | – | – | – | – | 2026-05/09 |
| `grok-build-0.1` | "Function calling: Yes" [Docs]. Server-side search support not stated → **needs live probe (P13)** | Yes | same | same | same | (if supported) same | 350 | 2026-09 |
| `grok-4.20-multi-agent-0309` | **Chat Completions not supported; client-side function tools not supported** (multi-agent guide) [Docs]. Its model page says "Function calling: Yes" → conflict, **needs live probe (P13)** | n/a | n/a | n/a | Encrypted sub-agent state only with the SDK's `use_encrypted_content` [Docs] | Built-in `web_search`/`x_search` and remote MCP supported [Docs] | – | 2026-09 |

### 2.5 DeepSeek (adapter: openai-compatible)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `deepseek-v4-pro` | Yes, in thinking and non-thinking mode [Docs] | Multiple `tool_calls` per message in the samples; no `parallel_tool_calls` parameter documented [Docs] | `none`/`auto` OK. `required`/named → **400 in thinking mode** [Docs] | Standard. `strict` (beta, `/beta` base) subset: every property required, `additionalProperties:false`; string `minLength`/`maxLength` unsupported [Docs] | **MUST-400**: with `tools`, `reasoning_content` of **all previous turns** must go back [Docs] | None in DeepSeek's API. Alibaba Model Studio (Singapore) hosts deepseek-v4-pro with web search, $10/1k [Docs] | N/D | 2026-09 |
| `deepseek-flash` (V4.1 Flash) | Yes. Thinking **on by default**, effort `high` [Docs] | same | same | same | **MUST-400** (same rule) | none | N/D | 2026-09 |

DeepSeek also serves Anthropic-format (`/anthropic`) and Responses-format endpoints [Docs]. On
Chat Completions it rejects tool calls inserted mid-conversation but accepts system messages there
[Docs].

### 2.6 Moonshot Kimi (adapter: openai-compatible)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `kimi-k3` | Yes. Always thinks; `reasoning_effort` low/high/max, default max [Docs] | Yes; the samples loop over `tool_calls` [Docs] | `none` OK. `required` OK. Named function + thinking → **400** "tool_choice 'specified' is incompatible with thinking enabled" [Docs] | Standard | "Return the complete assistant message unchanged" (Preserved Thinking always on) [Docs]. 400 enforcement **needs live probe (P5)**. K2.5/K2.6 return 400 "…reasoning_content is missing in assistant tool call message at index N" [3P] | `$web_search` builtin "will be deprecated soon" ($0.005/call) and "not recommended" on K3. New REST `/v1/tools/search` $0.002, `search_pro` $0.003, `fetch` $0.002 per call [Docs] | N/D (dynamic tool loading guide) | 2026-09 |
| `kimi-k2.7-code` / `-highspeed` | Yes. Always thinks; `thinking:{type:"disabled"}` errors; fixed sampling params, other values error [Docs] | Yes | `tool_choice` **only `auto`/`none`**; other values error [Docs] | Standard | Docs conflict: "omitting it does not cause an error" within a turn, yet Preserved Thinking is always on and historical `reasoning_content` "must" be kept → **needs live probe (P5)** | same as above | N/D | 2026-09 |

### 2.7 Zhipu GLM (adapter: openai-compatible; base `open.bigmodel.cn`)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `glm-5.3` | Yes. **Thinking forced**: `thinking.type:"disabled"` makes the request fail; `reasoning_effort` low/high/max, default max [Docs] | N/D | **"`tool_choice` … only supports `auto`"** [Docs] → `none` **needs live probe (P6)** | Standard | SHOULD: interleaved thinking; "thinking blocks should be explicitly preserved and returned". Preserved Thinking opt-in via `thinking.clear_thinking:false`, then the complete unmodified `reasoning_content` must be returned [Docs] | `tools:[{type:"web_search", web_search:{…}}]` in chat; **$0.01/use** (z.ai price list; bigmodel.cn pricing differs, [Unverified]) [Docs] | N/D | 2026-09 |
| `glm-4.7-flash` / `-flashx` | Yes. Thinking on by default, can be disabled per turn [Docs] | N/D | only `auto` [Docs] | Standard | SHOULD (same) | same | N/D | 2026-09 |
| `glm-4.6v-flash` / `-flashx` | Yes [Unverified: vision line, hybrid thinking] | N/D | only `auto` [Docs] | Standard | SHOULD | same | N/D | 2026-09 |

### 2.8 MiniMax (adapter: openai-compatible)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `MiniMax-M3` | Yes, function tools. Thinking `adaptive` by default, `disabled` allowed [Docs] | N/D | **No `tool_choice` field in the Chat schema** → **needs live probe (P7)** | Standard | SHOULD: "the entire response_message — including reasoning_details — must be preserved" (with `reasoning_split:true`), or keep the `<think>` content unmodified [Docs]. No 400 documented | `web_search` server tool (**Beta**) only on the Anthropic Messages (`/anthropic/v1/messages`) and Responses (`/v1/responses`) endpoints, **$0.01/request** [Docs] | N/D | 2026-09 |
| `MiniMax-M2.7-highspeed` | Yes. Thinking cannot be disabled [Docs] | N/D | same probe | Standard | SHOULD (same) | same | N/D | 2026-09 |

### 2.9 Mistral (adapter: openai-compatible)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `mistral-medium-latest` (3.5) | API supports it [Docs]; Juno `agenticTools:false` (evidence in `models.ts`) | Yes, default [Docs] | `auto`/`any`/`none` [Docs] | Standard | SHOULD: replay the full assistant message including `ThinkChunk` when effort is high [Docs] | `web_search` / `web_search_premium` only via the Conversations/Agents API, not Chat Completions [Docs]; $30/1k and $50/1k [3P] | N/D | 2026-09 |
| `mistral-large-latest`, `mistral-small-latest`, `codestral-latest`, `ministral-14b/8b/3b-latest` | Yes (all listed) [Docs] | Yes | same | Standard | Small: SHOULD (ThinkChunk); others n/a | same | N/D | 2026-09 |

Ordering: a `user` message directly after `tool` returns 400 "Unexpected role 'user' after role
'tool'" [3P, repeated across 2025–2026].

### 2.10 Meta Muse Spark (adapter: openai-compatible)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `muse-spark-1.3` | Yes, on Chat Completions and Responses [Docs] | Yes, default [Docs] | **`tool_choice` must be `"auto"`: `"none"`, `"required"` and named choices → HTTP 400** [Docs] | Names must match `^[a-zA-Z0-9_.-]+$` with **at most one dot**. `strict` is opt-in schema validation [Docs] | Chat Completions **redacts `reasoning_content` to empty**: nothing to replay. Responses: encrypted reasoning replay [Docs] | `web_search` **Responses only**, **$2.50/1k queries** [Docs]. `browser.search`/`open`/`find` names are reserved when it is on [Docs] | N/D. Tool search supported [Docs] | 2026-09 |
| `muse-spark-1.3-contributor` | same (trains on prompts) | same | same | same | same | same | same | 2026-09 |

### 2.11 Xiaomi MiMo (adapter: openai-compatible)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `mimo-v2.6-pro`, `-ultraspeed`, `mimo-v2.6-flash`, `mimo-v2.5` | Yes. Thinking **on by default** for all four [Docs] | N/D | N/D → **needs live probe** | Standard | **MUST-400**: assistant tool-call messages in all later rounds "must completely pass back the reasoning_content field, otherwise the API will return a 400 error" [Docs] | `tools:[{type:"web_search", …}]` on Chat Completions after the Web Search Plugin is activated in the console. Works alongside custom functions. Overseas **$5/1k**, domestic ¥16/1k [Docs] | N/D | 2026-09 |

### 2.12 Qwen (adapter: openai-compatible; base `dashscope-intl`, Singapore)

| Model | Tools | Parallel | Forced none | Schema | Replay | Native search (price) | Max tools | Date |
|---|---|---|---|---|---|---|---|---|
| `qwen3.8-max`, `qwen3.7-plus` | Yes [Docs] | **Opt-in**: set `parallel_tool_calls:true` to get all calls [Docs] | `none` OK. `required` not supported by Qwen models [Docs] | Standard | Not documented for text models (Omni: include the prior reasoning) → SHOULD [Unverified] | `enable_search:true` on Chat Completions, but the OpenAI-compatible mode "does not support returning search sources". Responses `web_search` returns `action.sources`. Singapore **$10/1k** (agent strategy) [Docs] | N/D | 2026-09-21 |
| `qwen3.8-flash` | Yes | opt-in | same | same | same | Not in the Singapore web-search model list [Docs] | N/D | 2026-09-21 |
| `qwen-long` | [Unverified] ("general-purpose models" support function calling) | – | – | – | n/a (non-reasoning) | Not in the web-search list [Docs] | N/D | 2026-09 |

### 2.13 LongCat (coming soon)

| Model | Tools | Rest |
|---|---|---|
| `LongCat-2.0` | Chat reference documents `thinking` enabled/disabled and `reasoning_content`, but no `tools`/`tool_choice` [Docs] → **needs live probe (P18)** before the model ships | N/D |

### 2.14 Rollup: which of the 48 accept tools, parallel calls and `tool_choice:"none"` today

The table below covers Juno's current transport.

| | Models |
|---|---|
| **Tools fail on the current transport** | `gpt-6-astra`: always. `gpt-6-sol`, `gpt-6-luna`: whenever effort ≠ none. `gpt-5.6-terra`: effort ≠ none [3P]. `grok-4.20-multi-agent-0309`: no Chat Completions at all. `grok-4.1-fast`: slug unknown |
| **Tools accepted, but tool rounds 400 without reasoning replay** | `deepseek-v4-pro`, `deepseek-flash`, the four `mimo-*`. Kimi K3 and K2.7: probe |
| **`tool_choice:"none"` rejected or not documented** | Meta (both): 400 [Docs]. GLM (all five): "only auto" [Docs]. MiniMax (both): no field. MiMo: N/D. LongCat: N/D |
| **Parallel calls need opt-in** | Qwen (`parallel_tool_calls:true`) |
| **Parallel by default** | Anthropic, OpenAI, Gemini, xAI, Mistral, Meta, Kimi |
| **Parallel not documented** | DeepSeek, GLM, MiniMax, MiMo |

---

## 3. Findings by question

### 3.1 Gemini (all current models are 3.x)

**`parameters` vs `parametersJsonSchema`** [Docs, API reference, read 2026-09-23]

- `FunctionDeclaration.parameters` "reflects the Open API 3.03 Parameter Object". Its `Schema` type
  "represents a select subset of an OpenAPI 3.0 schema object".
- The subset's fields are:
  - `type`, `format`, `title`, `description`, `nullable`;
  - `enum`, `maxItems`, `minItems`, `properties`, `required`, `minProperties`, `maxProperties`;
  - `minLength`, `maxLength`, `pattern`, `example`, `anyOf`, `propertyOrdering`, `default`,
    `items`, `minimum`, `maximum`.
- Keywords outside the list are rejected. The reference says `default` is accepted but ignored "so
  that developers who send schemas with a default field don't get unknown-field errors", which
  implies other unknown keywords do produce errors.
- Absent from the list, so rejected in `parameters`: `additionalProperties`, `$schema`, `$id`,
  `$ref`, `$defs`, `oneOf`, `allOf`, `not`, `const`, `exclusiveMinimum`/`exclusiveMaximum`,
  `prefixItems`, and array-valued `type` (`["string","null"]`, where the subset uses `nullable`).
- `parametersJsonSchema` "describes the parameters to the function in JSON Schema format". It is
  "mutually exclusive with `parameters`". Its documented example includes
  `additionalProperties:false`.
- The structured-output guide lists the JSON Schema subset Gemini supports:
  - `type`, including `"null"` in a type array;
  - `title`, `description`, `properties`, `required`, `additionalProperties`;
  - `enum`, `format`, `minimum`, `maximum`;
  - `items`, `prefixItems`, `minItems`, `maxItems`;
  - `anyOf`, and recursive `$ref` (for example `"#"`).
  
  It adds "Not all JSON Schema features are supported". [Docs, updated 2026-09-17]
- Whether `parametersJsonSchema` tolerates or rejects `$schema`, `oneOf`, `allOf` and `const` is
  **needs live probe (P1)**.

**google_search combined with `functionDeclarations`**

- Gemini 3: supported, labelled **Preview**. On generateContent the flag is
  `toolConfig.includeServerSideToolInvocations`. Server `toolCall`/`toolResponse` parts must then
  be echoed back. With circulation on, "Default to validated mode (auto mode is not supported)"
  [Docs, 2026-08-18 / 2026-09-04].
- Gemini 2.5 and older: not supported. This is the case `gemini-core.ts:375-379` handles. No
  current model is affected.

**Mode `NONE` vs withholding declarations**

- `NONE`: "Model will not predict any function call. Model behavior is same as when not passing
  any function declarations" [Docs].
- `UNEXPECTED_TOOL_CALL` is defined as "Model generated a tool call but no tools were enabled in
  the request" [Docs].
- Withholding declarations while the history holds `functionCall` parts therefore risks exactly
  that finish reason. Using `NONE` is the documented route.
- Whether the withheld form is rejected or just risky: **needs live probe (P2)**.

**`functionCall.id` / `functionResponse.id`**

- `FunctionCall.id`: "If populated, the client to execute the functionCall and return the
  response with the matching `id`".
- `FunctionResponse.id`: "Populated by the client to match the corresponding function call id".
  Error details go in `response` under an `"error"` key.
- Gemini 3 accepts multimodal `parts` in a `FunctionResponse` [Docs]. That removes the separate
  image user turn (M12).

**`MALFORMED_FUNCTION_CALL` / `UNEXPECTED_TOOL_CALL`**

- `MALFORMED_FUNCTION_CALL`: "The function call generated by the model is invalid" [Docs].
- `UNEXPECTED_TOOL_CALL`: as defined above [Docs].
- Also present: `TOO_MANY_TOOL_CALLS` ("Model called too many tools consecutively, thus the system
  exited execution") and `MISSING_THOUGHT_SIGNATURE` [Docs].
- A single automatic retry for `MALFORMED_FUNCTION_CALL` is the audit's recommendation
  [Unverified: no Google guidance on retry].

**`url_context` / `code_execution`**

- `url_context`:
  - Supported on all three current models.
  - Up to 20 URLs per request and 34 MB per URL. Text, image and PDF only.
  - Content is billed as input tokens with no tool fee.
  - Combines with `google_search` [Docs, 2026-09-02].
- `code_execution`:
  - Python only, 30 s limit, up to 5 regenerations.
  - Billed as tokens with no tool fee.
  - Combines with `google_search` [Docs, 2026-09-17].

**Search Suggestions display requirement** [Docs, Gemini API Additional Terms, updated 2026-04-28]

- Grounded Results may be displayed only "with the associated Search Suggestion(s) to the end
  user who submitted the prompt".
- No modifying or interspersing content with Grounded Results or Search Suggestions.
- No interstitials, redirects or click-tracking on Links.
- Chat-history storage of the Grounded Result text is allowed for up to 2 years.
- Using Links "to identify destination pages for crawling or scraping" is a violation.
- M13 is **confirmed**. Juno must render `searchEntryPoint.renderedContent` next to every
  grounded answer.
- Two implications need legal review [Unverified]:
  - Juno resolving the grounding redirect URLs to their final targets;
  - any `web_fetch` or Research fetch of a grounding URL.

### 3.2 Compat labs: resolved per item

| Lab | Reasoning replay on tool-call messages | Tools / parallel / `tool_choice:"none"` | Schema limits | `user` after `tool` | Native search (price) | Max tools |
|---|---|---|---|---|---|---|
| DeepSeek | **MUST-400**, and across turns whenever `tools` is present [Docs] | yes / multiple calls / `none` ok (`required`/named 400 in thinking) [Docs] | strict-mode subset (beta) [Docs] | N/D; system-mid-conversation allowed [Docs] | none native | N/D |
| Kimi | K3 and K2.7: "return unchanged" [Docs], enforcement **probe**. K2.5/K2.6: 400 [3P] | yes / yes / K3 `none` ok; K2.7 only `auto`/`none` [Docs] | N/D | N/D | `$web_search` deprecated ($0.005); REST search $0.002–0.003 [Docs] | N/D |
| GLM | SHOULD; Preserved Thinking via `clear_thinking:false` [Docs] | yes / N/D / only `auto` [Docs] | N/D | N/D | `web_search` tool $0.01/use [Docs] | N/D |
| MiniMax | SHOULD ("must be preserved" for performance) [Docs] | yes / N/D / no field [Docs] | N/D | N/D | `web_search` beta, Anthropic or Responses endpoints only, $0.01/req [Docs] | N/D |
| Qwen | SHOULD [Unverified] | yes / opt-in / `none` ok, `required` unsupported [Docs] | N/D | allowed per the documented sequence [Docs] | `enable_search` (no sources on OpenAI-compatible); Responses `web_search`; $10/1k Singapore [Docs] | N/D |
| Mistral | SHOULD (ThinkChunk) [Docs] | yes / default on / `none` ok [Docs] | N/D | **400** [3P] | Conversations/Agents API only; $30/1k [3P] | N/D |
| Meta | n/a on Chat Completions (redacted); Responses encrypted [Docs] | yes / default on / **`none` → 400** [Docs] | ≤1 dot in names; strict opt-in [Docs] | N/D | `web_search` Responses only, $2.50/1k [Docs] | N/D |
| MiMo | **MUST-400** [Docs] | yes / N/D / N/D | N/D | N/D | `web_search` plugin, $5/1k overseas [Docs] | N/D |
| LongCat | N/D | N/D (**probe**) | N/D | N/D | N/D | N/D |

Emerging pattern [Docs]. DeepSeek, MiniMax, Meta, Qwen (DashScope) and xAI now all expose an
**OpenAI Responses-compatible** endpoint, and several (MiniMax, Meta, Qwen, xAI) put their hosted
`web_search` **only** there. A generic "Responses-compatible" adapter would unlock native search
and encrypted reasoning replay for more labs than Juno's compat adapter can.

### 3.3 OpenAI

- **Chat Completions support per model:** see the §2.2 table.
- **Hosted `web_search` on Responses:**
  - Available on all 8 current models [Docs].
  - Priced at $10/1k calls plus search content tokens [Docs].
  - Accepts `filters.allowed_domains`/`blocked_domains` (up to 100), `user_location`,
    `search_context_size`, `external_web_access` and `return_token_budget`.
  - Full source lists come through `include:["web_search_call.action.sources"]` [Docs].
  - Web search is not supported on the original GPT-5 at minimal effort. On gpt-5.4 at effort
    none, results "may be lower-quality" [Docs].
- **Replay under `store:false`:**
  - Reasoning items include `encrypted_content` by default in stateless mode. The legacy
    `include:["reasoning.encrypted_content"]` is still accepted but not required.
  - For function calling, pass back all reasoning, function_call and function_call_output items
    since the last user message.
  - For cross-turn `all_turns` (the 5.6 default), "preserve every output item … and replay the
    complete history" [Docs].
  - Assistant `phase`:
    - `commentary` is for preambles and `final_answer` for answers.
    - It is optional at the API level but recommended for GPT-5.5 and 5.4.
    - "If you replay assistant history manually, preserve each original phase value. Missing or
      dropped phase can cause preambles to be treated as final answers" [Docs].
  - Reasoning reuse is limited to one model family. The 5.6 family shares reasoning; 5.6 and 5.5
    do not [Docs].
- **H6 (reasoning item without its following item):**
  - The 400 "Item 'rs_…' of type 'reasoning' was provided without its required following item"
    is widely reported when a reasoning item is replayed without the item it preceded [3P].
  - Whether dropping only the `message` item (with the `function_call` kept) triggers it is
    **needs live probe (P11)**.
  - Replaying every item with its `phase` removes the question.
- **`function_call_output` image arrays:** confirmed. "For functions that return images or files,
  you can pass an array of image or file objects instead of a string" [Docs].
- **128-function limit:**
  - Confirmed by the error text: "Invalid 'tools': array too long. Expected an array with maximum
    length 128", code `array_above_max_length` [3P].
  - Whether `defer_loading` tools count toward it: **needs live probe (P12)**.
- **Parallel with hosted tools:** "functions can be called in parallel when built-in tools are
  also available. Built-in tools cannot be included in a parallel function-call batch" [Docs].
- **`tool_search` / `defer_loading`:**
  - "Only gpt-5.4 and later models support `tool_search`" [Docs].
  - The model pages list it for Astra, Sol, Luna, Terra and 5.4-mini. It is not listed for
    5.4-nano, 5.5-pro or 5.3-codex [Docs].
  - Hosted and client-executed variants exist. Namespaces and MCP servers are the recommended
    surfaces.
  - `tool_choice:{type:"allowed_tools"}` narrows the callable set without changing `tools`, which
    keeps the cache [Docs].

### 3.4 xAI

- **Live Search status:**
  - Announced deprecated in Dec 2025, retired **12 Jan 2026**, now answers **410 Gone** [3P].
  - xAI's current comparison page lists Chat Completions as "Deprecated", with "Agentic Tools:
    Function calling only" and "Reasoning Models: No reasoning content returned" [Docs, Sep 2026].
  - M15 and RC-12 are **confirmed**, and worse than either audit assumed: it fails the turn rather
    than doing nothing.
- **Server-side tools:**
  - Endpoint: `POST https://api.x.ai/v1/responses` (or the xAI SDK).
  - Request shape: `tools:[{type:"web_search", filters:{allowed_domains|excluded_domains (≤5)},
    enable_image_understanding, enable_image_search}, {type:"x_search"}, {type:"code_interpreter"}]`.
  - Billing fields:
    - `server_side_tool_usage` map, e.g. `SERVER_SIDE_TOOL_WEB_SEARCH`;
    - `usage.server_side_tool_usage_details.x_posts_fetched` and `x_users_fetched`;
    - Responses emits `web_search_call` output items [Docs].
  - Mixing with client function tools works: execution pauses on a client call, and `max_turns`
    counts server-side turns only [Docs].
  - Storage defaults to `store:true` (30 days) on Responses [Docs]. Juno should send `store:false`.
- **Models:**
  - `grok-4.7` is documented with both tools [Docs].
  - `grok-4.20-multi-agent-0309` supports built-in tools but not client tools [Docs; conflicting
    model page].
  - `grok-build-0.1` needs a probe.
  - `grok-4.1-fast` needs a probe (slug).

### 3.5 Anthropic

- **`server_tool_use` input streaming:** confirmed. "A `server_tool_use` block that Claude calls
  directly streams like a client `tool_use` block: a `content_block_start` event followed by
  `input_json_delta` events. The result block arrives complete in a single `content_block_start`"
  [Docs]. RC-11 and M1 are **confirmed**.
- **Versions:**
  - `web_search_20250305`, `_20260209` (dynamic filtering) and `_20260318` (+
    `response_inclusion`).
  - `web_fetch_20250910`, `_20260209`, `_20260309` (+ `use_cache`) and `_20260318`.
  - Dynamic filtering needs "Claude 4.6 and later".
  - On models without programmatic tool calling (Haiku 4.5), the `_2026*` versions require
    `allowed_callers:["direct"]` [Docs].
  - Per-model mapping: see §2.1.
- **Dynamic filtering and code execution:**
  - It runs *through* code execution, but "You don't need to add the code execution tool". If you
    do add one, it must be `code_execution_20260120` or later.
  - There is no extra charge.
  - The `_2026*` versions are **not ZDR-eligible** unless `allowed_callers:["direct"]` [Docs].
- **`display:"updates"`:**
  - Available on Fable 5.1, Mythos 5.1, **Opus 5.5** and Fable 5, with beta header
    `thinking-display-updates-2026-08-18`, on every platform. Without the header the value is
    rejected [Docs].
  - Not Sonnet 5 or Haiku 4.5.
  - On Opus 5.5 and Fable 5.1, text the model writes between tool calls comes back as
    progress-update `thinking` blocks. They are empty under the default `omitted`.
  - Juno sends `summarized` (`anthropic-thinking.ts:164`), under which updates are "mixed with the
    reasoning summaries" [Docs].
  - Whether they can be told apart deterministically (block position before `tool_use` only) is
    **needs live probe (P16)**. This matters for T6's commentary items.
- **Interleaved thinking on manual-thinking models:**
  - "Claude Haiku 4.5 does not support interleaved thinking. On the Claude API, the beta header
    is accepted but ignored" [Docs].
  - The only current manual-thinking model is Haiku 4.5, so L2 is **refuted for the current
    catalog**. It applies only to legacy Sonnet 4.5 and Opus 4.5.
- **Forced tool choice:**
  - `any`/`tool` return 400 on Opus 5.5, Fable 5.1 and Mythos 5.1, on every request, including
    Batches and `count_tokens`.
  - `none` and `auto` are fine [Docs].
  - Juno uses only `auto`/`none` (`anthropic.ts:341`), so nothing breaks.
- **`is_error` semantics:**
  - Set `"is_error": true` with an instructive message.
  - Claude "will incorporate this error". For invalid-input errors it "will retry 2-3 times with
    corrections before apologizing".
  - Server-tool errors arrive as 200 responses with an error object in the result block, and need
    no `is_error` [Docs].
- **`pause_turn`:**
  - The server-side loop pauses a long turn.
  - The continuation must re-send the assistant content as-is with the **same tools**. A pending
    `server_tool_use` whose tool is missing is a validation error.
  - The default cap is **10 iterations** (skill reference cached Jun 2026). Batches allow more.
    The current server-tools page no longer prints the number [Docs].
- **New constraint, mixed batches:** when a response mixes a client `tool_use` and an unresolved
  `server_tool_use`:
  - `stop_reason` is `tool_use`.
  - The next user message must contain **only** `tool_result` blocks, or the API returns 400 with
  "… tool use with id … was found without a corresponding … result block" [Docs].
- **Preserved thinking (Opus 5.5, Fable 5.1):**
  - Changing `system`, `tools` or any earlier message invalidates replayed thinking blocks.
  - Accounts created on or after 2026-08-31 get a 400 on this. Older accounts opt in [skill
    reference; Docs].
  - Changing `tool_choice` is safe, but it invalidates the message-level prompt cache [Docs].

---

## 4. Verdicts on every "verify live" item

| Audit item | Claim | Verdict | Basis |
|---|---|---|---|
| e2e RC-2 (3): Kimi `$web_search` | Map the web toggle to it | **Refuted as a target.** Deprecated soon; "not recommended" on K3 | [Docs] Kimi web-search and K3 guides |
| e2e RC-2 (3): Qwen `enable_search` | Map the toggle to it | **Confirmed it exists, rejected for chat.** No sources on the OpenAI-compatible path; qwen3.8-flash and qwen-long not supported | [Docs] Model Studio web search, 2026-09-21 |
| e2e RC-2 (3): GLM `web_search` tool | Map the toggle to it | **Confirmed it exists ($0.01/use).** Combination with function tools on glm-5.3 **needs live probe (P20)** | [Docs] z.ai |
| e2e RC-2 (3) / RC-12 / backend M15: xAI | Live Search status; server-side tools | **Confirmed.** Retired 2026-01-12, 410 Gone; server tools only on Responses | [3P] + [Docs] |
| e2e RC-4 / backend H3 / §9: Gemini rejects `$schema`, `additionalProperties` in `parameters` | | **Confirmed** (Schema is an OpenAPI subset without them; unknown fields error). Byte-level error text: P1 | [Docs] API reference |
| backend §9: Gemini accepts `parametersJsonSchema` | | **Confirmed** (field exists, JSON Schema, exclusive with `parameters`). Keyword tolerance: **needs live probe (P1)** | [Docs] |
| e2e RC-4 / backend M11: withheld declarations on the final round | Accepted? | **Needs live probe (P2).** Docs point to `mode:NONE`; `UNEXPECTED_TOOL_CALL` defined as a call with no tools enabled | [Docs] |
| e2e RC-4: pre-Gemini-3 loses function tools with search | | **Confirmed but moot for current models** (all 3.x; combination is Gemini-3-only Preview) | [Docs] |
| backend M11: `MALFORMED_FUNCTION_CALL` handling | | **Confirmed definition.** Retry policy is Juno's choice | [Docs] |
| backend M13: Search Suggestions must be shown | | **Confirmed** | [Docs] terms, 2026-04-28 |
| e2e RC-5 / backend H4: DeepSeek replay | | **Confirmed, stronger than claimed** (400; all prior turns when tools present; flash thinks by default) | [Docs] |
| e2e RC-5 / H4: Kimi replay | | **Confirmed for K2.5/K2.6 [3P]. Needs live probe (P5) for K3 and K2.7** | [Docs] + [3P] |
| e2e RC-5 / H4: GLM "preserved thinking" | | **Confirmed as quality guidance, not a 400** (preserved thinking is opt-in on the standard endpoint) | [Docs] |
| e2e RC-5 / H4: MiniMax `reasoning_details` | | **Confirmed as a must-preserve; no 400 documented** | [Docs] |
| (new) MiMo replay | | **Confirmed 400** | [Docs] |
| backend H4: GPT-5.x on Chat Completions loses reasoning | | **Confirmed and superseded** — tools don't work at all on GPT-6 (Astra; Sol/Luna with effort) and 5.6 on that path | [Docs] + [3P] |
| backend H6: Responses 400 when a reasoning item loses its following message | | **Error confirmed to exist [3P]. Exact trigger needs live probe (P11).** `phase` replay confirmed recommended | [3P] + [Docs] |
| backend §3.3: `function_call_output` accepts content arrays with images | | **Confirmed** | [Docs] |
| backend H7: `defer_loading` / tool search | | **Confirmed.** Anthropic, all 4 current models; OpenAI gpt-5.4+ except nano/pro/codex; Meta and Kimi have their own | [Docs] |
| backend H7: 128-function limit (OpenAI) | | **Confirmed** (error text). Deferred-count: P12 | [3P] |
| e2e RC-11 / backend M1: `server_tool_use` input streams as `input_json_delta` | | **Confirmed** | [Docs] |
| backend M1: `pause_turn` continuation with `input:{}` | How the API treats an empty query | **Needs live probe (P21).** The API runs the pending server tool from the replayed block, so an empty query is at best a wasted search | [Docs] + [Unverified] |
| backend L8: newer Anthropic tool versions exist | | **Confirmed** (`_20260318`) | [Docs] |
| backend L2: interleaved-thinking header on manual-thinking models | | **Refuted for the current catalog** (Haiku 4.5 unsupported); true only for legacy Sonnet/Opus 4.5 | [Docs] |
| backend M23: Mistral rejects `user` after `tool` | | **Confirmed** | [3P] |
| backend M23: a mid-conversation `system` message is rejected by some hosts | | **Partly resolved.** DeepSeek: allowed [Docs]. xAI: "No role order limitation" [Docs]. Anthropic: only on models that support mid-conversation system messages (not Sonnet 5) [Docs]. Others: **needs live probe (P9)** | [Docs] |
| backend M24: candidates without tool support | `grok-4.20-multi-agent-0309`, `moonshot-v1-128k`, `deepseek-reasoner` | **Multi-agent confirmed (no client tools; no Chat Completions).** The other two are no longer current catalog entries (not checked). New entries: GPT-6 Astra on Chat Completions, Sol/Luna/Terra with effort | [Docs] |
| backend M8: Composio meta-tool names | | **Out of scope** (not a model provider). Needs a `listTools` probe against a connected app | – |
| (new) Anthropic web_fetch dynamic filtering on Opus 5.5 | | **Needs live probe (P15)** (web-fetch page omits Opus 5.x; web-search page says "4.6 and later") | [Docs] |
| (new) OpenAI GPT-5.6 Terra tools + reasoning on Chat Completions | | **Confirmed [3P]; needs live probe (P10)** against Juno's key | [3P] |

---

## 5. Probes (written, not run)

Each probe is minimal and costs a few hundred tokens. Replace keys from the environment. All
probes are read-only against the provider.

**P1: Gemini schema tolerance (`parameters` vs `parametersJsonSchema`).** Expect A → 400
unknown-field and B → 200. Repeat B with `oneOf`/`const`/`$defs` to map the tolerated keywords.

```bash
S='{"type":"object","$schema":"http://json-schema.org/draft-07/schema#","additionalProperties":false,"properties":{"q":{"type":"string","const":"x"}},"required":["q"]}'
for FIELD in parameters parametersJsonSchema; do
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent" \
 -H "x-goog-api-key: $GEMINI_API_KEY" -H 'content-type: application/json' \
 -d "{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"call f with q=x\"}]}],
      \"tools\":[{\"functionDeclarations\":[{\"name\":\"f\",\"description\":\"test\",\"$FIELD\":$S}]}]}" | head -c 400; echo; done
```

**P2: Gemini final round: withheld declarations vs `mode:NONE`**, with a `functionCall` in the
history. Record `finishReason` for both.

```bash
H='[{"role":"user","parts":[{"text":"weather in Paris?"}]},
    {"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]},
    {"role":"user","parts":[{"functionResponse":{"name":"get_weather","response":{"result":"12C"}}}]}]'
D='[{"functionDeclarations":[{"name":"get_weather","description":"w","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}]}]'
curl -s ".../gemini-3.8-flash:generateContent" -H "x-goog-api-key: $GEMINI_API_KEY" -d "{\"contents\":$H}"   # A: withheld
curl -s ".../gemini-3.8-flash:generateContent" -H "x-goog-api-key: $GEMINI_API_KEY" \
 -d "{\"contents\":$H,\"tools\":$D,\"toolConfig\":{\"functionCallingConfig\":{\"mode\":\"NONE\"}}}"         # B: NONE
```

(Gemini 3 may require the model turn's `thoughtSignature`. If A/B fail on
`MISSING_THOUGHT_SIGNATURE`, capture a real round first.)

**P3: Gemini 3 built-in + function combination**: with and without
`includeServerSideToolInvocations`, `AUTO` vs `VALIDATED`.

```bash
curl -s ".../gemini-3.8-flash:generateContent" -H "x-goog-api-key: $GEMINI_API_KEY" -d '{
 "contents":[{"role":"user","parts":[{"text":"Find today'\''s top AI headline, then call save(title)."}]}],
 "tools":[{"googleSearch":{}},{"functionDeclarations":[{"name":"save","description":"save","parameters":{"type":"object","properties":{"title":{"type":"string"}}}}]}],
 "toolConfig":{"includeServerSideToolInvocations":true,"functionCallingConfig":{"mode":"VALIDATED"}}}'
```

**P4: DeepSeek replay rule** (docs say 400). Round 2 of a tool loop without `reasoning_content`;
then a new user turn after a plain answer, with `tools` present.

```bash
curl -s https://api.deepseek.com/chat/completions -H "Authorization: Bearer $DEEPSEEK_API_KEY" -H 'content-type: application/json' -d '{
 "model":"deepseek-flash","tools":[{"type":"function","function":{"name":"now","parameters":{"type":"object","properties":{}}}}],
 "messages":[{"role":"user","content":"what time is it?"},
  {"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"now","arguments":"{}"}}]},
  {"role":"tool","tool_call_id":"call_1","content":"12:00"}]}' | head -c 400
```

**P5: Kimi K3 / K2.7 Code replay**: same shape as P4 against `https://api.moonshot.ai/v1`, models
`kimi-k3` and `kimi-k2.7-code`, assistant tool-call message **without** `reasoning_content`.
Expect 400 "thinking is enabled but reasoning_content is missing…" (as on K2.6) or 200.

**P6: GLM-5.3 `tool_choice:"none"` and Instant.** Two requests: (a) tools + `tool_choice:"none"`;
(b) `thinking:{type:"disabled"}`, which the docs say fails.

```bash
curl -s https://open.bigmodel.cn/api/paas/v4/chat/completions -H "Authorization: Bearer $ZHIPU_API_KEY" -H 'content-type: application/json' -d '{
 "model":"glm-5.3","tool_choice":"none","messages":[{"role":"user","content":"hi"}],
 "tools":[{"type":"function","function":{"name":"f","description":"x","parameters":{"type":"object","properties":{}}}}]}' | head -c 300
```

**P7: MiniMax `tool_choice:"none"` and replay without `reasoning_details`**:
`https://api.minimax.io/v1/chat/completions`, model `MiniMax-M3`, `reasoning_split:true`. Same
two shapes as P4 and P6.

**P8: Meta `tool_choice:"none"`** (docs say 400; run only to capture the exact body for the
error classifier). `https://api.meta.ai/v1/chat/completions`, model `muse-spark-1.3`.

**P9: `user` after `tool` and mid-conversation `system`**, for Mistral, Qwen, GLM, MiniMax, Kimi,
MiMo and Meta. The body is the P4 history plus
`{"role":"user","content":[{"type":"text","text":"(image follows)"}]}`, and separately a
`{"role":"system",…}` inserted before the last user message. Record which hosts return 400.

**P10: OpenAI Chat Completions + tools + reasoning.** Docs and 3P say 400 on the first three and
200 on 5.4-mini.

```bash
for M in gpt-6-sol gpt-5.6-terra gpt-6-astra gpt-5.4-mini; do
curl -s https://api.openai.com/v1/chat/completions -H "Authorization: Bearer $OPENAI_API_KEY" -H 'content-type: application/json' -d "{
 \"model\":\"$M\",\"reasoning_effort\":\"low\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],
 \"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"f\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}}]}" | head -c 300; echo; done
```

**P11: Responses replay without the `message` item.** Run a `gpt-5.3-codex` turn that emits a
preamble and a function call. Replay only `reasoning` + `function_call` + `function_call_output`,
then replay with the `message` item (and its `phase`) included. Compare.

```bash
# round 1: store:false, tools:[f], prompt "Say one short sentence, then call f."
# round 2: input = [user, <reasoning item>, <function_call item>, {type:function_call_output, call_id, output:"ok"}]
```

**P12: OpenAI deferred tools vs the 128 cap.** Send 129 function tools, 125 of them with
`defer_loading:true`, plus `{type:"tool_search"}` to `gpt-6-luna` on Responses. Is it 400
`array_above_max_length`?

**P13: xAI.**
- (a) Chat Completions with `search_parameters`: expect 410.
- (b) Responses `web_search` on `grok-build-0.1`.
- (c) `grok-4.20-multi-agent-0309` on Responses with one function tool.

```bash
curl -s https://api.x.ai/v1/responses -H "Authorization: Bearer $XAI_API_KEY" -H 'content-type: application/json' -d '{
 "model":"grok-build-0.1","store":false,"input":[{"role":"user","content":"latest xAI news?"}],"tools":[{"type":"web_search"}]}' | head -c 400
```

**P14: `grok-4.1-fast` slug.** `GET https://api.x.ai/v1/models/grok-4.1-fast`, and one
1-token completion. Record the served `model` and billing.

**P15: Anthropic tool versions per model.**
- (a) `claude-opus-5-5` with `web_fetch_20260318`.
- (b) `claude-haiku-4-5` with `web_search_20260318`, without `allowed_callers` (expect a 400
  asking for `["direct"]`).

```bash
curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d '{
 "model":"claude-opus-5-5","max_tokens":1024,"messages":[{"role":"user","content":"Summarize https://example.com"}],
 "tools":[{"type":"web_fetch_20260318","name":"web_fetch","max_uses":1}]}' | head -c 400
```

**P16: Opus 5.5 progress blocks under `summarized` vs `updates`.** Run one two-tool turn with
`thinking:{type:"adaptive",display:"summarized"}`, then the same with `display:"updates"` and header
`anthropic-beta: thinking-display-updates-2026-08-18`. Diff the block sequences: does any field
mark a progress block?

**P17: Qwen.**
- (a) `enable_search:true` + tools on `qwen3.8-flash` (not listed).
- (b) Tools on `qwen-long`.

**P18: LongCat tools.** One `tools` request on `https://api.longcat.chat/openai/v1/chat/completions`
with `LongCat-2.0`.

**P19: MiMo `web_search` + a function tool** on `mimo-v2.6-pro` (plugin must be activated). Also
test `tool_choice:"none"`.

**P20: GLM `web_search` tool + a function tool** on `glm-5.3`.

**P21: Anthropic `pause_turn` with an emptied `server_tool_use.input`.** Force a pause
(`max_uses` high, broad query), then continue with the paused content's `input` replaced by `{}`.
Record the `web_search_tool_result` error code, if any.

---

## 6. Implications for DECISIONS T1, T3, T5

### 6.1 T1: which adapter needs which fix

**Route all OpenAI models through Responses. The answer is yes, without exception.**

- GPT-6 Astra cannot tool-call on Chat Completions. Sol, Luna and (per 3P) GPT-5.6 Terra can do
  so only at effort none. gpt-5.5-pro and gpt-5.3-codex are Responses-only [Docs, §3.3].
- gpt-5.4-mini/nano *work* on Chat Completions, but they gain:
  - hosted `web_search`;
  - encrypted reasoning continuity;
  - `phase`;
  - `tool_search` (mini);
  - image tool outputs.
- One OpenAI path also halves the test surface. Change `providerAdapterFor` to send every
  `provider:"openai"` chat model to `openai-responses`.
- **Before** that ships, confirm with P10. If the 400 reproduces, the Chat Completions path is
  broken in production today for any tooled GPT-6/5.6 turn above Instant. It should be named as
  its own root cause alongside RC-1.

The Responses adapter itself needs these fixes (RC-2, RC-13, H6, §3.3):

- Replay **every** output item in order: `reasoning`, `message` with its original `phase`,
  `function_call`, and `web_search_call`.
- Send `function_call_output.output` as an array with `input_image`, and drop the extra user
  turn.
- Pass `call_id` to the broker.
- Emit usage per round.
- Wire the hosted `web_search` tool:
  - read sources through `include:["web_search_call.action.sources"]`;
  - remember that hosted tools are never in a parallel function batch.
- Map `phase:"commentary"` onto T6's commentary items. OpenAI's own contract matches T6.
- Optional: store encrypted reasoning items per assistant message for 5.6-family `all_turns`
  continuity. They are family-bound, so drop them on a family switch.

**xAI** (RC-12, M15, M24):

- Move Grok to the Responses shape at `https://api.x.ai/v1/responses`. This is the same Responses
  code with a different base URL, `store:false`, and no `phase`.
- Delete `search_parameters`.
- Web on → `tools:[{type:"web_search"},{type:"x_search"}]`.
- Bill from `server_side_tool_usage` and `usage.server_side_tool_usage_details`, not
  `ceil(citations/10)`.
- Replay `reasoning.encrypted_content` (always returned for grok-4.7).
- Handle `grok-4.20-multi-agent-0309` specially:
  - built-in tools only;
  - no Juno function tools;
  - not `start_task`.
  
  Otherwise mark it `tools:false` in the capability flag (M24).
- Resolve the `grok-4.1-fast` slug (P14) before relying on it.

**Gemini** (RC-4, M11, M12, M13, H2):

- Send connector schemas through `parametersJsonSchema`. Keep a light normaliser for the unknowns
  P1 reveals:
  - strip `$schema`, `$id` and `$comment`;
  - `const` → one-value `enum`;
  - `oneOf` → `anyOf`;
  - inline `$defs`.
  
  Juno's own `ToolSpec` schemas (T2's portable subset) can keep using `parameters`.
- Final round:
  - keep the declarations;
  - send `toolConfig.functionCallingConfig.mode:"NONE"`;
  - keep `google_search` only if P3 shows it is harmless.
- Echo `functionCall.id` into `functionResponse.id` (RC-13), and use `${round}:${index}` only when
  the id is absent.
- Return failures as `response:{error:…}`.
- Send images as `FunctionResponse.parts` on Gemini 3.
- Retry a `MALFORMED_FUNCTION_CALL` round once.
- Treat `UNEXPECTED_TOOL_CALL` and `TOO_MANY_TOOL_CALLS` as distinct finish reasons, not "length"
  or "unknown".
- Render `searchEntryPoint.renderedContent` with every grounded answer (terms).
- The pre-3 drop stays for legacy 2.5 only. No current model needs "pre-Gemini-3 keeps function
  tools".
- Built-in + function combination on 3.x is Preview, and the docs want `VALIDATED` mode. P3
  decides whether Juno's current `AUTO` combination is honoured.

**Compat adapter** (RC-5, RC-13, RC-14, M23, M24):

- Add a per-model `tools` capability record in place of the single `agenticTools` flag:
  `{ supported, parallel: "default"|"opt-in"|"unknown", forcedNone: "tool_choice"|"omit-tools",
  replay: "must"|"should"|"none", replayField: "reasoning_content"|"reasoning_details"|"think-tags"|"thinkchunk",
  maxTools, nativeSearch }`. The values are in §2.
- Reasoning replay per model:
  - **MUST**: DeepSeek, MiMo, Kimi (pending P5).
  - **SHOULD**: GLM, MiniMax, Mistral small/medium, Qwen.
- For DeepSeek the replay is **cross-turn** whenever `tools` is present. Juno must persist the
  assistant `reasoning_content` (it already persists `reasoning`) and replay it in history. The
  alternatives are to send DeepSeek turns with no tools at all, or to route DeepSeek through its
  Anthropic-format endpoint.
- Fix the `deepseek-flash` catalog entry (`reasoning:true`). Let Instant send
  `reasoning_effort:"none"`, which DeepSeek documents as "disables thinking mode".
- GLM-5.3: never send `thinking:{type:"disabled"}` (the request fails). Map effort to
  `reasoning_effort` low/high/max. The current code only does that for glm-5.2.
- Kimi K2.7: `tool_choice` only `auto`/`none`. Never force a named tool while thinking.
- Qwen: send `parallel_tool_calls:true`. Never send `tool_choice:"required"`.
- Mistral: never place a `user` message directly after `tool`. Move tool-output images into the
  tool message, or insert an assistant bridge.
- Meta: move to Responses for reasoning replay and web search. Until then, keep function names to
  at most one dot. Juno's `connectorId__tool` names already comply.
- Pass `tool_call.id` to the broker (RC-13). Synthesize an id only when a host omits it (M23).

**Anthropic** (RC-11, RC-14, L8):

- Accumulate `input_json_delta` for `server_tool_use` and emit the search query.
- Set `is_error:true` on failed results.
- Tool versions:
  - Fable 5.1, Opus 5.5 and Sonnet 5: move to `web_search_20260318` (and `web_fetch_20260318` if
    T3 adopts native fetch there, pending P15 on Opus 5.5).
  - Haiku 4.5: keep `web_search_20250305`.
  - Dynamic filtering is not ZDR-eligible. If Juno has ZDR commitments, send
    `allowed_callers:["direct"]`.
- Handle mixed batches:
  - an unresolved `server_tool_use` next to a client `tool_use`;
  - the follow-up user message then carries only `tool_result` blocks.
- Handle `caller`-tagged nested blocks from dynamic filtering.
- Don't add the interleaved-thinking beta; it has no effect on any current model.
- Consider `display:"updates"` only when reasoning is hidden (P16).

### 6.2 T3: where native search can replace Juno's `web_search`

| Adapter / lab | Native option | Verdict |
|---|---|---|
| Anthropic (4) | `web_search_20260318` ($10/1k); Haiku basic | **Keep native.** Also consider native `web_fetch` (free, same provenance rule as T3's `web_fetch`) |
| Gemini (3) | `google_search` ($14/1k after 5k/mo), `url_context` (tokens) | **Keep native search**, with Search Suggestions shown. On Gemini, prefer `url_context` over Juno `web_fetch` for grounding-derived URLs, because the terms forbid using grounding Links to find pages to crawl (legal review) |
| OpenAI (8) | Hosted `web_search` on Responses ($10/1k + content tokens) | **Use native once all OpenAI models are on Responses.** This replaces T3's "where the adapter supports it" hedge |
| xAI (grok-4.7, build pending P13) | `web_search` $5/1k + `x_search` per item | **Use native on Responses.** The only way Grok can search at all now |
| Meta (2) | `web_search` Responses-only, $2.50/1k | **Native after a Meta Responses adapter.** On compat, use Juno `web_search` |
| MiniMax (2) | `web_search` beta, Anthropic or Responses endpoints only, $0.01/req | **Juno `web_search`** for now; revisit if MiniMax moves to a Responses/Anthropic adapter |
| Qwen (3 of 4) | `enable_search` (no sources on the OpenAI-compatible path); Responses `web_search` $10/1k | **Juno `web_search`.** No citations on the current path; qwen3.8-flash and qwen-long unsupported |
| GLM (5) | `web_search` tool, $0.01/use | **Juno `web_search`** by default (uniform citations). Native is possible after P20 |
| MiMo (4) | `web_search` plugin, $5/1k overseas | **Juno `web_search`** by default. Native is possible after P19; needs console activation |
| Kimi (3) | `$web_search` deprecated; REST search API | **Juno `web_search`** |
| DeepSeek (2), Mistral (7), LongCat | none on the chat path (Mistral: Conversations API only, $30/1k [3P]) | **Juno `web_search`** |

After the fixes, native search covers **4 + 3 + 8 + 3–4 = 18–19** of the 48 models. Juno's
`web_search` covers the other ~29 (every compat lab). `web_fetch` stays universal, as T3 says,
with the Gemini caveat above.

### 6.3 T5: the loop

**Final round, "tools off", per adapter.**

| Adapter | Mechanism |
|---|---|
| Anthropic | `tool_choice:{type:"none"}` with the tools kept. Keeps preserved thinking valid; costs the message-level cache |
| Responses (OpenAI, xAI) | `tool_choice:"none"` |
| Gemini | `mode:"NONE"` with the declarations kept |
| Compat: DeepSeek, Kimi, Qwen, Mistral | `tool_choice:"none"` |
| Compat: GLM, MiniMax, Meta, MiMo, LongCat | **Omit `tools`** (Meta 400s on `none`; GLM documents "auto only"; the others are unknown until P6/P7/P19). For DeepSeek, note that omitting `tools` changes the replay rule: `reasoning_content` is then ignored, not required |

**The "answer from what you have" note.**

- On Anthropic, do **not** append it as a text block after `tool_result`s when the round left an
  unresolved `server_tool_use`. That returns a 400.
- Put it in a mid-conversation `system` message where the model supports one (Opus 5.5, Fable
  5.1). Otherwise add it only when no server tool is pending.
- On Mistral, never put it as a `user` message right after `tool`.

**Parallelism.**

- Parallel by default: Anthropic, OpenAI, Gemini, xAI, Mistral, Meta, Kimi.
- Qwen needs `parallel_tool_calls:true`.
- DeepSeek, GLM, MiniMax and MiMo don't document it, so handle multiple calls when they come but
  don't rely on them.
- OpenAI never mixes hosted tools into a parallel function batch.
- All results go back in one message (Anthropic: one user message; Gemini: one user turn).

**Budgets.**

- Count Anthropic `pause_turn` continuations and xAI server-side turns (`max_turns`) inside T5's
  round budget.
- Raise Claude's `max_uses` from 5 to the round budget.
- Meta's `max_tool_calls` caps built-in tools only.

**Tool-count caps.**

- Enforce a Juno ceiling below the smallest documented cap:
  - OpenAI 128 [3P];
  - Gemini 128 [Docs] (512 per the API error);
  - xAI 350 [Docs].
- Above ~30 tools, use deferred loading where it exists:
  - Anthropic `defer_loading` + tool search on all four current models;
  - OpenAI `tool_search` on gpt-5.4+ except nano, pro and codex;
  - Meta tool search;
  - Kimi dynamic loading.
- Elsewhere use a Juno "tool search" meta-tool. Sort tools deterministically (H7): prefix caches
  on Anthropic, OpenAI and Kimi depend on it, and on Opus 5.5 and Fable 5.1 a changed `tools`
  array also invalidates replayed thinking.

**Duplicates and timeouts.** No provider constraint found. The T5 decisions stand.

---

## 7. Sources

Every page below was read on 2026-09-23.

**Anthropic** [Docs]

- `claude-api` skill reference (cached 2026-06-24):
  - `shared/tool-use-concepts.md`
  - `shared/model-migration.md` (Opus 5.5, Fable 5.1)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
- https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- https://platform.claude.com/docs/en/build-with-claude/thinking

**Google**

- API reference [Docs]:
  - https://ai.google.dev/api/generate-content (FunctionDeclaration, Schema, FunctionCall/Response,
    FinishReason, Tool)
  - https://ai.google.dev/api/caching (ToolConfig, FunctionCallingConfig)
- Guides [Docs]:
  - https://ai.google.dev/gemini-api/docs/function-calling (2026-09-17)
  - https://ai.google.dev/gemini-api/docs/tool-combination (2026-09-04)
  - https://ai.google.dev/gemini-api/docs/tools (2026-08-18)
  - https://ai.google.dev/gemini-api/docs/google-search (2026-09-17)
  - https://ai.google.dev/gemini-api/docs/url-context (2026-09-02)
  - https://ai.google.dev/gemini-api/docs/code-execution (2026-09-17)
  - https://ai.google.dev/gemini-api/docs/structured-output (2026-09-17)
  - https://ai.google.dev/gemini-api/docs/thinking (2026-09-17)
  - https://ai.google.dev/gemini-api/docs/pricing (2026-09-23)
  - https://ai.google.dev/gemini-api/docs/models (2026-09-23)
- Terms [Docs]: https://ai.google.dev/gemini-api/terms (2026-04-28)
- Tool-count limits:
  - https://firebase.google.com/docs/ai-logic/function-calling [Docs] (128)
  - https://github.com/google-gemini/gemini-cli/issues/19083 [3P] (512 error)

**OpenAI**

- Guides [Docs]:
  - https://developers.openai.com/api/docs/guides/latest-model
  - https://developers.openai.com/api/docs/guides/reasoning
  - https://developers.openai.com/api/docs/guides/function-calling
  - https://developers.openai.com/api/docs/guides/tools-web-search
  - https://developers.openai.com/api/docs/guides/tools-tool-search
  - https://developers.openai.com/api/docs/pricing
- Model pages [Docs]:
  - https://developers.openai.com/api/docs/models/gpt-6-astra
  - https://developers.openai.com/api/docs/models/gpt-6-sol
  - https://developers.openai.com/api/docs/models/gpt-6-luna
  - https://developers.openai.com/api/docs/models/gpt-5.6-terra
  - https://developers.openai.com/api/docs/models/gpt-5.5-pro
  - https://developers.openai.com/api/docs/models/gpt-5.4-mini
  - https://developers.openai.com/api/docs/models/gpt-5.4-nano
  - https://developers.openai.com/api/docs/models/gpt-5.3-codex
- Third-party reports [3P]:
  - https://community.openai.com/t/gpt-5-6-chat-completion-reasoning-effort-bug-behavior-change/1386454
    (Jul–Sep 2026)
  - https://github.com/danny-avila/LibreChat/issues/14355 (2026-07-21)
  - https://github.com/musistudio/claude-code-router/issues/686 (128)
  - https://github.com/vercel/ai/issues/7099 (reasoning without following item)

**xAI**

- Docs [Docs]:
  - https://docs.x.ai/developers/tools/overview
  - https://docs.x.ai/developers/tools/web-search
  - https://docs.x.ai/developers/tools/x-search
  - https://docs.x.ai/developers/tools/advanced-usage
  - https://docs.x.ai/developers/tools/tool-usage-details
  - https://docs.x.ai/developers/tools/function-calling
  - https://docs.x.ai/developers/model-capabilities/text/comparison
  - https://docs.x.ai/developers/model-capabilities/text/multi-agent
  - https://docs.x.ai/developers/model-capabilities/legacy/chat-completions
  - https://docs.x.ai/developers/pricing
  - https://docs.x.ai/developers/models (2026-09-21)
  - https://docs.x.ai/developers/models/grok-4.7
  - https://docs.x.ai/developers/models/grok-build-0.1
  - https://docs.x.ai/developers/models/grok-4.20-multi-agent-0309
- [Changelog]:
  - https://docs.x.ai/developers/release-notes
  - https://docs.x.ai/developers/migration/may-15-retirement
- [3P]:
  - https://github.com/openclaw/openclaw/issues/26355 (410, 2026-02-25)
  - https://x.com/BenjaminDEKR/status/1996738390583054723 (retirement 2026-01-12)

**DeepSeek** [Docs]

- https://api-docs.deepseek.com/guides/thinking_mode
- https://api-docs.deepseek.com/guides/tool_calls
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/api/create-chat-completion

**Moonshot Kimi**

- Docs [Docs]:
  - https://platform.kimi.ai/docs/guide/kimi-k3-quickstart
  - https://platform.kimi.ai/docs/guide/use-thinking-models
  - https://platform.kimi.ai/docs/guide/use-tool-choice
  - https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart
  - https://platform.kimi.ai/docs/guide/use-web-search
  - https://platform.kimi.ai/docs/pricing/chat
- [3P]:
  - https://github.com/anomalyco/opencode/issues/29619
  - https://github.com/Kilo-Org/kilocode/issues/9535

**Zhipu (Z.ai)** [Docs]

- https://docs.z.ai/guides/capabilities/thinking-mode
- https://docs.z.ai/guides/capabilities/function-calling
- https://docs.z.ai/guides/llm/glm-5.3
- https://docs.z.ai/guides/tools/web-search
- https://docs.z.ai/guides/overview/pricing

**MiniMax** [Docs]

- https://platform.minimax.io/docs/guides/text-m3-function-call
- https://platform.minimax.io/docs/guides/server-tools
- https://platform.minimax.io/docs/api-reference/text-chat-openai
- https://platform.minimax.io/docs/guides/pricing-paygo

**Qwen (Alibaba Model Studio)** [Docs]

- https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling (2026-09-21)
- https://www.alibabacloud.com/help/en/model-studio/web-search (2026-09-21)

**Mistral**

- Docs [Docs]:
  - https://docs.mistral.ai/capabilities/function_calling
  - https://docs.mistral.ai/agents/tools/built-in/websearch
  - https://docs.mistral.ai/capabilities/reasoning
- [3P]:
  - https://github.com/zed-industries/zed/issues/31491
  - https://developer.puter.com/tutorials/mistral-api-pricing/ (web-search price)

**Meta** [Docs]

- https://dev.meta.ai/docs/tool-calling
- https://dev.meta.ai/docs/search-grounding
- https://dev.meta.ai/docs/reasoning
- https://dev.meta.ai/docs/pricing-rate-limits

**Xiaomi MiMo** [Docs]

- https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/deep-thinking.md
- https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/tool-calling/web-search.md
- https://mimo.mi.com/static/docs/price/pay-as-you-go.md

**LongCat** [Docs]

- https://longcat.chat/platform/docs/api/chat.html
