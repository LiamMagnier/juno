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
| Own cloud computer | shared VM per account | VM per person | **per-agent** persistent Docker desktop (`AgentComputer`, `juno-computer:1`: Xvfb + XFCE + Chromium + shell + `/home/agent/work` volume, isolated per agent on `172.30.0.0/24` with `--icc=false` and RFC1918 egress blocked) plus the temporary per-run cloud browser as fallback | `src/lib/computer/`, `deploy/agent-computers/`, `scripts/work-runner.ts` |
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
| Comes back to you | push | push, decides if a result is worth it | **in-app, Web Push, APNs and email** per `Agent.notify` (`needs_you | results | all`) | `src/lib/work/notify/` |
| **A named, persistent agent** | **yes** | **yes** | **yes** (`Agent`) | `src/lib/agents/` |
| **An avatar that shows state** | **yes** | **yes** | **yes** (`AgentFace`, `JunoAgentFace.swift`) | `src/components/agents/agent-face.tsx` |
| **Goals the agent pursues** | via chat | Goals | **yes** (`AgentGoal`) | `src/lib/agents/` |
| **Proactive ideas / check-ins** | — | Ideas | **yes** (`AgentIdea`, `reflectAgent`) | `src/lib/agents/reflect.ts` |
| **One place per agent: now, computer, setup** | Bot page | shelves | **yes** — thread-first split side panel (`Now · Computer · Setup`) | `src/components/agents/agent-panel.tsx` |
| **Agent-scoped memory** | yes | Identity | **yes** (`AgentNote`, encrypted at rest) | `src/lib/agents/store.ts` |

---

## 3. The decision

**An agent is a teammate that lives in Chat.** It is not a third product and it
does not reopen `TWO_PRODUCTS.md`: a conversation still decides when an ask
becomes work, and an agent is *who* that work is delegated to. What an agent
adds is a name, a face, a standing brief, goals, routines, rules, a memory of
its own, and an optional **dedicated cloud computer** — with its thread as the
home surface and a three-tab side panel (**Now · Computer · Setup**) beside it.

- **Its thread is an ordinary chat.** `Conversation.agentId` points at the
  agent; `kind` stays `"chat"` (`TWO_PRODUCTS.md` §5 — no new kind, because
  the phone drops kinds it does not know). Everything a chat does, the thread
  does: attachments, connectors, voice, canvas, self-configuration tools, and
  the in-chat task panel.
- **It works through Work.** The agent hands a job to `start_task` exactly as
  Chat does; the task is a `WorkSession` stamped with `agentId`, under the
  agent's autonomy and connectors, narrowed — never widened — by every layer
  that already narrows (§9b.5). No second runtime, no second approval system,
  no second budget.
- **Its computer is isolated per agent (`Agents v2`).** Reversing the v1
  stateless-only rule without copying Grok's shared account-wide VM: when the
  owner enables a computer for an agent (`AgentComputer`), that agent gets its
  own isolated Docker container (`juno-computer:1`) and persistent `/home/agent`
  volume (`juno-comp-<agentId>`). One agent's sign-ins, cookies and files are
  never shared with another agent's container (`--icc=false`). When a site needs
  a password, 2FA code, CAPTCHA or payment step, the agent calls `ask_user` and
  the owner takes over the live desktop (`noVNC` over the authenticated WebSocket
  relay) to type it directly, then hands control back.
- **Configuration by chat.** Five chat tools (`update_agent`,
  `manage_agent_goal`, `manage_agent_routine`, `manage_agent_note`,
  `manage_agent_computer`) let the owner configure the agent in conversation.
  Benign edits on trusted turns apply immediately with an inline **Undo** card
  (`agentChange`); privilege-escalating changes (widening autonomy, enabling the
  computer, adding connectors, or any tool call on an untrusted turn) require
  confirmation on the deterministic `ApprovalCard`.
