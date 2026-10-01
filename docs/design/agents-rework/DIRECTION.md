# Agents rework: direction

2026-09-27. Replaces the UI half of `docs/design/agents-v2/`. The runtime from v2 stays:
own computer, chat tools, approvals, receipts, the relay. What changes is the product
shape and every surface a person sees, on web, Mac and iPhone.

## What was wrong

- **It looked like a console.** Mono uppercase labels on every block (NEEDS YOU, GOALS,
  ROSTER (3), STARTING POINT PREVIEW), counters, hairlines under every row, a three-tab
  side panel stacked with five sections.
- **It still made you configure an agent before it existed.** A grid of seven templates,
  a "starting point preview", and a "Set up with a form" escape hatch. Muse, Grok Bot and
  ChatGPT agent all start from a sentence.
- **The agent was a record, not a presence.** Setup was a 700-line form. The face, the one
  thing that made it feel alive, was 20 to 28 px.
- **It broke the house rules:** a "Needs you" pill, a hand badge with a count in the
  sidebar, and approval cards showing plumbing ("Agents · agent_computer").

## The model

1. **You never hire. You ask.** Agents home is one sentence field: *What should be taken
   care of?*
   - Sending it creates a blank agent, opens its thread, and delivers the sentence as the
     first message.
   - The agent names itself, picks its face and role, and sets its first goal with its own
     tools. Then it either starts the job or asks the one thing it cannot guess.
   - The same happens from any chat: "get someone to watch Tokyo fares" → `create_agent`.
2. **The thread is the agent.** A messaging surface with a presence header: the face at a
   real size, the name, and one live sentence. Everything it does, asks or changes lands in
   the transcript: receipts, approvals, task runs.
3. **Configuration is conversation.**
   - The profile sheet shows what the agent is, in prose: its job, what it's working
     toward, when it runs, what it knows, what it can use, how much it asks.
   - Almost nothing in the sheet is a form. The controls are pause, remove an app, forget
     a note, turn the computer off, and retire. Every other change is made by telling it.
   - The sheet says so once: "Change anything by telling Mira."
4. **The computer is a place you can look into, not a tab.** Grok's three levels:
   - a quiet line in the header ("Using its computer");
   - a small live picture-in-picture above the composer while it works;
   - a full-screen view with Take control and Hand back.
5. **Needs you** is the face's waiting state plus accent text with a hand icon. It is never
   a pill, never a count badge.

## Visual language

- **Brand kept:** coral clay accent, Inter for UI, Newsreader italic for the one display
  moment per screen, `AgentFace` shapes and tones.
- **No mono uppercase labels anywhere in Agents.** Section titles are sentence case,
  `text-ui font-medium text-muted-foreground`, or nothing.
- **Space instead of lines.** At most one hairline per group. Cards only where something
  is a real object: a receipt, an approval, an agent tile, the live screen.
- **The signature detail: the halo.** Every face sits on a soft radial wash of its own tone
  (`--agent-<tone>` at about 14%, fading to transparent). You recognise an agent by colour
  before you read its name. It is static; only the face animates, and only for live state.
- **Sizes:** faces at 40 in the thread header, 72 on home tiles, 96 in the profile sheet.
  Minimum 44 pt targets on iOS, 28 on Mac.
- **Copy:** plain, short, no em dashes, 1 to 3 word buttons. Speak about the agent by name.

## Surfaces

### Agents home (web `/agents`, Mac Agents route, iPhone Agents screen)
- A Newsreader italic headline: *Who should take care of it?*
- A large composer: "Describe a job. An agent will set itself up." Enter or the arrow
  sends it.
- Three suggestion lines under it (plain text buttons with an arrow), drawn from the
  templates' first goals. Pressing one fills the composer; it never auto-sends.
- **Your agents:** tiles in a grid (web and Mac), a list on iPhone. Each tile has the halo
  + face (72), the name, and the live sentence.
  - Needs you: accent text "Needs you" with a hand icon, on the tile.
  - Pinned agents first. No role line, no counts, no filters.
- **Empty state:** the composer and the suggestions are the page. There is no template grid.
- `/agents/new` redirects to `/agents`. The form is gone from every surface. The
  API keeps accepting the full body for old clients.

### Agent thread
- **Presence header:** halo + face (40, live) · name (medium) · live sentence (muted).
  - Right side: **Computer** (only when the agent has one) and **Profile**, as icon
    buttons with tooltips.
  - Overflow menu: Pause/Resume, Pin, Duplicate, Retire.
- **Empty thread:** a large face with halo, the Newsreader italic greeting, one line
  "Tell me what to take care of. I'll set myself up.", and three suggestions.
- **Computer picture-in-picture:** when the computer is awake and the agent is using it,
  a 16:10 live tile (about 280 px wide) docks above the composer on the right.
  - It shows the watch view (noVNC, view-only), and one line under it with what it's
    doing.
  - Clicking it opens the **computer overlay**: a full-screen live view with Take control /
    Hand back, and Close. It rests after idle as today.
- **Receipts:** one line each. Face xs · "Mira will brief you weekdays at 8:30" · Undo.
  Details only on disclosure.
- **Approvals for agent changes** read as a question in plain words ("Give Mira its own
  computer?") with one line of why, then Not now / Allow. The connector and tool names
  are never shown.

### Profile sheet (right sheet on web and Mac, sheet on iPhone)
- The top is the display moment: halo + face 96, the name in Newsreader italic, and the
  role in muted text. Then "Change anything by telling Mira." with a Message button that
  focuses the composer.
- Then, as prose sections, each hidden when empty:
  - **Needs you:** open questions and approvals, answerable in place with the existing
    Work cards.
  - **Working on:** the live task, one line plus a link to it in the transcript.
  - **Goals:** a checklist. Checking a goal achieves it.
  - **Routines:** "Weekdays at 8:30: Morning briefing", with a pause toggle.
  - **What it knows:** notes, with a remove button on hover.
  - **What it can use:** apps (remove), its computer (the state in words, Open, Turn off).
  - **How much it asks:** one sentence per autonomy level, and "Ask Mira to change this."
- Footer: Pause, Retire.

## Removed
- The Now · Computer · Setup side panel and its tabs.
- `AgentStart`'s template grid.
- The hire form (web, Mac sheet, iPhone sheet).
- `TeamStatus` in the header.
- The sidebar count badge.
- Every mono uppercase label in Agents.
