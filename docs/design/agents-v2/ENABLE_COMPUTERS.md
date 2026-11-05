# Turning agent computers on in production

The owner's runbook, October 2026. Every step comes from the scripts as they are:
`deploy/computer-host/setup.sh`, `private-tls.sh`, `smoke.sh`, `deploy/agent-computers/setup-vm.sh`,
`deploy/ecosystem.config.js`, `src/lib/env.ts`, `src/lib/computer/access.ts` and
`src/lib/computer/remote.ts`. Background: `deploy/computer-host/README.md`, `OPERATIONS.md`
§8 and §9, and `docs/OPEN_DECISIONS.md` §10.

**Today computers are off.** `COMPUTER_PROVIDER` is empty, so nobody can create, wake, view
or use a computer, and no run gets computer tools. Nothing below has run in production yet.

**Why a second machine.** The web VM has under 1 GB of RAM, and it holds the database URL,
`AUTH_SECRET` and the provider keys. Computers run model-driven code, so they run on a
**computer host** of their own. The host holds none of those secrets: its service refuses
to start if one is in its environment.

---

## 0. Before you start

- You need SSH to the web VM and to the new host, a DNS name for the host, and your admin
  address range (for `--ssh-from`).
- You decide who goes on the allowlist first. The plan caps and weekly minutes are in
  `OPEN_DECISIONS.md` §10. Their defaults apply unless you change them.

## 1. Rent the machine

The size comes from the caps, by arithmetic (README "Sizing"; nobody has measured it under
load):

| | Per awake computer | Fixed |
|---|---|---|
| Memory | 2 GB, no swap (`memoryMb: 2048`) | about 2 GB for the system, plus a 1 GB free-memory floor (`minFreeMemMb`) |
| CPU | up to 2 vCPUs (`cpus: 2`), shared | |
| Disk | up to the quota per **enabled** computer (`diskQuotaMb`, default 10240 MB; soft, measured) | about 2 GB image, plus a 10 GB free-disk floor (`minFreeDiskMb`) |

- **The default host runs 6 awake computers at once** (`--max-running 6`). That needs about
  **16 GB of RAM and 4 to 8 vCPUs**. On Azure in Sweden Central, beside the web VM, that is a
  **Standard_D4s_v5** (4 vCPUs, 16 GiB) at the minimum.
  - For headroom, take a Standard_E4s_v5 (4 vCPUs, 32 GiB).
  - On a smaller machine, lower `--max-running` to match: 2 GB per computer, plus 3 GB.
- **Disk:** 12 GB, plus the quota for each computer you expect people to enable. For
  example, 10 enabled computers at the 10 GB default need about 112 GB, so take a 128 GB
  disk.
- **OS:** Linux AMD64, Debian 12 or Ubuntu 24.04. Prefer **Debian 12**: on Ubuntu 24.04,
  AppArmor blocks unprivileged user namespaces, so Chromium's own sandbox reports `off`
  until you relax that on the host (`OPEN_DECISIONS.md` §10).
- **Network:** put the host in the **same virtual network** as the web VM and give it a
  private address. Give it a **DNS name**, never a bare IP (see §3).
- Inbound access: only SSH from you. `setup.sh` closes everything else.

## 2. Run setup on the host

Copy the whole `deploy/` directory to the host. `computer-host/` uses `agent-computers/`.
Then, as root:

```bash
sudo bash deploy/computer-host/setup.sh \
     --web-ip <web VM private address> \
     --domain <host DNS name> \
     --ssh-from <your admin CIDR> \
     --namespace prod \
     --max-running 6
```

The flags, all from `setup.sh`:

| Flag | Default | Meaning |
|---|---|---|
| `--web-ip` | required | The only address port 443 answers. It must be the source address the host actually sees (step 5). |
| `--domain` | required | The host's name, used for nginx and the certificate. |
| `--tls private\|certbot\|own` | `private` | `certbot` also needs `--certbot-email`. `own` also needs `--cert <f> --key <f>`. |
| `--ssh-from` | none | Without it SSH stays open to everyone, and setup warns. |
| `--namespace` | `prod` | One namespace and one host per environment. |
| `--max-running` | `6` | Computers awake at once on this host. |

The egress knobs are environment variables of `setup-vm.sh`, which setup runs. Pass them
through `sudo`:

```bash
sudo JUNO_EGRESS_MAX_MB_PER_HOUR=1024 JUNO_EGRESS_LOG_DAYS=14 JUNO_COMPUTER_BROWSER_SANDBOX=auto \
     bash deploy/computer-host/setup.sh ...
```

These are the defaults. `JUNO_COMPUTER_BROWSER_SANDBOX` is `auto` or `off`.

What setup does, in this order:

1. Installs `docker.io`, `nginx`, `nftables`, `python3-websockets` (10.4 to 14.x),
   `openssl` and `curl`.
2. Loads the nftables table `inet juno_computer_host` **before anything listens**. Inbound
   it allows only 443 from `--web-ip`, SSH from `--ssh-from`, and the computers' own route
   to the egress proxy. Everything else is dropped.
