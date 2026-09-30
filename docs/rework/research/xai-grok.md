# SpaceXAI / Grok: competitor research for the Juno Refoundation

Phase 0 research, written 2026-09-30. Read-only against the codebase. Juno
code claims cite `rework/refoundation` @ `1feb392c`.

**How to read this.** Competitor claims come from first-party SpaceXAI pages
(x.ai news and guides, docs.x.ai), from Cursor, which SpaceX now owns and which
runs Grok Bot's infrastructure, and from the `xai-org/grok-build` GitHub repo.
Press and third-party write-ups are used only to fill gaps, and each one is
labelled **[3P]**. Anything I could not confirm first-party is marked
**UNVERIFIED**. Pages were read through a fetch-and-summarise tool, so short
quotes are what the tool returned and should be treated as close paraphrase,
not guaranteed verbatim text.

**The company and the name.** SpaceX acquired xAI on 2026-02-02 ("xAI joins
SpaceX", x.ai/news/xai-joins-spacex). The company now presents itself as
**SpaceXAI**: every x.ai and docs.x.ai page title reads "| SpaceXAI", and the
docs call the entity "SpaceX AI". Press dates the rebrand to 2026-07-06 [3P,
theplanettools.ai, digitalapplied.com]. The product names are unchanged:
**Grok**, **Grok Bot**, **Grok Build**. SpaceX then acquired **Cursor** on
2026-08-14 (cursor.com/blog/joining-spacex). Grok Bot runs on Cursor's
infrastructure: you sign in with a Cursor account, and its computers are
"Cursor-hosted".

---

## 1. Summary: the lessons that matter most for Juno

1. **The unit of delegation is a named, single-job agent, and SpaceXAI says so
   loudly.** Every Grok Bot page steers people away from one catch-all
   assistant ("Focused Bots build more useful context than one catch-all Bot").
   Their stated design test is *"Did this help someone delegate, or did it give
   them one more thing to manage?"* Juno's Agents already follow this model.
   What Grok adds is the discipline of **taking things away**.
2. **They use one clear ladder: good run, then skill, then routine.** A skill
   is how a job is done. A routine is when it runs. A draft skill can also be
   captured by **"Teach a task"**, which records the *Bot's own cloud
   computer* while the person drives it. It does not record the person's own
   screen. That point undercuts the privacy reason Juno gave for rejecting
   watch-me capture (`docs/design/AGENTS.md:494-496`). Juno should revisit that
   decision once agent computers are production-ready.
3. **Computer model: Grok shares one VM per person, while Juno gives each
   agent its own container.** Grok gives each user one Firecracker microVM and
   each Bot one screen on it. Logins, cookies and files are shared, and the
   docs say plainly that Bots are not a security boundary. Juno's per-agent
   container is safer. It also costs a sign-in per agent, which Grok's own
   users complained about. The answer is a **person-level session and
   credential broker**, not a shared machine.
4. **Approvals run on plain words and three choices.** The choices are *Allow
   once / Always allow (a rule) / Deny*. "Ask first" beats "allow
   automatically". The card shows the **current value, the proposed value and
   the expected impact**. Team Bots add scope phrased as *who it applies to*:
   this Bot, or all team Bots. Juno's digest-bound, expiring approvals are
   stronger underneath. Juno should adopt Grok's *before → after → impact*
   framing and its scope wording, but not its model-only "Auto Review" as the
   safety floor.
5. **Group chats are real but capped, and practitioners rebuild a board on top
   of them.** Grok caps a group at 2–6 Bots with "a single owner at each
   stage". SpaceXAI's own power users add a Notion board and a manager Bot. So
   a room alone does not coordinate work: **ownership plus a task list does**.
   Juno should keep one-to-one handoffs (`hand_off_to_teammate`) that create
   owned, visible tasks, and should not build agent rooms.
6. **Templates are a recipe, not a clone.** A template shares instructions,
   *filtered* memories, skills, routines and plugin *requirements*. It never
   shares credentials, custom code or MCP servers. Sharing is private until
   the owner picks team or public link. A marketplace (first-party plus
   community) sits on top, with little visible vetting. Juno's templates are
   seven hard-coded starting points (`src/lib/agents/templates.ts:33-137`).
   A shareable agent recipe is a clear gap.
7. **One product had two automation systems.** The Grok app shipped
   "Automations" (schedule + email trigger, 2026-07-16). Grok Bot shipped
   "routines" (schedule + event, 2026-08-11) with different limits and
   vocabulary. Juno also risks a split between Work automations and agent
   routines. Juno should keep **one scheduling primitive with an owner**, where
   the owner is you or a named agent.
8. **Grok Build's most interesting idea is keyless model access inside
   published apps.** A published app can call Grok for chat, images and voice
   with no key, scoped per project and revocable, and it gets access levels
   (private / link / public), remix and GitHub export. Juno's artifacts cannot
   call a model (`src/components/canvas/sandbox-frame.tsx` posts only
   `juno:console/open/inspect/selected/status`). **Artifacts that can think,
   metered to the owner** would be a real differentiator.
9. **The coding agent draws hard lines in the right places.** Plan review
   cannot be skipped even in auto or always-approve mode. "Deny always wins".
   A remembered "always allow" still prompts for `rm` and `git push`. One
   dashboard groups every session as *Needs input / Working / Idle / Inactive
   / Completed / Failed*. The weak spots are real too: the sandbox is **off by
   default**, and network limits are a **no-op on macOS**. Juno Code should
   match the gates and beat the defaults.
10. **Progress shows up as presence, not status chrome.** Agent state is carried
    by avatar motion ("rather than separate indicators"). Hovering shows the
    current action. The computer has three levels of access (a glance, a
    preview panel, a full takeover). Notifications fire only on *finished* or
    *needs input*. This fits the owner's no-pills rule, but Grok still uses a
    sidebar "status" and a computer "status indicator", and Juno must not copy
    those.

---

## 2. Capabilities

### 2.1 The Grok app: chat, connectors, Automations

**(a) What it is today.**
- A consumer chat app on grok.com, iOS and Android. It covers chat, file
  upload and analysis, Imagine (images and video), voice, and connectors to
  email, files and calendar. Paid SuperGrok plans draw from "a single weekly
  usage allowance you can spend however you like" (docs.x.ai/grok/overview,
  undated). The pool replaced per-product daily limits, rolling out in June
  2026 (docs.x.ai/grok/faq, undated).
- **Connectors** (docs.x.ai/grok/connectors, undated):
  - Built-in OAuth connectors: Gmail & Calendar, Drive, OneDrive, Outlook,
    Teams, SharePoint and Salesforce, plus a catalogue of pre-configured OAuth
    connectors.
  - Custom MCP servers, which must be "reachable over the public internet".
    Local servers need an ngrok or Cloudflare tunnel, and the docs note the
    tunnel URL changes on restart (docs.x.ai/grok/connectors/custom-mcp-tunneling).
  - On Business and Enterprise plans, an admin must provision each connector.
- **Automations** (x.ai/news/grok-automations, 2026-07-16):
  - Triggers are either scheduled (once / daily / weekdays / weekly / monthly /
    yearly, with timezone) or **email-triggered**. An email trigger matches on
    sender, recipient or subject and requires SuperGrok.
  - Each run "opens a real conversation, does the work, and saves the result
    to its run history".
  - Instructions can `@`-mention connectors and attach files.
  - Results are delivered by email, app notification, both or neither.
  - Controls: "Run now", pause, resume, edit, delete.
  - Automations can be created from grok.com/automations, from chat, or from
    templates.

**(b) User problem.** Getting answers that draw on your own accounts, and
getting recurring answers without having to ask again.

**(c) Does Juno solve it?** Yes, and more broadly.
- Juno has MCP, Composio and native connectors, and custom MCP is on a branch.
- Juno's Work triggers cover `once … yearly`, `cron`, `email_filter`,
  `calendar_window`, `topic_monitor`, `connector_event`, and a local-only
  `folder_change` (`src/lib/work/domain.ts:1259-1284`).
