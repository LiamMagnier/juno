# Security, release and maintenance continuation — 2026-10-01

## Stop state and checkout

The owner stopped further rework and requested a complete handoff, push and website deployment. At the final inspection, the integrated source is in `/Users/liammagnier/Developer/project/juno` on `main`, commit `133dd2857c787f70600b273994707263f109131c`. An external process merged and pushed the lane work while this lane was validating it. The original shared `/Users/liammagnier/Developer/project/juno-refoundation` checkout was reset back to the historical pause commit `756a93dc`; it is an ancestor of current main and is **not** the checkout to resume. This lane did not push or deploy.

The code at `133dd285` includes a later, externally introduced gate bypass: `deploy/deploy-from-mac.sh --skip-checks` and `SKIP_CHECKS=1` in `scripts/local-gates.sh`. This lane initially disabled bypass, but that change was superseded by the integration. Do not describe the current local gate as impossible to bypass. No bypass was used by this lane.

## Implemented source changes

### Ownership guard

- `src/lib/db.ts` throws before database dispatch for unscoped queries in **every** environment; production no longer logs and proceeds.
- Guarded operations include `findMany`, `findFirst`, `findFirstOrThrow`, `findUnique`, `findUniqueOrThrow`, `update`, `updateMany`, `delete`, `deleteMany`, `upsert`, `count`, `aggregate`, and `groupBy`.
- `whereHasOwner` requires a positive nonempty owner value, positive `equals`, or nonempty bounded `in`. A NOT/negative filter does not establish scope. Every OR branch must establish scope; one scoped AND branch suffices. Nested compound uniques and positive relation filters remain supported.
- Two existing unscoped upserts were corrected: Code device session ingestion adds `userId` to the `deviceId_sessionId` where; Work host registration adds `userId` to its device where.
- `tests/ownership-guard.test.ts` exercises OR/NOT/empty-filter cases and actual Prisma extension rejection for read/aggregate/mutation/upsert operations before an engine query.
- **Remaining:** create/createMany ownership assignment and nested mutations are not comprehensively guarded; `prismaUnguarded` is still an explicit escape hatch. The requested complete per-call-site audit of global queries was not completed. This tripwire is not an authorization proof for every query or relation.

### Connector encryption policy and boot

- `src/lib/crypto.ts` refuses production when `TOKEN_ENCRYPTION_PRIMARY` is unset, blank, or `auth`; an explicit independent 32-byte key in `TOKEN_ENCRYPTION_KEYS` must back the primary.
- `assertConnectorEncryptionConfigured()` is invoked from the Node boot checks before the process sends PM2 readiness. A broken/missing production key configuration refuses startup.
- Legacy `auth` decryption remains available, permitting rotation of old connector/Account ciphertext into the independent primary. This change does **not** rotate existing data or retire AUTH_SECRET automatically.
- `tests/connector-encryption-policy.test.ts` uses isolated production subprocesses to prove unsafe-primary refusal, missing/malformed-key refusal, independent-key roundtrip, and legacy payload decryption.
- **VM read-only evidence:** the current production `.env` has an independent primary and a connector keyring. Values were neither printed nor changed. There is no current key-provisioning blocker for the already deployed source. A future environment without these settings must be provisioned before deployment; rotate existing rows before changing AUTH_SECRET.

### Artifact maintenance inside the existing worker

- `src/lib/artifact-maintenance.ts` is a small scheduled service with injected callbacks. The existing Work scheduler invokes it during ticks.
- Idle drafts: once per minute, at most 25 candidates per pass. Artifact trash: once per six hours, at most one page of 25 artifacts per pass.
- `purgeExpiredArtifacts` accepts an optional `maxBatches` bound, validating positive integer values. Default manual behavior remains unchanged.
- Purge remains dry unless `JUNO_ARTIFACTS_PURGE=1`; that floor is enforced by the artifact library. Failure of either sweep is reported and retried on its next cadence without ending scheduler dispatch.
- The scheduler shares its existing Prisma client/pool allocation. There is no eleventh PM2 app. The 10-process ceiling and total 14-slot pool budget remain.
- The standalone artifact script remains available for manual runs; its comment now says production hosts the sweeps in the existing scheduler.
- `tests/artifact-maintenance.test.ts` proves cadence, independent failure handling and retries.

### Shared local release gates

- `scripts/local-gates.sh` is called by deploy CI, the Mac VM deploy, and the Mac release script. It builds generated inputs/runner; checks typecheck, tests, lint, security, approval dispatch, infrastructure Python tests, contracts/tokens/parity/sandbox; tests runner/relay; builds relay; runs release source invariants.
- `scripts/check-local-migrations.mjs` creates a **disposable** Postgres 16 container on a random loopback port, validates the schema and runs migration replay/diff with `--exit-code`. It cleans up its own container and temporary directory. An optional Git ref archives only that commit's Prisma source into a temporary directory before checking it.
- Hosted macOS without Docker falls back to a fresh local pg_ctl cluster. The macOS release workflow installs PostgreSQL 16 and relay dependencies for that path. The fallback implementation was syntax-checked but not exercised here; the Docker path was exercised.
- Mac VM deploy first invokes the shared gate's `--migrations-only "$SHA"` on the host, then the other checks inside its Linux build container with `--without-migrations`; no Docker socket is mounted into the build container.
- Mac release invokes the shared gate before archiving, after ensuring relay dependencies exist.
- **Current integrated limitation:** the external `133dd285` commit reintroduces skip controls. CI remains the required independent evidence; do not infer a green CI run from a local bypass or successful live deployment.

