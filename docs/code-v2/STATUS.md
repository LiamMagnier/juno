# Alevr Code v2 — integration status

Trunk `code/v2` (worktree `.claude/worktrees/code-v2`). Nothing here is pushed,
merged to `main` or deployed. Source of truth for the plan: `SPEC.md`; design:
`DESIGN.md` + `INTERACTION_SPEC.md`; device link: `DEVICE-LINK.md`; vendor
terms to re-check before release: `PROVIDERS-LEGAL.md`.

## Merged lanes (in order)

| Lane | Branch tip merged | What shipped |
|---|---|---|
| design | `code-v2/design` f7b66088 | DESIGN.md, INTERACTION_SPEC.md (20 micro-interactions), six HTML mocks in `mocks/` built on the product's own tokens and icons |
| models | `code-v2/models` 702bbcf5 (**not** the WIP abea790e) | Context-window tiers from `pricing.ts`, curated best-for-coding catalogue, tiers in the native manifest; BYOK keys sealed per user and lab (`/api/provider-keys`, tested before saving); `/api/agent` on the user's own key without ApiSpend, honouring a requested tier (400/413); per-thread role routing (`/api/code/routing/[conversationId]`), snapshotted onto tasks; `/code` opens for BYOK and paired-Mac users |
| orchestrator | `code-v2/orchestrator` b6ef51ef | agent-core: background subagents, role routing, budget, workflow, best-of-N, steer/queue, guards (255 tests). Swift engine: `SubagentRouting`, `RunBudgetLedger`, concurrency up to 6, `message_subagent`, repeat-call guard, fail-closed `AutoReviewer` |
| env | `code-v2/env` 96d2a982 | `runner/env-server`: loopback WebSocket protocol with per-launch bearer, JSONL log + snapshot/cursor replay, provider registry and detection, install/sign-in steps, usage limits, terminals, hidden-ref git checkpoints, worktrees, Alevr MCP; adapters for Claude (user's own `claude` via the Agent SDK), Codex app-server, ACP (Gemini, Grok, DeepSeek Harness, OpenCode; Antigravity on legal hold) and the Alevr/BYOK engine. Device-link hub + routes |
| computer | `code-v2/computer` 27b47aeb | Portable `computer_use` for every provider, ax_find/ax_press/menu, cross-process desktop lock, Mac bridge + overlay, web `ComputerTimeline` |
| mac | `code-v2/mac` b4d7d325 | Studio v2 thread, dock (Changes with per-hunk git apply, Agents, Best-of-N, Screen), composer (model picker with provider rail, traits, context-tier selector, Orchestrate, context gauge, queue, steer, approval takeover, Limited), Connections settings, env-server sidecar + hub, device link, snapshot gallery |
| web | `code-v2/web` 0c4b9963 | `/code/[id]` workspace (`src/components/code/v2`): sidebar, folding thread, step rows, receipt, checkpoints, plan card, agent tree, composer with takeover/queue/steer, pickers (model, traits, tier, Orchestrate, permissions), resizable dock, palette and keymap; Connections; `/dev/code-v2` gallery (13 states) |

`src/components/library/library-nav.tsx` (the models WIP commit abea790e) was
**dropped**: it came from another session's stash (rework/refoundation) and is
not part of this work.

## Integration work on `code/v2`

- **Merge conflicts**: the contract drift script (both lanes' schema entries kept,
  schema/runner/env-server copies regenerated), `CodeV2Contracts.swift` (every
  lane's fields kept; memberwise inits gained the new fields as defaulted
  parameters).
- **One device link.** The env and web lanes had each built
  `/api/code/v2/link/[deviceId]`, and the Mac spoke a third wire. Kept the env
  lane's in-memory hub (browser rpc + cursor polls; Mac pull + push at
  `./host`; replays from the Mac's log), with the web lane's strict request
  parsing. Rewrote the Mac's `EnvServerDeviceLinkChannel` to drain that hub:
  same remote rules, ordered events, 50 ms push batching, stops on 404/409.
- **Computer use in the env server**: `startEnvServer` registers `computer_use`
  on the Alevr MCP (offered while the Mac bridge socket exists; items land in
  the session log; released on session close via the new
  `SessionManager.onSessionClosed`); MCP results admit image blocks; Gemini
  sessions get 0–999 coordinates. Mac thread captions the new actions.
- **Orchestrate and `auto` on the Mac engine**: `SessionController.setRoleRouting`
  / `setAutoReview`; routing is part of the turn contract, so the delegate
  tools are rebuilt with role routing, one budget ledger per turn (reset as
  each turn starts) and concurrency sized to the workers (3–6); `auto` installs
  the fail-closed reviewer. Synced from the v2 composer.
- **BYOK in the switch**: `features.codeOpen` in the app bootstrap unlocks the
  Code segment of the product switch for BYOK / paired-Mac users.
- **Sidecar end to end**: the Mac resolved the wrong entry (`index.ts`, the
  library barrel). It now runs `alevr-env.mjs` / `dist/bin.js` / `src/bin.ts`,
  reads bin's handshake line, passes `--data-dir` and `--parent-pid`.
  `bundle:mac` was broken twice (agent-core import, `createRequire` banner
  clash); fixed and smoke-tested from a copy outside the repo.
- **Design gates**: the two LiveUI regressions from trunk (one frozen font size,
  one glass card) and the computer overlay's glass label are now opaque /
  scaled, so all six `native:design` gates hold.

## How to run the env server

Development (from the repo):

```sh
cd runner/env-server
npm run dev                       # tsx src/bin.ts; prints {"alevrEnv":1,"port":…,"token":…}
# or: npm run build && npm start  # node dist/bin.js
```

Flags: `--port N`, `--data-dir DIR` (default `~/.alevr/env`, or
`ALEVR_ENV_DATA_DIR`), `--parent-pid PID`, `--allow-origin URL`, `--log debug`.
It binds 127.0.0.1 only; clients connect to `ws://127.0.0.1:<port>/` with
`Authorization: Bearer <token>` (browsers: subprotocol `alevr-token.<token>`).
It exits when stdin closes, so keep stdin open when you background it.
`ALEVR_COMPUTER_USE=0` turns computer use off.

In the Mac app: build the bundle once with `npm run env-server:bundle:mac`
(writes `native/macOS/JunoDesktop/Resources/env-server/alevr-env.mjs`, shipped
at `Contents/Resources/env-server/`). The Code window starts it through
`EnvServerSidecar` with the user's `node`. Without the bundle a debug build uses
the repo checkout, or `ALEVR_ENV_SERVER_ENTRY=/path/to/entry`.

From the web: turn on **Remote hosting** on the Mac. The Mac then drains the
device-link hub; `/code/[id]` reaches its env server through
`/api/code/v2/link/<deviceId>`. Terminals and `env.configure` are never relayed.

## Connecting each subscription

Everything runs the vendor's own CLI on the user's Mac, signed in with the
user's own account; Alevr never reads or stores a vendor token. In the app:
Code › Settings › Connections (Mac) or Settings › Connections (web, for a
paired Mac) shows each one with Install / Sign in buttons that run these:

| Shown as | Needs | Sign in |
|---|---|---|
| Claude (your subscription) | the user's own `claude` CLI | `claude auth login` |
| Codex (your ChatGPT plan) | `codex` CLI | `codex login` |
| Gemini CLI | `npm install -g @google/gemini-cli` | first run of `gemini` signs in with Google |
| Grok | `grok` CLI | `grok login` |
| DeepSeek Harness | `npm install -g @deepseek-ai/dsh` | per its CLI |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode auth login` |
| Antigravity | Connections › Install (Alevr downloads Google's official runtime, pinned size and SHA-256) | Connections › Sign in: Google's page in the browser; from another device, paste the address it ends on |
| Your own API keys (BYOK) | a key per lab | Settings › Connections › API keys (tested with the lab before it is saved) |

After signing in, the provider probe (Refresh) turns the instance ready; usage
limits show as "limited until <reset>".

## Verification (integration tree)

See the result object of this run for exact commands; summary:

- `node scripts/check-code-v2-contracts.mjs`: in sync (69 definitions, 9 fixtures, Swift mirror).
- Root `npm run typecheck`: 0 errors (after building agent-core dist, generating the
  i18n catalogue, and generating this worktree's own Prisma client).
- `npx prisma validate`: valid.
- eslint on every changed TS/JS path: clean.
- runner/agent-core: 255/255. runner/env-server: typecheck clean, 34/34 tests.
- `native:design:check` (all 6 gates), `native:contract:check`, `native:icons:check`: pass.
- Root `npm test`: 6,627 tests, 0 failures.
- Swift JunoCode (`swift test`, all targets): Runtime 638, UI 379 (45 skipped), Local 428, Core 258, Bridge 200, Simulator 54; 0 failures.
- JunoDesktop `xcodebuild test -only-testing:JunoDesktopTests`: builds; 450 tests, 19 issues, all in shell/sidebar/icon/shortcut tests whose sources this branch does not touch (DesktopShellContract, DesktopDestination sidebar/more cases, DesktopIconCatalog geometry, JunoShortcutRegistry view menu): inherited from the trunk base, not fixed here.

## Left to do

- **Signed-in, real-hardware checks**: a real Claude/Codex hand-off through the
  bundled env server in the running app; `/code/[id]` against a real account
  and Mac through the device link; computer use with Screen Recording and
  Accessibility granted.
- **Web**: install `@xterm/xterm` for the Terminal tab; the Code sidebar is
  ready but the app shell still renders its own. The runtime APIs below
  (applyPatch, schedules, managed install/sign-in) have client functions but
  no visuals yet: that is the UI rework's job.
- **Antigravity**: a real Google sign-in and a real download of Google's 111 MB
  release on this Mac (the tests use a fake runtime and a local archive).
- **Mac**: Terminal/Files/Preview dock tabs for env-server threads;
  connected-agent approvals use NSAlert until they get a Studio card;
  Orchestrate selections on other providers (subscriptions, BYOK) inherit the
  parent's model in the Swift engine (no resolver yet); the overlay window has
  no snapshot test.
- **Release**: re-check every item in PROVIDERS-LEGAL.md (including the
  Antigravity terms risk); Codex ChatGPT token sharing stays disabled.
  OpenRouter BYOK is not in the catalogue.
- Owner questions in DESIGN.md §11 (coral value, auto-deleting losing Best-of-N
  worktrees, Antigravity visibility).

## Adversarial review (2026-10-09)

Fixed on code/v2:

- Device link: a remote could attach to a session in an unshared folder by naming its id next to a shared cwd. The Mac now checks the existing session's folder, links only after a successful open, filters `session.list` to shared folders and resolves symlinks.
- Env server: a hub replay (`session.open` with a placeholder cwd of `/`) could create a session for an unknown id. `afterSequence` now only re-attaches, and the hub always sends it.
- Budget: the routing budget was not enforced for subagents spawned through the Alevr MCP. `spawn_subagent` now refuses once the turn's children spent it, interrupts running children when it is crossed, and caps running children at 6.
- Approvals: `approval.respond` accepts only a decision the request offered, so "allow once" cannot become "allow for the session". ACP read-only declines every non-read kind.
- Checkpoints: after a restore, the next turn reuses the ordinal and overwrites its ref. An older checkpoint item could then restore or diff the newer turn's files. A superseded checkpoint is now refused.
- Secrets: the env server bearer is removed from the process environment after it is read, so child processes cannot inherit it. Repo `worktree-setup` scripts run without ALEVR_/JUNO_ variables, and `server.json` no longer holds the token.
- UI: Antigravity is listed as held instead of missing (web and Mac). Orchestrate role buttons share one column. Mac diff fills use the Code spec's quiet washes in dark. The computer-use fixtures show drawn frames. OpenCode uses the terminal glyph. The model rows on a subscription show its largest window.

Screens: the web /dev/code-v2 gallery (13 states × light/dark × desktop/mobile) and the Mac CodeV2Gallery (13 surfaces × light/dark, rendered inside JunoDesktop so the icons load).

## Runtime lane (code-v3/runtime, 2026-10-09)

Owner request (2026-10-09): "enable antigravity and finish the remaining items". Branch `code-v3/runtime` from `code/v2` c453c8e7. Not pushed, merged or deployed.

- **Antigravity enabled** (owner decision, 2026-10-09). The legal hold is lifted in the env server presets and registry. Alevr installs Google's official ACP runtime from `dl.google.com` (pinned size and SHA-256, exact two-file archive, identity checked with `initialize` before activation), signs it in with Google through the runtime's own `127.0.0.1` callback with a paste-the-address fallback for other devices, keeps one private profile per instance (`GEMINI_HOME`, file token storage), strips ambient `GEMINI_API_KEY` / Google credentials, probes with `initialize` only and declares its capabilities honestly. New commands `provider.install` and `provider.auth`; instances carry `install` and `auth` state. Web and Mac Connections data list it as a normal provider (no flag) and route Install / Sign in to those commands. Terms risk that remains: PROVIDERS-LEGAL.md "Antigravity".
- **Rollback scoped to the session**: `checkpoint.rollback` restores only files this session's own turns changed after the checkpoint (consecutive checkpoint diffs plus its file_change items), inside its folder. A file changed again after the session's last turn (another session, the user) is left alone and named in the notice.
- **Stale snapshots never apply**: `classifyEvent` (all TS copies) and the Swift `classify` treat a `session.snapshot` older than the cursor as a duplicate; `scripts/check-code-v2-contracts.mjs` asserts the rule in both languages.
- **Resume at reset**: `turn.schedule` / `turn.unschedule`, persisted in the session log (`session.scheduled`, `SessionSnapshot.scheduledResume`) and `schedules.json`, re-armed after a restart, superseded by any new turn. Client functions: web `EnvClient.scheduleResume` / `cancelScheduledResume`, Mac `EnvServerConnection.turnSchedule` / `CodeV2EnvSession.scheduleResume`.
- **Rejected hunks on the Mac**: `checkpoint.applyPatch` (forward or `reverse`, `checkOnly`), all or nothing, paths confined to the session's folder (no `..`, no `.git`, no symlink writes), refused while a turn runs. The Mac dock's Reject now goes through it (it also fixes a subfolder session, whose diff paths are repository-relative); web `EnvClient.applyPatch` takes `rejectedPatch(...)`.
- **Device-link hub on Postgres** behind the same interface (`ALEVR_LINK_STORE=postgres`), memory by default. See DEVICE-LINK.md.
- **Release ships the env server**: `native/Scripts/release-macos.sh` typechecks, tests and bundles it, checks the bundle runs and that the exported app carries it; the JunoDesktop pre-build phase builds it for non-Debug configurations. The app checks the user's Node (22.18 or later) and says plainly in Connections when it is missing or too old.
- **Computer bridge bound to the env server**: the Mac bridge checks each connection's peer with `getpeereid` and `LOCAL_PEERPID` and answers only env servers the app launched (`EnvServerHub.onLaunch`), so a shell command that read `bridge.token` is refused; the env server reads the token only from a private regular file, never through a symlink.
- **Fixed on the way**: a provider runtime that finished starting after its session closed (a restart racing a resumed turn) was adopted and leaked; it is now stopped.