- Juno has a missed-run policy (`skip / run_once / run_all`, `domain.ts:1286`)
  and a trigger deduplication layer. That layer exists because "every producer
  Juno listens to re-delivers" (`src/lib/work/triggers.ts:1-20`).

**(d) Is theirs better?** Not in capability. Two things are better:
- Automation instructions are written like a chat message, with `@connector`
  tokens inline.
- The delivery choice (email / notification / both / neither) is set per
  automation.

The weakness is structural: this is a *second* scheduling system next to Grok
Bot routines (§2.8).

**(e) Principle to adopt.** An automation is a chat message plus a clock. Write
it in the composer, with inline connector and skill tokens, and let each one
choose how it reports back.

**(f) Do not copy.** Two automation products with different limits and words.
Also avoid the public-internet-only custom MCP model: Juno's paired Mac can
reach local servers without a tunnel.

---

### 2.2 Voice

**(a) What it is today.**
- **Grok Voice Think Fast 2.0** (x.ai/news/grok-voice-think-fast-2,
  2026-07-29) is a speech-to-speech model that "reason[s] through queries
  while speaking".
  - SpaceXAI claims 0.70 s to first audio, 56.5% on τ-voice Bench (vs 45.7%
    for GPT-Realtime-2.1), and 1.5–2× better transcription than Deepgram Nova
    3 and ElevenLabs Scribe v2 across 24 languages.
  - API price: $0.08 per minute.
  - `grok-voice-latest` moved to 2.0 on 2026-08-05 (docs.x.ai/developers/release-notes).
- **Voice in Grok Bot** (docs.x.ai/grok-bot/mobile, docs.x.ai/grok-bot/chat-and-collaboration,
  undated):
  - "Start dictation", plus **"Start voice chat" when the composer is empty**.
  - Bots can send **voice memos** that play back in the thread.
- Press reports voice cloning, a Voice Agent Builder beta and 21 new voices
  between April and July 2026 [3P, search summaries; UNVERIFIED first-party
  beyond the release notes].

**(b) User problem.** Talking to the assistant hands-free, fast enough to feel
like a conversation, and keeping tool use available while speaking.

**(c) Does Juno solve it?** Yes. Juno has realtime speech-to-speech and
dictation in the composer, and voice lives in the composer rather than in a
separate mode. The owner's premium pass already made "voice in composer" a
rule.

**(d) Is theirs better?** Their model leads on the benchmarks they chose to
publish. The interaction pattern is the same as Juno's. One thing Juno lacks is
**asynchronous voice from an agent**: a Bot can leave a voice memo in the
thread, which suits mobile check-ins.

**(e) Principle to adopt.** Voice is a way into the *same* thread and the same
agent. An empty composer offers "talk". Agents may answer with a short voice
memo when the person started by voice, and a transcript always sits beside it.

**(f) Do not copy.** Benchmark-led voice marketing. Voice personas tied to
characters (see §2.3).

---

### 2.3 Companions

**(a) What it is today.**
- Animated 3D companion characters (Ani, Rudi, Valentine, Mika), launched in
  July 2025.
- The first-party FAQ still says "Companions are available on the iOS app
  only, and there are no plans to bring them to the web or Android"
  (docs.x.ai/grok/faq, undated).
- Several third-party sources report that xAI announced on 2026-07-24 that it
  would retire the dedicated 3D companion mode, with avatars removed by early
  September. The personas reportedly survive only as text inside ordinary Grok
  [3P, layer3labs.io 2026-08-26 update; nika.team; sloane.world]. **UNVERIFIED
  first-party**: I found no x.ai post confirming the retirement.

**(b) User problem.** Companionship and entertainment. Also engagement: an
"affection meter" was part of it [3P].

**(c) Does Juno solve it?** No, and it should not. Juno's agent face
(`src/components/agents/agent-face.tsx`, `JunoAgentFace.swift`) shows *state*.
It is not a relationship.

**(d) Is theirs better?** No. Even SpaceXAI reportedly called it an
experiment and is winding it down [3P].

**(e) Principle to adopt.** A face earns its place by telling you what the
agent is doing (idle, thinking, working, needs you). It must never ask for
emotional investment.

**(f) Do not copy.** Characters, outfits, affection mechanics, and persona
voices built for parasocial engagement.

---

### 2.4 Grok Bot: the persistent agent

**(a) What it is today.**

*Launch and availability.*
- Launched in early beta on **2026-08-11** (x.ai/news/introducing-grok-bot),
  described as "AI teammates you can give real work to".
- Bots "remember conversations, learn how you like things done", and come back
  "only when something needs your approval". SpaceXAI says it started as an
  internal prototype that spread across the company.
- Plan access was widened on 2026-08-26 to SuperGrok (all tiers), Cursor Pro /
  Pro+ / Ultra and Cursor Teams. Usage is "separate from your Grok and Cursor
  plans" (x.ai/news/grok-bot-more-plans).
- An X integration followed on 2026-08-29 (search, timeline, mentions,
  bookmarks, with free X API credits; x.ai/news/grok-bot-and-x). Enterprise
  followed on 2026-09-03 (x.ai/news/grok-bot-for-enterprise).
- Apps: macOS, Windows and Linux desktop, iOS 18+ and Android 9+
  (docs.x.ai/grok-bot/faq). You sign in with a Cursor account
  (docs.x.ai/grok-bot/get-started).

*Design model* (x.ai/news/designing-grok-bot, 2026-09-03):
- **Five primitives**: Bots, Chats, Prompts (one-off, saved Skills, automatic
  Routines), Tools, Artifacts. "Everything else remains hidden until needed."
- Their team removed window and panel controls, computer-view options and agent
  metadata.
- Limits: roughly 50 Bots per account and six per group chat.
- Scope split: **Tools and Skills belong to the account** and are shareable.
  **Memory and Routines belong to each Bot** and are role-specific.

*Creating a Bot.*
- Via "New > Create new Bot" with a name, label or title, description and
  avatar. Or pick a suggested teammate during onboarding, which first asks
  what tools you use (docs.x.ai/grok-bot/bots, docs.x.ai/grok-bot/get-started).
- The guidance, repeated everywhere: make each Bot own "a repeatable outcome,
  not a loose category of questions" (docs.x.ai/grok-bot/use-cases). Hide
  inactive Bots rather than deleting them, and duplicate a Bot for regional or
  scoped variants.

*Memory.*
- "Stable working preferences, important facts, and summaries from its work."
- "Memory is not a substitute for an authoritative source" (docs.x.ai/grok-bot/bots).

*Evidence and results* (docs.x.ai/grok-bot/files-and-results):
- Results are cards.
- The recommended report separates "facts found in source systems" from
  assumptions and pending approvals, and includes "an explicit list of anything
  the Bot could not verify".
- To revise, you update the artifact in place rather than making copies.

*Dogfooding numbers* (x.ai/news/grok-bot-customer-support, 2026-09-22, vendor
claims):
- Tickets up 175% after the Cursor merger with zero new support hires.
- $0.20–$0.30 per resolution.
- Rollout was "crawl, walk, run": internal notes only, with "human approval for
  every write action", before any direct customer replies.

*Hands-on criticism* [3P, flaviocopes.com/grok-bot, 2026-09-30]:
- Usage "disappears faster than expected" on long browser sessions and
  multi-Bot chats.
- No model picker.
- Browser automation is fragile, and datacenter IPs get blocked.
- The Cursor forum has a "Confused over Grok Bot" thread asking how it differs
  from the Cursor IDE (forum.cursor.com/t/confused-over-grok-bot/171745).

**(b) User problem.** "I want to hand off a recurring job to someone who
remembers how I like it done, works while I'm away, and only interrupts me for
decisions."

