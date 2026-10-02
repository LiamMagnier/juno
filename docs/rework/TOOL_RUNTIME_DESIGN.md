# Tool runtime: audit and design (scripts, skills, tool calls)

Status: **design only**, written 2026-10-02 on branch `rf/tools-design` against trunk
`rework/refoundation` @ 12e9716b. Nothing here is implemented, pushed or deployed, and no
production setting was touched. The owner's brief is [TOOL_CALL_REWORK.md](TOOL_CALL_REWORK.md);
its "Required validation" list is quoted as V1–V7 in §7. Production decisions are collected in §8
and §9, and the owner makes them.

Reading order: §1 for the short version, §3 for what is broken, §6 for the design, §7 for the
work lanes.

---

## 1. Summary

**What exists.** Alevr already has most of the pieces of a tool runtime, but they are not
connected to each other and the central piece, an execution backend, does not exist:

- A Python tool, `code_interpreter` (`src/lib/agent/code.ts:83`), with the right safety rule: it
  runs only against a remote sandbox and is not offered when none is configured. **No sandbox
  service exists anywhere in the repository, and none is configured in production**, so Python
  has never run for a user. Even when configured, the tool is attached only when a file is
  attached to the conversation (`src/app/api/chat/route.ts:2445`).
- Four provider adapters, each with its own tool loop (`anthropic.ts`, `openai-compat.ts`,
  `openai-responses.ts`, `gemini.ts`), a separate loop for Work and Orbit runs
  (`runner/agent-core/src/loop.ts`), and a third in native Code (`JunoCodeRuntime`).
- An approval broker with idempotent receipts, an audit trail, resumable chat streams, a skills
  library with import, scanning, pinning and permission narrowing, a hardened (but disabled)
  agent-computer sandbox, a container sandbox for Cloud Code on GitHub Actions, and a native Code
  runtime that already does schema validation, parallel waves, output spill and `use_skill`.
- An unmerged, reviewed **design** for the tool contract and loop: the chat-rework SPEC §3–§5 on
  branch `web/tools-thinking-research` (2026-09-24). Native Chat already built its run timeline
  against it (`NativeRunTimeline.swift:696` canonicalises `code_interpreter` to `run_code`).

**What is broken** (details and evidence in §3): no execution backend; call ids are lost or
random on three of four adapters, which defeats replay protection; invalid tool arguments are
silently executed as `{}`; parallel calls run one by one; generated files other than up to four
images are thrown away; no record of what ran; output is cut head-only at 30,000 characters; long
runs collide with the 120 s stall watchdog; Stop does not cancel the remote run; a later turn
cannot see what an earlier run did; the Python tool would ask for approval on every call; no
model has verified tool-calling evidence; skills cannot carry or run scripts; Orbit's cloud runs
have no script execution at all.

**The plan.**

1. **One tool contract and one dispatcher** for the four chat adapters, adopting the chat-rework
   SPEC §3–§5 (ToolSpec, validation, stable call ids, parallel read groups, per-tool timeouts,
   errors as results, history notes), plus progress events, a durable run record and an
   `outcome_unknown` state. A live tool-round-trip probe per model decides what is offered.
2. **A real execution service, `juno-exec`, on a separate execution host** (never on the web VM,
   which is at its 10-process, 887 MB limit). It speaks an extension of the HTTP contract the
   existing `MicroVMSandboxAdapter` already calls, runs every call in a fresh container with **no
   network**, a read-only root, a per-turn workspace and hard limits, and is driven through a root
   broker modelled on the agent-computer one. A hosted microVM provider behind the same contract
   is the alternative (owner decides, §8).
3. **Python, JavaScript (Node) and shell** through one `run_code` tool, plus `check_run` for long
   jobs. Every run is a `ToolRun` row keyed by `(session, callId)`, so a reconnect or replay never
   runs it twice. Produced files become ordinary conversation **attachments** (`origin:
   "tool_output"`), visible in the answer and under "Made by Alevr" in the Library.
4. **Skills become executable workflows**: their folder (scripts, references, templates) is
   stored as a scanned, content-addressed bundle, discovered through `use_skill`, read through
   `read_skill_file`, mounted read-only into the same sandbox and run with `run_code`. A skill
   never widens what the turn may do.
5. **One presentation** of real runs across Chat, Orbit, Code, native and voice, using the
   existing receipt vocabulary and the Continuum ThinkingMark rules.
6. **Four lanes** (§7): contract and providers; execution runtime; skill workflows; surfaces and
   acceptance.

---

## 2. Source map: the current tool and execution path

Line numbers are at trunk 12e9716b.

### 2.1 Model catalog and provider routing

| What | Where | Notes |
|---|---|---|
| Model record, `agenticTools` flag | `src/lib/models.ts:23-108` (flag at `:33-54`) | `agenticTools` is a guessed default (`guessAgenticTools`, `:161`), true for every chat model except `mistral-medium-latest`. Not evidence. |
| Providers and keys | `src/lib/providers.ts:9-80` | 14 providers; Anthropic native, the rest OpenAI-compatible base URLs. |
| Adapter choice | `src/lib/provider-routing.ts:15-25` | `anthropic-native`, `gemini-native`, `openai-responses` (OpenAI `api:"responses"` or pro mode), `openai-compatible` (everything else). |
| Capability probe | `src/lib/model-capability-probe.ts:33` (`"Reply with OK."`), `src/lib/model-capability.ts`, `scripts/probe-models.ts`, table `ModelCapabilityProbe` (`prisma/schema.prisma:562`) | Proves a model id is callable on its own transport. Does **not** test tool calling. `evidence` is free JSON and `probeVersion` exists, so tool evidence can be added without a migration. |

Current selectable chat models (48, `status: "current"`), by adapter:

| Adapter | Models |
|---|---|
| anthropic-native | claude-fable-5-1, claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5 |
| openai-compatible (OpenAI) | gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-terra, gpt-5.4-mini, gpt-5.4-nano |
| openai-responses | gpt-5.5-pro, gpt-5.3-codex |
| gemini-native | gemini-3.8-flash, gemini-3.1-pro-preview, gemini-3.5-flash-lite |
| openai-compatible (third party) | Meta muse-spark-1.3 (+ contributor); Zhipu glm-5.3, glm-4.7-flash/-flashx, glm-4.6v-flash/-flashx; Moonshot kimi-k3, kimi-k2.7-code (+ highspeed); DeepSeek deepseek-flash, deepseek-v4-pro; Mistral medium/large/small, codestral, ministral 14b/8b/3b; xAI grok-4.7, grok-4.1-fast, grok-build-0.1, grok-4.20-multi-agent; MiniMax M3, M2.7-highspeed; MiMo v2.6-pro (+ ultraspeed), v2.6-flash, v2.5; Qwen qwen3.8-max, qwen3.7-plus, qwen3.8-flash, qwen-long |

### 2.2 Chat route and the tool loop

