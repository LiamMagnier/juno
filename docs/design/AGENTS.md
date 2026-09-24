# Agents — an audit of Grok Bot, Meta Muse and their peers, and what Juno builds

September 2026. Two products shipped a month apart and moved the whole category:
**Grok Bot** (SpaceXAI, 11 August 2026) and **Meta Muse** (8 September 2026).
Both are the same idea — *a named agent that lives somewhere, has its own
computer, keeps working when you leave, and comes back only when it needs you*
— sold to two different people. This document is the audit (what they actually
do, where they fail), the gap analysis against what Juno already runs, the
decision, and the specification the website, the Mac and the iPhone were built
from. `FLAT_UI.md` is still the material law, `ICONS_AND_MOTION.md` the motion
law, `PREMIUM_AUDIT.md` §3 the composition law, and `TWO_PRODUCTS.md` the level
above them all; this document sits beside the last one and does not overrule it.

Sources are listed at the end. The vendors' own pages (x.ai, about.fb.com,
ai.meta.com) could not be fetched from the build environment, so every claim
below is cross-checked against at least two secondary write-ups (reviews,
tutorials, docs mirrors) and the ones that could not be are marked *reported*.

---

## 1. What the references do

### 1.1 Grok Bot (SpaceXAI)

**The unit is a Bot: a named, persistent teammate.** Not a chat session that is
thrown away — an entity with a name, an avatar, memory, tools, skills and a
screen of its own, that you delegate to the way you would to a coworker. The
design team's test for every decision was *"did this help someone delegate, or
did it give them one more thing to manage?"* — and by the end much of the work
was **taking things away**: window and panel controls, computer-view options and
agent metadata were all removed.

**Five objects.** Bots, Chats, Prompts, Tools, Artifacts. Everything else in the
product is one of those.

**The computer.** One persistent cloud machine per *account* (Debian 13, eight
cores, 16 GB, 128 GB disk) with a browser, files and a terminal that keeps
running after the laptop closes. Every Bot gets its own *screen* on it and runs
one computer-use task at a time; you can open a Bot's screen in a 1:1 chat and
take over when a site needs a login. Crucially, **the Bots share the machine,
its cookies, its saved logins and its files** — xAI's own docs say not to treat
separate Bots as a security boundary, and deleting a Bot does not necessarily
remove what it left on the machine.

**Talking to it.** Type, dictate, or start a voice chat when the composer is
empty. 1:1 chats and **group chats**: several Bots in one room divide a job,
assign ownership, message each other and pull the person back in for judgment
calls. A Bot answers in prose when prose fits and in **structured cards** when
it does not — a five-day forecast is a card, not a paragraph — and its own
actions (changing a setting, messaging another Bot) land in the transcript as
**objects you can open**, not as sentences about them.

**Skills and routines.** A skill is reusable instructions: steps, decision
rules, expected output, safety boundaries. A routine tells one Bot *when* to run
a workflow — on a clock or after an event; up to 50 per Bot, the last 20 runs
kept. The recommended progression is *one good run → skill → routine*. Where it
has rolled out, a Bot can **watch up to ten minutes of you using the browser**
and draft a skill from it.

**Approvals.** Allow once, deny, or turn it into a narrow always-allow rule.
Categories that can require approval: sending messages, publishing, deleting
data, purchasing, changing production systems, permission changes, accepting
legal terms.

**The avatar is the status bar.** Simple shapes and **expressive rounded-square
eyes**, all generated in code, so a roster can be scanned peripherally without
reading names. The same face carries state: *at rest, calm and slightly
curious; when work arrives it acknowledges the task; as work begins it kicks
into gear; it changes again when waiting or needing help, and settles once the
work is done* — idle, thinking, working, waiting, blocked, done. Community
ports of the component count ~25 expressions over 18 shapes.