**(c) Does Juno solve it?** Yes. Juno's Agents cover the same ground:
- **Identity and settings.** Named agents with a face, a role, instructions, a
  per-agent model and effort, an approval mode, connectors and a project
  (`src/lib/agents/types.ts:47-80`).
- **Hiring.** Hire-by-conversation with a deterministic parser as the floor
  (`src/lib/agents/hire-draft.ts:1-23`).
- **Autonomy.** Goals, proactive ideas and reflection (`src/lib/agents/reflect.ts`).
- **Memory.** Agent notes, encrypted at rest.
- **State.** Derived states with plain-language labels (Ready / Thinking /
  Working / Needs you / Stopped / Done / Paused / Listening;
  `src/lib/agents/domain.ts:66-86`), plus a `stateSentence`
  (`types.ts:71`).
- **Work.** Runs are delegated through Work.

Juno already compared itself with Grok Bot in `docs/design/AGENTS.md:22-60`.
One difference to note: Juno is **multi-model per agent**. Grok Bot has no
model picker [3P].

**(d) Is theirs better?** In three ways, and all three are discipline rather
than features:
1. **Relentless focus copy.** Every doc and guide pushes "one job per Bot".
2. **Evidence-shaped results.** Facts, assumptions, done, awaiting approval,
   could-not-verify.
3. **The staged-trust story.** Internal notes first, then approval on every
   write, then autonomy.

Juno has the parts: approval modes, and a Work plan review that gates on
`conservative` (`src/lib/work/plan-review.ts:1-25`). What Juno lacks is a way
to show an agent's **trust level rising over time** as an explicit, reversible
step.

**(e) Principle to adopt.**
- An agent is defined by the **outcome it owns**, and Juno should ask for that
  outcome at hire time.
- Every agent result states what is fact, what is assumed, what was done and
  what is waiting.
- Autonomy is earned in visible steps. For example: "Asks before every write"
  → after N approved runs, suggest "Ask before risky steps", with one tap to
  undo.

**(f) Do not copy.**
- Usage billed separately from the plan with no model control. Juno's single
  budget with 5-hour and weekly windows is clearer.
- Sign-in through a second product's account.
- The ~50-Bot roster ceiling as a goal. Juno should nudge people towards fewer,
  sharper agents.

---

### 2.5 Team workflows: group chats, bot-to-bot handoffs, Team Bots

**(a) What it is today.**

*Group chats* (docs.x.ai/grok-bot/chat-and-collaboration, undated):
- "Two to six Bots" per group.
- If you type without a mention, the Bots decide who answers. `@Bot` assigns
  ownership, e.g. "@Researcher gather the source material… @Writer turn the
  findings into a launch draft".
- Bots send asynchronous messages to each other. Handoffs are "text-only", so
  a Bot sends an image to another Bot directly.
- The guidance: "ask for a single owner at each stage". The transcript shows
  "tool activity, computer use, created files, questions, approval requests".
- Threads and reactions exist, but "a reaction alone shouldn't carry a
  safety-critical decision" (cursor.com/docs/grok-bot/work).

*Practitioner patterns:*
- "How I run multiple teams of Grok Bots" (Eric Zakariasson,
  x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots, 2026-08-27): each
  project gets a channel, a roster and **a Notion database entry**. A
  "Projects Manager" Bot staffs channels (at most five specialists plus the
  PM), reuses existing specialists before creating new ones, and marks tasks
  "Blocked" to pull the human in. His conclusion: "it resembles a system
  initially built for humans. A board, a manager, specialists claiming tasks."
- "Grok Bot for Engineering" (Lingxi Li, 2026-09-10): five domain Bots
  orchestrate Cursor Cloud Agents. They grew "from managing 15 concurrent
  agents to over 200". A shared Notion PR database is checked every 30 minutes,
  and PRs are auto-merged when "blast radius is low". An operations Bot runs a
  5 a.m. "1:1" to reinforce workflows.

*Team Bots* (x.ai/news/team-bots, **2026-09-28**; docs.x.ai/grok-bot/team-bots):
- **Ownership.** One owner configures plugins, secrets, skills and files, then
  publishes the Bot to the team.
- **Private chats, shared knowledge.** Each teammate gets a **private chat**;
  "The owner can't read teammates' chats". There is shared **team memory**
  plus private per-person notes.
- **Credentials.** OAuth plugins use **the speaker's own credentials**. Key or
  token plugins use the Bot's shared credential.
- **Where work runs.** Owner chat runs on the owner's computer. A teammate's
  chat or Slack DM runs on that teammate's computer. **Slack channels run on
  "one shared computer for that Bot"**.
- **Approval scopes.** "Allow once", "Always allow for this Bot", "Always allow
  for all Team Bots".

**(b) User problem.** Splitting a larger job across specialists without the
person routing every message. Also sharing one well-configured agent with a
team without sharing anyone's private context.

**(c) Does Juno solve it?** Partly.
- Juno deliberately has **no agent-to-agent rooms**. An agent can hand one task
  to a named teammate with `hand_off_to_teammate`, behind the approval card.
  The task runs in the teammate's thread and reports back
  (`docs/design/AGENTS.md:497-499`; `src/lib/chat/handoff-tool.ts:61`; risk
  class `external_write` at `src/lib/action-approval.ts:122`).
- `src/lib/agent/swarm.ts` holds a DAG "specialist team" orchestrator. Its
  capability is flagged `beta` (`src/lib/capabilities.ts:56-62`), and the only
  other file that mentions it is the research scheduler's comment
  (`src/lib/research/agents/scheduler.ts:4`).
- Juno agents are **per user only** (`prisma/schema.prisma:3809-3811`, where
  `Agent.userId` is the only owner field). There is no team-shared agent.

**(d) Is theirs better?** Team Bots are better than anything Juno has for
teams. The credential rule is the key idea: *OAuth tools act as whoever is
talking*. So are private chats with a shared skill base. Group chats are
**not clearly better**: SpaceXAI's own power users bolted a board and a
manager onto them. Juno's choice (a handoff that becomes an owned task)
matches what those practitioners converged on, with less ceremony.

**(e) Principle to adopt.**
- **Ownership over conversation.** A handoff creates a task with one named
  owner. It appears in the transcript as an object you can open, and it
  reports back to where it started.
- If Juno ever adds shared agents, adopt the Team Bot rule set: one owner
  configures; chats are private; the knowledge base is shared; OAuth acts as
  the speaker; channels run in their own sandbox.

**(f) Do not copy.**
- Unaddressed group messages where "Bots decide who responds". That is
  ambiguity by design.
- Auto-merging on the agent's own confidence.
- "Daily 1:1s" with agents to paper over context limits.
- Rooms as the coordination model without a claim or ownership model. Juno's
  own AGENTS.md already names this gap.

---

### 2.6 Bot computers

**(a) What it is today.**

*Shape of the machine.*
- **One persistent cloud computer per user account, shared by all that user's
  Bots.** Each Bot gets its own *screen* and runs "one computer-use task on its
  screen at a time" (docs.x.ai/grok-bot/faq; docs.x.ai/grok-bot/computer-and-apps).
- The launch post's "Each Bot has its own computer" wording contradicts the
  docs. The docs are authoritative.

*Isolation and credentials.*
- Isolation is per user: "a dedicated Firecracker microVM"
  (docs.x.ai/grok-bot/security-faq). Machines are hosted in the US.
- Within one account, Bots share files, browser sessions and logins: "Do not
  use separate Bots as a security boundary". "Deleting a Bot does not remove
  shared-computer files or browser sessions"
  (docs.x.ai/grok-bot/approvals-security-and-privacy).
- Credentials stay with the member: "Bots act as the signed-in member".
  Connector tokens stay on the backend: "Bots invoke tools without receiving
  OAuth tokens". A "secure secret request masks the entered value"
  (docs.x.ai/grok-bot/security).

