# Teach by demonstration

The person shows an agent a task once on its computer, and the agent turns that
into a reusable skill. Grok Bot has this; AUDIT.md §3 item 10 listed it as a gap.

**Off by default.** `AGENT_TEACH_ENABLED=1` turns it on, and only where agent
computers are on too (`COMPUTER_PROVIDER` set, `isAgentTeachConfigured()` in
`src/lib/env.ts`). With the switch off, the routes answer `teach_off` (404) before
reading anything, the overlay shows no teach controls, Hand back never loads the
teach module, and no test needs an env var.

## The flow

1. In the agent's computer overlay, **Show it how** takes control (the ordinary
   take over: VNC control password, the agent frozen, the takeover window and
   its heartbeats). Once the control stream is live the overlay asks the server
   to start recording. During an ordinary take over, **Record steps** does the same.
2. While it records, the overlay says so in words under the control sentence:
   "Recording your steps · 6 steps on shop.example.com", with **Stop**.
3. Recording ends on **Stop**, on **Hand back**, when the take over ends or is
   about to lapse, or at a cap.
4. After hand back the overlay shows **Turn this into a skill?** with the step
   count and site, and **Draft skill** / **Discard**.
5. **Draft skill** asks the account's background model for a draft from the
   redacted trace. The answer goes through the same gate a chat draft does
   (`admitSkillDraft`) and is shown as the ordinary skill draft card.
6. The card's **Review** opens the Teach page (`/skills/teach?draft=…`, through
   session storage, never the URL). The person edits it and saves. It becomes a
   normal versioned `WorkSkill`, **kept off** unless they confirm what it may
   use. Nothing runs on its own: every action a run takes later still goes
   through the existing approvals.

## Architecture

| Piece | File | Notes |
|---|---|---|
| Trace, redaction, caps, prompt (pure) | `src/lib/teach/demonstration.ts` | Client-safe, fully unit tested |
| In-memory recording state (pure) | `src/lib/teach/collector.ts` | Caps, screenshot gate |
| Rules and order of operations | `src/lib/teach/service.ts` | Dependencies injected; tested with fakes |
| Real wiring | `src/lib/teach/server.ts` | Prisma, field-crypto, computer store, model |
| CDP recorder | `src/lib/teach/recorder.ts` | Playwright `connectOverCDP` through the existing gate |
| Routes | `src/app/api/agents/[id]/computer/demonstration/route.ts`, `…/draft/route.ts` | GET status; POST start, stop, discard; POST draft |
| UI | `src/components/agents/computer-teach.tsx`, `agent-computer.tsx` | Existing buttons, the skill draft card |
| Table | `AgentDemonstration`, migration `20261031143217_agent_demonstration` | RLS enabled, `OWNER_COLUMN` |

### Recording

The recorder runs in the web process. It connects to the computer's CDP gate
(`deploy/agent-computers/cdp-gate.py`) with the same per-computer token the
agent's browser uses, read server-side from `(userId, agentId)`. Nothing changes
in the gate or the container. The gate takes one connection at a time, so:

- recording refuses to start while a task holds the computer's lease ("A task is
  using the computer"); a run waiting for a take over keeps its connection open;
- Hand back stops the recording first (`stopDemonstrationFirst` in
  `heartbeatComputerViewSession`, before `releaseTakeover`), so the recorder's
  connection is gone before the agent thaws;
- the recorder checks the take over every 2 seconds and stops when it changed
  hands, ended, or has less than 10 seconds left (`recordingStillHeld`). A
  lapsed window therefore ends the recording before the runner settles it.

For each tab it opens a CDP session and:

- adds `PAGE_CAPTURE_SCRIPT` to an **isolated world** (`juno-teach`) of every
  new document, and evaluates it in a new isolated world of the open one. The
  page's own scripts cannot see the script, call its binding (`Runtime.addBinding`
  with `executionContextName`), or change what it reads. Synthetic events are
  ignored (`event.isTrusted`);
- reads main-frame navigations from Playwright's `framenavigated`;
- every 20 s takes one JPEG screenshot (quality 40, 640 px wide) of the tab in
  front, only if that page said no sensitive field is focused or filled, and a
  check in the isolated world right before the capture agrees.

The recorder never clicks, types or navigates.

### The trace

`buildDemonstrationTrace` folds observations into steps:

- **navigate**: origin and path only. Query, fragment and credentials in the
  URL are dropped. Id-, token- and email-shaped path segments become `{id}` or
  `{email}`. Repeated navigations to the same page are one step.
- **click**: role, accessible name, and a stable selector (id, `data-testid`,
  `name`, `aria-label`, or a short `nth-of-type` path). Clicks that only focus a
  text field are dropped.
- **type**: the committed value (on `change`, never keystrokes), with a slot
  name for the drafter (`{{search}}`). Typing into the same field twice in a row
  keeps the last value.
- **submit**: the form or the button that sent it. The click on that button is
  folded into the submit.

### Redaction

A typed value is replaced by a placeholder (`{{password}}`, `{{one_time_code}}`,
`{{card_number}}`, `{{card_security_code}}`, `{{card_expiry}}`, `{{secret}}`)
when **any** layer says the field is sensitive:

