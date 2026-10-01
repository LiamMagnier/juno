# Security review of the 2026-10-01 continuation — 2026-10-02

The owner asked whether "the design change and security and everything chatgpt
have done is good or not". This is the security half of that answer, written
after an adversarial review of `git diff f5925044 25210430` and the code it
depends on, and after fixing what the review confirmed.

**Production runs `133dd285`.** Nothing here was pushed or deployed, and nothing
on the VM was touched. Lane: `rf/security-fixes`, landed on `rework/refoundation`.

## Verdict in one paragraph

ChatGPT's security work is mostly good engineering, aimed at the right
problems, and parts of it are better than what was there before: the
private-pipe CDP gate, the root Docker broker, the DNS-pinned egress proxy,
independent connector keys, the task-token refusal on `respond`, the
`userId`-keyed upserts and the bounded skill-package import. But one change,
making the ownership guard throw in production without auditing its call
sites, **broke core features in production** (every project chat, project
edit/delete, the member list, iPhone-to-Mac commands, roadmap votes, the admin
users page, Composio state changes, and silently memory extraction, which
re-paid an LLM call on every turn). The `SKIP_CHECKS` bypass added afterwards
let any inherited environment variable silently skip every release gate, and
the agent-computer uid split it built did not achieve the isolation its own
comments claimed. All three are fixed on the trunk with regression tests; the
production outage needs a deploy (see the end).

## Method and limits

- Two lenses were reviewed adversarially (sandbox, authz/API); each finding was
  then attacked by independent verifiers who ran real route handlers against a
  throwaway Postgres. This lane reviewed the release/gate lens itself and
  re-verified every fix below on this Mac.
- The review brief this lane received was cut off: the second confirmed
  finding's votes, part of the medium list, the authz lens's improvement list
  and the refuted-findings list were truncated. Where that matters it is said
  below; nothing here is reconstructed from memory.
- Not done: a live Linux/AMD64 run of the agent-computer image on a VM, and any
  production check (the owner's rule: no VM changes; liveness facts are the
  verifiers' read-only evidence plus the handoff's).

## Verdict per lens

| Lens | Is ChatGPT's work good? | Live in production? |
|---|---|---|
| Ownership / authz / API | The new and changed routes have **no IDOR or missing-session hole**: grants, custom MCP connectors, skill import/export, Code respond, session and host upserts and rooms are owner-scoped and validated. The guard's stricter scope rules are right. **But** turning it into an unconditional throw without a call-site audit was a production outage. | **Yes — outage live now.** Fixed on trunk. |
| Custom MCP (connectors) | SSRF handling is careful (DNS pinning, private ranges refused, credential stripping on cross-origin redirects, POST redirects refused). OAuth answers were read whole with no deadline. | **Yes** (DoS/OOM vector). Fixed on trunk. |
| Agent-computer sandbox | The hardening is real and well built, and it is **not live** (provider disabled, broker not installed). Its core claim did not hold: the agent drives the same display that ran a full 1001 desktop with a terminal and file manager. The broker also refused the provider's own commands, so it would have failed on first use. | No. Fixed on trunk; more work listed before enabling. |
| Release gates | Shared `local-gates.sh` for CI, Mac deploy and Mac release, plus migration replay, is a genuine improvement. `133dd285` then made it skippable by an inherited `SKIP_CHECKS=1` with no record. | The bypass script is live in the repo; production `133dd285` was evidently built with failing gates (its CI deploy run failed on tests). Fixed on trunk. |
| Secrets / crypto | Production refuses `AUTH_SECRET`-derived connector encryption and checks it at boot; the secret-scan fixtures added in `133dd285` are fake tokens (`ghp_abcdef…`, `ghp_012345…`). Good. | Already deployed and correct. |

## Genuine improvements (credit where due)