- **Approvals are cards, never prose** (Muse's Sentinel lesson). The floor —
  send, publish, pay, delete, account and security settings — asks under every
  autonomy level, and the agent's panel says so beside the control.
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
  its live mini-face (`Pinned` first) and a raised hand glyph when that agent
  needs you. Clicking an agent opens its **thread** (`/chat/[conversationId]`).
- **`/agents`** — the compact roster list: face `sm` · name · `role · state
  sentence` · trailing hand icon when it needs you, plus **New agent**.
- **`/agents/new`** — chat-first hiring (`AgentStart`): pick a template chip or
  *Start from scratch* to create the agent and jump straight into its thread
  where it sets itself up in one or two messages (`?form=1` keeps the full
  four-step form).
- **`/agents/[id]`** — server redirect to `/chat/<conversationId>?agent=<tab>`
  (`now | computer | setup`).
- **`/chat/[conversationId]`** — the agent's thread and its split side panel
  (`?agent=now|computer|setup`).
- **Mac and iPhone.** An **Agents** row in the Mac's Chat sidebar and the
  phone's drawer: the roster, the agent page with `NativeAgentComputerView`
  (poster, state sentence, **Wake**, **Watch**, **Take control**, **Hand back**
  via `/computer-view?c=…` one-time handoff sheet), and `JunoAgentFace.swift`.

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

Hiring is a job board (`AgentJobBoard`, shared by `/agents/new` and the empty
roster). The starting points are a tight row list: *Chief of staff*,
*Researcher*, *Deal finder*, *Trip planner*, *Writer* and *Monitor*, then
*Start from scratch* as its own row under a hairline rather than a seventh
equal tile. Hovering or focusing a row fills the brief beside it (face, first
suggested name, role, promise, standing brief, voice and autonomy, and the
floor: it always asks before it sends, publishes, pays or deletes), so the
whole combination is visible before **Hire**. Pressing a row or **Hire**
creates the agent and its thread (`POST /api/agents`) and redirects straight to
`/chat/<conversationId>`, where the agent greets in its own voice and offers
starter chips to refine its role, routines, goals, notes or computer in
conversation (`update_agent`, `manage_agent_goal`, `manage_agent_routine`,
`manage_agent_note`, `manage_agent_computer`). *Set up with a form*
(`/agents/new?form=1`) reveals the four-step form (template, name and face
builder, style/brief/autonomy, and first goal).

The empty roster shows *Hire your first agent* and the same board, and only
after a successful read returned zero agents. A failed roster read is a load
error with Try again, never the empty state: the transport treats a body
without an `agents` array as a failure, and the store treats every per-agent
glance (latest task, attention, schedules, ideas, computer) as optional, so a
missing related table cannot turn an existing roster into an error or an empty
list.

### 5.2 The thread and the three-tab side panel (`Now · Computer · Setup`)

An agent's home is its thread (`/chat/[conversationId]`), accompanied by a
split side panel (`AgentPanel`, `380px` on desktop, bottom drawer on mobile,
deep-linkable via `?agent=now|computer|setup`; `/agents/[id]` redirects there):

- **Now** — the block that needs you first (open questions and approvals from
  its tasks, answerable in place with the existing Work cards — Deny first),
  then the task it is doing (title, plan tally, the step it is on, time working),
  then **Goals** (up to 5 active goals with quick add and *Work on this* →
  thread), **Ideas** (Start / Not now), **Upcoming** (next routine fires), and a
  collapsible **Recent activity** disclosure.
- **Computer** — the agent's dedicated cloud desktop (`ComputerView` on web,
  `NativeAgentComputerView` on Mac & iPhone): a 16:10 dark stage showing the
  last poster frame (`GET /api/agents/[id]/computer/poster`), a live state
  badge (`Running`, `Needs you — take control to continue`, `Paused for you`,
  `Sleeping`, or `Waking up…`), **Watch** / **Take control** / **Hand back to
  <name>**, and a live noVNC session over the authenticated WebSocket relay
  (`/ws/agents/[id]/computer` on web, `/computer-view?c=…` one-time handoff
  sheet on Mac & iPhone). Below the screen sits a compact feed of the last 5
  actions on the computer. When no cloud computer is enabled, it shows the quiet
  feed of recent browser/file/code actions plus **Give <name> a computer**.
- **Setup** — identity (name, role, face swatches, style, instructions),
  **Autonomy** with the floor spelled out, **Notify me** (`Only when it needs me`,
  `When a task finishes or needs me`, `Every step`) and **Pin to sidebar**,
  **Routines** (enable/pause/delete + create), **Connected apps**, **Own cloud
  computer** (Enable, Reset computer, Delete computer and all its files),
  **What it knows** (`AgentNote`, encrypted at rest, with edit/delete/download),
  and **Retire agent**.

---

## 6. Data model

All additive — new tables and nullable columns only (§20.2b expand/contract).

- `Agent` — `userId`, `name`, `role`, `avatar` (JSON `{shape, tone, eyes,
  mark}`), `style`, `instructions`, `model?`, `reasoningEffort?`,
  `approvalMode` (a `WorkPermissionPolicy`), `connectorIds[]`, `projectId?`,
  `conversationId?` (its thread), `status` (`active | paused`), `proactive`,
  `notify` (`needs_you | results | all`), `pinned` (`Boolean`), `template?`,
  `lastReflectedAt?`, `sortOrder`, timestamps, `deletedAt?`.
- `AgentComputer` — `agentId` (unique), `userId`, `status` (`creating | running |
  taking_over | sleeping | error | destroyed`), `containerName`, `volumeName`,
  `novncPort?`, `vncPasswordEnc?`, `width` (1280), `height` (800),
  `takeoverReason?`, `takeoverSessionId?`, `lastActiveAt`, `lastPosterAt?`,
  `lastError?`.