| Step | Where |
|---|---|
| Runtime tool allowlist per turn (opt-in, never `undefined`) | `src/lib/chat/tool-policy.ts:78-85` |
| Attachment tool toggles; `code` needs a sandbox **and** an attachment | `src/app/api/chat/route.ts:2430-2452` (`:2445`) |
| Skill loaded for the turn (explicit slug only) | `route.ts:2533-2547`, `src/lib/chat/skill-runtime.ts:48` |
| Task/handoff gate; Gemini < 3 cannot mix grounding and functions | `route.ts:2632-2650` (`functionToolsReachModel`, `:2642`) |
| System prompt sections; the code nudge | `src/lib/chat/prompt-sections.ts:43` (`CODE_INTERPRETER_NUDGE`), `composeSystemPrompt` |
| `streamChat` call: tools, audit context, `sessionId: generationId` | `route.ts:3561-3614` (`:3610`) |
| Tool events to activity rows | `route.ts:3634-3641`, `createToolActivity` `route.ts:464` |
| `streamChat`: opens the toolset, adds native tools, picks the adapter | `src/lib/llm.ts:79-233` (`withNativeTools` `:57`, toolset `:176`, switch `:198`) |
| Unified registry (browser, read_document, inspect_image, code_interpreter) | `src/lib/agent/runtime.ts:20-198`; `executeToolCall` `:79` makes a **new random call id** `:93`; `openUnifiedAgentToolset` `:206`, registry path drops the provider call id `:279` |
| MCP connector toolset and the call-id contract | `src/lib/mcp.ts:261-297` (contract comment `:283-289`), broker call `:552` |
| Anthropic loop: 6 rounds + forced final, sequential execution, images in `tool_result` | `src/lib/anthropic.ts:194`, `:333-466` (`:419`) |
| Invalid JSON becomes `{}` | `src/lib/anthropic-round.ts:143` (`safeToolInput`), `src/lib/openai-compat.ts:563-567`, `src/lib/openai-responses.ts:455-459` |
| OpenAI-compatible loop; no call id passed to `execute` | `openai-compat.ts:172`, `:479-626` (`:569`) |
| Responses loop; no call id passed | `openai-responses.ts:47`, `:303`, `:449-480` (`:461`) |
| Gemini loop; **random call id per call** | `src/lib/gemini.ts:142`, `:295-340` (`:304`); thought signatures preserved in `gemini-round.ts:187-247` |
| Tool images per round (max 4, vision only) | `src/lib/tool-result-images.ts:30-79` |
| Stream event type: `call` and `result` only | `src/types/llm.ts:56-90`; model history is text + attachments only, `src/types/llm.ts:6` |
| Stall watchdog: 120 s idle | `src/lib/chat-stall.ts:25` |
| Stream log, reconnect replay, startup receipt sweep | `src/lib/chat/stream-log.ts`, `src/lib/chat/stream-replay.ts:1-60`, `src/lib/chat/receipt-sweep.ts:34`, table `ChatStreamEvent` (`schema.prisma:902`) |

### 2.3 The existing code execution pieces

| What | Where | State |
|---|---|---|
| `code_interpreter` tool | `src/lib/agent/code.ts:83-245` | Remote only (`isCodeInterpreterConfigured` `:73`). 120 s timeout `:56`, 32 MB per input, 30,000-char head-only stdout `:62`, 4,000-char stderr. Returns up to 4 images to the model `:200-209`; **every other produced file is discarded**. Declared `destructive_or_sensitive` `:109`. |
| Remote client | `src/lib/code-interpreter.ts:187-275` (`MicroVMSandboxAdapter`) | `GET /health`, synchronous `POST /execute` with base64 files in JSON. No cancel, no streaming, no idempotency key. |
| Unsafe fallback still in the module | `code-interpreter.ts:83` (`LocalIsolatedSandboxAdapter`), `:280-297` (`UnifiedCodeInterpreter` falls back to a host child process), `:325` (`codeInterpreterTool`) | Not registered, but exported and tested (`tests/code-interpreter.test.ts`). Must be removed from the hosted bundle. |
| Host child-process Python | `src/lib/sandbox/python.ts:147` | Local tests only; "not a tenant isolation boundary" (`runtime.ts` comment). |
| Server env | `.env.example:477-478` | `CODE_INTERPRETER_URL`, `CODE_INTERPRETER_TOKEN` empty. |
| Earlier analysis | `docs/file-understanding.md` ~797 | Lists "no remote sandbox configured" as gap #1. |
| Browser Pyodide in artifacts | `src/components/canvas/sandbox-frame.tsx:15` | A preview runtime in the reader's browser. Results never return to the model, so it is **not** tool execution. |

### 2.4 Approval broker and audit

| What | Where |
|---|---|
| Default policy `ask_for_any_change` | `src/lib/action-approval.ts:43` |
| Exact Alevr rules; `read_document`/`inspect_image` are `read_only`; **no rule for `code_interpreter`** | `action-approval.ts:99-140` (`:128`) |
| Classification: no rule and no read evidence = `unknown`, which asks under every policy | `action-approval.ts:221-283`, `decideActionPolicy` `:289` |
| A read that is allowed gets **no receipt** (so no broker replay protection) | `src/lib/action-approval-store.ts:430` |
| Replay of an executed/failed receipt; `executing` on recovery is refused (fail closed) | `action-approval-store.ts:455-462`, consume `:498` |
| Audit rows are connector-shaped (`connectorId` required) | `ToolInvocation`, `schema.prisma:2453` |

### 2.5 Work runner and Orbit agents (agent-core)

