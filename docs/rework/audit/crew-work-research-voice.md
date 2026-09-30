# Audit: Agents ("Crew" candidate), Work, Research, Voice (web and server)

Phase 0, Juno Refoundation. Written 2026-09-30 against `rework/refoundation` @ `1feb392c`
(same tree as `main`). Read-only. Nothing was built or executed.

Evidence labels used below:

- **CONFIRMED**: seen directly in the code at the cited line. The behaviour follows from the code as written.
- **PLAUSIBLE**: inferred from code I read. I did not run it.
- **UNVERIFIED**: I could not check it: production state, first-party competitor pages, or visual judgement without a render.

Code wins over docs. Where the design docs disagree with the code, §3.5 lists the drift.

---

## 1. Map

### 1.1 Agents (the "Crew" candidate)

**Routes (web)**

| Route | File | What it does |
|---|---|---|
| `/agents` | `src/app/(app)/agents/page.tsx` → `src/components/agents/agents-home.tsx` | Page title, a sentence about the team, the "job composer", and a grid of live cards. With zero agents it shows the Chat-landing twin (`FirstAgent`, `agents-home.tsx:178-192`). |
| `/agents/new` | `src/app/(app)/agents/new/page.tsx` | The same home with the composer focused. `?form=1` renders the old four-step `AgentHire` form. |
| `/agents/[id]` | `src/app/(app)/agents/[id]/page.tsx` | Server redirect to `/chat/<threadId>?agent=profile|computer`. |
| `/chat/[id]` (agent thread) | `src/components/chat/chat-view.tsx` (2,697 lines) | Mounts `AgentThreadHeader` (:2295), `AgentThreadContext` (:2312), `AgentGreeting` (:2447), `AgentComputerPip` (:2402), `AgentPanel` in the split slot (:2678), `AgentComputerOverlay` (:2687). The page seeds a pending "starter" prompt from `pendingAgentStarter` (`src/app/(app)/chat/[id]/page.tsx:74`). |
| `/computer-view?c=…` | `src/app/computer-view/page.tsx` | One-time handoff page for native WKWebViews. It embeds a noVNC viewer. |
| Sidebar fold | `src/components/app/app-sidebar.tsx:1233, 2710` | One row per agent, each with a live `AgentFace` at 20 px. |

**Components** (`src/components/agents/`, 4,700 lines): `agents-home.tsx` (365), `agent-panel.tsx` (538, the profile sheet), `agent-thread-header.tsx` (291), `agent-computer.tsx` (356, overlay and PiP), `computer-viewer.tsx` (275, noVNC), `agent-face.tsx` (298) + `face-rig.ts` (235) + `agent-face.css` (254), `agent-presence.tsx` (83, halo and status line), `agent-face-studio.tsx` (273), `agent-hire.tsx` (370) + `agent-profile-fields.tsx` (433) (form fallback only), `team-status.tsx` (68, dev gallery only), `agents-transport.ts`, `use-agents.ts`, `agents.css` (167).

**Server**

- Store and domain: `src/lib/agents/store.ts` (1,743), `domain.ts` (541: states, limits, schemas), `prompt.ts` (chat-turn identity block), `reflect.ts` / `reflect-sweep.ts` / `reflection.ts` (ideas and goal check-ins), `new-agent.ts` / `starter.ts` / `creation.ts` (compose-to-create), `avatar.ts`, `templates.ts`, `hire-draft.ts` (619, dead, see §2).
- Chat tools:
  - `src/lib/chat/agent-config-tools.ts`: `create_agent`, `update_agent`, `agent_goal`, `agent_routine`, `agent_memory` (:52-56). Each has an Undo card, and an `ApprovalCard` when it escalates.
  - `src/lib/chat/handoff-tool.ts`: `hand_off_to_teammate`.
  - `src/lib/chat/task-tool.ts`: `start_task`.
- API: 21 routes under `src/app/api/agents/**` (CRUD, thread, tasks, goals, ideas, notes, routines, reflect, undo, duplicate, starter, hire-draft, computer + view/heartbeat/poster/files, activity).
- Models (`prisma/schema.prisma`):
  - `Agent` (:3809), `AgentGoal` (:3870), `AgentIdea` (:3897), `AgentNote` (:3922, encrypted), `AgentEvent` (:3945), `AgentComputer` (:3966).
  - Pointer columns: `Conversation.agentId` (:598) and `WorkSession.agentId` (:2456).
- Background: `juno-agent-reflector` (`scripts/agent-reflector.ts`, `deploy/ecosystem.config.js`). Agent notifications go through Work's delivery path (`src/lib/work/notify/deliver.ts:238-243` honours `Agent.notify`).

**Per-agent computer**

- `src/lib/computer/*` (3,285 lines): `docker.ts`, `store.ts` (1,414), `sweep.ts`, `live-view.ts`, `remote-browser.ts`, `fake.ts`.
- Infrastructure: `deploy/agent-computers/*` (Dockerfile, entrypoint, `cdp-gate.py`, firewall, `setup-vm.sh`).
- Viewer path: `relay/src/computer-view.ts` (a WS→VNC bridge in the **voice relay** process, reached through `/voice-relay/computer`, `src/lib/computer/live-view.ts:159`).
- Tools: 7 runner tools in `runner/agent-core/src/work/computer-tools.ts` (`computer_screenshot|click|type|key|scroll|shell|files`), wired in `scripts/work-runner.ts`.