**Surfaces.** Desktop apps (macOS, Windows, Linux), companion apps on iOS and
Android. Not to be confused with **@grok on X**, which is Grok answering inside
a post when tagged, using the post as context — a reply bot, not an agent — or
with **Grok Companions** (Ani, Rudi, Valentine, Mika), the 3D animated
characters with an affection system that xAI retired on 7 September 2026. The
companions are worth one lesson: character without a job did not survive, and
the character that did survive is the one attached to work.

**Where it fails.** (1) The shared computer is a single point of failure: the
20–21 August incident stuck one machine and every Bot on the account stopped at
once. (2) The shared machine is a single *trust* domain: every credential on it
is reachable by every Bot, including Bots created later. (3) Quota burn —
reviewers published one six-Bot setup spending 42% of a weekly allowance on day
one. (4) An approval cannot reverse work already done; the audit view was listed
as "coming"; no compliance attestations.

### 1.2 Meta Muse

**The unit is one personal agent for everyone.** Consumer errands, not a team:
booking the date night, packing schedules, buying the tickets, filling in the
field-trip permission slip. Free, $20 and $100 tiers; web (muse.ai), iOS,
Android and WhatsApp at launch, glasses later.

**The computer.** *Muse Secure VM* — a dedicated cloud computer **per person**
with storage, memory, a real Chromium browser, a filesystem and background
jobs, contained so no one else's agent can reach it. You can watch the browser
and take over at any time.

**Sentinel.** A separate agent on the same machine, isolated from Muse at the
system level, through which **all egress** passes: nothing Muse does reaches the
internet unless Sentinel approves it, and when Sentinel decides to ask, the
dialog goes **straight to the client UI, not through the conversation** — a
deterministic approval card, never model prose. Credentials live in a vault the
agent uses without seeing, including passwords you type into its browser
yourself. Defence in depth: a runtime cell, privilege separation over which
code sees which credential, an ACL daemon, and Sentinel over every action.

**The interface is a messaging app with shelves.** Reviewers list the same
sections: **Goals** (objectives by category), **Artifacts** (itineraries, live
dashboards, media it made), an **Activity log**, an **Approvals queue**,
**Upcoming** (recurring work), **Ideas** (proactive suggestions from goals,
patterns and prior conversations), and **Identity** — what Muse has stored about
you, which you can inspect, edit and download. It keeps working after the app is
closed, responds to schedules and events, and **decides whether a result
warrants a notification**.

**Character.** You choose its avatar, name and communication style. The
animated avatar replaces the spinner: it picks up **a tiny laptop** while it
completes tasks and **an orb** while it makes media, so its state reads at a
glance. Meta's stated reason — a long-running relationship with a corporate
logo felt odd — is the same reason Grok gave its Bots eyes.

**Guidance.** More guided than ChatGPT or Gemini's blank canvas: tips during
onboarding, suggestions in Ideas, and a setup that is honest about being a set
of decisions about what the agent may do on your behalf.

**Where it fails.** (1) Trust: one survey put trust in Meta with passwords at
8%, and 58% would give no AI agent their passwords at all. (2) Reliability:
wrong colourway on a shoe order, the wrong film on a ticket purchase, delivery
dates quoted six days late; employees reported login churn before launch. (3)
Sites refuse agents. (4) It aims at jobs existing apps already do well —
booking an Airbnb through a wall of text is worse than opening Airbnb.

### 1.3 The rest of the field

- **ChatGPT agent / ChatGPT Work** — a virtual computer in OpenAI's cloud with a
  browser, a terminal and connectors (Gmail, Drive); a takeover mode for logins;
  Work returns finished sheets, slides and docs after hours of work.
- **Manus, Genspark** — autonomous sandboxes (browser, terminal, filesystem)
  aimed at deliverables rather than errands.
- **Google Gemini Agent** — the closest like-for-like to Muse for a general
  personal assistant.
- **Claude** — Cowork folded into Chat and Code on 16 September 2026; the ask
  decides whether it becomes work (`TWO_PRODUCTS.md` §1).

### 1.4 What they agree on

1. **Identity is the product.** A name, a face, a memory and a history. An agent
   you cannot tell apart from the last one is a session.
