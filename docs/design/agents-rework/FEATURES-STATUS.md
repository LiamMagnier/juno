# Agents features: status

2026-09-27. Branch `agents/features`, paused by the owner at WIP commit `2c773b5e`.
Nothing is pushed or deployed.

## Shared: data

Done:
- `prisma/schema.prisma` has six new tables: `AgentRoomMember`, `AgentRoomTurn`,
  `ChannelLink`, `ChannelInbound`, `AgentSpendLimit` and `AgentPayment`. No
  existing table changes.
- Migration `prisma/migrations/20260927160000_agents_rooms_channels_payments`. It is
  expand-only, uses `IF NOT EXISTS` on indexes, and enables RLS on each new table.
- `OWNER_COLUMN` entries in `src/lib/db.ts` for the five owned tables.
  `ChannelInbound` is an ownerless replay ledger.
- New `AGENT_EVENT_KINDS`: `room_joined`, `room_asked`, `spend_limit_changed`,
  `payment_issued` and `channel_message`.

Still to do:
- Run `prisma validate`.
- Run the drift check against a throwaway Postgres (RULES.md §6). Neither has run.
- Add rows to the encryption table in `SECURITY.md` for `ChannelLink.phone`,
  `AgentRoomTurn.request` and `AgentPayment.reason`.

## 1. Group chats between agents (rooms)

Done (server):
- `src/lib/agents/rooms.ts` (pure) covers:
  - @Name addressing, including @all;
  - relevance routing, with a tie going to the last speaker;
  - the cap of 3 turns per message;
  - the loop guard: an agent answers a message once, and `canAskMember` enforces it;
  - the next-turn rule, with stale running turns;
  - the room prompt block;
  - `[Name]` history labelling;
  - handoff sentences ("Mira asked Scout to check the pricing");
  - the `create_room` and `ask_room_member` declarations.
- The database enforces the cap and the loop guard too, through two unique keys:
  `(userMessageId, agentId)` and `(userMessageId, position)`.
- `src/lib/agents/room-store.ts` covers:
  - create, list and load of rooms;
  - `prepareRoomTurn`, which picks the speaker for a new message, a follow-up, a
    retry, or a native append followed by a regenerate;
  - `recordRoomPlan`, `askRoomMember`, `markRoomTurn`, `roomSpeakers` and
    `loadRoomDetail`, which returns turns and the next turn.
- `src/lib/chat/room-tools.ts` has the `create_room` and `ask_room_member` tool
  factories, with server modules loaded through `await import()`.
- Wiring in `src/app/api/chat/route.ts`:
  - rooms are detected when a conversation has members and no `agentId`;
  - the speaker becomes the turn's agent (model, brief, memory, tools, approvals);
  - the room block is appended to the prompt, and other members' replies are
    labelled in the history;
  - a follow-up turn appends a reply instead of replacing one;
  - the turn is marked answered when its reply is persisted;
  - both room tools are added to `nativeTools`. Follow-up turns ride
    `regenerate: true`, so start_task, handoff and config tools stay off there. This
    avoids approval-key collisions per message.
- `src/lib/chat/request.ts` has a new optional `roomTurn: { agentId }` field.
- `npm run typecheck` passes.

Next:
- API routes: `GET/POST /api/agents/rooms` and `GET /api/agents/rooms/[conversationId]`.
  Classify both in `contracts/parity/features.json`.
- Classify `request.roomTurn` (web-only) in
  `contracts/chat/juno-chat-wire-v1.status.json`, then run `npm run native:wire`.
- Client, all in new files where possible:
  - `continueRoom(agentId)` in `use-chat`: an assistant placeholder, then a
    runGeneration call with `regenerate: true` and `roomTurn`;
  - a room hook that fetches the detail after each reply and runs `next`;
  - the room header, with overlapping faces on halos from `agent-presence.tsx`;
  - a speaker line above each assistant message (face, name, handoff sentence),
    mounted in `message-item.tsx` through a context;
  - a sidebar rooms list under the Agents fold;
  - a quiet "Group" action on Agents home.
- `tests/agents-rooms.test.ts` for routing, caps and loop prevention, plus a
  source pin that room-tools loads server modules lazily.
- Known gap: native clients get the first answer only. They do not run follow-up
  turns until they learn `roomTurn`.

## 2. Message your agent from iMessage

Done:
- Tables `ChannelLink` (HMAC phone hash, encrypted number, verification code
  hash) and `ChannelInbound` (replay ledger).
