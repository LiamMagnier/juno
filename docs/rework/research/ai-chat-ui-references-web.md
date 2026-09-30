# AI chat UI on the web: reference study for the Juno Refoundation

Written 2026-09-30 for the web part of the Refoundation (PRODUCT_REFOUNDATION §4.1, §5, §6, §7, §8, §9, §10). It answers one question, moment by moment: **what does premium look like in an AI assistant on the web today, and what is slop?**

The owner's rules apply throughout:
- no status pills, badges or decorative dots;
- native Liquid Glass on Apple platforms (this file covers the web);
- nothing consequential happens without a deterministic approval.

Companion file: `ai-chat-ui-references-ios.md`, which covers iPhone.

## 0. How this was researched, and its limits

**Mobbin was not available.**
- On 2026-09-30, `search_screens` (deep and standard mode) and `search_flows` both returned "Mobbin MCP requires a paid plan. Upgrade at https://mobbin.com/pricing to continue."
- This file therefore has **no `mobbin_url` citations**.
- If the plan is upgraded, rerun the moment list in §2 as Mobbin queries (web platform) and add the results to the board.

**What I used instead.** Each claim carries one of these labels:

| Label | Meaning |
|---|---|
| **[CAP]** | I captured the page on 2026-09-30 with headless Chrome (Playwright, `channel: chrome`, 1440×900 @2x) from a public, signed-out page. I looked at the image myself. The URL of every file is in §5. |
| **[DOC]** | A first-party help, docs or blog page, read on 2026-09-30. |
| **[INT]** | A sibling research file in this folder (`openai.md`, `anthropic.md`, `xai-grok.md`). Each of those cites its own primary URLs, all read on 2026-09-30. |
| **[3P]** | A third-party article or library, labelled with its date where it has one. |
| **[MEM]** | My knowledge of the product from before mid-2026, not re-checked this session. **UNVERIFIED** for today's UI. |

**Caveats.**
- **Signed-out captures only.** I cannot sign in, so logged-in states come from vendors' own staged renders: marketing pages, and the UI illustrations on learn.chatgpt.com. That actually suits the question, because these renders show each company's *intended* premium face. It also means they are idealised and show no failure states.
- **Pages I skipped rather than got around:**
  - Behind a Cloudflare "Just a moment…" challenge: chatgpt.com, chatgpt.com/overview, perplexity.ai (home and /comet), claude.ai, chat.mistral.ai, lovable.dev, genspark.ai, poe.com.
  - Behind a terms-consent wall I did not accept: meta.ai.
  - Sign-in wall: copilot.microsoft.com.
  - Error page: chat.deepseek.com.
- **Nothing here shows motion.** Motion claims cite a doc, or are marked MEM or "implied".
- **Name change.** Le Chat now redirects to **Mistral Vibe** ("formerly Le Chat", mistral.ai/products/vibe, [CAP]).

**The board.** 37 high-resolution PNGs live in
`/private/tmp/claude-501/-Users-liammagnier-Developer-project-juno/9a242067-f03a-4200-acec-6b9eafa8d677/scratchpad/refs/web/`.
- Files are named `<moment>__<app>.png`.
- `_index.png` is a contact sheet of all of them.
- The folder is session scratch space. Copy it somewhere durable if the board should outlive this session.

---

## 1. The twelve patterns that separate premium from slop

1. **The model control is one quiet line of text.**
   - It reads model name in primary ink, then effort in secondary ink, then one chevron:
     - "Opus High" (Claude, `composer__claude.png`)
     - "6 Sol Medium" (ChatGPT, `composer__chatgpt-goal.png`)
     - "Instant High" (Kimi, `composer__kimi.png`)
     - "Claude Opus 5 High" as the chat subtitle (Raycast, `tool-calls__raycast.png`)
   - It has no pill, no logo and no border. Two dimensions share one control.
2. **At rest, the composer holds about four objects.**
   - Left: `+`.
   - Right: the model control, the microphone, and a send button that becomes a **stop square** while the model works (ChatGPT, Dia, Linear).
   - Nothing is permanently armed.
3. **Context is an object inside the sentence.**
   - It is drawn with the thing's own mark and appears both in the draft and in the sent bubble: "Are there any new bugs reported in [◐ Linear]?" (Raycast).
   - After sending, a quiet receipt confirms what was resolved: "◐ DRV-364 added to context" (Linear).
4. **The work trace is typography, not boxes.**
   - Cursor: "Thought 4s / Read AppManager.tsx / Searched expose patterns", with the verb in secondary ink and the object in tertiary ink.
   - Raycast: "Checked new bugs in Linear 3".
   - When the work is done, the whole trace collapses to "Worked for 10 sec ▸" (Linear).
   - Only real outputs get a container, such as the file chip "feature-prd.md +68".
5. **Slop speaks machine and wears pills.** Examples:
   - Raw function names: `database_query`.
   - Coloured status badges: "Awaiting Approval", "Running", "Completed".
   - "PARAMETERS {}".
   - Generic "This tool wants to…" approvals with a blue Approve button on a delete.
   - All of these appear in the default AI Elements components (`tool-calls__ai-elements-tool.png`, `approvals__ai-elements-confirmation.png`).
6. **Long work docks to the composer.**
   - ChatGPT's goal row is a tab on the composer's top edge: "Paused goal · Migrate this codebase… · 10h 9m · ✎ ▶ 🗑 ›".
   - State is a word, not a dot.
7. **Questions are first-class objects.**
   - Cursor asks with a checkbox card ("[x] Real-time metrics / [ ] System status") and Skip / Continue buttons, not a paragraph.
   - The sidebar groups work by what the person must do: "READY FOR REVIEW 5".
8. **Deliverables open beside the chat as documents.** They have tabs, a breadcrumb and editorial type.
   - Cursor: `artifacts__cursor.png`.
   - Claude artifacts, ChatGPT previews with "point at a part to revise", and Gemini's Canvas panel all do the same [DOC].
