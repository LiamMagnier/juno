# Agent Computers — Operations Guide

This runbook covers enabling, tuning, monitoring and shutting down **Agents v2** cloud
computers (`juno-computer:1` Docker containers, image label `juno.security=pipe-v4`).

**Status (October 2026): off in production.** `COMPUTER_PROVIDER` (or
`AGENT_COMPUTER_PROVIDER`) is empty by default, which means no computer can be created,
woken, viewed or used, and no run gets computer tools. Nothing in this guide has been
run on the production VM; every statement about a real host below was checked on a
disposable Linux machine (`tests/test_computer_boundary.py`, and for the computer host
`deploy/computer-host/local/run-local.sh` against real containers), not in production.
There are two providers. **Same-host Docker** (`docker`, §1) is for development and a
single-box install; it must not run on the web VM next to the database URL and provider
keys (`COMPUTERS_2026-10.md` fact 19). **A separate computer host** (`remote`, §8) is the
production path: computers run on a Linux machine of their own, which holds none of the
web VM's secrets. Who may use a computer once either is on is §9.

---

## 1. Turning agent computers on

1. **One-time host provisioning**, as root on the machine that will run the computers:
   ```bash
   sudo bash ~/juno/current/deploy/agent-computers/setup-vm.sh
   ```
   It installs, idempotently:
   - the narrow Docker broker `/usr/local/sbin/juno-computer-docker-broker` and its
     sudoers line (the app never holds the Docker socket and is removed from the
     `docker` group), and the policy `/etc/juno/computer-broker.json`;
   - the `juno-computers` bridge network (`172.30.0.0/24`, bridge `br-juno`, no
     container-to-container traffic);
   - the address-map helper `/usr/local/sbin/juno-computers-egress-map` and its watcher
     unit `juno-computers-egress-map.service`;
   - the egress proxy unit `juno-computers-egress.service` (its log and budget, §4),
     and `/etc/logrotate.d/juno-computers-egress`;
   - the firewall unit `juno-computers-firewall.service` (`firewall.sh`);
   - the image (`docker build --pull`), then the Chromium-sandbox probe (§6.2), which
     writes `browserSandbox` into the broker's policy.

   Owner-tunable on the command line (each is listed in `docs/OPEN_DECISIONS.md`):
   `JUNO_EGRESS_MAX_MB_PER_HOUR` (default 1024), `JUNO_EGRESS_LOG_DAYS` (default 14),
   `JUNO_COMPUTER_BROWSER_SANDBOX` (`auto`, the default, or `off`).

2. **Enable the provider in `.env` and reload**:
   ```bash
   cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload
   # Enter: docker
   ```
   `available()` refuses an image whose label is not `pipe-v4`, so a server with an
   older image stays off.

---

## 2. Resource caps & host protection

App side, read from `~/juno/.env` through `src/lib/env.ts` (defaults as the code has them):

| Variable | Default | Purpose |
|---|---|---|
| `COMPUTER_PROVIDER` / `AGENT_COMPUTER_PROVIDER` | empty (off) | `docker` (same host), `remote` (a computer host, §8); `fake` only when `NODE_ENV !== "production"` |
| `COMPUTER_DOCKER_IMAGE` / `AGENT_COMPUTER_IMAGE` | `juno-computer:1` | The tag `setup-vm.sh` builds |
| `AGENT_COMPUTER_NETWORK` / `COMPUTER_DOCKER_NETWORK` | `juno-computers` | The bridge network (`172.30.0.0/24`) |
| `COMPUTER_MAX_RUNNING_PER_USER` | `2` | Awake computers per account (also `AGENT_COMPUTER_MAX_AWAKE_USER`) |
| `COMPUTER_MAX_RUNNING_TOTAL` | `6` | Awake computers on the host (also `AGENT_COMPUTER_MAX_AWAKE_HOST`) |
| `COMPUTER_MEMORY_MB` | `2048` | RAM per container (`--memory` = `--memory-swap`, no swap; the broker caps it at 2048) |
| `COMPUTER_CPUS` | `2` | CPU quota per container (the broker caps it at 2) |
| `COMPUTER_DISK_LIMIT_MB` | `10240` | `/home/agent` size limit, measured by Juno, not enforced by the filesystem: a computer over it is not attached to tasks and an idle one is put to sleep with a sentence in `lastError` |
| `COMPUTER_MIN_FREE_MEMORY_MB` | `1024` | Host free-memory floor before creating or starting a computer |
| `COMPUTER_MIN_FREE_DISK_GB` | `10` | Host free-disk floor (also `AGENT_COMPUTER_MIN_FREE_DISK_MB`, 10240) |
| `COMPUTER_IDLE_PAUSE_SECONDS` | `180` | Idle time before an awake computer rests (`docker pause`) |
| `COMPUTER_IDLE_STOP_MINUTES` | `30` | Idle time before a computer sleeps (`docker stop`) |
| `COMPUTER_COST_MICRO_USD_PER_SECOND` | `0` | Price of awake time (§5) |
| `AGENT_COMPUTER_RETENTION_ENFORCE`, `AGENT_COMPUTER_RETENTION_DAYS` | empty (off) | Retention (§3.4). `COMPUTER_RETENTION_DAYS` is ignored |
| `RELAY_COMPUTER_CIDR` | `172.30.0.0/24` | Addresses the live-view relay may dial (port 5900 only) |

