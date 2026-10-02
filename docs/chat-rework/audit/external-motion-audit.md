# External audit: motion and visual design of thinking, working and tool-activity states

Audit date: **2026-09-23**. Branch `web/tools-thinking-research` (worktree `juno-tools`). Research only:
no Juno source was changed.

Scope:

- How the leading assistants **animate and word** the states between Send and a finished answer:
  Claude (claude.ai and Claude Code), ChatGPT, Gemini, Perplexity, Grok, DeepSeek, Cursor, Linear
  agents, and Vercel's v0 stack (AI Elements, Streamdown, the AI SDK).
- General practice for AI loading states and streaming text: Material 3 Expressive, Apple HIG,
  shimmer text, skeletons vs shimmers, layout shift, height-auto techniques, View Transitions,
  reduced motion, and compositor-only performance.
- A **motion spec for Juno**: tokens, three thinking-indicator concepts, phase changes, tool-step
  motion, right-panel motion, counters and favicons, the completion collapse, reduced motion and
  performance rules.
- **CSS and TS snippets** for the core techniques, written for Juno's tokens.

Companion reports, which this one assumes:

- [`internal-design-system-motion.md`](./internal-design-system-motion.md): Juno's tokens, keyframes
  and motion law.
- [`internal-thinking-and-right-panel.md`](./internal-thinking-and-right-panel.md): the current strip,
  the dock and their bugs (B1, B2, and others).
- [`external-deep-research-audit.md`](./external-deep-research-audit.md) §6: the Research progress
  grammar and motion table. This report agrees with it. §3.10 below says where it refines it.
- [`external-chatgpt-tools.md`](./external-chatgpt-tools.md) §A2 and §C5–C6, and
  [`external-claude-tools.md`](./external-claude-tools.md) §C.4: thinking anatomy.

### Evidence legend

| Tag | Meaning |
|---|---|
| **[V]** | Verified from a primary source: official docs, help centre, source code, changelog or engineering post. The date is given. |
| **[3P]** | A third party: press, a teardown site, a blog, a forum thread or a third-party reimplementation. |
| **[K]** | Prior knowledge of how the product looked in 2024–2025. It was **not re-verified in 2026**. Treat it as an estimate. |
| **[Est]** | A timing or easing I estimated. The product does not publish it. |
| **[I]** | My inference or recommendation. |

No product publishes its thinking-animation timings. Any number here that is not tagged [V] is either a
third-party reconstruction or my estimate, and is labelled as such.

---

## 0. Executive summary

**What the market converged on (as of Sep 2026):**

1. **One live line, not a block.** Every major product shows a single status line while working. It
   pairs a verb with a small moving mark: ChatGPT's shimmering "Thinking", Claude's spark plus a timer,
   Claude Code's glyph plus a verb, Cursor's "Planning next moves", and Perplexity's
   "Searching / Reading / Writing". Growing detail goes somewhere else: a side panel (ChatGPT), a
   bottom sheet (Gemini, 2026), or an inline disclosure that is collapsed by default (Claude,
   Perplexity). [V/3P]
2. **Shimmer text is the industry's "working" gesture.** A gradient is clipped to the glyphs with
   `background-clip: text` and swept across them. Vercel's AI Elements ships it with a 2 s period, a
   linear curve and a band scaled to the text length [V source]. Nuxt UI and ElevenLabs UI ship the same
   thing. The cost: animating `background-position` is a **paint** animation that runs on the main
   thread [3P Motion Magazine, Nov 2025]. It stutters exactly when React is busy rendering tokens.
   §4.3 gives a compositor-only version.
3. **The finished state is a past-tense summary with a duration.** Examples: "Thought for 19s"
   (ChatGPT [V Simon Willison, Sep 2025]), "Thought for 1 minute" (Grok [V xAI]), "Crunched for 5m 16s"
   (Claude Code [3P]), "Completed N steps" (Perplexity [3P, Jun 2026]) and "Thought for N seconds"
   (AI Elements, rounded up [V source]).
