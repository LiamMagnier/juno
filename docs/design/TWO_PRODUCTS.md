# Two products — the Work merge, and what Chat and Code become

September 2026. Juno had three products; it has two. This document is the
decision, not a proposal: what moved, what it looks like, and why each choice
beat the one next to it. `FLAT_UI.md` is still the material law and
`PREMIUM_AUDIT.md` §3 still the composition law; this is the level above them —
what the product *is*.

## 1. What the references did

**Anthropic folded Cowork into Claude on 16 September 2026.** Three modes
became two: Chat and Code. The stated reason is the interesting part — a person
should not have to decide, before typing, whether their sentence belongs in a
conversation or in an agent workspace. Claude reads the ask and uses the
capability the ask needs. Projects, Skills and Connectors survived the move; the
*place* did not.

**ChatGPT Work** (July 2026) sits beside Chat and Codex: you give it an outcome,
it works for hours across your connected apps, and it returns finished
material — sheets, slides, docs — rather than a reply.

**Claude Code on the web** is a repository, a branch, a cloud environment and a
permission mode, then a prompt; the session persists when the tab closes; the
review is a diff with per-line comments that queue into the next message, and a
"Create PR" at the top of it. **Codex** adds one thing Juno should copy
outright: `Ask` and `Code` as two presses on the same composer.

## 2. The decision

**Work is not a place. It is what a conversation can do when the ask is big.**

Everything under `/work` is retired from the web. A delegated run is a
`WorkSession` pointed at a `Conversation`, drawn inside that conversation's
transcript, and listed in the Chat sidebar as an ordinary chat with a status.
`/api/work/**`, `src/lib/work/domain.ts` and `contracts/work/juno-work-v1.json`
do not move a line: the Mac and the iPhone keep the product they have.

**Code keeps its switcher and loses its list page.** It lands on a greeting and
a composer; its sessions live in the sidebar in date folds, one status glyph per
row. Layout from Claude, skin from Juno.

### 2.1 The pointer was already there

`WorkSession.conversationId` has existed, indexed and serialised to every
client, since Work shipped — and the web create route has no field for it, so
only the legacy `ScheduledTask` adopter ever wrote one. The merge is mostly that
pointer, written from the chat composer, plus subtraction.

The pattern it feeds is not new either. A deep-research run already lives inside
a `kind: "chat"` conversation: discovered by `?conversationId=`, drawn by a
live/terminal router, injected through `MessageList`'s one inline slot, armed
from the `+` menu and steered from the composer. Work is the same shape with a
different card. **Nothing here invents a mechanism the product has not already
shipped once.**

### 2.2 Three choices, and why

**A message becomes work by a toggle, never by a guess.** The `+` menu gains
"Do this as a task" beside Deep research, and an armed pill sits beside `+` the
way the research pill does. A second, quieter trigger reads the sentence —
`inference.ts` already scores a goal for the capabilities it implies — and
offers *one caption with one chip*: "Looks like this needs a spreadsheet and
Gmail. Run it as a task?" It never arms itself. The file's own asymmetry
argument is why: a wrong guess about a local capability blocks a person, and a
wrong guess here would spend an afternoon of the account's window on a question
that wanted a reply.
Suggesting is Claude's behaviour; deciding for the reader is not.

**"Needs you" is a fold, not a destination.** The rejected alternative was a
`/tasks` page — the inbox under a new name, which is the thing being removed.
The fold sits above Today, appears only when it is non-empty, and its header
filters the sidebar in place. Zero new destinations; the triage the inbox did
survives as a filter rather than as a product.

**Code gets a Customize page, Chat does not.** Code has genuinely page-sized
configuration — environments, repositories and Mac workspaces, the default
permission mode. Chat's equivalents are already destinations (Projects,
Connections) or settings.

## 3. What a person sees

**Chat sidebar.** Brand row · Chat|Code pill · New chat · Library · Projects ·
Artifacts · Design · More (Assistants, Connections, Skills, Automations,
Permissions, Archived) · then the folds: **Needs you** (when non-empty), Pinned,
Today, Yesterday, Previous 7 days, Older. A conversation carrying a live or
waiting run swaps its hollow bullet for a toned status dot — state, not
decoration, and the one trailing mark that row is allowed.

**Chat composer.** Unchanged at rest: `+`, the model chip with thinking inside
it, dictate, send. Armed, a "Task · asks before risky steps" pill appears beside
`+` and one disclosure line sits under the field — where it runs, how often it
asks, what stops it — computed by the same function the dispatch route runs, so
the sentence read is the sentence acted on.

**A run in the transcript.** Live: what it is doing now, the plan with its
tally, one line of facts (spend against what the window had left when the run
started, time working — numbers, never meters), the run's own words, and the
block that needs a person —
questions with one-press options, approvals with Deny first. Terminal: the
outcome, the deliverables, the receipt. Every piece already exists under
`src/components/work/`; this is a new arrangement of shipped components, not new
components.

**Code landing.** A serif greeting and a composer pinned at the bottom:
environment and repository chips above the field, `+` · mic · permission mode on
the left below it, model · effort · status on the right. The "Runs" header, the
`Runs | Pull requests` tabs, the search field, the `All | Cloud | My Macs`
filter and the "Wrapped up" fold are gone. The old page argued that landing on a
composer hides the run that stopped to ask you a question; the sidebar answers
that better than a list did — that run is the first row, in every view, on every
page.

## 4. The run ceiling, reversed

This document said, above, that a raised run ceiling was a pricing decision and
that ceilings should become plan-shaped. The owner's call overrode it: **there
is no per-run ceiling.** A run goes until the work is done or until the
account's rolling 5-hour window or weekly window is used up — the model Claude
and ChatGPT use.

The argument the plan-shaped table made for itself was that a per-run ceiling
and a monthly one answer different questions: the monthly figure is what an
account may spend, and the per-run figure is how much of it one unattended loop
may take before somebody is asked. The question is real. The windows answer it
better, and for two reasons.

**A window bounds the thing the table was afraid of, without bounding the thing
it was not.** Five hours of spend is a hard stop on a loop that goes in circles.
It is not a stop on a task that genuinely needs thirty minutes — which is what
PRO's twenty-minute clock was, every day, while the month sat barely touched.
The table's common failure was the opposite of the one it was written against.

**It is the account's number, not the task's.** A run is never cut short while
the account still has room, and when it is cut short the honest sentence is a
wait rather than a purchase: *your 5-hour limit frees up at 14:00*, not *you are
over a ceiling*.

What this cost is the half that was not deletion, and it was the load-bearing
half. The windows were meters — `getUsageWindows` derived them and only the
usage page and the settings gauge read them. They enforce now: at admission,
beside the monthly gate that remains the outer bound, and again while a run
works, because the window moves under a run that started at 09:00. The cost axis
of the executor's guard stays wired, to the window's remainder rather than to a
constant, since a guard with every axis at zero cannot stop a runaway loop at
all. Tokens and running time carry no ceiling at all any more.

`docs/JUNO.md` §9b.1 is what this means in the code.

## 5. What is deliberately not done

- **No new `Conversation.kind`.** A Work conversation is `kind: "chat"`. The
  phone drops kinds it does not know, and a run is not a different kind of
  conversation — it is a conversation with a run in it.
- **No `/tasks` page.** See §2.2.
