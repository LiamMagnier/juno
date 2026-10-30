# The computer host

Agent computers (each agent's own Linux desktop with Chromium, a shell and files) run on
a machine of their own: the **computer host**. This directory is everything that runs on
it, and this file is the owner's guide. The plan it implements is
`docs/design/agents-v2/COMPUTERS_2026-10.md` (stage S3); day-to-day operations are in
`docs/design/agents-v2/OPERATIONS.md` §8.

**Status: built and tested on a development machine, never run in production.** Computers
are off in production until the owner does everything below and sets
`COMPUTER_PROVIDER=remote` on the web VM. Nothing here changes a price, a plan or a
credential.

## Why a separate machine

The web VM holds the database URL, `AUTH_SECRET` and the AI provider keys, and the Work
runner beside it drives models. A computer runs commands and pages a model chose. Running
those desktops on the web VM would put every secret of the product one container escape
away from model-driven code. The computer host holds none of them (the service refuses to
start with `DATABASE_URL`, `AUTH_SECRET` or any `*_API_KEY` in its environment), and the
web VM talks to it over one narrow, authenticated API.

```
web VM (app, Work runner, relay)                     computer host (this directory)
  RemoteComputerProvider  ── HTTPS + bearer token ──▶  nginx :443 ─▶ juno-computer-host :8750 (API)
  agent browser (CDP)     ── WSS tunnel + ticket  ──▶  nginx :443 ─▶ juno-computer-host :8751 (tunnels) ─▶ container :9222
  relay (live view, VNC)  ── WSS tunnel + ticket  ──▶  nginx :443 ─▶ juno-computer-host :8751 (tunnels) ─▶ container :5900
                                                       juno-computer-host ─▶ /run/juno-computer-host/broker.sock (root) ─▶ docker
```

- **The API** covers exactly the operations the app needs (create, start, stop, pause,
  state, screenshot, input, a command, files, VNC, freeze and thaw for a take over, the
  image), JSON over HTTPS, one bearer token per environment.
- **The tunnels** reach only port 9222 (the browser's CDP gate, which still checks its own
  per-computer token) and 5900 (the live view) of containers this host created for the
  caller's environment, each opened with a single-use ticket valid 60 seconds. The relay
  never holds the host's token: the app asks the host for a ticket and seals it into the
  relay's own token (AES-256-GCM, a key derived from `AUTH_SECRET`).
- **The broker** is the only thing that talks to Docker. It runs as root, one instance per
  request, and refuses any docker command that is not one of the exact shapes a computer
  needs (`deploy/agent-computers/docker-broker.py`, the same policy as a single-box
  install, in host mode). The service itself runs unprivileged: no docker group, no sudo,
  `NoNewPrivileges`, a read-only system.
- **Every computer carries its environment's namespace** (`juno.ns=<namespace>`), and a
  token sees only its namespace: listings, delete, state, tickets and tunnels. The host
  never learns a user id: the owner label is `u_` + 32 hex of sha256(user id).

## Sizing (arithmetic, not a measurement)

Each awake computer is capped at 2 GB of memory (no swap) and 2 CPUs. Keep about 2 GB for
the system, Docker, the egress proxy and the service, and the 1 GB free-memory floor the
host checks before every start. So **6 awake computers need about 16 GB** of memory and 4
to 8 vCPUs (CPU is shared; a busy page uses most of one). Disk: about 2 GB for the image,
the 10 GB free-disk floor, and up to 10 GB per enabled computer (the quota is measured, not
enforced by the filesystem). A Linux AMD64 VM in the same region as the web VM (Azure
Sweden Central today, for latency and EU residency), Debian 12 or Ubuntu 24.04.

The host service itself runs under `MemoryMax=512M` and carries every open tunnel, so a
command's output is bounded before the service holds it: each answer carries at most 1 MiB
of each stream (the app keeps 20,000 characters), and at most 4 commands run at once per
computer and 24 on the host (`maxCommandsPerComputer`, `maxConcurrentCommands` in
`/etc/juno/computer-host.json`; the next gets `429 too_many_commands`). Measured with a
fake Docker, eight commands at once that each printed 16 MiB per stream took the service
from 29 MiB to between 50 and 73 MiB (nine runs).

## Setting it up, in order

1. **Provision the machine** and give it a DNS name the web VM can resolve (A record to
   its address). Prefer one virtual network and private addresses between the two VMs.
2. **Copy this repository's `deploy/` directory** to the host (the whole directory:
   `computer-host/` uses `agent-computers/`).
