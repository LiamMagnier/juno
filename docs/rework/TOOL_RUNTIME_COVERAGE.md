# Tool runtime coverage

What has been proven about running tools, code and skills in Alevr, per model, per surface and
per runtime. The record is [`contracts/capabilities/tool-runtime-coverage.json`](../../contracts/capabilities/tool-runtime-coverage.json).
The design is [TOOL_RUNTIME_DESIGN.md](TOOL_RUNTIME_DESIGN.md) §6.11 and §6.12. This page is
reviewed in Git and holds no secrets.

Status on 2026-10-02: **nothing is verified yet.** No provider keys are present in the lanes
(`.env.development.local` holds only `AUTH_SECRET`), no execution host or hosted sandbox exists,
and agent computers are disabled in production. So every model cell and every real-run surface
cell says `untested`, and no model is marked compatible. The surfaces themselves are built and
tested against fixtures, which the matrix records separately as "presentation fixture-tested".

## How to read it

| Verdict | Meaning |
|---|---|
| `verified` | A live run recorded evidence (a probe run id, a test name or a `ToolRun` id) on a date. |
| `failed` | A live run recorded that it does not work, with the same evidence. |
| `untested` | Nobody has exercised it. Never read as "probably works". |
| `unsupported` | It cannot work by design, and a test proves the product says so (the realtime voice relay). |
| `n/a` | The surface never reaches that runtime, or the model has no vision (tool images). |

**Compatible** means `roundTrip` verified and `runCodeE2E` verified, by probe version 2 or later.
Nothing else makes a model compatible. The catalog's `agenticTools` flag is a guess, kept in the
JSON as `catalogAgenticTools` for context, and never counts as evidence. The capability contract
(`contracts/capabilities/juno-capabilities-v1.json` v4) carries the matching degradations:
`tool_calling_unverified` when a turn asks to run code on a model that is not verified, and
`code_execution_unavailable` when the sandbox is missing or the chat or plan does not allow it.

## Recording evidence

- **Model cells** come from the tool round-trip probe (tool-contract lane: `multiply(a, b)`, two
  parallel calls, an image in a tool result) and from the V1 to V3 acceptance runs (`runCodeE2E`,
  `skillE2E`). Record with `recordModelVerdict` (`src/lib/tool-runtime-coverage.ts`): a verified or
  failed cell must carry a date and evidence.
- **Matrix cells** come from the V7 acceptance run: a real run shown on that surface from that
  runtime, captured settled.
- Then run `npx tsx scripts/generate-tool-runtime-coverage.ts`. It rebuilds the model list from
  the catalog (new models arrive untested, departed models leave), carries every recorded verdict
  over and rewrites the tables below. `--check` fails on drift, on a current model with no row and
  on a model marked compatible without evidence, and `tests/tool-runtime-coverage.test.ts` runs
  the same rules under `npm test`.

## Models

<!-- coverage:models:start -->
49 current chat models; 0 compatible. Every other cell is untested until a live probe or acceptance run records evidence.