9. **The empty home is one sentence, one composer and air.**
   - Examples: Grok, ChatGPT, Gemini, Qwen.
   - The placeholder is the teacher: "Type @ to search your apps" (Grok).
   - Slop is generic starter chips ("How many Rs are in the word 'strawberry'?", t3.chat), mode-chip rows and blocking promo modals (Manus).
10. **Voice lives in the thread.**
    - An orb and a one-word state ("Listening") sit above a composer that stays in place ("Add to the conversation", mute, speaker, end).
    - Tool lines keep arriving as quiet checkmarks.
    - Approvals are never spoken (ChatGPT [CAP] [INT]).
11. **Citations read as provenance.**
    - Use a domain or app chip ("example.com +5"), a hover card with title, snippet and deep link, and source cards that carry the app's mark (Dia: Slack, Gmail).
    - Never put footnote dumps at the end. Never draw chips for unsourced text ([3P] aydesign 2026-09-11).
12. **Restraint is the system.**
    - Linear's 2026 refresh: "Don't compete for attention you haven't earned" and "Structure should be felt not seen". The sidebar is dimmer than the content, icons are fewer and smaller, there are no coloured icon backgrounds, greys are warmer and borders are softer ([DOC] 2026-03-12).
    - Motion is fast, ease-out and interruptible. Frequent and keyboard-triggered actions do not animate at all (§3).

---

## 2. Moment by moment

For each moment:
- **Best** lists the two or three strongest executions and says precisely why they read as premium.
- **Slop** names what to avoid.
- **For Juno** ties the finding back to the refoundation spec.

### 2.1 Empty home + composer

**Best**

- **Grok, grok.com** [CAP] (`home__grok.png`, `home__grok-dark.png`)
  - The page holds one bold question, "What should we explore?", then a composer card, then legal text in the footer.
  - The **placeholder rotates to teach**. The light capture read "Switch to Build Mode to create apps (AI Agent)"; the dark one read "Type @ to search your apps (AI Agent)".
  - The model is a word, "Fast ⌄", in secondary grey. The send circle stays tinted and disabled until there is text.
  - The background is warm off-white, not blue-white. There are no chips.
  - Why it works: every pixel is either input or orientation, and discovery lives in the placeholder, where the eye already is.
- **ChatGPT web, learn.chatgpt.com illustration** [CAP] [DOC] (`home__chatgpt.png`)
  - The heading "What should we work on?" is centred. The composer ("Work with ChatGPT") has `+` in a hairline circle on the left, and a mic and a black send circle on the right.
  - A **Chat | Work** segmented control sits top centre. Juno should not copy this: §2 of the refoundation decided on one conversation, not modes.
  - The sidebar:
    - an icon rail;
    - a "ChatGPT ⌄" title with search and collapse icons;
    - a filled "New chat" row;
    - section headers ("Projects", "Recents") whose "… +" actions sit on the header line;
    - recents as plain text rows with no icons, times or badges.
  - The composer shadow is very soft and wide. The composer is taller than one line even when empty, which signals that long input is welcome.
- **Gemini, gemini.google.com (signed out)** [CAP] (`home__gemini.png`)
  - "Meet Gemini, your personal AI assistant" sits over a single pill composer: "+ Ask Gemini … Flash-Lite ⌄ 🎙".
  - A soft radial blue glow sits *behind* the composer as ambient light. It is not a border effect.
  - Note for Juno's "glow = state" rule (premium pass 1.8.x): Gemini's glow is ambience. Juno should keep glow meaningful, meaning it lights up only when something is happening.

**Also seen**

- **v0** [CAP] (`home__v0.png`): "What do you want to create?", a composer ("v0 Max ⌄" and a mic) and four starter chips with a shuffle icon, then a template gallery. This is right for a builder and wrong for an assistant.
- **Kimi** [CAP] (`home__kimi.png`): the composer ("Instant High") has a **tray that slides out beneath it** ("Select project", "Plugins"), then a mode-chip row: Slides, Deep Research, Docs, Build, Sheets, Design. The tray idea is good. The chip row is the noise that Juno's `/` palette replaces.

**Slop**

- **t3.chat** [CAP] (`home__t3chat.png`)
  - "How can I help you?" with four category pills (Create, Explore, Code, Learn) and four generic questions, including "How many Rs are in the word 'strawberry'?".
  - A pink-tinted gradient and a terms toast floating over the composer.
  - A composer chip row carrying price glyphs ("Kimi K2 (0905) $$ · Instant · Search · Attach").
- **AI Elements chatbot example** [CAP] (`home__ai-elements-chatbot.png`): a horizontal carousel of generic suggestion chips ("What are the latest trends in AI?"). This is the default most AI apps ship.
- **Manus** [CAP] (`home__manus.png`)
  - A fresh, signed-out visit got a blocking modal: "Restore your account? Your account was deleted… claim your welcome back bonus".
  - The capture came from a clean headless profile. It may be a targeting bug, but it is what a new visitor saw, and it is a dark pattern.
- **Meta AI** [CAP]: a full consent wall before any UI.

**For Juno (§5)**
- Keep the one-line greeting and zero generic suggestions.
- Make the **placeholder the teaching surface**, rotating among "@ a crew member, file or app" and "/research, /deck".
- Show at most three state-derived suggestions, as plain text rows below the composer, never as chips.
- [MEM] On first send, ChatGPT and Claude move the composer from the centred home to the bottom dock. Juno should make that a single shared-element transition (about 250 ms, ease-out) so the field never jumps.

### 2.2 Composer: attachments, context chips, @ mentions

**Best**

- **Raycast AI** [CAP] (`tool-calls__raycast.png`, `composer__raycast.png`)
  - The sent message contains an **inline app token**: "Are there any new bugs reported in [◐ Linear]?". The token is a small rounded rectangle, at the same type size as the sentence, with a slightly raised fill and the app's own mark.
  - The placeholder teaches both palettes at once: "Ask anything, @ tools, or / for commands…".
  - This is PRODUCT_REFOUNDATION §5 almost exactly, shipped.
