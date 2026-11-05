# Agents, tasks and proactivity: depth audit (Alevr vs ChatGPT and Claude)

Date: 31 October 2026. Repo `/home/user/juno` at `e532983ea` (Merge PR #122). Read-only audit: static code reading plus competitor research. No code was run against a live Alevr.

Scope: background tasks (Work), agents (Orbit), routines/automations, triggers, notifications, approvals, the cloud browser and agent computer, and how results come back into chat. The gap matrix (`../parity-gap.md` §G) marks almost all of this "present". This file looks at depth and quality instead.

Not re-specified here, because they are being built in parallel: share with specific people, per-chat memory off, AI-powered artifacts and storage, PDF/Docs/Slides export, locked chats, Drive/OneDrive attach, connectors in voice, tone sliders and the capability-registry fix, MCP Apps `ui://` widgets, plugins, and the UI/motion redesign.

---

## 0. Bottom line

Alevr's Work engine is unusually strong underneath. It has:
- digest-bound approvals;
- a risk ladder in which a form submit always asks;
- DNS-pinned headless browsing;
- graceful restart resume;
- durable goals;
- a completion judge;
- multi-agent teams;
- DST-correct schedules;
- routine health checks.

Neither competitor documents several of these at this level.

The gaps are where users feel the product, not in the engine:

1. **Results don't come back into the chat as messages.** A finished task is a card in an inline slot. It is not an assistant message, and the chat model cannot see what the task produced, so follow-ups are blind. Only the newest finished task is drawn, so older ones disappear on reload. A routine's earlier runs (yesterday's brief) can't be reached from its thread at all.
2. **Most finished tasks never send a notification.** A task a person starts by hand defaults to `on_attention`, so "done" is never pushed, and the push body is a generic sentence.
3. **Proactivity can't see your world.** Agent reflection reads only titles, goals and notes, never connectors, so its ideas are guesses. Alevr has no daily brief and no "tell me only if something changed" option. Duet does morning summaries and checks every few hours. Dots do read-only proactive research on connected apps.
4. **Long tasks restart instead of resuming.** A crash, a provider outage or a failure means a new attempt from the goal, plus a text brief.
5. **The cloud browser is safe but limited.** It has 7 actions, the first 60 elements in document order, and the first 20k characters of a page. It cannot scroll, choose from a dropdown, press keys or go back, and gives the user no visuals. A visual computer with takeover exists only for hired agents, and it is off in production.
6. **Approvals only reach you in the app.** Work approvals cannot be answered from the lock screen, a notification or a text.

Alevr has no model-based auto-review, so long unattended runs stop more often than Claude's Auto mode or the dots' auto-review would.

---

## 1. Competitor research (as of late October 2026)

### Source limitations
- `help.openai.com`, `siliconangle.com`, `vktr.com` and `betanews.com` **could not be fetched**: DNS is blocked by the session's network allow-list. Every ChatGPT claim below comes from **web-search excerpts** of official help pages, or from press, and is marked as such. To verify, `help.openai.com` must be allowed in the session's network settings.
- `support.claude.com` pages were **fetched directly**: [C1], [C2], [C9], [C10].
- Claude Duet and OpenAI dots are covered only by press, plus Anthropic's one-line release note for Duet. Treat their details as provisional.

### ChatGPT (OpenAI)
- **Scheduled tasks** [O13] (search excerpts):
  - The Scheduled page lists tasks; you can create them, review results and schedules, and pause, resume, edit or delete them.
  - **Event-triggered tasks** run in Work on Gmail, Slack or GitHub activity (paid plans; added 25 Aug 2026). The desktop app can't edit triggers. A third-party source reports caps of 30 runs per hour and 720 per day, with several events possibly grouped into one run [O13b].
  - Notifications: browser push needs a permission prompt; mobile push needs the task to be created in the mobile app; preferences live under Settings > Notifications.
  - **Actions that need approval may pause the task.**
- **Pulse retired** (announced around 17 to 18 Jun 2026; retirement within 14 days) and folded into scheduled tasks. OpenAI's suggested replacement is "ask ChatGPT to schedule a daily briefing based on your interests and past chats" [O-P1][O-P2][O-P3].
- **ChatGPT Work** (Jul 2026, replacing "ChatGPT agent") [O6] (press):
  - Multi-hour background tasks.
  - Since Aug 2026 it can continue a task on a site that needs the user to sign in.
  - It asks before sensitive actions.
- **Dots** (DevDay, 29 Sep 2026) [P1][P2][P3] (press):
  - Always-on agents, each with its own cloud computer and browser that the user can open at any time.
  - **Proactive research** when idle, using **read-only tools** only.
  - **Auto-review** of consequential actions, plus a monitor that can pause the agent.
  - Saved-password sign-in.
  - Texting your dot via iMessage/RCS is in beta [O1].
- **Atlas** agent mode had pause, take control and logged-out mode [O19]. Atlas is reported deprecated, with the standalone browser stopping on 9 Aug 2026; browser agent features move into ChatGPT and Codex [O19b] (secondary source).

### Claude (Anthropic)
- **Cowork in every conversation** (16 Sep 2026) [C1][C2]:
  - Tasks "keep running in the cloud even if you close your laptop or leave the page".
  - **Several tasks at once.**
  - Tasks started on desktop appear in Claude Mobile, where you can **check progress, answer Claude's questions and redirect** [C2]. The persistent agent thread on mobile shipped 17 Mar 2026 [C1].
  - A permission setting per conversation: **Auto** (the default on Pro, Max, Ultra and Team; "automated safety checks run before actions") or **Manual** (asks before each action). You can stop or redirect mid-task, and it asks before permanently deleting files [C2].
  - "The result is waiting in the conversation" when done; files appear alongside the conversation [C2].
  - The browser is either the built-in Claude Desktop browser or Claude in Chrome, and can open, read, click and fill forms [C2].
- **Scheduled tasks** [C10] (fetched):
  - Created by describing the task in any conversation and then reviewing the proposed name, schedule and instructions; or from the Scheduled page, either "Create with Claude" or manually.
  - Hourly, daily, weekly, weekdays or manual.
  - **Each run is its own Cowork session.** The Scheduled page shows **upcoming and past runs**.
  - Tasks run remotely while the computer is asleep. Tasks that need local files run locally only.
- **Computer use** (beta) [C9] (fetched):
  - Per-app permission prompts and a blocklist. Investment and crypto apps are off by default.
  - Works in background windows by default on macOS 15 or later.
  - Preference order: connectors, then the browser, then the screen.
  - Requires the desktop app to be open.
- **Claude Duet** (research preview, 21 Oct 2026, US Pro/Max waitlist) [C1][P4][P5][P6] (press):
  - A proactive agent: a **morning summary** from connected tools, **checks every few hours**, configurable cadence and notifications.
  - Asks before it sends, pays, signs or deletes, and "shows you the exact action and waits for approval".
  - Background check-ins count against plan usage.

### Orbit-style agents
"Orbit" is Alevr's own agents product (`docs/design/AGENTS.md`). The comparable products are dots and Duet: a persistent teammate with its own computer, memory, goals, routines, a vault and a texting channel. Alevr already matches these on breadth (`../parity-gap.md` §G). The table below compares depth.

---

## 2. Capability table

Gap values: **missing**, **weaker**, **equal**, **ahead**. "Alevr today" cites file:line under `/home/user/juno`.

| # | Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|---|
| 1 | Start a background task from any chat | Work from chat [O6] | Cowork in every conversation [C2] | Model-decided `start_task` (`src/lib/chat/system-prompt.ts:226-247`, `src/lib/chat/task-tool.ts:640-760`); goal = user's own words + model brief (`composeTaskGoal`, task-tool.ts:288, called at :728) | equal |
| 2 | Keeps running after you leave / device off | yes (Work, press) | yes [C2] | Cloud runner with leases, heartbeat and checkpoints (`src/lib/work/store.ts:1040-1150`); queued runs expire only on a proven executor outage (`store.ts:1700-1790`) | equal |
| 3 | Survives worker restart | not documented | not documented | Pauses at the step boundary, checkpoints, parks, and resumes on the next runner (`src/lib/work/restart-resume-rules.ts:5-31`) | ahead |
| 4 | Recovers from a crash or failure mid-task | not documented | not documented | Expired lease → `interrupted`, "Deliberately does NOT re-queue" (`store.ts:1563-1582`). "Continue" is "a new attempt with a brief, not a restore" (`src/lib/work/continuation.ts:16-23`), although a checkpoint is saved on every message change (`scripts/work-runner.ts:4230-4255, 4478`) | weaker (the progress is thrown away) |
| 5 | Provider outage or rate limit mid-run | n/d | n/d | 4 in-step retries within 90 s (`runner/agent-core/src/loop.ts:258-276`). Lab failover only at a run boundary and only when a person presses Retry (`src/lib/work/models.ts:307-322`, `src/lib/work/dispatch.ts:886-917`). Waits and compaction are **logged only**, so the user sees a hung task (`work-runner.ts:4479-4505`) | weaker |
| 6 | Long-run ceilings | multi-hour (press) | no stated cap [C2] | 1,200-step backstop, no runtime ceiling; account windows stop it (`src/lib/work/budget.ts:109`, `work-runner.ts:4313-4324`); layered compaction (`loop.ts:429-470`) | equal/ahead |
| 7 | "Done" is checked | n/d | n/d | Structural validation plus a goal judge that fails open (`runner/agent-core/src/work/judge.ts:1-60`, wired at `work-runner.ts:4360-4377`) | ahead |
| 8 | Live progress in the chat | yes | yes, and on mobile [C2] | `WorkRunPanel`: step x of y, current action, the run's own words, Stop/Pause (`src/components/chat/work-run-panel.tsx:84-110`); elapsed/cost/tokens meter (`src/components/work/work-detail-panels.tsx:529-539`). Headless-browser steps have no visuals (only computer runs get a filmstrip, `src/components/work/computer-steps.tsx:12-26`) | equal (weaker for browser tasks) |
| 9 | Several tasks at once | n/d | yes [C2] | 3 live runs per account, then a hard 429 "Let one finish first" (`dispatch.ts:674, 1278-1285, 1528-1537`); 4 per conversation (`src/lib/work/conversation-tasks.ts:27`) | weaker |
| 10 | Steer or redirect mid-task | n/d | yes [C2] | Steering is read before the next step; nothing in flight is aborted (`docs/JUNO.md` §9b.3) | equal |
| 11 | Results land back in the chat | n/d | "the result is waiting in the conversation" [C2] | Card in `MessageList`'s inline slot; `WorkRun` has **no message pointer** (`prisma/schema.prisma:3308-3376`). The work runner writes no message (grep: no `message.create` in `scripts/work-runner.ts` or `src/lib/work/*` except the Code dispatch). Only "all live + the newest finished" are drawn (`src/app/api/conversations/[id]/tasks/route.ts:15-60`); "Older finished tasks still leave the transcript on reload" (`src/components/chat/use-conversation-work.ts:70-78`). Research, by contrast, writes a durable message (`src/lib/research/completion.ts:1-8`) | **weaker** |
| 12 | Follow-up questions about a task's result | yes (same chat) | yes (same chat) | The chat turn never reads Work outcomes (no WorkSession reads in `src/lib/chat/turn/history.ts`, `context-resolve.ts` or `turn-start-facts.ts`); the model only saw its own `start_task` "started" result | **missing** |
| 13 | Task gets the conversation's context | n/d | yes (runs in the conversation) | "The task cannot read this conversation, so the goal must stand alone" (`system-prompt.ts:241`); attachments come from this message only | weaker |
| 14 | Scheduled tasks from chat | yes [O13] | describe → review → confirm [C10] | `propose_routine` card: Schedule / Edit / Not now (`src/lib/work/routine-proposal.ts:1-22`); phrase parser; cron; DST-correct (`src/lib/work/schedule.ts:1-23`); Run now (`src/lib/work/fire-now.ts`); missed-run and host-offline policies; routine health (`src/lib/work/schedule-health.ts`) | equal/ahead |
| 15 | Reading past routine runs | review results on Scheduled page [O13] | past runs; each run its own session [C10] | One session per routine, re-run each fire (`schedule.ts:2333-2345`). The chat draws only the current run, and `?run=` is dropped because the page "cannot keep" it (`src/lib/work-url-migration.ts:52-57`). Run rows link to `/work/<sessionId>`, which lands on the newest run (`src/app/(app)/automations/[id]/page.tsx:134`) | **weaker** |
| 16 | Event-triggered automations | Gmail/Slack/GitHub [O13] | partial | Email filter, calendar window, topic monitor (polled every 6 h), first-party connector outbox (Gmail, Calendar, Drive, Outlook, M365, Slack), API fire URL; 2-min poll (`src/lib/work/triggers.ts:56-64, 305-329, 1208-1219`; `src/lib/first-party-connectors/providers.ts:3`). No GitHub event source for Work; folder trigger refused | equal |
| 17 | Proactive brief / proactive agent | Pulse → daily-briefing tasks [O-P1]; dots do read-only proactive research [P1] | Duet: morning summary + checks every few hours [P4][P5] | Agent reflection every 6 h (`src/lib/agents/domain.ts:321`) reads **only goals, notes and task titles/statuses, never connectors or deliverables** (`src/lib/agents/reflection.ts:9-24`); output is up to 3 idea cards with Start (`reflection.ts:27`); the sweep runs only for agents whose person chatted in the last 14 days (`src/lib/agents/reflect-sweep.ts:30-56`). No built-in brief | **weaker** |
| 18 | "Only tell me if there's news" | conditional briefings (search excerpts) | Duet decides "what needs you" [P4] | Notify policies are `none / on_finish / on_attention / all` only (`src/lib/work/notifications.ts:33-34`); a run cannot end quietly as "nothing new" | **missing** |
| 19 | Notified when a task finishes | browser + mobile push [O13] | mobile monitoring [C2] | A hand-started task defaults to `on_attention` and **does not notify on finish** (`notifications.ts:51-62, 180-185`); there is no presence signal, so "attended" means "a person started it" (`notifications.ts:64-73`). The completed body is generic: "finished the task and the result is ready" (`notifications.ts:421-426`). Manually created routines also default to `on_attention` (`src/components/work/work-schedule-editor.tsx:334`) | **weaker** |
| 20 | Approval UX in the app | pause for approval [O13] | Auto/Manual per conversation [C2]; Duet shows the exact action [P5] | Verb buttons, artifact preview, Amend-as-refusal, digest-bound and policy-bound decisions, standing approvals that irreversible actions can never get (`src/components/work/approvals/approval-card.tsx:24-66`, `src/lib/work/digests.ts:1-31`, `docs/JUNO.md` §9b.3) | ahead |
| 21 | Approve from lock screen, notification or text | n/d | answer questions on mobile [C2] | Actionable push exists **only for Code** (`native/iOS/JunoMobile/App/JunoMobileLinkApprovalResponder.swift:27-31, 70-81`). Work "needs you" pushes use `JUNO_NEEDS_YOU` (`src/lib/apns.ts:444-446, 487`), which **no native target registers** (grep across `native/`). The web service worker has no notification actions (`public/sw.js:106-170`). iMessage gets "a link to the card, never what, and never a way to answer" (`src/lib/notifications.ts:263-268`) | weaker |
| 22 | Fewer interruptions without less safety | dots auto-review [P1] | Auto mode "automated safety checks" [C2] | Static risk ladder × mode (`src/lib/work/domain.ts:639-649, 938-945`); no model reviewer (grep: no auto-review); the injection scanner is "a detector, not a boundary" (`runner/agent-core/src/work/injection.ts:1-27`) | weaker |
| 23 | Cloud browser capability | visual agent browser, sign-in continue (press) | built-in browser + Chrome; click/fill [C2] | Headless DOM browser with actions `open, read, click, type, submit, credentials, fill_credential` (`runner/agent-core/src/work/tools.ts:701`); an unknown action silently becomes `read` (`tools.ts:704-713`); first 20k chars only (`tools.ts:589, 724-728`); 60 interactive elements in document order (`src/lib/work/browser-page.ts:5, 13-100`); no scroll/select/press/back/wait/upload/download, no screenshot. Safety is strong: pinned DNS, WebSockets closed, submit always asks (`docs/JUNO.md` §9b) | weaker on capability, ahead on safety |
| 24 | Visual computer + takeover for any task | Work/dots computers (press) | computer use [C9] | Agent-only: `prepareRunComputer` returns `none` without `agentId` (`src/lib/computer/store.ts:2462-2475`). Watch, takeover and hand-back exist (`docs/JUNO.md` §9c), but "the agent computer … off in production (no host)" (`docs/design/AGENTS.md:276-285`) | weaker (in practice missing) |
| 25 | Use the user's own computer | Work desktop (press) | computer use beta [C9] | Mac host + local signed-in browser (`WorkHost`; `native/Packages/JunoScreenControl/...`); "Mac execution is unverified on hardware" (`AGENTS.md:281-282`) | equal (unverified) |
| 26 | Lock-screen live progress | n/d | mobile thread [C1] | Live Activity per run is **updated locally only**, so it goes stale once the app is suspended (`native/iOS/JunoMobile/App/JunoMobileLiveActivities.swift:30-55`, `JunoMobileRuns.swift:233` `pushType: nil`), though APNs already supports `liveactivity` (`src/lib/apns.ts:37`) | weaker |
| 27 | Text the agent a job | dots via iMessage (beta) [O1] | no | iMessage replies are a tool-less utility walk: "nothing in it can reach an approval, a connector or a task" (`src/lib/channels/reply.ts:1-12`) | weaker |
| 28 | Multi-agent teams / delegation | n/d (consumer) | n/d (consumer) | Lead + specialists + critic team; `delegate` child agents, ≤6 per run (`runner/agent-core/src/work/delegate.ts:58`) | ahead |
| 29 | Durable goals with success criteria | no | no | `src/lib/agents/goal-runner.ts:1-20`, criteria check (`work-runner.ts:4372-4377`) | ahead |
| 30 | Credential vault, payments, teach-by-demo | dots saved passwords (press) | Duet asks before paying (press) | Present (`../parity-gap.md` §G); agent-scoped | equal/ahead |

---

## 3. Ranked improvements

The order follows what users will feel, discounted by size and dependencies. R1 and R2 are foundations for R3 and R7.

### R1. Task results land in the chat as real messages, and the chat can read them
- **User-visible outcome.**
  - When a task or routine run finishes, an assistant message appears in the conversation. It has a 2 to 5 sentence result, its deliverables as artifacts, a "what it did" line, and Continue / Run again.
  - The message stays after reload. It is searchable and exported with the chat, and it renders on Mac and iPhone through the existing message sync.
  - "Shorten the report you just made" and "send that to Sam" work because the model can see the result.
  - A routine's thread becomes a dated history of runs ("Mon 8:00 brief", "Tue 8:00 brief"), not one card that overwrites itself.
- **Competitor evidence.** Claude: "the result is waiting in the conversation" [C2]; each scheduled run is its own session with past runs listed [C10]. ChatGPT: review results on the Scheduled page [O13].
- **Current code refs.**
  - `WorkRun` has no message pointer (`prisma/schema.prisma:3308-3376`).
  - Only the newest finished task is drawn (`src/app/api/conversations/[id]/tasks/route.ts:15-60`; `use-conversation-work.ts:70-78`).
  - `?run=` is dropped (`work-url-migration.ts:52-57`).
  - The chat context has no Work outcome (`src/lib/chat/turn/history.ts`, `context-resolve.ts`).
  - The pattern to copy is research's completion message (`src/lib/research/completion.ts:1-140`, `completion-core.ts:1-15`).
- **Implementation sketch.**
  - Data model (expand-only, per `docs/JUNO.md` §20.2b): add `WorkRun.assistantMessageId String? @unique` and `Message.workRunId String?` with an index.
  - Add a pure `src/lib/work/completion-core.ts` that turns `(run, session, finalText, artifacts, plan tally, terminalReason)` into one assistant message:
    - neutralise `<juno:` tags (as research does);
    - write the deliverables as artifacts with identifier `work-deliverable-{artifactId}`;
    - give the message `activity` a `kind: "work_result"` row carrying `runId`, `sessionId` and `attempt`.
  - Bind it in `src/lib/work/completion.ts` inside the same transaction as `commitRunEnding` (`store.ts:1418`), or right after it with a CAS on `assistantMessageId IS NULL`, so a lease sweeper and the executor can't both write.
  - Terminal states other than `completed` write a short "stopped at step N because …" message; `superseded` writes nothing.
  - Chat context: in the turn's history assembly, a `work_result` message is already an ASSISTANT message, so it flows in. Add a bounded `[Task result]` prefix, and keep deliverable bodies behind the artifact reference, not inlined.
  - Context in: pass a bounded digest of the **user-authored** turns of the conversation (not tool outputs) into the task's opening context, inside the untrusted envelope. The model then no longer has to restate everything, and injection risk stays unchanged. This changes `system-prompt.ts:241` and `task-tool.ts:728`.
  - UI:
    - `WorkRunPanel` stays for **live** runs only; the terminal state is the message.
    - The conversation tasks route returns live tasks only.
    - Older finished cards are no longer needed, because the messages carry history.
    - Add `?run=` support to `/work/<sessionId>` so it resolves to the message anchor.
  - Native: messages sync through `/api/v1`; add the `work_result` activity kind to the generated contract (`contracts/work/juno-work-v1.json`).
- **Acceptance tests.**
  - (a) A completed run writes exactly one message, and replaying the terminal write writes none: a unit test through a fake transaction, as in `tests/research-completion.test.ts`.
  - (b) After a reload, a conversation with two finished tasks shows both results (e2e).
  - (c) A follow-up "what was the third finding?" is answered from the result (integration test using a scripted model, `runner/agent-core/src/work/scripted-model.ts`).
  - (d) A routine fired 3 times shows 3 dated messages in its thread.
  - (e) A `restricted`-sensitivity run writes the message but no push quote.
  - (f) Deleting the conversation before completion writes nothing and still finishes the run.
- **Size** M. **Impact** H.
- **Risks.**
  - Double-writes from racing finishers: handled with a CAS on the pointer.
  - Large final texts bloating the history: bound the summary and keep the body in an artifact.
  - Older native builds that only know the card: they keep the card path, since the sessions route is unchanged.

### R2. Never miss a finished task: presence-aware "done" notifications with the result in them
- **User-visible outcome.**
  - Start a 15-minute task and switch tabs or lock the phone: you get "Competitor pricing sheet is done: Acme is 12% cheaper on the Pro tier; 3 vendors don't publish prices."
  - If you're watching the card, nothing pings.
  - The card has a "Tell me when it's done" toggle, and routines from the editor default to telling you.
- **Competitor evidence.** ChatGPT tasks send browser and mobile push and have notification settings [O13]. Claude lets you check progress from mobile [C2].
- **Current code refs.**
  - `runNotifyPolicy` defaults hand-started runs to `on_attention` (`src/lib/work/notifications.ts:51-62`).
  - `on_attention` never notifies on finish (`notifications.ts:180-185`).
  - The code admits there is "no presence signal" (`notifications.ts:64-73`).
  - The completed body is generic (`notifications.ts:421-426`).
  - The editor default is `on_attention` (`work-schedule-editor.tsx:334`).
  - Quoting is gated by sensitivity (`src/lib/work/notify/deliver.ts:258-262, 624-631`).
- **Implementation sketch.**
  - Presence: the SSE route (`src/app/api/work/sessions/[id]/events/route.ts`) already polls per open stream. Add `WorkSession.viewerSeenAt`, throttled to one write per 20 s while a stream is open and the client reports `visibilityState=visible`, sent as a `?visible=1` query parameter refreshed on `visibilitychange`.
  - In `deliver.ts`, an attended run's finish notifies when `now − viewerSeenAt > 30 s`.
  - New policy value `on_finish_if_away` becomes the default for hand-started runs (`WORK_NOTIFY_POLICIES`). This is a contract addition, so mirror it in `contracts/work/juno-work-v1.json`.
  - Outcome-bearing copy: extend `describeNotification` with a `resultLine` drawn from R1's summary, used only when `mayIncludeRunDetail` allows it (the restricted fallback stays generic). The email (`src/lib/work/notify/email.ts`) gets the full summary plus deliverable links.
  - Change the editor default to `on_finish` for schedules (keep `on_attention` for high-frequency triggers, those under 1 hour).
- **Acceptance tests.**
  - The decision-table unit tests in `tests/` cover: watching → no push; away > 30 s → push; restricted → generic body; superseded → none.
  - e2e: start a task, hide the tab, a web push arrives with the first result line.
  - iOS: the push body carries the result line, and opening it lands on R1's message.
- **Size** S-M. **Impact** H.
- **Risks.** Over-notification on chatty routines; mitigated by keeping `on_attention` for sub-hourly triggers and by R7. Privacy of lock-screen text; mitigated by keeping the existing sensitivity gate and adding a per-account "hide result text on lock screen" switch.

### R3. A proactive daily brief that reads your inbox, calendar and Slack (Duet/dots-class)
- **User-visible outcome.**
  - One tap, "Brief me every morning", during onboarding, on home or from any agent.
  - At 7:30 local time, a message in a "Daily brief" thread plus a push with the headline. It has these sections:
    - **Needs you today**: replies owed, approvals, meetings without prep;
    - **On your calendar**;
    - **Can wait**;
    - **Done for you overnight**: routines that ran;
    - **Suggested next**: up to 3 cards with Start, using the existing idea → Work dispatch.
  - Optional checks every few hours that stay silent unless something needs you (R7).
  - Dismissing a suggestion teaches the brief.
- **Competitor evidence.** Duet does a morning summary, checks every few hours and decides "what needs you" [P4][P5]. Dots do proactive research with read-only tools [P1][P2]. OpenAI tells former Pulse users to schedule a daily briefing based on interests and past chats [O-P1][O-P2].
- **Current code refs.**
  - Reflection reads only author-written text (`src/lib/agents/reflection.ts:9-24`), every 6 h (`src/lib/agents/domain.ts:321`), and only for agents of users active in the last 14 days (`src/lib/agents/reflect-sweep.ts:30-56`).
  - Idea cards and Start already go through dispatch with a cost preflight (`docs/JUNO.md` §9c).
  - Dismissed ideas are already tracked (`reflection.ts:69, 146`).
  - Unattended policies (`src/lib/work/domain.ts:938-945`) and the risk ladder (`domain.ts:639-649`).
  - First-party read connectors (`src/lib/first-party-connectors/providers.ts:3-21`).
  - The agent template "Chief of staff" (`src/lib/agents/templates.ts:35-49`).
- **Implementation sketch.**
  - New unattended policy `read_only`: the gate refuses every action above `safe`, structurally, so a hostile email cannot make the brief send anything. This mirrors dots' read-only proactive mode. Add it to `WORK_UNATTENDED_POLICIES` and enforce it in the runtime's approval gate (`runner/agent-core/src/work/session.ts` approval path).
  - Brief routine kind: `WorkSchedule.runKind = "brief"` (extends `WORK_SCHEDULE_RUN_KINDS` in `src/lib/work/code-routine.ts`). Its fixed skill prompt has a JSON-schema'd output (sections + items with `source`, `why`, `suggestedTask`). Connectors are the account's first-party mail, calendar, Slack and Drive, intersected with the user's choice. Memory context comes via `src/lib/work/memory-context.ts`.
  - Rendering: R1's completion writes the brief as a structured message (a `brief` activity row rendered as sections with Start buttons). Each `suggestedTask` becomes an `AgentIdea`-shaped card. The idea table can be reused with `agentId` nullable, or a sibling `BriefSuggestion` model can be added.
  - Learning: dismissals and Starts become feedback passed into the next brief's prompt ("you dismissed: …"), as reflection already does.
  - Cost control: run on the account's background provider and a mid-tier model; cap tokens; skip a day with no new mail or events (a cheap pre-check through the connector sync cursor in `src/lib/first-party-connectors/sync-store.ts`).
  - Safety: connector outputs stay inside the untrusted envelope. The brief can create suggestions, never tasks.
- **Acceptance tests.**
  - (a) A brief run that tries a `send` is refused by `read_only` (runtime unit test).
  - (b) A seeded inbox fixture with 3 "needs reply" threads yields a brief listing them (scripted model plus fake connector).
  - (c) A day with no new items produces a quiet run with no push (with R7).
  - (d) Start on a suggestion dispatches one task with preflight.
  - (e) Dismissed items don't reappear for 7 days.
  - (f) DST week: the brief still fires at 7:30 local (reuses `schedule.ts` tests).
- **Size** L. **Impact** H.
- **Risks.**
  - Cost of daily runs for inactive users: skip after 14 days of inactivity, as the reflect sweep does.
  - Hallucinated urgency: require each item to cite a source message or event id that the renderer links.
  - Prompt injection from mail: blocked structurally by `read_only`, and it can only create suggestions.

### R4. Pick up exactly where it stopped: checkpoint resume, mid-run lab failover, visible waits
- **User-visible outcome.**
  - A 2-hour task interrupted at step 140 by a crash, a deploy that ran past the grace period, or a provider outage resumes at step 140 with its context intact, instead of starting over.
  - During a provider rate limit the card says "Waiting for Anthropic's rate limit, retrying in 20 s". After it, "Switched to GPT-6 to keep going".
  - "Continue" really continues.
- **Competitor evidence.** ChatGPT Work and Claude Cowork promise multi-hour background tasks [O6][C2]. Neither documents recovery semantics, so this is a chance to be ahead.
- **Current code refs.**
  - Continue is a new attempt from the goal plus a brief (`src/lib/work/continuation.ts:16-23, 94-130`).
  - The lease sweeper never re-queues (`src/lib/work/store.ts:1563-1582`).
  - The checkpoint is bound to its run id (`scripts/work-runner.ts:722-749`) but saved continuously (`work-runner.ts:4230-4255, 4478`).
  - Parked in-flight calls can be read from a checkpoint (`WorkAgentSession.parkedToolCalls`, `runner/agent-core/src/work/session.ts:626`).
  - Failover happens only at run boundaries, on a user press (`src/lib/work/models.ts:307-322`; `src/lib/work/dispatch.ts:886-917`).
  - Provider adapters already drop another lab's signed reasoning (`runner/agent-core/src/providers/openai-responses.ts:82-90`).
  - Waits and compaction are only logged (`work-runner.ts:4479-4505`).
- **Implementation sketch.**
  - *Transplant:* add `transplantCheckpoint(prev, newRunId)` in `src/lib/work/restart-resume-rules.ts`. It does three things:
    - rewrite `runId`;
    - carry `plan`, `messages`, `actions`, `artifacts`, `citations` and `delegations`;
    - re-base `budget` (keep spent counters for honesty; the window check stays authoritative).
  - Continue on a `RESUMABLE` reason (`continuation.ts:35`) uses the transplant when `canContinueFrom` and the checkpoint is valid, and falls back to today's brief.
  - *Safe replay:* for a crashed run, classify the checkpoint's parked tool calls by risk tier:
    - all `safe` (reads, searches, page reads): auto-requeue once, with `terminalReason` recorded as `resumed_after_crash`;
    - any `edit` or higher: end `interrupted` and show a card, "It may have done: *Send email to Sam*. Resume from here / Start over", rendered from the parked call's own preview.
  - *Mid-run failover:* when the loop gives up on a step for `rate_limit` or `overloaded` after `MAX_TURN_RETRY_WAIT_MS` (`loop.ts:272-276`), and the run's model was **Auto**, the runner checkpoints, picks `workFailoverModels(...)[0]`, re-constructs the session with the transplanted checkpoint on the new provider, and emits `degraded: model_substituted`. A model the reader picked by hand is never switched; that run is paused with the reason shown instead.
  - *Visibility:* add event kinds `provider_waiting { lab, retryInMs }` and `context_compacted { strategy }` to `src/lib/work/domain.ts` and the contract, emitted from the two callbacks, and drawn as one muted line in `WorkRunPanel`.
- **Acceptance tests.**
  - Unit tests for the transplant (ids, budget re-base, plan preserved).
  - A runner integration test with the scripted model: kill after step N with only `web_fetch` in flight → resumes at step N+1 and finishes. Kill with `email.send` in flight → `interrupted` with the resume card, and no auto replay.
  - A failover test: provider A returns 429 for 120 s, so the run continues on provider B with the plan intact and one `model_substituted` event.
  - UI test: a `provider_waiting` event renders a line with a countdown.
- **Size** L. **Impact** H.
- **Risks.**
  - Replaying a non-idempotent call: guarded by tier classification; never auto above `safe`.
  - Cross-lab transcript quirks (tool-call id formats, image blocks): adapters normalise them already; add per-adapter tests.
  - Budget double counting: keep one usage ledger per run.

### R5. A browser that works on real sites (and shows its work)
- **User-visible outcome.**
  - Tasks that need a website finish more often: dropdowns, long pages, "Load more", Enter-to-search, back, file upload from the task's files, downloads saved as deliverables.
  - You see a thumbnail per page the task visited, in the same filmstrip computer runs get.
  - Cost per browsing step drops, because unchanged pages aren't re-sent.
- **Competitor evidence.** Claude's browser opens, reads, clicks and fills forms in a real browser [C2]. ChatGPT Work continues on sign-in-gated sites, and dots each have a browser [O6][P1]. Atlas had a visual agent with take-control [O19].
- **Current code refs.**
  - Actions (`runner/agent-core/src/work/tools.ts:701`).
  - An unknown action silently becomes `read` (`tools.ts:704-713`).
  - The first 20k chars are "cut off here" (`tools.ts:589, 724-728`).
  - 60 elements in document order with no viewport priority (`src/lib/work/browser-page.ts:5, 26-34`).
  - Full HTML is collected per snapshot (`browser-page.ts:125`).
  - The safety architecture (`docs/JUNO.md` §9b "What a cloud run can do").
- **Implementation sketch.**
  - Observation: replace the element walk with Playwright's accessibility snapshot (`locator.ariaSnapshot()`, with roles, names, states, `[ref]`s and checkbox/selected values), ranked viewport-first then by landmark (main before nav). Keep the `data-juno-ref` handles and the secret-input redaction (`browser-page.ts:186-190`).
  - Paged reading: `read { page: n }` and `find { text }` return the matching region and its neighbours, not always the first 20k chars.
  - Actions, each mapped onto the existing risk ladder (`BROWSER_ACTIONS`, `tools.ts:750`):
    - `scroll` (safe), `select {ref, option}` (edit), `press {key}` (edit; Enter inside a form becomes `submit`, so it still asks), `back` and `forward` (safe), `wait_for {text|ms}` (safe), `hover` (safe), `tabs` and `switch_tab` (safe);
    - `upload {ref, attachmentId}` (edit; only the task's granted files, via `WorkRunIO`);
    - `download` → a deliverable (safe; size-capped).
    - An unknown action returns an error naming the valid actions.
  - Diffs: keep the previous snapshot hash per tab. If the page is unchanged, return "unchanged since your last read", plus only the changed region after an action.
  - Visuals: a JPEG thumbnail per navigation (`page.screenshot({ quality: 50, scale: "css" })`) stored through the existing frame recorder (`src/lib/computer/frames.ts`) and drawn by `WorkComputerSteps`. It is not sent to the model, except as an optional `look` action for vision models with a set-of-marks overlay.
  - An eval suite: 20 scripted sites in `tests/fixtures/browser-sites/` (forms, pagination, SPA, dropdowns, infinite scroll), run with the scripted model and one real model nightly, tracking the success rate.
- **Acceptance tests.**
  - Each new action is unit-tested against fixtures.
  - `press Enter` in a form asks (risk test).
  - Unknown action → error, not a read.
  - The "unchanged" path returns under 300 chars.
  - The fixture suite's success rate is at least the target (set a baseline first).
  - The thumbnail filmstrip renders for a headless run.
- **Size** M-L. **Impact** H.
- **Risks.** Weakening the egress or submit invariants: the new actions must go through the same request interception and submit ladder (add tests that `press` and `select` can't bypass it). Screenshots of pages with personal data: keep them owner-only (`workFramePath`) and follow the run's retention (`src/lib/computer/retention.ts`).

### R6. Approve from anywhere, and "edit then approve" without a model round trip
- **User-visible outcome.**
  - A "Send this email to Sam?" push has **Send** and **Don't** buttons on iPhone, Mac and web. Face ID is required. Irreversible actions open the card with the full preview.
  - iMessage: "Iris wants to send 'Q3 renewal' to sam@… Reply SEND 4821 or NO."
  - On the card, **Edit & send** lets you fix the email body and approve your own version in one press. Today you can only Amend, which refuses and asks the model to redo.
- **Competitor evidence.** Claude lets you answer the agent's questions from mobile [C2]. Duet "shows you the exact action and waits for approval" [P5]. Alevr already does lock-screen approvals for Code, so this is parity inside its own product.
- **Current code refs.**
  - Code-only actionable categories (`JunoMobileLinkApprovalResponder.swift:27-31, 70-81`).
  - The Work category `JUNO_NEEDS_YOU`, unregistered (`src/lib/apns.ts:444-446, 487`).
  - The owner-auth gate to reuse (`native/iOS/JunoMobile/App/JunoMobileApprovalGate.swift:32-60`).
  - The service worker has no actions (`public/sw.js:106-170`).
  - iMessage "never a way to answer" (`src/lib/notifications.ts:263-268`).
  - Amend semantics and digest binding (`approval-card.tsx:51-66`).
  - The decision route (`src/app/api/work/approvals/[id]/decision`).
- **Implementation sketch.**
  - Push payload: add `approvalId`, `actionDigest`, `risk` and `verb` (from `src/components/work/approvals/action-verbs.ts`) when `mayIncludeRunDetail`.
  - iOS/Mac: register `JUNO_NEEDS_YOU` with dynamic actions, using two fixed categories (`JUNO_APPROVAL_ONCE` with Approve/Deny, and `JUNO_APPROVAL_OPEN` for irreversible actions), both with `.authenticationRequired`. Send `POST /api/work/approvals/{id}/decision {digest, decision:"allow_once"}` through `JunoMobileApprovalGate`.
  - Web: `showNotification(..., { actions: [...] })` plus a `notificationclick` handler that POSTs with credentials. It requires a fresh WebAuthn/password re-check only for `sensitive`.
  - iMessage: `textApprovalNotice` includes the verb and target and a 4-digit one-time code bound to `approvalId` and digest (10-minute TTL, stored hashed). Inbound `SEND 4821` → decision. Irreversible actions stay link-only unless the owner opts in.
  - Edit & approve: the decision route accepts `{decision:"allow_edited", editedDetail}` for actions whose preview kind is a text body (email, message, document). The server recomputes `actionDigest` over the edited detail and records the user's edit as the authorisation; the executor runs the edited action, not the original (the runtime must accept the replacement detail on resume, via `park-resume-rules.ts`).
- **Acceptance tests.**
  - The notification action decides the exact approval: a digest mismatch is refused, and an expired approval is refused with its own sentence.
  - Face ID cancel sends nothing.
  - Irreversible actions have no inline button.
  - An iMessage code works once, and a wrong code is refused after 3 attempts.
  - Edit & approve sends the edited body: an integration test asserts the connector call args.
- **Size** M. **Impact** M-H.
- **Risks.** Approving from the lock screen without reading: mitigated by verb buttons, owner auth and irreversible-only-in-app. SMS codes being phished: bound to digest, single-use, short TTL, and off for irreversible actions.

### R7. "Only tell me if something changed": quiet runs for monitors and briefs
- **User-visible outcome.**
  - "Check every 2 hours whether the visa appointment page has a slot, and only ping me if it does."
  - Runs with nothing to report don't push or write a full message. The thread shows one collapsed line, "Checked 14:00, nothing new", and the routine row says "last news 3 days ago".
- **Competitor evidence.** Duet checks every few hours and decides what needs you [P4][P5]. ChatGPT's replacement for Pulse is scheduled tasks used as monitors [O-P2].
- **Current code refs.**
  - Policies (`src/lib/work/notifications.ts:33-34`).
  - Topic monitor every 6 h (`src/lib/work/triggers.ts:1219`).
  - Event triggers (`triggers.ts:56-64`).
  - Schedule health (`src/lib/work/schedule-health.ts`).
- **Implementation sketch.**
  - Runtime tool `report_nothing_new { reason }` (safe), offered only to routine runs whose policy is `on_findings`. The run ends `completed` with `WorkRun.outcome = "quiet"` (a new nullable column).
  - `decideNotification`: `on_findings` + quiet → no notify; otherwise notify as `on_finish`.
  - R1 writes a one-line `work_result_quiet` activity, not a full message.
  - Change detection: store `WorkSchedule.lastFindingDigest` (a hash of the normalised result). If a non-quiet run's digest equals the last one, it is treated as quiet ("same as last time").
  - `propose_routine` gains `notify: "on_findings"` (`src/lib/work/routine-proposal.ts:52`).
- **Acceptance tests.**
  - Decision table: `on_findings` + quiet → none; + finding → push.
  - Two identical findings in a row → the second is quiet.
  - A quiet run still counts in schedule health as healthy.
  - The routine proposal round-trips the new policy.
- **Size** S-M. **Impact** M-H.
- **Risks.** The model saying "nothing new" too eagerly: the tool requires a reason, the reason is shown in the collapsed line, and a weekly "still watching, nothing new" summary keeps trust.

### R8. Auto-review: long tasks that don't stop every few minutes, without being less safe
- **User-visible outcome.**
  - In Balanced mode, routine `edit` and `command` actions consistent with your request (filing tickets you asked for, creating drafts, renaming files in the granted folder) proceed automatically after a reviewer check.
  - You're asked only when something looks off, or for irreversible and always-confirm actions.
  - The result message lists "Auto-approved 14 actions", with an undo link where one exists.
- **Competitor evidence.** Claude Auto mode: "automated safety checks run before actions", and it is the default on consumer plans [C2]. Dots auto-review, plus a monitor that can pause the agent [P1].
- **Current code refs.**
  - A static ladder (`src/lib/work/domain.ts:639-649`); `ALWAYS_CONFIRM_ACTIONS` (`domain.ts:672`).
  - Untrusted-taint tracking (`runner/agent-core/src/work/injection.ts`; the chat's `liveTaint` in `src/lib/chat/turn/tools.ts:198, 235`).
  - Approvals park the run after 60 s (`src/lib/work/park-resume-rules.ts:27`).
  - Undo exists as a host command (`WORK_COMMAND_KINDS` includes `undo`, `docs/JUNO.md` §9b.1).
- **Implementation sketch.**
  - `runner/agent-core/src/work/auto-review.ts`. Inputs are the user's original request, the task goal, the action and its preview, the provenance chain (was the last untrusted result before this action the reason for it?) and the policy. The output is `{ verdict: allow|ask, why }`.
  - Use a small, cheap model on the run's provider with a strict schema and a 5 s timeout that **fails closed** (ask).
  - Applies only to `edit` and `command` in `balanced`. Never to `sensitive` or `irreversible`, never after an injection signal, and never to a first-of-its-kind action to a new recipient or host.
  - Record a `WorkAuditEvent` (`auto_reviewed`) and add a count to the receipt.
  - Opt-in per conversation or project ("Let Alevr decide routine steps"); later, the default for Balanced.
- **Acceptance tests.**
  - A red-team fixture set: injected emails that ask to forward data → always `ask`.
  - Benign batch: 10 ticket creations requested by the user → 0 prompts.
  - Reviewer timeout → ask.
  - Irreversible actions bypass the reviewer.
  - The audit log has one row per decision.
- **Size** M. **Impact** M-H.
- **Risks.** Reviewer false negatives: bounded by the action classes and the fail-closed design. Extra cost per action: a tiny model and a cached system prompt, roughly 1 to 2% of run cost (measure).

### R9. Queue instead of refuse, and more tasks in parallel
- **User-visible outcome.** Asking for a 4th task says "Queued: starts when 'Inbox triage' finishes (2nd in line)", not "You already have 3 runs in progress. Let one finish first." Paid plans run more at once.
- **Competitor evidence.** Claude: "You can run several tasks at once" [C2].
- **Current code refs.**
  - `WORK_RUN_CONCURRENCY_CAP = 3` (`src/lib/work/dispatch.ts:674`).
  - A hard 429 at `dispatch.ts:1278-1285` and `1528-1537`.
  - `WORK_CAPPED_LIVE_STATUSES` counts parked runs (`park-resume-rules.ts`).
  - The per-conversation cap is 4 (`conversation-tasks.ts:27`).
  - Board dependency queueing already exists (`src/lib/work/board.ts`, referenced at `store.ts:1716`).
- **Implementation sketch.**
  - The cap counts **executing** statuses only (`preparing`, `running`). Waiting and parked runs hold no lease and should not block.
  - Over the cap, create the run as `queued` with `WorkRun.queuedBehind` (a run id) or a per-user FIFO position. The runner's `findQueuedRuns` respects a per-user executing cap.
  - Make the cap plan-tiered in `src/lib/plans.ts` (for example Free 1, Plus 3, Pro 8, team seats more). The 10/min dispatch rate limit stays.
  - UI: the card's live line says "Queued, 2nd in line", and the task card can be cancelled while queued.
- **Acceptance tests.**
  - The 4th dispatch returns 200 with `queued` and a position.
  - It starts within one runner tick of a slot freeing.
  - A parked run doesn't block a new one.
  - Plan caps are enforced.
  - `expireUnclaimedCloudRuns` (`store.ts:1700+`) still ends queued runs on a real executor outage only.
- **Size** S-M. **Impact** M.
- **Risks.** Runner capacity: set worker concurrency from the plan mix, and watch the queue latency metric.

### R10. Every task can get a computer when it needs one (not only hired agents)
- **User-visible outcome.**
  - A normal chat task that hits a sign-in wall, a canvas-heavy site or a site that blocks headless browsers says "I need you to sign in to United", and opens a live view where you take over, sign in (vault fill offered) and hand back.
  - The task continues on that computer. You can watch any visual task live.
- **Competitor evidence.** ChatGPT Work continues on sites that need sign-in (since Aug 2026, press) [O6]. Dots have their own computer you can open at any time [P1]. Claude computer use and browser [C2][C9].
- **Current code refs.**
  - `prepareRunComputer` returns `none` without `agentId` (`src/lib/computer/store.ts:2462-2475`).
  - Computer tools and the takeover fence (`scripts/work-runner.ts:2181-2235, 4000-4040`).
  - The login tool (`runner/agent-core/src/work/computer-login-tool.ts`).
  - Production status: off, no host (`docs/design/AGENTS.md:276-285`).
- **Implementation sketch.**
  - Ephemeral task computers: `AgentComputer` gains `ownerKind: "agent" | "task"` and `sessionId`. Alternatively, a sibling `TaskComputer` model can reuse `src/lib/computer/docker.ts` and the sweep with a short idle TTL (10 min) and a per-account concurrency of 1 to 2.
  - Escalation: the headless browser tool returns `needs_visual { reason }` when it detects a login form without a vault grant, `<canvas>`-only content, or a bot wall. The runtime then offers `start_computer` (asks under every mode, with a cost note).
  - The chat card (`WorkRunPanel`) embeds `ComputerView` (`src/components/agents/computer-viewer.tsx`) with Take over and Hand back.
  - Prerequisite: run the computer host in production (the runbook exists from task #10 in the parent's list; `deploy/agent-computers/`).
- **Acceptance tests.**
  - A login-wall fixture → the task pauses with a "Sign in" card → takeover → hand back → the task continues and the cookie persists for the session only.
  - Screenshots taken during takeover are never stored (an existing fence test, extended).
  - The idle reaper destroys the task computer after its TTL.
  - Cost is shown in the receipt.
- **Size** L (plus infra). **Impact** H.
- **Risks.** Infra cost and abuse (crypto-mining, scraping): keep egress blocks (`src/lib/computer/policy.ts`), CPU quotas and per-plan gating. Credential exposure: the vault fill-at-boundary already exists.

### R11. Live progress that stays live on the lock screen, Mac menu bar and web tab
- **User-visible outcome.**
  - The iPhone Live Activity and Dynamic Island update in real time even with the app closed: "Step 6 of 9 · Reading supplier PDFs · 14m".
  - They flip to "Needs you", then "Done" with the result line.
  - The web tab title shows "(1) Needs you · Alevr" when a task in the background chat blocks.
- **Competitor evidence.** Claude's persistent agent thread on mobile and checking progress on mobile [C1][C2].
- **Current code refs.**
  - Live Activities are updated locally only (`native/iOS/JunoMobile/App/JunoMobileLiveActivities.swift:30-55`; `JunoMobileRuns.swift:233` with `pushType: nil`).
  - APNs supports `liveactivity` (`src/lib/apns.ts:37`).
  - Plan and step events (`docs/JUNO.md` §9b.2).
- **Implementation sketch.**
  - Request the activity with `pushType: .token`, then upload `pushTokenUpdates` to a new `POST /api/v1/live-activity-tokens {runKey, token}` (a `LiveActivityToken` model with userId, runId, token and expiry).
  - `src/lib/work/notify/live-activity.ts` sends `liveactivity` pushes on `plan_updated`, `step_started`, needs-you and terminal events. It is throttled (no more than one per 15 s, as Apple's budget requires), with `relevance-score` and `stale-date`.
  - Push-to-start for runs started elsewhere (iOS 17.2+ `pushToStartToken`).
  - Web: a `document.title` badge from the existing needs-you count (`src/components/work/inbox/use-needs-you-count.ts`).
  - The `provider_waiting` line from R4 shows here too.
- **Acceptance tests.**
  - A token is registered and refreshed.
  - A server push updates the activity while the app is suspended (device test).
  - The throttle holds under a burst of 50 steps.
  - The activity ends on terminal with the result line.
- **Size** S-M. **Impact** M.
- **Risks.** The APNs Live Activity budget: throttle, and coalesce steps.

### R12. Text Alevr a job: iMessage that can start tasks and routines
- **User-visible outcome.**
  - "Book a table for 4 at 8 tonight near the office" → "On it, I'll text you when it's booked." The task runs, asks for approval by text (R6), and texts back the result line from R1.
  - "Every Friday send me a summary of Slack #sales" → a routine proposal you confirm with "YES".
- **Competitor evidence.** Texting your dot over iMessage/RCS (beta, 28 Oct 2026) [O1][P3].
- **Current code refs.**
  - A tool-less text reply (`src/lib/channels/reply.ts:1-12`).
  - The inbound pipeline (`src/lib/channels/inbound.ts`, `webhook.ts`).
  - Vendor gating (`isIMessageConfigured`, `src/lib/env.ts`); the Mac relay (`src/lib/channels/mac-relay.ts`).
- **Implementation sketch.**
  - Route inbound texts through a reduced chat turn (`src/lib/chat/turn/run-turn.ts`) with only `start_task` and `propose_routine` enabled. Trust rules are unchanged: a task starts only from the person's own message.
  - Confirmation by text for the routine proposal: a one-time code, as in R6.
  - Results go back via R1/R2 to the channel when the run's origin is a channel (`WorkRun.origin = "channel"`).
  - Rate-limit and cap cost per text.
- **Acceptance tests.**
  - A text produces one task, and duplicate deliveries are idempotent on the vendor message id.
  - The result is texted back once.
  - Approvals by code (R6).
  - A forwarded message containing "start a task" does not start one (trust test).
- **Size** M. **Impact** M (vendor-gated).
- **Risks.** Spoofed sender numbers: link verification already exists (`src/lib/channels/link.ts`), keep it. SMS cost.

---

## 4. Top items, short form

1. **R1** Results as durable chat messages the model can read (fixes vanishing results, routine history, blind follow-ups). M / H.
2. **R2** Presence-aware "done" notifications with the result in them. S-M / H.
3. **R3** A proactive daily brief over mail, calendar and Slack in a structural `read_only` mode, with Start cards. L / H.
4. **R4** Resume from checkpoint after crash or outage, automatic lab failover mid-run, visible provider waits. L / H.
5. **R5** Browser quality: accessibility snapshot, paging, the missing actions, diffs (cheaper), thumbnails, an eval suite. M-L / H.
6. **R6** Approve from the lock screen, Mac, web push and iMessage, plus Edit & approve. M / M-H.
7. **R7** Quiet runs: "only tell me if something changed". S-M / M-H.
8. **R8** Model auto-review in Balanced mode, fail-closed. M / M-H.
9. **R9** Queue instead of a 429; plan-tiered parallelism. S-M / M.
10. **R10** Ephemeral computers with takeover for any task (needs the production computer host). L / H.
11. **R11** Push-updated Live Activities and a background-tab badge. S-M / M.
12. **R12** iMessage that can start tasks and routines. M / M.

Suggested sequencing: R2 and R9 (quick wins) → R1 → R7 → R3 (depends on R1, R2, R7) → R4 → R5 → R6 → R8 → R11 → R10 (infra) → R12 (vendor).

---

## 5. Sources

Anthropic (fetched directly):
- [C1] Claude release notes: https://support.claude.com/en/articles/12138966-release-notes
- [C2] Claude Cowork and chat are one Claude: https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude
- [C9] Let Claude use your computer in Cowork: https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork
- [C10] Schedule recurring tasks in Claude Cowork: https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork

OpenAI (fetch blocked; search excerpts of these official pages):
- [O1] ChatGPT release notes: https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- [O6] ChatGPT Work and Codex: https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex (press: https://razomua.media/en/news/tekhnolohiyi/chatgpt-work-ne-novyy-chat-bot-a-ahent-yakomu-vy-zalyshayete-noutbuk-vidkrytym, https://borncity.com/news/chatgpt-work-openai-startet-ki-agenten-mit-8-mio-nutzern/)
- [O13] Scheduled tasks in ChatGPT: https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt ; [O13b] secondary on event-trigger caps: https://www.developersdigest.tech/blog/chatgpt-mcp-event-triggered-automations
- [O-P1] ChatGPT Pulse help page: https://help.openai.com/en/articles/12293630-chatgpt-pulse ; [O-P2] https://www.digit.in/news/general/openai-is-retiring-chatgpt-pulse-and-replacing-it-with-scheduled-tasks-here-is-why.html ; [O-P3] https://alternativeto.net/news/2026/6/chatgpt-launches-new-scheduled-tasks-and-prepares-to-sunset-pulse/
- [O19] ChatGPT Atlas release notes: https://help.openai.com/en/articles/12591856-chatgpt-atlas-release-notes ; launch: https://openai.com/index/introducing-chatgpt-atlas/ ; take control/stop: https://feeds.simonwillison.net/2025/Oct/21/introducing-chatgpt-atlas/ ; [O19b] retirement (secondary): https://aicybr.com/blog/openai-atlas-retirement-august-2026
- Developer-side long-task limits (community): https://community.openai.com/t/handling-long-running-tasks-in-chatgpt-apps/1369488 , https://community.openai.com/t/support-mcp-v2-tasks-extension-in-chatgpt-web/1389851

Press and secondary (lower confidence):
- [P1] dots (SiliconANGLE, fetch blocked; search excerpt): https://siliconangle.com/2026/09/29/openai-launches-dots-always-on-ai-agents-in-chatgpt-with-their-own-cloud-computers/
- [P2] dots explainers: https://www.datacamp.com/blog/openai-dots , https://www.mindstudio.ai/blog/chatgpt-dots-explained
- [P3] Texting your dot (from the gap matrix): https://x.com/ChatGPT/status/2115496387613786374
- [P4] Claude Duet (BetaNews, fetch blocked; search excerpt): https://betanews.com/article/proactive-ai-agent-claude-duet/
- [P5] Claude Duet approvals and check-ins: https://www.vktr.com/ai-platforms/claude-duet-anthropic-previews-an-ai-agent-that-messages-you-first/ , https://braindetox.kr/en/posts/claude_duet_proactive_personal_agent_2026.html , https://findskill.ai/blog/what-is-claude-duet-proactive-agent-waitlist-guide-2026/
- [P6] Duet availability: https://letsdatascience.com/news/anthropic-opens-claude-duet-research-preview-for-proactive-a-16522f5d
