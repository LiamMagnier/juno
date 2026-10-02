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

The surfaces read whatever the producing lanes send, tolerantly, through `readToolRun`
(`src/lib/chat/tool-run.ts`) on the web and `NativeActivityWire` plus
`NativeToolRunPresentation` in JunoChatKit. Two shapes are accepted, field by field, and a value
of the wrong type costs that field, never the row:

1. **The tool contract's shape** (rf/tools-L1-tool-contract): the fields ride on the row's
   `tool` detail (`ClientToolDetail`). This is what the chat route sends.

   ```ts
   tool: {
     server, name,             // name: "run_code" | "check_run" | "use_skill" | "read_skill_file" ("code_interpreter" is an alias)
     args?, result?, status?, resultNote?, durationMs?,   // the existing redacted detail
     callId?, timeoutMs?,
     phase?: "queued" | "awaiting_approval" | "running",  // live only
     progress?: { lines: { stream, text }[], stdoutBytes?, stderrBytes? },   // live only
     outcome?: "succeeded" | "failed" | "denied" | "expired" | "cancelled" | "outcome_unknown",
     errorCode?,               // "timeout" | "cancelled" | "unavailable" | "outcome_unknown" | ...
     run?: { runId, context, language?, status, exitCode?, durationMs?, stdoutBytes?, stderrBytes?,
             files: { attachmentId, name, mime, bytes }[], skill?: { slug, versionId?, bundleDigest? } }
   }
   ```

   `outcome_unknown` also arrives as `status: "failed"` with `errorCode: "outcome_unknown"`;
   both read as unknown, never as a failure or a success. A run record status of `timed_out`
   reads as a time-out.

2. **The typed record** `call` (chat-rework SPEC §2.4, which native already decodes), with
   `call.run`, `call.progress` and `error.code: "outcome_unknown"` meaning the same things. The
   run record may also carry `stdout` / `stderr` heads and tails with `omittedBytes`, the program
   `code`, `filesDiscarded`, `logUrl` (same-origin only) and `finishedLater`; when it carries no
   streams, the run detail shows the call's `result` text, which is what the model read.

Facts the producers should know:

- **File links.** The contract's run files carry no URL. Images open through
  `/api/attachments/{id}`; other files show as cards that say they are in the conversation's
  files, without a link, until the record carries a same-origin `url` or the reply is saved and
  the message's own attachment tiles take over (the run strip then stops drawing them, so a
  file is never shown twice).
- **Orbit task runs** use `workToolStartedPayload`, `workToolFinishedEvents` and
  `workRunCapabilityDegraded` (`src/lib/work/tool-run-events.ts`): the existing event kinds
  `tool_started`, `tool_finished`, `artifact_created` and `degraded` (`capability_unavailable`)
  with additive `summary`, `run` and `runPhase` keys, so shipped clients keep decoding.
- **Wire status.** Until the contract lands on the trunk, `contracts/chat/juno-chat-wire-v1.status.json`
  lists the eight `ClientToolDetail` keys native decodes under `nativeOnly`. When the contract
  lands, those entries move into `fields` as `native` (the check fails until they do).

## V7 acceptance status

| Scenario | Status (2026-10-02) |
|---|---|
| Every phase settled (queued, running with progress, waiting for approval, succeeded with files, failed, JavaScript exit 3, timed out, stopped, outcome unknown, unavailable, missing package, skill read and script, long output, the pre-rework row, and the tool contract's shapes) in web chat rows, the run strip and its files, the Thought process dock, web Code activity, the Orbit task feed and the voice sentences | Built and fixture-tested; captured in `/dev/tool-runs` light and dark, Reduced Motion on and off, and at phone width with no sideways scroll (screenshots kept outside the repository in `juno/.claude/local-tools/refoundation-artifacts/shots/tool-surfaces`) |
| macOS and iOS ChatKit decoding, words and file cards | `NativeToolRunTests` (decoding of both wire shapes, words, malformed records) and offscreen snapshots of the run detail at the Mac panel width (360 pt) and the iPhone width (390 pt), light and dark; `NativeWorkToolRunTests` for the Orbit log |
| Mac Activity panel | Shows a run's context, exit and file cards (`ActivityPanel.swift`); the app target compiles. The Mac transcript snapshot suite cannot run on the trunk today: its test target does not compile (`DesktopShellContractTests` expects a shell action the contract no longer has, and the connections screen needs the native lane's repair bff7598b) |
| Reduced Motion and screen-reader announcements | One polite announcement per phase change ("Running Python.", "Ran Python, 2 files."), none for progress, none for a stored turn, and only the working run when a live turn remounts; the live mark is the in-tree orb until the Continuum ThinkingMark lands, still under Reduced Motion |
| V1 to V4 shown in the authenticated web chat, an Orbit thread and task, web Code, a voice-mode turn | **Not run**: needs the tool-contract, execution and skill lanes merged, a sandbox and provider keys |
| Coverage per provider, runtime and surface | This page; every live cell untested |
