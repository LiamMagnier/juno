# Vendored agent core

This directory is a **vendored copy** of `juno-app/core` (`@juno/agent-core`), the
same agent loop the Juno Mac app runs. The Cloud Code GitHub Actions runner
(`.github/workflows/code-runner.yml` + `scripts/cloud-code-runner.mjs`) builds and
imports it so a cloud task executes with the exact same `AgentSession`, tools, and
permission engine as the desktop surface.

It is a **copy on purpose**: the runner lives in the `juno` (website) repo and must
build without a dependency on the `juno-app` checkout. Treat `juno-app/core` as the
source of truth and re-sync when it changes.

## Divergences from upstream `juno-app/core`

Keep this list exhaustive so a re-sync is mechanical.

1. **`tsconfig.json` — self-contained.**
   Upstream extends `../tsconfig.base.json`, which does not exist in this repo. The
   vendored `tsconfig.json` inlines the identical `compilerOptions` so `tsc` builds
   standalone. No source/behaviour change.

2. **`src/providers/errors.ts` — new file: the provider failure taxonomy.**
   `ProviderCallError` / `classifyProviderError`, plus `Retry-After` parsing.
   Called from `openai-compat.ts` and `anthropic.ts` at the two points where an
   SDK error still carries an HTTP status, and re-exported from
   `src/work/index.ts` (as a *value* — the executor's failover test is an
   `instanceof`).

   Why: an empty-bodied 429 reached a user as the literal string
   `429 status code (no body)`, because nothing between the SDK and the database
   ever asked what kind of failure it was. See the file header.

3. **`src/loop.ts` — turn-level retry, and a tool throw no longer corrupts the
   transcript.**
   Two changes in `runAgentLoop`:
   - The step is wrapped in a retry loop for `ProviderCallError.retryable`,
     honouring `retryAfterMs`, with full jitter and an **abortable** wait
     (`sleepUnlessAborted`). The wait races the caller's signal deliberately: a
     bare `setTimeout` would make Stop take as long as the back-off, and would
     let the run's own runtime ceiling overshoot by the same amount. Retry is
     refused once anything has streamed, so a partial answer is never shown
     twice. New optional `AgentLoopOptions.onProviderRetry`.
   - `executeToolCall` throwing no longer escapes past
     `opts.messages.push(results)`. Every outstanding `tool_call` still gets a
     `tool_result` before the error propagates. Without this the Work runner's
     `askQuestion` — which throws by design when its wait for a person expires —
     checkpointed an assistant message carrying an unanswered `tool_call`, which
     is the exact shape `work/session.ts`'s own header says every provider
     rejects. The pause path, whose entire purpose is to be resumed, was the one
     reliably writing a transcript that could not be.

4. **`src/work/session.ts` — `WorkSessionCallbacks.onProviderRetry`.**
   Optional, forwarded straight to `AgentLoopOptions.onProviderRetry`. Operator
   -facing only: it is deliberately NOT an emitted event, because the transcript
   vocabulary is a generated cross-language contract and
   `JunoWorkDegradationKind` decodes on the Swift side as a plain string enum
   with no unknown-case fallback. Adding a kind here would throw inside every
   shipped iOS/macOS build the first time a run was throttled.

   **All of 2–4 are bug fixes that belong upstream in `juno-app/core`.** Port
   them rather than reverting them on the next re-sync.

Former divergences #1 (proxy `authorization` bearer auth) and #3 (caller-provided
child-process env) have been **merged upstream** — `src/` is now a byte-for-byte
copy of `juno-app/core/src`, including the subagent orchestration layer
(`subagents.ts`, `loop.ts`) that landed with the 2026-07 multi-agent work.

## Divergences added in September 2026

- `src/tools/types.ts`, `src/tools/bash.ts`, `src/types.ts`, `src/agent.ts`:
  `ToolResult.exitCode` travels on `tool_finished`, so a web transcript can
  say "failed" from the exit status rather than from parsing " — ok" off the
  end of a summary. Re-apply when re-syncing.
- `src/agent.ts` (`AgentOptions.reasoningEffort`, threaded to `runAgentLoop`
  and to subagents through `SubagentHost`): the effort the composer chose used
  to reach runner-context and stop there. Re-apply when re-syncing.
- `src/agent.ts` (`AgentSession.seedHistory`): writes earlier user/assistant
  turns into a fresh session before its first `prompt()`, so a cloud follow-up
  is read as the next turn of its conversation rather than the first turn of a
  new one. Refuses on a session that already holds messages.

- `src/tools/container-sandbox.ts` (`ContainerSandboxConfig.network = "full"`
  and `ContainerSandboxConfig.forwardEnv`): the two things a **Cloud Code
  environment** needs the sandbox to be able to express. `full` joins docker's
  default bridge — the honest answer for a run that has to install a package
  the model only discovers it needs, which the "fetch it in the setup script"
  argument cannot cover. `forwardEnv` is a list of NAMES emitted as
  `--env NAME`, so docker copies each value out of its own (already scrubbed)
  process environment: the caller has to name a variable twice for it to
  arrive, and no value ever appears in an argv. Neither widens the boundary the
  file's header describes — nothing of the host's environment can cross by
  accident, and the default of both is still "no network, no variables".
  `src/test/container-sandbox.test.ts` pins both. Re-apply when re-syncing.
