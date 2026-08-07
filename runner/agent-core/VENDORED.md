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