- Research, with sources to cite in code comments:
  - Sendblue send is `POST https://api.sendblue.co/api/send-message` with headers
    `sb-api-key-id` and `sb-api-secret-key`, and body `number`, `from_number` and
    `content` (docs.sendblue.com/api/resources/messages/methods/send/).
  - The inbound "receive" webhook has fields `from_number`, `to_number`,
    `content`, `message_handle`, `date_sent` and `is_outbound`
    (docs.sendblue.com/getting-started/webhooks/).
  - The webhook secret is sent verbatim in the `sb-signing-secret` header. It is
    not an HMAC (docs.sendblue.com/guides/chat-sdk-adapter/). This needs one more
    env var: `CHANNEL_SENDBLUE_WEBHOOK_SECRET`.

Next:
- `src/lib/channels/`:
  - a provider interface;
  - a Sendblue provider;
  - the Mac relay stub and its documented protocol;
  - a fake provider for tests.
- Env getters in `src/lib/env.ts`, `.env.example` and `docs/JUNO.md` §19.
- Link and verify routes, with the code sent by iMessage.
- A webhook route with:
  - timing-safe secret check;
  - replay protection (handle dedupe and a `date_sent` window);
  - a rate limit per number;
  - unknown numbers ignored.
- A headless agent reply through `runUtilityPrompt`, with @Name targeting, mirrored
  into the agent's thread.
- Approval notices sent as texts with a link, through a small hook in `notifyUser`.
  A text reply never approves anything.
- Tests with the fake provider.

## 3. One-time payment cards

Done:
- Tables `AgentSpendLimit` and `AgentPayment`. The PAN and CVC are never stored.
- Research: Stripe Issuing virtual cards can use
  `spending_controls.spending_limits[{amount, interval: all_time}]`. A merchant
  lock needs the real-time `issuing_authorization.request` webhook, answered within
  2 s with `{approved}` and the `Stripe-Version` header. Card details come from
  `expand[]=number&expand[]=cvc`, and cards are cancelled with `status=canceled`.

Next:
- `src/lib/payments/`:
  - a provider interface;
  - a Stripe Issuing provider (off until `STRIPE_ISSUING_*` is set);
  - a dev-only test provider;
  - `fillPaymentCard(agentId, cardRef)` with a registration point for the
    computer builder, which holds the card and tells the person when no computer
    is available.
- A `request_payment` tool. It raises a deterministic approval with connector
  `juno_payments` and an exact rule of `destructive_or_sensitive`. The card shows
  Not now and Pay, and a receipt follows.
- A spending limit tool: widening needs the agent approval card.
- The Stripe authorization webhook.
- Tests.

## Gates so far

- Baseline on the untouched tree: typecheck, test, lint, `native:sync:check` and
  `work:contract:check` all passed.
- On the WIP commit: only `npm run typecheck` has run, and it passed.
- Not yet run on the WIP: `npm test`, lint, `native:sync:check` and the Prisma drift
  check. `native:wire:check` is expected to fail until `request.roomTurn` is
  classified.

## 4. Where an agent's work runs (cloud or your Mac)

2026-10-25.

Done:
- Executor heartbeat. `scripts/work-runner.ts` records one each tick (at most
  every 20 s) in the existing `RateLimit` key/expiry table, key
  `work-executor:heartbeat` (`src/lib/work/executor-heartbeat.ts`, rules in
  `src/lib/work/executor-presence.ts`). Dispatch, Run now, the scheduler, the
  trigger poller and saving a schedule (`admissionRefusal`) treat cloud as
  available only while that heartbeat is under two minutes old;
  otherwise the dispatcher returns its existing `no_executor_available` 409
  ("No cloud worker is running, so Cloud Work is not accepting tasks right
  now.") instead of queueing. `WORK_CLOUD_AVAILABLE=1|0` overrides it.
- Queued cloud runs end as `executor_unavailable` (status `interrupted`) once
  the executor's last heartbeat is over ten minutes old AND the run has sat in
  `queued` (its `updatedAt`, which a resume moves) for over ten minutes. The
  sweep reads the heartbeat row itself (no cache, no `WORK_CLOUD_AVAILABLE`
  override, a failed read ends nothing). A resumed run with a checkpoint ends
  `interrupted` and keeps it; team leads are left to `advanceTeams`. Swept by
  the Work scheduler every minute, and for one account by dispatch while cloud
  is closed. Until then, dispatch leaves unclaimed queued cloud runs out of the
  concurrency cap while the executor is known to be absent. Resume of a paused
  cloud run returns the same 409 when no worker is running.
- A cloud routine skipped because no cloud worker was running is recorded as
  `executor_unavailable` ("Last run skipped: no cloud worker"), not as a Mac
  that could not be reached.
- `Agent.executionTarget` (`cloud` | `mac`, default `cloud`) and
  `Agent.preferredHostId`, migration
  `prisma/migrations/20261025120000_agent_execution_target`. Tasks, routines,
  goal steps and goal retries use it (`agentDispatchTarget`, through
  `resolveAgentDispatchTarget`, which drops a preferred Mac that was removed
  to "any Mac"); `mac` maps to Work's `local`. An offline Mac is refused,
  never moved to the cloud; routine skips and goal refusals are recorded as
  the `task_refused` agent event. Specialist teams stay cloud-only and are
  refused for a Mac agent.
- Existing routines follow a "Runs on" change: `updateAgentForUser` moves the
  agent's Work schedules (target and Mac, placed by `agentRoutineHost` as
  `createAgentRoutine` places a new one) in the same transaction, or refuses
  the change when a Mac routine would have no Mac to name. Undo restores the
  setting (re-checking the Mac) and moves the routines back.