- `src/agent.ts` (`AgentSession.queueUserMessage` / `hasQueuedUserMessages` /
  `takeQueuedUserMessages`) and `src/loop.ts`
  (`AgentLoopOptions.takeQueuedUserText`): mid-run steering. Text queued while
  a turn runs is folded into the user message the next step sends (the tool
  results of the previous step, or the prompt on the first), keeping the
  user/assistant alternation every provider requires; the promise resolves
  when the text leaves the queue, which is what the cloud runner's `steer_ack`
  is timed on. `src/test/queue.test.ts` covers both. Re-apply when re-syncing.
- `src/tools/types.ts` (`ToolResult.images`), `src/work/types.ts`
  (`WorkToolDefinition.signatureInput`), `src/work/tools.ts` (`BrowserToolDeps.screenEpoch`),
  `src/work/session.ts` (`scrubCheckpointMessages`, `OMITTED_SCREENSHOT_MARKER`,
  `result.images` block forwarding, `signatureInput` hook), `src/loop.ts`
  (`pruneOldMessageImages`, `OMITTED_EARLIER_SCREENSHOT_MARKER`), `src/providers/anthropic.ts`
  (`THINKING_BINDING_BETA`, `bindingTolerantThinking`, `anthropicRequestHeadersForThinking`),
  and `src/work/computer-tools.ts` (`computerTools`, `REMOTE_TOOL_NAMES`):
  Agents v2 persistent desktop tools, screenshot image channel, checkpoint base64
  scrubbing, 3-image pruning + Anthropic `drop_block` thinking binding, and screen
  epoch anti-repetition signatures. Re-apply when re-syncing.


## Refoundation, Phase 9 (runtime parity with the Swift engine)

There is no `juno-app` checkout any more and the Mac runs the Swift engine, so
this copy is the cloud engine's source of truth. These changes bring it level
with the Swift runtime; each has tests in `src/test/`.

- **Permission rules** (`src/permission-rules.ts`, `src/permissions.ts`): the
  Mac's grammar and precedence — `permissions.{allow,ask,deny}` rules such as
  `Bash(npm run *)`, `Edit(src/**)`, `Read(.env)`, `WebFetch(domain:…)`,
  `mcp__server`; deny > ask > allow; per-segment command checks with
  substitutions opened; destructive always asks; plan refuses. The project's
  settings files only narrow unless a host passes `trustProjectSettings`
  (the cloud runner never does); the older top-level tool-name lists are still
  read. `contracts/agent/permission-rules.fixtures.json` is run by both
  `src/test/permission-rules.test.ts` and the Swift
  `PermissionRuleFixtureTests.swift`, family table included.
- **Prompt caching** (`src/providers/anthropic.ts`): breakpoints on the last
  tool, the system prompt, the previous request's newest block and the newest
  block. `AgentLoopOptions.sessionState` keeps the system prompt byte-stable by
  moving what changes (date, mode, Work's plan) into `<session_state>` blocks
  appended to the newest user message. `Usage` gains `cacheReadTokens` /
  `cacheWriteTokens`; `inputTokens` stays inclusive of them.
- **Thinking continuity** (`src/providers/anthropic.ts`, `src/loop.ts`,
  `src/providers/openai-responses.ts`): signed `thinking` / `redacted_thinking`
  blocks and sealed OpenAI `reasoning` items are recorded in stream order,
  stamped with their model, and replayed unchanged to that model only. The
  thinking-binding beta (above) is still sent: it is what makes dropping a
  block, on a model change or after compaction, safe.
- **OpenAI Responses** (`src/providers/openai-responses.ts`): `store: false`
  plus `include: ["reasoning.encrypted_content"]`, selected per model with
  `api: "responses"` on a catalog entry or provider spec model.
- **Compaction** (`src/compaction.ts`): a port of the Mac's
  ConversationCompactor / CompactionSummarizer — model-written summary with a
  structural fallback, step-boundary cuts that never split a call from its
  result, earlier memories folded rather than stacked, and compact-and-retry
  when a request is refused as too long. On for Code and Work sessions.
- **Failure typing** (`src/providers/errors.ts`, `src/loop.ts`): the proxy's
  402 `QUOTA_EXCEEDED` is `plan_limit` (never retried, never failed over),
  over-long prompts are `context_overflow`, and a tool that throws surfaces as
  `ToolExecutionError`. `failureCodeOf` maps any of them to the protocol's
  error codes.
- **Attribution** (`src/providers/proxy.ts`): `BackendConfig.runId` is sent as
  `x-juno-run` on every proxied call; the cloud runner passes its task id.

## Hosted code execution (October 2026, TOOL_RUNTIME_DESIGN.md §6.5)

- `src/work/tools.ts` (`execTools`, `ExecToolDeps`, `ExecToolResult`): `run_code`
  and `check_run` for Work and Orbit runs. The effect is injected (the web app's
  `src/lib/exec` runs the program on the execution host and owns the ToolRun
  record, files and metering). Risk `safe`, tier `structured_file`, output
  untrusted (scanned and enveloped). Not host workspace tools, so
  `withoutHostWorkspaceTools` keeps them.
- `src/tools/types.ts` (`ToolContext.callId`, `ToolContext.signal`) and
  `src/work/session.ts` (sets both): a tool whose effect is recorded per call
  keys it on the provider's call id, and Stop reaches a running program.
  `src/test/exec-tools.test.ts` covers both. Re-apply when re-syncing.

## Build

```sh
cd runner/agent-core
npm i
npm run build   # tsc -> dist/
```

`dist/` and `node_modules/` are git-ignored; CI regenerates them.

## Re-syncing from upstream

```sh
cp -R ../../../juno-app/core/src runner/agent-core/src   # adjust path to your checkout
```

then re-apply divergence #1 to `src/providers/proxy.ts` (divergence #2 is the
already-committed `tsconfig.json`, leave it).