**Data flow**

1. **Create.** Composer text goes to `POST /api/agents` with `{name, avatar, creationKey, starterMessage}`. That creates the `Agent` row and its thread `Conversation(agentId)`. The client then routes to `/chat/<thread>` (`agents-home.tsx:241-264`), where the starter is sent as the first message.
2. **Each chat turn.** `api/chat/route.ts` finds the thread's agent and applies its model, brief, style and notes (`agentChatContext`, `store.ts:1403`). It also gives the turn the config tools, `start_task` and `hand_off_to_teammate`.
3. **Starting work.** `start_task` creates a `WorkSession(agentId, conversationId=thread)` and a `WorkRun`. `juno-work` (`scripts/work-runner.ts`) claims the run by lease, injects the agent's identity, goals and notes (`work-runner.ts:920-962`), and optionally leases the agent's computer.
4. **Showing the run.** Events stream back over SSE to `useConversationWork` and are drawn by `WorkRunPanel` inside the transcript.
5. **Agent state.** Derived from the agent's **newest** session (`domain.ts:229-247`, `store.ts:129-140`). The client polls it every 10 s for the roster and every 5 s for the detail (`use-agents.ts:16-18`).

### 1.2 Work

- **Client:**
  - `src/components/chat/use-conversation-work.ts` (403). Discovery polls every 4 s (`:74`, `:179`), then the run is followed over SSE with a resume cursor.
  - `src/components/chat/work-run-panel.tsx` (443) switches between a LIVE body (current action, plan tally, meter, run words, question and approval cards) and a TERMINAL body (terminal detail, degradation, outcome digest, deliverable stage, "save as skill", meter).
  - Everything is built from `src/components/work/**`.
- **Server:**
  - `src/app/api/work/**`: 30 routes (sessions, runs control, approvals, hosts, schedules, skills, artifacts).
  - `src/lib/work/*`: dispatch, broker, approvals, budget, schedule, triggers, notifications, delegation.
  - Workers: `juno-work` (runner, `MAX_CONCURRENT_RUNS = 3`, `scripts/work-runner.ts:160`), `juno-work-scheduler`, `juno-work-triggers`.
- **Routes:** `/work/*` is now only redirects (`src/app/(app)/work/[[...segments]]/page.tsx`). Work lives in Chat. `/tasks` redirects to `/automations` (`src/app/(app)/automations/*`, the `WorkSchedule` list).

### 1.3 Research

- **Client:**
  - `src/components/chat/research-run-panel.tsx` (132) switches between a LIVE `ResearchConsole` and a TERMINAL `ResearchRecap` + `ReportDialog`.
  - `HistoricalResearchRunPanel` keeps older runs in the transcript.
  - Transport is **polling** (`use-research-run.ts:198-199`: 2.5 s while working, 8 s idle, stops when terminal).
- **Server:**
  - `src/app/api/research/**` (7 routes).
  - `src/lib/research/*`: `engine.ts` alone is 3,949 lines and 173 KB, plus claims, claim-analysis, corpus, crawler, and a multi-worker `research/agents/{lead,worker,scheduler}`.
  - `juno-research` worker (`scripts/research-worker.ts`) claims runs through `ResearchRun.workerLeaseOwner/Until`.
  - The model is separate: `ResearchRun` (:3591) has `budgetMicroUsd` and **no `agentId`**.
- **Route:** `/research` redirects to `/chat?research=1`.

### 1.4 Voice

- **Client:**
  - `src/hooks/use-realtime-voice.ts` (1,428) and `src/components/voice/realtime-voice.tsx` (461).
  - `src/components/voice/voice-composer-glow.tsx` wraps the third-party `voice-glow` `VoiceBeam`. The glow is the call state, per the owner's 2026-09-26 premium pass.
- **Server:** `src/app/api/voice/*` (context, memory, persona, relay-token, spend, stt, tts, transcript).
- **Relay:** `relay/` runs as the `juno-voice-relay` PM2 app, behind nginx `/voice-relay` (`deploy/nginx.conf.template:42`). The same process also bridges agent computer VNC.
- **In an agent thread:** the call speaks as the agent (`speakerName`, `chat-view.tsx:1926`). The face enters `listening`, driven by `--level` (`agent-thread-header.tsx:66-80`).

### 1.5 Ownership, claims, locking, budgets (what exists today)

| Concern | What exists | Where |
|---|---|---|
| Who a work item belongs to | `WorkSession.userId` (owner) and `WorkSession.agentId` (the agent it is delegated to, nullable). No assignee history, no co-owners. | `schema.prisma:2445-2523` |
| Executor claim/lock | `WorkRun.claimedBy/claimedAt/leaseExpiresAt`. This is a process-level lease so several executors can run. It is not an agent claim. | `schema.prisma:2577-2640` |
| Idempotency | `WorkRun @@unique([userId, idempotencyKey])`. Task, handoff and approval keys are derived from the user message id (`handoff-tool.ts:116`). | |
| Computer mutual exclusion | `AgentComputer.leaseRunId/leaseExpiresAt`: one run per computer. A busy computer falls back to the per-run browser. | `schema.prisma:3966-3990` |
| Research claim | `ResearchRun.workerLeaseOwner/Until`, a separate system | `schema.prisma:3591-3620` |
| One task per thread | Enforced **server-side** because the UI can only follow one: `start_task` refuses while any live session exists in the conversation (`task-tool.ts:594-611`), and so does handoff (`handoff-tool.ts:489-504`). | |
| Budgets | Per-run `maxCostMicroUsd/maxTokens/maxRuntimeMs` + `spendReservationRef` (`WorkRun`). The account's 5-hour and weekly windows are checked at dispatch and mid-run (`work-runner.ts:52`). Research has its own `budgetMicroUsd`. **There is no per-agent budget.** | |
| Delegation provenance | A handoff creates a new session in the teammate's thread. The origin exists only as **prose** in the goal (`composeHandoffGoal`, `handoff-tool.ts:216`). There is no `parentSessionId` or `fromAgentId` column, and the source thread never hears the result. | |
| Multi-agent rooms and claims | **None on main.** Server-side WIP exists on branch `agents/features` (see §4). | |

