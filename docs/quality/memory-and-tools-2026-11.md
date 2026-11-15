# Memory and tool calls — quality pass, November 2026

*Test-first audit of the two journeys. Each defect was proven with a failing
test before it was fixed. Line numbers are against this branch.*

## Summary

| # | Defect | Impact | Status |
|---|---|---|---|
| 1 | A memory reader already waiting on its model saves the chat's facts after the chat was deleted, memory was turned off for it, memory was paused, its project was cleared or everything was reset. After a reset it also moves the read mark back. | **High** (privacy: "delete" and "erase" do not hold) | **Fixed** |
| 2 | Clearing a project's memory keeps the edit ledger. Its Undo entries quote the cleared facts word for word, and pressing Undo writes them back into the project. | **Medium-high** (privacy, and an erased fact can come back) | **Fixed** |
| 3 | Undo on a receipt fact that the turn *believed again* (reinstated), rather than created, block-lists a fact the person stated before that turn. It does not return memory to how it was. | Medium | Open |
| 4 | A brokered Alevr tool that is stopped or times out mid-run is completed on its durable receipt as `failed` with an empty result. The action may have happened, and a replay of that receipt hands the model an empty failed result. | Medium-low | Open |
| 5 | Audit rows are written as `executed` before authorisation. If the broker throws, the row is never settled and still says `executed`. | Low-medium (audit integrity) | Open |
| 6 | A turn whose agent was deleted reads the account's full memory, not the deleted agent's narrower grant. | Low (unclear whether this is intended) | Open |
| 7 | The account reset's `createMany` has no `skipDuplicates`. A concurrent first extraction can make it return 500 after the erase has already committed. | Low | Open |
| 8 | There are three copies of the call-id stamper. The two adapter copies add one suffix and never re-check it, and the `seenCallIds` set they read is never written. | Low (latent) | Open |
| 9 | A voice tool POST builds a fresh dispatcher every time, so a relay retry of the same paid search runs it again and bills it again. Reads carry no receipt. | Low (the relay was not seen retrying) | Open |

## MEMORY

### Read: retrieval into a turn, and the "used memory" receipt

**What works.** A turn reads memory only when all of these hold: the account's
switch is on, the chat is not set to memory off, the project's assistant
permits recall, and the agent's grant allows it
(`src/lib/chat/turn/memory.ts:43-70`, with the rule in
`src/lib/memory-scope.ts` `turnMayUseMemory`). The receipt is derived in
exactly one place (`answerMemory`, `src/lib/chat/memory-receipts.ts:30`), so
the chip and the "Memory updated" notice cannot disagree. Each is proven by:

- `tests/memory-scope-db.test.ts`: "no reader sees memory it was not granted" covers projects, shared-project members and agents, against Postgres.
- `tests/memory-persistence-db.test.ts`: "learn → correct → recall → forget → reload" includes "B never reads A's facts".
- `tests/chat-memory-sources.test.ts`: 14 receipt and label cases. Run it without `--conditions=react-server`; under that condition the file fails to load, and that is environmental.

**Defect 6 (open).** `src/lib/chat/turn/memory.ts:53-60`: when
`conversation.agentId` names a soft-deleted agent, the lookup
(`deletedAt: null`) returns null, so `agentAccess` is null. The turn then reads
memory like an ordinary chat. A thread whose agent had `profile` or `none`
access gets full memory once the agent is deleted. This is fail-open. Whether
a deleted agent's thread should simply become an ordinary chat is a product
decision. To repro: create an agent with `memoryAccess: "none"`, start a thread
with it, soft-delete the agent, and send a message. The turn's
`memoryProfile.used` is non-empty.

### Write: extraction after a turn, and explicit "remember this"

**What works.** Tags in the model's reply are refused on any turn that carried
untrusted content (`src/lib/chat/turn/run-turn.ts`, the
`!untrustedContentInTurn && !untrustedToolResult` guard). Every save goes
through the block-list, the sensitive-subject gate and the secret screen
(`saveCandidates`). Proven by `tests/memory-sensitive.test.ts`,
`tests/memory-secret-screen.test.ts` and `tests/chat-memory-sources-db.test.ts`
("the receipt names the saved rows").

**Defect 1 (fixed).** `extractConversationMemory` (`src/lib/memory.ts`) took a
snapshot of the chat, waited seconds on the extraction model, and then saved
unconditionally. Each of these, done during that wait, was undone moments
later:

- deleting the chat: the facts were saved, then the read-mark upsert threw on the missing chat;
- memory off for the chat (`setConversationMemoryOff`);
- pausing memory for the account;
- `DELETE /api/memory` (reset): the facts came back, and `markProcessed` rewound the reset's read mark;
- `DELETE /api/memory?projectId=`: the cleared project learned the facts again;
- moving the chat out of its project: the facts landed in the scope it had left.

