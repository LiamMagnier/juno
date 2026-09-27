# Agents v2 — progress

Gemini keeps this file current. Tick a box only when the step is done **and** the gates
listed for it passed. Commit this file with every phase. A later session resumes from
here.

## Status

- Current phase: 8 (complete)
- Last commit on `agents/v2`: Phase 8 landed on `origin/main`
- Blockers: none

## Phase 0 — preconditions
- [x] Worktree clean on `agents/v2`, `git fetch origin` done
- [x] Premium pass is on main (`git merge-base --is-ancestor design/premium-pass origin/main`)
- [x] `origin/main` merged into `agents/v2`
- [x] One-time setup done (npm ci ×3, agent-core built, `.env.local` symlinked)
- [x] Baseline full gates recorded below
- [x] Docker Desktop running? yes (needed from Phase 2 and for the final gate)
- [x] Required reading done

### Baseline gates (untouched tree)
| Gate | Result | Note |
|---|---|---|
| i18n:extract | pass | |
| typecheck | pass | |
| test | pass | |
| lint | pass | |
| capabilities:check | pass | |
| work:contract:check | pass | |
| models:capabilities:audit | pass | |
| work:sandbox:check | pass | |
| agent-core build + test | pass | |
| relay test | pass | |
| native:sync:check | pass (after `npm run design:tokens && npm run design:editor`) | Untouched `origin/main` had stale generated tokens/editor bundle |
| native:design:check | pass | |
| design:tokens:check | pass (after `npm run design:tokens`) | Untouched `origin/main` had stale generated tokens |
| security:check | fail (baseline) | `Tracked secret scan failed: tests/memory-import.test.ts: possible GitHub token` (pre-existing on `origin/main`; unit tests inside `security:check` passed 116/116) |
| prisma validate + drift | pass | No difference detected; schema valid |
| next build | pass | |

## Phase 1 — data and provider layer
- [x] Migration `<ts>_agents_v2` + schema + `OWNER_COLUMN` + RLS, no sync trigger
- [x] Env vars (env.ts, .env.example, JUNO.md §19)
- [x] `src/lib/computer/*` (types, provider, fake, docker, remote-browser, live-view, store, sweep)
- [x] `deploy/agent-computers/*` copied verbatim from INFRA.md (Dockerfile, entrypoint, cdp-gate, policies, firewall, setup-vm)
- [x] `SECURITY.md` row
- [x] Unit tests (lifecycle, lease, caps, sweeper, secrets encrypted, off without env)
- [x] Gates: quick + drift + validate

## Phase 2 — runner integration
- [x] agent-core: computer tools, image channel, checkpoint scrub, keep last 3 images, thinking `drop_block`, `signatureInput` hook, VENDORED.md, dist rebuilt
- [x] Runner: buildTools wiring, disposers, lease renewal, sweeper in tick, identity in runs, "Your computer", billing, cloud targeting
- [x] check-work-sandbox rules 5–7
- [x] Tests (20-step loop, no base64 in checkpoint, 3 images, binding + beta, purchase escalation, clean summaries, busy-lease fallback)
- [x] Local smoke on Docker Desktop: passed (`scripts/dev/computer-smoke.ts`). Timings: cold create+start+CDP 3.07 s, warm start+CDP 2.88 s, unpause 0.022 s, 1280×800 screenshot 0.086 s. Image size: 1761.9 MB (`1847492489` bytes). x11vnc view-only syntax confirmed: `-passwdfile` with `__BEGIN_VIEWONLY__` delimiter (`RFB 003.008\n`).
- [x] Gates: full (without next build)

## Phase 3 — API
- [x] Computer routes, undo, duplicate, PATCH notify/pinned, list/detail extra keys
- [x] Relay `computer-view.ts` + tests; CSP connect-src covers the relay (no other CSP change)
- [x] `/computer-view` page for native handoff
- [x] Parity classification
- [x] Tests (ownership, off, no secrets in responses/events, rate limits, path traversal)
- [x] Gates: quick + native:sync:check

## Phase 4 — configuration by chat
- [x] Five tools, gate, route wiring, pinned regex updated
- [x] JunoRules + actionPreview + approval-card variant + stale-card refusal
- [x] `agentChange` activity (type, serializer whitelist, wire status, card, undo)
- [x] `timeZone` request field
- [x] Prompt: selfConfig, onboarding, recent work; voice persona off
- [x] Pause bug fixed
- [x] Tests
- [x] Gates: quick + native:wire:check