---

## 2. What is real, and what is placeholder, dead or gated

| Item | Verdict | Evidence |
|---|---|---|
| Agent CRUD, thread, profile, pause/pin/duplicate/retire | **Real** | Store and routes above. The web redesign is on main (`a4f8b992`, deployed 2026-09-30 per owner memory). |
| Compose-to-create ("describe a job") | **Real** | `agents-home.tsx:241-264`, `new-agent.ts`. Integration test `tests/agents-creation.integration.test.ts`. |
| Config-by-chat tools with Undo and approval cards | **Real** | `agent-config-tools.ts:52-56, 376-520` |
| Agent identity reaching runs | **Real, with a bug** | `work-runner.ts:920-962`. The bug: notes that were "forgotten" (soft-deleted) still reach runs (§3.3). |
| Handoff between agents | **Real, narrow** | One-way, approval every time, no chaining, results stay in the teammate's thread (`handoff-tool.ts:1-38`). |
| Reflection (ideas and check-ins) | **Real, gated** | `juno-agent-reflector`: at most one run per 6 h per agent (`domain.ts:190`), and it never starts work by itself. |
| Per-agent notification level | **Real** | `deliver.ts:238-243`. There is no UI control; it is set by chat (`update_agent` `notify`, `agent-config-tools.ts:160`). |
| **Per-agent Docker computer** | **Built, and almost certainly OFF in production (UNVERIFIED)** | See the four points below this table. |
| Computer UI when the provider is off | **Correctly hidden** | The profile offers "Give it one" only when `computerConfigured` (`agent-panel.tsx:128-130`). The header shows the Monitor button only when `agent.computer != null` (`agent-thread-header.tsx:90, 171`). |
| `/api/agents/hire-draft` + `src/lib/agents/hire-draft.ts` (619 lines) + `draftHireAgent` | **Dead** | `draftHireAgent` (`agents-transport.ts:150`) has no callers anywhere in `src` or `native`. The hire chat it served was deleted in the redesign. The route is also unclassified in parity (baseline `native:parity:check` failure, `docs/rework/PROGRESS.md`). |
| `/agents/new?form=1` → `agent-hire.tsx` + `agent-profile-fields.tsx` (~800 lines) | **Hidden fallback** | Nothing links to `?form=1` (only the page comment at `agents/new/page.tsx:6`). |
| `team-status.tsx` (uses the `bot-avatars` package) | **Dead in product** | Only imported by `src/app/dev/premium/gallery.tsx:14`. |
| `agents.css` lines 1-35 and 44-89 (`agent-workspace`, `agent-studio-start`, `agent-roster-*`, `agent-inspector`, `agent-status-dot`, …) | **Dead CSS** | 0 references in `src/**/*.ts(x)`. Only `.agent-thread-bar` and `.agent-card*` are used. |
| `src/lib/agent/computer.ts` (macOS OS automation), `src/lib/agent/swarm.ts` | **Dead in product** | Imported only by `scripts/eval-juno.ts` and tests. This is a third "computer" module beside `src/lib/computer/*` and `runner/agent-core/src/computer.ts`. |
| Work in chat (live and terminal panel, approvals, questions, steer, stop) | **Real** | `work-run-panel.tsx`, `use-conversation-work.ts` |
| Work history in a thread | **Limited by design** | "ONE TASK, THE NEWEST" (`use-conversation-work.ts:63-71`). Older task panels leave the transcript. |
| Automations (schedules and triggers) | **Real** | `/automations`, `juno-work-scheduler`, `juno-work-triggers`. Agent routines are ordinary `WorkSchedule`s whose session lives in the agent thread (`store.ts:1229`). |
| Research (durable, plan, clarify, steer, citations, report) | **Real** | Its own engine, worker, polling transport and model. Historical runs are kept in the transcript. |
| Voice (realtime providers, composer glow, speaks as the agent) | **Real** | Owner-approved design (premium pass, `08993d31`/`6171a846`). |
| Voice "bands" follow the audible voice | **Unmerged** | Branch `design/voice-motion` (§4) |

The per-agent computer, in detail:

1. **The server cannot fit it.** The production VM is `Standard_B2ats_v2` with about 887 MB RAM (owner memory note, 2026-09-30 outage). Code defaults are 2 GB RAM per container (`env.ts:185-189`) and a 4 GB host free-memory floor (`env.ts:216-221`). Both are above what the host has, so the preflight cannot pass.
2. **The one-time setup was never recorded as done.** `docs/design/agents-v2/PROGRESS.md` lists `setup-vm.sh` under "Not verified (needs you)".
3. **The owner has refused paid VM sizes.**
4. **The result.** Work degrades to the stateless per-run browser (OPERATIONS.md §2).