- **Linear agent panel** [CAP] (`thinking__linear.png`, `composer__linear.png`)
  - Under the user's bubble, right-aligned and grey, a receipt reads "◐ DRV-364 added to context". Context is confirmed *after* send, where the eye goes next.
  - The composer holds "Reply…", "Skills ⌄" on the left, and full-screen and attach icons on the right. While running, the send button becomes a stop square in a circle.
- **ChatGPT, learn.chatgpt.com illustration** [CAP] (`composer__chatgpt-goal.png`)
  - One row, grouped by role:
    - left: `+ | Auto-review ⌄ | Goal`, meaning who approves and what mode, with the approval mode in the accent colour;
    - right: `6 Sol Medium ⌄ · 🎙 · ■`, meaning which model, then input, then act.
  - A goal row docks above the composer (see §2.8).
- **Claude, claude.com marketing composer** [CAP] (`composer__claude.png`)
  - Only `+` on the left. "Opus High ⌄" and a rounded-square terracotta send button on the right.
  - The prompt is set at a comfortable reading size, about 17 px by my estimate from the capture.

**Also good**
- Grok's teaching placeholder "Type @ to search your apps" (`composer__grok.png`).
- Dia's "Ask another question…" with `+`, mic and an **amber stop square** while answering (`composer__dia.png`).

**Attachments** [MEM, UNVERIFIED]
- ChatGPT and Claude show attachment tiles *inside* the composer above the text, with a thumbnail or file-type glyph, a progress ring while uploading, and an × that appears on hover.
- Dropping a file on the page shows a full-window drop target.
- Pasting a long text turns it into a "pasted" tile instead of flooding the field.

**Slop**
- **AI Elements Prompt Input default** [CAP]: "+", a "Search" globe toggle, a "GPT-4o" pill and a blue enter-key button. Permanently armed toggles sit as chips in the composer, which §5 forbids.
- t3.chat's chip row with price glyphs (above).
- Styled text that pretends to be a mention but is not structured data, so a backspace eats half a token. [MEM] This is common in homegrown composers.

**For Juno (§5)**
- Draw tokens identically in the draft and in the sent bubble (Raycast).
- Add a one-line **resolution receipt** under the sent bubble (Linear), for example "Q3 Forecast.xlsx and Stripe added · Mira takes the renewal risk".
- Put the approval-ahead note on that same receipt line: "Posting to #design will ask you first".
- Backspace next to a token selects it first, then deletes it on the second press.

### 2.3 Model picker

**Best**
- **Claude** [CAP] "Opus High", **ChatGPT** [CAP] "6 Sol Medium" and **Kimi** [CAP] "Instant High" share the same grammar: name in ink, effort in secondary ink, one chevron, no container. The control is small, reads as a phrase, and carries two dimensions.
- **Raycast** [CAP] writes the model into the chat header subtitle, "Claude Opus 5 High". Each conversation records its brain, which helps later when reading history.
- **ChatGPT "Model selection" guide** [CAP] [DOC] (`model-picker__chatgpt.png`)
  - Three named models, each with a one-line purpose and a short use line: "Astra: State-of-the-art intelligence", "GPT-6.1 Sol: Optimized and high-performing", "Luna: Smart and efficient".
  - Below them sits a recommender: work type, then task type, then a slider from "More usage" to "Higher quality outputs", then "Recommended model: Luna · Reasoning effort Medium".
  - This is the right shape for Juno's **All models** sheet (§6), not for the popover.
- Context from [INT] `openai.md`:
  - ChatGPT moved model selection into the composer, with effort inside the picker, on 2026-04-28.
  - It retired automatic Instant-to-Thinking switching on 2026-09-14. Depth is an explicit user choice again.

**Slop**
- **AI Elements Context meter** [CAP] (`model-picker__ai-elements-context.png`): a raw "31.3% ◌" of the token window as an ambient signal. That is engineering telemetry.
- Cursor CLI's footer "GPT-5.6 Sol Extra High Fast · 8% · 5 files edited" [CAP] is fine in a pro terminal (Juno Code) and wrong in Chat.
- [MEM] First-layer model grids with speed and intelligence bars and per-token prices (t3.chat, Poe).

**For Juno (§6)**
- The control reads "Auto", or "{short name} {Effort}" with the effort in secondary ink.
- The popover is a short list, each row with one line of purpose, and effort as a segmented control (Light · Standard · Deep) under the list.
- The conversation header subtitle records the model used.

### 2.4 Streaming answer + thinking/reasoning

**Best**
- **Cursor Desktop** [CAP] (`thinking__cursor.png`)
  - The reasoning and tool trace are three short lines: "Thought 4s", "Read AppManager.tsx", "Searched expose patterns". The verb is in secondary ink, the object in tertiary, at about 13 px, with no icons, borders or backgrounds.
  - Then the only boxed element: a file chip, "📄 feature-prd.md +68", with the diff count in green.
  - Then prose resumes: "Drafted implementation steps in `feature-prd.md`. A few quick questions before I start building:".