| Model | Adapter | roundTrip | parallel | toolImages | runCodeE2E | skillE2E | Compatible |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `anthropic:claude-fable-5-1` | anthropic-native | untested | untested | untested | untested | untested | no |
| `anthropic:claude-opus-5-5` | anthropic-native | untested | untested | untested | untested | untested | no |
| `anthropic:claude-sonnet-5` | anthropic-native | untested | untested | untested | untested | untested | no |
| `anthropic:claude-haiku-4-5` | anthropic-native | untested | untested | untested | untested | untested | no |
| `openai:gpt-6-astra` | openai-compatible | untested | untested | untested | untested | untested | no |
| `openai:gpt-6-sol` | openai-compatible | untested | untested | untested | untested | untested | no |
| `openai:gpt-6-luna` | openai-compatible | untested | untested | untested | untested | untested | no |
| `openai:gpt-5.6-terra` | openai-compatible | untested | untested | untested | untested | untested | no |
| `openai:gpt-5.5-pro` | openai-responses | untested | untested | untested | untested | untested | no |
| `openai:gpt-5.4-mini` | openai-compatible | untested | untested | untested | untested | untested | no |
| `openai:gpt-5.4-nano` | openai-compatible | untested | untested | untested | untested | untested | no |
| `openai:gpt-5.3-codex` | openai-responses | untested | untested | untested | untested | untested | no |
| `google:gemini-3.8-flash` | gemini-native | untested | untested | untested | untested | untested | no |
| `google:gemini-3.1-pro-preview` | gemini-native | untested | untested | untested | untested | untested | no |
| `google:gemini-3.5-flash-lite` | gemini-native | untested | untested | untested | untested | untested | no |
| `meta:muse-spark-1.3` | openai-compatible | untested | untested | untested | untested | untested | no |
| `meta:muse-spark-1.3-contributor` | openai-compatible | untested | untested | untested | untested | untested | no |
| `zhipu:glm-5.3` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `zhipu:glm-4.7-flash` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `zhipu:glm-4.7-flashx` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `zhipu:glm-4.6v-flashx` | openai-compatible | untested | untested | untested | untested | untested | no |
| `zhipu:glm-4.6v-flash` | openai-compatible | untested | untested | untested | untested | untested | no |
| `moonshot:kimi-k3` | openai-compatible | untested | untested | untested | untested | untested | no |
| `moonshot:kimi-k2.7-code` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `moonshot:kimi-k2.7-code-highspeed` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `deepseek:deepseek-flash` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `deepseek:deepseek-v4-pro` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `mistral:mistral-medium-latest` | openai-compatible | untested | untested | untested | untested | untested | no |
| `mistral:mistral-large-latest` | openai-compatible | untested | untested | untested | untested | untested | no |
| `mistral:mistral-small-latest` | openai-compatible | untested | untested | untested | untested | untested | no |
| `mistral:codestral-latest` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `mistral:ministral-14b-latest` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `mistral:ministral-8b-latest` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `mistral:ministral-3b-latest` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `xai:grok-4.7` | openai-compatible | untested | untested | untested | untested | untested | no |
| `xai:grok-4.1-fast` | openai-compatible | untested | untested | untested | untested | untested | no |
| `xai:grok-build-0.1` | openai-compatible | untested | untested | untested | untested | untested | no |
| `xai:grok-4.20-multi-agent-0309` | openai-compatible | untested | untested | untested | untested | untested | no |
| `minimax:MiniMax-M3` | openai-compatible | untested | untested | untested | untested | untested | no |
| `minimax:MiniMax-M2.7-highspeed` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `mimo:mimo-v2.6-pro` | openai-compatible | untested | untested | untested | untested | untested | no |
| `mimo:mimo-v2.6-pro-ultraspeed` | openai-compatible | untested | untested | untested | untested | untested | no |
| `mimo:mimo-v2.6-flash` | openai-compatible | untested | untested | untested | untested | untested | no |
| `mimo:mimo-v2.5` | openai-compatible | untested | untested | untested | untested | untested | no |
| `qwen:qwen3.8-max` | openai-compatible | untested | untested | untested | untested | untested | no |
| `qwen:qwen3.7-plus` | openai-compatible | untested | untested | untested | untested | untested | no |
| `qwen:qwen3.8-flash` | openai-compatible | untested | untested | untested | untested | untested | no |
| `qwen:qwen-long` | openai-compatible | untested | untested | n/a | untested | untested | no |
| `longcat:LongCat-2.0` | openai-compatible | untested | untested | n/a | untested | untested | no |
<!-- coverage:models:end -->

## Surfaces and runtimes

A cell's verdict is about a **real run** shown on that surface. "Presentation fixture-tested"
means the surface renders every phase of a run from fixtures in tests and in the `/dev/tool-runs`
gallery, which is necessary but is not evidence that a run happened.