| What | Where |
|---|---|
| Vendored agent loop; sequential tool execution; every call answered on abort or throw | `runner/agent-core/src/loop.ts:690-767` (`:727`) |
| Work tool shapes (tier, risk, provenance) | `runner/agent-core/src/work/tools.ts` |
| Host workspace tools (`bash`, fs) removed from cloud Work, because the worker cwd is the production checkout | `work/tools.ts:217`, applied `scripts/work-runner.ts:2120` |
| Cloud toolset: connectors, research, browser, remote computer tools, deliverables, cloud files | `scripts/work-runner.ts:1762-2131` (computer `:1928`, deliverables `:2004`, cloud files `:2041`) |
| Provider spec: `tools: true` hard-coded for every model | `scripts/work-runner.ts:2879-2930` (`:2913`) |
| Agent-core adapters: Anthropic, OpenAI-compatible (Gemini goes through Google's OpenAI shim here), Responses | `runner/agent-core/src/providers/registry.ts` |
| Skills in Work: version pinning, scan, resources from the author's attachments, audit | `src/lib/work/skills.ts` (`resolveSkillResources` `:904`, `selectSkillAutomatically` `:1234`), `src/lib/work/skill-security.ts:224` |
| Orbit agent threads use the chat route with the agent context; their background tasks are Work runs | `route.ts:2675-2690`, `src/lib/agents/**`, `src/lib/chat/task-tool.ts`, `handoff-tool.ts` |

The Work runner runs as PM2 app `juno-work` on the web VM (`deploy/ecosystem.config.js:206`),
with a database pool budget of 2 (`:118`).

### 2.6 Other execution hosts

| Host | Where | Use for this rework |
|---|---|---|
| **Agent computers** (Docker, one persistent container per agent: Xvfb, Chromium, shell, python3, node, no pandas) | `src/lib/computer/**`, `src/lib/docker-cli.ts:5-9` (production calls `sudo -n /usr/local/sbin/juno-computer-docker-broker` **on the same machine**), `deploy/agent-computers/{Dockerfile,docker-broker.py,egress-proxy.py,firewall.sh,setup-vm.sh}` | Disabled in production, broker not installed. `setup-vm.sh:2` installs it "on the Juno VM", and `CONTINUATION_SECURITY.md:93` says the 887 MB VM is too small and a suitably sized host must be provisioned first. **There is no separate agent-computer VM in code or in production today, and no remote Docker transport.** The broker, egress proxy and firewall are the patterns to reuse. |
| **Cloud Code runner** (GitHub Actions, `ubuntu-latest`, 30 min, agent bash in a pinned container with `--network none`) | `.github/workflows/code-runner.yml:52`, `scripts/cloud-code-runner.mjs:1039-1136`, `runner/agent-core/src/tools/container-sandbox.ts:84` | Right for Code tasks. Wrong for chat: tens of seconds of cold start per run, public logs, minutes billing. The container flags are reused in §6.3. |
| **The user's Mac** (Work host relay; native Code) | `src/lib/work/relay.ts`, `WorkHost` (`schema.prisma:3097`), `native/Packages/JunoCode/**` | A local context only. Never implied by a hosted run. |
| **Voice relay** | `relay/src/**` | No tool calls at all. Voice-mode chat turns go through the chat route (canvas and tasks off). |

### 2.7 Skills

| What | Where |
|---|---|
| Import from files, zip/.skill packages, URLs and paste; companion files are **listed, never stored or executed** | `src/lib/skills/package.ts:18`, `:42`; same rule in `src/lib/skills/github.ts`; rationale `docs/skills-audit.md` §4.3 |
| SKILL.md parser | `src/lib/skills/skill-md.ts` |
| Storage: `WorkSkill`, `WorkSkillSource`, `WorkSkillVersion` (instructions, contract, requestedTools, scan, consent) | `schema.prisma:3220-3354` |
| Chat application: instructions appended (enveloped when imported), grant layer from what the turn has, no code tool in the grant vocabulary | `src/lib/chat/skills.ts:59` (`CHAT_SKILL_TOOLS`), `:109`, `:365` |
| Native Code: progressive disclosure, names in the prompt, body through `use_skill` | `native/Packages/JunoCode/Sources/JunoCodeRuntime/Tools/UseSkillTool.swift` |

### 2.8 Files and artifacts

| What | Where |
|---|---|
| Attachment rows (kind IMAGE/FILE, `origin` free string, `messageId`, `conversationId`) | `schema.prisma:930-999` (`origin` `:951`) |
| Conversation-scoped file access for runtime tools | `src/lib/agent/attachments.ts:27` |
| Object storage (buffer `putObject`, streamed reads) | `src/lib/storage.ts:64`, `:169` |
| User attachments linked to a message at persist time | `route.ts:2083-2112`; assistant message created at `route.ts:3067` (end of the turn) |
| Work outputs: `WorkArtifact`, `WorkRunIO`, cloud files | `schema.prisma:2982`, `:3543`; `scripts/work-runner.ts:2004-2118` |
| "Made by Alevr" collection name | `src/lib/brand/names.ts:23`, `:85` (D-038) |

### 2.9 Presentation

| Surface | Where |
|---|---|
| Receipt vocabulary shared by web and native (`run_code`: "Running code" / "Ran code") | `src/lib/chat/tool-receipt.ts:49-120` |
| What of a call may be shown (redaction, cuts, explained absences) | `src/lib/chat/tool-detail.ts` |
| Web rows and panels | `src/components/chat/activity-timeline.tsx`, `thought-process-panel.tsx`, `thought-process-model.tsx`, `session-outputs.tsx`, `src/components/code/code-activity.tsx` |
| Native run timeline (already expects canonical `run_code`) | `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeRunTimeline.swift:210`, `:696`, `NativeRunPresentation.swift:102` |
| Work transcript vocabulary (generated contract; Swift decodes some enums with no unknown case) | `contracts/work/juno-work-v1.json`, `runner/agent-core/VENDORED.md` item 4 |
| Capability contract | `contracts/capabilities/juno-capabilities-v1.json` |
| Thinking and motion rules | `docs/rework/brand/MOTION_AND_THINKING.md` |

### 2.10 Native JunoCode runtime (parity only)

`JunoCodeRuntime` already has what the web lacks: `SchemaValidator.swift` (required fields,
primitive types, unknown keys), `ToolScheduler.partitionIntoWaves` (`ToolScheduler.swift:60`,
parallel reads, serialised writes), `CommandOutputSpill.swift` (full output to a file, head and
tail to the model, paged reads), `UseSkillTool.swift`, `CommandSandboxProfile.swift` (seatbelt,
network off unless granted), long-lived `shell_start`/`shell_output`/`shell_kill`. Its tool names
are `run_command`, `run_tests`, `shell_*`, `use_skill`. The web design borrows the semantics, not
the code; native keeps its local context.

### 2.11 Prior unmerged design

`web/tools-thinking-research` holds `docs/chat-rework/SPEC.md` (3 adversarial reviews) and
`DECISIONS.md`. SPEC §3 (tool contract), §4 (loop: dispatcher, parallel groups, call ids RC-13,
timeouts, dedupe, final round, watchdog, history notes T7) and §5 (adapter fixes, per-model tool
record, probe index) are the right foundation and are adopted below. DECISIONS §4b/§4c already
settled: `run_code` is a `read` (remote sandbox on the user's own data, no egress); paid plans
only; metered per call; never on a host process; no code in private chats; lockdown blocks it.
The wave-1 WIP branches (`web/rework-ws1`, `ws3a`, `ws3b`, `ws4`) implement parts of it but were
never reviewed or gated, `ws1` has a parse error, and all are 480 commits behind the trunk
(merge base e5501f65). They are a source to port from with fresh review, not a branch to merge.

---

## 3. Gaps, with evidence

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| G1 | No execution backend | No service implements `/execute`; production env empty (`code.ts:73`, `.env.example:477`) | No model can run code today |
| G2 | Code needs an attachment | `route.ts:2445` | "Compute this" or "make a chart of these numbers" cannot run |
| G3 | Python would ask every time, and replay is not idempotent | No exact rule (`action-approval.ts:99-140`) so `unknown`; registry call id is random (`runtime.ts:93`) | An approval card per run; a retried call asks again |
| G4 | Call ids lost or random | `openai-compat.ts:569`, `openai-responses.ts:461` pass none; `gemini.ts:304` random; native tools drop it (`llm.ts:66`) | The contract in `mcp.ts:283-289` ("a random value per attempt would defeat replay protection") is broken on three adapters |
| G5 | Bad arguments execute | `safeToolInput` and the two `JSON.parse` fallbacks return `{}`; no schema validation on the web path | A malformed call runs with empty input instead of being sent back to the model |
| G6 | Parallel calls serialised | All four adapters and agent-core loop over calls with `await` | Slower turns; independent reads wait on each other |
| G7 | Four separate loops | Each adapter owns its loop and `MAX_TOOL_ROUNDS` | Fixes land in one adapter and not the others (G4 is the proof) |
| G8 | Produced files thrown away; no run record | `code.ts:200-209`; `ToolInvocation` is connector-only | No downloadable chart, CSV, workbook or PDF; nothing to inspect afterwards |
| G9 | Output cut head-only | `code.ts:62`, `:212-213` | Tracebacks at the end of long output are lost |
| G10 | Long runs vs the watchdog | 120 s idle (`chat-stall.ts:25`) vs 120 s + 10 s run (`code.ts:56`, `code-interpreter.ts:238`), no events while running | A slow run can be reported as a stalled model |
| G11 | Stop does not stop the run | No cancel call in the client | The sandbox keeps computing after Stop |
| G12 | Later turns are blind | `MessageForModel` is text + attachments (`types/llm.ts:6`) | "Now plot it by month" cannot build on the previous run |
| G13 | Unsafe fallback still exported | `code-interpreter.ts:280-297`, `:325` | One wrong import puts model code on the production host |
| G14 | No verified tool support | Probe sends "Reply with OK."; `agenticTools` guessed; Work hard-codes `tools: true` | The product cannot say truthfully which models run tools |
| G15 | Skills cannot run scripts | Companion files discarded at import (`package.ts:18`); no code tool in `CHAT_SKILL_TOOLS`; explicit slug only | A skill whose method is "run scripts/x.py" can only be described, not executed |
| G16 | Orbit cloud runs have no script execution | `withoutHostWorkspaceTools` (`work-runner.ts:2120`); computers disabled | Agents can only produce typed deliverables |
| G17 | No execution host fits production | Web VM at 10 apps / 887 MB; computers designed for the same VM and blocked on size (`CONTINUATION_SECURITY.md:93`) | A new host or a hosted provider is required (§6.2) |
| G18 | Voice realtime has no tools | `relay/src` | Realtime voice cannot run code; must say so |
| G19 | Wire has no progress or files | `types/llm.ts:56-90` | The UI cannot show a running script's output or its files |
| G20 | The good design is stranded | SPEC on an old branch; native already follows it | Implementing something else would fork native and web again |

---

## 4. Provider capability matrix

"Docs" is what the provider documents for its API; "Alevr today" is what the adapter code does;
"Verified" is evidence recorded by a live tool round trip in Alevr. **Verified is "none" for every
model**: no probe in the repository exercises tool calling, and the only recorded authenticated
production smoke is a plain Qwen text chat (`docs/rework/HANDOFF.md`). Every "docs" cell must be
confirmed by the probe in §6.11 before a model is marked compatible.

### 4.1 Chat adapters

| Adapter / family | Native tool calling (docs) | Parallel calls (docs) | Tool-result protocol | Images in a tool result | Tool-call streaming | Call id | Alevr today | Verified |
|---|---|---|---|---|---|---|---|---|
| **anthropic-native**: Fable 5.1, Opus 5.5, Sonnet 5, Haiku 4.5 | Yes, `tool_use` blocks; server tools (web search) alongside | Yes, several `tool_use` blocks per response (on by default; `disable_parallel_tool_use` exists) | One user message of `tool_result` blocks, in order, `tool_use_id` | Yes, text + image blocks inside `tool_result` | `input_json_delta` per block | `toolu_…`, unique per response | Sequential; passes `call.id`; images attached; `pause_turn` handled; forced final round `tool_choice: none`. The prior audit records that a forced `any`/named `tool_choice` returns 400 on Fable 5.1 and Opus 5.5 (SPEC §5.0) | None |
| **openai-responses**: gpt-5.5-pro, gpt-5.3-codex (and pro mode) | Yes, `function_call` items | Yes, `parallel_tool_calls` (default on) | `function_call_output` items with `call_id` | Output is a string in Alevr's use; images go in a following user turn as `input_image` | `response.function_call_arguments.delta`; Alevr waits for `output_item.done` | `call_id` | Sequential; **no call id passed to execute**; invalid JSON becomes `{}` | None |
| **openai-compatible (OpenAI)**: gpt-6 astra/sol/luna, gpt-5.6-terra, gpt-5.4-mini/nano | Yes, chat-completions `tool_calls` | Yes, `parallel_tool_calls` (default on) | One `role: "tool"` message per call, `tool_call_id` | String only; images in a following user turn as `image_url` | `delta.tool_calls[i].function.arguments` fragments | `call_…` | Same two bugs as Responses. SPEC §5.0 proposes moving every OpenAI model to Responses | None |
| **gemini-native**: 3.8 flash, 3.1 pro preview, 3.5 flash-lite | Yes, `functionCall` parts | Yes, several `functionCall` parts in one turn | One user turn of `functionResponse` parts in call order; `thoughtSignature` must be echoed | Alevr appends `inlineData` parts after the responses in the same turn (`gemini.ts:323-326`); whether Gemini 3 accepts this, or wants multimodal function responses, must be probed | Whole parts per chunk | Optional `functionCall.id` (ignored by Alevr) | **Random id per attempt** (`gemini.ts:304`); thought signatures preserved; Gemini < 3 cannot combine grounding with functions (route gate) | None |
| **openai-compatible (third party)**: Meta Muse, Zhipu GLM, Moonshot Kimi, DeepSeek, Mistral, xAI Grok, MiniMax, MiMo, Qwen | Accept OpenAI-format tools (catalog default; `mistral-medium-latest` marked not agentic) | Varies by host; unknown until probed | `role: "tool"` string | String only; image follow-up only for vision models (several GLM, Kimi-code, DeepSeek, ministral, codestral, qwen-long have no vision) | Varies; some hosts send whole calls, some finish with `stop` while emitting calls (handled, `openai-compat-round.ts:82`) | Host-specific; prior audit: Kimi uses `functions.<name>:<idx>`, several hosts restart numbering per response | Same two bugs | None |

### 4.2 Other runtimes

| Runtime | Loop | Parallel | Validation | Script execution | Notes |
|---|---|---|---|---|---|
| Work / Orbit runs (agent-core) | `runner/agent-core/src/loop.ts` | Sequential | Per tool | None in cloud (host tools stripped); `computer_exec` only with an agent computer (disabled in production) | Gemini runs through Google's OpenAI-compatible shim here, not the native adapter, so its tool behaviour can differ from chat. `tools: true` for all models. |
| Cloud Code (GitHub Actions) | agent-core `AgentSession` | Sequential | Per tool | `bash` in a pinned container, network `none` by default | Separate product context. |
| Native Code (Mac) | `JunoCodeRuntime` | Waves | `SchemaValidator` | Local, seatbelt, network off unless granted | Local context; outputs spill to files. |
| Voice realtime relay | none | n/a | n/a | none | Must report the limitation. |

---

## 5. Design principles

1. **Execution is a fact with a record.** A run exists only if a `ToolRun` row says so. Receipts,
   "Ran Python", file cards and the model's evidence all come from that row. No row, no claim.
2. **Reuse before building.** The SPEC tool contract, the broker, the stream log, attachments,
   skill pinning and scanning, the agent-computer broker/firewall patterns and the existing
   remote-sandbox client are extended, not replaced.
3. **Nothing new on the web VM.** No process, no Docker, no model code. The web side is an HTTP
   client inside the existing `juno-backend` and `juno-work` processes; sweeps fold into the
   existing `juno-work-scheduler`.
4. **The context is named.** Every run says where it ran: Alevr's sandbox (no internet, no access
   to your Mac), the agent's computer, the task's container, or your Mac. A hosted run never
   implies access to the user's machine.
5. **Fail closed, recover honestly.** An unknown outcome is reported as unknown and never re-run
   automatically. A missing capability is said, not simulated.
6. **Skills narrow, never widen.** A skill's scripts run with exactly the turn's sandbox profile.
7. **One vocabulary everywhere.** Tool ids, phases and receipts are shared by web, Orbit, Code,
   native and voice.

---

## 6. Target design

### 6.1 Execution contexts

| Context | User-facing label | Who uses it | Network | Files it can reach |
|---|---|---|---|---|
| `hosted_sandbox` (new, §6.2–6.3) | "Ran in Alevr's sandbox" | Chat, Orbit threads and tasks, voice-mode turns | None (v1) | This conversation's (or run's) attachments, earlier outputs, mounted skill bundles |
| `agent_computer` (existing, disabled) | "Ran on <agent>'s computer" | Orbit agents with a computer | Proxied public egress | The agent's own volume |
| `task_container` (existing) | "Ran in the task's container" | Cloud Code | `none` unless the environment grants it | The task worktree |
| `local_host` (existing) | "Ran on your Mac" | Native Code; Work runs targeted at a Mac | As the Mac's sandbox profile allows | Granted folders |
| Browser preview (existing) | none (an artifact preview) | Canvas Python/JS artifacts | Sandbox CSP | None of the account's |

