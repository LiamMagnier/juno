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
| Antigravity | on **legal hold**, hidden until PROVIDERS-LEGAL.md clears it | — |
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
- Swift JunoCode, JunoDesktop: see the run's result.

## Left to do

- **Signed-in, real-hardware checks**: a real Claude/Codex hand-off through the
  bundled env server in the running app; `/code/[id]` against a real account
  and Mac through the device link; computer use with Screen Recording and
  Accessibility granted.
- **Ship the bundle in release builds**: `release-macos.sh` should run
  `npm run env-server:bundle:mac` before archiving (not wired yet). The app
  still needs the user's own `node` on PATH.
- **Hub storage**: the device-link hub is in one backend process's memory
  (fine for the current single pm2 fork); a shared store is needed before
  running several backend processes.
- **Web**: install `@xterm/xterm` for the Terminal tab; apply a rejected hunk on
  the Mac from the live route; "resume at reset" needs a scheduling API; the
  Code sidebar is ready but the app shell still renders its own.
- **Mac**: Terminal/Files/Preview dock tabs for env-server threads;
  connected-agent approvals use NSAlert until they get a Studio card;
  Orchestrate selections on other providers (subscriptions, BYOK) inherit the
  parent's model in the Swift engine (no resolver yet); the overlay window has
  no snapshot test.
- **Release**: re-check every item in PROVIDERS-LEGAL.md; Codex ChatGPT token
  sharing stays disabled; Antigravity stays hidden. OpenRouter BYOK is not in
  the catalogue.
- Owner questions in DESIGN.md §11 (coral value, auto-deleting losing Best-of-N
  worktrees, Antigravity visibility).