This is the moment that matters most. Someone who regrets what they just said
acts straight after the answer, which is exactly when the after-turn reader is
running. The fix is in `mayStillLearn`, `src/lib/memory.ts:1608`, called at
`:1718` after each model call and before any write. It re-reads the chat, the
account switch and the read mark. The read mark is what detects resets and
clears: they move it, and only this reader's own `markProcessed` may.

The proof is `tests/memory-extraction-race-db.test.ts`, which has a control
case and the six scenarios above. The six failed before the fix and all seven
pass now.

### Undo of a just-saved memory

**What works.** Undo retires the fact and block-lists it, and it brings back
what the fact replaced only while the fact is still the one believed. Pressing
Undo twice after a reload writes nothing more. Proven by
`tests/chat-memory-sources-db.test.ts`: "Undo forgets them once", and "Undo on
a fact that replaced another brings the older one back; Forget does not". The
same file covers the stale-receipt case.

**Defect 3 (open).** The receipt's `saved` list includes facts that were
*believed again* (reinstated, `src/lib/memory.ts:1082`), alongside new ones
(`:1116`). `PATCH /api/memory/[id]` with `{forget, undo}` treats both the same
way: it suppresses the row and writes a block-list entry
(`src/app/api/memory/[id]/route.ts:160-190`).

To repro: save "lives in Lisbon", then "lives in Porto", then "lives in Lisbon"
again. The third turn's receipt lists the Lisbon row. Press Undo. Before that
turn, Lisbon was a superseded history row and could be learned again. After
Undo, it is "You asked Alevr to forget this" and "The user lives in Lisbon" is
block-listed for good.

A correct fix has to tell the route which rows the turn reinstated, by adding
a flag to the receipt and to `readMemoryWrite`. A reinstated row's Undo should
then return it to `superseded`, without a block-list entry. That changes the
client and stored-receipt contract, so it was left for review.

### Deletion: one memory, clear all, per-project clear, per-chat memory off, incognito

**What works.**

- Delete and forget of one memory remove every trace and bench stale summaries: `tests/memory-transparency-db.test.ts` ("deleting a fact or a chat leaves nothing of it behind") and `tests/memory-persistence-db.test.ts` ("every delete and rewrite path takes a summary that quotes the old fact out of service").
- Reset marks every chat read, so old chats are not relearned. The same suites cover it.
- Per-project clear touches only that person and that project: `tests/memory-clear-project-db.test.ts`.
- Per-chat memory off is honoured by every background reader: `tests/chat-memory-off-background.test.ts` and `tests/chat-memory-off*.test.ts`.
- Incognito turns run with `memoryEnabled: false` and never save (`src/lib/chat/turn/private-turn.ts:154`).

**Defect 2 (fixed).** `DELETE /api/memory?projectId=`
(`src/app/api/memory/route.ts:72-95`) deleted the facts and summary but not
`MemoryEdit` rows. The account reset deletes the whole ledger, and its own
comment says why. The fix is `editTouchesProject`
(`src/app/api/memory/edits/ledger.ts`). It drops exactly the edits whose
operations or Undo are scoped to the project or name one of its rows. Account
edits and other projects' edits stay. Proven by the new case in
`tests/memory-clear-project-db.test.ts`: it failed before the fix and passes
now.

**Defect 7 (open).** `src/app/api/memory/route.ts:126`: the account reset's
`conversationMemory.createMany` runs outside the transaction and without
`skipDuplicates`. A first extraction that creates the row in between makes the
route return 500 after the erase has committed, so the page says the reset
failed when it succeeded. The fix is `skipDuplicates: true`, as the project
branch already has.

### Data boundaries