The model is told which context its `run_code` uses in the tool description, and that the
sandbox cannot reach the internet or the user's computer.

### 6.2 Where hosted execution runs

| Option | Fits production? | Verdict |
|---|---|---|
| A. **`juno-exec` on a new execution host** (one Linux AMD64 VM near the web VM, e.g. 4 vCPU / 8 GB; later also the agent-computer host the security review already requires) | Yes: no load on the web VM; reuses the broker, egress-proxy and firewall patterns and their Python unittest suite | **Recommended.** The owner provisions the host (cost, region). |
| B. A hosted microVM provider (E2B-class) behind the same client contract | Yes: no host to run | Acceptable alternative. Adds a data processor (`docs/SUBPROCESSORS.md`), per-second cost, and the contract is adapted in the client. |
| C. The web VM | No: 10/10 PM2 apps, 887 MB, and model code beside every secret | Rejected. |
| D. GitHub Actions per call | No for chat: cold start, public logs, minutes | Rejected for chat; stays for Cloud Code. |
| E. The agent-computer containers | Not today: disabled, persistent GUI containers per agent, no pandas, and they would also need the new host | Remains its own context for agents that have a computer. |
| F. The user's Mac | Only as a local context | Never a fallback for hosted runs. |

The rest of this section assumes A. Under B, §6.3 becomes the provider's sandbox settings and the
client maps the same operations.