3. Creates the unprivileged user `juno-computer-host`.
4. Runs `setup-vm.sh --computer-host`. This sets up:
   - the network `juno-computers` (172.30.0.0/24);
   - the egress proxy, with its log and its budget;
   - the firewall;
   - the `juno-computer:1` image (label `pipe-v4`);
   - the browser-sandbox probe.
5. Installs the root broker, behind a socket, and the service (`juno-computer-host`, on
   127.0.0.1:8750 and :8751). It writes `/etc/juno/computer-host.json`.
6. Sets up TLS and nginx on 443.
7. Writes the first token for the namespace. The host keeps only its sha256. The token
   itself goes to a **root-only file**, `/root/juno-computer-host-token-<id>.txt`, whose
   path setup prints.

Setup ends with a local health check and then prints the values to set on the web VM.

## 3. TLS and private networking

- **Default: `--tls private`.** `private-tls.sh <domain> /etc/juno/computer-host-tls` does
  three things:
  - It makes an EC P-256 CA with a **critical name constraint** that permits only
    `<domain>`.
  - It signs the host's certificate (397 days) and then **shreds the CA's key**.
  - It leaves `ca.pem` (for the web VM), `cert.pem` and `key.pem` (for nginx).

  Trusting `ca.pem` on the web VM therefore trusts exactly one name.
- **The name must be a DNS name.** The certificate says `DNS:<domain>`, and Node matches
  an `https://<IP>` origin only against IP entries, so a certificate for an address can
  never be trusted. Both scripts now refuse an IP address with `--tls private`. A private
  name is fine. Use either:
  - a record in a private DNS zone of the shared virtual network; or
  - one line in `/etc/hosts` on the web VM: `<host private IP> <host DNS name>`.

  `COMPUTER_HOST_URL` must use that name.
- **Private networking and `--web-ip`.** When the two VMs share a virtual network, use the
  web VM's **private** address. Over the public Internet, Azure may SNAT the web VM's
  traffic to its public address. Step 5 shows which address the host actually sees.
- **The alternatives:**
  - `--tls certbot --certbot-email <e>` uses Let's Encrypt, standalone. Port 80 is open
    only while certbot runs, and nginx reloads after each renewal. The host needs a
    public name, and the web VM needs no `NODE_EXTRA_CA_CERTS`.
  - `--tls own --cert <f> --key <f>` uses your own certificate.
- **Renewal.** Run `sudo bash deploy/computer-host/setup.sh --renew-tls` about a month
  before the `tls.notAfter` that `/v1/health` reports.
  - It renews the kind of certificate setup installed, unless you pass `--tls` (it reads
    `/etc/juno/computer-host-setup.json`).
  - With private TLS it makes a **new CA**. Add the new `ca.pem` to the web VM's trust file
    *beside* the old one, and remove the old one only after every process has restarted.

## 4. Set the web VM's environment

The production env is `~/juno/.env` on the web VM. Each deploy copies it into the new
release, and `deploy/deploy-from-mac.sh` builds against it. The GitHub `PROD_ENV` secret is
what a CI deploy writes, so **set every key in both places**. Otherwise the next deploy
from the other path drops it.

1. Put the CA on the web VM (private TLS only). Copy the `ca.pem` that setup printed to a
   file the app user can read, for example `~/juno/computer-host-ca.pem`.
2. Set the keys. `scripts/set-env-key.sh <KEY>` writes `./.env`: run it from `~/juno`. It
   reads the value from a hidden prompt, so a token never reaches the shell history.
   Every name below is read in `src/lib/env.ts` or `relay/src/computer-view.ts`.

   | Key | Value | Read by |
   |---|---|---|
   | `COMPUTER_PROVIDER` | `remote` | app, Work runner (`env.agentComputer.provider`). It wins over `AGENT_COMPUTER_PROVIDER` whenever it is present, even if empty. |
   | `COMPUTER_HOST_URL` | `https://<host DNS name>` | An origin only: no path, no query, https in production (`remoteHostConfig`). |
   | `COMPUTER_HOST_TOKEN` | the contents of `/root/juno-computer-host-token-<id>.txt` | 64 hex characters, or the provider stays off. |
   | `NODE_EXTRA_CA_CERTS` | the path from step 1 | Private TLS only. `deploy/ecosystem.config.js` passes it to `juno-backend`, `juno-work` and `juno-voice-relay` when they **start**. |
   | `RELAY_COMPUTER_HOSTS` | `https://<host DNS name>` | The relay (live view and takeover tunnels). It passes through as a `RELAY_*` key. |
   | `AGENT_COMPUTER_ROLLOUT` | `allowlist` | `allowlist` is the default (also when empty). `plans` opens computers to every plan that includes them. `off`, or any other value, admits nobody. |
   | `AGENT_COMPUTER_ALLOWLIST` | comma-separated user ids or **verified** emails | Empty admits nobody. An entry still needs Pro or above. |
   | `AGENT_COMPUTER_MAX_AWAKE_HOST` | the host's `--max-running` (default 6 on both) | The app's own cap. Keep it equal to the host's. |

   Optional, with these defaults:
   - `COMPUTER_HOST_TIMEOUT_MS=30000`;
   - `AGENT_COMPUTER_MAX_AWAKE_USER=2`;
   - `AGENT_COMPUTER_REQUIRE_BROWSER_SANDBOX=0`;
   - `COMPUTER_VIEW_RELAY_URL`, which falls back to the voice relay's URL;
   - the per-plan caps `AGENT_COMPUTER_MAX_ENABLED_<PLAN>` and
     `AGENT_COMPUTER_WEEKLY_MINUTES_<PLAN>`.