3. **Run setup**, as root:
   ```bash
   sudo bash deploy/computer-host/setup.sh --web-ip <web VM address> --domain <host name> \
        --ssh-from <your admin CIDR> [--namespace prod] [--max-running 6]
   ```
   TLS defaults to `--tls private` (below). Setup prints where it wrote the first token
   (a root-only file under `/root`) and, for private TLS, the CA certificate.
4. **On the web VM** (and nowhere else), set and restart the app, the Work runner and the
   relay:
   ```bash
   COMPUTER_PROVIDER=remote
   COMPUTER_HOST_URL=https://<host name>
   COMPUTER_HOST_TOKEN=<the token from the root-only file; then delete that file>
   NODE_EXTRA_CA_CERTS=<path of a file on the web VM holding the CA certificate>   # private TLS only
   RELAY_COMPUTER_HOSTS=https://<host name>                                      # the relay
   AGENT_COMPUTER_ROLLOUT=allowlist                                              # keep it
   ```
   `NODE_EXTRA_CA_CERTS` is read by Node only when a process starts: it has to be in the
   release `.env` (`deploy/ecosystem.config.js` passes it to the app, the runner and the
   relay) and the processes restarted. The token must be one `setup.sh` generated (64 hex
   characters): its format is checked, its randomness cannot be.
5. **Check the address the host sees for the web VM.** From the web VM:
   ```bash
   # the header comes from stdin, so the token never shows in the process list
   printf 'Authorization: Bearer %s\n' "$COMPUTER_HOST_TOKEN" | curl -fsS -H @- https://<host name>/v1/health
   ```
   Its `source` must equal `--web-ip`. On Azure, outbound traffic may arrive from the web
   VM's public address (SNAT): if `source` differs, re-run setup with `--web-ip <source>`.
6. **Run the smoke on the host** before allowlisting anyone (and after every image rebuild
   or certificate renewal):
   ```bash
   sudo bash deploy/computer-host/smoke.sh --token-file /root/juno-computer-host-token-<id>.txt \
        --url https://<host name> --ca /etc/juno/computer-host-tls/ca.pem
   ```
   It creates a throwaway computer, starts it, opens a CDP and a VNC tunnel, runs a
   command, writes and reads a file, takes a screenshot, freezes and thaws it, pauses,
   stops and removes it, and prints every step.
7. **Allowlist the first accounts**: `AGENT_COMPUTER_ALLOWLIST=<ids or verified emails>` on
   the web VM. Only listed accounts on a plan with computers (Pro and up) get one. The
   numbers (computers per plan, awake minutes per week) are in `docs/OPEN_DECISIONS.md`
   §10, owner to confirm.

## One host per environment

Each environment (production, staging) gets its own host and its own namespace. A token
belongs to one namespace and the host never lets it touch another's computers, but a
staging database restored from production has the same agent ids, and on a shared host
it would meet name conflicts. Never serve two environments under one token.

## Tokens and rotation

The host keeps only the sha256 of each token, in `/etc/juno/computer-host-tokens.json`
(root:juno-computer-host 0640), at most two per namespace, so a rotation needs no
simultaneous restart:

```bash
sudo bash deploy/computer-host/setup.sh --add-token --namespace prod   # prints where the new token is
# set COMPUTER_HOST_TOKEN on the web VM to the new token; restart the app, runner and relay when convenient
sudo bash deploy/computer-host/setup.sh --retire-token <old id>        # the old one stops working at once
```

The host re-reads the file on `SIGHUP` (`systemctl reload juno-computer-host`); setup does
that for you. Retiring a token also drops the tunnel tickets minted under it and closes
every CDP and VNC tunnel opened with them (close code 1008, logged as `op=revoke`), and a
ticket request already in flight under it mints nothing (the token is checked again when the
ticket is minted and when it is used), so a leaked token keeps nothing open once it is
retired: retire the old token only after the
app, the Work runner and the relay run with the new one. The host's log names the token id
of every request, never the token.

## TLS

