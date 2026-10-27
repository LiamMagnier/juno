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
- **`/agents`** — Orbit: what needs you, then the crew, one tile per agent
  (live face · name · role · what it is doing), then **New agent** (§4.3).
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

Rebuilt from the ground up in October 2026 (the glossy Blender clay bodies,
glinting eyes and bolted-on marks read as stock mascot work). The language is
learned from Grok Bot: **3D but flat**. One flat shape in one tone, two cut
eyes, nothing else; the volume lives in the motion. The marks it is built
from are Juno's own: the open ring with its ball terminal, and the four-point
spark. Code: `src/components/agents/agent-face.tsx` (the element),
`face-geometry.ts` (bodies, eyes, orbit, `drawFace`), `face-rig.ts` (states as
poses over time, and the one shared clock), `agent-face.css` (paint, tokens
only). `tests/agents-face.test.ts` holds the promises below.

### 4.1 Construction (all code, no images)

- **Body**: nine signed distance fields, geometric constructions rather than
  hand paths (`face-shapes.ts`, traced offline into `face-outlines.ts`), all
  symmetric but one: `orb` circle · `pebble` superellipse (1.06 × 0.92, n 2.5) ·
  `capsule` stadium · `petal` Juno's petal, a drop leaning 35° with its tight
  end to the upper right like a petal off its stem (two circles joined by
  their tangents; the face sits in its round, lower left, and the needs-you
  notch on the other shoulder). Never Grok's upright teardrop: learn the
  language, never copy the artwork · `bloom` four lobes
  joined by a smooth minimum (a cushion; from 20 to 40 px a rounder
  four-lobe clover of its own construction, `SMALL_SDF`, whose waists are a
  device pixel deep at 20 px, since the cushion's are a third of a pixel
  there and it read as tile) · `spark` the brand spark, concave flanks through
  short blunt tips and a full centre (a body, not the ✨ glyph) · `tile`
  squircle (n 4.4) · `prism` soft hexagon · `halo` a soft gumdrop: a rounded
  triangle, apex up, its sides bowed out a third of the way toward the disc
  and its corners well rounded (never a warning sign), the face in its broad
  lower half. Every body is one closed mass, the same in every state (and at
  every size, bloom's small clover aside): nothing is cut out of it and
  nothing rests on it (halo was once
  a disc with a bite and a ball in it; it healed into a second orb at roster
  sizes and the ball read as a third eye at hero sizes). The nine must tell
  apart at the 30 px picker swatch and in a 20 px row at 1x (every pair's
  soft overlap under 0.95), and only orb may be round
  (tests/agents-face.test.ts). Each is scaled to one visual weight. Fill: the tone token
  `--agent-<tone>`, a notch quieter in dark (globals.css); the eye ink is the
  same in both themes, and every tone clears 5.4:1 against it. No outline,
  gradient, gloss, glow, shadow, catchlight, mouth or brow, anywhere.
- **Eyes**: two cuts in `--agent-ink` (the same in both themes, so an agent is
  the same agent in light and dark), placed on a sphere with a real head frame
  (yaw, pitch, roll): the lean and the narrower far eye come from the
  projection, and on a turn the eyes slide behind the limb. The stored `eyes`
  value is the cut, and every cut is an upright capsule, so nine bodies and
  four cuts still read as one family (a landscape pill reads bored or as
  sunglasses, a thin one as a pause glyph):

  | `eyes` | Cut (w × h, in R) | Split | Picker label (`AGENT_EYES_LABEL`) |
  | --- | --- | --- | --- |
  | `soft` | 0.25 × 0.46, the default capsule | 17° | Soft |
  | `round` | 0.34 × 0.36, a full, short oval | 18° | Round |
  | `tall` | 0.21 × 0.62, long and slimmer | 15.5° | Tall |
  | `wide` | 0.28 × 0.42, set well apart | 26° | Wide-set |

  The four differ by more than a pixel in the pickers' swatches (the studio
  and the hire flow), which show a crop of a 44 px face centred on its eyes
  and turned nearly to face you (`<AgentFace still pose="front">`,
  `frontPose`: yaw 8°, pitch 5°, roll −4°, every swatch of a row the same
  way round, `\`, so the cuts compare): a whole 30 px
  face draws 2 × 4 px eyes and the four would look alike, and at the full
  rest turn the far eye is foreshortened, so every option read as a dot and
  a comma; dead front (the old swatch) drew the Tall cut as two upright bars,
  the iOS pause button. The near turn keeps both eyes close in size, still on
  a sphere: the far eye a little narrower, the pair a little off centre, and
  leaning (below).

  **Never the pause glyph.** Two upright, parallel, equal bars side by side
  read as ⏸, never as eyes. Grok's eyes lean about 26° because its head rests
  rolled on a sphere; Juno's calmer rest leans 10 to 13° the same way, and
  every other pose keeps a floor (`EYE_LEAN`: soft 9°, tall 16°, wide 8°;
  round is not a bar): where a pose would stand a pair of long cuts upright
  (facing you while it waits, looking down at the work, a pointer across the
  face, the pickers), `drawFace` rolls the pair about its middle until it
  leans the agent's way by at least that (`pairRoll`, a soft floor: a pose
  already leaning past it keeps its own lean). The direction is the agent's
  side (`Pose.eyeLean`, blended, so a new look resting the other way turns it
  over smoothly). The tall cut keeps 16°: facing you (waiting, listening,
  looking down at the work) its two eyes are alike and square to the line
  between them, so the lean is the only cue left, and at 12° the pair read
  as ⏸ tipped over (from 44 px no frame has the far eye within 5% of the
  near one's width, no shear and under 14° of lean). Round cuts keep none
  (they are not bars). A state whose eyes
  are not a pair of open bars lets it go **on the clock**, never on a
  threshold of the pose: `Pose.leanW` is 0 in done (the happy capsules),
  blocked (the worry leans the eyes apart), paused and a small face thinking
  (shut), 1 elsewhere, and it blends like any field (let go over the entry's
  own ease, 0.35 to 0.5 s, once the lids are half down or the expression has
  formed; back over 0.3 s, at most about 2.7° a frame, before the eyes are
  bars again). Released by the smile or the lid instead, the steep start of
  their eases dropped the whole roll in 8 to 30 ms: the pair stood upright
  in a frame or two (11° at 160 px) at the end of every run. Between two
  states that both let it go, the eyes never pass through a pair of upright
  bars on the way: a small face out of thinking opens its eyes straight
  into done's capsules; a large one comes back round with its lean and
  lets it go only once they have formed; waking from paused into thinking
  the eyes stay shut as the head turns away; and done's happy lean turns
  over into blocked's worry under the acknowledgement blink (the tilt
  passes upright while the eyes are shut). Never with a blink. It also
  fades as the head turns far enough that the far eye is plainly the
  narrower or near the limb (the spin and the turn into thinking ease in
  and out of it, never flip it in a frame). Checked over every change
  between every two states at 20, 28, 96 and 160 px: no frame is ⏸, and no
  eye's lean or centre moves in one or two frames more than 2.5 times what
  it moves in the frames either side (tests/agents-face.test.ts). Working
  keeps the agent's rest roll and stays turned its own way (yaw 10°) while it
  looks down at the work; listening cocks the head the agent's way. Checked
  over every still, swatch and live frame (with the pointer at its far
  corners) of every state, cut and size from 20 to 160 px
  (tests/agents-face.test.ts).

  Rest pose: yaw 18°, pitch 13°, roll −6° (calmer than Grok's corner),
  mirrored per agent, so half rest looking up-left and half up-right and a
  stage of them never stares into one corner. The side (and the agent's
  pace, below) comes from the agent's identity, a hash of its stored face
  (`faceIdentity`), never from the mount: the server's frame, a roster still
  and the live face rest the same way round, nothing turns after hydration,
  and an agent looks the same way on every load. At 20 and 28 px the face
  looks at you and the cuts are larger, with pixel floors (a closed eye, a
  dash, covers a whole device row at 1x). There the long cuts are shortened
  to at most 1.45 (soft) and 1.75 (tall) times their width, and the pair
  sits about 0.08 R toward the agent's side: two equal upright bars dead
  centre are the pause glyph, and the product draws its own pause glyph
  beside these faces. A lid closes the cut itself rather than squashing it,
  so a blink and paused's dash end round, never in lens points; no
  expression draws a corner (every eye outline turns under 40° between
  neighbouring segments from 48 px). The eyes keep at least a pixel of
  body round whatever is cut into it: the needs-you notch or, with no notch,
  the small faces' working ball on the rim. When an eye comes near one, both
  slide away together, along the line from it to the middle of the pair,
  but never so far that an eye centre comes within 0.1 R of the body's edge:
  a slide, never an eviction. Done lifts the lower lids: each eye becomes a
  squashed capsule about half as thick as it is wide, bowed only a little,
  1.3× wider, its outer end 12° lower (mirrored). At 20 and 28 px it is 1.5×
  wider, set a little further apart, 1.25 dashes thick, never shorter than
  1.6 times its thickness (a stubbier one fills a 3 × 2 pixel square at 1x,
  a blob) where the pair has the room, and bowed by 0.3 of its width, at
  least 0.9 px, so done reads from a still
  in the sidebar rather than as two smaller dots. Same family as the cuts,
  never a `^ ^` caret, and always thicker than paused's dashes. Blocked's
  worry is drawn the same way: the cut itself, shortened (to 0.75 of its
  height, never below a capsule 1.25 times as tall as it is wide) and leaned
  14° with the tops toward the middle (mirrored), so the outer top of each
  eye is the low one. Grok's sad is the same restyle; leaned the other way
  the pair reads cross. An expression's lean levels as a blink shuts the
  eye (over the whole of its closing), so a shut eye is a level dash, as
  Grok's blink squashes the eye on screen: kept, the worry drew `\ /`, the
  angry V, on every blink of a blocked face.

  **The two eyes never touch.** At 20 and 28 px a round cut is nearly as
  wide as the space between two eyes on a narrow seat (spark, capsule,
  halo), and listening's larger eyes, waiting's and paused's widened dashes
  closed it: the pair fused into one blob, or paused into a minus sign.
  There `drawFace` keeps at least 1.25 CSS px of body between the two (on
  the line joining them, the body's own scale counted) in every state: both
  eyes narrow together, never under the 1.8 px floor, and never move, so the
  pair keeps its spacing and each cut its height. Checked over every still
  and live frame of every state, body and cut at 20 and 28 px: never under
  a pixel.
- **Mark**: not drawn. The enum is kept (it is stored and mirrored in the
  native apps); it only tunes rest life: `ring` glances more, `spark` blinks
  livelier, `leaf` slower, `antenna` glances up, `visor` rests half-lidded.
  Neither the studio (no "Detail" row) nor the hire flow's face builder (no
  "Mark" row) offers it, and no picker may (six swatches would look the
  same); nor does the chat (`create_agent` and `update_agent` no longer
  declare `faceMark`, though an older call that sends one is still
  accepted). The stored value round-trips untouched.
- **Labels**: display names only; the stored enums never change. `halo` is
  drawn as a gumdrop and offered as "Gumdrop"; `wide` eyes as "Wide-set".
  The studio and the hire flow use the same labels and the same order
  (Colour, Shape, Eyes), drawn by the same pickers (`SwatchRow` and
  `FaceStatePicker` in agent-profile-fields.tsx: flat tiles with the
  selected fill, and the house segmented control), and preview the same
  states in one row (Ready · Thinking · Working · Needs you · Done). Both
  previews are live: they blink, glance and look toward the pointer. Both
  put the face first, then who it is (its name in the serif, then its
  personality or role), then the states to try, and both carry a new look
  on from where the face is (never a remount): a look picked at rest
  greets with a beat of done, while a state the person chose stays chosen,
  so colours can be compared while it works or asks. The studio is seeded
  from the agent when it opens, never again while it is open (the profile
  re-reads the agent every 5 s, and that must not wipe an edit).

### 4.2 States

Every change blends each field from a frozen snapshot of the old pose with
its own delay, duration and ease: ease-outs, so a change shows in its first
frames (the one ease-in-out is working's deliberate face spin). The body
never overshoots; the one pop is the needs-you ball. Each acknowledgement
hides behind a blink.

| State | What you see | Reduced motion (the still) |
| --- | --- | --- |
| `idle` | rest pose; a `live` face blinks (~240 ms, random, 15% doubled) and now and then lets its gaze drift somewhere new (0.7 s, never a snap; a long drift opens with a blink); nothing floats in between | rest pose |
| `thinking` | large faces turn away, round the back, starting at once and easing out (0.6 s; the eyes are carried off, never flicked: no more than 0.17 R a frame), while the body winds into the middle of three flat dots, so there is no blank beat; the middle one is round (each outline point slides onto the circle at its own angle over the first 62% of the wind-down), so every agent thinks with the same ellipsis, never ●◆● or ●■●, and the turn away still starts from the body's own silhouette. Small faces close their eyes instead (a turn at 28 px is a jump). A wave runs across the dots on the chat's 1.4 s rhythm (from 48 px each agent at its own rate, within ±6%; a face arriving on a page holds its painted dots for a beat of its own, up to one period, before its wave starts, so thinking agents mounted together never pulse as one, even at roster sizes where every wave keeps the chat's exact rhythm). Out of working, the most frequent change in an agent loop, the ring reels into its ball while the head turns away and the ball sinks as the body winds (0.44 s, opaque, never a cut). Coming out, the wave runs on while the dots merge, the body re-inflates over 0.5 s and the face turns back the way it went. Below 48 px the dots span the slot, so a thinking agent keeps the weight of the faces beside it | three dots, middle raised |
| `working` | one action: an acknowledging blink, then the presence ball pops out on the near half of its ring, which passes under every body, at a point of each copy's own between the ring's right end and just past its front (5° to 125° round; 0.25 s), throws Juno's open ring forward round the body in its own direction of travel (0.35 to 0.95 s), the face goes once round the back the same way (0.45 to 1.45 s; not out of thinking, which is already a turn), and it settles looking down at the work, still turned (10°) and rolled its own way, so its eyes keep their lean and its far eye stays the narrower (looking straight down, a tall cut stood as ⏸ inside its spinning ring). Then the orbit turns at 96°/s, each agent at its own pace (±10%, from its identity, so one agent turns alike in the sidebar and the thread header), the eyes follow its ball as it passes in front (from 48 px), and the gaze looks up every few seconds; blinks come less often than at rest (4.5 to 9 s: focus). The ring is a tilted orbit in `--presence`, fitted under each body so its near half passes under it with its cut-paper gap and never across or through it (an arc under the eyes reads as a mouth); the far half goes behind. Its gap is 38°, about a ball's width either side of the ball: the brand's open ring with its ball terminal. As the ring gets short the gap closes, so a ring being thrown leaves the ball itself and a ring reeling in ends inside it (never a stray dash a gap ahead of the ball). Pixel floors: at 48 px a 1.6 px ring and a 2.6 px ball. Below 48 px: no ring, the ball rides just outside the rim and swings over the lower right (24° to 68°), in every frame, and the eyes keep clear of its notch; in the still it is parked at the upper right (−60°), where the logo's ball terminal sits (a ball held still at the lower right is every chat app's online dot, and the upper left is the needs-you notch's), and a live face arriving off that still rolls it down into its swing as its orbit starts (1.2 s, never a jump). Leaving, the ring reels back into its ball at once (an ease-out over 0.32 s) and the ball sinks into nothing as the last of the ring reels in (0.17 to 0.42 s), opaque throughout, as done puts it away: it never hangs beside the body as a lone, fading dot, and no stub of ring is ever left without its ball (whatever is left of a ring that is reeling in fades as the ball goes under half size; a whole ring never does, so a ball dipping to change its paint never ghosts the ring). **Never in lockstep**: every copy is painted with its ball at the same spot, so on a page load each holds it there for a beat of its own (0 to 2 s, skewed short) and then spins up at a rate of its own (time constant 0.63 to 1.17 s). Faces handed one change in one frame (the roster polls every 10 s, so agents that start within one poll window flip together; routines set for the same time do every day) part too: each acknowledges after a beat of its own (up to 0.45 s, and at least 90 ms clear of any other face's entry on the page; never for a state that needs you, a voice turn or a preview a person drives), so no two blink, pop and spin as one, and a fresh orbit pops at a point of its own and spins up at a rate of its own (0.45 to 2 s). Six agents started by one poll: 9% of pairs orbit within 15° of each other at a like speed 2 s later and 14% at 4 s (was 56% and 35%; six balls placed at random would be 8%) | ring with its ball in its gap, in front at the right (small: the ball parked at the upper right) |
| `waiting` | leans in, eyes open to you; the needs-you ball pops once into a notch at the upper left (never Grok's upper-right corner), in `--status-needs-you` (the owner's needs-you ember, `--signal`, as in the sidebar and Activity; never `--attention`, which is for warnings only); the notch's air separates it from a coral or amber body; from 48 px the notch is a cut a pixel wide, not a ring of page round a sticker. The ball pops at 0.2 s; out of the dots at 0.5 s, once the face is nearly home (at 0.2 s a head coming back round is still turned about 70°, its near eye at the body's edge: the notch bit it and then shoved the pair in one frame, up to 4.3 px at 160 px, on agents that rest to the left). Switched between waiting and blocked before a badge has grown (a preview), the old glyph shrinks away before the new one grows: a badge never goes in a frame, nor the notch, nor the eyes it held clear. Below 48 px a working rim ball sinks first, in 0.18 s, so it is gone before the notch opens and the eyes never have two things to keep clear of (a 20 px face once lost both eyes between them). The eyes go to it and back, every 4.2 s at first and then every 16 s (small faces look half as far). **Never in lockstep**: a state that needs you is never held back or staggered, so faces handed it in one frame each answer a beat of their own late instead (0 to 120 ms, from the copy's own noise; blocked too): the acknowledgement blink (unless it joins a blink already under way), the head and eyes, the glances at the badge. The badge (and blocked's stalled orbit from 48 px) is the signal and comes on at once on every face | the ball |
| `blocked` | head tilts and sinks, slowly; the eyes go worried (the cut shortened and leaned, tops in, §4.1: no lid cut, so no corner however long the block lasts). From 48 px no sticker: the orbit stalls, its open ring standing still in `--muted-foreground` with its ball, in `--destructive` (the blocked ink), rolled to rest at the lowest point of the ring. Out of working the running orbit is picked up and runs down: the ball coasts on with the speed it had, decaying (never faster, never back), then, slow, settles the shorter way to the lowest point, never faster than 55°/s, so it rocks back at most once, slowly, like a ball finding the bottom (the face stays on the clock until it has); the ring's paint blends grey over 220 ms, in step with the ball; the ball never blends (blue to red passes a magenta in neither palette): it dips to a third of its size in its old paint and grows back in the new one, changing colour at the bottom of the dip (0.14 s), under the acknowledgement blink, and the same back into working; from anything else it enters calmly, working's entrance without the pop: the stalled ball rises at the bottom (0.15 to 0.5 s) and the ring is drawn out of it, in the stalled paint from the first frame (the paint is set while the orbit is hidden, with no transition, so blocked never flashes the running blue). Leaving, the grey ring reels in and the red ball shrinks with it, so the two reach nothing together and the ball never sits alone under the body. Below 48 px a still bar in `--destructive` sits in a stadium notch, 2.5 balls wide, so blocked and waiting differ by shape and not only by hue; it grows in from 0.25 s, after a working rim ball has sunk (0.18 s). No pop, no loop: a block can last hours | the worried eyes, and the stalled orbit (small: the bar) |
| `done` | from working, the gap closes so the open ring is whole for a moment (0.25 s), then the ring reels into its ball (0.3 to 0.7 s) and the ball sinks into the rim (to 0.83 s): put away, opaque throughout, never faded or thrown outward. The lower lids lift into happy capsules (§4.1) and stay content for as long as the state lasts; after the beat a `live` face lets its gaze drift slowly now and then (no blinks, not even the hover notice, which it answers with its look alone: the capsules hold), so a roster of finished agents is never a row of stickers. The happy capsule forms and lets go as one shape: the thickness it keeps while forming follows the smile continuously and thickens the whole profile about its centre line, so its round ends stay round through every blink and change (it once stepped 3 to 5 px in a frame and drew square-ended bars). Out of thinking it forms once the face is nearly round, and into thinking it lets go before the eyes reach the limb, so it is never seen edge-on | happy capsules, no ring |
| `sleeping` | eyes close to dashes, head drops, and the body goes dormant: a neutral grey with a 14% trace of its tone (`--agent-dormant`, face-local in agent-face.css), clearing 1.8:1 or more on the page and the card in light (level with the amber body, so a paused face never fades out of a 20 px list), dashes in softened ink (4.8:1 in light, 3.3:1 or more in dark; tests/agents-face.test.ts), so paused never reads as done; it holds still. The paint keys off the state as drawn (`data-drawn`), not as requested, so a held change never greys a face that is still working. Waking, the eyes open with the colour, slowly and then fully (0.6 s) | dashes, dormant |
| `listening` | it looks up at you: head tilted 12° the agent's own way (as its eyes lean), eyes wider and higher; their height follows the voice level (`--level` on an ancestor) | tilted, eyes wide and up |

**Rest life vs state motion.** Blinks, gaze drifts and looking toward the
pointer belong to `live` faces (`AgentPresence` turns them on; pickers and
swatches leave them off). Toward a near pointer the eyes follow quickly and
the body leans and rolls a little after them, trailing. Scheduled blinks are
muted for 1.2 s after a change of state (the acknowledgement blink is the
blink). **A change never cuts a blink**: a blink under way when the state
changes (a scheduled one, a glance's, the hover notice, an acknowledgement a
preview interrupts, one carried from the change before, or a look saved
mid-blink) runs on in the new state from where it is (the snapshot records
how shut the eyes are and which way they are going): one closing goes on to
shut and reopens, one reopening reopens, on the blink's own curve. A state
that acknowledges with a blink takes the blink under way as its
acknowledgement rather than reopening the eyes to close them again; only a
blink all but reopened (0.9 open or more) closes again, from where it is (a
double blink, never a jump). How far a blink has got is judged by the
blink alone, never by the lid: a face that rests half-lidded (`visor`,
0.86) is open, and acknowledges like every other (judged on the lid, a
visor agent once entered working, waiting, listening and blocked with no
blink at all). Eyes a lid had closed (paused, a small face thinking) need
no acknowledgement: their opening is it. Into a state that takes the eyes
away (paused and a small face thinking shut them, a large face thinking
turns them round the back) the blink never reopens: how open it was is the
ceiling, and the lid or the turn takes the eyes from there (a large face
once reopened them to full on the way round, then lost them to the limb).
The hover notice is a blink like the others, and joins one under way: a
pointer arriving while the eyes are already blinking, or just before a
needs-you face's late acknowledgement, starts no blink of its own (two
curves multiplied closed the eyes twice), and a second arrival never
restarts one still running. Checked at 240 fps over 7,000 changes landing at every phase of a
blink, at 28 and 96 px, on three bodies and three marks (`visor` among
them): no frame opens the eyes by more than a natural blink does (0.1 a
frame), and no blink restarts; and every mark blinks on every entry that
acknowledges. There is no continuous drift: at rest a face is still between
events. State motion plays on every face, except a `still` face
(`<AgentFace still>`): the still pose and nothing else, for pickers and for
a second copy of a face that is alive elsewhere on the screen, so one agent
never blinks and glances out of step with itself. The larger copy lives:
the thread header's 34 px face is held still while the empty thread's
greeting (88 px) or the profile panel's face (96 px) is up, and lives again
when they go. A face that has been live is held on its own element, never
swapped for a still copy (the swap was a new element, a one-frame cut from
mid-blink to open): its rig eases it into the still frame from where it is
(0.45 s; a blink under way finishes first, the pointer is let go over the
look's own ease, an orbit or the thinking wave coasts to a stop), then asks
for no frames; let go, the state carries on from the still with no entry
beats (`FaceConfig.still`, `holdPose`).

**A new look under a running state** (a colour, shape or eyes pick in the
hire flow, a look saved from the studio while the thread is open) never
jumps. The agent's rest side and pace come from a hash of its look, so a
new look can rest the other way round and keep another pace: rather than
swap them under the running state (the head flipped and the orbit's ball
jumped in one frame), the rig re-enters the same state from where the face
is (`rebaseSegment`), skipping its entry beats (no blink, no spin, no pop),
and every field eases there over 0.6 s (an ease-in-out, so the first frame
after the change is the frame before it). A face turned away (thinking) is
mirrored while its eyes are hidden. A still face's state change rides the paint
transitions; under reduced motion every state is its still pose, and a change
cross-fades over 120 ms from 60% (never a flash). The state is also always said in words
beside the face (aria-label, state sentence); the face is never the only
carrier.

**Changes are smoothed** (`gateAt` in face-rig.ts). The rig holds a request
to enter `thinking` for 250 ms (2.5 s out of working, so a model turn
between two tool calls stays working and the orbit keeps turning), holds a
request to enter `working` out of thinking for 400 ms (a tool blip inside a
model turn never throws a ring), keeps any state on screen for at least
700 ms (1.4 s between thinking and working, whose transitions take about a
second each), never interrupts the working face spin except for a state that
needs you (waiting, blocked: the face comes home from wherever the spin got
to, the same way round, at nearly the spin's own peak, 1000°/s, so an eye is
out front within 0.3 s, before the badge has popped), and applies only the
latest request when that time is up. So the flips of a voice turn, a
streamed reply or an agent loop never play as a flicker (a seeded loop of
reasoning and tool calls shows about 16 changes a minute, down from 28), and
every transition that plays runs to its end. **Pickers and previews skip the
holds**: a face a person drives (`direct`: the studio's 128 px face and the
hire flow's preview) plays each picked state in the next frame, since the
smoothing is for agent loops and a held click reads as a broken control.

**Cost.** One `requestAnimationFrame` clock, one pointer listener and one
IntersectionObserver for the whole page; a face off screen does nothing.
Rest is event driven: a face whose pose is not changing leaves the clock and
sets a timer for its next blink or glance. Frames are written as attribute
diffs with a quarter-pixel dead band. The server renders the still pose of
the state, and on the client the face glides off it over 0.3 s (its orbit
ball moves off the painted spot), so there is no first-frame jump.

### 4.2b The geometry, exactly

The numbers live in code, not here, so the doc cannot drift from them: the
body constructions and weights in `face-shapes.ts`, the eye cuts (`CUT`),
seats, size classes and orbit (`RING`) in `face-geometry.ts`, every state's
pose and timing in `face-rig.ts`. The Swift face (`JunoAgentFace.swift`) is to
be ported from those files.

### 4.3 Where each size is used

20 (sidebar row, notifications, chat byline), 28 (activity and list rows,
pickers), 34–48 (thread header), 64–120 (the Orbit crew, agent page),
128–160 (studio, hire arrival). Four size classes: `xs` ≤ 24 and `sm` ≤ 40
face the viewer, drop the orbit for the rim ball and never spin; `md` ≤ 64
and `lg` draw everything. The Orbit crew draws its faces at 120 px for up to
four agents, 96 for six, 64 beyond, and 72 on a phone.

**The Orbit home draws one object per agent and states each fact once.**
What needs you leads: the Needs you cards, each with the ask itself ("Mira
asked · 2 min ago", then the task or question, never cut, and the way in),
on the neutral hairline (no coloured stripe), with no face (the crew below
shows it), no second "needs your answer" (the heading says it) and a count
beside the heading only when there are two or more. The nuance of the ask
is in the lead's verb ("asked", "needs your approval", "is waiting for your
Mac", "is blocked", "ran out of usage"); the server's state sentence is a
template round the task's title, so under the title it shows only when it
is the agent's own words. Below 40rem the way in sits under the ask. Then the crew (`OrbitCrew`,
orbit-stage.tsx), the real list a keyboard and a screen reader use: one
tile per agent with its live face, its name in the serif, its role, and one
line saying what it is doing in words ("Working on the competitor pricing
brief", "Next: Weekly spend review, Mon at 09:00" for a resting agent with
a routine coming, else "Ready", "Paused", the last with no pause glyph: the
dormant face and the word say it). An agent with a card above carries no
state line (the card says it and dates it); an agent's last activity shows
only on hover or focus, and its ⋯ menu (pin, pause) is revealed in the
tile's corner on hover or focus; on touch, where nothing hovers, it stays
shown at the end of the name's line in the quietest ink, away from the
face (never a row of ellipses at the faces' shoulders, nor beside a
thinking face's dots). There is no second list of the same agents, and no
lede: the tiles' own lines already say who is ready, what runs next and
what is under way. On a phone the crew is two columns of 72 px
faces, so the first screen holds the cards and the whole crew.
Needs-you words beside a face anywhere (the thread header's sentence, the
profile's waiting task) are set in `--status-needs-you-ink`, blocked in
`--destructive-ink`; `--attention` stays for real warnings (the cloud
worker being down).

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