---

## 3. Problems

### 3.1 Product and UX coherence

1. **"One task per thread" is a UI limitation that became a domain rule.**
   - The chat view can follow only the newest session (`use-conversation-work.ts:63-71`).
   - So `start_task` and handoff refuse a second live task in the same conversation (`task-tool.ts:594-611`, `handoff-tool.ts:489-504`).
   - Agent routines put their sessions in the **same** thread (`store.ts:1229`). The thread's panel is chosen by `lastActivityAt desc` (`api/work/protocol.ts:857-863`). **PLAUSIBLE:** while a routine fires, the person cannot start a task in that agent's thread, and the routine's panel replaces the task panel they were watching.
   - This is incompatible with a crew, where several agents work concurrently in one room.
2. **Agent state is the state of the newest session only.** `deriveAgentState` (`domain.ts:229-247`) takes one `task`, from the per-agent `findFirst` at `store.ts:129-140`. An agent with a waiting task and a newer running routine shows "working". The needs-you count is separate (groupBy on `needsAttention`), so the face and the hand icon can disagree.
3. **Handoff is fire-and-forget.** The source agent's thread never learns the outcome, and provenance is text inside the goal (`handoff-tool.ts:216`). There is no delegation graph to render, audit or budget.
4. **Three durable run systems with three transports:**
   - `WorkRun`: SSE, runner lease, approvals, budgets.
   - `ResearchRun`: 2.5 s polling, its own lease and budget, no agent.
   - Code tasks: `juno-code-sweeper`, `/api/tasks`.
   - Agents can only own `WorkSession`s. A researcher agent cannot own a Research run.
5. **Two separate "where things run" lists.** Automations (`/automations`) do not show which agent a routine belongs to (no agent field in `work-schedule-row.tsx` or `lib/work/schedule.ts`). The profile's "When it works" list (`agent-panel.tsx:233-262`) is a second, partial view of the same rows.
6. **Several profile actions are broken or ambiguous:**
   - "Answer in chat" / "Show in chat" (`agent-panel.tsx:150-154`) look for `[data-work-run-panel], [data-work-task-card]`. **No element in `src` has either attribute** (grep). The button closes the profile and scrolls nowhere. CONFIRMED.
   - The web profile says "Change anything by telling {name}". But there is no way to see or set notification level or model outside chat, and `?form=1` is unlinked. That fits the direction, but the model and effort a person is paying for are invisible on the profile.
7. **Polling cost on a tiny host.** On a box that already swaps (owner memory: load around 13 after boot), one open agent thread runs:
   - roster poll every 10 s: N+5 queries, one `findFirst` per agent (`store.ts:129-140`, `use-agents.ts:16`);
   - detail poll every 5 s (`use-agents.ts:18`);
   - work discovery poll every 4 s, which runs in **every** chat, agent or not (`use-conversation-work.ts:74`);
   - a second SSE stream whenever the computer overlay is open (`agent-computer.tsx:53`, which contradicts the "exactly one cursor" rule in `use-conversation-work.ts:41-48`).

   The research worker comment (`scripts/research-worker.ts:18-30`) already records 6.3 M queries for two accounts.
8. **Naming collides everywhere.**
   - "Agent" means: the teammates here; the runner (`runner/agent-core`); runner subagents (`WorkEvent.agentId`, `schema.prisma:2710`); research workers (`src/lib/research/agents/*`); `src/lib/agent/*`; `/api/agent/[...path]`, which is the Code provider proxy; and Juno Code's agents.
   - "Computer" names three modules.
   - A product rename to **Crew** should come with an internal vocabulary split. External check on the name: "Crews" is the core noun of CrewAI, a widely used multi-agent framework (§6). That is a naming-collision and SEO risk, not a blocker.

### 3.2 Visual: AI-slop and imitation

Each item is judged against the owner's hard rules: no status pills, badges or pulsing status dots; no gradients or glow blobs; native materials only.

1. **Glow blobs everywhere a face appears.**
   - `AgentPresence` draws a radial-gradient tone halo behind every face (`agent-face.css:194-202`).
   - It adds a conic "sheen" that rotates while the agent thinks (`agent-face.css:203-230`).
   - It is used at 34-88 px on the home cards, thread bar, greeting and profile.
   - Native copies it: `JunoAgentPresence.swift:108-138` (RadialGradient and AngularGradient) and `NativeAgentsHome.swift:376`.
   - This is literally the "glow blob" the rules forbid. The comments justify it as "the way the voice glow does in Chat", but the voice glow is one owner-approved object, and this makes glow a system-wide motif.
2. **Gradient washes.**
   - Home cards: `radial-gradient(... var(--card-tone) / 0.10 ...)` (`agents.css:103`), a toned drop-shadow on hover (`agents.css:108-111`), and a bouncy lift.
   - Thread bar: a radial gradient with `backdrop-filter: blur(18px)` (`agents.css:36-43`), a faked glass layer on web.