- **`--tls private` (default):** setup makes an EC P-256 CA whose certificate carries a
  critical name constraint permitting only `<host name>`, signs the host's certificate
  (397 days), and destroys the CA's key. Trusting that CA on the web VM therefore trusts
  exactly one name, and nobody can sign anything else with it. Renew a month before the
  expiry `/v1/health` reports: `setup.sh --renew-tls` (a new CA; keep the old and new CA
  certificates in the web VM's trust file until every process has restarted).
- **`--tls certbot --certbot-email <e>`:** Let's Encrypt, standalone. Port 80 is opened in
  the firewall only while certbot runs (its pre- and post-hooks) and nginx reloads after
  a renewal.
- **`--tls own --cert <f> --key <f>`:** your own certificate.

## The firewall

nftables table `inet juno_computer_host`, input hook only, policy drop: loopback,
established traffic, ICMP, SSH from `--ssh-from`, 443 from `--web-ip`, and the computers'
own connections to the egress proxy (`br-juno` to 172.30.0.1:3128). Docker's forward and
NAT rules are left alone; `deploy/agent-computers/firewall.sh` keeps computers off private
networks, the metadata service and the host itself, and away from DNS. Without
`--ssh-from`, SSH stays open to everyone (setup warns). Setup loads this table before
anything else it installs listens (the package's default nginx site on port 80 is
removed at the same time), so 443 never answers anyone but `--web-ip`, even if setup
stops halfway.

## Image freshness

`setup.sh --rebuild-image` rebuilds the computer image (`docker build --pull --no-cache`),
checks its security label (`pipe-v4`), and prunes old computer images no container uses.
Each computer made from the old image is recreated on its volumes (files and sign-ins
kept) at its next wake. `setup.sh --rebuild-timer on` installs a weekly rebuild (it pulls
Debian packages on the host; off by default, the owner's call). A stale image is reported
by `/v1/health` and audited; nothing is refused for its age.

## The kill switch

On the web VM, empty `COMPUTER_PROVIDER` (or set `AGENT_COMPUTER_ROLLOUT=off`) and reload:
no computer can be woken, viewed or used. On the host, to stop everything at once:

```bash
sudo systemctl stop juno-computer-host                                       # no API calls, no tunnels
sudo docker ps -aq --filter label=app=juno --filter name=juno-agent- | sudo xargs -r docker rm -f
```

`docker rm -f` goes to Docker directly, around the broker, so the broker does not release
the computers' addresses from the egress map; the map watcher (`juno-computers-egress-map`
unit) drops them as each container dies. If that unit is not running, repair the map by
hand: `sudo /usr/local/sbin/juno-computers-egress-map rebuild`.

Volumes are kept (`docker volume ls -q --filter name=juno-agent-`); a computer is recreated
on them at its next wake once computers are back on. Removing the volumes deletes every
person's files and sign-ins: the owner's decision only.

## Logs

- `journalctl -u juno-computer-host`: one line per request (operation, computer, token id,
  status, duration) and per tunnel. Never a path, a query, a command, file content, a
  token, a password or a ticket.
- `journalctl -u 'juno-computer-host-broker@*'`: the broker's refusals.
- `/var/log/nginx/juno-computer-host.access.log`: method, status, size and time only; the
  error log is at `crit` (nginx writes the request line into `error` entries).
- `/var/log/juno-computers-egress/egress.jsonl`: one line per connection a computer made
  through the egress proxy (computer, host, port, bytes, times; never a URL or a body),
  kept 14 days by default (`JUNO_EGRESS_LOG_DAYS`). It names the hosts each computer
  reached: personal data about what an agent did.

## Development

`local/run-local.sh` runs the host on this machine for development and the tests, never on
a shared machine: the service on 127.0.0.1:8750 and :8751 with the broker as a child
process (same validation, the local Docker socket), a generated token in
`$JUNO_COMPUTER_HOST_DATA/token`, namespace `dev`. With `--nginx` it also serves the
production nginx config in the official nginx image on `https://localhost:8443`, with a
private CA for `localhost`, so the tested path is the production path. It needs the
computers network, the egress proxy and the image (what `setup-vm.sh` or the boundary
test fixture puts on a machine). Tests: `tests/test_computer_host.py` (the service, no
Docker), `tests/test_computer_host_firewall.py` (the ruleset, in network namespaces),
`tests/computer-remote-provider.test.ts`, `tests/computer-host-down.test.ts`,
`tests/computer-host-argv.test.ts`, `tests/computer-host-tls.test.ts`.

## What stays open

Everything in `COMPUTERS_2026-10.md` section 7 applies to a computer host as to a single
box: the CDP gate passes every method through (only the app holds its token), the egress
proxy allows any public host on 80 and 443, the disk quota is measured rather than
enforced, and an approved command can run a script the agent wrote. Specific to the host:
the web VM's address check is by IP (`--web-ip`), so anything that can send from that
address and holds a token can call the API; keep the token on the web VM only.
