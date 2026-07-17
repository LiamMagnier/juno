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
   rate-limits + concurrency-caps the user (see Abuse controls), then
   `workflow_dispatch`es `.github/workflows/code-runner.yml` with
   `{ taskId, repoOwner, repoName, baseRef, callbackBase }` as inputs. **None of
   these inputs are secret** — no credential rides the workflow inputs, so there is
   nothing sensitive for GitHub to echo into the public Actions log. Only this
   server can dispatch the workflow (`GITHUB_DISPATCH_TOKEN`), so the taskId in the
   inputs is a trustworthy binding. The user message + task row persist only AFTER
   a successful dispatch, so a dispatch failure leaves nothing orphaned.
2. **Runner** (`code-runner.yml` + `scripts/cloud-code-runner.mjs`): the job runs
   with `permissions: { contents: read, id-token: write }`. The driver first
   **fetches a GitHub Actions OIDC JWT** at runtime (from the auto-provisioned
   `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, audience
   `juno-cloud-code`) and calls `GET /api/code/tasks/[id]/runner-context` with
   `Authorization: Bearer <oidc-jwt>`. That returns the clone token + a fresh
   `cct_` task token + the model catalog. It then checks out the target repo
   (clone token), `npm i` the vendored agent-core, calls
   `POST /api/code/tasks/[id]/claim` (task-token auth) to flip to `running`,
   runs the agent against the prompt with the backend proxy pointed at
   `callbackUrl/api/agent` (so provider calls + billing go through Juno), streams
   each `AgentEvent` to `POST /api/code/tasks/[id]/events` (task-token auth,
   batched), and on completion commits the diff to a branch, opens a PR, and
   posts a terminal `status` event carrying the PR URL. The OIDC request token is
   GitHub-auto-masked and the JWT is short-lived and never logged.
3. **Auth.** The runner-context **handshake is credential-free on the wire**: the
   runner proves its identity with a GitHub-signed OIDC token (never a secret in
   the inputs), and the ONE Juno-minted credential (`cct_`) only ever crosses the
   wire inside the runner-context response body.
   - **OIDC handshake** (`src/lib/github-oidc.ts`): `GET runner-context` accepts a
     GitHub Actions OIDC JWT (`Authorization: Bearer <jwt>`) and NOTHING else.
     `verifyGithubActionsOidc` fetches + caches GitHub's JWKS from
     `https://token.actions.githubusercontent.com/.well-known/jwks` (cached by
     `kid`, refreshed on an unknown `kid`), verifies the **RS256 signature**, and
     checks the claims: `iss = https://token.actions.githubusercontent.com`,
     `aud = juno-cloud-code`, `exp`/`nbf` valid, `repository = CLOUD_CODE_REPO`
     (env allowlist, default `LiamMagnier/juno`), and `job_workflow_ref` (or
     `workflow_ref`) starts with `<repo>/.github/workflows/code-runner.yml@`. Any
     other token — a browser session (→ **403**, so the clone token never reaches a
     browser), a `cct_` task token, a forged/expired/wrong-claims JWT (→ **401**) —
     is refused. The route is also **single-use**: the first call atomically stamps
     `runnerClaimedAt` (an additive nullable column) and hands back the clone
     token + a fresh task token; a second call is `409 runner_context_consumed`. It
     gates on status too (queued/running; terminal → 409).
   - **Task token** (`cct_…`, ~30 min, `src/lib/cloud-code-token.ts`): HMAC over
     `{ taskId, exp, kind }` with a dedicated secret (`CLOUD_CODE_SECRET`, added to
     `PROD_ENV`; **never** shared with the runner). Minted only inside the
     runner-context response and used for the runner's later callbacks.
     `requireTaskAuth(taskId)` accepts either a real user session **or** a valid
     task token for that exact task, so claim/events/respond/cancel serve both the
     native host and the cloud runner. Those routes (and the `/api/agent` proxy)
     reject a task-token caller once the task is terminal (done/failed/cancelled →
     409), so a runner cannot act after its run ends.

   The runner holds **no** credential the agent can reach during the agent phase:
   the driver fetches its OIDC token once, keeps the task + clone tokens in JS
   memory only (never process.env, a file, or a command line), tears down the git
   askpass before running the agent, and hands agent shells a hard-scrubbed env
   (and strips `ACTIONS_*` + secret-shaped vars from its own environ). See
   `scripts/cloud-code-runner.mjs` and `runner/agent-core/VENDORED.md`
   (divergence #3, the caller-provided child-process env).
4. **UI.** Composer gains a target toggle (Device ⇄ Cloud) and a repo picker
   backed by `GET /api/code/github/repos` (real connector repos, honest
   disconnected state). Cloud sessions show a "Runs in the cloud · opens a PR"
   banner; the existing event stream, cancel, and PR link render as-is.

## Hard rules

- The runner never receives `.env`, the DB URL, `AUTH_SECRET`, or any provider
  key — and **no credential rides the workflow inputs**. It authenticates the one
  bootstrap call with a GitHub-signed OIDC token, then holds only a per-task
  token + the callback URL. Provider calls proxy through Juno.
- No fake data: the repo picker lists the user's actual repos; if GitHub is
  disconnected, the cloud target is disabled with an honest connect prompt.
- Device-backed Code (native host) is unchanged and remains the default.

## Configuration (env)

All three live in the `PROD_ENV` secret (see `.github/workflows/deploy.yml`):

- **`CLOUD_CODE_SECRET`** (required for cloud): HMAC key that signs the `cct_`
  task token. Kept separate from `AUTH_SECRET`. Never shipped to the runner.
- **`GITHUB_DISPATCH_TOKEN`** (optional): a GitHub token with `actions:write` on
  `LiamMagnier/juno`, used ONLY to `workflow_dispatch` the runner. Absent →
  cloud task creation returns `503`. Never leaves the server.
- **`CLOUD_CODE_REPO`** (optional, default `LiamMagnier/juno`): the repository
  whose GitHub Actions OIDC token is trusted to redeem runner-context. The
  verifier requires the token's `repository` claim AND `job_workflow_ref` to be
  this repo's `code-runner.yml`. Override only in a fork.

The runner uses no configured secret at all: it fetches its OIDC token from the
GitHub-provisioned `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
(present because the job has `id-token: write`).

## Abuse controls

Cloud task creation (`POST /api/code/tasks`, cloud branch) is gated so one user
can't fan out an unbounded fleet of runners:

- **Rate limit:** 10 cloud dispatches per user per minute (`code-cloud:<userId>`,
  same Postgres limiter as `/api/agent`) → `429`.
- **Concurrency cap:** at most 3 simultaneously-active (queued/running/
  awaiting_approval) cloud tasks per user → `429`.

## Failure handling

The driver posts its own terminal `failed` event on any catchable error (it holds
the task token in memory). For a hard crash that kills the driver, we keep **no**
token on disk to reconstruct auth from: the task stays `running` until the job's
`timeout-minutes` (30) reaps it. A server-side stuck-task sweep is a follow-up.