3. **Decorative "working" indicators that behave like live badges:**
   - a light sweeping along the bottom edge of busy cards (`agents.css:139-163`);
   - a shimmering status sentence (`agent-face.css:236-245`, `background-clip: text` + infinite sweep);
   - Work's status line printing "Running" in mono beside an animated `ThinkingOrb` (`work-vocabulary.tsx:63, 236-241`; the WebGL orb from the `thinking-orbs` package, `phase-orb.tsx:41-48`).

   The 2026-09-26 directive removed the pill box but kept a live label plus an animated mark. That is the same signal in a different wrapper.
4. **Idle loops break the house motion law.**
   - `ICONS_AND_MOTION.md:221-222` says "Nothing idle loops".
   - But idle faces breathe forever (`agent-face.css:84`), paused faces breathe (`:85`), and the rig blinks and glances every face on the page on JS timers (`face-rig.ts`).
   - The sidebar alone carries one animated face per agent (`app-sidebar.tsx:2710`), which amounts to animated status markers down the navigation.
   - `AGENTS.md` §4.2 still says idle has "none". MOTION.md and the CSS contradict it.
5. **Borrowed identity.**
   - The face system is explicitly "Grok Bot's insight, taken whole" (`agent-face.tsx:6-8`), with "soft (rounded squares, Grok's lineage)" eyes (`AGENTS.md` §4.1).
   - xAI's own design write-up (2026-09-03) describes the Grok Bot avatar as "simple shapes and expressive eyes" that convey identity and state.
   - "Take control / Hand back" mirrors Grok's "take over" and Muse's "Take control".
   - On a side-by-side view this reads as a Grok Bot clone, not as Juno.
6. **Claude and ChatGPT tells.**
   - The status line blurs in and then sweeps a gradient through the text (`agent-face.css:236-253`). A third-party description of Claude's web "thinking" header (2026-09-11) names exactly that pair: a blur-in and a `background-clip: text` sweep.
   - `globals.css:1206` itself labels the app-wide `.shimmer-text` "ChatGPT-style thinking shimmer".
   - "X is thinking" bylines (`message-item.tsx:186`) under a serif display greeting with an italic name ("Hi, I'm *Mira*.", `agent-thread-header.tsx:281-283`; "Who should take care of it, *Liam*?", `agents-home.tsx:185-187`) read close to Claude.ai's serif greeting. The greeting similarity is my visual judgement (**UNVERIFIED**).
7. **Two effect libraries stay in the dependency tree for dead or ornamental uses:** `bot-avatars` (dead `team-status.tsx`) and `thinking-orbs`, which is used for a status mark (`agent-computer.tsx:205`, `phase-orb.tsx`).

### 3.3 Correctness and security

1. **"Forgotten" notes still reach autonomous runs.** CONFIRMED.
   - `work-runner.ts:931-936` reads `agentNote.findMany({ where: { userId, agentId } })` with **no `deletedAt: null`**.
   - Every other reader filters on it (`store.ts:329-330, 1604-1605`, `reflect.ts:96-97`).
   - The profile's "Forget this" is a soft delete (`store.ts:1658-1660`), so the agent's runs keep using what the person asked it to forget.
   - This is a privacy and trust bug. The fix is one line.
2. **Hand back answers whatever question is open.** CONFIRMED.
   - `agent-computer.tsx:106-107` posts "Done. I've finished on your computer; continue." to `work.questions[0]`, whatever that question actually asked.
   - It should answer only the takeover question.
3. **Computer handoff and view tokens are not single-use, contrary to the docs.** CONFIRMED.
   - `verifyHandoffCode` (`live-view.ts:89-138`) and the relay's `verifyComputerViewToken` (`relay/src/computer-view.ts:88-150`) check only the HMAC and a 60 s expiry. There is no nonce or consumed-store.
   - `/computer-view` renders the VNC password into the page (`computer-view/page.tsx:57`).
   - So a leaked `?c=` URL, including one with `mode: "control"`, is replayable for 60 s. `AGENTS.md` §7 promises "single-use".
   - Low exposure while computers are off.
4. **The CDP gate token is visible to the agent's shell.** CONFIRMED.
   - The token is passed with `-e JUNO_CDP_TOKEN` at `docker create` (`docker.ts:82-83`).
   - `docker exec` (`computer_shell`) inherits container env, so the model can read it.
   - The unmerged `agents/runtime` WIP fixes this: it provisions the token through stdin into tmpfs (`provisionCdpToken`, §4).
5. **The ops runbook would fail at the first wake.** PLAUSIBLE.
   - `setup-vm.sh:10` builds `juno-computer:1`.
   - Code defaults to `juno-agent-computer:1` (`env.ts:171-177`).
   - OPERATIONS.md §1 only sets `COMPUTER_PROVIDER`.
   - OPERATIONS.md also documents `COMPUTER_MAX_RUNNING_PER_USER` / `_TOTAL`, which the code never reads. It reads `AGENT_COMPUTER_MAX_AWAKE_USER` / `_HOST` (`env.ts:207-215`).
6. **One process carries two unrelated risks.** The relay (voice sessions plus VNC bridging) runs under a 300 MB PM2 cap (`ecosystem.config.js`, `juno-voice-relay`). A VNC-heavy session can restart voice calls. PLAUSIBLE.
7. **The docs repeat claims that are false in production.** `AGENTS.md` §8 lists per-agent computers as "Shipped" and PROGRESS says "Agents v2 is on main". Both are true of the code and not of production (§2). Product copy or marketing built on these docs would overclaim.

### 3.4 Parity (Web / Mac / iPhone / iPad)

