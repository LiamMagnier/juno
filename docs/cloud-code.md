# Cloud Juno Code (GitHub Actions runner)

Status: **in progress** (started 2026-07-17). Goal: run Juno Code sessions in the
cloud from the website — pick a GitHub repo, describe a task, the agent runs with
no local machine and opens a pull request. Mirrors claude.ai/code's "cloud" model.

## Why GitHub Actions (not the prod VM, not a new service)

The Code agent runs **arbitrary bash by design**. It therefore cannot share the
1 GB Oracle prod VM: that box holds `.env` (Neon `DATABASE_URL`, `AUTH_SECRET`,
every provider key), so one `cat .env` from an agent turn would exfiltrate the
whole product. It's also too small to clone + `npm install` + run a model loop.

GitHub Actions gives us, for free (the `LiamMagnier/juno` repo is **public** →
unlimited minutes): a fresh ubuntu-latest VM per run (~16 GB RAM), strong
per-job isolation, the repo already checked out, and — via the user's GitHub
**connector** (`repo` scope) — authorization to clone their repo and open a PR.
Trade-off accepted: cold start ~20–40 s, and approvals are **plan → approve →
run** (Actions is non-interactive) rather than mid-run prompts.

## Reused, not rebuilt

- **`@juno/agent-core`** (`juno-app/core/`): the agent loop (`agent.ts`),
  `bash`/`fs` tools, permission gating (`permissions.ts`), checkpoints, usage
  reporting, and — crucially — the **backend-proxy provider**
  (`providers/proxy.ts`), which streams through Juno's `/api/agent` with
  server-side keys and bills the account plan. The runner uses this so no
  provider key ever touches the Actions environment.
- **`CodeTask` / `CodeTaskEvent`**: already model a run and stream events; the
  web code-session view already renders `/api/code/tasks/[id]/events` (SSE) with
  approval cards + cancel. Cloud runs are just a new task **target**.
- **GitHub connector** (`src/lib/connectors.ts`, `repo read:user`): already
  stores an OAuth token we can hand the runner to clone + push + open a PR.

## Architecture

1. **Dispatch.** Web composer submits a cloud task: `POST /api/code/tasks` with a
   `target: "cloud"` + a real connector repo (`owner/name`, `baseRef`). The route
   mints a **task-scoped bearer** (signed, ~30 min TTL, audience = this taskId
   only — NOT a session, NOT `.env`) and `workflow_dispatch`es
   `.github/workflows/code-runner.yml` with `{ taskId, callbackUrl, repo, baseRef }`
   as inputs; the token rides as a masked input the workflow re-masks immediately.
2. **Runner** (`code-runner.yml` + `scripts/cloud-code-runner.mjs`): checks out
   the target repo (connector token), `npm i` the vendored agent-core, calls
   `POST /api/code/tasks/[id]/claim` (task-token auth) to flip to `running`,
   runs the agent against the prompt with the backend proxy pointed at
   `callbackUrl/api/agent` (so provider calls + billing go through Juno), streams
   each `AgentEvent` to `POST /api/code/tasks/[id]/events` (task-token auth,
   batched), and on completion commits the diff to a branch, opens a PR, and
   posts a terminal `status` event carrying the PR URL.
3. **Auth.** New `src/lib/cloud-code-token.ts`: HMAC over `{ taskId, exp }` with a
   dedicated secret (`CLOUD_CODE_SECRET`, added to `PROD_ENV`; **never** shared
   with the runner beyond the derived per-task token). `requireTaskAuth(taskId)`
   accepts either a real user session (existing) **or** a valid task bearer for
   that exact task, so the claim/events/respond/cancel routes serve both the
   native host and the cloud runner without widening any other surface.
4. **UI.** Composer gains a target toggle (Device ⇄ Cloud) and a repo picker
   backed by `GET /api/code/github/repos` (real connector repos, honest
   disconnected state). Cloud sessions show a "Runs in the cloud · opens a PR"
   banner; the existing event stream, cancel, and PR link render as-is.

## Hard rules

- The runner never receives `.env`, the DB URL, `AUTH_SECRET`, or any provider
  key — only a per-task token + the callback URL. Provider calls proxy through
  Juno.
- No fake data: the repo picker lists the user's actual repos; if GitHub is
  disconnected, the cloud target is disabled with an honest connect prompt.
- Device-backed Code (native host) is unchanged and remains the default.