Host side (systemd `Environment=` lines written by `setup-vm.sh`; not app env):

| Variable | Default | Purpose |
|---|---|---|
| `JUNO_EGRESS_MAX_MB_PER_HOUR` | `1024` | Bytes through the proxy per computer (container name) per rolling hour, both directions |
| `JUNO_EGRESS_LOG_DAYS` | `14` | Days of the egress log logrotate keeps |
| `JUNO_EGRESS_MAP` | `/run/juno-computers/egress-map.json` | Address → computer map (§4) |

If a run cannot attach the computer (caps full, preflight refused, over the disk quota),
it does not fail: it uses the temporary per-run browser and says why.

---

## 3. Lifecycle & background sweeper

The Work runner's tick runs `sweepAgentComputers()` (`src/lib/computer/sweep.ts`) at most
once every 60 seconds. Each computer is checked on its own: one whose state cannot be
read (a daemon or broker failure) is skipped for that pass, logged once per outage, and
never treated as missing or recreated; the computers after it are still checked.

1. **Awake → Resting (`docker pause`)** after `COMPUTER_IDLE_PAUSE_SECONDS` (3 minutes)
   with no live run lease and no viewer. A poster frame (1280×800 JPEG) is kept for the
   panel. A resting computer resumes with `docker unpause`.
