# Agent Computers — Operations Guide

This runbook covers enabling, tuning, monitoring, and shutting down **Agents v2** cloud computers (`juno-computer:1` Docker desktop containers on the owner's server).

---

## 1. Turning agent computers on

By default, `COMPUTER_PROVIDER` is unset (`off`). When `off`, every computer route returns `computer: null` (`computerConfigured: false`), the UI hides the **Computer** tab in the agent panel and header, and Work runs use the temporary stateless browser as before.

To enable agent computers after deploying `main`:

1. **One-time host provisioning (~10 minutes)** — installs Docker if missing, creates the isolated `juno-computers` bridge network (`172.30.0.0/24`), installs the `DOCKER-USER` iptables rules blocking RFC1918/link-local/metadata traffic and inter-container communication (`--icc=false`), and builds the `juno-computer:1` image:
   ```bash
   ssh -i ~/Developer/KEY/chatliamsdev.pem liammgnr@20.91.138.96 \
     'sudo bash ~/juno/current/deploy/agent-computers/setup-vm.sh'
   ```

2. **Enable the provider in `.env` and reload**:
   ```bash
   ssh -i ~/Developer/KEY/chatliamsdev.pem liammgnr@20.91.138.96
   cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload
   # Enter: docker
   ```

---

## 2. Resource caps & host protection

All limits are read from `~/juno/.env` via `src/lib/env.ts` and can be adjusted without code changes:

| Variable | Default | Purpose |
|---|---|---|
| `COMPUTER_PROVIDER` | `off` | `docker` in production; `fake` allowed only when `NODE_ENV !== "production"` |
| `COMPUTER_DOCKER_IMAGE` | `juno-computer:1` | Container image built by `deploy/agent-computers/setup-vm.sh` |
| `COMPUTER_DOCKER_NETWORK` | `juno-computers` | Isolated Docker bridge network (`172.30.0.0/24`) |
| `COMPUTER_MAX_RUNNING_PER_USER` | `2` | Max awake computers per user account (also read as `AGENT_COMPUTER_MAX_AWAKE_USER`) |
| `COMPUTER_MAX_RUNNING_TOTAL` | `6` | Max awake computers across the server (also read as `AGENT_COMPUTER_MAX_AWAKE_HOST`) |
| `COMPUTER_MEMORY_MB` | `2048` | RAM limit per container (`--memory` and `--memory-swap` equal, so zero swap) |
| `COMPUTER_CPUS` | `1.5` | CPU core quota per container (`--cpus`) |
| `COMPUTER_DISK_LIMIT_MB` | `4096` | `/home/agent` size limit. Enforced by Juno, not the filesystem: a computer over it is not attached to tasks (they use the temporary browser and say why), and an idle one is put to sleep with a sentence in `lastError`. The person can still open it and delete files. |
| `COMPUTER_MIN_FREE_MEMORY_MB` | `4096` | Host free + available RAM floor required before creating or waking a computer |
| `COMPUTER_MIN_FREE_DISK_GB` | `10` | Host free disk floor required before creating or waking a computer |
| `RELAY_COMPUTER_CIDR` | `172.30.0.0/24` | CIDR allowlist enforced by the WebSocket VNC relay (`relay/src/computer-view.ts`) |

If an agent starts a run when the user or server cap is full, or if the host preflight check fails, the run does not fail—it degrades cleanly to the temporary per-run browser and notes the reason.

---

## 3. Lifecycle & background sweeper

Each `work-runner` tick runs `sweepComputers()` (`src/lib/computer/sweep.ts`) at most once every 30 seconds:

1. **Awake → Resting (`docker pause`)**:
   - After `COMPUTER_IDLE_PAUSE_SECONDS` (default `180` seconds = 3 minutes) with no active run lease (`leasedRunId IS NULL` or expired `leaseUntil`) and no active viewer (`viewerUntil` expired), the sweeper captures a JPEG poster (`640×400`), stops `x11vnc` (`streamOn = false`), and pauses the container (`docker pause`).
   - A resting container resumes in ~20 ms via `docker unpause`.

2. **Resting → Asleep (`docker stop`)**:
   - After `COMPUTER_IDLE_STOP_MINUTES` (default `30` minutes) in `resting`, the sweeper unpauses and stops the container (`docker stop -t 20`). The entrypoint closes Chromium cleanly over loopback CDP so cookies and `/home/agent/work` files are flushed to the persistent volume `juno-comp-<agentId>`.

3. **Asleep → Destroyed (`docker rm -f` + `docker volume rm`)**:
   - After `COMPUTER_RETENTION_DAYS` (default `30` days) asleep, the container and its volume are destroyed and `enabled` is reset to `false`.

4. **Disk enforcement & reboot reconciliation**:
   - If `/home/agent` exceeds `COMPUTER_DISK_LIMIT_MB`, the computer is stopped with an error explaining that `/home/agent/work` exceeded its 10 GB allowance.
   - Any Docker container labelled `juno.computer=1` with no matching `AgentComputer` row (or belonging to a retired agent) is destroyed automatically.
   - Any `AgentComputer` row marked `awake` or `resting` whose container was stopped by a host reboot is reconciled to `asleep`.

---

## 4. Cost & usage accounting

- `COMPUTER_COST_MICRO_USD_PER_SECOND` defaults to `0` (since computers run on the owner's server).
- If set above `0`, awake seconds (`lastResumedAt` → sleep or run end) are added to `AgentComputer.activeSeconds` and billed against the user's 5-hour and weekly Work usage windows via `recordWorkSpend`.

---

## 5. Emergency shutoff (kill switch)

To immediately disable all agent computers without redeploying:

1. **Turn off the provider**:
   ```bash
   cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload
   # Enter: off
   ```
2. **Stop and remove all running agent containers (optional)**:
   ```bash
   docker ps -aq --filter label=juno.computer=1 | xargs -r docker rm -f
   ```
   When `COMPUTER_PROVIDER` is re-enabled later, any computer whose container was removed will automatically recreate its container on next wake while keeping its `juno-comp-<agentId>` volume (or start fresh if volumes were also removed).

---

## 6. Security model and what still needs the image rebuilt (refoundation, 2026-09-30)

Computers stay OFF unless `COMPUTER_PROVIDER` is set, and the UI and the
model's tool list say nothing about them while it is off. What the code now
guarantees, whatever the image:

- **Shell and typing always ask.** `computer_shell`, `computer_type` and any
  `computer_key` that produces text (or pastes, or opens a terminal) are graded
  `sensitive`: they ask under every approval mode, Skip included, and "Always
  allow" can never cover them. `computer_files` writes only under
  `/home/agent/work`, never into a dotfile or dot-folder (no `~/.bashrc`, no
  autostart entries).
- **Takeover is exclusive.** While the person has control
  (`AgentComputer.takeoverUntil`), every computer tool and the browser tool on
  the same Chromium refuse, screenshots included, and a result that finished as
  control began is thrown away. Control heartbeats (web viewer and the apps,
  every 20 s) hold it; Hand back releases it; a window nobody extends lapses
  after 60 s.
- **App links are single use.** `/computer-view?c=` codes are random, stored as
  hashes, spent on first open, bound to the device session that asked (a
  revoked device cannot use one), refused for a browser signed in to another
  account, and live 60 s. The page never renders a credential: the viewer trades
  a one-time ticket for the relay token and VNC password over
  `POST /api/computer-view/session`, which also records `takeover_started`.
- **Relay tokens are single use** (a one-time id the relay remembers until the
  token expires) and travel in the WebSocket subprotocol, not the URL, so they
  are not in the access log.
- **The CDP token is not in the container's env.** It is written to tmpfs over
  `docker exec -i` after every start; the gate reads it, deletes the file and
  marks itself non-dumpable. The VNC password file lives in tmpfs and x11vnc
  deletes it on read.

What the image rebuild must still do (security audit C1, not closable from the
app alone):

1. **Split the uids.** Run Chromium and `cdp-gate.py` as a second user (for
   example uid 1001, `browser`) with its own profile directory that uid 1000
   cannot read, and keep `docker exec --user 1000` for the agent's shell. This
   needs `--cap-add SETUID --cap-add SETGID` for the entrypoint only (it drops
   to each uid with `setpriv`), alongside `no-new-privileges`.
2. **Take DevTools off TCP.** Launch Chromium with `--remote-debugging-pipe`
   from the gate (fds 3 and 4) and have the gate bridge its token-checked
   WebSocket on `:9222` to the pipe, so nothing listens on `127.0.0.1:9223` for
   the agent's shell to reach. `remote-browser.ts` then connects to a fixed
   path instead of asking `/json/version` over `docker exec`.
3. **Egress.** Default-deny container egress through an allowlisting proxy
   driven by the skill's `egressDomains`, so a shell command the person approved
   cannot reach beyond it.

After rebuilding, containers created by an older build still carry
`JUNO_CDP_TOKEN` in their env: use **Reset** on each computer (or
`docker rm -f` them; the volume is kept) so they are recreated with the new
arguments.

