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
| `COMPUTER_MAX_RUNNING_PER_USER` | `2` | Max computers in `awake`, `waking`, or `resting` per user account |
| `COMPUTER_MAX_RUNNING_TOTAL` | `4` | Max computers in `awake`, `waking`, or `resting` across the entire server |
| `COMPUTER_MEMORY_MB` | `2048` | RAM limit per container (`--memory` and `--memory-swap` equal, so zero swap) |
| `COMPUTER_CPUS` | `2` | CPU core quota per container (`--cpus`) |
| `COMPUTER_DISK_LIMIT_MB` | `10240` | Max `/home/agent` volume size (10 GB) enforced by the sweeper |
| `COMPUTER_MIN_FREE_MEMORY_MB` | `1024` | Host free + available RAM floor required before creating or waking a computer |
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