### 6.3 `juno-exec`: service, container profile and security boundary

**Service.** A small Python standard-library HTTP service (`deploy/exec-host/juno-exec.py`), run
by systemd with `DynamicUser`, `NoNewPrivileges`, `ProtectSystem=strict`, memory and task caps,
in the same style as `egress-proxy.py`. It never holds the Docker socket: every container
operation goes through a second root-owned argv-validating broker,
`juno-exec-docker-broker` (modelled on `deploy/agent-computers/docker-broker.py`), whose policy
pins the image digest, network, flags and limits. TLS terminates in nginx on the host. Requests
carry `Authorization: Bearer <CODE_INTERPRETER_TOKEN>` (the existing variable) and the host
firewall accepts the API port only from the web VM's address. The host stores no database URL,
no provider key and no user identity beyond an opaque account hash used for quotas.

**API (v1).** The existing synchronous `POST /execute` stays for compatibility; the client moves
to:

| Call | Purpose |
|---|---|
| `GET /v1/health`, `GET /v1/manifest` | Liveness; runtimes, versions and installed packages (fed into the tool description so the model knows what is available) |
| `PUT /v1/sessions/{session}/inputs/{name}` | Stream one input file into the session workspace (no base64 JSON in the web process) |
| `PUT /v1/sessions/{session}/skills/{slug}` | Stream a skill bundle (tar); extracted read-only |
| `POST /v1/runs` with `Idempotency-Key: <surface>:<session>:<callId>` | Start a run: `{ session, language: "python"\|"javascript"\|"bash", code, args?, timeoutMs, inlineWaitMs }`. The same key returns the same run, never a second one |
| `GET /v1/runs/{id}?wait=25` | Long-poll status: `queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`; exit code; byte counts |
| `GET /v1/runs/{id}/events?after=<seq>` | Server-sent stdout/stderr chunks for progress |
| `GET /v1/runs/{id}/output?stream=stdout&offset=&limit=` | Paged full output |
| `GET /v1/runs/{id}/files`, `GET /v1/runs/{id}/files/{name}` | Manifest and streamed download of produced files |
| `POST /v1/runs/{id}/cancel` | Kill the container; status `cancelled` |
| `DELETE /v1/sessions/{session}` | Drop the workspace (also swept after 30 min idle) |

**Container per run**, sharing one workspace volume per session (one session per chat
generation, or per Work run):

- `docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges
  --user 1000:1000 --pids-limit 256 --memory 1536m --memory-swap 1536m --cpus 1
  --tmpfs /tmp:rw,nosuid,nodev,size=256m`
- `/work`: the session volume (tmpfs-backed local volume with a 1 GB size cap, uid 1000), holding
  `inputs/` (read-only copies), anything earlier runs in the session wrote, and new outputs.
- `/skills/<slug>`: read-only, root-owned 0555/0444 copies of mounted bundles.
- Image pinned by digest (`juno-exec:1@sha256:…`): Debian slim, Python 3.12 with pandas, numpy,
  scipy, matplotlib, seaborn, openpyxl, xlsxwriter, python-docx, python-pptx, pypdf, pdfplumber,
  Pillow, reportlab; Node 22 with a small fixed set; bash and coreutils. No compilers, no package
  manager at runtime. The broker refuses any other image.
- Recommended additionally: the gVisor `runsc` runtime pinned in the broker policy, if the host
  supports it (ops decision), because the code comes from a model that may have read a hostile
  document or skill.

**Limits.** Inline wait 90 s in chat (the run continues after that; §6.7), hard wall clock 10 min
for chat and 30 min for Work; stdout + stderr kept up to 16 MB per run in a log file, beyond that
truncated with a note; produced files at most 20 per run, 25 MB each, 50 MB total; inputs at most
32 MB each, 64 MB per session; 2 concurrent runs per account, a host-wide queue bound, 20 runs
per turn.

**What the boundary is.** No network (DNS included). No host mounts. No credentials. Read-only
root. Non-root uid with no capabilities. Bounded CPU, memory, pids, disk and time. Data retention:
the session volume and its logs live at most 30 minutes after the last activity; durable copies
are only what the web side saves (outputs as attachments, the log as an object). Logs on the host
record ids, sizes and verdicts, never file contents. A network-enabled profile (through the
existing DNS-pinned egress proxy with per-run domain grants) is **not** part of v1; adding it
needs its own owner decision and makes the call `external_write` (§6.9).

**Missing dependencies** surface as the real `ModuleNotFoundError`; the tool result adds one line
("This sandbox has no internet, so packages cannot be installed. Installed: …") from the manifest,
so the model can choose another approach and tell the user truthfully.

### 6.4 One tool contract and one dispatcher

Adopt SPEC §3.1 (`ToolSpec`, `PortableSchema`, `ResolvedTool`, `ToolOutcome`, `ToolContext`),
§3.2–3.3 (risk mapping, broker rule), §3.5 (aliases: `code_interpreter` → `run_code`), §3.6
(entitlements), §4.2 (`executeToolBatch`), §4.3 (call ids RC-13), §4.4 (per-tool timeouts,
excluding approval waits), §4.5 (dedupe), §4.6 (final round per provider), §4.8 (watchdog) and
§4.9 (history notes) as written, with these additions:

- **`ToolOutcome.status`** gains `outcome_unknown`. `ToolOutcome.run` carries `{ runId, context,
  language, exitCode, durationMs, stdoutBytes, stderrBytes, files: [{ attachmentId, name, mime,
  bytes }] }` for execution tools.
- **`LlmEvent` tool phases**: `call`, `status` (`queued` / `awaiting_approval` / `running` with
  `timeoutMs`), **`progress`** (new: last ≤ 20 lines of stdout/stderr and byte counts, at most one
  per second per call, logged to `ChatStreamEvent` like other frames, and touching the watchdog),
  `result`.
- **Every adapter** builds `ToolCallInput[]` and calls the dispatcher; none executes tools itself.
  The provider id is echoed on the wire (`tool_use_id`, `call_id`, `tool_call_id`,
  `functionResponse.id` when Gemini sent one). The Alevr `callId` (provider id, or `jc_<round>_<n>`,
  suffixed when a host reuses ids) goes to the broker, the `ToolRun` key, the stream frames and the
  registry (removing `crypto.randomUUID()` at `runtime.ts:93`, and passing it through
  `withNativeTools`).
- **Validation before dispatch**: JSON parse errors and schema violations become error results
  that name the problem ("Nothing was run"), sent back to the model; nothing runs with `{}`. The
  rules match native `SchemaValidator` (required, primitive types, enum, unknown keys refused for
  Alevr tools; shallow for connector tools).
- **Parallel**: consecutive `parallelSafe` read tools run concurrently, at most 4 in flight;
  `run_code` is not parallel-safe (calls share a workspace) and runs in call order.
- **Cancellation**: when the turn aborts, every outstanding call still gets a `cancelled` result
  (the agent-core rule, `loop.ts:713-750`), so a transcript never ends on an unanswered call.
- **agent-core** keeps its own loop (it already answers every call and is built standalone) and
  gets the same `run_code`/`check_run`/skill tool shapes through its injected-effects pattern.

### 6.5 The execution tools