2. **Its own computer.** A browser it drives, code it runs, files it keeps.
3. **It keeps going without you** — on a clock, on an event, or because a goal
   is still open — and comes back **only** when it needs a decision.
4. **Approval is deterministic UI**, never prose: allow once, deny, always allow
   — and a floor of actions nothing can silence.
5. **State is shown, not spun.** The avatar is the progress indicator.
6. **Goals, routines and ideas** make it proactive; **activity and memory** make
   it inspectable.

### 1.5 What they got wrong, which Juno must not copy

1. A shared machine across agents (Grok) is one trust domain and one failure
   domain. Isolation per run is not a luxury.
2. An approval that goes through the conversation can be talked around. Muse got
   this right; the card is the gate, not the chat.
3. Quota burn from agents that loop. Budget has to bind every autonomous run.
4. "Audit view coming" — an agent that acts without a readable log is a liability.
5. Character without a job (Companions) does not last.

---

## 2. The audit: what Juno already runs

Juno is closer to both products than either launch post would suggest. Almost
all of the *runtime* exists and is stricter than theirs; what is missing is the
**identity layer** that turns runs into a teammate.

| Capability | Grok Bot | Muse | Juno today | Where |
| --- | --- | --- | --- | --- |
| Own cloud computer | shared VM per account | VM per person | **per-run** cloud executor: a real headless Chromium behind a DNS-pinned, intercept-and-fulfil leash, `web_search`/`web_fetch`, cloud files and deliverables. **No shell in the cloud** — `workspaceTools()` is filtered out and `scripts/check-work-sandbox.mjs` enforces it | `src/lib/work/browser.ts`, `scripts/work-runner.ts`, `runner/agent-core` |
| Your own Mac as a computer | — | — | a paired Mac runs Work locally: files, a shell, the signed-in browser, computer use — the machine a person already trusts | `WorkHost`, `native/Packages/JunoWork`, §9b |
| Plans a job, works it for hours | yes | yes | plan state machine, stall/repetition policing, structural validation | §9b.2 |
| Stops to ask | approvals | Sentinel cards | questions + approvals with action/policy digests, expiry, always-allow ceilings | §9b.3 |
| A floor nothing silences | sends, publishes, purchases… | Sentinel | `ALWAYS_CONFIRM_ACTIONS`, `irreversible`/`sensitive` risk | `src/lib/work/domain.ts` |
| Skills | yes (+ watch-me) | — | versioned skills, from repos, with resources | §9b.5–6 |
| Routines | 50/bot, clock + event | Upcoming | Automations: clocks, events, API trigger, missed-run policy | `WorkSchedule`, §14 |
| Delegation to a sub-agent | group chats | — | `delegate` child agent on the same budget | §9b |
| Connectors | connectors/MCP | 6 categories | MCP + Composio + native connectors | §8 |
| Memory you can inspect | — | Identity | Memory page, edit, export, sensitive-topic guard | §7 |
| Voice | voice chat | yes | realtime speech-to-speech relay | §10 |
| Budget that binds autonomy | weekly quota | tiers | 5-hour + weekly windows enforced at admission and mid-run | §9b.1 |
| Comes back to you | push | push, decides if a result is worth it | **email** per the routine's notify policy; push and in-app notifications are not wired (`createNotification` has no caller, the apps never register APNs) | `src/lib/work/notify/` |
| **A named, persistent agent** | **yes** | **yes** | **no** — assistants are prompt personas, runs are anonymous | — |
| **An avatar that shows state** | **yes** | **yes** | **no** | — |
| **Goals the agent pursues** | via chat | Goals | **no** | — |
| **Proactive ideas / check-ins** | — | Ideas | **no** | — |
| **One place per agent: now, goals, routines, log, rules, memory** | Bot page | shelves | **no** — the pieces exist per task, not per agent | — |
| **Agent-scoped memory** | yes | Identity | **no** — account memory only | — |

The last six rows are the build.

---

## 3. The decision