- Only the person sets it: `update_agent` refuses `executionTarget` and
  `preferredHostId`, and builds its patch from a named list of arguments.
- A Mac run of an agent's task gets `agentContext` (persona, brief, goals,
  kept notes; `src/lib/agents/run-context.ts`) on its start and resume
  commands. It is built when the Mac claims the command
  (`serializeClaimedCommand`, GET `/api/work/hosts/[id]/commands`) from the
  live agent and never stored on the command row, so decrypted notes are not
  kept in plaintext and a forgotten note does not reach a resume. The Mac
  prepends it to the system prompt as context only.
- Saving a cloud routine does not consult the executor heartbeat; a fire with
  no cloud worker is skipped as `executor_unavailable`.
- Web: "Runs on" on the agent profile, with each Mac's name and state
  ("Online", "Not responding", "Offline") from `/api/work/hosts`, refreshed
  while open, with loading and error states and a line when its Mac is gone;
  the thread says when no cloud worker is running.
- Mac: "Runs on" on the agent page (Cloud / This Mac, or "Another Mac" when
  pinned elsewhere, with "Use this Mac instead"), which leads to Settings,
  Devices, "Allow Alevr Work on this Mac" when its tasks would run here.

Dev: cloud tasks need the runner. There is no process manager in the
dependencies, so run it in a second terminal beside `npm run dev`, and the
scheduler in a third (it hosts the queued-run expiry sweep as well as
routines; without it, runs queued while the runner was down only end when a
dispatch for that account comes in):

```bash
npm run work:runner
npm run work:scheduler
```

(or set `WORK_CLOUD_AVAILABLE=1` only if something else claims queued runs).

Still to do:
- Build and test the Swift changes on a Mac (`npm run native:test`); they were
  written without a Swift toolchain.

Gates run: `prisma validate`, `prisma generate`, and the drift check against a
throwaway Postgres 16 ("No difference detected").

## 5. Orbit truth and controls (package O2)

2026-10-28. On the working branch `claude/premium-design-pass`; not deployed.
Closes gaps 10, 11 and 15 of the 2026-10-27 Orbit discovery and the doc drift
of gap 17 (outside the computers section of `docs/design/AGENTS.md`).

Done:
- **A goal is met only when it is checked.** The run that finishes a goal's
  last milestone checks the goal's success criteria against every step's
  result (`checkGoalCriteria` in `runner/agent-core/src/work/judge.ts`, built
  to be hard to pass: a criterion the results do not show is NOT MET), with
  the run's own provider and model, and records the verdict on the agent's log
  (`goal_checked`; `src/lib/agents/goal-criteria.ts`, wired in
  `scripts/work-runner.ts` around the run's own validator, whose result it
  never changes). The driver (`goal-runner.ts`) makes the goal `achieved` only
  on a recorded pass; a NOT MET, a check that could not run, or no check at all
  (a last step that ran on a Mac) leaves it `unverified`: "Every step ran.
  Check the result.", with each step's task linked on the profile, *Mark it
  met* and *Keep working* (which adds one milestone aimed at the gap and drives
  it). The person is notified (`agent_goal`: needs-you when unverified, an
  update when met unless the agent only notifies when it needs them). The chat
  tool's `achieve` is described as the person's call only.
- New goal status `unverified`, handled by the API (never settable by a
  person or a chat), the web profile, notifications, the OpenAPI contract
  (`AgentGoal.status`) and the native decoder (`NativeAgentGoalStatus`, label
  "Check the result", listed on the native profile).