### Truthful security documentation

`SECURITY.md` now describes the actual heuristic untrusted-content detection and approval policy; it does not claim full provenance tracking. The standalone trust-boundary, enterprise SSO and DLP modules are explicitly described as unwired prototypes. It describes the strict ownership tripwire and adds WorkEvent/WorkRunIO to the plaintext-at-rest disclosure. Prototype modules were retained, not deleted or wired.

## Agent computer image, broker and egress

### Source implementation

- Protected desktop, Chromium and CDP gate run as browser UID 1001; agent shell/file execution remains UID 1000. Browser is a supplementary member of the agent group for the shared downloads directory.
- Browser profile is in its own named volume at `/home/browser`, owner-only mode 0700. Each agent now has separate agent-home and browser-home volumes. Deletion of the agent with removeVolume also removes the browser volume.
- Chromium uses `--remote-debugging-pipe`; raw TCP DevTools port 9223 is removed. A Python WebSocket adapter bridges authenticated `/devtools/browser` connections to private fd 3/4 pipes. Exactly one matching token header is required; one controlling connection is allowed at a time. The token is provisioned as UID 1001 through stdin into tmpfs, consumed and removed; the gate is non-dumpable.
- Both pipe descriptors are explicitly inheritable after dup2, including when a copied descriptor already equals fd 3/4. The fake-fd integration test caught that real CLOEXEC issue before release.
- On client disconnect, the pipe adapter disables auto-attachment so an enduring pipe can release debugger-paused targets and reconnect. ConnectionClosed is handled without dumping a normal disconnect traceback.
- The image declares `juno.security=pipe-v2`; provider availability requires that label, preventing an old unsafe image from satisfying availability merely because its tag exists.
- Browser connection discovery no longer executes curl against raw 9223 inside the agent shell; it directly uses the authenticated WebSocket endpoint.
- Production Docker CLI calls go through `sudo -n /usr/local/sbin/juno-computer-docker-broker`. The root-owned Python broker permits only the agent namespace, fixed sandbox flags, fixed named-volume mount destinations, the configured image/network, bounded CPU/memory, and unprivileged exec. It refuses arbitrary run/build/privileged/host-network/host-mount requests. Exec environment additions are limited to DISPLAY and agent HOME. Docker invocation uses a fixed root environment to exclude daemon/config/plugin injection.
- `setup-vm.sh` installs the broker/policy/sudo rule and removes the application user from the docker group. Old logged-in processes must be restarted to drop prior supplementary group membership. This source installation alone does not prove an application account with broad sudo rights is isolated; audit the actual service/deploy identity before enabling computers.
- Egress proxy: root-owned Python HTTP/CONNECT proxy, bound to the computer bridge gateway, validates every DNS result, rejects private/reserved/metadata addresses and unsupported ports, pins the upstream socket to its validated IP, bounds active connections and idle time. Systemd runs it with DynamicUser/NoNewPrivileges/protected filesystems, 96 MB memory and 32 tasks.
- Firewall permits direct public resolver DNS and host proxy access, drops other new forwarded egress and private host access, and refuses IPv6 from the computer bridge. Chromium and shell proxy settings use the gateway proxy; Chromium's loopback bypass is disabled.

### Actual local validation

Docker Desktop was already installed but stopped; this lane opened it for reversible local validation. The image was built on the local ARM64 Docker engine as `juno-computer:refoundation-security`.

A real container was started with dropped capabilities, no-new-privileges, read-only root, tmpfs, bounded memory/CPU/processes, and both named home volumes. Evidence:

- Browser `id`: UID/GID 1001, supplementary group 1000; agent `id`: UID/GID 1000.
- UID 1000 could not read a UID-1001 profile probe or the CDP token file.
- Raw `http://127.0.0.1:9223/json/version` did not answer.
- An invalid CDP bearer received 403.
- Authenticated Playwright connected through the adapter to real Chromium, set page content/title, and took a **7,826-byte PNG screenshot**. The title was `Private pipe verified`.
- The temporary Python WebSocket/fake-Chromium-fd test passed after the inherited-fd repair.
- Five Python broker/egress tests passed: unprivileged/namespace exec, complete sandbox requirements, refusal of privileged/host mount/image/network/resource variations, private/metadata/mapped-address refusal, mixed DNS refusal and exactly-once pinned DNS connection.

A proposed Chrome policy `DeveloperToolsAvailability=2` was removed after real testing showed it also rejects legitimate CDP target attachment (`Not allowed`). Do not restore that setting without a working automation-compatible alternative. Shared GUI/X11 interaction remains intentional; UID/profile and pipe isolation do not claim that approved GUI control is unable to access signed-in browser content.

