# Alevr Refoundation — the product decision

> **2026-10-01 brand editorial update:** Alevr / Alevr Orbit / Alevr Code are the working design direction. Read [the brand package](brand/README.md) and the separate [Chat](brand/CHAT_SYSTEM.md), [Orbit](brand/ORBIT_SYSTEM.md), [Code](brand/CODE_SYSTEM.md) systems. Names in current proposed product prose are updated; source identifiers, routes, fenced code and dated evidence retain their actual spelling. Name availability and final artwork remain unresolved. This documentation pass does not authorize or claim a code rename. D-027–D-034 and the new brand specification override older visual rules; in particular D-033 allows restrained blur only on floating web layers and D-034 governs the new character direction. Original dated status below remains historical; HANDOFF.md is the current implementation record.

2026-09-30. This document says what Alevr *is* after the refoundation: which
nouns a person has to learn, where each capability lives, what every screen is
for, and what was cut. `DECISIONS.md` is the log of each decision with its
reasons and rejected alternatives; `PROGRESS.md` is the phase record. The
research behind it is in `research/` (OpenAI, Anthropic, SpaceXAI, Meta,
naming and identity) and the current-state audits are in `audit/`.

## 1. What we learned before deciding

**Juno is not short of capability; it is short of coherence.** Juno already
has more than any single competitor ships in one product: multi-provider chat
with honest pricing, memory with receipts and suppressions, digest-bound
approvals, typed triggers, an editable research plan, a design editor with
versions, a local coding agent with durable permission rules. What it lacks is
one story. A person meets Chat, Code, Library, Projects, Artifacts, Agents,
Assistants, Skills, Automations, Connections, Notifications and Needs you in the
sidebar alone, and the iPhone shows a different set again (Chat, Code, Work,
Search).

**It looks like Claude.** The page ground (#faf9f6) is ΔE 0.13 from Claude's
ivory, the sidebar is Claude's "Pampas", the coral has Claude's hue and chroma,
the greeting is a serif "How can I help, *Name*?", the wordmark was sized
against Claude's, and the `+` menu uses Claude's labels word for word. 55
comments justify design choices by citing Claude or ChatGPT.

**The market converged while Juno was building.** Between July and September
2026 every major vendor shipped the same two ideas Juno already had:

- *The conversation decides when an ask becomes work.* Anthropic merged Cowork
  into Claude on 16 September; OpenAI split Chat and Work into separate modes
  and users said switching felt like "being transferred to another assistant".
  Juno's `start_task` design was right; the lesson is to finish it (Research,
  too, should be something a conversation does).
- *Persistent named agents.* OpenAI dots (29 Sep), SpaceXAI Grok Bot (11 Aug),
  Meta Muse (8 Sep). Each names the individual and keeps presence in the face.
  None has earned the right to a team-of-agents UI yet: OpenAI launched one dot
  per person, Grok caps groups at six with "a single owner at each stage", and
  its own power users bolt a Notion board on top.

**Where Juno is already better, and must not regress:** digest-bound expiring
approvals with an always-confirm floor; connector annotations treated as
evidence, never authority; skills that can never widen a run's permissions;
memory the person can read and delete item by item; research plans the person
edits before the run; triggers with missed-fire records.