| Capability | Web | Mac | iPhone | iPad |
|---|---|---|---|---|
| Agents home, compose-to-create, live faces | yes | yes (`NativeAgentsHome.swift`, commit `73406344`) | yes (drawer → `NativeAgentsScreen`) | same iOS app. A menu entry exists (`JunoMobileIPad.swift:86`). Layout **UNVERIFIED** |
| Thread presence bar, profile sheet | yes | yes | yes (profile, computer and menu in place) | as iPhone |
| Computer | full-screen overlay + PiP | sheet, **no PiP** (commit `73406344`: "Not ported") | handoff WKWebView (`/computer-view`) | as iPhone |
| Work run inline in chat | yes (`WorkRunPanel`) | yes (`ChatWorkRunCard.swift`, `NativeConversationWork`) | **no inline card found**; Work is a separate Tasks section (`JunoMobileWorkView.swift`, `JunoMobileSection.swift:12`) (PLAUSIBLE) | as iPhone |
| Research inline | yes | yes (`ResearchViews.swift`, `ResearchRecapCard.swift`) | progress view (`JunoMobileResearchProgress.swift`) | as iPhone |
| Voice glow | `voice-glow` | `JunoVoiceGlow.swift` | same | same |
| Voice bands (audible-synced) | no | no | no | no. All on unmerged `design/voice-motion` |
| Parity contract | `native:parity:check` **fails**: `/api/agents/[id]/starter` and `/api/agents/hire-draft` unclassified; `/api/agents/[id]/duplicate` marked planned though Swift calls it (`docs/rework/PROGRESS.md`) | | | |

Native uses gradients for the halo (`JunoAgentPresence.swift:108-138`). That is not a faked material, but it is the same glow blob as the web.

### 3.5 Doc drift (code wins)

- **Stale design reference.** `agents-home.tsx:29` and `agent-panel.tsx:40` cite `docs/design/agents-rework/DIRECTION.md`. That file is not on main; it exists only on the `agents/rework` branch (commit `8162c005`).
- **The panel.** `AGENTS.md` §3.1 and §5.2 describe a 3-tab `Now · Computer · Setup` panel and a job-board hire. The code has a single profile sheet plus a computer overlay (`agent-panel.tsx:39-48`) and a composer home.
- **Config tool names.** `AGENTS.md` names `manage_agent_goal` / `manage_agent_note` / `manage_agent_computer`. The real tools are `agent_goal`, `agent_routine`, `agent_memory`, with computer control inside `update_agent`.
- **Computer tools.** `AGENTS.md` lists 9 `computer_*` tools, including `computer_bash`. There are 7, including `computer_shell` and `computer_files`.
- **Computer states.** `AGENTS.md` §6 lists `creating|running|taking_over|sleeping`. The schema has `asleep|resting|waking|awake|error` (`schema.prisma:3972`).
- **Relay path.** The docs say `/ws/agents/[id]/computer`. The code uses `/voice-relay/computer`.
- **Idle motion.** `AGENTS.md` §4.2 and §4.2b (idle: no loop, specific timings) contradict `MOTION.md` and `agent-face.css`.
- **Unsourced competitor claims.** `docs/design/agents-v2/AUDIT.md` and `AGENTS.md` make claims without dates. Some of them check out against live sources (§6); others, such as "Grok: no cap that stops a run", are **UNVERIFIED**.

---

## 4. Unmerged branches and parallel work touching this area

| Branch (worktree) | vs main | Content | Fold in? |
|---|---|---|---|
| `agents/features` (`../juno-agents-features`), `2c773b5e` + status `0011ecbd` | +4 / −15 | **Agent rooms, server side:** `src/lib/agents/rooms.ts` (@Name, @all, relevance routing, cap of 3 turns per message, loop guard), `room-store.ts`, `create_room` / `ask_room_member` tools, chat-route wiring, and DB uniques `(userMessageId, agentId)` and `(userMessageId, position)`. Also tables for iMessage `ChannelLink`/`ChannelInbound` and payments `AgentSpendLimit`/`AgentPayment`. Status file `docs/design/agents-rework/FEATURES-STATUS.md`: typecheck only; no tests, no UI, no prisma validate or drift check. | **Harvest, don't merge.** `rooms.ts` routing, the cap and loop rules, and the two DB uniques are the best starting point for Crew rooms. Rebase them onto a unified run and claim model (§5). Leave channels and payments out of the refoundation. |
| `agents/runtime` (`../juno-agents-runtime`), **uncommitted** diff on `8d944f32` | +2 committed (same as `agents/rework`), 622+/242− uncommitted | Computer hardening: `ComputerError` scrubbing daemon text (`src/lib/computer/errors.ts`, untracked), CDP token through stdin/tmpfs, `listOwned` reconciliation, `fileInfo`, `isVncRunning`, `cwd` for exec, env rework. New event kinds `secret_filled`, `sign_in_saved`, `skill_learned`. | **Fold in the security parts** (CDP token, error scrubbing, reconciliation) if the computer survives the refoundation. They must be committed first; right now they exist only as a dirty worktree. |
| `agents/rework` (`../juno-agents`) `72b512b3` | +3 / −15 | The first redesign (face studio, gaze) and `DIRECTION.md`. | **Superseded** by `a4f8b992` on main. Salvage only `DIRECTION.md` if its text is still wanted, because code on main cites it. Then delete. |
| `agents/rework-native` (`../juno-agents-native`) | +3 / −15 | Native port of the superseded redesign | **Superseded** by `73406344`. Delete. |
| `wip/agents-v2-gemini-stopped` `44e4e67f` | +1 / −15 | Gemini's parked v2 UI edits | **Drop.** |
| `agents/redesign`, `agents/redesign-native`, `worktree-agent-ac27…` | 0 ahead | Already in main | Delete the branches and remove `.claude/worktrees/agent-ac27…` (the owner wants a single folder). |
| `design/voice-motion` (`../juno-voice-motion`) `338ef437` | +1 / −31 | Voice glow follows the **audible** voice in low/mid/high bands. Adds `JunoVoiceSpectrum.swift` and `JunoVoicePlaybackEnvelope`, plus tests. | **Fold in during Phase 7 (Voice),** after reconciling with `81bf66c5`, which touched the same files (`use-realtime-voice.ts`, `voice-composer-glow.tsx`, `JunoVoiceGlow.swift`). Expect conflicts. |
| `web/tools-thinking-research` `9f297a8b` | +15 / −172 | Handoff docs only (chat rework wave 1) | Read `docs/chat-rework/HANDOFF.md` for research-naming intent, then retire. |
| `origin/codex/chat-native-research`, `origin/codex/research-workspace-redesign`, `origin/claude/deep-research-ui-improvements-*` | 0 ahead | Already merged | Delete the remotes. |