1. The page script: `type=password`; autocomplete `current-password`,
   `new-password`, `one-time-code` or any `cc-*`; a name, id, aria-label,
   placeholder or label that reads as a password, code, card, CVV, PIN, SSN,
   IBAN, key or token; a value shaped like a card number (Luhn) or a key; or a
   value containing something typed into a sensitive field earlier on that page.
   For those it sends **no value at all**.
2. `readPageReport` drops the value of any report marked sensitive, whatever
   the page sent.
3. `fieldSensitivity` checks again on the server from the element's attributes
   and the value's shape, and `buildDemonstrationTrace` stores only the placeholder.
4. `readDemonstrationTrace` checks every stored value's shape again on read.
5. The model's draft is scrubbed for card- and key-shaped strings before the
   card shows it.

Screenshots follow the same rule: none while a sensitive field is focused or
holds a value, none for a page that has not reported yet.

### Storage

One `AgentDemonstration` row per recording, owner-scoped (`userId` in
`OWNER_COLUMN`, every query names `userId`, `agentId` and the row id):

- `trace`: `encryptField()` of the redacted trace JSON;
- `shots`: `encryptField()` of at most 8 screenshots;
- `status` (`recording`, `recorded`, `discarded`), `endReason`, `stepCount`,
  times.

A running recording is written down every 20 s, so a restart keeps what it had.
A `recording` row with no recorder behind it is settled on the next read as
`recorded` (or `discarded` when empty), with `endReason: "interrupted"`.
**Discard** erases `trace` and `shots`, not just hides them. Rows cascade with
the account and the agent.

### Drafting

`buildDemonstrationDraftPrompt` builds the two messages from the stored,
redacted trace alone. The trace lines go inside `<demonstration>` tags, and the
system prompt says they are data, not instructions. Redacted values are never
guessed or asked for in a step. Values that would change between runs become
inputs. Screenshots are **not** sent in this version: the utility model path is
text-only. They are kept for a vision drafting step later.

`admitDemonstrationDraft`:

- empties `tools` and `apps`, because a demonstration grants nothing;
- adds a server-written rule, "Only on shop.example.com. If the page is on
  another site, stop and ask the person.";
- marks the draft `fromOutsideContent`, because page text was in the prompt;
- keys it `demonstration:<id>`, so a second save lands on the first skill;
- runs `admitSkillDraft`: bounds, the skill scanner (a draft that says to skip
  approval is refused), and the teachable tool list.

The call is the account's background provider under its policy, billed to the
account and the agent (`runUtilityPrompt`), and rate limited (20 an hour).

### Caps

| Cap | Value |
|---|---|
| Duration | 10 minutes |
| Steps | 120 |
| Raw observations in memory | 1,000 |
| Report from the page | 8,000 characters |
| Typed value kept | 200 characters |
| Screenshots | 8, one per 20 s, at most 96 KB each |
| Trace text given to the model | 14,000 characters |

## Security properties and their tests

All in `tests/teach-demonstration.test.ts`.

| Property | Test |
|---|---|
| The trace builder turns a scripted CDP stream into the expected steps | (a) |
| URLs keep origin and path only; ids, emails and tokens in paths are replaced | (a) |
| Password, OTP, card and key values never reach the trace, the stored plaintext or the prompt | (b), (b, e) |
| A value the page should have withheld is dropped at the first read | (b) |
| A tampered stored trace is redacted again on read | (b) |
| The capture script ignores synthetic events and sends no value for sensitive fields | (b) |
| Step, duration, event and screenshot caps hold; screenshots wait for "no secret on screen" | (c) |
| Recording only during a take over this client holds, no task using the computer, account allowed | (d) |
| Another account or agent cannot read, draft or discard a recording | (d) |
| The browser connection closes before anything is written, and before Hand back releases | (d), (f) |
| The prompt is exactly the redacted trace's lines; the answer goes through the chat draft gate | (b, e) |
| A draft grants no tools or apps and carries the site rule | (b, e) |
| Off without `AGENT_TEACH_ENABLED=1` and computers; routes answer off first | (f) |

Nothing here weakens the take over, the approvals, ownership, the sandbox or
encryption. The gate, the container and the take over code paths are unchanged,
except that Hand back now stops a recording first.

## Owner setup

1. Agent computers must already work (ENABLE_COMPUTERS.md).
2. Apply the migration (`20261031143217_agent_demonstration`) with the usual
   deploy.
3. Set `AGENT_TEACH_ENABLED=1` in the server's environment and restart
   `juno-backend`. The Work runner needs nothing.
4. To turn it off, unset the variable and restart. Recorded rows stay
   encrypted and unread.

## Known limits and follow-ups

- Recording is not possible while a task holds the computer, including a run
  that asked the person to take over. Show it how is for an idle computer.
- Only the main frame is captured: clicks and typing inside iframes (some
  payment and sign-in widgets) are not recorded.
- A deploy or restart mid-recording keeps what was written at the last
  checkpoint (at most 20 s lost) and ends it as `interrupted`.
- Provenance: the saved skill records `taught.via = walkthrough` and
  `taught.key = demonstration:<id>`. A distinct `demonstration` origin would
  change the chat wire contract's `TaughtSource`, so it is left for later.
- Native apps: the routes are `planned` in the parity ledger. The overlay is web only.
