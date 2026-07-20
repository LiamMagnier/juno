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
