# Cloud Code — isolation audit

Audited 2026-07-22 against the completion brief's Stage 11 checklist, by reading
the runner workflow, the dispatch route, the runner-context handoff and the
event ingest path.

## Verdict

**Cloud is safe to remain enabled.** The controlling requirement — *never
execute an agent inside Next.js, an API handler, PM2, the production web process
or the production checkout* — is satisfied structurally, not by policy: the
agent runs on a GitHub Actions `ubuntu-latest` runner, a different machine from
production entirely. Nothing in the request path executes agent code.

This is an audit of what is already built. No isolation property was added here.

## The checklist, item by item

| requirement | status | where |
|---|---|---|
| ephemeral workspace | **yes** | GitHub-hosted runner VM, destroyed when the job ends |
| isolated checkout | **yes** | the runner clones the target repo fresh; production's checkout is never touched |
| timeout | **yes** | `timeout-minutes: 30` in `code-runner.yml` |
| cancellation | **yes** | `POST /api/code/tasks/[id]/cancel`; the task's status gate stops further work |
| scoped secrets | **yes** | see "The credential handoff" below |
| output limits | **yes** | `MAX_BODY_BYTES = 256 KB` per event POST, 413 past it |
| cleanup | **yes** | the runner VM is discarded by GitHub; nothing persists host-side |
| owner isolation | **yes** | every task is `userId`-scoped; the runner authenticates per task |
| audit trail | **yes** | Actions run log plus the task's own event stream |
| replay protection | **yes** | see "Single-use handoff" below |
| CPU and memory boundaries | **yes, inherited** | GitHub-hosted runner limits; not separately configurable |
| **bounded retention** | **NO — see gap** | no job prunes `CodeTask` / `CodeTaskEvent` |
| network restrictions | **no** | GitHub-hosted runners have unrestricted egress |

## The credential handoff

Worth stating precisely, because it is the part most likely to be got wrong and
here it is right.

No credential rides the workflow inputs. The runner authenticates to
`/api/code/tasks/[id]/runner-context` with a **GitHub-signed OIDC JWT**
(audience `juno-cloud-code`) that it fetches at job runtime, so nothing
sensitive is ever echoed into a public Actions log. That endpoint is the only
place the user's decrypted GitHub token (`cloneToken`) is served, and it refuses
a browser session with 403 specifically so that token can never reach a browser.
A `cct_` task token is not a valid JWT and is refused there too.

`permissions:` is narrowed to `contents: read` plus `id-token: write`, so the
ambient `GITHUB_TOKEN` cannot write to the repository.

## Single-use handoff

Two gates make the handoff safe against a hostile or replaying runner:

1. **Status gate** — the task must be `queued` or `running`. A replay after the
   run finished is 409.
2. **Single use** — the first successful call atomically stamps
   `runnerClaimedAt` via an `updateMany` guarded on `runnerClaimedAt IS NULL`. A
   second call gets 409 `runner_context_consumed`. The clone token and the fresh
   task token are therefore handed out **at most once**, even though the OIDC
   token stays valid for the life of the job.

## Abuse control

Two independent limits, and the second is more carefully built than it looks:

- A burst rate limit on dispatch (`code-cloud:<userId>`), because one dispatch
  spins up an entire CI VM and agent loop.
- A concurrent-run cap enforced under `pg_advisory_xact_lock(hashtext(...))`.
  The lock is the point: a plain `count()` then `create()` is a TOCTOU, and N
  parallel requests would each read *under* the cap and all create. Serializing
  per user closes it, and a hash collision only briefly serializes two unrelated
  users.

## The one real gap: retention

`CodeTask` and `CodeTaskEvent` rows accumulate with no pruning job. Nothing is
insecure about that today — the rows are owner-scoped and the event bodies are
capped at 256 KB each — but "bounded retention" is a stated requirement and it
is not met. Left as a finding rather than fixed here, because a retention policy
is a product decision (how long should someone be able to read back a run?)
rather than a security fix, and inventing a window would be guessing at the
owner's answer.

Network egress is likewise unrestricted, which is inherent to GitHub-hosted
runners. Constraining it would mean self-hosted runners, which trades this
isolation for a machine someone has to secure — a worse position, not a better
one.