- **CDP is no longer a TCP port.** Chromium runs `--remote-debugging-pipe`; the only way in is a WebSocket gate that checks the `X-Juno-Cdp-Token` header with `hmac.compare_digest` at the upgrade, accepts only `/devtools/browser`, one client at a time, and is non-dumpable. The token is streamed via stdin (never argv/env) and deleted once read.
- **The app is no longer root-equivalent for Docker.** `setup-vm.sh` removes the app user from the docker group; a root-owned sudo broker pins image, network, `--cap-drop ALL`, no-new-privileges, read-only root, fixed mounts, bounded memory/CPU/pids, and runs Docker with a fixed environment (no `DOCKER_HOST`/plugin injection).
- **Egress is default-deny.** Firewall drops forwarded traffic except public DNS and the proxy; the proxy validates every DNS answer (incl. IPv4-mapped IPv6, link-local metadata, Azure wire server) and connects to the validated address without resolving again.
- **Live view** links are single-use server-side tickets; relay tokens are one-time with a 60 s lifetime and the relay only dials inside the computers CIDR.
- **Code `respond`** refuses Cloud Code task tokens (the untrusted runner could previously answer its own approval gate) and inputs are a bounded zod union.
- **Ownership guard semantics**: aggregates and upserts guarded; `OR` needs every branch scoped; `NOT`/`none`/`every`/`isNot`/`notIn`/empty never count. Session sync and host registration upserts are keyed with `userId` (a cross-owner id collision now fails closed).
- **Standing grants, custom MCP routes, skill package import** (no zip-slip, no execution, inflation bounded even when ZIP headers lie): owner-scoped and validated.
- **Connector encryption**: production refuses an `AUTH_SECRET`-derived primary key and checks at boot.
- **Shared local gates** and disposable migration replay used by CI, the Mac deploy and the Mac release.
- **Truthful docs**: `SECURITY.md` stopped claiming unwired prototypes as controls.

## Confirmed findings and fixes

### 1. The throwing ownership guard broke production features — HIGH, LIVE