---

## 5. Recommendations for the refoundation (ordered by leverage)

1. **One run substrate with an owner, a claim and a budget. This is the foundation for Crew.**
   - Introduce a `Job` (or extend `WorkSession`) that Work, Research and Code share. It needs:
     - `ownerAgentId` (the claimant);
     - `requestedByAgentId` / `parentJobId` (the delegation graph);
     - `roomId?` (conversation);
     - a per-agent `budgetMicroUsd` checked at dispatch and mid-run, beside the account windows;
     - an explicit claim state (`unclaimed → claimed(agent) → running → terminal`), unique per job.
   - Keep `WorkRun`'s executor lease as it is, because it is a different lock.
   - Make Research a job kind (the engine stays), so a researcher agent can own a research run.
   - Files: `prisma/schema.prisma` (WorkSession, WorkRun, ResearchRun, Agent), `src/lib/work/{dispatch,store,budget}.ts`, `src/lib/research/run.ts`, `src/lib/chat/{task-tool,handoff-tool}.ts`, `scripts/work-runner.ts`, `scripts/research-worker.ts`, and the native Work contract (`npm run work:contract:generate`).
2. **Drop "one live task per thread" and render every job in the transcript.**
   - Replace the discovery poll plus single stream with one per-conversation event stream that multiplexes all live jobs. Terminal jobs get a one-shot read, the same way `HistoricalResearchRunPanel` works.
   - Then remove the refusals at `task-tool.ts:594-611` and `handoff-tool.ts:489-504`.
   - Files: `use-conversation-work.ts`, `work-run-panel.tsx`, `chat-view.tsx`, `src/app/api/work/sessions/**`, and a new `/api/conversations/[id]/jobs/events`.
3. **Crew rooms on that substrate.**
   - Harvest `agents/features`: the `rooms.ts` routing, cap and loop rules; `AgentRoomTurn` with its two uniques; the `ask_room_member` tool.
   - Handoffs report back into the requesting room as a job card.
   - Agent state becomes an aggregate over the agent's claimed jobs, not "the newest session" (`domain.ts:229-247`, `store.ts:120-240`).
   - Files: `src/lib/agents/{rooms,room-store}.ts` (from the branch), `src/app/api/chat/route.ts`, `src/lib/chat/request.ts`, `contracts/chat/*`, `message-item.tsx` (speaker line).
4. **Fix the trust bugs now, independent of the redesign.**
   - Add `deletedAt: null` at `scripts/work-runner.ts:932-935`, with a regression test.
   - Make Hand back answer only the takeover question (`agent-computer.tsx:101-110`).
   - Make handoff and view tokens single-use with a consumed-jti store, and stop rendering the VNC password into the page (`live-view.ts`, `relay/src/computer-view.ts`, `computer-view/page.tsx`).
   - Fix or remove "Show in chat" (`agent-panel.tsx:150-154`).
5. **Take a decision on the per-agent computer.** It cannot run on the current VM (887 MB, owner refuses paid sizes). There are two options:
   - **(a)** Hide it completely: stop listing it in docs as shipped, keep the code behind `COMPUTER_PROVIDER`, and fold in the `agents/runtime` hardening only when a host exists.
   - **(b)** Move it to a paid ephemeral provider. That reverses the owner's self-host choice, so the owner decides.

   Either way, fix the image-name and env-name drift (`env.ts:171-221` vs `setup-vm.sh:10`, OPERATIONS.md) and move VNC bridging out of the voice relay process.