- `AgentGoal` — `title`, `detail`, `status` (`active | paused | achieved |
  dropped`), `cadence` (`none | daily | weekly`), `lastCheckInAt?`,
  `lastCheckInNote?`, `dueAt?`.
- `AgentIdea` — `title`, `detail`, `prompt`, `status` (`new | started |
  dismissed`), `goalId?`, `decidedAt?`; the task a started idea became is
  recorded on its `idea_started` event.
- `AgentNote` — the agent's own memory: `content` (AES-256-GCM encrypted at
  rest with prefix `enc:v1:`), `source` (`user | agent | reflection`),
  soft-deleted.
- `AgentEvent` — the activity log: `kind`, `title`, `detail` JSON,
  `sessionId?`, `createdAt`.
- `Conversation.agentId?` and `WorkSession.agentId?`, indexed.

## 7. API

Web and native share one surface, bearer- and cookie-authenticated through
`requireUser` like `/api/work/**`:

| Route | Does |
| --- | --- |
| `GET/POST /api/agents` | roster (with derived state) · hire |
| `GET/PATCH/DELETE /api/agents/[id]` | the panel's payload (including `computer` + `computerConfigured`) · edit / pause / pin / notify · retire |
| `POST /api/agents/[id]/thread` | the agent's thread, created on first use |
| `GET/POST /api/agents/[id]/computer` | computer status · `ensure` / `wake` / `sleep` / `takeover` / `handback` / `reset` / `destroy` |
| `POST /api/agents/[id]/computer/view` | mint a single-use 60s WebSocket/handoff token (`wsPath`, `viewUrl`, `mode`, `expiresAt`) |
| `POST /api/agents/[id]/computer/heartbeat` | keepalive while watching or taking over |
| `GET /api/agents/[id]/computer/poster` | latest JPEG frame (`Cache-Control: private, no-store`, `204` if none) |
| `GET/POST /api/agents/[id]/goals`, `PATCH/DELETE …/goals/[goalId]` | goals |
| `GET/POST /api/agents/[id]/routines` | routines (a `WorkSession` + `WorkSchedule` under the agent) |
| `GET /api/agents/[id]/activity` | the log |
| `GET/POST /api/agents/[id]/notes`, `PATCH/DELETE …/notes/[noteId]` | what it knows (encrypted at rest) |
| `POST /api/agents/[id]/reflect` | ideas and check-ins, at most every 6 h unless `force` |
| `PATCH /api/agents/[id]/ideas/[ideaId]` | start / dismiss |
| `POST /api/agents/[id]/tasks` | start a task as the agent (409 `confirm_expensive` asks first) |

## 8. What is deliberately not done

- **No shared machine across agents.** See §3. Each agent that has a cloud
  computer gets its own isolated Docker container (`juno-computer:1`) and volume
  (`juno-comp-<agentId>`) with inter-container networking disabled
  (`--icc=false`). A person can also pair their Mac for local Work.
- **No watch-me skill capture.** Screen-recording a person's browser into
  instructions is a privacy surface of its own; skills already come from a run
  (*save as skill*) and from repositories.
- **No agent-to-agent group rooms.** An agent can hand one task to a named
  teammate (`hand_off_to_teammate`, behind the approval card; it runs as the
  teammate, in its thread, and reports back there). Rooms where agents assign
  each other work still need a claim model the executor does not have.

**Shipped in Agents v1 & v2** (September 2026): per-agent isolated Docker cloud
computers (`juno-computer:1`: Xvfb + XFCE + Chromium + `x11vnc` + `xdotool` +
`scrot`) with live noVNC Watch/Takeover/Hand-back on web (`/ws/agents/[id]/computer`)
and Mac/iPhone (`/computer-view?c=…`); 9 `computer_*` Work tools (`computer_screenshot`,
`computer_click`, `computer_move`, `computer_type`, `computer_key`,
`computer_scroll`, `computer_open_url`, `computer_bash`, `computer_wait`);
5 chat self-configuration tools (`update_agent`, `manage_agent_goal`,
`manage_agent_routine`, `manage_agent_note`, `manage_agent_computer`) with
inline Undo cards (`agentChange`) for benign edits and deterministic
`ApprovalCard` confirmation for privilege escalations; thread-first home UX with
the 3-tab side panel (`Now · Computer · Setup`), compact `/agents` list, and
chat-first `/agents/new`; `Agent.notify` (`needs_you | results | all`, with email
fallback when no push channel exists), `Agent.pinned`, and AES-256-GCM
encryption at rest for `AgentNote.content` (`enc:v1:`); push end to end across
in-app, APNs, Web Push and Mac local notifications; `juno-agent-reflector`
background sweep; and voice calls in an agent's thread.
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