4. **Phase copy, not whimsy.** Claude Code's playful verbs caused a real usability bug: users could not
   tell when it had finished (GitHub issue #52759, closed as a duplicate on 2026-04-24 [3P]). Research on
   visible thinking finds that it anthropomorphises the assistant and shapes expectations (arXiv
   2601.16720, Jan 2026 [V abstract]). Juno should use factual verbs and an explicit done state. [I]
5. **Long waits escalate.** Claude Code changes its status to "deep in thought" after 45 s, and its
   spinner turns red when a check stalls. VS Code shows "Not responding" after 60 s of silence
   [3P changelog digest, 2026]. Linear marks an agent **unresponsive** if it does not acknowledge within
   10 s [V Linear docs].
6. **Only the active item animates.** One third-party fix (Macro, PR #6488, 2026-09-16 [3P]) stopped
   every earlier thought from shimmering, because a turn "appears frozen" when they all do. This is
   Juno's own "one breathing element" rule.
7. **Don't collapse what the user is reading.** Cursor auto-collapses thoughts on the next step, and
   users complain about it (forum, 2026 [3P]).
8. **Gemini moved its thinking out of the transcript.** Its May 2026 redesign put "See thinking steps"
   into the overflow menu as a **bottom sheet**. Its loader became three waving dots
   [3P 9to5Google / Android Headlines, May 2026].

**What Juno should do (details in §3):**

1. **Keep one persistent status line** from Send to Done. It has the same node, the same 36 px box and
   the same type in the live and finished states. Nothing reflows at completion. This fixes the
   StreamStatus-to-strip handoff and the ~190 px jump at done (internal B2).
2. **Make the thinking matrix phase-typed** (Concept A). The existing 3×3 `ThinkingDots` gets a
   distinct opacity-only pattern for *thinking*, *searching*, *reading*, *running a tool* and *writing*.
   It holds still for *waiting on you*. At *done* it **gathers** into the 6 px resting dot. It stays
   brand-owned and never copies Claude's spark.
3. **Shimmer the label with transforms, not `background-position`.** Use the compositor-only sweep in
   §4.3. Use one loop family (`--loop-beat` 1.2 s → 2.4 s standard, 4.8 s calm) so the glyph and the
   label move as one gesture and no two loops beat against each other.
4. **Pace the copy.** Show nothing before 400 ms. Hold each phase for at least 700 ms, with the newest
   phase winning. Show the clock only after 3 s. After 20 s the line goes **calm**: the shimmer stops
   and the glyph slows to 4.8 s.
5. **Keep the dock mounted through its exit, and never close it on stream** (fixes B1). Open it with a
   **View Transition**: a 360 ms `ease-drawer` slide, with the transcript cross-faded instead of
   snapping its re-wrap. Inside the dock the loop lives on the **running row's marker**, and the
   transcript line goes static.
6. **Choreograph "Done" as a sequence** instead of a storm: glyph gather, then the summary label,
   favicons, toolbar, follow-ups, and finally the title and memory changes, spread over about 1 s.
7. **Performance rules:** only `transform` and `opacity` loop. The status line subscribes to phase,
   not to tokens. Finished markdown blocks are memoised. Loops are phase-locked to the page clock and
   pause off screen. No `box-shadow` or `height` animates in the transcript.
8. **Reduced motion keeps the meaning and loses the travel.** Each phase gets a static signature, an
   opacity-only breath shows liveness, and labels cross-fade. Forced-colors mode uses system colors.

---

## 1. Per-product breakdown

Each entry covers what animates, how it animates (durations and easings are tagged as verified or
estimated), and the words shown in each phase.

### 1.1 Claude: claude.ai web, desktop and mobile

| Aspect | Finding | Evidence |
|---|---|---|
| Thinking indicator | A **"Thinking" indicator with a timer**, plus an **expandable "Thinking" section** above the answer. Clicking it shows the thought-process summary. When safety filtering applies, part of the trace is replaced by "the rest of Claude's thought process is not available". | [V] Claude Help Center, "Using extended thinking" (fetched 2026-09-23) |
| The mark | "On the web, Claude has a **hand-drawn spinner animation** that plays while it's thinking." It is the orange spark (starburst) redrawn with irregular strokes. The ASCII spinner in Claude Code was built to echo it. | [3P] Kyle Martinez, "Reverse engineering Claude's ASCII spinner animation" (Medium, via search summary) |
| Placement of the mark | The spark animates beside the turn that is streaming and settles to a static mark when done. | [K] |
| Live line content | While thinking, the header shows a **one-line summary** of the current thinking. It is summarised, as Claude 4-era models return summarised thinking. It changes every few seconds and shimmers. | [K]; summarised thinking is [V] (Claude platform docs, "Thinking") |
| Tool rows | Live: "Searching the web" plus the query. Done: "Searched the web" plus a result count. Expanding it shows a list of results with favicon, title and domain. Fetches read "Fetched *title*". | [K]; recorded as [Obs] in `external-claude-tools.md` §B |
| Tense change | Rows change verb tense in place ("Searching" becomes "Searched"). The row's height does not change. | [K] |
| Where details go | **Inline**, collapsed by default. There is no side panel for thinking. Artifacts open in a split pane, which is a different surface. | [K]; the split pane is [3P] (AI UX Playground, Claude artifacts teardown, Jun 2026) |
| Research | Turned on with "+" → Research. A **blue indicator** shows at the bottom of the chat. The Help Center does not describe the progress UI. | [V] Help Center, "Use research on Claude" (updated 2026-06-02) |
| Timings | Not published. From memory: the spark cycles in roughly 1–1.5 s steps and the shimmer sweep takes about 2 s. | [Est] |

**Lessons for Juno [I]:**

- A branded mark plus a plain verb, and a timer.
- Summaries, not raw traces, in the live line.
- Details stay collapsed. Don't copy the spark. Juno's dot matrix is its equivalent.

### 1.2 Claude Code: CLI and desktop app

This is a terminal UI, but it is the best-documented thinking indicator of any product, and its failure
modes are public.

| Aspect | Finding | Evidence |
|---|---|---|
| Glyph frames | `·` `✢` `✳` `✶` `✻` `✽`. `*` is used on Ghostty and non-Darwin terminals. | [3P] alexbeals.com, 2026-02-07; [3P] tweakcc defaults |
| Frame timing | **120 ms per frame**, with `reverseMirror: true`, so the frames ping-pong. That gives a round trip of about 1.2 s. The first and last frames hold slightly longer, a built-in ease at each end. | [3P] tweakcc README (defaults); [3P] Kyle Martinez frame analysis |
| Render loop | The terminal renderer throttles at about **50 ms** (`FRAME_INTERVAL_MS`) and defers renders with `queueMicrotask` to avoid cursor lag while streaming. | [3P] brtkwr.com, "What we can all learn from the Claude Code source", 2026-04-01 |
| Status text | `✻ Improvising… (35s · ↓ 279 tokens · esc to interrupt)`. One verb is picked per turn from about 180–190 gerunds and stays fixed for the whole turn. It has a shimmer sweep and a token counter. | [3P] tweakcc; alexbeals; spinner-verbs dictionary |
| Internal states | *requesting*, *thinking*, *tool-input*, *tool-use* and *responding*, each with slightly different colour or movement. | [3P] note.com/rorosuke, 2026-03-06 |
| Escalation | "Deep in thought" after 45 s of thinking. The spinner shows elapsed time during hooks. It turns **red** when an auto-mode permission check stalls. VS Code shows a red spinner and "Not responding" after 60 s of backend silence. | [3P] gradually.ai changelog digest (Sep 2026) |
| Done | A past-tense line: `Crunched for 5m 16s`, drawn from Baked, Brewed, Churned, Cogitated, Cooked, Crunched, Sautéed and Worked. | [3P] GitHub issues #30032 and #52420; note.com |
| Known failure | The spinner lingers after the response, and the playful verbs make it look busy, so users wait needlessly. The issue proposes phase-specific verbs and a clear "Done". | [3P] GitHub issue #52759 (closed as a duplicate, 2026-04-24) |
| Desktop app | Transcript views **Verbose / Normal / Summary**, "from full visibility into tool invocations down to results-only". | [V] claude.com blog, "Redesigning Claude Code on desktop", 2026-04-14 |

**Lessons for Juno [I]:**

- A 120 ms stepped glyph reads as alive even without smooth tweening.
- Held end frames act as easing.
- Tokens and seconds are the trust signal on long runs.
- Whimsy costs clarity.
- Make **Done** unambiguous: the mark stops, the tense changes and the duration freezes.

### 1.3 ChatGPT: chat, thinking panel, deep research, Work

| Aspect | Finding | Evidence |
|---|---|---|
| Waiting for the first token | A **pulsating black dot** in the assistant slot. A 2024 forum post: "Instead of a blue spinning slider… it shows a pulsating black dot." | [3P] OpenAI community forum, 2024-02-27 |
| Thinking | A **shimmering "Thinking"** label. The current activity or reasoning-summary headline replaces it ("Searching the web", "Reading 4 sources", a bold summary title). | [K]; shimmer anatomy is [P] in `external-chatgpt-tools.md` §A2 |
| Shimmer CSS | Recalled from inspecting chatgpt.com in 2025: a `loading-shimmer` class with `background-clip:text`, a `text-quaternary → text-primary → text-quaternary` gradient, `background-size` about 50% × 200%, a 0.5 s delay and a **3 s** infinite loop. **Unverified** (the page is behind a Cloudflare challenge), so treat these as estimates. | [K]/[Est] |
| Finished | A collapsed row, **"Thought for Ns ›"**. Clicking it opens a **right-hand panel**. The panel shipped on 2024-11-26 and is shared with Sources. | [P] Tibor Blaho, via `external-chatgpt-tools.md` |
| Panel content | Header "Thought for 19s". **Bullet-style reasoning steps**. Search results as **domain chips with "+ 10 more"**. Ends with **"Done"**. Sources are at the bottom. | [V] Simon Willison, "Research Goblin", 2025-09-06 (screenshots) |
| Panel header | "Activity · 5s" with a Done state. Copy and Edit icons sit on the Thought row. The teardown's critique: the label "is easy to miss on fast scroll", and it adds "a second surface to learn". | [3P] AI UX Playground, ChatGPT output teardown, updated 2026-06-15 |
| Controls while running | **Answer now** (skip the rest of thinking). **Update** (add context mid-run in the sidebar, since 2025-11-05). **Upfront plan** before the final answer (GPT-5.4 Thinking, 2026-03). | [P] via `external-chatgpt-tools.md` |
| Effort | On 2026-08-06 Instant and Thinking merged. Plus and Pro get a **reasoning slider**; Free and Go get a **Think** button. There is no named-mode picker. | [3P] AppleInsider / 9to5Mac, 2026-08-06 |
| Deep research | A sidebar summarises the steps taken and sources used, live. You can interrupt, click **Update**, and view the report fullscreen. | [V] OpenAI Help Center, "Deep research in ChatGPT" |
| Data model | ChatKit `Workflow` with ordered `tasks` (thought, web_search, file, image, custom). Each task has `status_indicator` (none, loading or complete). The summary is a `DurationSummary` ("Thought for N s") or a custom title. It is collapsed by default. | [V] ChatKit Python types |
| Streaming | Text streams in chunks with no per-token animation. The old trailing ● cursor is gone. | [K] |

**Lessons for Juno [I]:**

- A dot before the first token.
- Shimmer on **one** label.
- The finished row is also the **button** that opens the panel.
- The panel mixes reasoning bullets with search chips and "+N more", and ends in an explicit "Done".
- Header clock.
- The panel is a second surface, so the transcript line alone must say enough.

### 1.4 Gemini

| Aspect | Finding | Evidence |
|---|---|---|
| 2025 thinking | A **"Show thinking"** toggle above the answer reveals thought summaries with bold headings. The spark avatar has a rotating gradient ring while it generates. | [K]; thought summaries are [V] (Gemini API / Firebase AI Logic docs) |
| 2026 redesign (web, iOS, Android) | "See thinking steps" moved **into the overflow menu**, where the thought process opens as a **bottom sheet**. The thinking animation is now "three waving dots instead of a circular loading element outside the Gemini icon". There is a pulsating gradient background on the home screen and on send. | [3P] 9to5Google 2026-05-03; Android Headlines (via search), May 2026 |
| Neural Expressive (I/O, 2026-05-19) | "Fluid animations, vibrant colors, haptic feedback, and new typography". Motion "communicating state": the UI "breathes" while it processes, retrieves or switches mode. It uses a custom variable font that "animates between weights as you scroll". One blog reports replies streaming with "a wavy underline effect that signals AI thinking". | [3P] 9to5Google 2026-05-19; urdesignmag 2026-05-21; precisionpulse (low confidence) |
| Design rationale | Gradients have "sharp, almost opaque leading edges that diffuse at the tail" to point attention. Motion has defined start and end points, and the "inner activity" signals thinking. | [V] Google Design, "Gemini AI visual design" (undated) |
| Timings | Not published. | — |

**Lessons for Juno [I]:**

- Detail belongs in a sheet on mobile.
- A directional gradient (sharp front, soft tail) is a good model for Juno's shimmer band: a sharper
  leading edge and a longer trailing fade.
- Motion should track state changes, not decorate them.

### 1.5 Perplexity

| Aspect | Finding | Evidence |
|---|---|---|
| Phases | Three visible phases, **Searching → Reading → Writing**, streamed over SSE. | [3P] blakecrosley.com design guide |
| Steps | Plain-language step labels ("Searching the web", "Checking predictions"). **Collapsed by default** under **"Completed N steps"**. "Step count in the header sets expectation for latency." | [3P] AI UX Playground, Perplexity output teardown, 2026-06-15 |
| Sources | Sources **appear before the answer** and fade in slightly ahead of the text that cites them. A **favicon stack plus count** sits in the answer's action row. | [3P] blakecrosley; AI UX Playground |
| Cursor | A **teal block cursor** trails the streamed text. | [3P] blakecrosley |
| Why show steps | "Users were more willing to wait for results if the product would display the intermediate progress." Also: "You don't want to overload the user with too much information until they are actually curious." | [V] LangChain "Breakout Agents: Perplexity" case study |
| Timings | A third-party guide gives: loading dots 1.4 s ease-in-out with 0.2 s / 0.4 s stagger (scale 0.6→1, opacity 0.5→1); source cards 0.3 s ease-out with `translateY(8px)` and 100 ms stagger; cursor blink 1 s `step-end`. The author says these are **inferred from code examples, not measured**. | [3P]/[Est] |

**Lessons for Juno [I]:**

- Sources first.
- The step count is the latency promise.
- Collapse after done.
- Stagger arrivals at 50–100 ms.

### 1.6 Grok (xAI)

| Aspect | Finding | Evidence |
|---|---|---|
| Thinking | "Thinking" with an elapsed timer. An expandable **Thoughts** panel shows the reasoning, including the search strategy. | [V] xAI Grok 4 post shows "thought for 1 minute" (2025) |
| Live trace | A fixed-height window that **auto-scrolls** the streaming chain of thought, with **faded top and bottom edges**. | [3P] 21st.dev "AI thinking" component modelled on it; [K] |
| DeepSearch | Iterative steps across web and X, up to about 10 steps. The steps show as a list. | [3P] suprmind |

**Lesson for Juno [I]:** a fixed-height, edge-faded trace window is the right way to show raw
reasoning live without layout shift. Juno's AIcss 180 px viewport is this idea. Move it from the
transcript into the dock (§3.6).

### 1.7 DeepSeek

| Aspect | Finding | Evidence |
|---|---|---|
| Mode | **DeepThink** is an armed chip in the composer ("a mode, not a model name"). | [3P] AI UX Playground, DeepSeek composer teardown, 2026-06-16 |
| Thinking | "Thinking…" while running, then **"Thought for N seconds"**. The **raw** reasoning is shown in a muted, smaller block with a left rule. It is expanded by default and collapsible. | [3P] (e-discoveryteam, 2025); [K] for styling |

**Lesson [I]:** raw traces expanded by default are noisy. Every later product moved to summaries
and collapsed defaults.

### 1.8 Cursor (agent UI)

| Aspect | Finding | Evidence |
|---|---|---|
| Live label | **"Planning next moves"** with shimmer. Users report it sticking, which is itself a sign that a lingering shimmer reads as "hung". | [3P] Cursor forum threads (2025–2026) |
| Thinking blocks | "Thought for Ns" bubbles **auto-expand while streaming and collapse when finished**. Users ask it to stop auto-collapsing while they read. | [3P] Cursor forum, "Don't auto-collapse thoughts…" (search summary) |
| Tool rows | Grouped as "Explored N files" (or tools), with Read, Grepped and Edited rows. A compact mode hides tool icons and collapses diffs. | [3P] Cursor forum, v3.10 (2026) |
| Cursor 3 | An "Agents Window", agent tabs side by side, a scroll-to-bottom button when content overflows, and a fix for expanding and collapsing thinking blocks during streaming. | [V] Cursor changelog 3.0 |
| Third-party renderer fix | Only the **trailing** thought shimmers. Earlier thoughts settle to a static "Thought". The live reasoning row stays separate from grouped tool rows. | [3P] macro-inc/macro PR #6488, 2026-09-16 |

**Lessons for Juno [I]:**

- Group repeated tool kinds.
- Only the trailing item animates.
- Never auto-collapse a disclosure the user opened or is scrolling in.

### 1.9 Linear (agents in issues)

| Aspect | Finding | Evidence |
|---|---|---|
| Principles (AIG) | Disclose that it is an agent. Give **immediate, unobtrusive feedback**. Keep **transparent internal state**: "thinking, waiting for input, executing, or finished", with reasoning and tool calls open to inspection. Stop at once when asked. | [V] linear.app/developers/aig (AIG launched 2025-07-30) |
| States | `pending`, `active`, `awaitingInput`, `error`, `complete`, `stale`. | [V] Linear developer docs, agent interaction |
| Activities | `thought`, `elicitation`, `action` (action + parameter + optional result), `response`, `error`. **Ephemeral** thought and action activities "will be replaced when the next activity arrives". There is an optional plan checklist (`pending`, `inProgress`, `completed`, `canceled`). | [V] same |
| Acknowledgement | The first activity must arrive **within 10 s**, or the session is shown as unresponsive. | [V] same |

**Lessons for Juno [I]:**

- Adopt Linear's state vocabulary for the status line, especially *awaiting input*, which is not
  "working" and must not loop.
- Treat ephemeral status copy as "replace, don't append".

### 1.10 Vercel: v0, AI Elements, Streamdown, AI SDK

| Piece | Finding | Evidence |
|---|---|---|
| `Shimmer` (AI Elements) | Motion (`motion/react`) animates `backgroundPosition` from `100% center` to `0% center`, **linear, 2 s, repeating forever**. The background is `250% 100%`. The band is `linear-gradient(90deg, transparent calc(50% - spread), var(--color-background), transparent calc(50% + spread))` layered over a solid `muted-foreground` fill and clipped to the text. Because the band is the **page background colour**, the sweep is a *valley*: the text fades toward the page as the band passes, rather than lighting up. `--spread` = **text length × 2 px** by default. | [V] `vercel/ai-elements/packages/elements/src/shimmer.tsx` |
| `Reasoning` | Opens automatically while streaming and **closes 1000 ms after** streaming ends (`AUTO_CLOSE_DELAY`). The trigger shows `<Shimmer duration={1}>Thinking...</Shimmer>` while live, then "Thought for {n} seconds" (`Math.ceil`) or "Thought for a few seconds". The content uses `slide-in-from-top-2` / `fade-out-0` (tailwindcss-animate). | [V] `reasoning.tsx` |
| `ChainOfThought` | Step status sets the ink: active `text-foreground`, complete `text-muted-foreground`, pending `text-muted-foreground/50`. Steps enter with `fade-in-0 slide-in-from-top-2 animate-in`. There is a 1 px spine and search results as small badges. | [V] `chain-of-thought.tsx` |
| Streamdown | **Block memoisation**: only the last, growing block re-renders. Incomplete markdown is repaired during streaming. **Carets** (`block ▋` or `circle ●`) are drawn with `::after` via `--streamdown-caret`. Animations `fadeIn` (default), `blurIn` and `slideUp` (4 px), **150 ms `ease`**, per word. `stagger` defaults to **40 ms** since v2.5 (2026-03-16). The docs do not mention reduced motion. | [V] streamdown.ai docs; Vercel changelog 2026-03-16 |
| AI SDK | `smoothStream()` defaults to `chunking: 'word'` and `delayInMs: 10`. `useChat({ experimental_throttle })` throttles renders. A known issue: `smoothStream` slows down in background tabs. The cookbook memoises parsed markdown blocks. | [V] ai-sdk.dev reference; GitHub issue #20217; cookbook |
| v0 | "Thought for Ns" disclosures and file-operation step rows, built from the same components. | [K] |
| Web Interface Guidelines | Honour `prefers-reduced-motion`. Prefer CSS, then WAAPI, then JS. Animate `transform` and `opacity`. Make animations interruptible. Never use `transition: all`. Anything **over 5 s** needs pause, stop or hide. Loading: **~150–300 ms show-delay and ~300–500 ms minimum visible time**. Skeletons must match the final layout. | [V] vercel.com/design/guidelines |

**Lessons for Juno [I]:** these are the reference implementations that most AI UIs copy, so they set
user expectations. Juno should match their *behaviour*: auto-open while live, a short settle, a
"Thought for N s" rounded up, and a show-delay. Juno can beat their *performance*: its shimmer
should be compositor-only, and nothing should re-animate on re-render.

### 1.11 Others worth knowing

- **Material 3 Expressive loading indicator.** A looping morph through seven shapes, driven by
  springs, with a "contained" variant. It is meant for waits **under about 5 s** and replaces
  indeterminate circular spinners [3P CSS Script / 9to5Google, May 2025]. This is a precedent for a
  *shape* that carries the working state. Juno's matrix plays the same role.
- **Apple Intelligence** shows a moving edge glow while Siri thinks: a mesh gradient with layered
  blurred strokes [3P reimplementations]. It is ambient light at screen scale. Juno reserves ambient
  light for voice only, which is correct.
- **Shimmer text components** in Nuxt UI (`ChatShimmer`, with a `duration` prop) and ElevenLabs UI
  (`ShimmeringText`) show that the pattern is now a commodity [3P docs].

### 1.12 Phase-by-phase comparison: what each product shows

| Product | Before first output | Thinking | Using tools | Writing | Done | Where detail lives |
|---|---|---|---|---|---|---|
| ChatGPT | Pulsating dot [3P] | "Thinking" shimmer, then the summary or activity [K] | "Searching the web", "Reading N sources", favicons [K] | Answer streams, no label [K] | "Thought for Ns ›" plus a Sources pill [V/P] | **Right panel**: bullets, domain chips "+N more", "Done" [V] |
| Claude.ai | Hand-drawn spark [3P] | "Thinking" + timer; one-line summary [V/K] | "Searching the web · *q*" → "Searched the web · N results" [K] | Answer streams; spark at the turn [K] | Collapsed summary + time [K] | **Inline** disclosure [V] |
| Claude Code | `·✢✳✶✻✽` at 120 ms, mirrored [3P] | "Verb… (35s · ↓ 279 tokens · esc to interrupt)" [3P] | Tool rows in the transcript [K] | — | "✻ Crunched for 5m 16s" [3P] | Transcript view modes [V] |
| Gemini | Three waving dots (2026) [3P] | Hidden. Overflow → "See thinking steps" sheet [3P] | — | Wavy underline (low confidence) [3P] | — | **Bottom sheet** [3P] |
| Perplexity | — | "Searching" [3P] | "Reading N sources"; sources arrive first [3P] | "Writing"; teal block cursor [3P] | "Completed N steps", favicons + count [3P] | Inline, collapsed [3P] |
| Grok | — | "Thinking" + timer [K] | DeepSearch steps [3P] | — | "Thought for 1 minute" [V] | Inline "Thoughts" [V] |
| DeepSeek | — | "Thinking…"; raw trace [K] | "Read N web pages" [K] | — | "Thought for N seconds" [3P] | Inline, expanded [K] |
| Cursor | — | "Planning next moves" shimmer [3P] | "Explored N files" groups [3P] | — | "Thought for Ns" auto-collapses [3P] | Inline [V] |
| Linear agents | Ack within 10 s [V] | Ephemeral `thought` [V] | `action` + parameter + result [V] | — | `response`; state `complete` [V] | Issue activity + plan [V] |
| AI Elements | — | `<Shimmer 1s>Thinking...` [V] | ChainOfThought active step [V] | Streamdown caret [V] | "Thought for N seconds", closes after 1 s [V] | Inline collapsible [V] |

### 1.13 Convergent patterns and documented anti-patterns

**Patterns** (seen in three or more products):

1. A single live line: verb + mark + optional timer (ChatGPT, Claude, Claude Code, Cursor, Perplexity,
   AI Elements).
2. The verb changes tense in place at completion (Claude, Perplexity, Claude Code's
   "Crunched for").
3. The finished summary carries a duration (ChatGPT, Grok, DeepSeek, Cursor, AI Elements, Claude Code).
4. Detail lives out of the transcript's main flow: a panel (ChatGPT), a sheet (Gemini), or a collapsed
   disclosure (Claude, Perplexity, Cursor).
5. Favicon stack + count as the provenance glance (ChatGPT, Perplexity).
6. Copy escalates on long waits (Claude Code at 45 s; Juno already has 2 min and 10 min).
7. Explicit stalled or unresponsive states (Claude Code red, VS Code at 60 s, Linear at 10 s).

**Anti-patterns with evidence:**

| Anti-pattern | Evidence | Juno rule [I] |
|---|---|---|
| Busy-looking copy after finishing | Claude Code #52759 | Done must stop all motion *and* change the tense |
| Every past item keeps shimmering | Macro PR #6488 | Only the trailing or active item may loop |
| Auto-collapse under the reader | Cursor forum | Never collapse a disclosure the user opened; collapse only what the system opened, and only when the user is not interacting with it |
| Raw trace expanded by default | DeepSeek, compared with everyone's later move to summaries | Summaries in the transcript; the raw trace only in the dock |
| Status that is easy to miss, or a second surface to learn | ChatGPT teardown (Jun 2026) | The transcript line must say enough alone: verb, count, time |
| Whimsical or personifying verbs | Claude Code complaints; arXiv 2601.16720 | Factual, action-based verbs |

---

## 2. General practice (with dates)

### 2.1 Waiting psychology and thresholds

- **0.1 s / 1 s / 10 s.** Under 0.1 s feels instant. Under 1 s keeps the user's flow. Past 10 s,
  attention goes: users need progress and a way to interrupt [V NN/g, 1993, updated 2014].
- **Indicator by duration.** No indicator under 1 s. A looped indicator for 2–10 s waits on a module.
  Progress bars for waits over 10 s. Skeletons for full-page loads under 10 s. Frame-only skeletons
  are "not recommended". Animated skeletons "can potentially be distracting" [V NN/g "Skeleton
  Screens 101", 2023, reviewed 2026-09-02].
- **Show-delay and minimum visibility.** Show-delay about 150–300 ms, minimum visible about
  300–500 ms, to prevent flicker [V Vercel WIG].
- **Showing intermediate progress raises tolerance for waiting** [V Perplexity case study].
- **Implication [I].** A chat turn that runs 30 s to 30 min is a >10 s wait. A looping shimmer is not
  enough on its own. Pair it with **countable progress**: sources read, steps done, questions covered,
  elapsed time. Use a determinate indicator only when the total is genuinely known (Research
  sub-questions). Never fake a percent-done bar.

### 2.2 Material 3 (Expressive) motion

Material 3 Expressive (2025) replaced most easing and duration pairs with **springs**. There are two
schemes. **Standard** is higher damping and utilitarian. **Expressive** is lower damping, with
overshoot for hero moments. Tokens are split into **spatial** (position, size, shape: may overshoot)
and **effects** (opacity, colour: critically damped), each in fast, default and slow
[V m3.material.io motion pages; token values from AndroidX source].

| Token (mass 1) | Standard ζ / k | Expressive ζ / k | Standard ≈ period, settle, overshoot (my computation) |
|---|---|---|---|
| Fast spatial | 0.9 / 1400 | 0.6 / 800 | 168 ms period, ~260 ms settle, ~0% · Expressive: ~480 ms settle, **9.3%** overshoot |
| Default spatial | 0.9 / 700 | 0.8 / 380 | 237 ms, ~350 ms, ~0% · Expressive: ~480 ms, 1.4% |
| Slow spatial | 0.9 / 300 | 0.8 / 200 | 363 ms, ~475 ms, ~0% · Expressive: ~650 ms, 1.5% |
| Fast effects | 1.0 / 3800 | 1.0 / 3800 | 102 ms, ~190 ms |
| Default effects | 1.0 / 1600 | 1.0 / 1600 | 157 ms, ~270 ms |
| Slow effects | 1.0 / 800 | 1.0 / 800 | 222 ms, ~370 ms |

- **Source of the ζ and k values:** [V] `androidx/compose/material3/.../tokens/StandardMotionTokens.kt`
  and `ExpressiveMotionTokens.kt` (androidx-main, fetched 2026-09-23).
- **Source of the derived columns:** my numerical integration (settle at |x−1| < 0.001).
- **Legacy easing tokens:** emphasized `(0.2, 0, 0, 1)`, emphasized-decelerate `(0.05, 0.7, 0.1, 1)`,
  emphasized-accelerate `(0.3, 0, 0.8, 0.15)`, standard-decelerate `(0, 0, 0, 1)`, standard-accelerate
  `(0.3, 0, 1, 1)`. Durations run from short 50–200 ms, medium 250–400 ms and long 450–600 ms to
  extra-long 700–1000 ms [3P compose-skill reference, from `MotionTokens.kt`].

**Mapping to Juno [I].** Juno's ladder already matches M3 Standard closely:

| Juno | M3 Standard equivalent |
|---|---|
| `fast` 120 ms | effects fast/default |
| `base` 220 ms | default spatial period (237 ms) |
| `slow` 360 ms | slow spatial period (363 ms) |
| framer `spring.standard` {0.22 s, bounce 0.05} | default spatial |
| framer `spring.emphasized` {0.36 s, bounce 0.1} | slow spatial (k ≈ 305, ζ 0.9) |

Juno is a **Standard-scheme** product. Keep Expressive-style overshoot (more than 3%) out of the run UI.

### 2.3 Apple HIG

**Motion principles** [V HIG Motion, change log last entry 2025-09-09 "Added Liquid Glass guidance"]:

- Motion is purposeful. It is never the only carrier of information.
- Feedback is brief and precise. Lightweight animations often communicate better than prominent ones.
- Avoid adding motion to frequent interactions.
- **Let people cancel animations** rather than wait.

**When Reduce Motion is on** [V HIG Accessibility]:

- Tighten springs to reduce bounce.
- Track animations directly to gestures.
- Avoid animating depth (z-axis).
- **Replace x, y and z transitions with fades.**
- **Avoid animating into and out of blurs.**

**SwiftUI springs** [V WWDC23 "Animate with springs"]:

- Springs are specified as `duration` and `bounce`. The default is duration 0.5, bounce 0.
- The presets are `.smooth` (no bounce), `.snappy` (small bounce) and `.bouncy` (larger bounce).
  Commonly cited values are bounce 0, 0.15 and 0.3 [3P].
- Completions should use **perceptual** duration, not settling duration.
- **Conversion used below** (mass 1): stiffness = (2π / duration)², damping = 4π(1 − bounce) / duration,
  so ζ = 1 − bounce.

### 2.4 Practitioner standards (2025–2026)

**Emil Kowalski's animation standards** [3P GitHub `emilkowalski/skills`, 2026]:

- Durations:

  | Element | Duration |
  |---|---|
  | Press feedback | 100–160 ms |
  | Tooltip | 125–200 ms |
  | Dropdown | 150–250 ms |
  | Modal or drawer | 200–500 ms |
  | UI generally | under 300 ms |

- Strong ease-out `(0.23, 1, 0.32, 1)`, ease-in-out `(0.77, 0, 0.175, 1)`, drawer `(0.32, 0.72, 0, 1)`.
  Juno's `drawer` is the same curve.
- Stagger 30–80 ms.
- Never scale from 0; start at 0.9–0.97.
- Gate hover motion with `(hover: hover) and (pointer: fine)`.
- CSS transitions can be interrupted, while keyframes restart, so use transitions for dynamic UI and
  `@starting-style` for entries.
- The frequency rule: the more often something happens, the less it should animate.

**Vercel Web Interface Guidelines:** see §1.10 [V].

### 2.5 Shimmer text

**The technique.** Give the text a gradient background clipped to the glyphs (`background-clip:
text` plus a transparent text fill), and sweep the gradient's position. Variants:

- A **bright band** over muted text: ChatGPT [K], Juno's `.shimmer-text`.
- A **valley**, where the band fades the text toward the page: AI Elements, whose band is
  `--color-background` [V], and Juno's `.aicss-shine` (alpha 0.45). It reads as breathing rather than
  loading, but it **lowers contrast mid-sweep** (§3.13).

**Parameters worth fixing:**

| Parameter | What the references use |
|---|---|
| Period | 1–3 s: AI Elements 2 s, and 1 s in the Reasoning trigger [V]; ChatGPT about 3 s + 0.5 s delay [Est]; Juno 2.2–2.25 s today |
| Band width | Proportional to the text (AI Elements: 2 px per character) |
| Curve | Linear travel (a scan reads as constant speed), plus a **rest** between sweeps so it breathes |
| Direction | Follows the writing direction |

**The cost:**

- `background-position` (and any animated gradient or custom property) is **paint-bound**
  ("C-tier") and runs on the main thread. Animating CSS variables "will always trigger paint", and an
  inherited variable can invalidate style across big subtrees [3P Motion Magazine, "Web animation
  performance tier list", 2025-11-05].
- Only `transform`, `opacity` and `filter` (plus, in newer Chromium, `clip-path`) are composited
  [V Chrome for Developers; web.dev animations guide].
- For a single short label the paint is cheap. The real problem is **jank while React is busy**
  committing streamed tokens, because a main-thread animation drops frames exactly then.
- §4.3 therefore gives a **transform-only** shimmer: a masked window slides one way while a copy of the
  text slides the other, so the glyphs stay aligned.

**Accessibility.**

- Transparent text fill disappears in Windows forced-colors mode unless it is overridden, so give it a
  `forced-colors` fallback (§4.11).
- The shimmer must stop under reduced motion.
- It is a status affordance, never a prose style. Juno's `globals.css` says the same.

### 2.6 Skeletons vs shimmers vs status lines in AI chat

- **Never skeleton the answer.** Its shape is unknown, and a fake paragraph misleads. The status line
  *is* the placeholder [I, consistent with NN/g's "don't use skeletons for non-page processes"].
- **Skeletons are right** only where the final geometry is known: the dock's header and first rows
  while its chunk loads, a source card waiting on its favicon or title, a research report outline
  once the plan is known. They must **match the final layout exactly** [V Vercel WIG].
- Prefer a **pulse** (opacity breath) to a **sweeping shimmer** on skeletons, so the sweep keeps one
  meaning ("working") and skeletons don't borrow it. This is Juno PREMIUM_AUDIT rule 14.

### 2.7 Layout shift while steps stream in

1. **Constant live footprint.** The transcript's live area has a fixed height. The one-line status
   (36 px) is present from Send to Done. Growing lists live in the dock or in fixed-slot windows
   (Grok-style edge-faded trace, Juno's 40 px slots) [I].
2. **Append-only.** New steps go at the end, never above what the reader is looking at. A step that
   changes state changes *in place*, with no height change: tense swap, icon swap, ink change [I].
3. **Stick to the bottom only when pinned.** Follow new content only if the reader was at the bottom.
   Otherwise show a "jump to latest" pill. `use-stick-to-bottom` (StackBlitz Labs) uses
   `ResizeObserver` with velocity-based spring scrolling, and handles scroll anchoring itself because
   Safari lacks `overflow-anchor` [V repo].
4. **Safari still has no `overflow-anchor`.** As of Aug 2026 it is only in Safari Technology Preview;
   stable Safari 27.2 and iOS 27.2 do not have it [V caniuse]. When content above the viewport
   collapses, JS must re-anchor: measure the anchor before, restore after, in a layout effect [I].
5. **Stable skeletons and favicons.** Reserve 16 px circles. Show a monogram fallback. The image fades
   in without changing size [I].
6. **Streaming markdown.** Memoise finished blocks and repair unterminated syntax so a half-written
   `**` or a code fence does not reflow the paragraph when it closes (Streamdown [V]).
   `content-visibility: auto` with `contain-intrinsic-size` for long off-screen content has been
   Baseline since 2025-09-15 [V web.dev].
7. **Measure it.** Record `layout-shift` entries with a `PerformanceObserver` during a scripted run.
   Target: zero shift outside 500 ms after user input [I].

### 2.8 Animating to `height: auto`

| Technique | Support (as of Aug–Sep 2026) | Notes |
|---|---|---|
| `grid-template-rows: 0fr → 1fr` | All engines: Chrome 107+, Firefox 66+, Safari 16+. Some sources say Chrome 111 / Safari 16.4 [3P] | The child needs `min-height: 0` and `overflow: hidden`. Pad the inner wrapper, not the track. Name the property; never `transition: all`. It is a **layout** animation, so keep it short and local. |
| `interpolate-size: allow-keywords` / `calc-size()` | **Chromium only** (Chrome/Edge 129+). Firefox 159 and Safari 27.2: **no** [V caniuse, Aug 2026; MDN, 2026-07-26] | Progressive enhancement only. Set it on the component, not `:root`, so nothing else starts animating. |
| `::details-content` + `content-visibility` with `allow-discrete` | Chrome 131, Firefox 143, Safari 18.4 [V caniuse] | Native `<details>` animation. Needs `interpolate-size` for the `auto` end, so other engines snap. Juno's `/upgrade` page already uses it. |
| `@starting-style` + `transition-behavior: allow-discrete` | Baseline since 2024-08-06 (Chrome 117, Firefox 129, Safari 17.5) [V web.dev] | Entry animations with no JS, and exits from `display: none`. |
| FLIP / Motion `layout` | Any | Transforms plus scale correction. It can distort text mid-flight. Use it for position changes, not for text-heavy expanding blocks. |

### 2.9 View Transitions API

- **Same-document** view transitions have been **Baseline Newly available since 2025-10-14** (Firefox
  144). That includes `startViewTransition`, `view-transition-name`, `view-transition-class`,
  `match-element` and `:active-view-transition`. Firefox's first version has **no view-transition
  types** [V web.dev, 2025-10-16].
- React **19.3** (2026-09-09) made `<ViewTransition>` stable. It only animates updates marked as
  transitions: `startTransition`, Suspense reveals and `useDeferredValue` [3P react.dev blog via
  search, and DevX]. **Juno runs React 19.2.7 and Next 15.5.25**, so use the DOM API directly
  (§4.10) until an upgrade.
- **Caveats [I]:**
  - By default pointer input hits the transition overlay, not the page, while it runs. Keep it at or
    under 360 ms, or set `::view-transition { pointer-events: none }`.
  - Do not start one while the user is selecting text.
  - `flushSync` the React update inside the callback.
  - Set `:root { view-transition-name: none }` for the duration, so only the named regions animate
    and the rest of the page stays live.

### 2.10 Reduced motion and WCAG

- **WCAG 2.2.2 Pause, Stop, Hide (A).** Moving content that starts automatically, lasts **more than
  5 s** and is shown **in parallel with other content** needs a way to pause, stop or hide it, unless
  it is essential. A preloader that is the only content on the page is exempt [V W3C Understanding
  2.2.2]. A chat thinking indicator runs beside the transcript, so it is *not* covered by that
  exemption. It must be stoppable (the Stop button ends the run) and should **quieten itself** on long
  runs. §3.3 does this with "calm mode" after 20 s [I].
- **Apple:** fades instead of x, y and z travel; no blur in or out; tighter springs [V].
- **Juno's tiers** are already right:
  - Tier A keeps state-carrying opacity and colour.
  - Tier B collapses travel through `--motion-shift`.
  - Tier C stops decorative loops in the unlayered kill list.
  - Any new keyframe must read `--motion-shift` and `--motion-scale-from`
    ([internal audit §11](./internal-design-system-motion.md)).

### 2.11 Performance: per-token rendering and compositor-only animation

- **Composited properties:** `transform` (including individual `translate`, `scale` and `rotate`, and
  percentage translates since Chromium 89) and `opacity`. `filter` is composited but variable in cost
  [V Chrome blog; web.dev].
- **Paint- or layout-bound:** `box-shadow`, `background-*`, `color` (paint); width, height and
  grid tracks (layout).
- **WAAPI and CSS animations of composited properties are S-tier:** they stay smooth when the main
  thread is blocked [3P Motion Magazine].
- **Re-rendering the whole message per token** is the main cost. Fixes:
  - Throttle UI flushes to about 30–50 ms. Claude Code's renderer uses 50 ms [3P]; the AI SDK has
    `experimental_throttle` [V].
  - Memoise closed markdown blocks [V AI SDK cookbook; Streamdown].
  - Keep indicators out of the token path: they subscribe to *phase*, not to text [I].
- **An animation restarts** when its element remounts or its `animation-name` changes. It does not
  restart when React re-renders with the same class. Rules [I]:
  - Never key a live node on something that changes per token or per phase.
  - Never add an entrance class after mount. That caused Juno's "dock settle flash".
- **`will-change`:** only while a transient animation runs, then remove it. Never on loops by
  default [I].

### 2.12 Accessibility of live status

- Put `aria-busy="true"` on the message container while it streams. Use a separate **polite** live
  region that announces **state transitions only**: "Thinking", "Searching the web", "Done, thought
  for 12 seconds". Never announce per token or per clock tick. Keep ticking text `aria-hidden`
  [3P TianPan 2026-04; Sara Soueidan; consistent with Juno's existing rule 13].
- Throttle announcements to at least 3 s apart. Always announce *Done*, *Stopped*, *Failed* and
  *Waiting for you* [I].

---

## 3. Recommended motion spec for Juno

### 3.0 Principles (the contract this spec adds to Juno's §10 rules)

1. **One status line per turn, one node from Send to Done.** It never swaps components. Only its
   `data-phase`, label and clock change.
2. **Motion means working.** Loops run only while the system is working. *Waiting for you*,
   *Stopped*, *Failed* and *Done* never loop.
3. **One loop family.** Every loop period is a multiple of `--loop-beat` (1.2 s) and phase-locked to
   the page clock.
4. **One loop owner on screen.** It is the transcript line, or the dock's running row when the dock is
   open. Never both.
5. **Phases animate once.** A phase change is a single swap, at least 700 ms apart, with the newest
   phase winning. Ticks and tokens never restart anything.
6. **Nothing reflows under the reader.** The live footprint is constant. Collapses happen only inside
   the dock or on user action, and are scroll-anchored.
7. **Only `transform` and `opacity` loop.** Colour may cross-fade once. Height animates only inside
   the dock or on a click.
8. **Long runs calm down.** After 20 s the shimmer stops and the glyph slows. Copy escalates at 2 min
   and 10 min (existing).
9. **Done is unmistakable.** All motion stops, the tense changes, the duration freezes, and a single
   gather gesture plays.
10. **Reduced motion keeps meaning.** Every phase has a static signature, liveness is shown by an
    opacity breath, and labels cross-fade.

### 3.1 Tokens

**Keep Juno's existing ladder unchanged:** press 70, fast 120, exit 160, base 220, slow 360,
emphasis 560 ms, and the easings `out-soft`, `out-strong`, `out-expo`, `in`, `in-out`, `breathe`,
`out-back` and `drawer`. **Add these:**

| Token | Value | Use |
|---|---|---|
| `--loop-beat` | 1.2 s | The unit of every loop |
| `--loop` | 2.4 s (2 beats) | Glyph patterns, shimmer, breathing dot, skeleton pulse, research pulse ring. Replaces 1.8 / 2.2 / 2.25 / 1.6 / 1.4 / 2.8 s |
| `--loop-calm` | 4.8 s (4 beats) | Long-run calm mode; the reduced-motion breath |
| `--status-show-delay` | 400 ms | No label before this; a fast answer never flashes "Thinking" |
| `--status-min-visible` | 600 ms | A shown label stays at least this long |
| `--status-dwell` | 700 ms | Minimum time between phase-label changes |
| `--status-timer-after` | 3 s | The elapsed clock appears after this |
| `--status-calm-after` | 20 s | Continuous working time before calm mode |
| `--shift-row` | 4 px | Step enter travel (× `--motion-shift`) |
| `--shift-label` | 0.4 em | Label swap travel |
| `--shift-dock` | 24 px | Dock enter and exit travel |
| `--stagger-row` | 30 ms (= `STAGGER.tight`) | Steps in one arriving batch, capped at 5 |
| `--stagger-fav` | 50 ms | Favicons in one batch, capped at 3 |
| `--spring-standard` / `-dur` | `linear(…)` / 250 ms | CSS version of framer `spring.standard` |
| `--spring-emphasized` / `-dur` | `linear(…)` / 350 ms | CSS version of `spring.emphasized` |
| `--spring-pop` / `-dur` | `linear(…)` / 370 ms, 2.8% overshoot | Favicon and marker pops, **scale only** |

**Springs [I].** The framer presets stay as they are. Their CSS equivalents are generated at token
build time (`npm run design:tokens`) from the same {duration, bounce} pairs:

- k = (2π/d)², ζ = 1 − bounce.
- Sample to |x−1| < 0.004.
- Emit a `linear()` string with 17 points. The values are in §4.1. `linear()` has been Baseline in
  all engines since 2023 [3P Chrome docs / MDN].
- Motion's `spring(visualDuration, bounce)` or Jake Archibald's generator can produce the same strings.

**Rule [I].** Use spatial springs (a little overshoot is allowed) for scale and translate only.
Opacity and colour always use `out-soft` or `in`.

### 3.2 The phase model and its copy

One state machine drives the transcript line, the dock header, the sidebar conversation row and
screen-reader announcements. Every label is an i18n key, and none is built by string concatenation.

| Phase | Enter trigger | Transcript label | Glyph (Concept A) | Loops? | Announce |
|---|---|---|---|---|---|
| `queued` | Send | *(no label for 400 ms)* | The glyph fades in at 150 ms (`fast`), already running the thinking pattern | Yes, from 150 ms | — |
| `thinking` | Reasoning started, or 400 ms passed with no output | Latest reasoning-summary headline if the provider gives one, else "Thinking" | Travelling point (current signature) | Yes | "Thinking" (once) |
| `searching` | `web_search` started | "Searching for “{query}”" (query truncated at about 40 characters) | Column sweep | Yes | "Searching the web" |
| `reading` | Fetch or page read | "Reading {domain}", or "Reading {n} sources" when there are 2 or more in 1 s | Row sweep | Yes | "Reading sources" (throttled) |
| `tool` | Any other tool | The tool's `invoking` string, e.g. "Running code", "Creating an image", "Checking your calendar", "Using Linear" | Perimeter orbit | Yes | The `invoking` string |
| `waiting` | Approval, elicitation or connector auth | "Waiting for your approval" / "Needs your answer" | Static; centre dot in accent | **No** | Assertive: "Needs your input" |
| `writing` | Research synthesis only (see note) | "Writing the report" | Bottom-row typing | Yes | "Writing the report" |
| `done` | Stream end, or first answer token (see note) | "Thought for 12s" (reasoning only) or "Worked for 1m 04s · 3 searches · 14 sources" (tools used), then a favicon stack and a chevron | **Gather** → 6 px resting dot | No | "Done, worked for 1 minute 4 seconds" |
| `stopped` | The user stopped | "Stopped after 12s" | Gather, then the dot | No | "Stopped" |
| `failed` | Error | "Couldn't finish · 12s" (warning ink) | Centre dot in warning ink | No | "Couldn't finish" |
| `stalled` | No event for 30 s while working | Label unchanged, plus a secondary "No response for 30s" in warning ink | The loop slows to calm | Calm | "Still working" (once) |

**When the line settles** (my recommendation; it matches ChatGPT and Claude [K]):

- **Chat turns** settle the line to `done` at the **first answer token**. The streaming answer is
  then its own progress indicator, together with the existing `.stream-tail` mask.
- The clock keeps counting reasoning and tool time only.
- "Writing" is shown only in **Research**, where synthesis takes minutes.
- If a tool call happens *after* answer text has started (interleaved), the line re-enters a working
  phase, and its *done* label counts the total.

**Summary copy rules [I]:**

- "Thought for" when only reasoning happened. "Worked for" when any tool ran.
- Add at most two facts, chosen in this order: searches, sources, code runs, files created.
- Seconds are integers under 60 s. Over 60 s, use `1m 04s`. Over 10 min, use `12m`.
- The same formatter runs live and at rest, and the clock freezes on its last live value (fixes
  "12s → 11.6s").

### 3.3 The thinking indicator

#### 3.3.1 Anatomy (the transcript line)

```
┌──────────────────────────────────────────────────────────────── 36px ─┐
│ [18px glyph] 10px [label · shimmer · flex:1 · 1 line · ellipsis] [facts] [●●● favicons] [clock]│
└────────────────────────────────────────────────────────────────────────┘
```

- **Row:** it is the existing `Pressable kind="row"`.
  - Size: `min-h-9` (36 px), 44 px on `coarse:`, `rounded-field`, `-mx-2 px-2`.
  - It is **the same element live and at rest**. Today the StreamStatus (40 px) swaps to the strip
    (36 px). Keep one element instead.
- **Glyph slot:** 18 px square, `shrink-0`, vertically centred on the first line.
- **Label:** `text-reading` (16 px) `text-muted-foreground` while live. At rest it becomes
  `text-ui font-medium text-foreground/80`, the existing resting style, cross-faded in 220 ms. The
  swap is colour and size only, done by the label-swap mechanism (§4.4). **Pin `leading-6` (24 px) in
  both states.** `text-reading` (1.7) and `text-ui` (1.5) have different line heights, so without the
  pin the box would change height at settle.
- **Facts:** `text-caption font-mono tabular-nums text-muted-foreground`, for example "· 14 sources".
  They appear only once they are non-zero.
- **Favicons:** at most 3 in the transcript (§3.8).
- **Clock:** `text-caption font-mono tabular-nums`, right-aligned, `min-inline-size: 5ch` so the
  width never changes. `aria-hidden`. Visible after 3 s.
- **Order:** the clock sits at the **far right**, so label changes never push it.

#### 3.3.2 Three concepts

All three share the anatomy, the phase model and the pacing rules. They differ only in the glyph.

**Concept A: phase-typed matrix (recommended for the transcript line)**

An evolution of `ThinkingDots`: a 3×3 grid of 4 px dots with 3 px gaps (18 px), the resting grid
`muted-foreground/25`, and a *lit layer* per dot (`::after`, `currentColor` = foreground) whose
**opacity** is the only thing that loops. The `box-shadow` trail is removed: it paints every frame
(internal §6.3). Each phase has its own pattern on the 2.4 s loop:

| Phase | Pattern | Keyframe / delays (§4.5) | Reads as |
|---|---|---|---|
| thinking | A point travels the perimeter clockwise, then through the centre, leaving a short trail | `jn-lit`, delay = sequence × 266 ms | Juno's existing signature |
| searching | A **column** sweeps left → right in 600 ms, then rests | `jn-lit-bar`, delay = col × 200 ms | A scanning beam |
| reading | A **row** sweeps top → bottom in 600 ms, then rests | `jn-lit-bar`, delay = row × 200 ms | Lines being read |
| tool | The perimeter **orbits** twice per loop (1.2 s each); the centre holds at 60% | `jn-lit` at `--loop-beat`, delay = sequence × 150 ms | An engine turning |
| writing | The **bottom row** types left → right; the upper rows stay at rest | `jn-lit-type`, delay = col × 200 ms | A line being written |
| waiting | Nothing moves. The centre dot takes `--primary` (accent) | — | Your move |
| failed | Nothing moves. The centre dot takes `--warning` | — | Stopped on an error |
| done | **Gather:** the 8 outer dots travel 7 px to the centre, scale to 0.4 and fade (360 ms `out-strong`). The centre scales 1.5× (4 → 6 px) and inks to `muted-foreground/45`: the resting dot | Transition, not a keyframe | Settled |

- **Phase swap:** the lit channel dims for 120 ms (`color → transparent`, `in`), the pattern changes
  underneath, and the channel returns over 220 ms (`out-soft`). The base grid never disappears, so the
  glyph never blinks out.
- **Calm mode:** after 20 s of continuous work, every pattern's period becomes 4.8 s.
- **Why A:**
  - It is **ownable**: the dot is Juno's signature, and it avoids a spark or star shape.
  - Phase is legible at a glance without an icon set.
  - It is 9 opacity animations: compositor-only and cheap.
  - It settles into the resting mark the product already uses, so the design stays continuous.

**Concept B: glyph swap (alternative, the most explicit)**

- **Glyph:** a 16 px Phosphor glyph through `icons.tsx`, in the 18 px slot. One glyph per phase:
  - thinking: `Sparkle`, or Juno's own mark at 16 px;
  - searching: `MagnifyingGlass`;
  - reading: `FileText`;
  - code: `Terminal`;
  - image: `ImageSquare`;
  - memory: `Brain`;
  - connector: its provider logo (`rounded-logo`).
- **Motion:**
  - The glyph **does not loop**. Only the label shimmers.
  - Phase change: `IconSwap`, meaning opacity plus scale 0.8 → 1 over `fast` 120 ms.
  - Waiting: the glyph turns accent.
  - Done: it becomes `Check` for 1.2 s through `check-morph`, then cross-fades to the resting dot.
- **Pros:** instantly legible, and it scales to many tool kinds and connectors.
- **Cons:** less ownable, and it adds icon noise on turns that only think. Use B's vocabulary for the
  **dock's step markers** (static kind icons) rather than for the transcript line.

**Concept C: breathing dot (alternative, the most minimal)**

- **Glyph:** a single 6 px dot, the resting mark itself.
  - While working it **breathes**: opacity 0.45 ↔ 1 and scale 0.8 ↔ 1 on `--loop`, `breathe` curve.
  - At done it simply stops at scale 1 and inks to `muted-foreground/45`: zero morph.
  - Waiting: static accent. Failed: static warning.
- **Label:** carries all phase information, with shimmer.
- **Pros:** calmest; one element; perfect continuity.
- **Cons:** the glyph carries no phase information, so it depends entirely on copy.
- **Use C for every *secondary* running marker:**
  - the dock's running step row (as a 20 px ring around the kind icon);
  - sidebar conversation rows with a background run;
  - Research sub-question dots;
  - mobile, when the line is truncated.

**Recommendation [I]:**

- Transcript line: **A + shimmer label**, phase-locked, so the glyph's cycle and the shimmer sweep
  start together and read as one gesture.
- Dock step rows: **B's static kind icons**, with **C's breath** on the running row only.
- When the dock is open, the transcript line goes static: the glyph shows the phase's reduced-motion
  signature and the label has no shimmer. This keeps one loop owner.

#### 3.3.3 Shimmer specification

| Property | Value |
|---|---|
| Base / highlight ink | `--muted-foreground` → `--foreground` (both themes, every accent: no accent in the sweep) |
| Band | 30% of the label width. Leading edge sharper than the tail: gradient stops 35% → 50% → 65%, or skew them to 40/50/70 for a Gemini-style leading edge |
| Travel | Linear over 75% of the period (1.8 s), then rest for 25% (0.6 s). Period `--loop` 2.4 s |
| Direction | Follows `:dir()`; RTL reverses |
| Implementation | **Compositor-only sweep** (§4.3) for the live line. The paint-based `.jn-shimmer` (§4.2) is acceptable only for rare, short-lived labels |
| Stops | Instantly on any non-working phase (`data-settled`): no fade-out loop. After 20 s of continuous work (calm). Under reduced motion. In forced colors |
| Never on | Prose, finished rows, buttons, or more than one element per screen |

### 3.4 Phase-change choreography

A single phase change, t = 0 at the event after dwell gating:

| t (ms) | Glyph (A) | Label | Clock / facts |
|---|---|---|---|
| 0 | Lit channel dims (`fast` 120, `in`) | Old label: opacity → 0, y → −0.4 em (`fast` 120, `in`) | Unchanged (it never moves) |
| 40 | — | New label: from y +0.4 em, opacity 0 → 1 (`base` 220, `out-soft`) | Facts may update (digit roll, `base`, `in-out`) |
| 120 | New pattern runs; channel returns (`base` 220, `out-soft`) | — | — |
| 260 | Settled | Settled; the old node is removed on `transitionend` | — |

Reduced motion: opacity only (both labels cross-fade over 120 ms), the static glyph signature swaps
instantly, and the clock and facts jump.

### 3.5 Pacing rules (the "calm" layer)

1. **Show-delay:** nothing for 150 ms. The glyph appears at 150 ms and the label at 400 ms. If the
   first answer token arrives before 400 ms, the line never shows a label: it goes straight to the
   done summary, or disappears for trivial turns (see §3.9).
2. **Minimum visible:** a shown label stays at least 600 ms.
3. **Dwell:** at least 700 ms between label changes. **The newest phase wins.** Intermediate phases
   are dropped, never queued. A 90 ms tool call that happens during a dwell never flashes.
4. **Coalesce:** 2 or more reads within 1 s become "Reading {n} sources". 2 or more searches within
   1 s become "Searching {n} queries".
5. **Same phase, new detail** (for example a new query): swap the label only if at least 1.5 s has
   passed since the last swap. Otherwise update the facts only.
6. **Calm mode** after 20 s of continuous working (not per phase): the shimmer stops and the glyph
   period becomes 4.8 s. Copy escalation stays as it is today: "Still thinking…" at 2 min, "Still
   working. You can leave…" at 10 min.
7. **Stalled:** no stream event for 30 s while working adds the secondary warning line and forces
   calm mode. It clears on the next event.

### 3.6 Tool steps: transcript vs dock

**In the transcript:**

- **No step list.** The line and its facts summarise the run.
- **Optional "peek"** (Concept A only, desktop only): under the live line, a fixed **2-slot** window
  (2 × 28 px, 8 px top margin) shows the latest two steps. Each is a kind icon plus a caption.
  - New steps enter from below by translating the window (transform, `base`, `out-soft`), not by
    growing it.
  - The window exists only while working. It collapses **at the first answer token**, before the
    answer text renders, not at done. So the one shift (about 64 px) happens before there is anything
    to read under it, and it is scroll-anchored.
  - Recommendation: **ship without the peek first**. Add it only if testing shows users miss seeing
    activity.
- **Reasoning trace:** no raw or summary trace in the transcript by default. It lives in the dock.
  This removes the 180 px viewport and its 560 ms glide from the transcript, and with them bug B2.

**In the dock (one spine of step rows; the existing grid `1.25rem | 1fr | auto | 1.75rem`):**

| Event | Motion | Timing | Reduced |
|---|---|---|---|
| Step appended (a single event) | Opacity 0 → 1, `translate` y 4 px → 0, via `@starting-style` (**mount-only**: never re-plays) | `base` 220, `out-soft` | Opacity, `fast` |
| Batch of up to 5 steps (parallel calls) | Same, staggered 30 ms | Cap 5, so the last starts at 120 ms | No stagger |
| Batch of more than 5 | All fade together, no travel | `fast` 120 | Same |
| Spine segment for a new row | `scaleY` 0 → 1 from the top | `base` 220, `out-soft` | Instant |
| Running → done | Marker: breathing ring stops (ring opacity → 0, `exit` 160). Kind icon stays. Label tense swap (cross-fade, `fast`). Row ink foreground → `muted-foreground` (colour, `base`) | — | Same, without scale |
| Running → failed | Marker ring → static `--warning` ring; icon → `Warning`. **No shake.** | `fast` | Same |
| Running → waiting | Ring → static accent ring; an inline approval control **replaces** the caption in place (it opens with the grid-rows technique inside the row, `base`) | `base` | Instant open |
| Consecutive steps of one kind | Grouped on arrival into one row: "Searched 4 queries" plus a digit roll. The children live in the row's disclosure | Roll `base`, `in-out` | Jump |
| Expand a step (args or result) | Caret rotates 90° (`base`, `in-out`). Body opens with `grid-template-rows` 0fr → 1fr (`base` 220, `in-out`). Inner content fades in 60 ms late (`base`, `out-soft`) | — | Instant open + fade |
| Collapse | Reverse. Content fades first (`exit` 160, `in`), rows close (`base`, `in-out`) | — | Instant |
| Step superseded (retry) | Never removed. Marked "Retried", ink muted | Colour, `base` | Same |
| Auto-follow | If the dock scroller is at the bottom (24 px slop), keep the running row in view with smooth scroll, **at most once per 500 ms**. Otherwise show the "Jump to latest" pill (`pop-in`) | 300 ms smooth | `behavior: auto` |
| Live reasoning trace | Summary headings as rows. The raw trace (if the user switches to Full trace) streams into a **fixed-height, edge-faded window** (Grok pattern): new lines translate up, with no height change | `base`, `out-soft` per line batch, **throttled to at most 1 per 250 ms** | No glide |

**Never auto-collapse** a row the user expanded. The system collapses a group only at done, only if
it opened it, and only if the pointer is not over the dock and the dock has not been scrolled in the
last 2 s (the Cursor lesson).

### 3.7 The right panel (thought dock)

**Layouts:**

| Mode | When | Open | Close |
|---|---|---|---|
| **Split** | `@container/split` ≥ 50 rem (current breakpoint) | **View Transition** (§4.10): the dock enters from x +24 px with opacity 0 → 1 over `slow` 360, `drawer`. The transcript column's old snapshot fades out (120, `in`) and the new one fades in (220, `out-soft`, 80 ms late), top-aligned with `object-fit: none`, so the re-wrap reads as a quick dissolve and never as a snap or a stretch. The scroll anchor (first visible message) is restored inside the callback | Reverse: dock x +24 px, opacity → 0 (`exit` 160, `in`); transcript cross-fade (120 / 220) |
| **Overlay** | < 50 rem, fine pointer | Full-bleed sheet from the right: `translateX(100%)` → 0 (`slow` 360, `drawer`); scrim fades (`fast` 120, `out-soft`) | Sheet out (`exit` 160, `in`); scrim trails (`base` 220, `in`), as in Juno's dialog convention |
| **Bottom sheet** | `coarse:` and < 40 rem (phones) | Rises to the 50% detent (`slow` 360, `drawer`). Drag follows the finger 1:1. On release, a spring (`spring.standard`) with the gesture's velocity goes to the nearest detent (50% / 92% / dismiss). This matches Gemini's 2026 sheet | Spring to dismiss; scrim `base` |
| **No View Transition** (reduced motion, or unsupported) | — | Dock and sheet: opacity only (`base`). The transcript snaps, but the scroll anchor is still restored | Opacity, `exit` |

**Lifecycle rules** (these fix B1 and the empty-column bugs):

- The dock **stays open while an answer streams**. Only the user closes it.
- **Keep the content mounted through the exit.** Use `data-state="closing"` and unmount on
  `animationend`, or `display` with `allow-discrete` (§4.10). Never animate an empty column.
- **Prefetch the dock chunk** when the first working phase begins (`import()`), so the first open
  renders content, not a blank card. If the chunk is still pending, render a **geometry-matched
  skeleton**: a header with a 48 px title bar and three 32 px rows, pulsing on `--loop`.
- **Content swaps** (opening another turn's activity while the dock is open): the header label uses
  the label swap; the body cross-fades (`fast` 120 out, `base` 220 in), with no slide.
- **Tabs** inside the dock (Activity / Sources): the existing `layoutId` thumb; body cross-fade `fast`.
- **Resize:** live, never animated. The handle tint stays as today. Add `scrollbar-gutter: stable` to
  the dock's scroller so a scrollbar appearing never shifts the rows.
- **Loop ownership:**
  - The dock's **running row marker** (Concept C ring) is the only loop.
  - The dock header shows a static state word ("Searching"), the clock and the facts.
  - The transcript line goes static while the dock is open (§3.3.2).
- **Header status word:** uses the §3.4 label swap. It shows the same phase copy as the transcript,
  in `text-ui font-medium`.

### 3.8 Counters and favicons

**Counters** (sources read or cited, steps, searches, minutes):

- Use the existing `RollingNumber` (digit roll, `base` 220, `in-out`) and `font-mono tabular-nums`.
- Set `min-inline-size` to the widest expected value (for example `4ch`).
- **Throttle to one visible change per 500 ms.** For Research, one per second, which matches the
  research audit.
- If the value jumps by more than 1 within the throttle window, roll once to the latest value. Never
  step through intermediate values.
- Mark it `aria-hidden`, and put the value into the row's stable `aria-label` at done.

**Favicon stack:**

| Property | Transcript row | Dock header / Sources |
|---|---|---|
| Size | 16 px | 20 px |
| Max shown | 3, then a "+N" rolling count | 5, then "+N" (matches research audit §6.3) |
| Overlap | −4 px | −5 px |
| Separation | A static 1.5 px ring in the surface colour (`box-shadow: 0 0 0 1.5px hsl(var(--card))`, never animated) | Same |
| Order | First sources stay first. New ones join at the end until the cap, then only "+N" grows. **Never reshuffle** | Same |
| Enter | Opacity 0 → 1 and `scale` 0.6 → 1, `--spring-pop` 370 ms (scale) / `base` `out-soft` (opacity). Stagger 50 ms, capped at 3 per batch | Same |
| Image load | A monogram circle (`bg-secondary`, `text-micro`) first, then the image fades in over 120 ms. **Size never changes** | Same |
| Hover (fine pointer) | The stack spreads: each favicon `translate` x by index × 6 px (`fast` 120, `out-soft`) | — |
| Reduced | Opacity only; no spread | Same |

### 3.9 Completion, stopped, failed, waiting

**Done choreography** (t = 0 at the settle event; replaces the "done storm"):

| t (ms) | What |
|---|---|
| 0 | The shimmer stops **in place**: `data-settled` on the same node. The clock freezes on its last live value. The glyph starts the **gather** (360 ms, `out-strong`) |
| 0 | The label swaps to the summary ("Worked for 1m 04s · 14 sources") via §3.4. `aria-busy="false"`. Announce "Done…" |
| 120 | Favicon stack enters, if any (stagger 50) |
| 360 | Message toolbar (copy, retry, and so on) fades in (`base`, `out-soft`) |
| 600 | Follow-up suggestions `rise-in`, stagger 45 ms |
| ≥ 800 | Chat-title rename (existing `animated-title`), then the memory pill, **at least 200 ms apart** |
| — | Background completion while the user is elsewhere: toast (`emphasis` 560, `out-expo`), as today |

- If the dock is open, the header word becomes "Done" (label swap), the running ring stops, and
  **no row re-animates**.
- **Trivial turns** (the first token arrived before 400 ms, with no tools and no reasoning) never show
  the line at all. Don't label a 0.3 s turn "Thought for 1s". This follows AI Elements, which says
  "a few seconds" when no duration exists [I].
- **Stopped:** the same as done, but the label is "Stopped after 12s", with no favicons or
  follow-ups. The toolbar still appears.
- **Failed:** the glyph does not gather. The centre dot inks `--warning` (colour, `base`). The label
  is "Couldn't finish · 12s" in `text-warning`, with a Retry action in the row. No shake.
- **Waiting:** the loop stops at once. The centre dot is accent, and the label is "Waiting for your
  approval". The row gains the approval affordance in place (the grid-rows open inside the dock, or
  the existing `ApprovalCard` in the transcript, which enters with `rise-in`).

### 3.10 Long runs and Research

This refines [`external-deep-research-audit.md` §6.3](./external-deep-research-audit.md), which stays
authoritative for Research-specific elements (scope card, plan rows, sub-question dots, report card).

- **The same line, the same glyph and the same loop family.** Research uses phases `searching`,
  `reading` and `writing` with the Research grammar ("Searching for EU adoption data").
- **Determinate where it is honest.** Show "3 of 5 questions covered" with sub-question status dots:
  hollow → half → filled, with a label and never colour alone. After about 2 min, once the engine can
  estimate, show an ETA *range* ("about 6–9 min left"). Never show a percent bar [I, per NN/g >10 s].
- **Calm by default.** A Research run is always past 20 s, so its line is in calm mode after the
  first 20 s: no shimmer, 4.8 s glyph. The counters and the clock carry the liveness.
- **The `pulse-ring` on the current stage** moves onto `--loop` (2.4 s), and only one may exist on
  screen. That fixes the "dozen pulse rings" the research audit found.
- **No motion by depth.** Named levels are being removed. Depth shows as time and source counts,
  never as a special animation for "Max". The PREMIUM_AUDIT "And Max moves" line is dead and should be
  deleted.

### 3.11 Reduced-motion fallbacks

| Element | Default | `prefers-reduced-motion: reduce` |
|---|---|---|
| Label shimmer | Transform sweep, 2.4 s | **Off.** Static muted label (Tier C) |
| Matrix glyph (A) | Opacity patterns | Static per-phase signature (§4.5) + an opacity breath of the lit layer on `--loop-calm` (Tier A: it carries state) |
| Breathing dot (C) | Opacity + scale | Opacity only, `--loop-calm` |
| Phase label swap | y 0.4 em + opacity | Opacity cross-fade, `fast` |
| Gather at done | Translate + scale + opacity | Cross-fade to the resting dot, `fast` |
| Step enter | y 4 px + opacity, stagger | Opacity `fast`, no stagger |
| Disclosure open | grid-rows 0fr → 1fr | Instant + content fade |
| Dock or sheet | Slide + View Transition | Opacity only; no VT; the scroll anchor is still restored |
| Favicon enter | Scale pop + opacity | Opacity |
| Counters | Digit roll | Jump |
| Auto-follow scroll | Smooth | Instant |
| Calm mode | After 20 s | Immediately |

All loop kills must live in Juno's **unlayered** reduced-motion block at the end of `globals.css`, and
every new transforming keyframe multiplies travel by `--motion-shift`.

### 3.12 Performance rules

1. **Loops animate only `opacity`, `transform`, `translate` or `scale`.**
   - Delete the `box-shadow` trail from `thinking-matrix`.
   - Replace `background-position` shimmers on live labels with §4.3.
   - Remove the `height` transition on `.aicss-tr-viewport`.
2. **One loop family (`--loop-beat`)**, with phase locking: set `--loop-phase` (a negative delay)
   from `document.timeline.currentTime` at mount **and at every phase change** (§4.12), so remounts
   resume mid-cycle and every loop on screen is in step.
3. **Pause off screen:** an `IntersectionObserver` on the live line and the dock sets
   `data-offscreen`, which sets `animation-play-state: paused`. `StreamProgress` mounts only while
   streaming: today it animates forever at opacity 0.
4. **Keep indicators out of the token path.** The status line and dock rows read a **phase store**
   through `useSyncExternalStore` with selectors. Token deltas never re-render them. The 1 Hz clock
   re-renders only its own `<span>`.
5. **Throttle text flushes** to about 50 ms: `experimental_throttle`, or rAF coalescing in
   `use-chat.ts`. **Memoise closed markdown blocks.** Stop copying `reasoningParts` into a fresh array
   on every delta (internal §6.5).
6. **Never re-key** a row or line on status change. **Never add an entrance class after mount.**
   Entrances use `@starting-style` (they fire on insertion only).
7. **Batch arrivals:** step rows and favicons flush in batches, at most every 250 ms while streaming.
8. **Long dock lists:** `content-visibility: auto; contain-intrinsic-size: auto 32px` on rows past the
   first screen; `contain: layout paint` on each row.
9. **`will-change: transform`** only on the dock during its enter or exit, removed on `transitionend`.
10. **Budget:** at most **one** infinite animation per visible region (transcript, dock), and at most
    about 20 running `Animation` objects in total (`document.getAnimations().length`). Assert this in
    the dev gallery.
11. **Verify under stress:** Chrome DevTools with **4× CPU throttle** while a fixture streams at
    50 tokens/s:
    - "Paint flashing" must show **no** paint on the shimmer (the compositor variant);
    - the glyph and the sweep stay at 60 fps;
    - `layout-shift` is 0 after the first token.

### 3.13 Accessibility rules

- The line is a `Pressable` with a **stable** `aria-label` that changes once per phase-kind change and
  once at settle ("Thought process, worked for 1 minute 4 seconds, 14 sources"). Ticking text and the
  label copy inside are `aria-hidden` (existing rule 13).
- There is one polite live region per chat, fed by the phase store. It announces transitions at least
  3 s apart, and always announces Done, Stopped, Failed and Waiting. *Waiting* is announced
  assertively.
- `aria-busy` is on the streaming message.
- The **Stop** control stays reachable and stops all motion, which satisfies WCAG 2.2.2 alongside
  calm mode.
- Forced colors:
  - the shimmer is removed;
  - the matrix dots use `CanvasText` (lit) and `GrayText` (rest) with `forced-color-adjust: none`;
  - the accent centre uses `Highlight`.
- Contrast: the muted label is ≥ 4.5:1 (Juno's `--muted-foreground` floor). The shimmer highlight is
  **darker or lighter than the base in both themes** (it moves toward foreground), so legibility never
  drops mid-sweep. This is why Juno's current *valley* (alpha 0.45) should not be used on the live
  label: it lowers contrast to about 2:1 mid-sweep.

### 3.14 How this spec fixes the internal audit's defects

| Internal finding ([`internal-thinking-and-right-panel.md`](./internal-thinking-and-right-panel.md)) | Fix in this spec |
|---|---|
| B1: the dock closes itself when an answer streams | §3.7 lifecycle: only the user closes it |
| B2: live blocks unmount at done → ~190 px jump | §3.6: no trace or search block in the transcript; the optional peek collapses at the first token, scroll-anchored |
| StreamStatus → strip handoff (new matrix, 40 → 36 px, re-fade) | §3.3.1: one persistent 36 px node from Send to Done |
| "Done storm" (6–9 uncoordinated changes) | §3.9 choreography |
| Dock settle flash (entrance class re-added at done) | §3.12.6: `@starting-style`, mount-only |
| Empty column on first open, and on exit | §3.7: prefetch, geometry skeleton, content mounted through exit |
| Chat width snaps on dock toggle, reader's place drifts | §3.7 / §4.10: View Transition dissolve + scroll-anchor restore |
| Five loop periods beating | §3.1: one loop family; phase locking |
| Matrix `box-shadow`, `background-position` shine, `height` transition | §3.12.1 |
| 560 ms trace glide nearly always mid-flight | Trace moves to the dock; line batches at most once per 250 ms, `base` 220 |
| Clock "12s → 11.6s" at settle | §3.2: one formatter; freeze the last live value |
| Right-column exits slide under reduced motion | §3.11: every exit is opacity-only under reduce |
| `stream-progress` animates forever at opacity 0 | §3.12.3: mount only while streaming |
| Per-token re-render of strip and dock | §3.12.4–5 |
| `AgentStatusBadge` `animate-ping` + tinted pill | Replace it with Concept C's dot: static unless working, neutral pill |

### 3.15 Verification plan

- Add `/dev/run?state=queued|thinking|searching|reading|tool|waiting|writing|done|stopped|failed|stalled&dock=0|1&peek=0|1&long=1`.
  - It plays fixture event streams through the **real** components.
  - It has a speed control and a "burst" mode that fires 20 tool events in 1 s, to test dwell and
    coalescing.
  - Follow the existing `/dev/*` contract: `notFound()` in production and no auth.
- Check each state:
  - in light and dark;
  - under all six accents (the waiting accent dot);
  - with reduced motion emulated;
  - in forced colors (DevTools rendering emulation);
  - at 375 px (the bottom sheet), 800 px (the split breakpoint) and 1440 px.
- Automated:
  - an animation-count assertion (`document.getAnimations()`);
  - a `layout-shift` observer during a scripted run (expect 0 after the first token);
  - the dwell-queue unit tests (§4.12).
- Manual: the 4× CPU throttle paint-flashing check from §3.12.11.

---

## 4. Snippets

These are written for Juno. They use its HSL variables (`hsl(var(--x))`), its `--dur-*` and `--ease-*`
tokens, `--motion-shift` and `--motion-scale-from`. The `jn-` prefix is a placeholder, so rename to
the house convention. Component classes go in `@layer components`. The reduced-motion and forced-colors
overrides go in the **unlayered** block at the end of `globals.css`.

### 4.1 Tokens

```css
:root {
  /* One loop family: every loop is a multiple of the beat, so loops never beat against each other. */
  --loop-beat: 1.2s;
  --loop: calc(var(--loop-beat) * 2);        /* 2.4s */
  --loop-calm: calc(var(--loop-beat) * 4);   /* 4.8s */

  /* Travel (always multiplied by --motion-shift, which reduced motion sets to 0) */
  --shift-row: 4px;
  --shift-label: 0.4em;
  --shift-dock: 24px;

  --stagger-row: 30ms;
  --stagger-fav: 50ms;

  /* CSS springs generated from the framer presets (mass 1, k = (2π/d)², ζ = 1 − bounce).
     Spatial springs: transform/scale only. Opacity and colour keep out-soft / in. */
  --spring-standard-dur: 250ms;   /* spring.standard {0.22s, bounce 0.05} */
  --spring-standard: linear(0, 0.078, 0.235, 0.404, 0.555, 0.679, 0.775, 0.845, 0.895, 0.931,
                            0.955, 0.972, 0.982, 0.989, 0.994, 0.996, 1);
  --spring-emphasized-dur: 350ms; /* spring.emphasized {0.36s, bounce 0.1} */
  --spring-emphasized: linear(0, 0.058, 0.185, 0.335, 0.478, 0.604, 0.709, 0.792, 0.855, 0.902,
                              0.936, 0.959, 0.975, 0.986, 0.993, 0.997, 1);
  --spring-pop-dur: 370ms;        /* {0.30s, bounce 0.25}: 2.8% overshoot, scale only */
  --spring-pop: linear(0, 0.094, 0.289, 0.502, 0.686, 0.826, 0.922, 0.981, 1.013, 1.026, 1.028,
                       1.024, 1.018, 1.013, 1.008, 1.004, 1);
}
```

JS pacing constants belong in `src/lib/motion.ts` next to `STAGGER`, not in CSS: show-delay 400,
min-visible 600, dwell 700, timer-after 3000, calm-after 20000, stalled-after 30000.

### 4.2 Shimmer label, paint-based (simple; rare or short-lived labels only)

```css
@layer components {
  .jn-shimmer {
    --shimmer-base: var(--muted-foreground);
    --shimmer-hi: var(--foreground);
    color: hsl(var(--shimmer-base));                 /* fallback if clipping is unsupported */
    background-image: linear-gradient(90deg,
      hsl(var(--shimmer-base)) 0%,
      hsl(var(--shimmer-base)) 40%,
      hsl(var(--shimmer-hi)) 50%,
      hsl(var(--shimmer-base)) 62%,                  /* longer tail than lead: a directional band */
      hsl(var(--shimmer-base)) 100%);
    background-size: 300% 100%;                      /* band ≈ 0.6 × label width */
    background-position: 100% 0;                     /* band parked just left of the text */
    -webkit-background-clip: text;
            background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: jn-shimmer var(--loop) linear infinite;
    animation-delay: var(--loop-phase, 0ms);
  }
  .jn-shimmer:dir(rtl) { animation-direction: reverse; }
  /* Settled: same node, same box; it simply stops. */
  .jn-shimmer[data-settled] {
    animation: none;
    background-image: none;
    -webkit-text-fill-color: currentColor;
  }
  @keyframes jn-shimmer {
    0%        { background-position: 100% 0; }      /* off the left edge  */
    75%, 100% { background-position: 0% 0; }        /* off the right edge, then rest 0.6s */
  }
}
```

### 4.3 Shimmer label, compositor-only (use this for the live status line)

A masked **window** slides left → right. Inside it, a highlight copy of the text slides right → left
by exactly the same amount, so the lit glyphs stay pixel-aligned with the base copy. Both animations
are transform-only with no `var()` in the keyframes, so the compositor runs them even while the main
thread is busy committing tokens.

```html
<span class="jn-sweep" data-settled="false">
  <span class="jn-sweep__text">Searching for “heat pump subsidies”</span>
  <span class="jn-sweep__window" aria-hidden="true">
    <span class="jn-sweep__text jn-sweep__text--hi">Searching for “heat pump subsidies”</span>
  </span>
</span>
```

```css
@layer components {
  .jn-sweep {
    position: relative;
    display: inline-block;
    max-inline-size: 100%;
    overflow: hidden;                /* clips the window while it is off either edge */
    contain: paint;
    vertical-align: bottom;
  }
  .jn-sweep__text {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;         /* both copies ellipsize identically: same width */
    color: hsl(var(--muted-foreground));
  }
  .jn-sweep__window {
    position: absolute;
    inset: 0;
    pointer-events: none;
    user-select: none;
    /* The lit band is 30% of the label, centred in the window (35% → 50% → 65%). */
    -webkit-mask-image: linear-gradient(90deg, transparent 35%, #000 50%, transparent 65%);
            mask-image: linear-gradient(90deg, transparent 35%, #000 50%, transparent 65%);
    animation: jn-sweep-window var(--loop) linear infinite;
    animation-delay: var(--loop-phase, 0ms);
  }
  .jn-sweep__text--hi {
    color: hsl(var(--foreground));
    animation: jn-sweep-counter var(--loop) linear infinite;
    animation-delay: var(--loop-phase, 0ms);
  }
  /* At −65% the band's right edge sits exactly on the label's left edge; at +65% its left edge
     sits on the label's right edge. 0–75% travel (1.8s), 75–100% rest (0.6s). */
  @keyframes jn-sweep-window {
    0%        { transform: translateX(-65%); }
    75%, 100% { transform: translateX(65%); }
  }
  @keyframes jn-sweep-counter {
    0%        { transform: translateX(65%); }
    75%, 100% { transform: translateX(-65%); }
  }
  .jn-sweep:dir(rtl) :is(.jn-sweep__window, .jn-sweep__text--hi) { animation-direction: reverse; }
  .jn-sweep[data-settled="true"] .jn-sweep__window { display: none; }
  .jn-sweep[data-offscreen] :is(.jn-sweep__window, .jn-sweep__text--hi) { animation-play-state: paused; }
}
```

Notes:

- Only the base copy is exposed to assistive technology. The highlight copy is `aria-hidden` and
  cannot be selected.
- The window and its child share `--loop-phase` and the same timing, so the compositor samples them on
  the same frame. Their transforms cancel exactly, and the glyphs cannot drift.
- Check it with DevTools → Rendering → **Paint flashing**: the label must not flash while it sweeps.

### 4.4 Phase-label swap

Two labels share one grid cell. The outgoing one is marked `data-leaving` and removed on
`transitionend`. The incoming one enters through `@starting-style`, so it animates once, on insertion
only.

```html
<span class="jn-phase" aria-hidden="true">
  <span class="jn-phase__label" data-leaving>Thinking</span>
  <span class="jn-phase__label">Searching for “heat pumps”</span>
</span>
```

```css
@layer components {
  .jn-phase { display: grid; min-inline-size: 0; }
  .jn-phase__label {
    grid-area: 1 / 1;
    min-inline-size: 0;
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    transition:
      opacity var(--dur-base) var(--ease-out-soft) 40ms,
      translate var(--dur-base) var(--ease-out-soft) 40ms;
  }
  @starting-style {
    .jn-phase__label {
      opacity: 0;
      translate: 0 calc(var(--shift-label) * var(--motion-shift, 1));
    }
  }
  .jn-phase__label[data-leaving] {
    opacity: 0;
    translate: 0 calc(var(--shift-label) * -1 * var(--motion-shift, 1));
    transition-duration: var(--dur-fast);
    transition-timing-function: var(--ease-in);
    transition-delay: 0ms;
  }
}
```

### 4.5 Phase-typed matrix (Concept A)

```html
<!-- data-r / data-c for selectors; --r / --c / --s for delay maths.
     --s is the thinking sequence: perimeter clockwise 0–7, centre 8. -->
<span class="jn-matrix" data-phase="thinking" aria-hidden="true">
  <i data-r="0" data-c="0" style="--r:0;--c:0;--s:0"></i>
  <i data-r="0" data-c="1" style="--r:0;--c:1;--s:1"></i>
  <i data-r="0" data-c="2" style="--r:0;--c:2;--s:2"></i>
  <i data-r="1" data-c="0" style="--r:1;--c:0;--s:7"></i>
  <i data-r="1" data-c="1" style="--r:1;--c:1;--s:8" data-centre></i>
  <i data-r="1" data-c="2" style="--r:1;--c:2;--s:3"></i>
  <i data-r="2" data-c="0" style="--r:2;--c:0;--s:6"></i>
  <i data-r="2" data-c="1" style="--r:2;--c:1;--s:5"></i>
  <i data-r="2" data-c="2" style="--r:2;--c:2;--s:4"></i>
</span>
```

```css
@layer components {
  .jn-matrix {
    --dot: 4px;
    --gap: 3px;                          /* pitch 7px; box 18px (size-4.5) */
    display: inline-grid;
    grid-template-columns: repeat(3, var(--dot));
    gap: var(--gap);
    flex-shrink: 0;
    color: hsl(var(--foreground));       /* the lit ink */
    transition: color var(--dur-base) var(--ease-out-soft);
  }
  .jn-matrix[data-swapping] {            /* 120ms dim while the pattern changes underneath */
    color: transparent;
    transition: color var(--dur-fast) var(--ease-in);
  }
  .jn-matrix > i {
    position: relative;
    inline-size: var(--dot);
    block-size: var(--dot);
    border-radius: 999px;
    background: hsl(var(--muted-foreground) / 0.25);   /* the resting grid: always visible */
    transition:
      translate var(--dur-slow) var(--ease-out-strong),
      scale var(--dur-slow) var(--ease-out-strong),
      opacity var(--dur-base) var(--ease-out-soft),
      background-color var(--dur-base) var(--ease-out-soft);
  }
  .jn-matrix > i::after {                /* lit layer: opacity is the only thing that loops */
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: currentColor;
    opacity: 0;
    animation: var(--lit-name, none) var(--lit-period, var(--loop)) linear infinite;
    animation-delay: calc(var(--loop-phase, 0ms) + var(--lit-delay, 0ms));
  }

  .jn-matrix[data-phase="thinking"]  > i { --lit-name: jn-lit;     --lit-delay: calc(var(--s) * 266ms); }
  .jn-matrix[data-phase="searching"] > i { --lit-name: jn-lit-bar; --lit-delay: calc(var(--c) * 200ms); }
  .jn-matrix[data-phase="reading"]   > i { --lit-name: jn-lit-bar; --lit-delay: calc(var(--r) * 200ms); }
  .jn-matrix[data-phase="tool"]      > i { --lit-name: jn-lit; --lit-period: var(--loop-beat);
                                           --lit-delay: calc(var(--s) * 150ms); }
  .jn-matrix[data-phase="tool"]      > i[data-centre]::after { animation: none; opacity: 0.6; }
  .jn-matrix[data-phase="writing"]   > i[data-r="2"] { --lit-name: jn-lit-type;
                                                       --lit-delay: calc(var(--c) * 200ms); }

  /* Calm mode (after 20s of work): same patterns, twice as slow. Keep this after the phase rules. */
  .jn-matrix[data-calm] > i { --lit-period: var(--loop-calm); }

  /* Waiting / failed: nothing moves; the centre carries the state. */
  .jn-matrix[data-phase="waiting"] > i[data-centre] { background: hsl(var(--primary)); }
  .jn-matrix[data-phase="failed"]  > i[data-centre] { background: hsl(var(--warning)); }

  /* Done: the outer eight gather into the centre; the centre becomes the 6px resting dot. */
  .jn-matrix[data-phase="done"] > i:not([data-centre]) {
    opacity: 0;
    scale: 0.4;
    translate:
      calc((1 - var(--c)) * 7px * var(--motion-shift, 1))
      calc((1 - var(--r)) * 7px * var(--motion-shift, 1));
  }
  .jn-matrix[data-phase="done"] > i[data-centre] {
    scale: 1.5;
    background: hsl(var(--muted-foreground) / 0.45);
  }

  @keyframes jn-lit      { 0% { opacity: 0 } 6% { opacity: 1 } 30% { opacity: .3 } 42%, 100% { opacity: 0 } }
  @keyframes jn-lit-bar  { 0% { opacity: 0 } 8% { opacity: 1 } 28% { opacity: .25 } 40%, 100% { opacity: 0 } }
  @keyframes jn-lit-type { 0% { opacity: 0 } 4% { opacity: 1 } 60% { opacity: .7 } 80%, 100% { opacity: 0 } }
}
```

To change phase in JS:

1. Set `data-swapping`.
2. After 120 ms, set the new `data-phase` and a fresh `--loop-phase` (§4.12).
3. Remove `data-swapping`.

The resting grid never disappears.

### 4.6 Breathing dot (Concept C) and the dock's running ring

```css
@layer components {
  .jn-dot {
    inline-size: 6px;
    block-size: 6px;
    border-radius: 999px;
    background: hsl(var(--muted-foreground) / 0.45);   /* the resting mark */
    transition: background-color var(--dur-base) var(--ease-out-soft), scale var(--dur-fast) var(--ease-out-soft);
  }
  .jn-dot[data-state="working"] {
    background: hsl(var(--foreground));
    animation: jn-breathe var(--loop) var(--ease-breathe) infinite;
    animation-delay: var(--loop-phase, 0ms);
  }
  .jn-dot[data-state="waiting"] { background: hsl(var(--primary)); }
  .jn-dot[data-state="failed"]  { background: hsl(var(--warning)); }

  /* Running marker in the dock: a ring around the static kind icon breathes; the icon does not. */
  .jn-step-marker { position: relative; }
  .jn-step-marker[data-state="running"]::before {
    content: "";
    position: absolute;
    inset: -3px;
    border-radius: 999px;
    box-shadow: inset 0 0 0 1.5px hsl(var(--primary));  /* static geometry; only opacity/scale move */
    animation: jn-breathe var(--loop) var(--ease-breathe) infinite;
    animation-delay: var(--loop-phase, 0ms);
  }

  @keyframes jn-breathe {
    0%, 100% { opacity: 0.45; scale: calc(1 - 0.2 * var(--motion-shift, 1)); }
    50%      { opacity: 1;    scale: 1; }
  }
}
```

The keyframe reads `--motion-shift` so the scale collapses under reduced motion. That makes it a
style-dependent keyframe. If profiling shows it is not composited, split it into two keyframes: an
opacity-only one for reduced motion and a fixed-scale one for everything else.

### 4.7 Height-auto disclosure

```html
<div class="jn-collapse" data-open="false">
  <div class="jn-collapse__inner" inert>
    <div class="jn-collapse__pad"><!-- padding lives here, never on the track --></div>
  </div>
</div>
```

```css
@layer components {
  /* 1) Cross-browser: grid track 0fr ↔ 1fr (Chrome 107+, Firefox 66+, Safari 16+). */
  .jn-collapse {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--dur-base) var(--ease-in-out);
  }
  .jn-collapse[data-open="true"] { grid-template-rows: 1fr; }
  .jn-collapse__inner {
    min-block-size: 0;
    overflow: hidden;
    opacity: 0;
    visibility: hidden;
    transition:
      opacity var(--dur-exit) var(--ease-in),
      visibility 0s linear var(--dur-base);            /* hide after the close finishes */
  }
  .jn-collapse[data-open="true"] > .jn-collapse__inner {
    opacity: 1;
    visibility: visible;
    transition:
      opacity var(--dur-base) var(--ease-out-soft) 60ms,
      visibility 0s;
  }

  /* 2) Native <details> (Chrome 131, Firefox 143, Safari 18.4 for ::details-content).
        The `auto` end interpolates only where interpolate-size exists (Chromium, Aug 2026);
        elsewhere it snaps open, which is acceptable progressive enhancement. */
  details.jn-details { interpolate-size: allow-keywords; }       /* scoped, never :root */
  details.jn-details::details-content {
    block-size: 0;
    overflow: clip;
    transition:
      block-size var(--dur-base) var(--ease-in-out),
      content-visibility var(--dur-base) allow-discrete;
  }
  details.jn-details[open]::details-content { block-size: auto; }
}
```

Toggle `inert` on `.jn-collapse__inner` together with `data-open`, so closed content cannot be
focused. This is a layout animation: use it in the dock and on user clicks, never for automatic
changes in the transcript.

### 4.8 Staggered list entry, mount-only

```html
<!-- --i is the index within the arriving batch (0..n), not the list index.
     Rows present when the dock mounts past the first screen get data-instant. -->
<li class="jn-step" style="--i:2">…</li>
```

```css
@layer components {
  .jn-step {
    transition:
      opacity var(--dur-base) var(--ease-out-soft),
      translate var(--dur-base) var(--ease-out-soft);
    transition-delay: calc(min(var(--i, 0), 4) * var(--stagger-row));   /* cap: 5 rows, ≤120ms */
  }
  /* @starting-style fires only when the element is first rendered: re-renders, status changes
     and "streaming → done" can never replay it (the dock settle flash). */
  @starting-style {
    .jn-step:not([data-instant]) {
      opacity: 0;
      translate: 0 calc(var(--shift-row) * var(--motion-shift, 1));
    }
  }
  /* Later state changes animate colour only and must not inherit the entry delay. */
  .jn-step[data-settled] { transition-delay: 0ms; }

  /* Spine segment for a new row grows from the top (transform only). */
  .jn-step__spine {
    transform-origin: top;
    transition: scale var(--dur-base) var(--ease-out-soft);
  }
  @starting-style { .jn-step:not([data-instant]) .jn-step__spine { scale: 1 0; } }
}
```

### 4.9 Favicon stack

```html
<!-- --i is the favicon's POSITION in the stack (0..4). Sources are append-only, so position is also
     arrival order: it drives both the entry stagger and the hover spread. -->
<span class="jn-favs" aria-hidden="true">
  <span class="jn-fav" style="--i:0"><img src="…" alt="" onload="this.dataset.loaded=''"></span>
  <span class="jn-fav" style="--i:1"><span class="jn-fav__mono">W</span></span>
  <span class="jn-favs__more">+11</span>
</span>
```

```css
@layer components {
  .jn-favs { display: inline-flex; align-items: center; }
  .jn-fav {
    position: relative;
    display: grid;
    place-items: center;
    inline-size: 16px;
    block-size: 16px;
    border-radius: 999px;
    overflow: hidden;
    background: hsl(var(--secondary));
    box-shadow: 0 0 0 1.5px hsl(var(--card));          /* static separation ring */
    margin-inline-start: -4px;
    transition:
      opacity var(--dur-base) var(--ease-out-soft),
      scale var(--spring-pop-dur) var(--spring-pop),
      translate var(--dur-fast) var(--ease-out-soft);
    transition-delay: calc(min(var(--i, 0), 2) * var(--stagger-fav));
  }
  .jn-fav:first-child { margin-inline-start: 0; }
  @starting-style { .jn-fav { opacity: 0; scale: var(--motion-scale-from, 0.6); } }
  .jn-fav > img {
    inline-size: 100%;
    block-size: 100%;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out-soft);
  }
  .jn-fav > img[data-loaded] { opacity: 1; }
  .jn-fav__mono { font-size: 0.625rem; font-weight: 500; color: hsl(var(--muted-foreground)); }

  @media (hover: hover) and (pointer: fine) {
    .jn-favs:hover .jn-fav {
      translate: calc(var(--i, 0) * 6px * var(--motion-shift, 1)) 0;
      transition-delay: 0ms;
    }
  }
}
```

`.jn-fav__mono` uses a raw `font-size`. Swap it for the `text-micro` utility, or the design-system
text lint will flag it.

### 4.10 Dock open and close

**(a) CSS-only.** For the overlay sheet, or when the transcript width does not change. The content
stays rendered through the exit.

```css
@layer components {
  .jn-dock {
    transition-property: translate, opacity, display;
    transition-duration: var(--dur-slow), var(--dur-base), var(--dur-slow);
    transition-timing-function: var(--ease-drawer), var(--ease-out-soft), linear;
    transition-behavior: allow-discrete;       /* display flips at the END of the exit */
  }
  .jn-dock:not([data-open]) {
    display: none;
    opacity: 0;
    translate: calc(var(--shift-dock) * var(--motion-shift, 1)) 0;
    transition-duration: var(--dur-exit), var(--dur-exit), var(--dur-exit);
    transition-timing-function: var(--ease-in), var(--ease-in), linear;
  }
  @starting-style {
    .jn-dock[data-open] {
      opacity: 0;
      translate: calc(var(--shift-dock) * var(--motion-shift, 1)) 0;
    }
  }
  .jn-dock__scroller { scrollbar-gutter: stable; overscroll-behavior: contain; }
}
```

**(b) View Transition.** For split mode, where the transcript re-wraps.

```ts
import { flushSync } from "react-dom";

/** Open or close the dock with a View Transition: the dock slides, the transcript dissolves
 *  from its old wrap to its new one instead of snapping. React 19.2 has no stable
 *  <ViewTransition>, so this uses the DOM API directly. */
export function transitionDock(open: boolean, commit: (open: boolean) => void) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const selecting = !!window.getSelection()?.toString();
  const anchor = captureScrollAnchor(); // first visible message id + its offset from the scroller top
  if (reduce || selecting || !("startViewTransition" in document)) {
    flushSync(() => commit(open));
    anchor.restore();                    // Safari has no overflow-anchor
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = open ? "dock-open" : "dock-close";
  const vt = document.startViewTransition(() => {
    flushSync(() => commit(open));
    anchor.restore();
  });
  vt.finished.finally(() => { delete root.dataset.vt; });
}
```

```css
/* Only the two named regions animate; the rest of the page stays live under the overlay. */
html[data-vt^="dock"] { view-transition-name: none; }
html[data-vt^="dock"] .chat-column  { view-transition-name: chat-column; }
html[data-vt^="dock"] .thought-dock { view-transition-name: dock; }

::view-transition-group(chat-column) {
  animation-duration: var(--dur-slow);
  animation-timing-function: var(--ease-drawer);
}
/* Never stretch text: draw each snapshot at its natural size, top-centred, and dissolve. */
::view-transition-old(chat-column),
::view-transition-new(chat-column) {
  block-size: 100%;
  object-fit: none;
  object-position: 50% 0;
  mix-blend-mode: normal;   /* the UA default plus-lighter would bolden overlapping text */
}
::view-transition-old(chat-column) { animation: var(--dur-fast) var(--ease-in) both jn-vt-out; }
::view-transition-new(chat-column) { animation: var(--dur-base) var(--ease-out-soft) 80ms both jn-vt-in; }

::view-transition-new(dock):only-child { animation: var(--dur-slow) var(--ease-drawer) both jn-vt-dock-in; }
::view-transition-old(dock):only-child { animation: var(--dur-exit) var(--ease-in) both jn-vt-dock-out; }

@keyframes jn-vt-out      { to   { opacity: 0; } }
@keyframes jn-vt-in       { from { opacity: 0; } }
@keyframes jn-vt-dock-in  { from { opacity: 0; transform: translateX(var(--shift-dock)); } }
@keyframes jn-vt-dock-out { to   { opacity: 0; transform: translateX(var(--shift-dock)); } }
```

### 4.11 Reduced motion and forced colors (unlayered, end of `globals.css`)

```css
@media (prefers-reduced-motion: reduce) {
  /* Tier C: decorative sweeps stop. */
  .jn-shimmer { animation: none; background-image: none; -webkit-text-fill-color: currentColor; }
  .jn-sweep__window { display: none; }

  /* Tier A: the matrix keeps state. Each phase shows a static signature and the lit layer breathes
     in opacity only. */
  .jn-matrix > i::after { animation: none; }
  .jn-matrix[data-phase="thinking"]  > i[data-centre]::after,
  .jn-matrix[data-phase="searching"] > i[data-c="1"]::after,
  .jn-matrix[data-phase="reading"]   > i[data-r="1"]::after,
  .jn-matrix[data-phase="tool"]      > i:is([data-r="0"], [data-r="2"]):is([data-c="0"], [data-c="2"])::after,
  .jn-matrix[data-phase="writing"]   > i[data-r="2"]::after { opacity: 1; }
  .jn-matrix:is([data-phase="thinking"], [data-phase="searching"], [data-phase="reading"],
                [data-phase="tool"], [data-phase="writing"]) {
    animation: jn-breathe-opacity var(--loop-calm) var(--ease-breathe) infinite;
  }
  .jn-matrix > i { transition-duration: var(--dur-fast); }      /* gather becomes a quick fade */

  .jn-dot[data-state="working"],
  .jn-step-marker[data-state="running"]::before {
    animation-name: jn-breathe-opacity;
    animation-duration: var(--loop-calm);
  }
  .jn-step, .jn-fav { transition-delay: 0ms !important; }
}
@keyframes jn-breathe-opacity { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }

@media (forced-colors: active) {
  .jn-shimmer {
    animation: none; background: none;
    color: CanvasText; -webkit-text-fill-color: CanvasText;
  }
  .jn-sweep__window { display: none; }
  .jn-matrix > i, .jn-dot { forced-color-adjust: none; background: GrayText; }
  .jn-matrix > i::after { background: CanvasText; }
  .jn-matrix[data-phase="waiting"] > i[data-centre],
  .jn-dot[data-state="waiting"] { background: Highlight; }
}
```

### 4.12 TS helpers: phase locking, dwell queue, clock, offscreen pause

```ts
/** Negative delay that puts a loop at the page clock's current point in its cycle. Set it at
 *  mount AND at every phase change: remounts then resume mid-cycle, and every loop on the page
 *  is in step (glyph and shimmer read as one gesture). */
export function loopPhase(periodMs: number): string {
  const now = Number(document.timeline?.currentTime ?? performance.now());
  return `${-(now % periodMs)}ms`;
}

/** Status-label pacing: show-delay, dwell, newest-wins. Intermediate phases are dropped, never
 *  queued, so a 90ms tool call inside a dwell never flashes. Terminal phases skip the dwell. */
export type PhaseKey =
  | "thinking" | "searching" | "reading" | "tool" | "writing"
  | "waiting" | "done" | "stopped" | "failed";
export interface Phase { key: PhaseKey; label: string; detailKey?: string }

export function createPhasePacer(
  show: (p: Phase) => void,
  { showDelay = 400, dwell = 700 }: { showDelay?: number; dwell?: number } = {},
) {
  const startedAt = performance.now();
  let shownAt = -Infinity;
  let current: Phase | null = null;
  let pending: Phase | null = null;
  let timer: number | undefined;
  const terminal = (k: PhaseKey) => k === "done" || k === "stopped" || k === "failed" || k === "waiting";

  const flush = () => {
    timer = undefined;
    if (!pending) return;
    current = pending;
    pending = null;
    shownAt = performance.now();
    show(current);
  };

  return {
    push(p: Phase) {
      if (current && current.key === p.key && current.detailKey === p.detailKey) return;
      pending = p;                                   // newest wins
      const now = performance.now();
      const wait = terminal(p.key)
        ? 0
        : Math.max(startedAt + showDelay - now, shownAt + dwell - now, 0);
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, wait);
    },
    dispose() { window.clearTimeout(timer); },
  };
}

/** One formatter for live and settled: integer seconds, never decimals, so nothing jumps at settle. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${m}m`;
}

/** Pause loops that are off screen (IntersectionObserver → data-offscreen). */
export function observeOffscreen(el: Element): () => void {
  const io = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) el.removeAttribute("data-offscreen");
    else el.setAttribute("data-offscreen", "");
  });
  io.observe(el);
  return () => io.disconnect();
}
```

The unit tests for `createPhasePacer` should cover:

- a burst of 20 events in 1 s shows at most 2 labels;
- a terminal phase shows immediately;
- nothing shows before 400 ms;
- the same key with the same detail is a no-op.

---

## 5. Unverified items and open questions

- **ChatGPT's shimmer CSS** (the 3 s loop, 0.5 s delay and 50% × 200% background) comes from
  2025 memory. chatgpt.com is behind a Cloudflare challenge and could not be fetched. Treat the values
  as estimates.
- **The claude.ai spark's placement and cadence**, and the shimmering one-line thinking summary, are
  [K]. The only 2026 primary source (the Help Center) confirms only "a Thinking indicator with a
  timer" and an expandable section.
- **Gemini 2026 in-chat thinking visuals** (three waving dots, the wavy underline) come from secondary
  press. Google publishes no motion spec for Neural Expressive.
- **Perplexity timings** are a third-party reconstruction (§1.5).
- **Cursor** behaviour comes from forum threads and one third-party renderer's PR, not from Cursor docs.
- **Open question for the owner:** ship the optional transcript "peek" (§3.6), or rely on the line
  plus the dock? The recommendation is to ship without it and add it only if users miss visible
  activity.
- **Open question:** Concept A (matrix) vs Concept C (dot) for the transcript line. The recommendation
  is A. Prototype both in `/dev/run` before committing, and judge them at 100% zoom in both themes
  with a real 30 s run.
- **Engineering check:** that Chrome composites the `jn-breathe` keyframes when they read
  `--motion-shift`. If not, use the fixed-value split described in §4.6.

---

## 6. Sources (all accessed 2026-09-23)

**Claude and Anthropic**

- Claude Help Center, extended thinking: https://support.claude.com/en/articles/10574485-using-extended-thinking
- Claude Help Center, Research: https://support.claude.com/en/articles/11088861-use-research-on-claude
- Claude platform docs, thinking: https://platform.claude.com/docs/en/build-with-claude/thinking
- Redesigning Claude Code on desktop (2026-04-14): https://claude.com/blog/claude-code-desktop-redesign
- Claude Code's thinking animation (2026-02-07): https://blog.alexbeals.com/posts/claude-codes-thinking-animation
- tweakcc (spinner defaults): https://github.com/Piebald-AI/tweakcc
- Kyle Martinez, reverse engineering Claude's ASCII spinner: https://medium.com/@kyletmartinez/reverse-engineering-claudes-ascii-spinner-animation-eec2804626e0
- ROROSUKE LABO on the Claude Code spinner (2026-03-06): https://note.com/rorosuke/n/na1d87a50ad61
- What we can learn from the Claude Code source (2026-04-01): https://brtkwr.com/posts/2026-04-01-what-we-can-all-learn-from-the-claude-code-source/
- Claude Code issue #52759: https://github.com/anthropics/claude-code/issues/52759
- Claude Code issue #30032: https://github.com/anthropics/claude-code/issues/30032
- Claude Code issue #52420: https://github.com/anthropics/claude-code/issues/52420
- Claude Code changelog digest: https://www.gradually.ai/en/changelogs/claude-code/

**OpenAI**

- Community forum, the pulsating dot (2024-02-27): https://community.openai.com/t/chat-gpt-4-dont-want-to-use-web-browsing-on-pc-but-on-iphone-it-works/657811
- Simon Willison, "Research Goblin" (2025-09-06): https://simonwillison.net/2025/Sep/6/research-goblin/
- AI UX Playground, ChatGPT output teardown (2026-06-15): https://aiuxplayground.com/teardowns/chatgpt/output/
- ChatKit types: https://openai.github.io/chatkit-python/api/chatkit/types/
- Deep research in ChatGPT: https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt
- AppleInsider, the Think button (2026-08-06): https://appleinsider.com/articles/26/08/06/new-chatgpt-version-has-a-think-button-will-find-more-reliable-facts

**Google**

- 9to5Google, full Gemini redesign (2026-05-03): https://9to5google.com/2026/05/03/gemini-full-redesign/
- 9to5Google, Gemini at I/O 2026 (2026-05-19): https://9to5google.com/2026/05/19/gemini-app-google-io-2026/
- Android Headlines, Gemini UI overhaul: https://www.androidheadlines.com/2026/05/google-gemini-app-redesign-ui-overhaul-2026.html
- urdesignmag on Neural Expressive (2026-05-21): https://www.urdesignmag.com/google-gemini-neural-expressive-redesign-2026/
- Precision Pulse on Neural Expressive: https://precisionpulse.co/gemini-app-neural-expressive-redesign-2026/
- Google Design, Gemini visual design: https://design.google/library/gemini-ai-visual-design
- Android Authority, Gemini animation teardown (2025-10-14): https://www.androidauthority.com/google-gemini-new-animation-apk-teardown-3606914/

**Perplexity, Grok, DeepSeek, Cursor, Linear**

- AI UX Playground, Perplexity output (2026-06-15): https://aiuxplayground.com/teardowns/perplexity/output/
- Perplexity design guide: https://blakecrosley.com/guides/design/perplexity
- LangChain, Perplexity case study: https://www.langchain.com/breakoutagents/perplexity
- Grok features: https://suprmind.ai/hub/grok/grok-features/
- 21st.dev AI thinking component: https://21st.dev/@preetsuthar17/components/ai-thinking
- AI UX Playground, DeepSeek composer (2026-06-16): https://aiuxplayground.com/teardowns/deepseek/composer/
- Cursor forum, "Planning next moves": https://forum.cursor.com/t/cursor-agent-stuck-in-planning-next-moves/150064
- Cursor forum, auto-collapsing thoughts: https://forum.cursor.com/t/dont-auto-collapse-thoughts-while-the-user-is-still-reading-them/170175
- Cursor forum, hidden tool-call details: https://forum.cursor.com/t/new-version-hides-agent-tool-call-details-in-defiance-of-setting/165292
- Cursor changelog 3.0: https://cursor.com/changelog/3-0
- Macro PR #6488 (2026-09-16): https://github.com/macro-inc/macro/pull/6488
- Linear Agent Interaction Guidelines: https://linear.app/developers/aig
- Linear, developing the agent interaction: https://linear.app/developers/agent-interaction
- Linear changelog, AIG and SDK (2025-07-30): https://linear.app/changelog/2025-07-30-agent-interaction-guidelines-and-sdk

**Vercel**

- AI Elements Shimmer source: https://raw.githubusercontent.com/vercel/ai-elements/main/packages/elements/src/shimmer.tsx
- AI Elements Reasoning source: https://raw.githubusercontent.com/vercel/ai-elements/main/packages/elements/src/reasoning.tsx
- AI Elements Chain of Thought source: https://raw.githubusercontent.com/vercel/ai-elements/main/packages/elements/src/chain-of-thought.tsx
- AI Elements Reasoning docs: https://elements.ai-sdk.dev/components/reasoning
- Streamdown carets: https://streamdown.ai/docs/carets
- Streamdown animation: https://streamdown.ai/docs/animation
- Streamdown 2.5 changelog: https://vercel.com/changelog/streamdown-2-5
- AI SDK smoothStream: https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream
- AI SDK memoisation cookbook: https://ai-sdk.dev/cookbook/next/markdown-chatbot-with-memoization
- Vercel Web Interface Guidelines: https://vercel.com/design/guidelines

**Material and Apple**

- M3 motion overview: https://m3.material.io/styles/motion/overview/how-it-works
- AndroidX `ExpressiveMotionTokens.kt`: https://raw.githubusercontent.com/androidx/androidx/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/ExpressiveMotionTokens.kt
- AndroidX `StandardMotionTokens.kt`: https://raw.githubusercontent.com/androidx/androidx/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/StandardMotionTokens.kt
- compose-skill M3 motion reference: https://github.com/aldefy/compose-skill/blob/master/skills/compose-expert/references/material3-motion.md
- M3 Expressive loading indicator (2025-05-16): https://9to5google.com/2025/05/16/material-3-expressive-loading-indicator/
- Apple HIG, Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- Apple HIG, Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- WWDC23 notes, Animate with springs: https://wwdcnotes.com/documentation/wwdc23-10158-animate-with-springs/

**Practice, performance and web platform**

- Emil Kowalski, animation standards: https://github.com/emilkowalski/skills/blob/main/skills/review-animations/STANDARDS.md
- Motion Magazine, performance tier list (2025-11-05): https://motion.dev/magazine/web-animation-performance-tier-list
- Chrome, hardware-accelerated animations: https://developer.chrome.com/blog/hardware-accelerated-animations
- web.dev animations guide: https://web.dev/articles/animations-guide
- Motion transitions (`visualDuration`): https://motion.dev/docs/react-transitions
- Motion CSS springs: https://motion.dev/docs/css
- Jake Archibald's linear() easing generator: https://github.com/jakearchibald/linear-easing-generator
- NN/g, response times: https://www.nngroup.com/articles/response-times-3-important-limits/
- NN/g, skeleton screens: https://www.nngroup.com/articles/skeleton-screens/
- W3C, Understanding 2.2.2: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- MDN, `interpolate-size`: https://developer.mozilla.org/en-US/docs/Web/CSS/interpolate-size
- caniuse, `interpolate-size`: https://caniuse.com/mdn-css_properties_interpolate-size_allow-keywords
- caniuse, `::details-content`: https://caniuse.com/mdn-css_selectors_details-content
- caniuse, `overflow-anchor`: https://caniuse.com/css-overflow-anchor
- Chrome, animate to height auto: https://developer.chrome.com/docs/css-ui/animate-to-height-auto
- CSS-Tricks, grid height transitions: https://css-tricks.com/css-grid-can-do-auto-height-transitions/
- web.dev, same-document view transitions Baseline: https://web.dev/blog/same-document-view-transitions-are-now-baseline-newly-available
- web.dev, entry animations Baseline: https://web.dev/blog/baseline-entry-animations
- web.dev, content-visibility Baseline: https://web.dev/blog/css-content-visibility-baseline
- React 19.3 (2026-09-09): https://react.dev/blog/2026/09/09/react-19-3
- use-stick-to-bottom: https://github.com/stackblitz-labs/use-stick-to-bottom
- NumberFlow: https://number-flow.barvian.me/
- TianPan, streaming accessibility (2026-04-17): https://tianpan.co/blog/2026/04/17/ai-accessibility-streaming-screen-readers
- "Watching AI Think" (arXiv 2601.16720, Jan 2026): https://arxiv.org/abs/2601.16720