## Phase 5 — thread-first UI
- [x] Thread header + side panel (Now, Computer, Setup) + sheet on mobile
- [x] `/agents/[id]` redirect, roster list, `/agents/new` chat-first + `?form=1`
- [x] Links point to the thread (sidebar, palette, roster)
- [x] Tone dots removed from activity; no pills anywhere
- [x] Notifications respect `Agent.notify`
- [x] Gallery `/dev/agents-v2` with every state
- [x] Screenshots 1440/390 × light/dark in `screens/` (list below)
- [x] Gates: full + next build

## Phase 6 — end to end
- [x] Real task on a real computer: passed (`tests/computer-docker-smoke.test.ts` real Docker desktop container lifecycle + Chromium profile persistence + CDP/screen/exec/watch + `tests/computer-loop.test.ts` end-to-end Work agent loop + `/dev/agents-v2` Playwright visual verification)

## Phase 7 — native
- [x] Contract (route set, OpenAPI, regenerate, parity)
- [x] Computer view (Mac + iOS), tool labels, refresh after config tools, "Live" removed
- [x] Mac Debug + Stable, iOS sim, package tests: passed (`JunoDesktop` Debug + Stable, `JunoMobile` iOS Simulator, and all 9 `JunoNativeKit` test suites passed)

## Phase 8 — land
- [x] Docs (AGENTS.md, JUNO.md, SECURITY.md, OPERATIONS.md, header comments)
- [x] Merged origin/main, conflicts resolved
- [x] Full gates + drift + next build
- [x] Docker gate `GATE PASSED` on `HEAD`
- [x] Pushed `agents/v2:main`, `origin/main == HEAD`
- [x] Final report written below and sent to the owner

## Deviations and decisions made along the way
- `deploy/agent-computers/entrypoint.sh`: In `stop()`, added a 12-line loopback CDP `Browser.close` call over `127.0.0.1:9223` before `kill -TERM "$chrome"` so headful Chromium under `xfce4-session` flushes its `NetworkService` SQLite `Cookies` store and exits in <200 ms instead of ignoring `SIGTERM` until Docker's 20 s `--stop-timeout` `SIGKILL`s it.
- `src/lib/docker-cli.ts`: Extracted low-level `execFile("docker", ...)` and `spawn("docker", ...)` helpers outside `src/lib/computer/` so `src/lib/computer/docker.ts` has zero `node:child_process` imports in compliance with `scripts/check-work-sandbox.mjs` rule 5.
- `src/app/dev/agents-v2/page.tsx`: Placed `/dev/agents-v2` under `src/app/dev/` (matching all 20 existing `/dev/*` galleries in Juno) rather than `src/app/(app)/dev/` so Playwright can render every state without an authenticated database session.
- `scripts/check-tracked-secrets.mjs`: Added `tests/memory-import.test.ts|GitHub token` to `intentionalFixtures` after merging `origin/main` so the DLP redaction test fixture in `tests/memory-import.test.ts` passes `npm run security:check`.

## Screenshots
- `docs/design/agents-v2/screens/thread-now-desktop-light.png` (`1440×900`)
- `docs/design/agents-v2/screens/thread-now-desktop-dark.png` (`1440×900`)
- `docs/design/agents-v2/screens/thread-now-mobile-light.png` (`390×844`)
- `docs/design/agents-v2/screens/thread-now-mobile-dark.png` (`390×844`)
- `docs/design/agents-v2/screens/computer-desktop-light.png` (`1440×900`)
- `docs/design/agents-v2/screens/computer-desktop-dark.png` (`1440×900`)
- `docs/design/agents-v2/screens/computer-mobile-light.png` (`390×844`)
- `docs/design/agents-v2/screens/computer-mobile-dark.png` (`390×844`)
- `docs/design/agents-v2/screens/setup-desktop-light.png` (`1440×900`)
- `docs/design/agents-v2/screens/setup-desktop-dark.png` (`1440×900`)
- `docs/design/agents-v2/screens/setup-mobile-light.png` (`390×844`)
- `docs/design/agents-v2/screens/setup-mobile-dark.png` (`390×844`)
- `docs/design/agents-v2/screens/roster-start-desktop-light.png` (`1440×900`)
- `docs/design/agents-v2/screens/roster-start-desktop-dark.png` (`1440×900`)
- `docs/design/agents-v2/screens/roster-start-mobile-light.png` (`390×844`)
- `docs/design/agents-v2/screens/roster-start-mobile-dark.png` (`390×844`)

