# juno-exec: the execution host

Alevr's hosted code execution (`run_code`, `check_run`). Design:
[docs/rework/TOOL_RUNTIME_DESIGN.md](../../docs/rework/TOOL_RUNTIME_DESIGN.md) §6.2–§6.7.
Nothing here runs on the web VM, and nothing here is deployed by the normal release:
the owner provisions a separate host and runs `setup.sh` on it.

| File | What it is |
|---|---|
| `juno-exec.py` | The service (Python standard library only): the v1 API, sessions, runs, logs, produced files, idempotency, limits, the sweep |
| `juno-exec-docker-broker.py` | The root broker, the only thing that talks to Docker. Validates every argv against `/etc/juno/exec-broker.json` and relays stdout/stderr/exit as frames |
| `exec-broker-policy.json` | The policy template (`setup.sh` writes the real one with the built image id and the run uid) |
| `image/` | The sandbox image: Python 3.12 with the data, Office and PDF libraries (every dependency pinned), Node 22 (binary only), bash. Bases pinned by digest |
| `setup.sh` | One-time, idempotent host setup: user, size-capped workspace filesystem, broker socket, service, nginx TLS, nftables |
| `local/run-local.sh` | The developer profile on Docker Desktop (127.0.0.1, a port in 3170–3179) |

## The boundary

Every run is a fresh container: `--network none`, `--read-only`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, a non-root uid, `--pids-limit 256`,
`--memory 1536m` (swap equal), `--cpus 1`, a 256 MB tmpfs `/tmp`, optionally gVisor
(`--gvisor`). Mounts are the session's own directories only: `/work` (the workspace,
read-write), `/work/inputs` (the conversation's files, read-only), `/juno/program`
(this run's program, read-only), `/skills/<slug>` (skill bundles, read-only). The
broker refuses any other image, network, mount, capability, user, device, environment,
runtime or limit, and any bind source that is not a real directory under the sessions
root.

The service runs unprivileged with `NoNewPrivileges` and never holds the Docker
socket; it reaches the broker through a socket only its group can open. Everything it
reads from a workspace is opened component by component with `O_NOFOLLOW`, because the
container can leave symlinks there. The host stores no database URL, no provider key
and no user identity: sessions (`s_…`) and accounts (`a_…`) are opaque hashes chosen
by the web side. Logs record ids, sizes and verdicts, never code or file contents.
Workspaces and run records are dropped 30 minutes after the last activity.

## API (v1)

All requests carry `Authorization: Bearer <token>`.

| Call | Purpose |
|---|---|
| `GET /v1/health` | Liveness, `egress: "none"`, the image, load, `runsStarted` |
| `GET /v1/manifest` | Runtimes and installed packages (read by an ordinary sandboxed run) |
| `PUT /v1/sessions/{s}/inputs/{name}` | One input file, raw body, ≤ 32 MB (64 MB per session) |
| `PUT /v1/sessions/{s}/skills/{slug}` | A skill bundle as a tar (`X-Bundle-Digest` checked), ≤ 200 files / 5 MB, regular files and folders only, mounted read-only |
| `DELETE /v1/sessions/{s}` | Cancel the session's runs and drop its workspace |
| `POST /v1/runs` + `Idempotency-Key` | `{ session, account, language, code, timeoutMs, skills? }`. The same key returns the same run; the same key with a different body is refused (409) |
| `GET /v1/runs/{id}?wait=N` | Status (`queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, `lost`), exit code, byte counts, head and tail of each stream (8 KB each), produced files |
| `GET /v1/runs/{id}/events?after=SEQ` | Server-sent stdout/stderr chunks |
| `GET /v1/runs/{id}/output?stream=&offset=&limit=` | The full log, paged (≤ 16 MB kept per stream) |
| `GET /v1/runs/{id}/files[/{path}]` | Produced files (≤ 20, 25 MB each, 50 MB total), with their sha256 |
| `POST /v1/runs/{id}/cancel` | Kill the container; status `cancelled` |

A run in flight when the service restarts becomes `lost` (the web side records
`outcome_unknown`), and its container is killed at start-up. Nothing is ever re-run.

## Tests

```sh
python3 -m unittest discover -s tests -p 'test_exec_host.py'           # no Docker needed
JUNO_EXEC_DOCKER_TESTS=1 python3 -m unittest tests.test_exec_host.RealSandboxBoundary   # real containers
```

The web side's suites against a live local host and a throwaway Postgres:
`tests/exec-runtime.integration.test.ts` and `tests/exec-chat-route.integration.test.ts`
(opt-in, see their headers).

## What production needs (the owner decides; nothing here was done)

1. A host (option A in the design) or a hosted provider (option B).
2. `sudo bash setup.sh --web-ip … --domain … (--cert/--key | --certbot-email) --ssh-from …`.
3. On the web VM only: `CODE_INTERPRETER_URL`, `CODE_INTERPRETER_TOKEN`, then `TOOL_RUNTIME=1`.
4. The `ToolRun` migration ships with the normal deploy (additive).
5. The metering price: `RUN_CODE_MICRO_USD_PER_SECOND` (default 46).