2. **Resting → Asleep (`docker stop`)** after `COMPUTER_IDLE_STOP_MINUTES` (30 minutes)
   idle. The CDP gate closes Chromium over its private pipe and waits for it to exit
   (up to 15 s of Docker's 20 s stop timeout) so cookies and the profile are written;
   files and sign-ins stay on the two volumes, `juno-agent-<agentId>` (`/home/agent`)
   and `juno-agent-<agentId>-browser` (`/home/browser`).
3. **Disk, leases, streams, reboots and orphans.** A computer over
   `COMPUTER_DISK_LIMIT_MB` is put to sleep with a sentence in `lastError`; expired
   leases are cleared; a live view nobody watched for 60 s is stopped; a row marked
   awake or resting whose container stopped (a host reboot) is reconciled to asleep;
   a container (label `app=juno`, name `juno-agent-*`) or volume with no computer row
   for 10 minutes is removed.
4. **Retention: off.** Computers are never deleted for age unless the owner turns
   retention on. Turning it on needs both `AGENT_COMPUTER_RETENTION_ENFORCE=1` and
   `AGENT_COMPUTER_RETENTION_DAYS` (at least 7); then a computer asleep that many days
   is deleted with its files and its sign-ins. The old `COMPUTER_RETENTION_DAYS` is
   ignored, even if set. Until then every computer stays until its person deletes or
   resets it, deletes the agent or deletes the account. Turning retention on is an
   owner decision that needs a notice to users first.

   (When it is on: a computer that is asleep, with no lease, no live view and nobody in
   control, whose last use and last view are both older than N days, is claimed as
   still idle and deleted through the same path as Delete. If
   `COMPUTER_RETENTION_DAYS` is set, the sweep logs once: "COMPUTER_RETENTION_DAYS is
   ignored. Deleting computers needs AGENT_COMPUTER_RETENTION_ENFORCE=1 and
   AGENT_COMPUTER_RETENTION_DAYS; see OPERATIONS.md.")

---

## 4. Egress: the proxy, its log and the budget

Computers have no direct Internet access and no DNS. `firewall.sh` drops everything a
computer sends except replies, rejects port 53 (so a lookup fails at once), and lets
computers open one connection to the host: the egress proxy on `172.30.0.1:3128`. The
proxy resolves names on the host, connects only to global addresses on ports 80 and 443
(never cloud metadata, private, loopback or link-local ranges), and pins the address it
checked.

What follows from "no DNS": tools that honour `HTTP(S)_PROXY` work (curl, pip, npm, git
over https, Python's urllib, Chromium); tools that resolve names themselves (ssh, raw
sockets, Node's built-in `fetch` on the image's Node) cannot reach the Internet.

**Which computer.** The broker updates the address map
(`/run/juno-computers/egress-map.json`) before and after it starts a computer and before
and after it stops or removes one; `juno-computers-egress-map.service` (a `docker events`
watcher, no timer) repairs it for a computer that stopped on its own. The proxy names
every connection after the computer that holds its source address, and refuses an
address the map does not know (after re-checking for 2 s) instead of guessing.

**The log.** One JSON line per connection, written when it ends, to
`/var/log/juno-computers-egress/egress.jsonl` (not journald, whose rate limit can drop
lines): `start`, `end`, `computer` (the container name), `src`, `host`, `port`, `up`
and `down` bytes, and `verdict` (`ok`, `refused`, `over_budget`, `unmapped`, `error`).
Never a path, a query, a header or a body. logrotate keeps `JUNO_EGRESS_LOG_DAYS` (14)
days. The log names the hosts each computer reached, so it is personal data about what
an agent did.

**The budget.** `JUNO_EGRESS_MAX_MB_PER_HOUR` (1024 MB) per computer, by container name,
over a rolling hour, both directions. Over it, a new request gets 403 and an open tunnel
is closed at its next chunk (`over_budget` in the log). A new computer on a reused
address starts with its own, empty budget. The counts are saved to
`/var/lib/juno-computers-egress/budget.json` every 10 s and at stop, and loaded at
start, so a restart of the proxy never resets a budget.

---

## 5. Cost & usage accounting

- `COMPUTER_COST_MICRO_USD_PER_SECOND` defaults to `0` (computers run on the owner's server).
- Above `0`, awake seconds are billed through `recordSpend` with `model: "agent-computer"`
  against the account's 5-hour and weekly usage windows.
- The weekly allowance of awake minutes per plan, which binds even at price 0, is
  `COMPUTERS_2026-10.md` S1 (see `docs/OPEN_DECISIONS.md` for its numbers).

---

## 6. Emergency shutoff (kill switch)

To disable every agent computer at once without redeploying:

1. **Turn off the provider** (and, once S1's rollout control has landed, the rollout):
   ```bash
   cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload
   # Enter an empty value (or: ./scripts/set-env-key.sh AGENT_COMPUTER_ROLLOUT --reload, value: off)
   ```
2. **Remove every computer container**, as root on the computers host:
   ```bash
   docker ps -aq --filter label=app=juno --filter name=juno-agent- | xargs -r docker rm -f
   ```
   Volumes are kept (`docker volume ls -q --filter name=juno-agent-` lists them). When
   computers are switched back on, a computer whose container was removed is recreated
   on its volumes at its next wake, with its files and sign-ins. Remove the volumes too
   only on the owner's decision: that deletes every person's files and sign-ins.
3. **On a computer host** (§8) the command in step 2 is the same, run as root on the
   host; to also stop new tunnels and API calls at once, stop the service there:
   `sudo systemctl stop juno-computer-host` (open tunnels end with it). Step 1 on the
   web VM is still what keeps computers off after a restart.

---

## 7. Security model

### 7.1 What pipe-v3 already did (September–October 2026)

- **Uid split.** The agent's shell is uid 1000; Chromium, the CDP gate, Xvfb, xfwm4
  and x11vnc are uid 1001. `/home/browser` and `/run/juno` (the CDP token and VNC
  password handover) are 0700 uid 1001. No desktop session, panel, terminal, file
  manager or editor runs as uid 1001 on the display.
- **No DevTools port.** Chromium speaks CDP over a private pipe to `cdp-gate.py`, which
  serves one token-checked WebSocket on `:9222`. The token is never in the container's
  environment; it is written to tmpfs after every start and deleted on read.
- **Container.** `--cap-drop ALL`, `no-new-privileges`, read-only root, tmpfs `/tmp`,
  `/run`, `/var/tmp`, memory equal to swap, at most 2 CPUs and 2048 pids, `--restart no`.
- **Broker.** Only exact argv shapes; `exec` only as uid 1000 or 1001; `--workdir` only
  under `/home/agent`; names `juno-agent-*` with label `app=juno` only.
- **Network.** ICC off, the firewall, no IPv6, the pinned proxy (§4).
- **Approvals.** `computer_shell`, `computer_type` and a text-producing `computer_key`
  are `sensitive`: they ask every time and "Always allow" never covers them. Take over
  is exclusive (every tool refuses while the person has control; an epoch fence
  discards results that overlapped it); relay tokens and app links are single use.

### 7.2 What pipe-v4 adds (October 2026, `COMPUTERS_2026-10.md` S2)

Each item is checked on a real container by `tests/test_computer_boundary.py` (passed three
times in a row on a disposable Linux host on 2026-10-28, with a local build of the image on
an Ubuntu 24.04 base and Chrome for Testing, because that host could not reach a Debian
mirror; the CI job `computer-boundary` builds the Debian image itself; nothing here ran in
production):

- **No DNS.** The create argv pins `--dns 192.0.2.53` (RFC 5737, a documentation address
  no resolver serves) and the firewall rejects port 53 to every address, so no lookup
  leaves a computer whatever that address routes to; the 1.1.1.1 / 9.9.9.9 exception is gone.
- **Egress log and budget**, keyed by computer through the broker's address map (§4).
- **The exec launcher.** Every agent command starts through `/opt/juno/agent-exec`
  (`run` for model-driven work, `helper` for the provider's own reads and a person's
  upload, `freeze`, `thaw`); the broker refuses any other uid-1000 exec. The launcher
  stacks a seccomp filter that denies user, mount, network and every other namespace
  to the agent's processes (`unshare`, `setns`, `clone` with `CLONE_NEW*`: EPERM;
  `clone3`: ENOSYS), and replaces the environment: `HOME=/home/agent`, a fixed `PATH`
  with `~/.local/bin` last, the proxy variables, nothing passed through. The shell
  runs `bash --noprofile --norc -c`, so no login or rc file, `BASH_ENV` or planted
  `~/.local/bin/ls` runs before or instead of an approved command.
- **Chromium's own sandbox, where the host allows it.** `setup-vm.sh` probes, in a
  throwaway container, whether the browser uid may create a user namespace under
  `seccomp-chromium.json` (Docker's default profile plus `clone`, `unshare` and
  `chroot`) and whether the launcher's ban still holds for the agent under it. Only
  then does the broker's policy set `browserSandbox: true` and computers get that
  profile; otherwise Docker's default profile, exactly as pipe-v3. The gate records
  `on`, `off:kernel` or `off:chromium` in `/run/juno-state/browser-sandbox`, and the
  provider re-checks the ban from the agent's side at every wake. On Ubuntu 24.04,
  AppArmor restricts unprivileged user namespaces by default, so expect `off` there
  unless the owner relaxes that restriction on the host.
- **Freeze at take over, thaw at hand back.** The provider writes a frozen marker
  (`/run/juno-state`, readable by the agent, writable only by uid 1001) so no new agent
  command starts, stops every uid-1000 process until a scan finds none running (fork
  loops and commands racing the freeze included), disconnects every X client that
  belongs to the agent through the X server (by PID, never by name), and releases every
  key and mouse button the X server reports down (a typer stopped between a key's press
  and release would otherwise leave autorepeat typing for the person). A typer resumed
  at hand back finds its display
  connection gone and cannot type. (The store's wiring of these is S1's.)
- **VNC** accepts connections from the host side of the network only (`-allow
  172.30.0.1`); the agent cannot reach it on its own loopback.
- **pip and venv** in the image; `pip install --user`, `python3 -m venv` and npm work
  in `/home/agent`.
- **Outdated containers.** A container made from another image ID than the current tag
  is detected (`isOutdated`) and recreated on its volumes at its next wake; the image
  build time is reported (`imageInfo`).
- **Missing means missing.** `state()` reports `missing` only when Docker says the
  container does not exist (the broker's exit 3); any other failure is "unreachable",
  so a daemon hiccup never recreates a computer.

### 7.3 What stays open

See `COMPUTERS_2026-10.md` section 7: the CDP gate passes every method through; a CDP
flood or a message over 64 MB stops the gate; `AllowFileSelectionDialogs` is undecided;
image rebuilds are by hand; a script the agent wrote, or configuration a named tool
reads from the agent's home (`.npmrc`, `.gitconfig`, a `.pth` file), still runs with a
command the person approved; the egress proxy allows any public host on 80 and 443; the
disk quota is measured, not enforced by the filesystem.

Found while proving pipe-v4 (not closed): the freeze is SIGSTOP, and the kernel sends
SIGHUP then SIGCONT to a stopped process group that becomes orphaned when one of its
members exits. A process that ignores SIGHUP (some started through `docker exec` did on
the test host, and the agent can set it for its own) survives the SIGHUP, so if a frozen
agent process were killed during a take over (by the OOM killer, say), a stopped
process in an orphaned group could resume. Its old display connection is cut, but it
could open a new one. A watchdog that re-stops the agent's processes while the marker
exists, or the cgroup freezer on a cgroup of the agent's own, would close it.

---

## 8. A separate computer host (`COMPUTER_PROVIDER=remote`)

The production path (`COMPUTERS_2026-10.md` S3, decision 5). The web VM runs no desktop:
every computer operation is one request to the host's narrow API
(`deploy/computer-host/juno-computer-host.py`), and the live view and the agent's
browser reach a computer only through the host's WebSocket tunnels. The owner guide,
with sizing and every command, is `deploy/computer-host/README.md`. In short:

1. **Provision** a dedicated Linux AMD64 machine (same region as the web VM; about 16 GB
   for 6 awake computers) and, as root there, from a checkout of this repository:
   ```bash
   sudo bash deploy/computer-host/setup.sh --web-ip <web VM address> --domain <host name> \
        --ssh-from <admin CIDR> [--namespace prod] [--max-running 6] [--tls private|certbot|own]
   ```
   It runs the shared steps of `setup-vm.sh --computer-host` (network, egress proxy and
   its log and budget, firewall, image, sandbox decision; no sudoers rule), installs the
   socket-activated root broker (`/run/juno-computer-host/broker.sock`, the only thing
   that talks to Docker; its argv policy is `docker-broker.py`'s, in host mode), the
   service (`juno-computer-host.service`: `NoNewPrivileges`, `ProtectSystem=strict`, no
   capabilities, `MemoryMax=512M`), TLS, nginx on 443 and the nftables table
   `inet juno_computer_host` (443 from `--web-ip` only, SSH from `--ssh-from`, the
   computers' way to the egress proxy, everything else dropped), and the first token,
   written once to a root-only file under `/root` whose path it prints.
2. **On the web VM**, set and reload: `COMPUTER_PROVIDER=remote`,
   `COMPUTER_HOST_URL=https://<host name>`, `COMPUTER_HOST_TOKEN=<the token>`,
   `NODE_EXTRA_CA_CERTS=<a file holding the CA certificate setup.sh printed>` (only with
   the default private TLS), and for the relay `RELAY_COMPUTER_HOSTS=https://<host name>`.
   `NODE_EXTRA_CA_CERTS` is read only when a process starts, so it must reach the
   process environment of the app, the Work runner and the relay:
   `deploy/ecosystem.config.js` passes it from the release `.env`, and the processes must
   be restarted (a reload of the env file alone is not enough). Keep
   `AGENT_COMPUTER_ROLLOUT=allowlist` (§9).
3. **Check** from the web VM: `curl -fsS -H "Authorization: Bearer $COMPUTER_HOST_TOKEN"
   https://<host name>/v1/health`. It reports the image (id, label, build time, age in
   days), how many computers run, the certificate's expiry and the source address it saw
   for the web VM; if that differs from `--web-ip` (Azure may SNAT), re-run setup with it.

What the host enforces, whatever the web VM sends:

- **Tokens** (D17): a bearer token in the generator's format (64 hex, or 43+
  base64url), hashed and compared with every stored hash; at most two per environment
  namespace; `SIGHUP` (`systemctl reload juno-computer-host`) re-reads them. The log
  names the token id, never the token. Rotate: `setup.sh --add-token --namespace prod`,
  set the new token on the web VM and restart the app, runner and relay when
  convenient, then `setup.sh --retire-token <old id>`.
- **Namespaces**: every container and volume carries `juno.ns=<namespace>`; listings,
  destroy, state, tickets and tunnels see only the token's namespace. One host per
  environment (a staging database restored from production shares agent ids and would
  meet name conflicts, never another environment's computer).
- **No user ids**: the owner label on the host is `u_` + 32 hex of sha256(user id).
- **Tunnels**: a single-use ticket (60 s, one container, one port, 16 outstanding per
  computer at most) in `X-Juno-Tunnel-Ticket`; port 9222 (the CDP gate, with the
  caller's gate token forwarded) or 5900 (x11vnc) only; the container's address must be
  on the computers network. VNC tunnels end after 2 hours.
- **Missing vs failing**: only Docker's "No such container" is a 404; every other
  failure is a 502, so the app never mistakes an outage for a deleted computer.
- **Logs** (`journalctl -u juno-computer-host`): operation, computer, token id, status
  and duration per request; never a path, query, command, file content, token,
  password or ticket. nginx logs no path either, and its error log is at `crit`.
- **No app secrets**: the service refuses to start with `DATABASE_URL`, `AUTH_SECRET`
  or any `*_API_KEY` in its environment.

**Losing the host.** The sweep records the last time it reached each awake computer
(`lastContactAt`). When the host stops answering, an awake computer's time is metered
only up to that contact, nothing accrues during the outage, and `host_unreachable` is
audited once; nothing is recreated, marked missing or reaped. Tool calls return "{product}
could not reach the agent's computer right now." and the panel says "Computers on this
server can't be reached right now." At the first answer afterwards metering resumes and
`host_reachable` is audited with the outage's minutes.

**Maintenance on the host:** `--renew-tls` (a month before the expiry health reports;
with private TLS it makes a new CA, which the web VM's trust file holds beside the old
one until every process restarted), `--rebuild-image` (`docker build --pull --no-cache`,
the label checked, unused computer images pruned; containers made from the old image
are recreated on their volumes at their next wake), `--rebuild-timer on|off` (weekly,
off by default). The egress log is `/var/log/juno-computers-egress/egress.jsonl`, as on
a single box (§4).

---

## 9. Rollout, caps and the weekly allowance

Setting a provider exposes nobody (`COMPUTERS_2026-10.md` S1; `src/lib/computer/access.ts`).
Every path checks, on the server, in this order: a provider is configured; the rollout
(`AGENT_COMPUTER_ROLLOUT`: `allowlist`, the default, `plans` or `off`; anything else is
`off`); under `allowlist`, the account is in `AGENT_COMPUTER_ALLOWLIST` (user ids, or
emails that match only a verified email; empty: nobody); the plan includes computers
(Pro and up, `PLAN_AGENT_COMPUTER` in `src/lib/plans.ts`); and the provider answers
(`unavailable` otherwise, cached 30 s). Free and Lite are told which plan includes them.

| Gate | Where |
|---|---|
| Enable (the account's computers, `AGENT_COMPUTER_MAX_ENABLED_<PLAN>`) | `enableComputer`, one transaction under an advisory lock |
| Wake, run start, view and take over, the chat tools, the run's own start | access, then the weekly allowance, then (at a price above 0) the spend windows |
| Lease renewal (40 s) and the sweep (60 s) | the same; a refusal puts the computer to sleep |
| Delete, sleep, hand back, the poster | never gated: they reduce use or return control |

The weekly allowance (`AGENT_COMPUTER_WEEKLY_MINUTES_<PLAN>`, Monday 00:00 UTC) is
metered whatever the price (`AgentComputerUsageInterval`), and is soft by at most (awake
computers) × 40 s. Each agent's policy (`Agent.computerPolicy`: `off`, `ask`, the
default, or `allowed`) decides whether its runs may start its computer, and whether the
first start asks the person ("Start {name}'s computer"). The numbers and their defaults
are in `docs/OPEN_DECISIONS.md` §10, owner to confirm. Every change of state (enabled,
woke, slept, take over, refused, host outages, image age, the sandbox state) is a row in
`AgentComputerAudit`: identifiers and verdicts only.
