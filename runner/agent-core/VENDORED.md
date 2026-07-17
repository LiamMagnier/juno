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

1. **`src/providers/proxy.ts` — task-bearer auth.**
   `BackendConfig` gains an optional `authorization?: string` field, and
   `createProxyProvider` sends `{ Authorization: config.authorization }` when it is
   set (falling back to `{ Cookie: config.cookie }` otherwise). The runner
   authenticates every `/api/agent/*` proxy call with a short-lived per-task bearer
   token, not a session cookie.
   **Upstream `juno-app/core/src/providers/proxy.ts` needs the same field for
   parity** (do not edit `juno-app` from the runner worktree — track it as a
   follow-up on that repo).

2. **`tsconfig.json` — self-contained.**
   Upstream extends `../tsconfig.base.json`, which does not exist in this repo. The
   vendored `tsconfig.json` inlines the identical `compilerOptions` so `tsc` builds
   standalone. No source/behaviour change.

Nothing else is modified — `src/` is otherwise a byte-for-byte copy.

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