**An agent is a teammate that lives in Chat.** It is not a third product and it
does not reopen `TWO_PRODUCTS.md`: a conversation still decides when an ask
becomes work, and an agent is *who* that work is delegated to. What an agent
adds is a name, a face, a standing brief, goals, routines, rules and a memory of
its own — and one page that answers "what is it doing, and does it need me?"

- **Its thread is an ordinary chat.** `Conversation.agentId` points at the
  agent; `kind` stays `"chat"` (`TWO_PRODUCTS.md` §5 — no new kind, because
  the phone drops kinds it does not know). Everything a chat does, the thread
  does: attachments, connectors, voice, canvas, and the in-chat task panel.
- **It works through Work.** The agent hands a job to `start_task` exactly as
  Chat does; the task is a `WorkSession` stamped with `agentId`, under the
  agent's autonomy and connectors, narrowed — never widened — by every layer
  that already narrows (§9b.5). No second runtime, no second approval system,
  no second budget.
- **Its computer is a clean one, every run.** Juno does not copy Grok's shared
  machine. Each run gets its own executor; nothing one agent's run signed into
  is visible to another's; the browser holds no Juno credential. The agent's
  continuity lives in its memory, its goals and its thread — things a person
  can read — not in a cookie jar nobody can.
- **Approvals are cards, never prose** (Muse's Sentinel lesson). The floor —
  send, publish, pay, delete, account and security settings — asks under every
  autonomy level, and the agent's page says so beside the control.
- **Budget binds it** like any run: the account's 5-hour and weekly windows.
  An agent cannot outspend its owner's window, and no routine adds a ceiling of
  its own (`TWO_PRODUCTS.md` §4).
- **Proactivity is bounded.** An agent reflects at most every six hours (or
  when asked), writes *ideas* and *goal check-ins*, and never starts work from
  a reflection: an idea is a card with **Start** on it. Reflection runs on the
  account's own background provider under the same policy titles and memory
  use (`runUtilityPrompt`), and it is billed as utility work.

### 3.1 Where it appears

- **Sidebar.** One destination row, **Agents**, after Design. Below the
  destinations, an **Agents** fold (like Pinned projects) lists each agent with
  its live mini-face — peripheral recognition, Grok's point — and the one
  trailing signal a row may carry: a toned dot when that agent needs you.
- **`/agents`** — the roster. A card per agent: face, name, role, and one
  sentence of state ("Working on *Competitor pricing*", "Needs you — approve
  sending an email", "Next: Monday 09:00 — Weekly digest"). A **New agent**
  card. Nothing else.
- **`/agents/new`** — hiring, in four steps (§5.1).
- **`/agents/[id]`** — the agent's page: the face at size, name, role, state
  sentence, **Message** as the one primary action, and five tabs — **Now,
  Goals, Routines, Activity, Profile**.
- **`/chat/[conversationId]`** — the agent's thread. The chat view gains one
  row above the transcript: the face, the name, the state, a link to the page.
- **Mac and iPhone.** An **Agents** row in the Mac's Chat sidebar (after
  Artifacts) and an Agents entry in the phone's drawer (after Work): the
  roster, the agent page with the same five tabs, hiring as a sheet, and the
  same face drawn natively from the same numbers (`JunoAgentFace.swift`).
  Message opens the agent's thread in the app's own chat. A question or an
  approval is answered in the thread, where the existing Work cards live.

---

## 4. The face

Grok's insight is the right one — the face is the status bar — and Muse's is
the other half: a prop says *what kind* of work. Juno's face is built from
Juno's own vocabulary so it looks like it belongs here, not like a borrowed
mascot.

### 4.1 Construction (all code, no images)

A 64-unit square. **Body**: one of six shapes — `orb` (circle), `pebble`
(superellipse), `capsule` (tall stadium), `petal` (rounded teardrop), `bloom`
(four-lobed soft square), `spark` (Juno's four-point spark with fat concave
sides, so it still reads as a body). **Tone**: one of six, the same six hues as
the account accents — `coral`, `juniper`, `teal`, `violet`, `amber`, `sage` —
declared as `--agent-*` tokens in `globals.css` (both themes) and projected to
Swift by `npm run design:tokens`, so the Mac draws the same colour the web does.
**Eyes**: one of four resting cuts — `soft` (rounded squares, Grok's lineage),
`round` (dots), `tall` (upright pills), `wide` (landscape pills). **Mark**: an
optional accessory from Juno's own marks — `none`, `ring` (the open ring with
its ball terminal, as a halo), `spark` (a small spark at the crown), `leaf`,
`antenna` (a stem and ball), `visor`. Everything is deterministic from
`{shape, tone, eyes, mark}`, stored on the agent, and a new agent's default is
derived from its id so two agents never start identical.

### 4.2 States

| State | Means | Eyes | Body | Loop |
| --- | --- | --- | --- | --- |
| `idle` | nothing live | resting cut, open | still | **none** — nothing idle loops (`ICONS_AND_MOTION.md` §2.2 rule 9); a blink plays only on hover |
| `thinking` | a reply is streaming | narrowed, glance up-right | still | the three-dot orbit beside the body — the `ThinkingDots` rhythm |
| `working` | a task is running | focused (slightly flattened), tracking left↔right | a 1.5% breathe | yes; plus the **work prop**: a tiny laptop (Muse's) when the task uses the browser or files, the orb when it makes media |
| `waiting` | a question or approval is open | wide, looking at the reader | still | a slow attention lift, every 2.4s — the only state that asks for you |
| `blocked` | the last run failed or ran out of window | flat lines | still | none |
| `done` | a run finished in the last 15 min | happy arcs (`^ ^`) | a one-shot settle (spring overshoot) | none |
| `sleeping` | the agent is paused | closed lines | still | none |
| `listening` | voice is open | wide, pupils scale with input level | still | driven by audio, not a timer |

Transitions between states **cross-fade** the eye shapes (opacity + 0.8→1
scale, `duration-fast`), the one gesture `ICONS_AND_MOTION.md` §2.2 rule 7
allows for a state swap; only `transform` and `opacity` animate (rule 8).
Under reduced motion every loop stops, the state still reads from the eyes'
*shape*, and the cross-fade keeps its timing. The state is also always said in
words beside the face (aria-label and the state sentence) — the face is never
the only carrier.

### 4.2b The geometry, exactly

Both clients draw from these numbers in a 64×64 box; nothing is traced from a
picture, so the web and the Mac cannot drift by eye.

**Body** (fill `--agent-<tone>`):

| Shape | Drawing | Eye centres (L, R) · eye scale |
| --- | --- | --- |
| `orb` | circle, centre (32, 33), r 26 | (24, 31), (40, 31) · 1 |
| `pebble` | rounded rect (6, 9, 52, 48), corner 20 | (24, 32), (40, 32) · 1 |
| `capsule` | rounded rect (12, 5, 40, 56), corner 20 | (26, 29), (38, 29) · 0.9 |
| `petal` | `M8 9 H34 C48 9 58 21 58 35 C58 49 47 59 33 59 C19 59 8 48 8 34 Z` | (26, 34), (42, 34) · 1 |
| `bloom` | four circles r 15 at (22, 23), (42, 23), (22, 43), (42, 43) + rect (22, 23, 20, 20) | (25, 32), (39, 32) · 0.95 |
| `spark` | `M32 5 C36 22 42 28 59 33 C42 38 36 44 32 61 C28 44 22 38 5 33 C22 28 28 22 32 5 Z` | (27, 33), (37, 33) · 0.75 |

**Eyes** (fill `--agent-ink`), resting cut, width × height and corner radius
before the shape's eye scale: `soft` 7 × 9 r 2.5 · `round` 6.5 × 6.5 r 3.25 ·
`tall` 5 × 11 r 2.5 · `wide` 10 × 5.5 r 2.75. Each eye is centred on its
anchor.

**Eyes by state** (applied to the resting cut): `idle` as rested · `thinking`
height × 0.7, both eyes offset (+2, −2) · `working` height × 0.75 · `waiting`
width and height × 1.2 · `blocked` a flat bar: resting width × 1.3, height 2 ·
`sleeping` the same bar, offset (0, +2) · `listening`
× 1.15 · `done` a happy arc per eye, stroke 2.4, round caps: from
(cx − 4, cy + 1.5) through control (cx, cy − 3.5) to (cx + 4, cy + 1.5).

**Mark** (`--agent-mark`, which is the ink on paper and a warm off-white on charcoal, because a mark sits partly off the body with the page behind it): `ring` an open ring centred
(51, 12) r 5.5, stroke 2.2, open for 70° at the upper right, with a ball r 1.8 at
the gap's leading end · `spark` a four-point spark centred (51, 12), radius 7 ·
`leaf` `M44 18 C44 11 49 6 57 6 C57 13 52 18 44 18 Z` · `antenna` a stroke
(32, 8)→(32, 2.5) width 2, round cap, with a ball r 2.2 at (32, 2.5) ·
`visor` a rounded band behind the eyes spanning 7 units beyond each eye
horizontally and 6 above and below the eye line, fully rounded, `--agent-ink` at 18% (it sits on the body).

**Work prop** (`working` only, drawn at `md` and above): a tiny laptop — screen
rounded rect (46, 45, 12, 8) corner 1.5, stroke 1.6 `--agent-mark`, filled with the page
ground; base stroke (43.5, 55.5)→(60.5, 55.5), width 2, round caps. Muse's
idea, Juno's line weight.

**Thinking dots** (`thinking` only): three dots r 1.6 at (50, 12), (55, 12),
(60, 12), `--agent-mark`, each fading 0.3 → 1 → 0.3 over 1.2 s, staggered 0.2 s.

**Motion.** `working`: the eyes travel −2.5 → +2.5 → −2.5 on x over 2.4 s,
eased in-out, and the body breathes 1 → 1.015; `waiting`: the whole face lifts
0 → −1.5 → 0 over 2.4 s; `done`: a one-shot settle 0.94 → 1.03 → 1 on the
spring over the emphasis rung (560 ms); a state change cross-fades the eyes on
the fast rung (120 ms, 0.8 → 1). `idle` blinks (eyes scale y to 0.1 and back
in 180 ms) only when the pointer is over it. Reduced motion stops every loop
and the settle; the eyes' shape still carries the state.

### 4.3 Where each size is used

`xs` 20 (sidebar row), `sm` 28 (thread header, activity rows), `md` 48 (roster
card), `lg` 96 (agent page header, hire preview), `xl` 160 (hire arrival). The
mark and the prop are dropped below `sm`; the eyes never are.

---

## 5. What a person sees

### 5.1 Hiring an agent (`/agents/new`)

Four questions on one page, top to bottom, every answer staying on screen while
the next is given (Muse's guidance, without a wizard's modal chrome — a Writer
called Quill who may "just do it" is a combination to see whole before Hire).
Picking a starting point refills only the fields not yet touched:

1. **What should it take on?** Seven starting points, each a one-line promise
   with a sensible brief, autonomy and suggested connectors — *Chief of staff*
   (inbox, calendar, follow-ups), *Researcher* (reads widely, cites, reports),
   *Deal finder* (compares prices, watches for drops — asks before buying),
   *Trip planner*, *Writer* (drafts, never publishes without you), *Monitor*
   (watches pages and feeds, reports changes), and *Start from scratch*.
2. **Name and face.** A name field (suggestions per starting point), and the
   face builder: shape, tone, eyes, mark as four rows of swatches, with the live
   preview cycling through its states on hover so you see the character before
   you commit.
3. **How it works.** Communication style (`warm`, `direct`, `playful`,
   `formal`), the brief (pre-filled, editable), and autonomy — the three Work
   modes by their promise labels, with the floor listed underneath.
4. **A first goal** (optional) — one sentence the agent starts from.

**Hire** creates the agent, its thread and the goal; the face arrives on the
spring (`done` → `idle`) and the page lands on the agent.

### 5.2 The agent's page

Header: face (`lg`) with its live state, name, role, and the state sentence.
**Message** is the primary action; **Pause** / **Resume** beside it; *Think it
over now*, *Edit profile* and *Retire* in the overflow. On the first visit after
hiring, one line welcomes it and names its autonomy. Then the tabs:

- **Now** — the block that needs you first (open questions and approvals from
  its tasks, answerable in place with the existing Work cards — Deny first),
  then the task it is doing (title, plan tally, the step it is on, time working,
  *Open in chat*), then **Its computer** — the last things the run did in the
  browser, in files and in code, as a quiet feed of rows, never a fake
  screenshot — then **Ideas** (Start / Not now), then **Upcoming** (next routine
  fires).
- **Goals** — each goal with its status, cadence and last check-in; add, pause,
  achieve, drop; *Work on this* opens the thread with the goal as the message.
- **Routines** — the agent's automations with their next fire; *New routine*
  takes a name, the instructions and a cadence and creates a real
  `WorkSchedule` under the agent.
- **Activity** — one log for everything the agent did: tasks started, finished,
  stopped to ask; approvals given; goals set and checked in; ideas raised and
  taken; routines created; memory learned.
- **Profile** — name, role, face, style and brief; **Autonomy** with the floor
  spelled out; **Connected apps** it may use; **What it knows** — the agent's
  own memory, each note editable and deletable, with *Download*; and Delete.

### 5.3 The thread

The chat view, unchanged, with one header row: the face (`sm`, live), the name,
the state sentence, and *Agent page*. The empty thread greets in the agent's own
voice. A task the agent starts is drawn by `WorkRunPanel` exactly as today.

---

## 6. Data model

All additive — new tables and nullable columns only (§20.2b expand/contract).

- `Agent` — `userId`, `name`, `role`, `avatar` (JSON `{shape, tone, eyes,
  mark}`), `style`, `instructions`, `model?`, `reasoningEffort?`,
  `approvalMode` (a `WorkPermissionPolicy`), `connectorIds[]`, `projectId?`,
  `conversationId?` (its thread), `status` (`active | paused`), `proactive`,
  `template?`, `lastReflectedAt?`, `sortOrder`, timestamps, `deletedAt?`.
- `AgentGoal` — `title`, `detail`, `status` (`active | paused | achieved |
  dropped`), `cadence` (`none | daily | weekly`), `lastCheckInAt?`,
  `lastCheckInNote?`, `dueAt?`.
- `AgentIdea` — `title`, `detail`, `prompt`, `status` (`new | started |
  dismissed`), `goalId?`, `decidedAt?`; the task a started idea became is
  recorded on its `idea_started` event.
- `AgentNote` — the agent's own memory: `content`, `source` (`user | agent |
  reflection`), soft-deleted.
- `AgentEvent` — the activity log: `kind`, `title`, `detail` JSON,
  `sessionId?`, `createdAt`.
- `Conversation.agentId?` and `WorkSession.agentId?`, indexed.

## 7. API

Web and native share one surface, bearer- and cookie-authenticated through
`requireUser` like `/api/work/**`:

| Route | Does |
| --- | --- |
| `GET/POST /api/agents` | roster (with derived state) · hire |
| `GET/PATCH/DELETE /api/agents/[id]` | the page's payload · edit / pause · retire |
| `POST /api/agents/[id]/thread` | the agent's thread, created on first use |
| `GET/POST /api/agents/[id]/goals`, `PATCH/DELETE …/goals/[goalId]` | goals |
| `GET/POST /api/agents/[id]/routines` | routines (a `WorkSession` + `WorkSchedule` under the agent) |
| `GET /api/agents/[id]/activity` | the log |
| `GET/POST /api/agents/[id]/notes`, `PATCH/DELETE …/notes/[noteId]` | what it knows |
| `POST /api/agents/[id]/reflect` | ideas and check-ins, at most every 6 h unless `force` |
| `PATCH /api/agents/[id]/ideas/[ideaId]` | start / dismiss |
| `POST /api/agents/[id]/tasks` | start a task as the agent (409 `confirm_expensive` asks first) |

## 8. What is deliberately not done

- **No shared machine, no persistent cookie jar.** See §3. A person who wants an
  agent signed in as them pairs their Mac; that is a machine they already trust
  and can see.
- **No watch-me skill capture.** Screen-recording a person's browser into
  instructions is a privacy surface of its own; skills already come from a run
  (*save as skill*) and from repositories.
- **No agent-to-agent group rooms yet.** `delegate` already hands a piece of
  work to a child agent on the same budget; rooms where named agents assign each
  other work need a claim model the executor does not have. The data model
  leaves room for it (`AgentEvent.kind` is open).
- **No push yet.** An agent that needs you reaches you the way any Work run
  does today — the sidebar's Needs you fold, the toned dot on its face, the
  roster sorted waiting-first, and email under the routine's notify policy.
  Push and in-app notifications need the APNs registration the apps do not yet
  perform; that is its own piece of work, and it serves every run, not only
  an agent's.
- **No per-agent fold in the Mac sidebar yet.** The web draws each agent as a
  live face in the sidebar; the Mac has the destination row and the roster.
- **No companion mode.** No affection meters, no idle chatter. An agent speaks
  when it has done something or needs something.
- **No new `Conversation.kind`** and **no second runtime** (§3).

---

## Sources

- [Designing Grok Bot for a world of persistent agents — SpaceXAI](https://x.ai/news/designing-grok-bot)
- [Introducing Grok Bot — SpaceXAI](https://x.ai/news/introducing-grok-bot)
- [Grok Bot docs: overview · skills and routines · chat and collaboration · mobile · security FAQ](https://docs.x.ai/grok-bot/overview)
- [Grok Bot Tutorial: Skills, Routines, and Approvals — DataCamp](https://www.datacamp.com/tutorial/grok-bot-tutorial)
- [A deep dive into Grok Bot — Flavio Copes](https://flaviocopes.com/grok-bot/)
- [Grok Bot, Rounded Square Eyes — Design Compass](https://designcompass.org/en/2026/08/12/grok-bot-ai-teammate/)
- [Grok Bot Explained: xAI's Agent vs the @grok Chatbot — Layer3 Labs](https://www.layer3labs.io/guides/what-is-grok-bot)
- [Grok Bot Security, Explained — CellCog](https://cellcog.ai/blog/grok-bot-security/) · [Grok Bot Problems and Limitations — CellCog](https://cellcog.ai/blog/grok-bot-problems/)
- [Grok Companions Discontinued — Robo Rhythms](https://www.roborhythms.com/grok-companions-discontinued/)
- [Introducing Muse — Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) · [Muse — Meta AI](https://ai.meta.com/muse/) · [How We Designed Muse](https://introducing.muse.ai/)
- [How We Built Safety Into Muse — Meta AI Research](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
- [Meta debuts its Muse AI agent — TechCrunch](https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/) · [Meta's Muse agent, tested — CNN](https://www.cnn.com/2026/09/23/tech/meta-muse-ai-agent)
- [Muse review: the personal AI agent that gets consumer UX right — Lenny's Newsletter](https://www.lennysnewsletter.com/p/muse-review-the-personal-ai-agent)
- [Meta introduces Muse as a proactive personal agent — TestingCatalog](https://www.testingcatalog.com/meta-introduces-muse-as-a-proactive-personal-agent/)
- [Meta's Muse Has a Trust Problem — Forkast](https://forkast.news/metas-muse-has-a-trust-problem-that-no-secure-vm-can-fix/) · [Muse app review — Slate](https://slate.com/technology/2026/09/meta-muse-ai-app-review.html)
- [7 best Meta Muse alternatives — eesel AI](https://www.eesel.ai/blog/meta-muse-agent-alternatives)