`run_code` (replaces `code_interpreter`; alias kept for stored skill grants and native):

```
run_code {
  language: "python" | "javascript" | "bash",   // default python
  code: string,                                  // the program, or a command for bash
  files?: string[],                              // attachment names to place in /work/inputs; default all
  timeout_seconds?: integer,                     // ≤ surface maximum
  reason?: string                                // shown in the row
}
```

- Offered when: a sandbox is configured and healthy, the model has **verified** tool calling
  (§6.11), the plan and workspace allow it, the turn is not private and not in lockdown. It no
  longer requires an attachment.
- Returns: exit status, duration, stdout and stderr as head 8 KB + tail 8 KB with an omitted-bytes
  note when larger (parity with native `CommandOutputSpill`), up to 4 produced images (vision
  models), and a manifest of every produced file (name, type, size, "attached to this
  conversation").
- If the run outlives the inline wait, the result is `running` with a `run_id` and the output so
  far; the run continues on the host.

`check_run { run_id, wait_seconds?: ≤ 60, stream?: "stdout" | "stderr", offset?: integer }`:
status, more output (paged), and, once finished, the same result as `run_code`. Read-only.

Stop is the user's Stop button (and Work's stop command): it cancels the turn, the dispatcher
calls `POST /runs/{id}/cancel`, and the run ends `cancelled`.

### 6.6 Durable run record

New additive model (migration in the execution lane):

```prisma
model ToolRun {
  id              String    @id @default(cuid())
  userId          String
  surface         String    // chat | work | voice
  sessionId       String    // chat generation id, or Work run id
  callId          String
  conversationId  String?
  workRunId       String?
  tool            String    // run_code | check_run
  language        String
  context         String    // hosted_sandbox | agent_computer | ...
  skillVersionId  String?
  skillBundleDigest String?
  codeDigest      String
  code            String    @db.Text   // field-encrypted like Message.activity
  status          String    // queued | running | succeeded | failed | timed_out | cancelled | outcome_unknown | refused
  exitCode        Int?
  stdoutTail      String?   @db.Text   // field-encrypted, bounded
  stderrTail      String?   @db.Text   // field-encrypted, bounded
  logKey          String?   // full output in object storage
  remoteRunId     String?
  inputs          Json      @default("[]")  // attachment ids + digests
  outputs         Json      @default("[]")  // attachment ids
  leaseUntil      DateTime?
  startedAt       DateTime?
  finishedAt      DateTime?
  createdAt       DateTime  @default(now())
  @@unique([sessionId, callId])
  @@index([userId, createdAt])
  @@index([status, leaseUntil])
}
```

- **Before dispatch** the dispatcher creates or loads the row by `(sessionId, callId)`. A terminal
  row returns its stored outcome (no second run). A `running` row is re-attached by polling the
  host with `remoteRunId`. The host's own idempotency key is a second guard.
- **Lease**: the executing process renews `leaseUntil`. A sweep inside the existing
  `juno-work-scheduler` (no new process) takes rows whose lease expired: if the host still has the
  run, it finishes collecting it ("finished after the reply was interrupted"); otherwise the row
  becomes `outcome_unknown`. Nothing is re-run automatically; the user or the model can start a
  new run, which is a new call.
- The broker receipt (if any) and the `ToolRun` are linked by the same `callId`. Because an allowed
  read gets no receipt (`action-approval-store.ts:430`), the `ToolRun` key, not the broker, is the
  replay guard for execution.

### 6.7 Files and artifacts

- **Inputs**: the conversation's attachments (existing scope helper), so earlier outputs (which
  are attachments) are automatically available to later runs; skill bundles; nothing else.
  Uploaded to the session one file at a time by stream.
- **Outputs**: every file a run creates or changes under `/work` (excluding `inputs/`) is
  downloaded one at a time, stored with `putObject`, and becomes an `Attachment` with
  `origin: "tool_output"` (the column is a free string; no enum migration), `kind` IMAGE or FILE,
  `conversationId` set at once and `messageId` linked when the assistant message is persisted (the
  route already links user attachments the same way). They appear in the answer as file cards,
  in the conversation's files and under "Made by Alevr" in the Library, and they are indexed like
  uploads so `read_document` can open them later.
- **Work and Orbit runs**: outputs also get `WorkRunIO` output rows; `create_deliverable` stays the
  path for typed documents.
- **Full logs** go to object storage (`logKey`), readable from the run detail by the owner of the
  conversation only.
- **Interrupted turns**: outputs already stored stay attached to the conversation and listed on
  the run record. Files from a **cancelled** run are not attached; the record says they were
  discarded.

### 6.8 Skills as executable workflows

1. **Bundles.** The importers (`package.ts`, `github.ts`, paste, upload) keep a skill's folder
   instead of listing it: allowed text types (md, txt, py, js, mjs, ts, sh, json, yaml, csv, html,
   css) and small binaries (images, fonts, office templates), at most 200 files and 5 MB
   (the existing `MAX_PACKAGE_BYTES`), no symlinks, no absolute or `..` paths. Stored once as a
   content-addressed tar in object storage. `WorkSkillVersion` gains nullable `bundleKey`,
   `bundleDigest`, `bundleManifest` (path, size, sha256, kind: instructions / reference / script /
   asset). This reverses `skills-audit.md` §4.3 and needs the owner's decision (§9).
2. **Scanning and consent.** `skill-security.ts` also scans bundle scripts (network calls,
   subprocess use, paths outside `/work`, credential paths, encoded blobs). A version whose bundle
   has scripts and whose trust is not `user_authored` gets `requiresConsent`; consent uses the
   existing flow and audit kind `skill_permission_consent`.
3. **Discovery.** `use_skill { name }`, as in native Code: its description lists the enabled,
   clean skills the turn may use (name and one line each, at most 30). Listed for the model only
   when `autoSelect` is on or the skill is user-authored (owner decision, §9); an explicit
   `/slug` still arms any enabled skill as today. Loading returns SKILL.md (enveloped when
   imported) and the bundle manifest, and mounts the bundle into the session.
4. **Reading.** `read_skill_file { skill, path, offset? }` returns a referenced file, enveloped
   when imported, paged at 40,000 characters.
5. **Running.** Scripts run through `run_code` (for example `language: "bash"`,
   `code: "python /skills/quarterly-summary/scripts/build.py inputs/sales.csv out.xlsx"`). The
   `ToolRun` records `skillVersionId` and `skillBundleDigest`.
6. **Never widening.** The grant stays `resolveSkillPermissions` over the turn's single layer;
   `CHAT_SKILL_TOOLS` gains `code: "run_code"`, granted only when the turn already has it. The
   sandbox profile (no network) is the turn's, whatever the skill requests. A skill asking for
   network, connectors or a shell on a surface without a sandbox is told it did not get them.
7. **Work and Orbit** get the same three tools through agent-core shapes; the Work runner already
   pins versions and writes `skill_applied`.

### 6.9 Permissions and policy

| Rule | Value |
|---|---|
| Broker exact rules | `juno_runtime:run_code` `read_only` (precondition: profile has no network; otherwise not attached), `juno_runtime:check_run`, `use_skill`, `read_skill_file` `read_only` |
| Network-enabled profile (future) | Separate action, `external_write`: asks under every policy, never a standing approval |
| Lockdown | No execution or skill tools attached |
| Private chats | Not attached (outputs would persist) |
| Plans | Paid plans (DECISIONS §4c default, owner confirms) |
| Workspaces that restrict tools | Off unless the workspace allows code |
| Voice-mode turns | Attached; spoken presentation (§6.12) |
| Metering | `ApiSpend` `juno-tool:run_code` per sandbox-second; price from the host cost |
| Budgets | 20 runs per turn; 2 concurrent per account; daily cap per plan |