**Not validated:** real Linux host sudo broker installation, systemd service behavior, host iptables enforcement, proxy service routing on the production bridge, old-profile migration, full reset/reconnect lifecycle under sustained CDP load, and Linux AMD64 image startup. The local image test used the Mac Docker bridge rather than applying firewall rules to the VM or Docker Desktop's host namespace. No claim that these deployment requirements are completed.

**Production status:** computer provider is disabled and the root broker is absent. The 887 MB VM remains too small to enable the image safely. Deploying the website does not enable computers. Provision a suitably sized host, build the v2 image, install broker/proxy/firewall, restart service identity to drop docker-group rights, inspect broad sudo grants and reset/migrate old containers before enabling the provider. Never install the proxy as another PM2 Node worker.

## Validation and CI truth

Before the concurrent external merge, targeted ownership/maintenance, connector policy, computer lifecycle/takeover and release-script tests passed; typecheck and targeted ESLint passed. Shell scripts and Python infrastructure were syntax-checked.

Disposable migration replay passed for both current lane source and archived HEAD: Prisma schema valid; **No difference detected**. Existing backup restore drill was exercised against `/opt/homebrew/opt/postgresql@17/bin`: **3 database rows and 3 objects restored with matching integrity**. This is a fixture drill, not a production restore. Production backup scheduling, production restore smoke, measured production RPO/RTO and operator installation remain incomplete.

The supported local runtime is `/opt/homebrew/opt/node@24/bin` (Node 24.20.0). Default shell Node is 26, outside the repository engines. Use:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/local-gates.sh
```

Final targeted rerun against integrated main, on Node 24, counted **83 tests: 80 passed, 2 failed, 1 skipped**. Failures:

1. `tests/agent-computer-takeover.test.ts`: static source assertion expects `spawnDockerWithStdin`, but the integrated provider uses `spawnWithStdin`. The actual resolved-path guard is still before the write.
2. `tests/agent-computer.test.ts`: awake-cap test expects the obsolete `You already have 2 awake agent computers` sentence, while integrated source throws the new typed ComputerError with the public cap message.

The skipped test needs `flock`, absent on this Mac and present on VM/Linux CI. All five broker/egress Python tests passed again. MCP SSRF CI also has a stale source-pattern assertion: it expects `userServer ? safeMcpFetch` while integrated source applies the safe fetcher to `userServer || c.custom`, a broader safeguard. These are unresolved verification failures at the owner stop; this lane left the tests unchanged. Do not mark CI green.

GitHub deploy run **36885598783** and native run **36885598776** at `133dd285` failed. The deploy logs contain actual test failures; billing is no longer the only explanation. The root lane records the complete test-failure inventory. No new development fix was retained after the owner's stop.

## Read-only production evidence and deploy preparation

- SSH key is readable at `/Users/liammagnier/Developer/KEY/chatliamsdev.pem`; authenticated SSH works as `liammgnr@20.91.138.96`.
- GitHub CLI is authenticated for the repository; Actions secret names include PROD_ENV and VM SSH configuration. Secret contents were not printed.
- Public `/api/health` returned `ok:true`, `db:ok`, exact version `133dd2857c787f70600b273994707263f109131c`.
- VM current symlink: `/home/liammgnr/juno/releases/133dd2857c78-20261001155737-59211`.
- The old deployment lock names PID 59211; that PID is no longer alive. No lock was removed and no duplicate deployment started.
- All **10 PM2 apps** were online: backend, Work executor, Work scheduler, research, triggers, memory dreamer, agent reflector, import recovery, Code sweeper, voice relay.
- Independent connector keyring is already present; computer provider disabled; broker absent; smoke credential configuration present. These are booleans from a secret-suppressed remote inspection.
- The raw stored smoke access credential was expired: authenticated smoke passed health then failed `/api/v1/models` as unauthenticated. The standard release credential refresh was then used with token captured internally and never printed; see final smoke result appended below.

The standard future website deployment command is:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH bash deploy/deploy-from-mac.sh origin/main
```

At this handoff the site already serves the current remote main source. Do not redeploy merely because a documentation-only continuation is pushed, and do not push a redundant code change. This lane performed no push, deploy, rollback, provisioning or credential/environment rewrite.

### Final production smoke result

With the standard fresh release-smoke credential (never printed), the live source `133dd285` passed:

- health and database check;
- model catalog for the ordered release candidates;
- real Qwen chat submission reaching a terminal response;
- completed receipt and canonical idempotent replay;
- voice relay-token URL `wss://chat.liams.dev/voice-relay`;
- public UI smoke (exit 0).

This smoke used the existing dedicated release-smoke identity and routine token refresh; it did not rewrite `.env`, deploy a release, alter a connector key, enable computers, or install VM services. The authenticated smoke creates its normal disposable chat/receipt state and performs the real provider request.

The test computer container and its two test-only named volumes were stopped/removed. The locally built security image remains available as cached validation evidence. Docker Desktop was left running for the root lane's remaining checks. Temporary `__pycache__` directories in both checkouts were removed.