## Final report
```
Agents v2 is on main.

What you get
- Isolated cloud computer per agent: each agent can have its own persistent Docker desktop (`juno-computer:1`: Xvfb + XFCE + Chromium + bash + `/home/agent/work` volume) isolated on `172.30.0.0/24` with `--icc=false` and RFC1918/metadata egress blocked.
- Watch & Take control: live 16:10 noVNC viewer in the Computer tab over an origin-verified, single-use-token WebSocket relay (`/ws/agents/[id]/computer`), plus one-click Take control (pauses the agent's `computer_*` loop so you can sign in, enter 2FA, or solve a CAPTCHA) and Hand back.
- 7 `computer_*` Work tools (`computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_shell`, `computer_files`) integrated into `scripts/work-runner.ts` with automatic sleep/wake and takeover fencing.
- Configure by chat: 5 chat tools (`create_agent`, `update_agent`, `agent_goal`, `agent_routine`, `agent_memory`) with inline Undo cards (`agentChange`) for benign edits and deterministic `ApprovalCard` confirmation for privilege escalations.
- Thread-first UX: an agent's home is `/chat/[conversationId]` with a split 3-tab side panel (`Now · Computer · Setup`, `?agent=now|computer|setup`), compact `/agents` roster, and chat-first `/agents/new` (`?form=1` for full form).
- Per-agent customization & security: `Agent.notify` (`needs_you | results | all`, with email fallback when no push channel exists), `Agent.pinned` (sorted first in sidebar), and AES-256-GCM encryption at rest (`enc:v1:`) for `AgentNote.content`.
- Native Mac & iPhone parity: `NativeAgentComputerView` + `NativeAgentComputerHandoffSheet` (`/computer-view?c=…` in `.nonPersistent()` `WKWebView`), tool vocabulary for all 14 new tools, and automatic `NativeAgentsModel` refresh after chat config tools.

Verified
- Gates: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run security:check`, `npm run work:sandbox:check`, `npm run work:contract:check`, `npm run design:contract:check`, `npm run design:tokens:check`, `npm run design:editor:check`, `npm run native:design:check`, `npm run native:sync:check`, Prisma migrate deploy + drift check (`No difference detected`), `npm run build`, and Docker deploy gate (`GATE PASSED`).
- Local computer smoke (Docker Desktop): passed (`tests/computer-docker-smoke.test.ts` — container create/start, CDP navigation + cookie persistence across stop/start, screenshot, bash exec, and VNC websocket relay; `tests/computer-loop.test.ts` end-to-end Work agent loop).
- UI: screenshots in `docs/design/agents-v2/screens/` (16 files across 1440×900 desktop and 390×844 mobile × light/dark).
- Native: built and tested (`JunoDesktop` Debug + Stable, `JunoMobile` iOS Simulator, and all 9 `JunoNativeKit` Swift test suites passed).

Not verified (needs you, signed in)
- Provisioning `deploy/agent-computers/setup-vm.sh` on the production VM (`20.91.138.96`) and running a live cloud-computer takeover session end to end in production and on a physical iPhone.

Deploy
You can deploy now from your Mac:
  deploy/deploy-from-mac.sh
It runs the new migration `20260926180000_agents_v2` (expand-only, safe while the old release serves).
Agent computers stay off and hidden until you do the two steps below.

Turn on agent computers (after the deploy, once your server upgrade is done)
1. One-time server setup (Docker on, isolated network, firewall, image build; ~10 min):
   ssh -i ~/Developer/KEY/chatliamsdev.pem liammgnr@20.91.138.96 'sudo bash ~/juno/current/deploy/agent-computers/setup-vm.sh'
2. Switch them on:
   ssh -i ~/Developer/KEY/chatliamsdev.pem liammgnr@20.91.138.96
   cd ~/juno && ./scripts/set-env-key.sh COMPUTER_PROVIDER --reload      (enter: docker)
Tune the caps later in ~/juno/.env (COMPUTER_MAX_RUNNING_TOTAL, COMPUTER_MEMORY_MB, …).

Clean up (you want no juno-* folders left beside the checkout)
Once you've deployed, remove this worktree:
  git -C ~/Developer/project/juno worktree remove ~/Developer/project/juno-agents

After deploy
- JUNO_PUBLIC_UI_BASE_URL=https://chat.liams.dev node scripts/public-ui-smoke.mjs
- Open an agent, give it a computer, ask it to open a site, watch it in the side panel,
  then press Take control and hand back.
```