### 6.10 The loop: inspect → run → inspect → repair → deliver

- One prompt section replaces `CODE_INTERPRETER_NUDGE`: when a task needs computing, reading a
  file's contents, transforming data or producing a file, use `run_code`; read the output; when it
  fails, read stderr and fix the program; produced files are attached automatically, so refer to
  them by name; state only results a tool returned; say plainly when something could not be done.
  It includes the sandbox context line and a short runtime manifest.
- Round budgets follow SPEC (4 / 10 / 16 / 24 by effort) with the forced final round.
- History notes (SPEC §4.9) summarise earlier runs in later turns ("run_code python → exit 0,
  2 files: chart.png, summary.csv"), so follow-up requests can build on them; the files
  themselves are already attachments.
- Work runs use the same tools with the longer limits.

### 6.11 Capability gating and coverage

- **Tool round-trip probe** (probe version 2, results in `ModelCapabilityProbe.evidence`): one
  function `multiply(a, b)`; the model must call it with valid JSON, receive the result and state
  it. Then: two independent calls in one response (parallel), and for vision models an image in a
  tool result. Verdicts: `verified`, `failed`, `untested`, with date and probe version.
- **Gating**: `run_code`, `check_run` and the skill tools are attached only for `verified` models.
  For any other model the turn carries a short capability note, so the model says it cannot run
  code with this model and names verified alternatives, instead of writing code and implying it
  ran. Work stops hard-coding `tools: true`.
- **Coverage record**: `contracts/capabilities/tool-runtime-coverage.json` (generated by the probe
  and the acceptance suite, reviewed in Git, no secrets): model × {round trip, parallel, tool
  images, run_code end to end, skill end to end} and surface × runtime, each with verdict, date
  and evidence (test name or run id). An untested model is never marked compatible. The capability
  contract gains `codeExecution` and the degradation kinds `code_execution_unavailable` and
  `tool_calling_unverified`, added the way existing kinds were (native projections regenerated).

### 6.12 Presentation across Chat, Orbit, Code, native and voice

- **Phases** (from runtime events only): "Thinking" only while the model reasons; then the real
  action: "Running Python", "Running JavaScript", "Running a shell script", "Reading the <name>
  skill", "Waiting for your answer" (an approval). Settled: "Ran Python · 2.4 s · 2 files",
  "Python failed · exit 1", "Stopped", "Timed out after 2 min", "Outcome unknown, the server
  restarted while this ran" with "Run again" (a new call).
- **ThinkingMark** (MOTION_AND_THINKING.md): the Continuum mark sits only on the single active row,
  makes one path-handoff pass when a phase starts, passes coalesced to at most one per 1.6 s,
  holds still while waiting or on error, is static under Reduced Motion and hidden when not
  visible. Settled rows carry no mark. Phase changes are announced once through the existing live
  region. No progress percentages.
- **Run detail** (Activity panel and the row's disclosure): the code (collapsed), stdout/stderr
  head and tail with "Show full output", exit status, duration, context line ("Ran in Alevr's
  sandbox: no internet, no access to your Mac"), produced files. Images render inline in the
  answer; other files are file cards. No status pills or dots (owner rule).
- **Orbit**: Work events reuse `tool_started`, `tool_finished`, `artifact_created` and `degraded`
  (`capability_unavailable`); no new event kinds, so shipped native builds keep decoding.
- **Code (web)**: `code-activity.tsx` reads the same receipt module; Cloud Code keeps its context
  label.
- **Native (macOS, iOS)**: `NativeRunTimeline` already canonicalises `run_code`; it gains
  tolerant decoding of `progress` and `run.files`, and file cards that open attachments.
- **Voice**: voice-mode turns speak the outcome, never code or raw output; a run longer than a few
  seconds gets one spoken phase ("Running the numbers"); files are attached to the transcript
  message and mentioned once. The realtime relay has no tools: asked to run code, it says it can
  do that in the chat. That limitation is recorded in the coverage file.

---

## 7. Implementation lanes

Four lanes with disjoint file ownership. L1 lands its contract types (`src/lib/tools/types.ts`,
the `LlmEvent` additions) on the trunk first, in a small commit; L2 can start its host work at the
same time; L3 starts once L2 has landed `src/lib/exec/types.ts`; L4 builds against fixtures and
finishes with the end-to-end acceptance. Every lane follows the landing protocol and the gates.
Live provider runs need provider keys in the lane's `.env.development.local`; today it holds only
`AUTH_SECRET`, so the owner supplies development keys or authorises a bounded live run. Until
then the live cells stay `untested`.

Required validation from the brief:

- **V1** A supported model reads a CSV, runs Python, computes a result and returns a generated
  chart or file whose content is inspected.
- **V2** Another provider does the same through its adapter, including a real failure, a corrected
  run and a truthful final answer.
- **V3** A skill needing referenced instructions/resources and a script is selected, read,
  executed and produces its artifact.
- **V4** A non-Python script runs in the intended context, with stdout, stderr and exit status
  recorded.
- **V5** Stop, long output, reconnect and replay never claim success early or repeat a
  consequential operation.
- **V6** Permission decisions, unsupported capabilities and missing dependencies produce
  understandable, recoverable states with enough evidence for the model.
- **V7** Web, native and voice surfaces show output and task state; coverage is recorded per
  provider, runtime and surface; untested models are not marked compatible.

### L1 · Tool contract and providers (`rf/tool-contract`)

Scope: SPEC §3–§5 ported onto the trunk with fresh review (from `web/tools-thinking-research` WS0
and the useful parts of `web/rework-ws1`/`ws3a`/`ws3b`; web search/fetch and research stay out):
`src/lib/tools/**` (types, registry, entitlements, dispatcher, schema validation, call ids,
dedupe), the four adapters calling the dispatcher, `src/lib/llm.ts`, `src/lib/agent/runtime.ts`
(call id through, registry folded into the contract), `src/lib/mcp.ts` (execute options),
`src/types/llm.ts` and `src/types/chat.ts` (status/progress frames), `src/lib/chat-stall.ts`,
`src/lib/chat/history-notes.ts`, `src/lib/chat/tool-policy.ts`, `prompt-sections.ts`, the tool
round-trip probe (`model-capability*.ts`, `scripts/probe-models.ts`), capability gating and the
honest-limitation note, and `src/app/api/chat/route.ts` integration (entitlement rows for
`run_code`, `check_run`, `use_skill`, `read_skill_file` keyed to the providers L2 and L3 expose).

Acceptance:
- Offline scripted-transport tests (SPEC §5.0 seam) for all four adapters: parallel calls in one
  response, invalid JSON and schema violations returned as errors (nothing executed), unknown
  tool, Stop mid-batch (every call answered `cancelled`), provider id echoed, Alevr call id stable
  across a replayed round, Gemini `functionResponse.id` when given (**V5, V6**).
- Watchdog: a 130 s tool call with progress frames completes without a stall (**V5**).
- Probe evidence recorded for at least one model per adapter family the owner has keys for;
  every other model `untested`; a non-verified model gets the limitation note and no execution
  tools (**V6, V7**).
- Gates: typecheck, lint, `npm test`, `models:capabilities:audit`, chat wire classification.

### L2 · Execution runtime (`rf/exec-runtime`)

Scope: `deploy/exec-host/**` (service, broker, policy, image Dockerfile, nginx/firewall/systemd
setup, Python unittests in the style of the agent-computer suite, a local Docker Desktop
profile on a free port 3170–3179), `src/lib/exec/**` (client, `types.ts` with the `SkillMount`
interface, ToolRun store, output capture to attachments, sweep), `src/lib/tools/specs/run-code.ts`
and `check-run.ts`, the `ToolRun` migration, broker exact rules in `src/lib/action-approval.ts`,
retirement of `src/lib/code-interpreter.ts` fallbacks, `src/lib/sandbox/python.ts` and the old
`src/lib/agent/code.ts`, agent-core `run_code`/`check_run` shapes
(`runner/agent-core/src/work/tools.ts`), Work/Orbit wiring in `scripts/work-runner.ts` (including
the call site for L3's `skillToolsFor`, returning nothing until L3 lands), and the ToolRun sweep in
`scripts/work-scheduler.ts`. Metering rows.

Acceptance (route tests on a throwaway Postgres, a local `juno-exec` on Docker Desktop, and the
real provider loop from L1):
- **V1**: attach `sales.csv`; "average revenue by region and a bar chart". One `ToolRun`
  `succeeded`, exit 0; an `Attachment` `origin: "tool_output"`, `image/png`, decodes with sharp to
  non-zero dimensions; the answer's numbers equal the test's own computation; the image went back
  to the model in the tool round.
- **V2** (with L1, a second adapter family): a CSV whose header differs from the prompt's wording
  makes the first run fail (`KeyError`, exit 1); the model reads stderr and fixes it; rows:
  one `failed`, one `succeeded`; the final answer does not claim the failed run succeeded.
- **V4**: Node and bash programs that write to both streams and exit 3: `ToolRun.exitCode = 3`,
  both tails stored, status `failed`, the model's result shows both streams; the run reports its
  context.
- **V5**: Stop during a 60 s loop kills the container (host reports `cancelled`) and leaves no
  success claim; 5 MB of output gives the model head + tail + paging note and stores the full log;
  re-dispatching the same `(session, callId)` returns the stored result and the host counts one
  run; killing the backend mid-run ends in "finished later" or `outcome_unknown`, never a re-run;
  a dropped SSE client resumes through `/api/chat/stream/[generationId]` with one run.
- **V6**: `import polars` (not installed) gives `ModuleNotFoundError` plus the manifest line and a
  truthful answer; lockdown and private turns carry no execution tool; sandbox down produces
  `capability_unavailable` and the model says so.
- Infrastructure unittests: broker refuses any other image, network, mount, capability, user or
  limit; host API refuses missing/invalid tokens; idempotency key reuse with a different body is
  refused.
- No process added to `deploy/ecosystem.config.js`; `security:check` and the release gates pass.

### L3 · Skill workflows (`rf/skill-workflows`)

Scope: bundle storage and manifest (`src/lib/skills/bundle.ts`, importers in `package.ts`,
`github.ts`, upload and paste routes), `WorkSkillVersion` bundle columns (migration), bundle
scanning and consent (`src/lib/work/skill-security.ts`, `src/lib/work/skills.ts`), chat grant
vocabulary and discovery (`src/lib/chat/skills.ts`, `skill-runtime.ts`), `use_skill` and
`read_skill_file` specs (`src/lib/tools/specs/`), `SkillMount` provider for L2's client,
`skillToolsFor` for Work runs (`src/lib/skills/run-tools.ts`), the Customize > Skills page showing
bundle files, scripts and consent.

Acceptance:
- **V3**: a fixture package `quarterly-summary.zip` (SKILL.md tells the model to read
  `reference/style.md` and run `scripts/build.py` on the attached CSV) is imported, scanned and
  consented; in chat the model finds it through `use_skill` (and, separately, through `/slug`),
  reads the reference, runs the script; the `ToolRun` carries the skill version and bundle digest;
  `out.xlsx` is attached and opens with the expected sheet and values; an audit row records the
  skill applied. The same through a Work run.
- **V6**: a skill requesting network or connectors keeps the turn's grant (no network in the
  sandbox, a test proves a socket fails); a bundle with a symlink, `..` path or oversize file is
  refused at import with a readable reason; an unconsented imported skill with scripts is
  explained, not run.
- Existing skill tests (`chat-skills`, `work-skills`, `work-skill-security`, `skill-md`,
  `skills-github`, skill package suite) still pass.

### L4 · Surfaces and acceptance (`rf/tool-surfaces`)

Scope: web run rows, run detail, file cards, ThinkingMark live-row behaviour
(`src/components/chat/**`, `src/components/code/code-activity.tsx`, `src/lib/chat/tool-receipt.ts`,
`tool-detail.ts`), Orbit activity mapping, voice-mode spoken presentation and the realtime relay's
honest limitation, native ChatKit/WorkKit decoding and presentation (JunoNativeKit; Swift checks
through the Juno Code workflow), the capability contract additions and native projections, the
coverage file and `docs/rework/TOOL_RUNTIME_COVERAGE.md`, dev gallery states for every phase.

Acceptance:
- **V7**: the V1–V4 scenarios shown in the real web chat (authenticated dev server on 3170–3179),
  an Orbit agent thread and one of its tasks, web Code activity, a voice-mode turn, and macOS/iOS
  ChatKit snapshot tests; each phase, failure, Stop, timeout and `outcome_unknown` state captured
  settled; Reduced Motion and screen-reader announcements checked.
- Coverage file complete: every current model has a verdict per capability; surfaces × runtimes
  filled; untested cells say so.
- Gates: typecheck, lint, `npm test`, shell/tokens/wire/parity/icon checks, native contract
  checks, native snapshot tests.

---

## 8. What production needs (the owner decides)

Nothing below has been done. None of it is needed to merge the lanes, because every tool stays
detached without a configured, healthy sandbox and a verified model.

1. **Execution host** (option A) or **hosted provider** (option B). For A: a Linux AMD64 VM
   (suggested 4 vCPU / 8 GB, same region as the web VM), DNS name and TLS, firewall allowing the
   API only from the web VM, `sudo bash deploy/exec-host/setup.sh` run by the owner, image built
   and pinned. For B: an account, a data-processing review, and the provider's sandbox set to no
   network.
2. **Secrets**, set by the owner on the web VM only: `CODE_INTERPRETER_URL`,
   `CODE_INTERPRETER_TOKEN`. Never in Git or logs.
3. **Migrations** through the normal deploy: `ToolRun`; `WorkSkillVersion` bundle columns. The
   probe evidence uses the existing JSON column.
4. **Probe run** (billed, one small round trip per model per check) to fill the coverage file.
5. **Price** per sandbox-second for metering.
6. **Feature switch** `TOOL_RUNTIME=1` after the host is healthy.
7. Later, separately: the same host can serve agent computers once the security review's
   "before enabling agent computers" list is done (`SECURITY_REVIEW_2026-10-02.md:251`).

## 9. Owner decisions

1. Option A (own execution host) or B (hosted provider).
2. Reverse `skills-audit.md` §4.3: store skill bundles and run their scripts inside the
   no-network sandbox, with consent for imported skills that carry scripts.
3. Automatic skill discovery in chat: only skills with `autoSelect` on (recommended), or every
   user-authored skill too.
4. Confirm the inherited defaults: `run_code` on paid plans only, not in private chats, blocked by
   lockdown, metered per second (chat-rework DECISIONS §4c).
5. Network-enabled sandbox profile: not in v1 (recommended), or a later opt-in per run.
6. Move every OpenAI model to the Responses adapter (SPEC §5.0), or keep chat completions.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Container escape from model-written or skill code | No network, no credentials on the host, non-root, no capabilities, read-only root, optional gVisor, separate host from the web VM |
| Data leaving through the sandbox | No network in v1; outputs return only to the conversation's owner |
| Web VM memory | Streamed uploads, one output file at a time, size caps; no new process |
| Cost runaway | Per-turn and per-day caps, per-second metering, concurrency limits |
| Provider quirks undiscovered | Probe before offering; untested stays untested |
| Native decoding of new fields | Additive fields with tolerant decoding; no new enum cases in shipped Work contracts |
| The stranded SPEC branches drift further | L1 ports and closes them; the WIP branches are archived once ported |