*Lifecycle* (docs.x.ai/grok-bot/security; docs.x.ai/grok-bot/computers):
- Durable `/workspace` disk.
- "Idle computers hibernate automatically. Hibernation is not deletion."
- Admins can **Recreate** a computer on the latest image while keeping files
  and logins; the member sees "Updating Grok Bot's Computer". **Terminate**
  also exists, and hibernated computers are removed after 30 days while the
  disk stays.

*Watching and taking over* (docs.x.ai/grok-bot/computer-and-apps; x.ai/news/designing-grok-bot):
- Open **Agent Computer** from a conversation to watch live.
- **Take over** for a password, 2FA, CAPTCHA or payment check, then hand
  back.
- Three access levels: indicator → preview panel → full-screen takeover.
- "Dynamic wallpapers" run from light in the morning to dark at night.

*Network* (docs.x.ai/grok-bot/private-networks; docs.x.ai/grok-bot/security-faq):
- **Route Bot traffic through your desktop** (Settings → Computer) to reach
  intranets or use your own IP.
- Enterprise gets egress allowlists.
- Egress IPs are static shared ranges, and dedicated IPs are not available.

*Local machine.* Local execution is set to "Ask every time / Always allow /
Never allow".

*Complaint.* A Cursor forum thread is titled "per-agent browser still requires
separate sign-in", against the promise of account-level logins [forum listing
only; thread not read, UNVERIFIED detail].

**(b) User problem.** An agent that can use websites with no API, keeps logins
and files between sessions, and keeps working while the laptop is closed.

**(c) Does Juno solve it?** Yes by design; **not production-ready**.
- **Per-agent machine.** Juno gives each agent an isolated Docker desktop:
  container and volume `juno-agent-<agentId>`
  (`src/lib/computer/docker.ts:39,218-219`), Xvfb, XFCE, Chromium, VNC.
  Inter-container networking is off and RFC1918 egress is blocked
  (`docs/design/AGENTS.md:490-493` and the table row around line 180).
- **Watching and takeover.** Watch / Takeover / Hand-back runs over noVNC with
  single-use handoff codes (`src/lib/computer/live-view.ts:64-89`).
- **Lifecycle.** Status covers asleep / starting / awake / resting / stopping
  (`src/lib/computer/types.ts:3-9`).
- **Off by default.** The provider is off unless `AGENT_COMPUTER_PROVIDER` is
  set (`src/lib/env.ts:164-171`; `src/lib/computer/provider.ts:17-28`).
- **The paired Mac.** Juno also has something Grok lacks: a person's own Mac
  can serve as the computer for local Work, with the files and signed-in
  browser they already trust (`docs/design/AGENTS.md`, `WorkHost` row).

**(d) Is theirs better?** Operationally, yes:
- The machine exists, it works across desktop and mobile, it hibernates, it
  can be recreated on a new image, admins can fleet-manage it, and it routes
  through the desktop.

On the model, it is a trade-off, not a win:
- A shared machine gives one login for all Bots and easy file handoffs.
- It gives up isolation. Juno's per-agent isolation is the right *security*
  default.
- It creates the friction Grok users hit anyway: signing in again per agent.

**(e) Principle to adopt.**
- **Isolate the machine; share the identity carefully.** Keep a computer per
  agent. Add a person-level, consented **session and credential broker**, so a
  login granted once can be *lent* to a named agent for a named site. It should
  be visible and revocable per agent.
- Hibernation is not deletion. Keep a durable disk and a "rebuild on a new
  image, keep files" operation.
- Offer the takeover and hand-back moment for passwords, 2FA and CAPTCHA.
  Never let a password go through chat.
- "Route through my Mac" should be a first-class option, because Juno already
  has paired Macs.

**(f) Do not copy.**
- A machine shared by every agent with a docs caveat that it is not a security
  boundary.
- A status indicator on the computer (owner rule). Show the face's state and
  the latest action in words instead.
- Wallpaper theatre that changes by time of day. It is decorative and
  conflicts with the no-ornament rule.

---

### 2.7 Templates and the marketplace

**(a) What it is today.**

*The template model* ("Templates for Grok Bot" guide, 2026-09-08,
x.ai/bot/guides/templates-for-grok-bot; docs.x.ai/grok-bot/bots):
- A template is "a recipe, not a clone".
- **Included:** instructions, *relevant* memories (personal or internal
  memories are filtered out by default), skills, routines and first-party
  plugins.
- **Excluded:** conversation history, custom code and scripts, MCP servers and
  any credentials. Recipients "reinstall those plugins" themselves.
- **Sharing:** "Share as Template" in settings, then team-only or a public link;
  sharing "will not make your bot public" by itself.
- **Install:** "Add to Grok Bot" → review context and integrations → confirm.
  Recipients accept third-party Bot terms, and the guide warns: "Be very
  careful about what you're installing in your bot."

*The marketplace* (x.ai/bot/marketplace, undated):
- Nine categories, plus "From Grok Bot Team".
- Community creators are credited by name, e.g. "Outbound Prospecting", "SEO &
  AEO Desk", "figma bro", "Stalk Bot" (competitor monitoring).
- No vetting badges were visible.

**(b) User problem.** Starting from a proven setup instead of a blank brief,
and spreading a good agent across a team.

**(c) Does Juno solve it?** Partly.
- Juno has seven built-in starting points: chief-of-staff, researcher,
  deal-finder, trip-planner, writer, monitor and custom
  (`src/lib/agents/templates.ts:33-137`).
- Their connector suggestions "are offered only when the account has linked
  them; a suggestion is never a grant" (`templates.ts:10-12`).
- Juno has a duplicate route (`src/app/api/agents/[id]/duplicate`).
- There is **no user-shareable template and no marketplace**. Skills can be
  imported (SKILL.md), and imported skills are treated as third-party text
  (`src/lib/work/skills.ts:1-30,996`).

**(d) Is theirs better?** For distribution, yes. What makes the design good
is **what it leaves out**: memory is filtered, credentials, code and MCP never
travel, and plugins are requirements, not grants. That is the right safety
shape. The marketplace itself is thin on trust signals, and templates carry
free-text instructions, which is a prompt-injection path.

**(e) Principle to adopt.** An **agent recipe** is brief + skills + routines
+ *declared* connector needs + optional hand-picked notes. It is private by
default, with explicit "team" or "link" sharing. At install, Juno shows every
instruction and every routine *before* Hire, and everything installs into the
most restrictive approval mode.

**(f) Do not copy.**
- A public, community marketplace before there is review, reporting and
  takedown. Juno already has takedown mechanics for shares
  (`src/lib/share-policy.ts:9-33`).
- Surveillance-flavoured templates like "Stalk Bot".

---

### 2.8 Routines and scheduled tasks

**(a) What it is today.**

*Grok Bot routines* (docs.x.ai/grok-bot/skills-routines-and-automations, undated):
- **Skills** are reusable instructions. A good skill documents "When to use
  it, required inputs and access, the sequence of work, how to validate the
  result, what to return, [and] what requires approval". Skills are shared
  across all Bots in the workspace.
- **Routines** decide *when* a workflow runs: on a schedule (times, days,
  timezone) or on an event from a connected account (a Slack message, a
  GitHub notification), with "narrow matching rules".
- Limits: up to **50 routines per Bot**, and **20 most recent run records**
  kept per routine.
- "Test runs perform real work". Deletion has no undo. Routines may be paused
  after long inactivity.
- Routines should include no-data and stale-data policies, with drafting
  before executing.
- On mobile you can see schedules, next run time and "Run history", and toggle
  "Active". Editing a routine, testing it and teaching need the desktop app
  (docs.x.ai/grok-bot/mobile).
- The design post frames routines as "the interface should ask less of the
  person", with the transcript showing what ran.

*The Grok app's separate "Automations"* are covered in §2.1.

