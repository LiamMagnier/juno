# Agents v2 — audit: Juno Agents vs Grok Bot, Meta Muse and OpenMuse

September 26, 2026. Written by the mentor (Claude) from eleven research and code
investigations. Sources are the vendors' docs and reviews listed at the end, and the
Juno code on `design/premium-pass` (which becomes `main` before this work starts).

The owner's verdict on today's Agents: *"it doesn't feel like a real product, only a
design interface."* The audit agrees, and says exactly why.

---

## 1. The one-paragraph answer

Juno's Agents are an **identity layer with no body**. Each agent has a name, a face, goals,
notes and routines. But its work runs in a throwaway headless browser that loads no
images and is killed at the end of every run. It has no shell, no files, no logins
that last, nothing to watch and nothing to take over. It cannot configure itself. Its
own brief and memory never reach the runs that do its work, and what those runs
produce never comes back to its thread. Grok Bot and Muse are built around the
opposite: **a real computer of its own that keeps working without you, which you can
watch and take over, and an agent you set up by talking to it**. Juno's safety
machinery (approvals, budgets, audit) is stricter than both. What it lacks is the body
and the conversation.

---

## 2. Side by side

| | Grok Bot (SpaceXAI) | Meta Muse | OpenMuse (CopilotKit, open source) | **Juno today** |
|---|---|---|---|---|
| Unit | Named Bots, a roster (≈50/account) | One personal agent | One agent per install | Named agents (24/account) |
| **Own computer** | One Firecracker VM **per user, shared by all Bots**: Debian, Chrome, terminal, `/workspace`, keeps running | Secure VM **per user**: Chromium, filesystem, terminal, background jobs, backups | Self-hosted Playwright worker + a Docker container per owner (no GUI desktop) | **None.** A per-run headless Chromium on the web server, text only, closed on pause/finish. No shell, no files. |
| Logins that persist | Yes (buggy across Bots) | Yes, plus a credential vault | Cookies per browser profile | **No.** Every run starts signed out. |
| Live view | Pinned side panel, then full-screen | In-chat mini-browser | 2 s PNG polling console | **No.** "Its computer" is a list of tool rows. |
| Take over (login, 2FA, CAPTCHA) | "Take over" → "I'm done" | "Take control" (agent pauses) | Click/type console | **No.** |
| Configure by chatting | Yes: "setup is a message"; `CreateAgent`, `UpdateAgent`, routines and skills by chat; changes show as cards | Yes: name, tone, look, memories, reminders, connectors by chat; "go back to default" | Partly: memories, goals, watches, tasks by chat; identity form-only | **No.** A 47-control hire form, a long Profile form, 5 tabs. |
| Changes shown as objects in the chat | Yes ("Created Routine: Morning Briefing") | Yes (cards, approvals outside the chat) | Yes (tool cards with deep links) | Only the Work run panel and the task/handoff approval cards. |
| Agent identity reaches its work | Yes | Yes (Soul/Identity/Memory files) | Task agent: yes | **No.** Brief, style, notes and goals stop at the chat turn; runs never read them. |
| Results flow back | Same thread | Same chat | Thread cards + "An update for you" | **No.** Later turns don't know what a run produced. |
| Agent keeps its own memory | Markdown on its computer (not inspectable) | Yes, inspectable and editable | Records, editable | Reflection writes ≤2 notes per 6 h from task *titles*; the agent never writes notes. |
| Approvals | Allow once / Always / Deny, auto-review rules | Sentinel cards outside the chat; scopes once/task/site/always | Hash-bound proposals | **Stronger than all three**: digest-bound, policy-bound, expiring, a floor nothing silences. |
| Budget binds autonomy | Weekly quota; no spend cap mid-run | Weekly tokens | None | **Stronger**: 5-hour and weekly windows enforced at dispatch and mid-run. |
| Routines | 50/Bot, clocks + events, test run | Upcoming | Monitors | Automations (clocks, email/CalDAV events, API); agent page offers only 5 clocks and edits elsewhere. |
| Goals / Ideas | Via chat | Goals, Ideas, Feed | Goals, Ideas | Goals, Ideas (reflection) |
| Group chats / bot-to-bot | 2–6 Bots, @mentions | — | — | One-way handoff behind a card. |
| Skills | Library, **teach by demonstration** | Built in | — | Versioned skills, GitHub import (stronger); no demonstration. |
| Model choice | None | None | Any | Any, per agent (stronger). |
| Avatar as status | Yes (eyes) | Yes (laptop / orb props) | Mascot + status line | Yes (face with states) — the most finished part today. |
| Surfaces | Desktop apps, iOS, Android | Web, iOS, Android, WhatsApp, Mac | Web + mobile (Expo) | Web, Mac, iPhone (native), push everywhere. |

---

## 3. Where Juno is weaker (ranked by how much it hurts)

1. **No computer of its own.** This is what makes it feel like a demo. Grok and Muse can
   log in, stay logged in, click through real sites, run code and keep files. Juno's
   agent reads pages as text and forgets everything each run.