- **Hiring needs a plan with agents.** `createAgentForUser` and
  `duplicateAgentForUser` refuse Free and Lite with `402 plan_locked` and
  `upgradePlan`, before anything is created (`src/lib/agents/plan-gate.ts`);
  so do the chat's `create_agent` and Move to crew, which go through it.
  `/agents` and `/agents/new` show one upgrade card instead of the hire field
  (and `?form=1` falls back to it). Agents kept from before a downgrade stay
  listed and readable; nothing is deleted.
- **Agents keep what they learn in a task.** The Work tool `remember`
  (`agentNoteTool`, runner/agent-core/src/work/tools.ts) saves one short note
  for the agent, at most three per run, through `src/lib/agents/run-notes.ts`.
  Under the default memory grant the note is `pending` (`AgentNote.status`,
  migration `20261028120000_agent_note_review`, expand-only) until the person
  keeps it on the profile (*Keep* / *Forget*); only an agent granted all of
  the person's memory keeps it at once, and a sensitive topic always waits.
  No reader sees a pending note: the chat prompt, the run persona (cloud and
  Mac), reflection and `GET …/notes` read `status: "kept"`. Every note,
  whoever writes it, is screened: a value beside a password, PIN, code or key
  label is refused, and keys and tokens are masked with the redaction shared
  transcripts use (`scanAndRedact`; `src/lib/agents/note-review.ts`).
- **Profile controls** for the two settings that were chat-only: *When it
  tells you* (needs you / results / everything) and *What it thinks with*
  (the Settings model picker, with thinking effort), both through the same
  agent patch and plan check as the thread's setup changes.

Second pass (2026-10-30, same branch, not deployed):
- The chat's `create_agent` on a plan without agents answers with the plan's
  sentence before any approval card, so nobody approves a routine or an app
  for a hire the plan then refuses (`hiringRefusal`, handed in by the chat
  turn from `agentHiringGate`; `createAgentForUser` still refuses either way).
- An agent's chat knows its `unverified` goals apart from its active ones
  ("Goals waiting for the person to check", with the gap the check named),
  and is told never to call one met (`src/lib/agents/prompt.ts`).
- An `unverified` goal counts as open against the 20-goal cap until the
  person marks it met or keeps it going.
- The OpenAPI contract documents the hire's `402 plan_locked`, the note
  route's `{ "action": "keep" }` and its `422 note_secret`
  (`JunoNativeContract.swift` digest regenerated). The native profile says
  "Every step ran. Check the result." under an unverified goal, as the web
  does (Swift, uncompiled here).
- The wiring is now exercised, not only read: `tests/orbit-truth-runner.integration.test.ts`
  drives the real cloud executor (`scripts/work-runner.ts`) against a local
  stand-in for the model API. An agent's run is offered `remember` and a plain
  run is not; the note waits for review, encrypted; a secret is refused even
  under "Everything"; the last milestone's run asks the criteria check with
  the run's own model and records MET or NOT MET; the driver then makes the
  goal `achieved` or `unverified`. It also calls the routes: hire on Free is
  402 and makes nothing, `unverified` cannot be set by hand, *Mark it met*,
  *Keep working* (a follow-up milestone dispatched as a real task) and *Keep*.
  Both O2 integration suites run in deploy.yml's isolated-database loop.

Tests: `tests/orbit-truth.test.ts`, `tests/orbit-truth.integration.test.ts`,
`tests/orbit-truth-runner.integration.test.ts`,
`runner/agent-core/src/test/work-judge.test.ts` (criteria cases) and
`work-agent-note-tool.test.ts`; `tests/orbit-goals.integration.test.ts` now
expects `unverified` when no check ran.

Not done or not verified:
- No real model has run the criteria check or `remember` (no provider keys
  here; the tests use a stand-in that answers MET or NOT MET by a marker). How
  often a real model calls `remember`, and how well a real model's MET/NOT MET
  matches a person's judgement, is unmeasured.
- Native: the Swift edits are uncompiled here, and the native profile has no
  *Keep* / *Forget* for pending notes (they never reach native's `notes`) and
  no *Mark it met* / *Keep working* beyond the existing tap to mark achieved.
- The profile was looked at as a static render of the real API's answer with
  the app's CSS (the shared dev server restarted every few minutes under load,
  so the live chat page did not load for a screenshot); the controls'
  interaction (pressing a segment, picking a model) was not clicked through in
  a browser here.
- A Mac run has no `remember` and no criteria check; a goal whose last step ran
  on a Mac ends `unverified` by design.