**Where Juno is behind:** agent computers (every competitor runs one; Juno's
is built but unsafe and off), credential handling (Muse's surrogate tokens),
published artifacts (Claude and Grok Build publish live, versioned pages; Juno
freezes a snapshot), a single home for apps and skills (Claude's Customize,
ChatGPT's plugin directory), and voice that can act.

## 2. The product in one paragraph

Alevr is one conversation that can answer, make things and do work — with a
group of named agents who keep working when you leave — and a professional
coding tool beside it. You type (or say) what you want, naming the files, apps,
projects and agents involved right in the sentence. Alevr decides whether
that needs an answer, a document, a research run or a long task, shows only
what currently matters while it works, stops to ask before anything
consequential, and ends with the finished thing.

## 3. Nouns a person learns

Seven, down from fourteen.

| Noun | What it is | Where it lives |
|---|---|---|
| **Chat** | The conversation. Answers, research, making things and delegated tasks all happen here. | Workspace (⌘⇧1) |
| **Code** | Coding sessions on this Mac, in the cloud or on a paired Mac. | Workspace (⌘⇧2) |
| **Orbit** | The workspace for named agents with a role, their own thread, standing work and (where enabled) their own computer. | Sidebar section; `/crew` roster |
| **Project** | A folder of chats, files and standing instructions. | Sidebar destination |
| **Library** | Everything Alevr made (documents, decks, sheets, designs, apps) and everything you gave it (files, images). | Sidebar destination |
| **Apps** | Services Alevr can act in (Slack, Linear, Gmail, custom MCP servers). | Customize, and inline in the composer |
| **Skills** | Reusable methods: how to do a kind of task. | Customize, and `/` in the composer |

Everything else is a *capability* (research, voice, web search, memory,
routines, approvals), a *customization* (instructions, memory, routines,
permissions) or a *tool* the conversation reaches for. None of those is a
sidebar destination.

**Retired as nouns:**

- **Artifacts** and **Design** become kinds of things in the Library. A design
  is a type of creation, not a place. The object keeps its `/a/{id}` page.
- **Assistants** retire into Orbit. An assistant was a persona with a prompt,
  tools and a model; an agent is that plus a thread and standing work.
  Existing assistants stay readable and get a one-step "Move to Orbit". Nothing
  new is created as an assistant.
- **Automations** become **routines**, owned by you or by an agent, listed
  in Customize and on the owner's page. One scheduling primitive.
- **Connections / Connectors** become **Apps** in every user-facing string. "MCP
  server" survives only where a person adds a custom one.
- **Notifications** stops being a sidebar row. Actionable items are the
  *Needs you* fold; the record is a quiet bell in the sidebar header.
- **Work** is not a word the product uses. A delegated run is a *task* in a
  chat. The iPhone Work tab is removed. (ChatGPT now owns "Work" as a mode name.)
- **Compare**, **Roadmap**, **Knowledge**, **Tasks** and **Permissions** pages
  become tools reachable from ⌘K and Settings, not destinations.

## 4. Information architecture

### 4.1 Chat workspace (web, Mac, iPad sidebar)

```
Alevr                    [bell] [collapse]
[ Chat | Code ]
+ New chat                              ⌘N
  Search                                ⌘K
  Projects
  Library
  Customize
── Needs you  (only when non-empty; each row names who and what)
── Orbit       Mira · Scout · Otto …   + Create agent
── Pinned
── Recent
[account]
```

- The Orbit section lists agents as rows (face, name, one-line "now"). Its
  header opens the roster. There is no separate "Agents" destination row, which
  removes today's double listing.
- *Needs you* is the only attention surface. A row says who needs what: "Mira
  wants your answer on the Acme renewal", "Research plan ready to approve".
- **Customize** holds Apps, Skills, Routines, Memory and Instructions. It
  replaces `/connections`, `/skills`, `/automations`, `/assistants`, the
  Settings › Connectors block and Code's separate Customize for account-level
  things. Code keeps a Customize for repository-level configuration.

### 4.2 Code workspace

```
Alevr                    [bell] [collapse]
[ Chat | Code ]
+ New session                           ⌘N
  Search                                ⌘K
  Customize        (environments, repositories, permission rules, hooks)
── Needs you
── Sessions  (today / earlier; each row one glyph of state + where it runs)
── Workspaces  (this Mac, paired Macs, cloud environments)
[account]
```

Pull requests move into the session they belong to and into ⌘K; they are not a
destination.

### 4.3 iPhone

Tab bar: **Chat · Orbit · Code**, plus the system search tab. Library,
Projects and Customize are reached from the Chat tab's top-left menu. The Work
tab goes: tasks render inside their chat as on every other surface. The iPhone
is a first-class *control* surface for Code: start cloud sessions, monitor and
steer Mac sessions, answer questions, approve, inspect diffs and tests, stop.
It is never pretended into a workstation.

### 4.4 iPad

A three-column split: sidebar identical in structure to the Mac, content, and
an inspector that shows the artifact, task or Code workspace when one is open.
Keyboard chords are shared with the Mac through one registry.

### 4.5 The shell contract covers every client

`contracts/product/juno-shell-v1.json` today projects only to the Mac. It
becomes v2 and projects to the Mac, the iPhone and the iPad. A sidebar change
on the web fails the native builds until each maps it, and a platform may
differ only through an entry in the contract's `platformDifferences` list with
a reason.

## 5. The composer: one pattern everywhere

Chat, Code, an agent thread and a project all use the same composer. What changes
between them is only the context row.

**At rest:** a field and four objects on one row — `+`, the model control,
dictate, and a send/voice button. Nothing is permanently armed. In Code, the
context row above the field names the repository, the environment and the mode
(Ask · Plan · Code), quietly.

**Inline context tokens.** Typing `@` opens a palette with Orbit, Files,
Projects, Apps and Chats. Choosing one inserts a *token*: an atomic object in
the sentence, drawn with the thing's own mark ("Compare [Q3 Forecast.xlsx] with
[Stripe] and ask [Mira] to flag renewal risk"). Tokens are structured data, not
styled text: the request carries `context: [{ kind, id, … }]` and the server
resolves each through the mechanism that already exists — an attachment, a
project context, a connector enabled for this turn, a hand-off to an agent.
A token for an app that needs connecting shows that in its popover and
connects in place; one for an action that will need approval says so before
you send ("Posting to #design will ask you first").

**`/` opens skills and commands**: `/research`, `/design`, `/deck`, and every
enabled skill by name. Research stops being a toggle in `+`.

**Progressive disclosure:** `+` holds adding things (files, photos, a
screenshot, from Library) and the per-message switches that people actually
flip (web search, memory). Everything else is reachable by typing.

**The greeting and suggestions.** A one-line greeting in upright Newsreader
(D-027), and at most three suggestions *derived from the person's own
state*: an agent who needs them, an app just connected, a project touched
today. When there is nothing real to suggest, there are no suggestions. No
generic "Write a poem" starters.

## 6. Model choice

The control shows the current model's short name. Its popover is a short list:
**Auto**, the person's favourites, and the four or five current best models,
each with one line saying what it is good at — and an effort control
(Light · Standard · Deep) under the list. Price per message is shown as a
single relative mark where it matters. Intelligence and speed bars, context
windows, modality grids and per-token prices move one layer deeper, into
**All models**, a sheet with the provider rail and full specs. Grades that are
estimates are labelled as estimates or not drawn.

## 7. Orbit

**Name.** Alevr Orbit is the proposed agent product; Orbit is its navigation
label and Your agents is its first-use descriptor. Individuals are agents,
addressed by their own names: "Mira needs your answer". The collective is
"your agents", never an Orbit or crewmates. This supersedes D-006's Crew
recommendation; see D-035 and the brand naming screen. Availability remains
unresolved, so this is a working identity rather than a released rename.

**An agent is a persistent workspace.** Its surfaces:

- **Roster** (`/crew`): who exists, what each is responsible for, who needs you.
- **Thread**: the member's persistent conversation and work history, with the
  same composer as Chat.
- **Now**: one line under the name saying what it is doing or waiting for, and
  the live task cards in the thread.
- **Computer** (gated): watch, take control, hand back.
- **Setup** (a sheet): mission, skills, apps, routines, notification policy,
  permissions, memory. A precise editor, not the primary way to configure.

**Configured by talking.** "Every weekday at 8 summarise escalations",
"Connect Linear", "Only notify me when you need a decision" produce *setup
change* cards in the thread: before → after, what it affects, Apply / Undo.
Anything that widens access (a new app, a looser approval mode, spending)
needs a deterministic approval; narrowing applies at once and is undoable.

**Presence and characters.** D-032–D-034 supersede the earlier instrument-only
face rule: original short-flocked designer-toy characters with graphic eyes,
customizable shape/color/accessories and readable state words. Motion is mostly
event-driven; any subtle idle is limited to the visible large thread character
and stops under Reduce Motion. Small faces use cached sprites. Existing shipped
faces remain until final replacements are approved. See ORBIT_SYSTEM.md.

**Multi-member rooms are not shipped in this pass.** Prerequisites come first:
every task has one owning member, an explicit transfer/claim, a parent link for
delegation, per-member budgets inside the account window, and several live
tasks per conversation. See D-010.

**Computers stay gated** until the five holes the security audit found are
closed and tested (unauthenticated DevTools inside the container, silent
`computer_shell`, takeover that doesn't pause the agent, reusable handoff
bearer links, web process in the docker group). Where the server can't run
them, the UI says nothing about them.

## 8. Apps and Skills (Customize)

**Apps** are capabilities you install, not OAuth records. Each app has a page:
its account, what it can read, what it can change, when it was last used, who
can use it (you, which agents), and the policy per action (Allow ·
Ask · Off). Revoke and reconnect live there. The directory opens on a curated
first page and searches the long tail (Composio). Custom MCP servers are added
from the same directory.

**Skills** say what they do, where they came from (author, source, commit),
what they can access, what tools they use, which surfaces they work on, their
version and update state, and their editable source. Enable/disable is one
switch. A skill that needs apps says which.

**Packages** (skill + required apps + permissions manifest + version and
provenance) are the unit of sharing. This pass defines the manifest and makes
install / update / trust excellent for skills; no marketplace.

**One approval ladder** across chat, tasks, agents and Code, named by what the
person experiences: *Ask me first* · *Ask for anything that changes things* ·
*Only ask for things that can't be undone*. The always-confirm floor (send,
publish, buy, delete, transfer, change permissions, credentials) cannot be
lowered by any setting, grant or skill.

## 9. Tasks, research, voice

**A task in a chat** leads with four things, in this order: what Alevr is doing
(one sentence), what needs you (if anything), progress (one line, plan behind
a disclosure), and when done the result — deliverables, changes, sources,
receipts, next action. Executor telemetry is one disclosure down.

**Research** is `/research` or the model's choice. The plan gate stays (it is
better than anyone's). While it runs: one line ("Reading 14 sources · 3 of 5
questions answered"). The report is a Library document with citations; the
trace is behind a disclosure.

**Voice** is a signature, quiet at rest. Listening, thinking and answering
are distinguishable by motion *and* by an accessible state; nothing starts or
sends without the same approvals as text.

## 10. Artifacts become deliverables

An artifact has its own owner and project, survives its chat, has immutable
versions, and has a lifecycle: **Share** (private link, people) is separate
from **Publish** (a stable public URL that serves a version you choose;
update, roll back, unpublish). Publishing ships static pages until the
separate preview origin and publish-time screening exist; interactive public
pages are gated on that. Duplicate/remix and download are standard; GitHub
export follows.

## 11. Alevr Code

Runtime before polish:

- **Correctness:** a stable cache prefix (goal, skills and date move to a
  per-turn session-state block), typed retries with backoff and `retry-after`,
  the tool batch persisted before it runs ("outcome unknown" on crash),
  malformed tool JSON reported instead of coerced to `{}`, command output
  spilled to a file instead of killed at 2 MB.
- **Tools:** durable shell sessions (background, output, kill, stdin),
  multi-edit and multi-file patch, image/PDF and line-numbered reads, search
  with context, a todo/plan tool, `ask_user`, Plan → approve → Code.
- **Instructions:** nested `AGENTS.md`/`CLAUDE.md` loaded by directory, user
  instructions ranked above repository files, repository skills behind the same
  trust gate as hooks and MCP.
- **One protocol:** `contracts/agent/juno-agent-protocol-v1.json`, generated
  into TypeScript (runner, web) and Swift (a dependency-free `JunoAgentProtocol`
  target). Two engines stay (Swift on the Mac, agent-core in the cloud); their
  sessions, events, approvals, plans, questions and usage stop diverging.
- **Mac experience:** sidebar (new session, needs you, sessions, workspaces),
  the transcript, and a contextual inspector (Diff, Files, Terminal, Tests,
  Preview, Git, Computer) that appears only when useful. Excellent keyboard.
- **Web and iPhone:** start cloud work, monitor and steer Mac sessions,
  approve, answer, inspect diffs and tests, stop, reconnect.

## 12. Identity

The current working direction is **Alevr**, pronounced AL-ver, with separate
[Alevr Chat](brand/CHAT_SYSTEM.md), [Alevr Orbit](brand/ORBIT_SYSTEM.md) and
[Alevr Code](brand/CODE_SYSTEM.md) systems. Read [the shared identity](brand/BRAND_IDENTITY.md)
and [names/icons](brand/NAMES_AND_ICONS.md). D-035 records the documentation-only
scope and unresolved availability; the hosted-chatbot exact name use means
this is not a claim that Alevr is unused.

The foundation is actual V3: bright neutral light, layered charcoal dark,
restrained ultramarine, upright Newsreader display, Inter UI and JetBrains
Mono technical text, with Literata Cyrillic display fallback. Desktop is
framed with an inset panel; floating layers alone receive D-033 blur. Composer
has a crisp edge and no shadow. Shared custom icons follow D-028. Orbit adds
mathematical/cosmic construction and the latest original short-flocked character
direction D-034. Native retains platform-appropriate controls/materials while
sharing color roles, display identity, spacing and original glyph geometry.
Generated concepts guide review; vectors, catalogs and actual application remain
future authorized work. The older no-serif/not-Inter research is superseded.

## 13. What is deliberately not built

- A marketplace, a public agent-template gallery, or social features.
- Multi-member rooms before ownership and claim semantics exist.
- Purchasing, payment cards, WhatsApp/iMessage bridges.
- A Chat/Work mode switch or a Research toggle.
- Model-learned approval relaxation ("learns which decisions need you").
- Interactive public artifact pages before the separate origin and screening.
- Cartoon personas, companions, desktop pets, ornamental waits.