Every read is keyed by `userId` at the query (`getMemoryProfile`, and every
route's `where`). Project isolation holds in SQL and in ranking. Proven by
`tests/memory-scope-db.test.ts` and `tests/memory-persistence-db.test.ts`.
Defect 1's "moved chat" case was the one write path that could still put a
chat's facts in a scope it had left.

## TOOL CALLS

### Approval: cards, digests, expiry, always-allow ceilings

**What works.**

- The receipt digest binds the arguments, the policy and the binding window.
- A decision must present the digest (`decideActionApproval`).
- Allow is spent atomically and once, immediately before the network sink.
- A policy change between Allow and spend supersedes the approval (`src/lib/action-approval-store.ts`, `authorizeExternalAction`).
- Standing grants are capped at `reversible_write` and re-checked against the *current* classification (`findStandingGrant`).
- Unattended callers are refused instead of waiting.

These are proven by `tests/action-approval.test.ts`,
`tests/action-approval-enforcement.test.ts`,
`tests/approval-grants-route.test.ts`, `tests/runtime-spec-broker.test.ts` and
`tests/tool-broker-runtime.test.ts`.

**Minor (not ranked).** Answering a card whose reply was stopped (the receipt
is `superseded`) returns "This request has already been answered."
(`action-approval-store.ts:569`). The request was not answered, it was
stopped. This is a copy issue only, because the chat's card already shows the
call as stopped.

### Execution, failure, typed outcomes

**What works.** One dispatcher (`src/lib/tools/dispatch.ts`) answers every
call with a typed outcome: `succeeded`, `failed`, `denied`, `expired`,
`cancelled` or `outcome_unknown`. The tool's timer starts only after
authorisation, so an approval wait is never cut short. Invalid JSON and
unknown tools are answered instead of run. Results are bounded. A connector
that answers `isError` is recorded as a failure. Proven by
`tests/tool-dispatch.test.ts`, `tests/tool-dispatch-adversarial.test.ts`,
`tests/tool-receipt.test.ts` and `tests/mcp-toolset-status.test.ts`.

**Defect 4 (open).** At `dispatch.ts:636-650`, the brokered path completes the
receipt in a `finally` with `ok: outcome?.status === "succeeded"` and
`result: outcome?.text ?? ""`. On a Stop or timeout mid-run, `outcome` is
undefined, so the receipt becomes `failed` with an empty result. Two things go
wrong:

- the approvals history says the action failed when it may have taken effect;
- a replay of that receipt returns `""` as a failed result, because `""` is not nullish at `action-approval-store.ts:452`.

`mcp.ts` has the same shape for connector calls: on abort it marks the receipt
`failed` with the abort message. A fix wants an outcome-unknown receipt state,
or at least the timeout/cancel text as the result.

**Defect 5 (open).** At `dispatch.ts:554` and `mcp.ts:817`, the audit row is
created with `status: "executed"` before authorisation. If
`authorizeExternalAction` throws (for example, a database error), the row is
never settled and claims a call ran that never left Alevr.

### Cancellation: Stop during a call, an approval left unanswered

**What works.**

- Stop answers every unfinished call `cancelled` before the abort surfaces.
- A write stopped mid-run is told to the model as "may have taken effect".
- A pending approval is superseded when the turn stops, and expires after 15 minutes.
- The stall watchdog is paused while a person decides (`createApprovalRequester`).
- A reload turns any non-terminal row into `cancelled` (`readToolCallRecord`).

Proven by `tests/tool-dispatch.test.ts`, `tests/chat-stop-generation.test.ts`,
`tests/chat-cross-process-stop.integration.test.ts` and
`tests/chat-stall.test.ts`.

### Retries and reconnects: never twice, never billed twice

**What works.**

- The broker key is (generation, call id), so a replayed call returns its stored outcome.
- The pre-stream retry fires only when the stream yielded nothing (`countingStream`, `pre-stream-retry.ts`), so no tool can have run.
- A reconnecting client resumes from the frame log rather than posting again (`send-retry.ts`).
- The durable first-submission receipt makes a repeated first POST recover instead of running a second turn.
- The per-turn duplicate cache serves repeats of succeeded calls without running or billing them. A write clears it, so "list, create, list" lists again.
- Tool fees are written once (`ToolFeeAccumulator.claimWrite`).

Proven by `tests/chat-pre-stream-retry.test.ts`,
`tests/chat-pre-stream-retry-wire.test.ts`, `tests/chat-send-retry.test.ts`,
`tests/tool-dispatch.test.ts` (cache) and `tests/tool-metering.test.ts`.

**Defect 8 (open, latent).** The id stamper exists three times:
`src/lib/tools/call-ids.ts`, `src/lib/llm/tool-round.ts:110` and
`src/lib/llm/openai-shared.ts:100`. The two adapter copies add a single
`#round.index` suffix and do not check it again. All of them read a
`seenCallIds` set that nothing writes (`dispatch.ts:135` only declares it).
Today, uniqueness rests on each adapter's local set. That holds because
`(round, index)` is unique within a stream, but the comments describe a
shared registry that does not exist.

**Defect 9 (open).** `runVoiceToolCall` (`src/lib/voice-tools-server.ts`)
opens a fresh dispatcher and fee accumulator for each POST. A paid search
carries no receipt, so a relay retry of the same `callId` runs it again and
bills it again (`:335`). No retry was found in the relay, so this is latent.

## How to run

```
# unit (plain tsx; chat-memory-sources fails to load under react-server)
./node_modules/.bin/tsx --test tests/chat-memory-sources.test.ts
NODE_OPTIONS=--conditions=react-server ./node_modules/.bin/tsx --test --experimental-test-module-mocks \
  tests/chat-memory-off-background.test.ts tests/chat-memory-off.test.ts tests/memory-forget.test.ts \
  tests/memory-scope.test.ts tests/memory-sensitive.test.ts tests/tool-dispatch.test.ts \
  tests/tool-dispatch-adversarial.test.ts tests/action-approval.test.ts tests/tool-receipt.test.ts \
  tests/chat-pre-stream-retry.test.ts
# database (a disposable loopback database)
MEMORY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/<db> npm run test:memory:db
```
