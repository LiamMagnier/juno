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