**(b) User problem.** Recurring work that happens without being asked, with
results you can check.

**(c) Does Juno solve it?** Yes, and it is ahead on semantics:
- Richer triggers, missed-run policy and deduplication (see §2.1).
- Per-agent routines (`src/app/api/agents/[id]/routines`), with the next
  routine shown on the agent (`ClientAgentRoutineGlance`,
  `src/lib/agents/types.ts:36-40`).
- Skills can be "captured from a run" (`src/lib/skills/library-contract.ts:71`).

**(d) Is theirs better?** Two things are better:
- The **ladder** (one good run → skill → routine) is taught everywhere,
  including in onboarding.
- The skill template is written *for the model's future self*: when to use it,
  inputs, validation, output, approval boundary.

Juno's machinery is stronger. Its teaching of the ladder is weaker.

**(e) Principle to adopt.**
- After a good run, offer **one** next step: "Save how you did this" (a
  skill). After a skill is used twice, offer "Run this every…" (a routine).
- Every saved skill gets the six-field structure, including "what requires
  approval" and a "no data / stale data" rule.

**(f) Do not copy.**
- Two parallel automation systems (§2.1).
- "Test run" buttons that do real work without saying so. If Juno has a test
  run, it runs in dry-run or draft mode, or says plainly that it acts for real.

---

### 2.9 Teach / show workflows (learning by demonstration)

**(a) What it is today.**
- **"Teach a task"**: open a one-to-one Bot conversation *with the computer
  view open*, describe the result you are about to show, perform the workflow
  once (up to **10 minutes**), stop, and review the **draft skill**. It
  records "visible computer interaction", not audio.
- Users are told to "keep secrets out of the demonstration and use the secure
  secret request for credentials", and to "add decision rules, failure
  handling, and approval boundaries, then test it on a safe input before
  scheduling" (cursor.com/docs/grok-bot/work;
  docs.x.ai/grok-bot/skills-routines-and-automations).
- Availability is qualified ("When available"). Teaching is desktop-only
  (docs.x.ai/grok-bot/mobile).
- A third-party explainer adds the honest limit: a recording captures the
  happy path, not how to spot a stale page or what must never be clicked [3P,
  search summary; consistent with first-party guidance].

**(b) User problem.** Some workflows are faster to show than to describe,
especially in web apps without APIs.

**(c) Does Juno solve it?** No. `docs/design/AGENTS.md:494-496` rejects
"watch-me skill capture" because "Screen-recording a person's browser into
instructions is a privacy surface of its own".

**(d) Is theirs better?** Yes, and it avoids the risk Juno cited. Grok records
the **agent's own cloud computer while the person drives it**. It never
records the person's own screen or browser. Juno already has everything this
needs: a per-agent computer, and a takeover and hand-back flow over noVNC
(`src/lib/computer/live-view.ts:64-89`).

**(e) Principle to adopt.** **"Show it on its computer."**
- During a takeover, the person can say "watch me do this". Juno records the
  agent's screen actions (not audio, not the person's machine), masks typed
  secrets, and produces a *draft* skill.
- The draft uses the six-field shape from §2.8 and opens for review with
  explicit gaps: "What should happen if the list is empty?" and "Which of
  these clicks must always ask you first?"
- Gate this on agent computers becoming production-ready.

**(f) Do not copy.**
- Recording the person's own Mac or browser.
- Treating a recording as a finished skill.
- Mobile teaching (they did not ship it either).

---

### 2.10 Approvals and Auto Review

**(a) What it is today.**

*The approval card* (docs.x.ai/grok-bot/approvals-security-and-privacy):
- "The conversation shows the proposed operation and its inputs".
- Recommended phrasing: "Ask for approval after showing the current value,
  proposed value, and expected impact".
- Choices: **Allow once / Always allow** (creates a matching rule) **/ Deny**.
- "An approval controls the proposed action. It does not reverse work already
  completed."
- On mobile, drafted email and Slack messages become "Send Email" / "Send
  Message" cards (docs.x.ai/grok-bot/mobile).

*Auto Review* (docs.x.ai/grok-bot/security, x.ai/bot/guides/grok-bot-101):
- "An independent review layer" over shell, plugin calls, computer use,
  automation writes and delegation.
- Rules are "Ask first" or "Allow automatically", and "If both kinds of rule
  match, Ask first wins".
- "Rules are a prompt": a review agent checks proposed actions against allow
  and block lists written by the user.
- "It does not review every side effect": memory writes and settings changes
  are not covered.
- Admins can enforce team rules that members cannot turn off (Enterprise).

**(b) User problem.** Letting an agent act without letting it do something you
cannot take back, and without being asked about everything.

**(c) Does Juno solve it?** Yes, and more rigorously:
- **Risk classes:** read_only / reversible_write / external_write /
  destructive_or_sensitive / unknown (`src/lib/action-approval.ts:22-30`).
- **Policies:** always_ask / ask_for_any_change / ask_for_important_actions /
  allow_selected_low_risk / block (`action-approval.ts:32-40`).
- **Decisions:** `allow_once | allow_scope | deny`, with a **15-minute TTL**
  (`action-approval.ts:43,57`).
- **Digest binding:** policy, args and receipt are bound by SHA-256
  (`action-approval.ts:350-381`).
- **A floor nothing silences:** `ALWAYS_CONFIRM_ACTIONS`
  (`src/lib/work/domain.ts:615`).
- **Plain-language modes:** "Ask before every change" / "Ask before risky
  steps" (`domain.ts:533-555`).
- **Expired approvals are dropped**, so no card appears whose buttons are
  bound to fail (`src/lib/work/approvals.ts:1-45`).

**(d) Is theirs better?**
- **The safety floor: no.** A model reviewing actions against prose rules is a
  probabilistic floor, and they admit the review has gaps.