- **Linear** [CAP]: the finished run collapses to "Worked for 10 sec ▸" in grey, above the answer. It is a disclosure, not a panel.
- **Behaviour baseline, AI Elements Reasoning** [DOC] [CAP] (`thinking__ai-elements-reasoning.png`): it "automatically open[s] during streaming and clos[es] when finished", with the label "Thought for 4 seconds ⌄". The behaviour is right; the look is generic.
- **Streaming text**
  - **Streamdown 2.2** (Vercel) [DOC] [3P]:
    - an `animated` prop gives a per-word fade;
    - "Remend" completes unterminated Markdown so half-written bold, lists and links never flash raw syntax;
    - a built-in caret;
    - a March 2026 fix (PR #474) makes code fences animate with the surrounding prose instead of popping in all at once.
  - Libraries that copy Claude and ChatGPT pacing (StreamingText, flowtoken) [3P] describe **adaptive pacing**: a steady cadence that speeds up when the backlog grows, so the display never lags the network by more than a few seconds. The exact values Claude and ChatGPT use are UNVERIFIED.

**Slop**
- Spinner plus "Thinking…" with no end.
- Raw chain-of-thought dumped into a bordered grey box (`thinking__ai-elements-cot.png` shows the step-list version: search-result pills and inline images; better, but heavy).
- Auto-scroll that yanks readers who have scrolled up.
- Markdown that flashes `**` or `|---|` mid-stream.
- A blinking caret that keeps blinking after the stream ends.

**For Juno**
- While live, show one line with a shimmer ("Thinking", then the current step in plain words).
- When done, collapse it to "Thought 12s ▸" or "Worked 2m ▸".
- Fade each word in over about 120–180 ms with buffered pacing.
- Stick to the bottom only while the reader is at the bottom. Otherwise show a "↓ New" affordance.
- Code fences stream in the same rhythm as prose.

### 2.5 Tool calls and source citations

**Best (tool calls)**
- **Raycast** [CAP] (`tool-calls__raycast.png`): "Checked new bugs in Linear 3". Stacked app marks, a past-tense human sentence, a small count, grey, one line.
- **ChatGPT voice illustration** [CAP] (`voice__chatgpt.png`): "✓ Reviewed the latest Codex voice components / ✓ Found the realtime voice stage and composer", with small green checks and secondary text.
- **Cursor** [CAP]: as in §2.4. Verb plus object, no chrome.

**Slop (tool calls)**
- **AI Elements Tool** [CAP] (`tool-calls__ai-elements-tool.png`)
  - Every call is a bordered accordion: wrench icon, raw function name `database_query`, and a **coloured status pill** reading "Pending", "Awaiting Approval", "Responded", "Running", "Completed" or "Error".
  - When expanded it shows "PARAMETERS {}".
  - It breaks both owner rules, pills and machine language, and it is the default that most AI Elements and shadcn-based products ship.

**Best (citations)**
- **Perplexity** [MEM] [3P aydesign 2026-09-11]: a source strip above the answer, inline chips after sentences, and a hover card with title, snippet and deep link. The citation UI sets the category baseline.
- **AI Elements Inline Citation** [CAP] (`citations__ai-elements-inline.png`): a **domain chip at the end of the claim**, "example.com +5", which opens a carousel hover card. A domain name reads as provenance; "[3]" reads as homework.
- **Dia** [CAP] (`citations__dia.png`): for personal data, sources are small cards that carry the app's mark (a Slack thread thumbnail, a Gmail envelope), each with a two-line description, under a section label "Fall marketing summit plans ›".

**Slop (citations)** [3P aydesign]
- A footnote dump at the end.
- Paragraph-level citations that hide which claim is unsourced.
- Chips drawn for unsourced content: "a trust-killer".

**For Juno**
- A tool line is a sentence with the app mark: "Read 3 files in Drive", "Posted to #design", "Checked Linear".
- A citation is a domain or app chip with a hover card.
- Juno's citation audit is a real differentiator ([INT] `openai.md` §2.10). Its visible form should be a quiet "2 claims unsourced" line, never a warning badge.

### 2.6 Code blocks and copy

The evidence here is thin: I made no logged-in captures.

- **AI Elements CodeBlock** [CAP] (`code__ai-elements-code-block.png`): a filename header ("greet.ts"), a language selector ("TypeScript ⌄"), a copy icon, optional line numbers, and dark mode.
- **Cursor** [CAP] (`artifacts__cursor.png`): code and documents open in a tabbed pane with a breadcrumb ("Plans › feature-prd.md"). Sidebar rows carry diff counts, "+20 −3", in green and red.
- [MEM, UNVERIFIED] Claude and ChatGPT:
  - a sticky header with the language on the left and copy on the right;
  - the copy icon morphs to a check and "Copied" for about 2 s, with no toast;
  - ChatGPT offers "Edit", which opens the block in canvas;
  - long blocks scroll horizontally inside the block, never the page.

**Premium details to adopt**
- The header stays sticky while you scroll a long block.
- Copy morphs copy → check with a 150 ms crossfade, then reverts after 1.5–2 s.
- The syntax palette uses three or four hues on a neutral base, not a rainbow.
- Numbers use tabular figures.
- Streaming renders code incrementally (the Streamdown fix above).
- The block has no drop shadow; it gets one tonal step of surface.

### 2.7 Artifacts / canvas side panel

**Best**
- **Cursor Desktop** [CAP] (`artifacts__cursor.png`)
  - Three columns: a sessions sidebar, the transcript, and a **document pane**.
  - The document pane has file tabs with ×, a breadcrumb and editorial typography (H1 "Mission Control Interface", H3 "Trigger").
  - The artifact is presented as a document you would hand to someone, not as a card in the chat.
- **Claude** [DOC] (support.claude.com, "Updated this week")
  - Artifacts open "in its own window beside your conversation". An **Artifacts** tab in the sidebar collects them.
  - Templates: Docs, Slides and Design.
  - **Export** per type: Docs to Word, PDF, Markdown or Google Docs; Slides to PowerPoint or PDF; Designs to .zip, PDF, PowerPoint or HTML.
  - On an error there is a "Try fixing with Claude" button.
  - "The first time an artifact needs a connected app, Claude shows which apps and tools it will use and asks you to approve them."
- **ChatGPT** [DOC] (learn.chatgpt.com, "Work with files"): deliverables preview beside the chat. You can "point at a specific part of a supported preview and request a focused revision". HTML switches between preview and source.
- **Gemini** [DOC]: Deep Research reports open in the "Canvas panel", with "Create › Audio Overview" and "Share & export": "Share Canvas", "Export to Docs", "Copy Contents".

**Slop**
- **AI Elements Artifact** [CAP] (`artifacts__ai-elements-artifact.png`): a bordered code card with five unlabelled icon buttons (run, copy, regenerate, download, share) and no hierarchy between them.

**For Juno (§10)**
- The pane shows the document at reading width with a title, owner and version.
- **One primary verb** (Share), with Publish, Export and Duplicate in an overflow.
- **Point-to-revise** annotation, as in ChatGPT.
- A version scrubber, where each version is immutable.
- Errors get a single "Fix it" verb that writes the error into the composer, as in Claude.

### 2.8 Agent / task progress and approvals

**Best**
- **ChatGPT goal row** [CAP] [DOC] (`composer__chatgpt-goal.png`)
  - The row reads "Paused goal · Migrate this codebase from JavaScript to TypeScript. Th… · 10h 9m · ✎ ▶ 🗑 ›".
  - It is a tab attached to the composer's top edge. State is a *word*, elapsed time is a number, and the verbs are icons.
  - Context from [INT] `openai.md`:
    - Pause, Stop and Cancel are named separately, and stopping undoes nothing.
    - Approvals offer **Approve / Always approve / Tell Codex what to do / Deny**. The redirect is a first-class answer.
- **Cursor** [CAP] (`agent-progress__cursor.png`, `thinking__cursor.png`)
  - A question card: "Question — What data should the mission control display? [x] Real-time metrics [ ] System status", with **Skip / Continue**.
  - Delegation as an indented tree: "Started 3 agents: Health · Saving state / Deployments · Saving state / Incidents · Saving state".
  - The sidebar group "READY FOR REVIEW 5", where each row has a title, a relative time on the right, and a second line with diff stats and a one-line summary.
- **Linear** [CAP] (`agent-progress__linear.png`, `composer__linear.png`)
  - The agent's output is a PR card: "Draft · Reset dimmed ride rows / master ← ride/drv-364-reset-dimmed-rows".
  - Its actions appear in the issue's activity feed as ordinary lines ("Linear moved from Todo to In Progress · just now"), next to human activity.
- **Raycast automations** [CAP] (`routines__raycast.png`): "Check emails · Daily at 09:00 • Next tomorrow at 09:00". The schedule is prose with the next run stated.

**Slop**
- **AI Elements Confirmation** [CAP] (`approvals__ai-elements-confirmation.png`)
  - "This tool wants to delete the file /tmp/example.txt. Do you approve this action?" [Reject] [Approve].
  - The actor is anonymous and the verb is generic.
  - A blue primary button sits on a destructive action.
- **AI Elements Queue** [CAP] (`agent-progress__ai-elements-queue.png`): "7 Queued / 5 Todo" count headers, struck-through todos and nested attachments. It lists everything and prioritises nothing.
- [INT] "Worked for 2m 30s" as the *main* progress signal. Elapsed time is not progress.

**For Juno (§8, §9)**
- A task card leads with one sentence, then "needs you", then progress, then the result.
- Approval buttons carry **the specific verb** ("Post to #design", "Send 3 emails"), a secondary "Not now", and a tertiary "Tell Mira what to do".
- The card shows the exact digest of what will change.
- Destructive verbs use the destructive tone, never the brand accent.
- Questions render as option cards.
- The "Needs you" fold works like Cursor's "Ready for review" group.

### 2.9 Deep research progress + report

**Best**
- **Gemini** [DOC] (support.google.com/gemini/answer/15719111; the page shows no date)
  - The prompt produces a plan with **"Edit plan"** and **"Start research"**.
  - A run takes "about 5–10 minutes". You can leave; a notification appears "next to the chat thread".
  - The report opens in the Canvas panel, with Audio Overview, Share & export and Export to Docs.
- **ChatGPT** [INT] (`openai.md` §2.10)
  - The plan comes first and is editable. Source scoping (restrict or prioritise sites) is part of the plan.
  - Connected apps are used read-only.
  - You can interrupt during the run to refocus.
  - The report opens full screen with a table of contents, the sources used and the **activity history**, and exports to Markdown, Word or PDF.
- **Dia** [CAP] (`research-report__dia.png`)
  - A generated brief ("The Friday Brief") is set like an editorial object: a serif display title over an image, set-in datelines ("04 SEP 2026", "07:11 AM") and small-caps section heads.
  - The layout proves a generated report can carry authorship-grade typography instead of chat Markdown.
- **Claude** [INT]: research starts with `/deep-research` or `+`.

**Slop** [MEM]
- Step lists that auto-scroll for minutes.
- Percentage bars with no meaning.
- Source-count odometers.
- Reports that are just a long chat message.

**For Juno (§9)**
- Keep the plan gate, which is better than anyone's, and add source scope to it.
- While running, show one line: "Reading 14 sources · 3 of 5 questions answered".
- The report is a Library document at reading width, with a table of contents and the trace behind a disclosure.

### 2.10 Voice mode

**Best**
- **ChatGPT Voice** [CAP] [DOC] [INT] (`voice__chatgpt.png`)
  - Voice happens **inside the conversation**.
  - A soft lilac-blue sphere with a faint halo sits centred above the composer, labelled with one word, **"Listening"**.
  - The composer stays, with placeholder "Add to the conversation", mic mute, speaker, and a black ✕ to end.
  - The transcript keeps building above it, and tool lines appear as checkmarks while you talk.
  - Policy ([INT]): "Spoken approval is not supported". When you end a call in Work, the task continues in text.
- **Grok** [INT]: "Start voice chat" appears when the composer is empty, and bots can leave voice memos with transcripts.
- **Building block**: the AI Elements Voice set (Persona, Speech Input, Transcription, Mic and Voice Selector) [DOC].

**Slop**
- A full-screen takeover with a giant idle-pulsing blob and no transcript.
- States shown only by animation, with no text.
- An orb that animates while nothing is happening.

**For Juno (§9)**
- Voice is "a signature, quiet at rest".
- States (listening, thinking, speaking, muted) are shown by a word and by motion.
- The field never leaves.
- Idle is still. Motion starts only when audio does.

### 2.11 Sidebar / history / projects

**Best**
- **ChatGPT** [CAP] (`home__chatgpt.png`)
  - An icon rail (home, history, library, chats, apps) plus a panel.
  - Section headers carry their own "… +" actions. Recents are plain one-line text.
  - There are no icons per row, no timestamps and no badges.
- **Linear 2026 refresh** [DOC] (linear.app/now, 2026-03-12, Charlie Aufmann and Maxime Heckel)
  - The sidebar is **dimmer** than the content. Icons are smaller, inactive text is muted and vertical padding is larger.
  - Coloured team-icon backgrounds removed (paraphrase).
  - Warmer greys that stay crisp without turning muddy (paraphrase).
  - Softened, rounded borders.
- **Cursor** [CAP] (`thinking__cursor.png`): the sidebar is grouped by **what the person must do** ("READY FOR REVIEW 5"). Two-line rows: title and time, then diff stats and summary.
- **Raycast** [CAP] (`tool-calls__raycast.png`): project folders ("Website", "Personal") as quiet section labels, plain rows, a filled highlight on the selected row, and new-folder and new-chat icons grouped top-right.

**Slop** [MEM]
- Emoji-prefixed titles.
- A coloured icon on every row.
- Unread-count badges.
- "Upgrade to Pro" cards parked in the sidebar.
- Date buckets that outnumber the items.

**For Juno (§4.1)**
- The sidebar sits one tonal step dimmer than the canvas.
- Rows are plain text.
- The *Needs you* fold behaves like Cursor's group, with each row naming who needs what.
- Crew rows carry face, name and one-line "now" as text, never a dot.

### 2.12 Connectors / apps directory and permissions

- **Claude** [DOC] [3P]
  - Each connector tool is set to **Always allow / Needs approval / Blocked**, grouped by read and write.
  - Since 2026-05-28, Enterprise roles can set these per role, and they are enforced server-side on every surface.
  - [INT] The directory carries Verified/Community labels and context-cost estimates.
- **ChatGPT** [INT]
  - The Plugin Directory replaced Apps. A plugin bundles skills, MCP apps and UI.
  - The UI guidelines define display modes: inline card, carousel, fullscreen with the system composer overlaid, and picture-in-picture.
- **Raycast** [CAP]: apps are invoked with `@` in the composer. A "Bring your own subscriptions and keys" row shows provider marks.
- **Notion AI** [CAP] (`crew__notion.png`): "Meet your 24/7 AI team", Custom Agents with illustrated faces, and Q&A agents answering in context. It is the nearest web analogue to Juno's Crew.

**Slop**
- Lists of OAuth records.
- A single on/off switch per app.
- "Verified" or "Beta" as coloured pills: Notion's pricing card shows a "Beta" row of app marks and a "Recommended" pill ([CAP] notion.com/product/ai, lower on the page; not on the board).

**For Juno (§8)**
- The app page shows account, reads, changes, last used, and who can use it.
- Policy is **Allow · Ask · Off**, one segmented control per action group.
- The always-confirm floor is stated as text under the control ("Sending always asks").
- Provenance is written as a line ("Built by Linear"), not a badge.

### 2.13 Settings

The evidence is thin.
- Claude [DOC] points to "Settings › Capabilities" for artifact prerequisites.
- Linear's refresh [DOC] made headers and controls "consistent across projects, issues, reviews, and documents".
- [MEM, UNVERIFIED] Linear and Claude settings: a left nav and a single column of about 640 px. Each row is a label, a one-line description and a control aligned right. Changes apply instantly, with no Save button.

**For Juno**
- Apply instantly, and offer Undo on reversible changes.
- Ask for a deterministic confirm only when a change *widens* access (§7, §8).
- Every setting is findable from ⌘K.

### 2.14 Share / publish

- **Claude** [DOC]: *share* is separate from *publish*. Building on a published artifact makes a separate copy. Export formats are listed per type.
- **ChatGPT Sites** [INT]: live deployments with versions and custom domains; "every deployment URL is a production URL".
- **Gemini** [DOC]: the "Share & export" menu offers "Share Canvas", "Export to Docs" and "Copy Contents".
- **Dia** [CAP]: a quiet "Share" button in the page toolbar, top right.

**For Juno (§10)**
- The Share dialog previews exactly what the recipient will see and states the scope in one sentence.
- The Publish dialog shows the URL, the pinned version, and Update / Roll back / Unpublish.
- "Copy link" morphs to "Copied" in place.

### 2.15 Error, empty and loading states

- **Claude** [DOC]: "Try fixing with Claude" copies the error into a new message.
- **Vercel Web Interface Guidelines** [DOC]
  - Loading states get "a short show-delay (~150–300 ms) & a minimum visible time (~300–500 ms) to avoid flicker".
  - Busy labels end with an ellipsis character: "Loading…", "Saving…", "Generating…".
  - "Show a loading indicator & keep the original label".
  - Skeletons "mirror final content exactly to avoid layout shift".
  - Optimistic updates reconcile with the server, and "On failure, show an error & roll back or provide Undo".
  - Errors "tell the user how to fix it".
- **AI Elements Shimmer** [DOC]: a text shimmer for live labels.

**Slop**
- The Manus modal and the Meta consent wall (§2.1).
- Toasts for everything.
- Red banners at the top of the page for an error in one message.

**For Juno**
- An error appears inline where it happened, as a quiet line with one recovery verb.
- Network loss keeps the draft and says "Reconnecting…".
- Rate limits say *when* ("Available again at 14:20").

---

## 3. Micro-interaction spec (cross-cutting, with sources)

| Interaction | Value | Source |
|---|---|---|
| Button press | `scale(0.97)` on `:active`, 100–160 ms, ease-out. The label scales with it. | Emil Kowalski, `review-animations/STANDARDS.md` [DOC] |
| Tooltip / small popover | 125–200 ms. No delay on subsequent tooltips. | Emil [DOC] |
| Dropdown / select | 150–250 ms. The origin sits at the trigger ("anchor motion to where it physically starts"). | Emil [DOC]; Vercel [DOC] |
| Modal / drawer | 200–500 ms. Drawer curve `cubic-bezier(0.32, 0.72, 0, 1)`. | Emil [DOC] |
| Default ease | ease-out `cubic-bezier(0.23, 1, 0.32, 1)`. On-screen moves use `cubic-bezier(0.77, 0, 0.175, 1)`. Never ease-in on UI. | Emil [DOC] |
| Entry | Start at `scale(0.9–0.97)` with `opacity: 0`, never `scale(0)`. | Emil [DOC] |
| Stagger | 30–80 ms between items. Never block input. | Emil [DOC] |
| Keyboard / ⌘K / frequent actions | **No animation.** | Emil [DOC]; Rauno Freiberg, "Invisible Details of Interaction Design" (2023) [DOC] |
| Interruptibility | Use transitions, not keyframes, for anything the user can reverse. Every animation is cancellable by input. | Emil [DOC]; Vercel [DOC] |
| Properties | `transform` and `opacity` only. Never `transition: all`. | Vercel [DOC] |
| Hover | Gate hover motion behind `(hover: hover) and (pointer: fine)`. Hover, active and focus states have more contrast than rest. | Emil [DOC]; Vercel [DOC] |
| Focus | Visible `:focus-visible` ring on everything. | Vercel [DOC] |
| Hit targets | ≥ 24 px on desktop, ≥ 44 px on touch. | Vercel [DOC] |
| Loading | 150–300 ms show-delay, 300–500 ms minimum visible. | Vercel [DOC] |
| Reduced motion | Keep opacity and colour, drop transforms. "Gentler, not zero." | Emil [DOC] |
| Streaming text | Per-word fade over about 120–180 ms with adaptive pacing. Complete unterminated Markdown. Code animates with prose. | Streamdown 2.2 [DOC]; StreamingText / flowtoken [3P]; the ms range is my recommendation |
| Copy | Icon morphs to check with "Copied", reverting after 1.5–2 s. No toast. | [MEM] Claude/ChatGPT; recommendation |
| Composer submit | ⌘/Ctrl+Enter or Enter per preference. Never block paste. | Vercel [DOC] |
| Tabular numbers | `font-variant-numeric: tabular-nums` for counts, timers and diffs. | Vercel [DOC] |

**Restraint rules** from Linear's refresh [DOC]:
- "Don't compete for attention you haven't earned."
- "Structure should be felt not seen."
- Fewer icons, smaller icons, no coloured icon backgrounds.
- Dim the chrome, and let the content lead.

---

## 4. Component libraries: take the behaviour, not the skin

The owner asked about "the best website components for AI chatbot". Four matter:

- **AI Elements (Vercel)**, elements.ai-sdk.dev [DOC] [CAP]
  - A shadcn registry with 48 components, grouped as:
    - Chatbot: Attachments, Chain of Thought, Checkpoint, Confirmation, Context, Conversation, Inline Citation, Message, Model Selector, Plan, Prompt Input, Queue, Reasoning, Shimmer, Sources, Suggestion, Task, Tool;
    - Code: Agent, Artifact, Code Block, Commit, Environment Variables, File Tree, JSX Preview, Package Info, Sandbox, Schema Display, Snippet, Stack Trace, Terminal, Test Results, Web Preview;
    - Voice: Audio Player, Mic Selector, Persona, Speech Input, Transcription, Voice Selector;
    - Workflow: Canvas, Connection, Controls, Edge, Node, Panel, Toolbar;
    - Utility: Image, Open In Chat.
  - **Take:** the data models and behaviours. Reasoning auto-opens while streaming and auto-closes. Tool has input-streaming, running, awaiting-approval, output and error states. Checkpoint. Context accounting. Inline citation carousel.
  - **Reject:** the defaults, which are the "AI slop" look in one kit: status pills, raw tool names, blue primaries, generic suggestion carousels, and unlabelled icon rows.
- **Streamdown** (Vercel) [DOC]: streaming Markdown with unterminated-block completion, animated per-word streaming and a caret. The best current primitive for §2.4.
- **assistant-ui** [3P]: composable React chat primitives covering auto-scroll, attachments, **branching and editing**. The strongest reference for the hard mechanics.
- **prompt-kit** [3P]: shadcn-based Response Stream, Reasoning, Chain of Thought, Chat Container, Scroll Button and File Upload. Similar to AI Elements, and just as generic in skin.

Also useful:
- **Shape of AI**, shapeof.ai, by Emily Campbell [3P]: a pattern taxonomy of Wayfinders, Prompt Actions, Tuners and Governors. Good vocabulary for the spec.
- **libraries.dev** (a skill is installed in this environment): Border beam, Thinking orbs, Voice glow, Bot avatars. Use sparingly and only where motion means state.

---

## 5. Reference board index

All files are in `…/scratchpad/refs/web/`. Everything was captured 2026-09-30 by me [CAP], from the URL shown. "Crop" means a region of the full capture.

| File | Shows | Source URL |
|---|---|---|
| `home__grok.png` | Empty home, teaching placeholder, "Fast ⌄" | https://grok.com/ |
| `home__grok-dark.png` | Dark home, "Type @ to search your apps" | https://grok.com/ (dark scheme) |
| `home__gemini.png` | Pill composer, ambient glow, "Flash-Lite ⌄" | https://gemini.google.com/app |
| `home__chatgpt.png` | Web app illustration: rail + sidebar, Chat/Work, composer (crop) | https://learn.chatgpt.com/docs/web |
| `home__v0.png` | Builder home with starter chips and templates | https://v0.app/ |
| `home__kimi.png` | Composer with tray beneath and mode-chip row | https://www.kimi.com/ |
| `home__t3chat.png` | **Slop:** generic starters, category pills, price glyphs | https://t3.chat/ |
| `home__manus.png` | **Slop:** "Restore your account… welcome back bonus" modal on a fresh visit | https://manus.im/ |
| `home__ai-elements-chatbot.png` | **Slop baseline:** suggestion-chip carousel | https://elements.ai-sdk.dev/examples/chatbot |
| `composer__claude.png` | "Opus High ⌄" + rounded-square send (crop) | https://claude.com/product/overview |
| `composer__chatgpt-goal.png` | Goal row docked to composer; Auto-review, "6 Sol Medium", stop (crop) | https://learn.chatgpt.com/docs/long-running-work |
| `composer__raycast.png` | "Ask anything, @ tools, or / for commands…" + suggestion row (crop) | https://www.raycast.com/core-features/ai |
| `composer__linear.png` | PR card, "Reply…", Skills ⌄, stop (crop) | https://linear.app/ |
| `composer__kimi.png` | "Instant High", tray, mode chips (crop) | https://www.kimi.com/ |
| `composer__grok.png` | Dark composer, "Type @…" (crop) | https://grok.com/ |
| `composer__dia.png` | "Ask another question…", amber stop (crop) | https://www.diabrowser.com/ |
| `model-picker__chatgpt.png` | Astra / GPT-6.1 Sol / Luna with one-line purposes (crop) | https://learn.chatgpt.com/docs/model-selection |
| `model-picker__ai-elements-context.png` | **Slop:** "31.3%" context meter | https://elements.ai-sdk.dev/components/context |
| `thinking__cursor.png` | "Thought 4s / Read / Searched", file chip, "Ready for review" sidebar (crop) | https://cursor.com/ |
| `thinking__linear.png` | "DRV-364 added to context", "Worked for 10 sec ▸" (crop) | https://linear.app/ |
| `thinking__ai-elements-reasoning.png` | Baseline: "Thought for 4 seconds ⌄" | https://elements.ai-sdk.dev/components/reasoning |
| `thinking__ai-elements-cot.png` | Baseline: chain-of-thought steps with search pills and image | https://elements.ai-sdk.dev/components/chain-of-thought |
| `tool-calls__raycast.png` | Inline [Linear] token; "Checked new bugs in Linear 3" (crop) | https://www.raycast.com/core-features/ai |
| `tool-calls__ai-elements-tool.png` | **Slop:** raw names + coloured status pills | https://elements.ai-sdk.dev/components/tool |
| `citations__ai-elements-inline.png` | Domain chip "example.com +5" | https://elements.ai-sdk.dev/components/inline-citation |
| `citations__dia.png` | Personal-data source cards with app marks (crop) | https://www.diabrowser.com/ |
| `code__ai-elements-code-block.png` | Filename, language selector, copy | https://elements.ai-sdk.dev/components/code-block |
| `artifacts__cursor.png` | Three-column: sessions / transcript / document pane | https://cursor.com/ |
| `artifacts__ai-elements-artifact.png` | **Slop:** five unlabelled icon actions | https://elements.ai-sdk.dev/components/artifact |
| `agent-progress__cursor.png` | Question card; "Started 3 agents" tree; status footer (crop) | https://cursor.com/ |
| `agent-progress__linear.png` | Issue + agent panel + activity feed (dark) | https://linear.app/ |
| `agent-progress__ai-elements-queue.png` | **Slop-ish:** "7 Queued / 5 Todo" lists | https://elements.ai-sdk.dev/components/queue |
| `approvals__ai-elements-confirmation.png` | **Slop:** "This tool wants to delete…" [Reject][Approve] | https://elements.ai-sdk.dev/components/confirmation |
| `research-report__dia.png` | Editorial "Friday Brief" report | https://www.diabrowser.com/ |
| `voice__chatgpt.png` | In-thread voice: orb, "Listening", retained composer (crop) | https://learn.chatgpt.com/docs/features/voice |
| `routines__raycast.png` | "Daily at 09:00 • Next tomorrow at 09:00" (crop) | https://www.raycast.com/core-features/ai |
| `crew__notion.png` | "Meet your 24/7 AI team", agent faces | https://www.notion.com/product/ai |

---

## 6. Sources (all read 2026-09-30)

**First-party**
- Linear, "A calmer interface for a product in motion", 2026-03-12: https://linear.app/now/behind-the-latest-design-refresh ; changelog https://linear.app/changelog/2026-03-12-ui-refresh
- Vercel Web Interface Guidelines (undated, living): https://vercel.com/design/guidelines
- AI Elements (undated, living): https://elements.ai-sdk.dev/
- Streamdown: https://streamdown.ai/ ; changelog https://vercel.com/changelog/streamdown-2-2 ; PR https://github.com/vercel/streamdown/pull/474
- Claude Help Center, "What are artifacts and how do I use them?" ("Updated this week"): https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
- Claude connectors help: https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities
- Gemini Apps Help, "Use Deep Research in Gemini Apps" (undated): https://support.google.com/gemini/answer/15719111
- ChatGPT Learn (undated): https://learn.chatgpt.com/docs/web ; /docs/features/voice ; /docs/artifacts-viewer ; /docs/long-running-work ; /docs/model-selection
- Emil Kowalski, review-animations standards: https://github.com/emilkowalski/skills/blob/main/skills/review-animations/STANDARDS.md ; https://emilkowal.ski/ui/great-animations
- Rauno Freiberg, "Invisible Details of Interaction Design" (2023): https://rauno.me/craft/interaction-design

**Third-party**
- AYDesign, "AI citation and source UI design patterns for 2026", 2026-09-11: https://www.aydesign.ai/blog/ai-citation-source-ui-patterns-2026
- Shape of AI: https://www.shapeof.ai/
- assistant-ui: https://www.assistant-ui.com/
- prompt-kit: https://www.prompt-kit.com/
- flowtoken: https://github.com/Ephibbs/flowtoken
- StreamingText: https://github.com/halilozel1903/StreamingText
- Blake Crosley's Perplexity design guide (https://blakecrosley.com/guides/design/perplexity) was read and **not used**. Its values, such as a citation blue `#0066cc`, do not match Perplexity's teal brand and look reconstructed.

**Sibling files:** `openai.md`, `anthropic.md` and `xai-grok.md` in this folder.

**Not used:** Mobbin. The MCP refused with "requires a paid plan".