<!-- coverage:matrix:start -->
| Surface | Alevr's sandbox (juno-exec) | An agent's computer | The task's container (Cloud Code) | Your Mac |
| --- | --- | --- | --- | --- |
| Web chat | untested (presentation fixture-tested) | n/a | n/a | n/a |
| Orbit agent thread | untested (presentation fixture-tested) | n/a | n/a | n/a |
| Orbit agent task (Work run) | untested (presentation fixture-tested) | untested (presentation fixture-tested) | n/a | untested (presentation fixture-tested) |
| Web Code activity | n/a | n/a | untested (presentation fixture-tested) | untested (presentation fixture-tested) |
| Voice-mode chat turn | untested (presentation fixture-tested) | n/a | n/a | n/a |
| Realtime voice call (relay) | unsupported | unsupported | unsupported | unsupported |
| macOS ChatKit | untested (presentation fixture-tested) | n/a | n/a | untested (presentation not built) |
| iOS ChatKit | untested (presentation fixture-tested) | n/a | n/a | n/a |
<!-- coverage:matrix:end -->

The realtime voice relay has no tool calls at all. Every call's instructions say that it cannot
run code, make files, browse or use tools, and that it can be done in the chat
(`relay/src/session.ts`, `VOICE_TOOL_LIMIT`; `relay/tests/voice-tool-limit.test.ts`). Voice-mode
chat turns go through the chat route and can run code there; they speak the outcome, never the
code or raw output, say one phase for a run longer than four seconds, and name produced files
once (`src/lib/chat/tool-run-speech.ts`).

## What the surfaces read

The surfaces are built against the wire the design specifies, read tolerantly by
`readToolRun` (`src/lib/chat/tool-run.ts`) and its Swift twin (`NativeToolRunPresentation`,
`NativeActivityWire.CallWire`). The producing lanes emit, on the activity row of a call:

```ts
call: {
  callId, tool,               // "run_code" | "check_run" | "use_skill" | "read_skill_file" ("code_interpreter" is an alias)
  status,                     // ToolCallStatus, plus "outcome_unknown" (and "timed_out" on the run record)
  durationMs?, timeoutMs?, startedAt?,
  args?: { language?, reason?, name?, skill?, path?, run_id? },   // ToolSpec.present, safe to show
  error?: { code, detail? },  // "timeout" | "cancelled" | "unavailable" | "blocked" | "not_permitted" | "invalid_args" | ...
  run?: {                     // the client projection of ToolOutcome.run (§6.4); persisted via sanitizeToolRunRecord
    runId?, status?, context?, language?, exitCode?, durationMs?,
    stdout?: { head, tail?, omittedBytes, totalBytes? }, stderr?: { ... },
    code?, codeTruncated?, files?: [{ attachmentId, name, mime, bytes, url? }],
    filesDiscarded?, skill?: { name, slug? }, agentName?, logUrl?, finishedLater?
  },
  progress?: { seq, lines (at most 20), stdoutBytes, stderrBytes }   // live only
}
```

Two producer obligations follow from this:

1. `serializeActivity` (`src/lib/serializers.ts`) must keep `call` on reload, passing `call.run`
   through `sanitizeToolRunRecord`, or a reloaded conversation loses its exit codes and file
   cards. Until then a stored run falls back to the legacy detail.
2. Orbit task runs use `workToolStartedPayload`, `workToolFinishedEvents` and
   `workRunCapabilityDegraded` (`src/lib/work/tool-run-events.ts`): the existing event kinds
   `tool_started`, `tool_finished`, `artifact_created` and `degraded` (`capability_unavailable`)
   with additive `run` and `runPhase` keys, so shipped clients keep decoding.

## V7 acceptance status

| Scenario | Status |
|---|---|
| Every phase settled (running, waiting for approval, succeeded, failed, timed out, stopped, outcome unknown, unavailable) in web chat rows, the run strip, the Thought process panel, web Code activity, the Orbit task feed and voice sentences | Built and fixture-tested; captured in `/dev/tool-runs` |
| macOS and iOS ChatKit decoding, words and file cards | Built and fixture-tested in `NativeToolRunTests` |
| Reduced Motion and screen-reader announcements | One announcement per phase change through a polite live region, none for progress or a stored turn; the live mark is still under Reduced Motion |
| V1 to V4 shown in the authenticated web chat, an Orbit thread and task, web Code, a voice-mode turn | **Not run**: needs the tool-contract, execution and skill lanes merged, a sandbox and provider keys |
| Coverage per provider, runtime and surface | This page; every live cell untested |