- **Presentation: yes, in two ways.**
  1. **Current → proposed → impact** is a better card shape than "tool + args".
  2. **Scope wording tied to who it applies to** ("this Bot" / "all Team
     Bots") is easier to understand than abstract scopes.
- The "doesn't reverse completed work" line is honest copy that Juno should
  also carry.

**(e) Principle to adopt.**
- Every approval card answers three things in words: **what is there now, what
  will be there after, and who or what it touches**.
- "Always allow" is always narrow and names its scope ("for Wren, on
  calendar.google.com, for new events only").
- Personal rules may be written as prose ("never email anyone at
  competitor.com"). Juno **compiles them into deterministic matchers** where it
  can, and treats model review only as an extra check. It never loosens the
  floor.

**(f) Do not copy.**
- Model-only review as the floor.
- Unreviewed side-effect classes (memory writes, settings changes).
- Letting a reaction count as an approval. They warn against this themselves.

---

### 2.11 Grok Build: the app and website builder

Watch the naming. SpaceXAI uses "Grok Build" for **two products**:
- the **terminal coding agent** (CLI, May 2026; §2.12)
- the **in-chat app builder**. It shipped as "Build Mode" on 2026-07-28 and
  was renamed "Grok Build on web and mobile" on 2026-08-19.

The FAQ says Build Mode replaced the discontinued "Grok Studio"
(docs.x.ai/grok/faq).

**(a) What it is today.**

*Build Mode* (x.ai/news/grok-build-mode, **2026-07-28**):
- "Tell Grok an idea, and it builds a working version live in your chat".
  Outputs cover websites, apps, games (including 3D) and dashboards with data
  connectors.
- Publishing goes to `grok.me` or a custom domain.
- Early Beta, **SuperGrok Heavy only**, on web, iOS and Android.

*Grok Build for everyone* (x.ai/news/grok-build-for-everyone, **2026-08-19**):
- All plans, including free.
- A live preview in chat, and every published app gets a `grok.me` address
  with **private / link-only / public** access.
- **Apps can call SpaceXAI APIs for chat, images and voice "from inside its
  own code — no keys to create"**, scoped per project and revocable [scope
  detail per 3P runtimewire.com].
- Remix (fork), **GitHub export**, custom domains.
- A **secrets store** for third-party keys, and data connectors for "live,
  filterable dashboards".
- Each app gets an auto-generated preview card. **Shared on X, it renders
  inline** with the creator's handle and a play affordance for games.

*Limits* [3P, appwrite.io 2026-07-29]: "Once you need multiple users,
persistent data, authentication, file uploads, or server-side logic you
control, a generated grok.me app is not a backend you own."

**(b) User problem.** Turning an idea into something shareable and working
without setting up a project, keys or hosting.

**(c) Does Juno solve it?** Partly.
- Juno's Artifacts and Canvas render web artifacts live in a sandboxed iframe
  (HTML, React, SVG, Mermaid) and run JS, TS and Python in-browser
  (`src/lib/artifact-runtime.ts:1-23`).
- They have versioning and a Design editor, and one stable address `/a/{id}`
  "belongs to the object rather than to the chat it was made in"
  (`src/lib/artifact-links.ts:1-18`).
- Public shares can be revoked and taken down (`src/lib/share-policy.ts`).
- The sandbox bridge only carries `juno:console`, `juno:open`,
  `juno:inspect`, `juno:selected` and `juno:status`
  (`src/components/canvas/sandbox-frame.tsx:237,270,361,410`). **So a
  published artifact cannot call a model.**
- No custom domains and no GitHub export for artifacts were found in this
  pass. **UNVERIFIED absence**: grep-level only.

**(d) Is theirs better?** On reach, yes:
- **Keyless model access inside the artifact** turns a static page into a
  small AI app.
- Access levels are clear.
- Remix and GitHub export make the output portable.

On honesty about limits, no: the builder is not a backend. And X-feed
distribution is a growth loop, not a user benefit.

**(e) Principle to adopt.**
- **"Artifacts that can think."** A published or private artifact may call
  Juno models through a narrow bridge: owner-metered, rate-limited per
  artifact, revocable, and **off by default** per artifact. Visitors' calls
  count against the owner's budget, with a spend cap and usage shown on the
  artifact.
- Publishing is a lifecycle step with three plain access levels (only me /
  anyone with the link / public).
- "Take it with you": export to a repo, or hand off to Juno Code.

**(f) Do not copy.**
- Social-feed distribution and remix as a growth engine.
- Implying a generated app is a backend.
- A separate "Build Mode" switch. Juno's artifact appears when the work calls
  for one.

---

### 2.12 The coding agent: grok-code-fast → grok-build-0.1 → Grok Build CLI, and Bot → Cloud Agents

**(a) What it is today.**

*Models.*
- **grok-code-fast-1** (x.ai/news/grok-code-fast-1, **2025-08-28**) was built
  "from scratch, starting with a brand-new model architecture" on a
  code-heavy corpus.
  - It claims ~190 tokens/s and "cache hit rates above 90%" with partners, and
    was tuned for grep, terminal and file editing.
  - Launch price: $0.20 per 1M input tokens and $1.50 per 1M output tokens.
- **grok-build-0.1** (docs.x.ai/developers/models/grok-build-0.1, undated)
  lists `grok-code-fast-1` as an alias.
  - 256k context, text and image input.
  - The page lists $1.00/$2.00 per 1M input and output tokens below 200k, and
    double above that. **Pricing conflicts with third-party reports of
    $0.20/$1.50** (those match the 2025 grok-code-fast-1 price). I treat the
    docs page as current; the conflict is UNVERIFIED.
- **Grok 4.5** (2026-07-16) was pitched for coding and agentic work. It is
  available "through Grok Build, Cursor, and the SpaceXAI API"
  (x.ai/news/grok-4-5). **Grok 4.6** (August) and **Grok 4.7** (September,
  500k context) followed (docs.x.ai/developers/release-notes).

*The Grok Build CLI* (x.ai/news/grok-build-cli, **2026-05-25**; beta from
2026-05-14 per [3P]):
- **Surfaces.** Terminal agent with a full-screen TUI, headless mode (`-p`),
  and "full ACP support".
- **Rust**, open-sourced on 2026-07-15 under Apache-2.0
  (x.ai/news/grok-build-open-source; github.com/xai-org/grok-build).
- **Rule files.** Reads `AGENTS.md`, `CLAUDE.md` and `.grok/rules/`, with
  deeper files winning (docs.x.ai/build/features/project-rules).
- **Claude Code compatibility.** "zero-configuration compatibility with Claude
  Code": it reads its marketplaces, plugins, skills and MCPs.
  `SKILL.md` frontmatter is supported (docs.x.ai/build/features/skills-plugins-marketplaces).
- **Modes** (Shift+Tab; docs.x.ai/build/modes-and-commands,
  docs.x.ai/build/features/permissions):
  - **Plan**: only the plan file is editable until you approve.
  - **Auto**: a classifier approves safe calls.
  - **Always-approve.**
  - Rules follow `allow` / `deny` patterns, and "deny always wins". "A
    remembered 'always allow' grant still prompts for dangerous patterns such
    as `rm` and `git push`."
- **Plan review** (docs.x.ai/build/features/plan-mode): approve / request
  changes / **comment on specific lines or steps**. "Auto and always-approve do
  not skip this review." Subagents are not edit-gated by the parent's plan
  mode, but they inherit its permission mode.
- **Sandbox** (docs.x.ai/build/features/sandbox): Seatbelt on macOS and
  Landlock on Linux, but **"Off by default"**. Network restrictions apply "on
  Linux only; no-op on macOS" for strict profiles. "Model API and web tools
  are not blocked by child-network settings."
- **Subagents** (docs.x.ai/build/features/subagents): `general-purpose`,
  `explore` (read and search only) and `plan` (no shell, no edits). Custom
  agents live in `.grok/agents/`, plus "personas" as behaviour overlays. Each
  child has its own context and returns a summary. Up to eight in parallel
  [3P].
- **Worktrees** (docs.x.ai/build/features/worktrees): per session or per
  subagent, under `~/.grok/worktrees/…`, persist until removed, with
  `grok worktree gc`.
- **Background work** (docs.x.ai/build/features/background-tasks): background
  tasks, `/loop` (at least 60 s apart; expires after 7 days; at most 50
  active), and **monitors**, where "each line the script prints becomes a
  notification". Prompts typed during a turn are queued.
- **Agent Dashboard** (docs.x.ai/build/features/dashboard): every session
  grouped as "Needs input, Working, Idle, Inactive, Completed, Failed". A peek
  panel shows the latest activity. You can reply inline or answer permission
  prompts with number keys. A bottom bar "dispatches prompts to new sessions".
- **Sessions** (docs.x.ai/build/features/sessions): stored on disk. `/resume`,
  `/fork` (optionally into a worktree), `/rewind` restores files and
  truncates the conversation, and `/compact`.
- **Workflows**: `/create-workflow` authors a bounded fan-out of subagents.
  "Grok asks about fan-out, verification, and scope, then authors,
  smoke-checks, and saves the file". A built-in `/deep-research` workflow
  exists.

*Grok Bot and Cursor Cloud Agents*
(cursor.com/docs/grok-bot; x.ai/bot/guides/grok-bot-for-engineering,
2026-09-10):
- Bots "delegate coding tasks to separate computers under your existing Cloud
  Agent controls" and check the results visually through screenshots.
- Admins can turn off "Cloud Agent spawning" (docs.x.ai/grok-bot/teams-and-enterprises).
- Forum threads report Grok-launched cloud agents missing from Cursor's
  `/agents` list, and missing review commands (forum.cursor.com listings).

**(b) User problem.** Getting code written, reviewed and merged while you are
not watching, in a harness you can trust and extend.

**(c) Does Juno solve it?** Mostly, and several of the same design choices
already exist in Juno Code:
- **Permission modes.** Four modes: readOnly / askBeforeChanges /
  workspaceWrite / fullAccess. Sub-agents are **capped at the authority of
  whoever started them** (`native/Packages/JunoCode/Sources/JunoCodeCore/PermissionModel.swift:4-33`).
  A destructive tier "no mode proceeds silently" past, including full access
  (same file).
- **Plan mode.** The Studio ladder is `[.plan, .askBeforeEdits, .autoEdit,
  .fullAccess]`, and Plan "Reads the project and writes a plan. Changes
  nothing." (`…/JunoCodeUI/Studio/StudioMode.swift:28,86`).
- **Subagents.** Read-only or workspace-write modes
  (`…/JunoCodeCore/SubagentExecutionMode.swift`) and a `WorktreeManager`
  (`…/JunoCodeLocal/WorktreeManager.swift`).
- **Compatibility.** Rule files `JUNO.md`, `AGENTS.md`, `CLAUDE.md` and
  `.claude/CLAUDE.md` (`…/JunoCodeUI/Models/WorkspaceContext.swift:255`).
  Skills are read from `.claude/skills` and `.juno/skills`
  (`…/JunoCodeUI/Models/SlashCommands.swift:466`).
- **Where it runs.** Cloud runs go through GitHub Actions and a TS runner;
  the phone acts as a remote control.
- **Work plans.** Plan review for Work is tied to the approval mode rather
  than being a separate switch (`src/lib/work/plan-review.ts:1-25`), with
  "Go ahead" / "Change it" (`plan-review.ts:92-93`).

**(d) Is theirs better?** In four places:
1. **Plan review is independent of the mode**: auto modes cannot skip it, and
   you can comment *line by line*.
2. **Dangerous patterns re-prompt even under "always allow"**.
3. **One dashboard for every running session**, grouped by what needs you,
   with inline replies.
4. **Monitors**, where each output line becomes a notification.

In two places Juno is better or should be:
1. Juno caps sub-agent authority at the parent's.
2. Juno should **not** match "sandbox off by default" or a network sandbox
   that is a no-op on macOS.

**(e) Principle to adopt.**
- A plan, once asked for, is always reviewed before edits, whatever the mode.
  The review allows comments on single steps.
- "Deny wins", and remembered grants never cover irreversible or outbound
  patterns (`git push`, `rm -rf`, publish, send).
- One **Runs** view across Code, Work and agents, grouped by *Needs you /
  Working / Idle / Done / Failed* in **words**, with inline answer and steer.
- Juno Code's sandbox is on by default on the Mac.
- Keep reading `CLAUDE.md`, `AGENTS.md` and `.claude/skills` without setup.
  Compatibility is table stakes; Grok ships it.

**(f) Do not copy.**
- Sandbox off by default.
- Auto-merge on agent confidence.
- 200-agent fleets as a selling point.
- Showing the same thing under two product names ("Grok Build" CLI vs "Grok
  Build" app builder).

---

## 3. Interaction and visual patterns worth noting (principles, not pixels)

**Composer**
- **Voice.** Voice chat is offered *when the composer is empty*, and dictation
  is always available (docs.x.ai/grok-bot/mobile). This matches Juno's
  "voice in composer".
- **Drafts** auto-save per conversation (docs.x.ai/grok-bot/mobile). This is
  worth matching on every Juno surface.
- **Queued prompts.** Prompts typed while an agent is busy are queued, not
  dropped (docs.x.ai/build/features/background-tasks). The dashboard does the
  same: messages to busy agents queue.
- **Automations are written as chat messages**, with `@connector` tokens and
  attachments (x.ai/news/grok-automations).

**Inline tokens and mentions**
- `@Bot` assigns *ownership* in a group, not just attention
  (docs.x.ai/grok-bot/chat-and-collaboration). If Juno uses `@agent`, the
  token should mean "this agent owns this".
- `/skill` works as a slash command in the CLI, and `user-invocable` controls
  which skills appear there (docs.x.ai/build/features/skills-plugins-marketplaces).

**Approvals**
- The card shows the **proposed operation and its inputs**, and ideally
  current value → proposed value → expected impact.
- Three answers: *Allow once / Always allow / Deny*. Team scopes are phrased
  by *who*: "for this Bot" / "for all Team Bots".
- Outbound drafts become a **"Send Email" / "Send Message"** card. The action
  is the button, and the draft is the content.
- The copy is honest: approving does not undo work already done.

**Progress presentation**
- **Presence over chrome.** The avatar's *motion* carries idle, thinking,
  working, waiting, blocked and done, "rather than separate indicators".
  Hovering reveals the current action ("Searched web", "Ran tests";
  x.ai/news/designing-grok-bot). Juno's `AgentFace` plus `stateSentence` is
  the same idea. Keep it, and make hover or long-press show the latest action
  in words.
- **Actions appear as transcript objects.** A routine scheduled, a message sent
  to another Bot, a setting changed: each appears in the thread as something
  you can open, not a sentence about it. Juno's inline Undo cards
  (`agentChange`) already do this.
- **Structured cards when prose is wrong.** A forecast is a card, not a
  paragraph.
- **Three levels of computer access.** A glance, then a preview panel, then a
  full takeover. *Juno should drop the first level's "status indicator"* (owner
  rule) and let the face and a line of text carry it.
- **Notifications only on "finishes or needs input"**, suppressed while the app
  is focused. Unread activity still shows in the sidebar and dock badge
  (docs.x.ai/grok-bot/settings-and-notifications). Juno's `Agent.notify` levels
  (`needs_you | results | all`) are the same idea, with more control.
- **Evidence-shaped results.** Facts vs assumptions vs done vs awaiting
  approval, plus "could not verify".
- **The CLI dashboard groups sessions by state in words**, with a peek panel
  and inline replies. A text-first, pill-free model for a Runs view.

**Agent presence**
- A roster in the sidebar. Named Bots with a title and avatar; "hide" rather
  than delete.
- SpaceXAI explored **ambient presence**: a Bot tucked into the Mac notch, a
  corner peek, and a cursor-following companion ("Designing Grok Bot with Grok
  Bot", John Bai, 2026-08-24). These were explorations, and there is no
  evidence any shipped. If Juno explores ambient presence on the Mac, it has to
  use native system surfaces (menu bar, Live Activities on iOS) and never a
  faked material or a floating glow.
- Asynchronous voice memos from an agent are a presence pattern that works on
  a phone.

**Patterns to reject explicitly**
- Sidebar status markers and a computer "status indicator".
- Time-of-day wallpapers.
- Companion characters.
- Unaddressed group messages where agents decide who replies.
- Model-only safety review.
- Feed-distribution loops.

---

## 4. Sources

First-party SpaceXAI (x.ai). Dates are publication dates shown on the page.
- Introducing Grok Bot — https://x.ai/news/introducing-grok-bot — 2026-08-11
- Grok Bot is now included with more plans — https://x.ai/news/grok-bot-more-plans — 2026-08-26
- Grok Bot now works with X — https://x.ai/news/grok-bot-and-x — 2026-08-29
- Grok Bot for Enterprise — https://x.ai/news/grok-bot-for-enterprise — 2026-09-03
- Designing Grok Bot for a world of persistent agents — https://x.ai/news/designing-grok-bot — 2026-09-03
- How SpaceXAI is using Grok Bot to scale customer support — https://x.ai/news/grok-bot-customer-support — 2026-09-22
- Team Bots: AI coworkers that learn from your team — https://x.ai/news/team-bots — 2026-09-28
- Introducing Build Mode — https://x.ai/news/grok-build-mode — 2026-07-28
- Grok Build on web and mobile — https://x.ai/news/grok-build-for-everyone — 2026-08-19
- Introducing Grok Build (CLI) — https://x.ai/news/grok-build-cli — 2026-05-25
- Grok Build is Now Open Source — https://x.ai/news/grok-build-open-source — 2026-07-15
- Introducing Grok Voice Think Fast 2.0 — https://x.ai/news/grok-voice-think-fast-2 — 2026-07-29
- Introducing Grok 4.5 — https://x.ai/news/grok-4-5 — 2026-07-16
- Automations in Grok — https://x.ai/news/grok-automations — 2026-07-16
- Grok Code Fast 1 — https://x.ai/news/grok-code-fast-1 — 2025-08-28
- xAI joins SpaceX — https://x.ai/news/xai-joins-spacex — 2026-02-02
- Templates for Grok Bot (guide) — https://x.ai/bot/guides/templates-for-grok-bot — 2026-09-08
- Grok Bot 101 (Matt Palmer) — https://x.ai/bot/guides/grok-bot-101 — 2026-09-11
- Grok Bot for Engineering (Lingxi Li) — https://x.ai/bot/guides/grok-bot-for-engineering — 2026-09-10
- How I run multiple teams of Grok Bots (Eric Zakariasson) — https://x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots — 2026-08-27
- Designing Grok Bot with Grok Bot (John Bai) — https://x.ai/bot/guides/designing-grok-bot-with-grok-bot — 2026-08-24
- Grok Bot guides index — https://x.ai/bot/guides — accessed 2026-09-30
- Grok Bot Marketplace — https://x.ai/bot/marketplace — accessed 2026-09-30

First-party docs (docs.x.ai; pages are undated, accessed 2026-09-30).
- Grok Bot overview — https://docs.x.ai/grok-bot
- Get started — https://docs.x.ai/grok-bot/get-started
- Create and manage Bots — https://docs.x.ai/grok-bot/bots
- Team Bots — https://docs.x.ai/grok-bot/team-bots
- Message and collaborate — https://docs.x.ai/grok-bot/chat-and-collaboration
- Use the computer and apps — https://docs.x.ai/grok-bot/computer-and-apps
- Files and results — https://docs.x.ai/grok-bot/files-and-results
- Skills and routines — https://docs.x.ai/grok-bot/skills-routines-and-automations
- Settings and notifications — https://docs.x.ai/grok-bot/settings-and-notifications
- Approvals, security, and privacy — https://docs.x.ai/grok-bot/approvals-security-and-privacy
- Teams and enterprises — https://docs.x.ai/grok-bot/teams-and-enterprises
- Grok Bot security — https://docs.x.ai/grok-bot/security
- Grok Bot security FAQ — https://docs.x.ai/grok-bot/security-faq
- Manage computers — https://docs.x.ai/grok-bot/computers
- Private networks — https://docs.x.ai/grok-bot/private-networks
- Grok Bot for Mobile — https://docs.x.ai/grok-bot/mobile
- Use cases — https://docs.x.ai/grok-bot/use-cases
- Troubleshooting — https://docs.x.ai/grok-bot/troubleshooting
- FAQ — https://docs.x.ai/grok-bot/faq
- Grok Build overview — https://docs.x.ai/build/overview
- Modes and commands — https://docs.x.ai/build/modes-and-commands
- Plan mode — https://docs.x.ai/build/features/plan-mode
- Permissions — https://docs.x.ai/build/features/permissions
- Sandbox — https://docs.x.ai/build/features/sandbox
- Subagents — https://docs.x.ai/build/features/subagents
- Worktrees — https://docs.x.ai/build/features/worktrees
- Background tasks — https://docs.x.ai/build/features/background-tasks
- Agent Dashboard — https://docs.x.ai/build/features/dashboard
- Sessions — https://docs.x.ai/build/features/sessions
- Skills, plugins, marketplaces — https://docs.x.ai/build/features/skills-plugins-marketplaces
- AGENTS.md / project rules — https://docs.x.ai/build/features/project-rules
- grok-build-0.1 model page — https://docs.x.ai/developers/models/grok-build-0.1
- API release notes — https://docs.x.ai/developers/release-notes
- Grok (consumer) overview — https://docs.x.ai/grok/overview
- Grok FAQ — https://docs.x.ai/grok/faq
- Connectors — https://docs.x.ai/grok/connectors
- Custom MCP tunneling — https://docs.x.ai/grok/connectors/custom-mcp-tunneling
- Docs index — https://docs.x.ai/llms.txt

First-party code and Cursor, which SpaceX owns.
- xai-org/grok-build README — https://github.com/xai-org/grok-build — accessed 2026-09-30
- Cursor is now a part of SpaceX — https://cursor.com/blog/joining-spacex — 2026-08-14
- Grok Bot (Cursor Docs) — https://cursor.com/docs/grok-bot — accessed 2026-09-30
- Work with Grok Bot (Cursor Docs; the Teach a task details) — https://cursor.com/docs/grok-bot/work — accessed 2026-09-30
- Introducing Grok Bot (Cursor forum announcement and related threads) — https://forum.cursor.com/t/introducing-grok-bot/168053 — 2026-08-11
- Confused over Grok Bot (Cursor forum) — https://forum.cursor.com/t/confused-over-grok-bot/171745 — undated

Third-party, labelled [3P] in the text and used only to fill gaps.
- Flavio Copes, "A deep dive into Grok Bot" — https://flaviocopes.com/grok-bot/ — 2026-09-30
- RuntimeWire, "SpaceXAI opens Grok Build to every plan and gives its apps an X feed" — https://runtimewire.com/article/spacexai-grok-build-every-plan-x-app-distribution — 2026-08-19
- Appwrite, "Grok Build Mode: Everything developers need to know" — https://appwrite.io/blog/post/grok-build-mode-everything-developers-need-to-know — 2026-07-29
- Layer3 Labs, "Grok Companions Explained" — https://www.layer3labs.io/guides/grok-companions-explained — updated 2026-08-26
- Search-result summaries (not opened) for the rebrand date and companion retirement: theplanettools.ai, digitalapplied.com, nika.team, sloane.world — dates as reported there

Juno code referenced (branch `rework/refoundation` @ `1feb392c`):
- `docs/design/AGENTS.md:22-60, 180-200, 490-499`
- `src/lib/agents/types.ts:36-80`, `src/lib/agents/domain.ts:66-86`, `src/lib/agents/templates.ts:1-137`, `src/lib/agents/hire-draft.ts:1-23`
- `src/lib/computer/types.ts:3-91`, `src/lib/computer/provider.ts:17-28`, `src/lib/computer/docker.ts:39,218-219`, `src/lib/computer/live-view.ts:64-89`, `src/lib/env.ts:164-171`
- `src/lib/action-approval.ts:22-58,122,284-291,350-381`, `src/lib/work/approvals.ts:1-45`, `src/lib/work/domain.ts:503-555,615,1259-1287`, `src/lib/work/triggers.ts:1-20`, `src/lib/work/plan-review.ts:1-25,92-93`, `src/lib/work/skills.ts:1-30,996`, `src/lib/skills/library-contract.ts:71`
- `src/lib/chat/handoff-tool.ts:2,61`, `src/lib/agent/swarm.ts:1-8`, `src/lib/capabilities.ts:56-62`, `src/lib/research/agents/scheduler.ts:4`
- `src/lib/artifact-runtime.ts:1-23`, `src/lib/artifact-links.ts:1-18`, `src/lib/share-policy.ts:9-33`, `src/components/canvas/sandbox-frame.tsx:237-489`
- `prisma/schema.prisma:3809-3811`
- `native/Packages/JunoCode/Sources/JunoCodeCore/PermissionModel.swift:4-33`, `…/JunoCodeCore/SubagentExecutionMode.swift`, `…/JunoCodeUI/Studio/StudioMode.swift:14-86`, `…/JunoCodeUI/Models/WorkspaceContext.swift:255`, `…/JunoCodeUI/Models/SlashCommands.swift:466`, `…/JunoCodeLocal/WorktreeManager.swift`