2. **No live view and no takeover.** You can't watch it work, and it can't hand you a
   login or 2FA step. So it can never get into anything that needs an account.
3. **No configuration by conversation.** Everything goes through forms: a 47-control
   hire page, a long Profile form, routines edited in Automations. Grok and Muse are
   set up by talking.
4. **Identity doesn't reach the work.** The runs that do the job never see the agent's
   brief, style, goals or notes, and their results never come back to its thread.
5. **Page-first UI.** Every entry point lands on a 5-tab page with a 96 px face and a
   long form. The thread, where the work happens, is one click away and gets a single
   28 px header row.
6. **No change cards.** When something about the agent changes, nothing appears in the
   transcript. Grok's and Muse's chats show every change as an object you can open or undo.
7. **The agent never writes its own memory.** Notes come from the owner or from
   reflection over task titles.
8. **Pause is cosmetic in the thread (bug).** A paused agent's thread still starts tasks
   under its name.
9. **Little per-agent customization beyond the face**: no notification preference per
   agent, no pin/reorder, no duplicate, and model/effort are hidden in the Profile form.
10. **No group rooms, no teach-by-demonstration, no credential vault or single-use
    payment cards, no messaging from outside the app.** These are deliberately deferred
    (§5).

## 4. Where Juno is already stronger (keep all of it)

- Approvals: digest-bound and policy-bound cards that expire, a floor (send, publish,
  pay, delete, account settings) that nothing silences, and "always allow" refused for
  irreversible actions.
- Budget windows that bind every autonomous run mid-flight. Grok has no cap that stops
  a run.
- Per-agent isolation (v2 keeps this: **one computer per agent**, never shared, the
  opposite of Grok's shared VM, whose own docs say "don't treat Bots as a security
  boundary").
- Inspectable, editable, encrypted memory. Grok's memory can't be seen or edited.
- Model choice per agent, a plan state machine with structural validation, versioned
  skills from GitHub, realtime voice that speaks as the agent, push to iPhone, Mac and
  browsers.

## 5. What Agents v2 builds (the brief) — and what it defers

**Builds:**
- **Its own computer.** One E2B Desktop sandbox per agent (Ubuntu, XFCE, real Chrome,
  shell, files). It pauses when idle, keeping memory, disk and logins, and it is never
  shared between agents.
- **Live view and takeover.** Watch it work in a side panel and take control for
  logins, 2FA or CAPTCHAs. View-only is enforced on the server.
- **Real actions on that computer.** A DOM-level browser in the persistent Chrome (same
  risk ladder as today: submit and purchase always ask), pixel control for anything
  else, shell and files, and screenshots the model can actually see.
- **Configuration by conversation.** Hire by chatting. Rename, restyle, change the face,
  set goals, routines and memory by chatting. Anything that widens what the agent may
  do (autonomy up, new apps, the computer, unattended routines) goes through a
  deterministic card. Every change appears in the transcript as a card with **Undo**.
- **Identity in every run and results back in the thread.** Runs get the brief, style,
  goals and notes. The thread's next turn knows what the last tasks produced.
- **Thread-first, condensed UI.** The agent's home is its chat, with a side panel:
  **Now · Computer · Setup**. A compact roster list. Hiring is a conversation (the
  form stays as a fallback).
- **Customization.** Per-agent notifications, pin, duplicate, model and effort, look
  changed by asking.
- **The pause bug fixed**, and native parity (watch and take over on Mac and iPhone)
  where the builds stay green.

**Deferred:**
- group rooms;
- teach-a-task recording;
- a credential vault or password-manager fill;
- single-use payment cards;
- WhatsApp or Telegram access;
- uploaded or generated avatar images.

---

## Sources

**Grok Bot**
- docs.x.ai/grok-bot:
  - overview
  - bots
  - chat-and-collaboration
  - computer-and-apps
  - skills-routines-and-automations
  - settings-and-notifications
  - approvals-security-and-privacy
  - security-faq
  - troubleshooting
- x.ai/news posts:
  - introducing-grok-bot
  - designing-grok-bot
- forum.cursor.com Grok Bot threads
- atomicbot.ai/blog/what-is-grok-bot
- datacamp.com/tutorial/grok-bot-tutorial
- flaviocopes.com/grok-bot
- cellcog.ai/blog/grok-bot-problems

**Meta Muse**
- mindstudio.ai/blog/meta-muse-ai-agent
- about.fb.com/news/2026/09/introducing-muse-personal-ai-agent
- research.meta.ai security blog
- introducing.muse.ai
- Meta Help Center pages
- TechCrunch (Sept 8, 23, 25)
- Slate
- Lenny's Newsletter

**OpenMuse**
- github.com/CopilotKit/OpenMuse: README, docs, and the code under apps/server, apps/worker and apps/mobile

**E2B**
- docs.e2b.dev: persistence, connect, list, network, template
- @e2b/desktop 2.4.0 source
- e2b.dev/pricing
