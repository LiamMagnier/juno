# Agents v2 — progress

Gemini keeps this file current. Tick a box only when the step is done **and** the gates
listed for it passed. Commit this file with every phase. A later session resumes from
here.

## Status

- Current phase: 5
- Last commit on `agents/v2`: Phase 4 configuration by chat
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
- [ ] Contract (route set, OpenAPI, regenerate, parity)
- [ ] Computer view (Mac + iOS), tool labels, refresh after config tools, "Live" removed
- [ ] Mac Debug + Stable, iOS sim, package tests: passed / deferred (reason)

## Phase 8 — land
- [ ] Docs (AGENTS.md, JUNO.md, SECURITY.md, OPERATIONS.md, header comments)
- [ ] Merged origin/main, conflicts resolved
- [ ] Full gates + drift + next build
- [ ] Docker gate `GATE PASSED` on `<sha>`
- [ ] Pushed `agents/v2:main`, `origin/main == <sha>`
- [ ] Final report written below and sent to the owner

## Deviations and decisions made along the way
- `deploy/agent-computers/entrypoint.sh`: In `stop()`, added a 12-line loopback CDP `Browser.close` call over `127.0.0.1:9223` before `kill -TERM "$chrome"` so headful Chromium under `xfce4-session` flushes its `NetworkService` SQLite `Cookies` store and exits in <200 ms instead of ignoring `SIGTERM` until Docker's 20 s `--stop-timeout` `SIGKILL`s it.
- `src/lib/docker-cli.ts`: Extracted low-level `execFile("docker", ...)` and `spawn("docker", ...)` helpers outside `src/lib/computer/` so `src/lib/computer/docker.ts` has zero `node:child_process` imports in compliance with `scripts/check-work-sandbox.mjs` rule 5.
- `src/app/dev/agents-v2/page.tsx`: Placed `/dev/agents-v2` under `src/app/dev/` (matching all 20 existing `/dev/*` galleries in Juno) rather than `src/app/(app)/dev/` so Playwright can render every state without an authenticated database session.

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
(paste the §6 report here)