6. **Strip the slop and keep the identity.** For the Phase 6 visual pass:
   - Delete the halo and sheen (`agent-face.css:186-230`, `JunoAgentPresence.swift`), the card gradient, hover glow and edge sweep (`agents.css:91-163`), and the thread-bar gradient and blur (`agents.css:36-43`). On Mac and iOS, use system materials for the bar.
   - Kill idle loops, to obey `ICONS_AND_MOTION.md:221-222`: no idle or sleeping breathe. Blink and glance only on hover or focus, or only on the one face in focus. Show sidebar faces static (`live={false}`).
   - Replace the shimmer status lines (`agent-face.css:232-253`, `globals.css:1206-1230`) and the "Running" + orb mark (`work-vocabulary.tsx:236-241`) with plain words that change.
   - Redraw the face so it stops being a Grok Bot derivative. At minimum, drop "rounded-square eyes as the default"; ideally, build the mark from Juno's own spark and ring grammar.
   - Files: `agent-face.css`, `agent-presence.tsx`, `agents.css`, `agent-face.tsx`, `face-rig.ts`, `JunoAgentFace.swift`, `JunoAgentPresence.swift`, `NativeAgentsHome.swift`.
7. **Delete dead weight.**
   - `src/lib/agents/hire-draft.ts`, `src/app/api/agents/hire-draft/`, `draftHireAgent` (this also fixes one `native:parity:check` failure).
   - `team-status.tsx` and the `bot-avatars` dependency.
   - Dead `agents.css` (lines 1-35 and 44-89).
   - `?form=1` with `agent-hire.tsx` + `agent-profile-fields.tsx`, unless the owner wants the form as the accessible fallback.
   - `src/lib/agent/{computer,swarm}.ts` after checking the evals.
   - Then classify `/api/agents/[id]/starter` and `duplicate` in `contracts/parity/features.json`.
8. **Cut polling.**
   - Serve the roster glance from one query, not N+5 (`store.ts:129-140`). A window-function or `DISTINCT ON (agentId)` query does it.
   - Push agent state changes over the same stream as recommendation 2 instead of the 5 s and 10 s polls.
   - Stop the 4 s work discovery in chats that have no job.
   - Files: `use-agents.ts`, `store.ts`, `use-conversation-work.ts`.
9. **Parity.**
   - Put Work run cards inline in the iPhone and iPad conversation, matching web and Mac, and demote the Tasks section to a filter.
   - Port the computer PiP to Mac, or drop it on web.
   - Merge `design/voice-motion` in Phase 7.
   - Files: `native/iOS/JunoMobile/App/JunoMobileConversationsView.swift`, `JunoMobileWorkView.swift`, `native/Packages/JunoNativeKit/Sources/JunoWorkKit/NativeConversationWork.swift`, `DesktopAgentThread.swift`.
10. **Split the vocabulary before renaming.**
    - If the product becomes **Crew**, rename only the user-facing noun: sidebar label `app-sidebar.tsx:1233, 1363`, routes `/agents`→`/crew` with redirects, copy, native labels, i18n catalog.
    - Separately, rename the internals that collide: `src/lib/agent/*` → `src/lib/runtime/*`, `/api/agent/[...path]` → `/api/code/proxy`, and research `agents/` → `research/workers/`.
    - Note the CrewAI "crews" collision when choosing the name.
11. **Rewrite the docs to match the code.** Replace `docs/design/AGENTS.md` §3-§8 and `docs/design/agents-v2/*` with one current spec. Restore or remove the `DIRECTION.md` citation. Correct the tool and state names, and mark the computer as "built, off in production".

---

## 6. Competitor context (live-checked 2026-09-30)

**Grok Bot (xAI)**

- *Designing Grok Bot*, x.ai, **2026-09-03** (https://x.ai/news/designing-grok-bot):
  - three progressive access levels to the bot's computer: an activity icon, a side-panel preview, and full-screen takeover;
  - avatar built from "simple shapes and expressive eyes" that carries identity and state;
  - window, panel and computer-view controls removed;
  - limits of about 50 Bots per account and 6 per group chat.
- Grok Bot docs, *Chat and collaboration*, **undated** (https://docs.x.ai/grok-bot/chat-and-collaboration):
  - group chats of 2-6 Bots, with @mentions;
  - "Ask for a single owner at each stage";
  - async bot-to-bot handoffs are visible in the transcript;
  - a user message takes priority over background work.
  - This is the ownership model Crew needs and Juno lacks.
- Digital Applied, **2026-08-11** (https://www.digitalapplied.com/blog/grok-bot-ai-teammates-launch-cloud-computer-2026), secondary source:
  - bots "pass work, assign ownership";
  - one computer-use task per bot at a time;
  - approvals are Allow once, Deny or Always allow.

**Meta Muse**

- TechCrunch, **2026-09-08** (https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/):
  - a dedicated "Muse Secure VM" whose credentials are hidden from the agent;
  - approvals interface;
  - name, avatar and style customisation;
  - web, iOS, Android, WhatsApp and glasses;
  - $20 and $100 tiers.
- Wikipedia summary via search (https://en.wikipedia.org/wiki/Muse_(AI_agent)), secondary: a 2026-09-23 event added a Realtime Avatar, macOS app control, and an email address of the agent's own. **UNVERIFIED** against first-party pages.

**The "Crew" name**

- CrewAI (https://en.wikipedia.org/wiki/CrewAI, https://docs.crewai.com/en/introduction): "Crews" are CrewAI's teams of agents. Stable release 1.15.22 as of 2026-09-16, per a secondary search summary.

**Claude's thinking header**

- Third-party PR, **2026-09-11** (https://github.com/WHCreativeDesign/Jio/pull/17): describes Claude web's thinking status as a phrase that "blurs down into place" with a `background-clip: text` gradient sweep. Juno's agent status line does the same thing. **UNVERIFIED** against Anthropic's own UI.