3. **Deploy to apply it:** run `deploy/deploy-from-mac.sh`. The app and the runner read the
   release's own copy of `.env`, and Node reads `NODE_EXTRA_CA_CERTS` only at process start,
   so editing `~/juno/.env` alone changes nothing that is running.
4. Delete the token file on the host once the token is in both places, and once you have
   run the first smoke in step 6.

## 5. Check the address the host sees

From the web VM:

```bash
printf 'Authorization: Bearer %s\n' "$COMPUTER_HOST_TOKEN" | curl -fsS -H @- https://<host DNS name>/v1/health
```

First load the token into your shell without echoing it, for example with
`read -rs COMPUTER_HOST_TOKEN`. The header goes through stdin, so the token never appears
in the process list.

- The answer reports the image, the number of computers running, `maxRunning`,
  `tls.notAfter` and `source`.
- **`source` must equal `--web-ip`.** If it differs, re-run setup on the host with
  `--web-ip <source>`. Setup is idempotent.
- If the TLS handshake fails, check:
  - `NODE_EXTRA_CA_CERTS` (for curl, add `--cacert <ca file>`);
  - that the URL uses the DNS name the certificate was made for.

## 6. Smoke before anyone uses it

On the host, while the first token file still exists:

```bash
sudo bash deploy/computer-host/smoke.sh --token-file /root/juno-computer-host-token-<id>.txt \
     --url https://<host DNS name> --ca /etc/juno/computer-host-tls/ca.pem
```

- Drop `--ca` with certbot or your own public certificate.
- Without `--url`, the smoke calls `http://127.0.0.1:8750` and skips nginx and TLS.

It drives one throwaway computer through the API and the tunnels, exactly as the app does,
then removes it. It prints one `ok` or `FAIL` line per step. The steps:

1. health (the image must carry `pipe-v4`) and available;
2. create, start and provision the CDP token, then check that the state is running;
3. CDP through the tunnel (`Browser.getVersion`);
4. exec;
5. a file round trip;
6. a screenshot;
7. the browser-sandbox state;
8. VNC through the tunnel (the RFB banner);
9. freeze and thaw, then pause and unpause;
10. stop, then remove the computer and its volumes.

It exits 0 only if every step passed.

**Run it again after every `--rebuild-image` and every `--renew-tls`.** By then the first
token file is gone, so mint a short-lived one:

1. Run `setup.sh --add-token --namespace prod`. It prints the new file.
2. Run the smoke with that file.
3. Run `setup.sh --retire-token <new id>`.

A namespace holds at most two tokens.

Then, in the product:

1. Sign in with an allowlisted account on Pro or above.
2. Open an agent and give it its computer: Computer in the side panel.
3. Ask it to open a site. Watch it work, press **Take control**, then hand it back.

The Work runner's log (`pm2 logs juno-work`) names any problem on the app side:

- `[agent-computer] COMPUTER_PROVIDER=remote is off: <reason>`: the URL or the token format
  is wrong.
- `the computer host refused this server's token`.
- `computer host call failed`.

## 7. Roll back

Use the fastest step that is enough. Each one leaves every computer's volumes, files and
sign-ins intact.

1. **Stop all use now, from the host:**

   ```bash
   sudo systemctl stop juno-computer-host
   ```

   Every call and tunnel fails at once. The app says the computer can't be reached and
   meters nothing past the last contact (`OPERATIONS.md` §8, "Losing the host").

   To also stop the running computers:

   ```bash
   sudo docker ps -aq --filter label=app=juno --filter name=juno-agent- | sudo xargs -r docker rm -f
   ```
2. **Turn it off in the app.** Set `AGENT_COMPUTER_ROLLOUT=off` or `COMPUTER_PROVIDER=off`
   in `~/juno/.env` and in `PROD_ENV`, then deploy.
   - Any value other than `docker`, `remote` or `fake` turns the provider off.
   - `set-env-key.sh` refuses an empty value, so use `off` rather than an empty one.
   - Nobody can then create, wake, view or use a computer, and no run gets computer tools.
3. **Narrow it instead:** take accounts off `AGENT_COMPUTER_ALLOWLIST`, then deploy.
4. **A leaked token:** run `setup.sh --add-token`, put the new token on the web VM and
   deploy, then run `setup.sh --retire-token <old id>`. Retiring a token also closes every
   tunnel opened under it.

`deploy.sh --rollback` restores the previous release with **its own copy of `.env`**. Rolling
back code past the deploy that turned computers on also turns them off. The next deploy
copies `~/juno/.env` again, so to keep them off, change that file too.

Never remove the `juno-agent-*` volumes as part of a rollback. That deletes people's files
and sign-ins, and only you can decide to do it.