`b1295d77` (ChatGPT's continuation, merged into `133dd285`) changed `src/lib/db.ts`
from "throw in development, log in production" to an unconditional throw and
added `count`/`aggregate`/`groupBy`/`upsert`. Call sites that had only ever
logged in production now failed before reaching the database. Verifiers drove
the real handlers with `NODE_ENV=production` against a throwaway Postgres and
reproduced every one, including for the project's own owner.

Broken (500 / "Couldn't start the chat"): every turn in a project chat
(`chat/route.ts` project lookup); project rename/instructions/work defaults and
delete; the member list; iPhone-to-Mac command enqueue; roadmap votes (500
*after* the vote was written); the owner's users page, also on any search that
matched nobody (`in: []`); Composio connect/disconnect transitions; research
source refresh. Silently degraded: memory extraction never advanced its read
mark, so **every turn re-ran (and re-paid for) extraction**; the attachment
text cache never saved (every turn re-read the file); agent computer status in
the agent config tools; two failed-dispatch task reads.

**Fix** (`c7147331`, `657dd846` for one type): each site is scoped to the owner
the caller already holds (`conversation.userId`, `task.userId`, `row.userId`,
`opts.userId`, `user.id`), or uses `prismaUnguarded` *after* the access check
where collaborators legitimately act on rows they do not own (project update by
an EDITOR, the member list), or because the question is global (the public vote
tally, the admin "active this month" count). The guard itself is unchanged: it
keeps failing closed.

**Regression gates:**
- `scripts/ownership-callsites.ts` + `tests/ownership-guard-callsites.test.ts`
  (in `npm test`): a TypeScript-AST scan of all ~1,200 guarded call sites in
  `src/` and `scripts/`, classifying the client (guarded `prisma`, its
  transactions, lazy imports, `new PrismaClient()`, `prismaUnguarded`) and
  judging each `where` the way `whereHasOwner` does. An unscoped literal fails
  the gate; a `where` it cannot see into must be listed with its reason (13
  today, each explained), and stale entries fail too. It finds every site the
  verifiers listed, including the admin `in: []` cases.
- `tests/ownership-guard-routes.integration.test.ts` (runs when
  `OWNERSHIP_TEST_DATABASE_URL` names a local throwaway DB): real handlers
  for project chat, project PATCH/DELETE as owner/editor/viewer, members,
  votes, iPhone commands, admin users (incl. empty search), and the library
  shapes. **9/9 pass; 5 fail on the old code.**

Residual: the scanner cannot see an owner value that is `undefined` at runtime
(it treats a named value as present). That case still fails closed.

### 2. The agent/browser uid split was not effective — HIGH (verifiers: MEDIUM), not live

Xvfb runs without access control and the agent's computer tools drive the same
display as uid 1000, while the display ran a full XFCE session **as uid 1001**
with a terminal, file manager and editor. GUI input could therefore start a
shell as the browser user, and because the browser was in the agent's group
with `/home/agent/work` at 0770, profile material could be moved where the
agent reads it and sent out through the proxy. The `cdp-gate.py` docstring and
the Dockerfile said this could not happen. Both verifiers agreed it holds and
corrected it to medium (not live; approvals still guard typed text).

**Fix** (`d73e2490`, `0167d4b3`) — the finding's option (b):
- Image `pipe-v3`: `xfwm4` alone; no session, panel, desktop menu, terminal,
  file manager or editor. The provider refuses older images.
- The browser is **not** in the agent group. It owns only
  `/home/agent/work/downloads` (2770 browser:agent); `/home/agent` and `work`
  are 0711.
- Chromium `URLBlocklist`: `file://`, `chrome://`, `chrome-untrusted://`,
  `devtools://`, `view-source:`; new tab is `about:blank`.
- The comments now say what the split does and does not do: the agent's
  *shell* cannot read the profile or the token; GUI control of the browser
  window itself is the approved takeover surface and the profile is treated as
  reachable through it.

**Verified on a locally built image** (Docker Desktop on this Mac, arm64, same
flags as production): only Xvfb, xfwm4, dbus, the gate and Chromium run as
1001; none of the removed binaries exist; `id browser` has no agent group;
the agent cannot list or write `/run/juno` or read the profile; the browser
cannot write `work/` but can write downloads, which the agent reads; the
provider's token handover is consumed; a wrong bearer is refused; Playwright
over the gate renders and screenshots; `file://`, `chrome://`, `devtools://`
are `ERR_BLOCKED_BY_ADMINISTRATOR` while the browser stays connected; the
agent's xdotool/scrot still work; x11vnc reads and deletes its password file.
This first run caught a real bug (the entrypoint could not create `/run/juno`
because `/run` is root 0755 in the container), fixed in `0167d4b3`.

Residual, owner decision: Chromium's own file chooser runs as 1001 and can
browse the profile, so a model with GUI control could upload a profile file to
a website. `"AllowFileSelectionDialogs": false` closes that but also stops
uploading files through the browser by GUI (the browser tool has no upload of
its own). Not set; recommended unless GUI uploads are wanted.

### 3. `SKIP_CHECKS` silently skipped every release gate — confirmed

`133dd285` ("Allow deployment gates bypass") made `scripts/local-gates.sh` exit
0 whenever `SKIP_CHECKS=1` was in the environment, and `deploy-from-mac.sh`
inherited the same variable. CI, the Mac release and the Mac deploy all call
that script, so one leftover `export` skipped every gate with a one-word banner
and no record. A verifier ran the gate script with `SKIP_CHECKS=1` inherited
under the Mac release and the deploy container: zero gate invocations.

**What changed and why** (`657dd846`). The owner added the bypass, so the
emergency path is kept, in the safest shape:
- `local-gates.sh` has **no bypass**. An inherited `SKIP_CHECKS` is reported and
  ignored. A push to main (CI) and the Mac release can never skip.
- The only emergency path is `deploy/deploy-from-mac.sh REF
  --skip-checks="<reason>"`: a flag, never an environment variable; a bare
  `--skip-checks` is refused; the reason must be one printable line of 12–300
  characters.
- It still runs the migration replay (host), `npm run security:check`, and
  `next build` (which typechecks and lints). It skips tests, contracts and
  runner/relay tests.
- It is logged: a red banner, a line in `~/.juno/deploy-bypass.log` on the Mac
  before anything is built, and the same line appended to
  `~/juno/deploy-bypass.log` on the VM before `deploy.sh` runs (the reason
  crosses SSH as base64). The final message repeats that the release did not
  pass its gates.
- `tests/gate-bypass.test.ts`: runs the real `local-gates.sh` with stubbed tools
  and `SKIP_CHECKS=1` and asserts every gate ran; exercises the flag parsing;
  pins the emergency branch, both logs and CI.

## Medium and low findings

Fixed (cheap and clearly right):

| Finding | Severity | Live | Fix |
|---|---|---|---|
| Custom MCP OAuth discovery/registration/token answers read whole (up to 32 MB each) with no deadline; sign-in start not rate-limited — one person could hold requests or push the 887 MB VM toward OOM | medium | **yes** | `0738452d`: 64 KB cap per answer (cancelled beyond), 15 s per hop, sign-in shares the 30/h probe budget. Hostile-server checks added to `test:custom-mcp`. |
| Broker refused the provider's real argv (labelled `volume create`, `exec --workdir`, `ps`/`volume ls`): creation, the shell tool and orphan reconciliation all fail; the obvious workaround restores root-equivalence | medium | no | `d73e2490`: broker accepts exactly those shapes (workdir only inside `/home/agent`); `tests/computer-broker-argv.test.ts` drives the real provider in production mode and runs every argv through `validate()` — fails on the old broker. |
| CDP token (and VNC password) delivered through shared `/tmp`; safety depended on host sysctls, also on unpause with agent processes alive | medium | no | `d73e2490`/`0167d4b3`: `/run/juno` tmpfs mounted by Docker 0700 uid 1001, required by argv and broker, checked by the entrypoint; files created with noclobber. |
| Broker namespace check failed open when `docker inspect` failed | low | no | `docker inspect --type container`, refuse on any failure. |
| Egress proxy: one 16-slot pool for all computers, per-recv header timeout | low | no | 6 per computer, 24 host-wide (under TasksMax 32), one 10 s header deadline, 30 min tunnel lifetime. |

Not fixed (recorded; none is live):

| Finding | Severity | Why not now / what to do |
|---|---|---|
| Chromium runs `--no-sandbox` as the uid that holds the profile; the image is only rebuilt by hand | medium | Needs a Chrome-compatible seccomp profile on the create argv and broker, validated on the Linux VM. Do before enabling; add a scheduled rebuild + recreation of idle computers. |
| CDP gate is a pure pass-through (no method allowlist) | low | Today only the app holds the token. Add a method allowlist before any tool gives the model raw CDP. |
| A page flooding protocol events (or a >64 MB message) stops the gate and the whole computer | low | Close only the current client on overflow and skip oversized frames; needs a pipe-level test. |
| VNC control password is 8 characters (RFB truncates there) and reachable from the agent's loopback | low | Protocol limit; online guessing is slow. Consider a per-computer listen on the bridge address only, or rate limiting. |
| Cloud runner task token can post control-kind events (e.g. `approval_response`) via `/events` | low | The runner legitimately posts mode-answered approvals (`runner/agent-core/src/protocol-legacy.ts`), so a blanket refusal would break it; mark runner-derived decisions distinctly from the person's and refuse person-only kinds from task tokens. |
| Custom MCP token refresh re-discovers the authorization server each time, so a changed metadata document can redirect the refresh token | low | Persist the token endpoint at connect (needs a column) and refresh against it. |
| Skill import checks its rate limit after doing work | low | Reported by the authz lens; not re-verified here. |
| `ProjectWorkspace` upsert by a collaborator uses the project id as the row id, so it collides with the owner's row | functional | Not security; noticed while fixing finding 1. |

## Refuted or corrected

The full refuted list was not in this lane's brief (truncated), so it is not
reproduced. Corrections the verifiers made to confirmed findings:

- Finding 1's provenance: `133dd285` did not touch `db.ts`; the throw came from
  `b1295d77` (ChatGPT's continuation), which is in the deployed release.
- Finding 2's root cause is not `Xvfb -ac`: the design needs uid 1000 to drive
  the display anyway, so removing `-ac` alone would not close it. The 1001 GUI
  apps and the shared group were the problem. Severity high → medium (not live;
  typed text and shell commands always ask the person).

## PRODUCTION ACTIONS NEEDED (ranked)

1. **Deploy the ownership fixes — live outage.** Project chats, project
   edit/delete, member lists, iPhone-to-Mac commands, roadmap votes, the admin
   users page and Composio connect/disconnect fail in production today, and
   memory extraction re-spends an LLM call every turn. The fix is on the
   trunk. Because the trunk also carries undeployed redesign work, a minimal
   branch off `main` exists for a production-only fix:
   **`hotfix/ownership-guard-callsites`** (not pushed) = `main` + the
   ownership fixes and their gates + the custom MCP OAuth bounds + the custom
   MCP safe-fetcher fix from the web-baseline lane (item 3), verified there
   with the guard tests, the DB-backed route suite (9/9) and `test:custom-mcp`
   (14/14). Deploy whichever the owner chooses, through the gates (CI on push
   to main, or `deploy-from-mac.sh` without the emergency flag). Afterwards
   smoke: a turn in a project chat, rename and delete a test project, open
   its members, vote, open Admin → Users, connect Composio if configured.
2. **Expect a one-time memory backlog.** Conversations whose read mark never
   advanced since the 2026-10-01 deploy will be processed once after the fix;
   watch background LLM spend for a day.
3. **Same deploy: custom MCP fixes.** (a) The OAuth bounds above (a
   user-triggerable memory/connection-holding vector on the 887 MB VM). (b)
   Found and fixed on the trunk by the web-baseline lane (`1ec384b3`), live in
   `133dd285`: the Work runner rebuilds connectors without the `custom` field,
   so a person's custom MCP connector was dialled with plain `fetch` (no DNS
   pinning or private-range refusal) in Work runs, and its switched-off tools
   were offered. Both are in the hotfix branch.
4. **Treat `133dd285` as ungated.** Its CI deploy failed on tests and the local
   gate failed at that commit, so it was evidently built with the bypass. Check
   no shell profile on the Mac exports `SKIP_CHECKS` (it is now ignored, with a
   warning). Any emergency bypass from now on leaves a line in
   `~/juno/deploy-bypass.log` on the VM.
5. **Before enabling agent computers** (nothing to do today; provider disabled):
   provision a host that can run them; build the `pipe-v3` image there; run
   `setup-vm.sh` (new broker rules, proxy limits); delete and recreate any
   existing computers and volumes (old volumes keep the old downloads
   ownership, and the provider refuses `pipe-v2`); restart the app's service
   identity to drop docker-group membership and audit its sudo rights; decide
   `AllowFileSelectionDialogs`; restore Chromium's sandbox with a seccomp
   profile; schedule image rebuilds; re-run the acceptance script
   (`.claude/local-tools/refoundation-artifacts/tools/sec-fixes/image-check.sh`
   in the main checkout) on Linux/AMD64.
6. **No secret rotation and no migration** are needed for any finding here.

## Gates run on this lane (Node 24, before landing)

- `npm run typecheck`: pass.
- `npm run lint`: 0 errors, 7 warnings (all pre-existing, in the old
  `src/app/dev/design/canvas` and `porcelain` galleries).
- `npm test` (full chain): unit 4,514 tests, 4,442 pass, **0 fail**, 72
  skipped; then auth, message crypto, moderation, skill package (9) and custom
  MCP (14, including the two new hostile-server checks) all pass.
- `npm run security:check`: pass (tracked secret scan of 6,786 files,
  dependency audit, security release gate).
- `npm run build`: see the landing note below.
- `python3 -m unittest` infrastructure suite: 11/11 (broker, proxy).
- `tests/ownership-guard-routes.integration.test.ts` against a throwaway local
  Postgres 17 with all migrations: 9/9 (5 fail on the old code).
- Local image acceptance of `pipe-v3` on Docker Desktop: all checks listed
  under finding 2.
