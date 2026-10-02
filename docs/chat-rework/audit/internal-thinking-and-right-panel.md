# Internal audit: the thinking animation and the right-hand panel (web chat)

Status: read-only audit of branch `web/tools-thinking-research` at `d0997af2`, 23 September 2026.
Scope: what the user called "the thinking animation" and "the sidebar (the right one)" in the web
chat at chat.liams.dev. It feeds a full redesign, so every claim below cites the file and line it
comes from. Nothing here was run in a browser. Behaviour was read from the code, and where a
conclusion depends on runtime ordering it says so.

---

## 0. Summary

- **"The right sidebar" is the thought-process dock**, a docked column opened from the one-line
  "run strip" above each assistant answer (`ActivityTimeline` portals `ThoughtProcessPanel` into a
  column that `chat-view.tsx` mounts). Two other surfaces use the same right edge and are mutually
  exclusive with it: the **canvas** (artifacts) and the **document viewer** (files). They share one
  width slot. Everything else that looks like a "panel" (research console and recap, Work run
  panel, citation audit) is **inline in the transcript**, not on the right.
- **The "thinking animation" is not one thing.** A single turn can show up to about nine different
  "working" vocabularies: a 3×3 dot matrix (`ThinkingDots`), a text shine (`.aicss-shine`), a masked
  4-line reasoning viewport, a stream-tail mask on the answer, a 2px coral sweep in the shell, a
  spinner on the send button, a coral dot matrix plus a pulsing dot on streaming artifact cards, a
  SMIL globe on the legacy research path, and `Loader2` spinners on python, citation-audit and visual
  blocks. There are five different loop periods (1.4s, 1.6s, 1.8s, 2.25s, 2.8s).
- **The biggest functional bug:** if the dock is open while an answer streams, **it closes itself
  when the answer finishes**. The assistant message's id changes from `temp-…` to the server id at
  `done`, and chat-view's reconciliation effect then drops a dock whose id no longer exists. There
  is no exit animation (§7, B1).
- **The biggest visual bug:** the live reasoning viewport and the search block **unmount without
  any exit at `done`**. Up to about 190px of content above the answer disappears in one frame, so
  the answer jumps up under the reader (§7, B2).
- **Live state is often wrong or missing.** A normal web search shows "Thinking" the whole time. A
  tool call in flight is never marked running in the panel. A turn blocked on the user's approval
  says "Thinking", and after 2 minutes "Still thinking…". Artifact events never appear (§6.1).
- **The information architecture takes two clicks to read the thinking.** You open the dock, and
  then every row is collapsed, including "Full reasoning trace". The dock leads with a recap
  sentence, three figures (Elapsed, **Cost**, Sources) and a filter/find/copy toolbar. Its content
  is organised as a machine ledger (Research / Think / Write sections with step counts). It is not
  the chronological narrative of thinking and tool calls that people expect from Claude and ChatGPT.
- **Performance:** every answer token re-splits the whole reasoning trace
  (`activity-timeline.tsx:269`). With the dock open, the whole panel re-renders (all rows, each with
  Radix tooltips) on every token and every 1Hz tick. The dot matrix animates `box-shadow` (paint),
  and the shell sweep animates forever even when invisible.
- **Code health:** these files have seen 32 and 25 commits, the panel is 1,647 lines, and about
  40% of the text is comments that record past debates. Several of those comments now contradict the
  code, and `docs/JUNO.md` §4.2 describes a panel ("PROFILE vs FACTS") that no longer exists. No
  `/dev` gallery and no rendering tests exist for the strip or the panel.

---

## 1. Files read

| File | Lines | Role |
|---|---|---|
| `src/components/chat/chat-view.tsx` | 2589 | Owns the split mount, dock open/close state, the canvas and the document columns |
| `src/components/chat/split-layout.ts` | 136 | Split breakpoint (800px mount), dock and canvas bounds |
| `src/hooks/use-split-pane.ts` | 454 | Resizable right column: drag, keyboard, persistence |
| `src/components/chat/thought-panel-context.tsx` | 69 | Context: `openId`, `container`, `seedDraft`, `coversChat` |
| `src/components/chat/activity-timeline.tsx` | 439 | The run strip above each answer; owns the run clock; portals the panel |
| `src/components/chat/thought-process-model.tsx` | 804 | `buildRun` / `buildSteps` / `useRunClock` (data model) |
| `src/components/chat/thought-process-panel.tsx` | 1647 | The dock UI |
| `src/components/chat/message-item.tsx` | 1613 | `StreamStatus`, mounts the strip, answer body, stream tail |
| `src/components/chat/generation-placeholder.tsx` | 133 | Image and video generation placeholder |
| `src/components/signature/thinking-dots.tsx` | 46 | 3×3 thinking matrix |
| `src/components/aicss/thinking-reasoning.tsx` | 175 | Masked live reasoning viewport |
| `src/components/aicss/thinking-state.tsx` | 47 | Text shine |
| `src/components/aicss/web-search.tsx` | 236 | Search block with the SMIL globe |
| `src/lib/reasoning-lines.ts`, `src/lib/reasoning-parts.ts`, `src/lib/run-receipt.ts` | — | Line chunking, part folding, summary and span formatting |
| `src/hooks/use-chat.ts` | — | Stream reducer (status, activity, reasoning, delta, done) |
| `src/app/api/chat/route.ts` | — | Activity events the producer emits |
| `src/app/globals.css`, `tailwind.config.ts`, `src/lib/motion.ts` | — | Keyframes, motion tokens, reduced-motion tiers |
| `src/components/app/app-shell.tsx` | — | `StreamProgress` 2px sweep |
| `src/components/chat/session-outputs.tsx`, `research-run-panel.tsx`, `code/code-session-view.tsx` | — | Neighbouring surfaces |
| `docs/design/ICONS_AND_MOTION.md`, `FLAT_UI.md`, `SOFT_UI.md`, `PREMIUM_AUDIT.md`, `REVIEW_2026-09-02.md` | — | Design language the critique is measured against |

`framer-motion` is used by UI primitives (`collapse.tsx`, `composer-shell.tsx`, `segmented-control.tsx`,
`tabs.tsx`, `switch.tsx`, `micro.tsx`, `hold-button.tsx`, `surface-tabs.tsx`). **None of the thinking
or panel code uses it.** The dock and the thinking indicators are CSS keyframes plus
`tailwindcss-animate`. The only framer piece in the panel is the `Collapse` behind "Details".

---

## 2. What "the right sidebar" is

### 2.1 Mechanics

- The chat root is a `@container/split` flex row (`chat-view.tsx:1974-1990`). It holds the **chat
  column** (`flex-1`) and up to **one docked column on the right**.
- **Split breakpoint:** `SPLIT_MIN_WIDTH = 320 + 480 = 800px` of *mount* width, not window width
  (`split-layout.ts:87`). The CSS says the same thing as `@[50rem]/split:`, and the code asks
  `splitEngaged()` (`split-layout.ts:109-112`). With the 304px sidebar expanded, the window needs to
  be at least about 1104px before a dock sits beside the chat.
- **At or above the split,** the chat narrows beside the dock. Nothing is dimmed, focus is not
  trapped, and the chat stays typeable.
- **Below the split,** the dock is full-bleed and the chat column (including the composer) is
  `display:none` (`chat-view.tsx:1999`).
- **Coexistence rule:** the thought dock, the canvas and the document viewer are mutually
  exclusive, and the newest request wins. The one that gets evicted leaves **without** an exit
  (`chat-view.tsx:969-992`, `994-1009`, `1020-1033`).
- **Resize:** `useSplitPane` gives drag with pointer capture, ←/→ steps, Home to reset,
  double-click to reset and localStorage persistence (`juno:thought-width`, `juno:canvas-width`).
  - Thought dock: undragged width is the CSS class `w-[30rem]` (480px). Drag floor is 400px
    (`THOUGHT_MIN_WIDTH`), with 280px on cramped mounts. Cap is 60% of the mount, and the chat keeps
    320px (`split-layout.ts:72-135`).
  - Canvas and document: floor 420px, cap 82%, reset to 46% of the mount. A drag past the cap asks
    the shell to collapse the sidebar.
- **While a docked column is open,** the chat header's action cluster (Outputs chip, Share,
  Incognito) is hidden (`chat-view.tsx:1914`).
- **Esc** closes the thought dock through a window-level listener, unless a nearer layer already
  called `preventDefault` (`chat-view.tsx:1109-1121`).
- **Motion:** the dock enters with `duration-base` (220ms), `ease-drawer`, `fade-in` and
  `slide-in-from-right-4` (16px). Reduced motion gets a fade only. It exits with `duration-exit`
  (160ms), `ease-in`, `fade-out` and `slide-out-to-right-4`, positioned `absolute` so the chat
  reflows underneath at once (`chat-view.tsx:2439-2452`). `closingThoughtId` keeps the column
  mounted for 180ms (`chat-view.tsx:1058-1063`).

### 2.2 Every right-side surface, and when it appears

| # | Surface | Where it renders | Opens when | Width | Notes |
|---|---|---|---|---|---|
| R1 | **Thought-process dock** (`ThoughtProcessPanel`) | Right column `chat-view.tsx:2421-2477`; content portalled from `ActivityTimeline` (`activity-timeline.tsx:418-436`) | Click on the run strip above any assistant answer that has activity or reasoning | 480px default, drag 400px to 60% | One dock per chat. Opening it closes the canvas and the file viewer. `bg-card`. Code sessions reuse it with a second, diverging implementation (`code-session-view.tsx:103-140`, `1217-1232`) |
| R2 | **Canvas** (`CanvasPanel`, lazy) | `chat-view.tsx:2498-2541` | Artifact card click, `?artifact=` deep link, Outputs popover | Stored px, at least 420px, cap 82%, reset 46% | Same slide recipe. Fullscreen mode (`fixed inset-0` inside the mount). `bg-background` |
| R3 | **Document viewer** (`DocumentViewer`, lazy) | `chat-view.tsx:2545-2580` | Attachment tile click, Outputs popover | Shares the canvas width and handle | Same slot as R2, a third party to the coexistence rule |
| R4 | **Outputs popover** (`SessionOutputs`) | Popover anchored to the chip at the top right of the header band (`session-outputs.tsx:248-386`) | Chip click. The chip only exists once the chat has made or used something | 21rem, max height 30rem | Not a column. Hidden while R1 to R3 are open, because the whole action cluster is hidden |
| — | Shell stream sweep (`StreamProgress`) | 2px line at the top of `<main>` (`app-shell.tsx:74-84`, `625`) | Busy **and** the composer is off-screen (for example, the dock covers the chat on mobile) (`chat-view.tsx:1405-1432`) | Full width | A "working" signal, not a panel. Listed because it appears *because of* the dock |
| — | Research console and recap, Work run panel | **Inline** in the transcript via `inlineRuns` (`chat-view.tsx:2261-2268`) | A research run or delegated task | Column width | Not right-side. The research report opens in a **modal dialog** (`research/report-dialog.tsx`) |
| — | Citation audit panel, sources pill | Inline under the answer (`message-item.tsx:1419-1428`) | After `done` | Column width | Not right-side |
| — | Realtime voice panel | Above the composer (`chat-view.tsx:2317`) | Voice mode | Column width | Not right-side. It blocks opening R2 or R3 below the split |

### 2.3 ASCII: the layout and its states

**A. Desktop, dock closed, answer streaming (mount ≥ 800px)**

```
┌─────────┬─────────────────────────────────────────────────────────────────────┐
│ sidebar │  Conversation title                        [▤ 2] [share] [incog]   │ h-14 band, no border
│  304px  │                                                                     │
│         │                                       ┌────────────────────────┐    │
│         │                                       │ user bubble            │    │ rise-in 6px/220ms
│         │                                       └────────────────────────┘    │
│         │  ⠿  Thinking · 12s                                                  │ live strip, 16px muted
│         │     │ Designing the caching layer                                   │ reasoning viewport
│         │     │ Weighing Redis against in-process LRU…                        │ 13px, 2-line clamp,
│         │     │ …                                                             │ max 180px, masked
│         │  [Linear needs approval — card]  (only while blocked)               │
│         │  Answer text streaming…  last line dimmed by .stream-tail           │
│         │                                                                     │
│         │        ┌────────────────── composer ───────────────── [■] ┐         │ send→stop face
└─────────┴────────┴─────────────────────────────────────────────────────┴─────┘
```

**B. Desktop, dock open while streaming**

```
┌───────┬──────────────────────────────┬┃──────────────────────────────────────┐
│sidebar│ Conversation title           │┃ ⠿ Thinking · 12s          [≡][⧉][×] │ 48px, border-b
│       │ (actions cluster hidden)     │┃──────────────────────────────────────│
│       │                              │┃ Using Linear · create_issue          │ recap sentence
│       │           ┌──────────────┐   │┃ (min-h 2 lines)                      │ = strip's live copy
│       │           │ user bubble  │   │┃ 12s          —            1          │ figures: text-ui mono
│       │           └──────────────┘   │┃ Elapsed      Cost         Tool calls │ captions: mono label
│       │ ▓ ● Thinking · 12s ▓ (sel.)  │┃──────────────────────────────────────│
│       │   │ reasoning viewport…      │┃ Think                        3 steps │ sticky mono section
│       │                              │┃ │○ › Full reasoning trace            │ collapsed by default
│       │   Answer…                    │┃ │◇   Linear · create_issue    (idle!)│ in-flight tool NOT
│       │                              │┃ │◉   Thinking               (coral)  │ marked running
│       │                              │┃──────────────────────────────────────│
│       │                              │┃ › Details                            │ model/effort/context/
│       │   ┌──── composer ────┐       │┃             [↓ Live]                 │ tools/billed/memory
└───────┴──────────────────────────────┴┃──────────────────────────────────────┘
                                        ↑ 12px separator: hairline tints on hover,
                                          grip appears on hover/focus
```

**C. Desktop, dock open on a settled run**

```
┃ • Done · 12.4s                                 [≡][⧉][×] ┃
┃──────────────────────────────────────────────────────────┃
┃ Thought for 3.1s, read 5 sources across 4 domains and    ┃ toRunSummary()
┃ wrote 612 tokens.                                        ┃
┃ 12.4s            $0.004            5                     ┃
┃ Elapsed          Cost              Sources               ┃
┃ ▌⚠ Notice                                               ┃ only when warnings or
┃ ▌  The model stopped at its token limit.                 ┃ finishNote
┃──────────────────────────────────────────────────────────┃
┃ Research                                        5 steps  ┃
┃ │[fav] Page title                               [ 3 ]    ┃ cite chip on hover
┃ │      nature.com                                        ┃
┃ Think                                           2 steps  ┃
┃ │ ○ › Designing the caching layer                        ┃ OpenAI summary parts
┃ │       Weighing Redis against…                          ┃ (detail = 90-char preview)
┃ │ ◇ › Linear · create_issue          Failed  2.4s  [↻]   ┃ "Ask to run again"
┃ Write                                           1 step   ┃
┃ │ ▢   Wrote the answer                          9.3s     ┃
┃ │     612 tokens                                         ┃
┃──────────────────────────────────────────────────────────┃
┃ › Details                                                ┃
```

**D. A row, expanded (tool call)**

```
│ ◇ │ ⌄ Linear · create_issue                  │ 2.4s │ [⧉] │  bg-secondary when open
│   │  ┌ Arguments ─────────────────────────┐  │      │     │  AicssCodeBlock, max 220px
│   │  │ { "title": "…" }                   │  │      │     │
│   │  └────────────────────────────────────┘  │      │     │
│   │  ┌ Result ────────────────────────────┐  │      │     │  max 320px
│   │  └────────────────────────────────────┘  │      │     │
│   │  Exactly what Juno sent each connector…  │      │     │  TOOLS_DESCRIPTION
│   │  [Copy step] [Ask to run again]          │      │     │
  20px            1fr                           auto   28px
```

**E. Below the split (phone, or a narrow window with the sidebar open)**

```
┌───────────────────────────┐
│ ☰   Juno            [+]   │ shell mobile bar
├═══════════════════════════┤ 2px coral sweep, 1.4s loop (composer is hidden)
│ ‹  Thinking · 12s  [≡][⧉] │ dock header: back chevron, NO dot matrix at this width
│───────────────────────────│
│ recap…                    │
│ figures…                  │
│ spine…                    │
│                           │
│        [↓ Live]           │
└───────────────────────────┘   chat column and composer are display:none
```

**F. The run strip's states (in the transcript, above the answer)**

```
StreamStatus (before any event)  ⠿  Sending                          min-h-10, 16px muted, role=status
live                             ⠿  Thinking · 4s                    min-h-9, text-reading 16px muted
live, research (legacy path)     ⠿  Reading nature.com · 4 sources · 31s
live, tool                       ⠿  Using Linear · create_issue · 9s
live, dock open                  ●  Thinking · 4s        (bg-selected, static coral dot)
rest, with reasoning             •  Thought process · 3 sources · 1 tool call ....... 12.4s ›   text-ui 13px
rest, no reasoning               •  Run · 5 sources ................................. 3.1s ›
rest, warning                    •  Run · 2 tool calls · Usage limit reached ........ 8.0s ›   (warning ink)
plain completion                 (no row at all)
```

---

## 3. The dock, part by part

Source: `thought-process-panel.tsx`, `thought-process-model.tsx`.

1. **Header**, `min-h-12`, `pl-3 pr-2` (`:714-865`).
   - Below the split: a back chevron.
   - At the split: a `ThinkingDots` while streaming, or a static grey dot at rest, in a 16px box.
   - Status word: `Researching`, `Thinking`, `Writing`, `Done` or `Stopped`, then `· 12s`.
   - Filter menu: Find in this run; All steps; up to five kinds with counts; Summary or Full trace
     (settled runs with reasoning only); Expand all; Collapse all.
   - Copy menu: summary, run, sources, and visible steps when filtered.
   - Close ×, at the split only.
2. **Find bar**, 40px, when opened (`:867-921`). Esc clears the text first, then closes the bar.
3. **Recap** (`:936-1013`).
   - While streaming, the sentence is the strip's `live.message`. Once settled, it is
     `toRunSummary()` ("Thought for 3.1s, read 5 sources… and wrote 612 tokens.").
     It has `min-h-[2.6rem]` and is keyed on `streaming`, so it fades once at settle.
   - Three figures: **Elapsed**, **Cost**, and **Sources** or **Tool calls**.
   - A **Notice** block (warning left stripe) listing warnings and `finishNote`.
4. **Spine** (`:1016-1080`).
   - Grouped into sticky mono section heads **Research / Think / Write**, each with "N steps".
   - A hairline runs through a 20px marker column.
   - Row recipe (`StepRow`, `:1208-1531`): marker | label plus optional detail | figure (measured
     ms only, or "Failed") | a 28px action revealed on hover or focus (cite chip, open ↗, ask to run
     again, or copy).
   - Rows with a body are `<button aria-expanded>` and expand through `grid-rows` in 220ms.
   - Bodies: prose (reasoning), a tool args/result pair in `AicssCodeBlock`s, or a memory with
     Forget.
   - **All rows start collapsed.**
5. **Details** (`:1083-1158`). A `Collapse` holding Model, Effort, Context, Tools, Billed, and
   "Memory used" rows that carry Forget / Open source chat / Manage all.
6. **Live pill** (`:1172-1190`). Shown when streaming and the reader has scrolled more than 24px up.
   `animate-pop-in`. Clicking it resumes following.
7. **Keyboard.** Focus moves to the `<aside>` on open. j/k/↑/↓/Home/End move between rows (scoped to
   the scroller). Esc closes (chat-view).
8. **Screen readers.** The scroller is `aria-live="off"`. A single `role=status` announcer debounced
   at 500ms says the phase word while streaming and the summary plus duration at settle
   (`:676-683`, `:923-925`).

**What `buildRun` turns the event stream into** (`thought-process-model.tsx:345-525`, `541-750`):

- **Phases** are derived only from timestamps: RESEARCH is corpus-ready minus the first search,
  THINK is time to first `write` minus research, and WRITE is `write` to `usage`.
- **Steps**, in emission order:
  - Search rows come only from `"Searching the web"` events, which only `deep-research.ts:149`
    sends.
  - Source rows come from `visit` events.
  - Think rows are OpenAI summary parts (with a title when the part opens with `**Bold**`), or a
    single "Full reasoning trace" row for providers that stream unbroken prose (Anthropic, Zhipu,
    Mistral, Google).
  - Tool rows come only from `tool` events whose title starts with `"Using "`.
  - Notice rows come from warnings.
  - Memory rows are filed under Details.
  - One Write row.
  - A synthetic "running" row ("Waiting for the model", "Researching" or "Thinking") appears until
    the first `write`.
- **Reasoning is deliberately *not* interleaved with tool calls**, because summary parts carry no
  timestamps (`:535-540`).
- Events that never become steps:
  - `context`, `model`, the effort `reasoning` event, `"Preparing web search"`, `"Connected tools
    ready"`, `usage` and `artifact`. These become Details facts or are dropped.
  - Approval requests (`"Linear needs approval"`, kind `tool`, which does not start with "Using").
    These are dropped.

---

## 4. Inventory of every "working" and "thinking" signal in a chat turn

| Signal | Component / class | Where | Loop | Period / timing | Paint cost |
|---|---|---|---|---|---|
| 3×3 dot matrix | `ThinkingDots` (`signature/thinking-dots.tsx`), keyframe `thinking-matrix` (`tailwind.config.ts:539-557`, `845`) | `StreamStatus`, live strip, dock header (split only), memory summary, **artifact card (coral)**, learning-block placeholder | yes | 1.8s `--ease-breathe`, 9 dots staggered 0.2s, starts mid-cycle | Animates `opacity` **and `box-shadow`** on 9 elements (paint every frame) |
| Reduced-motion matrix | `thinking-pulse` | Centre dot only | yes | 1.8s opacity 0.3↔1 | Opacity only |
| Text shine | `ThinkingState` / `.aicss-shine` (`globals.css:1914-1944`) | Generation placeholder label, legacy search label, dev gallery, research timeline | yes | 2.25s `--ease-breathe`, `background-position` sweep on `background-clip:text` | Paint (not composited) |
| Reasoning viewport | `ThinkingReasoning` headless (`aicss/thinking-reasoning.tsx`), `.aicss-tr-*` (`globals.css:1956-2043`) | Under the live strip | no | New line: fade 360ms. Stream: `translateY` **560ms** literal, `ease-out-soft`. Viewport **`height` transition** 360ms. 16px masks | `height` animates layout |
| Search block + globe | `WebSearchBlock` (`aicss/web-search.tsx`) | Live strip, **only** when a `"Searching the web"` query exists (legacy in-chat deep research); research timeline | yes (SMIL) | Globe 7.2s. Rows enter over .34s. Glyph crossfades .22–.36s (all literals) | In chat every row is created as `done`, so the dashed → globe → check sequence never plays and every source shows a **green check** |
| Status line | `StreamStatus` (`message-item.tsx:118-203`) | Assistant row before the first activity event | no | Keyed fade on copy change; 1Hz clock | — |
| Answer tail | `.stream-tail` mask (`globals.css:3100-3106`) | Answer prose once it passes 140 characters (`message-item.tsx:1358`) | no | Static gradient: last 1.35em fades to 30% | Mask on a growing block |
| Shell sweep | `.stream-progress::before` (`globals.css:3567-3588`) | Top of `<main>`, when busy and the composer is off-screen | yes | 1.4s `--ease-in-out`, a 40% band translated | **Always mounted** (`app-shell.tsx:625`), so it animates forever at `opacity:0` |
| Send button | `ComposerPrimaryAction` faces (`composer-shell.tsx:731-760`) | Composer | spinner | `busy` (Loader2 spin) while checking; `stop` square while streaming; faces cross-morph over 120ms | — |
| Artifact card | `ThinkingDots text-primary` + pulsing status dot (`artifact-inline-card.tsx:290`, `431`) | Streaming artifact | yes | Matrix 1.8s + Tailwind `animate-pulse` 2s | **Coral** matrix: the accent used as decoration |
| Spinners | `Loader2 animate-spin` | Python block, citation audit, inline visual | yes | 1s | — |
| Live pill | `animate-pop-in` | Dock | once | 220ms spring | — |
| Running step marker | `ring-2 ring-primary/35 text-primary` | Dock spine | no | Static coral ring | — |

**Design rule broken:** ICONS_AND_MOTION §2.2 rule 9 says loops are for live state only, and the
strip's own comment says "ONE BREATHING ELEMENT ON SCREEN AT A TIME" (`activity-timeline.tsx:316-321`).
That holds between the strip and the dock header. It does not hold for the turn as a whole. A
streaming answer with an artifact shows the muted matrix in the strip, the coral matrix and the
pulsing dot in the card, and the tail mask: three live signals plus a mask, with two different
matrix inks.

---

## 5. Frame by frame: send, then done

The timings are the code's. "Same instant" means the producer sent those events with no await
between them, so they share one `Date.now()` (`thought-process-model.tsx:33-38`).

| # | Moment | What the user sees | Timing / easing | Source |
|---|---|---|---|---|
| 0 | **Send pressed**, prompt not locally skippable | **Nothing appears in the transcript.** The send disc morphs to a spinner (`busy`) and the textarea disables. `/api/chat/clarify` runs | Face morph 120ms `ease-out-strong`. The wait lasts up to **3.5s**, or **8s** for research | `use-chat.ts:1423-1433`, `composer.tsx:1304-1306` |
| 1 | Clarify returns "no questions" | The user bubble (pending) and an empty assistant row are appended. Both **rise in** 6px. First message of a chat: the greeting plays `title-out`, then the composer travels from centre to dock | Rise-in 220ms `ease-out-soft`. Handoff: title-out 160ms `ease-in`, then composer travel 360ms `ease-out-expo` and list fade-in | `use-chat.ts:1240-1263`, `chat-view.tsx:1303-1395` |
| 2 | Status `submitting` | **`StreamStatus`**: matrix plus "Sending" (no clock while submitting), in a 40px row, fading in. The disc becomes ■ stop | Matrix 1.8s loop | `message-item.tsx:175-201`, `1277-1288` |
| 3 | **First activity events** (context, memory, model, connectors, effort, "Preparing web search", all at the same instant) | `StreamStatus` **unmounts** and **`ActivityTimeline` mounts**: a **new** matrix (its phase restarts) and "Thinking · 0s" in a **36px** row (4px shorter). No change of words | Keyed fade. 1Hz clock calibrated to server skew | `activity-timeline.tsx:197-201`, `284-356`, `model.tsx:775-804` |
| 4a | **Reasoning deltas, OpenAI** (parts) | Under the strip, a headless viewport of **part titles**, one per line, 13px grey. Each new line fades in. The viewport grows 40→84→128→172px, then caps at 180px and translates the stream up behind 16px top and bottom masks | Line fade 360ms. Height 360ms. Translate 560ms `ease-out-soft` | `reasoning-lines.ts:65-73`, `thinking-reasoning.tsx:70-175` |
| 4b | **Reasoning deltas, Anthropic / Gemini / Zhipu / Mistral** (flat) | The same viewport, filled with the **prose** cut at blank lines, then into chunks of up to 170 characters at sentence ends, each **clamped to 2 lines**. On a narrow column a chunk needs 3–4 lines, so the text being written is hidden behind the clamp | Same | `reasoning-lines.ts:31-81`, `globals.css:2024-2042` |
| 4c | Long silent thinking | Strip copy becomes "Still thinking. This can take a few minutes." at 2 min of THINK, and "Still working. You can leave; the answer will be here." at 10 min | Keyed fade | `activity-timeline.tsx:82-94` |
| 5 | **Tool call** (`Using X`) | Strip: "Using Linear · create_issue · 9s". The dock (if open) adds a tool row that is **not** marked running | Keyed fade | `activity-timeline.tsx:73-76`, `model.tsx:680-693` |
| 5b | **Approval needed** | An `ApprovalCard` appears between the strip and the answer. The strip **keeps saying "Thinking · Ns"**, and the clock keeps running | — | `route.ts:2896-2907`, `activity-timeline.tsx:73`, `message-item.tsx:1268-1274` |
| 6 | **Web search (normal chat)** | **Nothing changes.** Still "Thinking". `visit` events accumulate unseen. The "Preparing web search" preflight is never shown | — | `route.ts:1119-1123`, `3031-3037`; `liveCopy` only reads visits when `activeLabel === "Research"`, which needs a `"Searching the web"` event |
| 6b | Search, legacy in-chat deep research path | A `WebSearchBlock` appears: magnifier, "Searching “query”" with shine, and a railed list where every row enters with a green ✓. Strip: "Searching for “…” · 4 sources · 31s", then "Reading nature.com" | Row enter .34s. Shine 2.25s | `activity-timeline.tsx:63-71`, `397-413` |
| 7 | **First answer token** (`write` event plus `delta`) | Strip: "Writing · 14s" (keyed fade). **The reasoning viewport stays above the answer** for the whole answer stream. The answer streams into Markdown, and after 140 characters the last line is dimmed by the tail mask. If the composer is off-screen, the 2px coral sweep runs in the shell | Sweep 1.4s | `message-item.tsx:1358`, `chat-view.tsx:1427-1432` |
| 8 | **`done`** | Everything below changes in the same commit. See the list after the table | — | — |
| 9 | Seconds later | Citation audit loading→ready with a spinner. The AI title cross-fades in the header band. A "Memory updated" pill (rise-in plus one pulse ring) may appear | — | `message-item.tsx:1426-1428`, `chat-view.tsx:2124-2153` |

At step 8 (`done`), these land in the same commit (`use-chat.ts:658-676`, `activity-timeline.tsx:269-272`):

- The message is replaced by the server row, and its **id changes**.
- The strip swaps in one frame to the resting row. Type drops from 16px to 13px, height from 36px
  to 32px, and the matrix becomes a grey dot. **The duration moves** from inline after the sentence
  (sans, 16px) to a right-aligned mono caption at 11px. There is no transition.
- The **reasoning viewport and the search block unmount with no exit**. Up to about 190px above the
  answer collapses and the answer jumps up.
- The toolbar (Copy, 👍, 👎, Regenerate, More) mounts. It has an opacity transition but no mount
  entrance, so it appears at once. The sources pill appears, and follow-up chips fade in.
- "Response complete, N words." is announced.
- **If the dock was open, it disappears** (bug B1) and focus jumps to the strip.

**The "Thought for Xs" wording** exists only inside the recap sentence ("Thought for 3.1s, …") and
the unused `ThinkingReasoning` header. The strip intentionally prints "Thought process … 12.4s"
instead (`activity-timeline.tsx:112-120`). THINK is time to first token, so a model that does no
reasoning still gets "Thought for 1.8s" in the recap while its strip says "Run".

**If the dock is opened on a settled run:**

- The dock slides in: 220ms, `ease-drawer`, 16px.
- **First open only:** the panel chunk is loaded with `next/dynamic` with no `loading` fallback
  (`activity-timeline.tsx:30-33`). The column slides in **empty** and the content pops in when the
  chunk arrives.
- The recap fades in. Rows fade up in a stagger (220ms each, 30ms apart, capped at 10), and every
  section's stagger starts from 0 at the same time.
- The chat column snaps narrower in one frame, and the transcript re-wraps with no scroll anchor
  (`overflow-anchor:none` and bottom-follow only, `message-list.tsx:195-229`). A reader mid-scroll
  loses their place.

**If the dock is closed:**

- The portal unmounts at once, so the panel content disappears in that frame.
- The **empty** `bg-card` column plays the 160ms fade and slide out
  (`activity-timeline.tsx:418`, `chat-view.tsx:2450-2452`).
- The chat snaps wider in one frame.

---

## 6. Critique

### 6.1 Information and state accuracy

1. **Reading the thinking takes two disclosures.** The strip opens the dock, and then every row is
   collapsed (`thought-process-panel.tsx:332`). For Anthropic, Gemini and other flat-trace providers
   the entire reasoning is one row, "Full reasoning trace", with the detail "This model streams one
   unbroken trace.", which has to be clicked again. Claude and ChatGPT show the text as soon as the
   thinking block is opened.
2. **The dock leads with metadata, not with the thinking.** In order: status word, recap sentence,
   Elapsed/**Cost**/Sources figures, notice, and only then the steps. Cost as a headline figure
   contradicts the product's own decision to take per-turn cost out of the reading column
   (`message-item.tsx:1430-1435`).
3. **The Research / Think / Write sections and "N steps" counts are a machine ledger.** "Write · 1
   step · Wrote the answer · 612 tokens" fills a section with one row that says nothing new.
4. **Thinking and tool calls are not interleaved.** This is a deliberate honesty rule (reasoning
   parts carry no timestamps, `model.tsx:535-540`), but it removes the most useful view: *thought →
   searched → read → thought → called tool → answered*. The provider does order these (Anthropic
   interleaved thinking; the order of Responses API output items). The fix belongs upstream: the
   server should emit **sequence-ordered timeline items**, so interleaving is a recorded fact and not
   an inference.
5. **Live state is missing or wrong:**
   - Normal web search is invisible while it runs. The strip says "Thinking"; sources appear only in
     the dock or as the resting noun (§5 row 6).
   - A tool call in flight is never marked running. Only the synthetic phase row can be
     `running: true` (`model.tsx:689-691`, `744`), even though `ClientToolDetail.resultNote ===
     "pending"` says exactly this (`types/chat.ts:187-188`).
   - A turn blocked on approval says "Thinking", then "Still thinking…". The approval activity is
     dropped from the spine because its title does not start with "Using " (`model.tsx:405-407`).
   - Artifact events (`kind: "artifact"`, `artifactVerification`) never become steps.
   - `StreamStatus` covers only the "Sending" window. Its 2-minute and 10-minute copy rungs are
     effectively dead in chat, because an activity event always arrives first. The same copy is
     duplicated in `liveCopy` (`activity-timeline.tsx:82-94`).
6. **Deep research is a second, unrelated "run" UI.** It is inline, with a console, recap and
   report dialog. The thought dock has its own "Research" phase that only the legacy in-chat
   deep-research path fills. Two vocabularies for one concept (see the research audit).
7. **The dock's control surface is too heavy for a reading panel.** It has find, five kind filters
   with counts, a Summary/Full radio, Expand all, Collapse all, four copy variants, per-row copy,
   ask-to-run-again, cite chips and open ↗. Most people open it to read the thinking or check the
   sources. "Summary" versus "Full trace" is also misleading: for OpenAI both are the provider's
   *summary*, and "Full" only concatenates the parts.
8. **The resting noun set is inconsistent.** "Thought process" appears only when there is reasoning,
   "Run" otherwise, and the recap says "Thought for …" either way (§5).
9. **The dock hides the chat's header actions** (Outputs, Share, Incognito) while open
   (`chat-view.tsx:1914`), so opening an annotation panel removes unrelated controls.
10. **Width priority is inverted at the split.** At an 800px mount the dock takes 480px and the
    transcript is left with the 320px phone floor. The dock's content (one-line rows) needs less
    width than the reading column.

### 6.2 Visual quality

- **The right-hand columns disagree with each other:**
  - Fill: `bg-card` for the dock, `bg-background` for the canvas and the document viewer.
  - Header height: 48px for the dock, about 52px for the canvas and the viewer (`py-2` plus
    controls), 56px for the chat header band. The top edges of the columns do not align.
  - Header gutter: 12px for the dock and the viewer, 16px for the canvas. PREMIUM_AUDIT rule 8 asks
    for 16px on every panel edge.
- **Too many type voices in the dock:** `text-ui`, `text-body` (recap, prose), mono `text-label`
  (sections, figure captions), `text-caption` (details, figures), and mono `text-ui` figures.
  PREMIUM_AUDIT rule 5 allows two in chrome.
- **Sources look different in the strip and in the dock.** The strip (legacy path) marks every
  source with a green success ✓. The dock marks sources monochrome, because "the accent is state
  only" (`thought-process-panel.tsx:206-208`).
- **The strip changes size and shape when it settles.** 16px sentence case with an inline clock
  becomes 13px with a right-aligned 11px mono figure. The docstring claims the opposite
  (`activity-timeline.tsx:107-111`: "The duration occupies the SAME node, slot and typeface in both
  states"), which is no longer true.
- **The live reasoning viewport** is 13px grey, clamped to 2 lines, and masked. On OpenAI it shows
  titles only. On flat-trace providers it shows mid-sentence fragments with ellipses. It keeps
  showing above the answer through the whole answer stream, which pushes the answer about 190px
  down while it is being read.
- **The notice block** uses a 2px warning left stripe, the side-stripe pattern the flat language
  otherwise avoids.
- **The coral ThinkingDots on artifact cards** is the accent used as decoration (FLAT_UI §2.4).
- **Hover plates on spine rows** use `px-0`, so the fill starts flush at the marker's edge with no
  inset.
- The running marker's `ring-2 ring-primary/35` replaces the `ring-4 ring-card` mask, so the spine
  hairline can show through around it (`thought-process-panel.tsx:1259-1266`).

### 6.3 Motion quality

| Issue | Evidence | Why it matters |
|---|---|---|
| Content disappears and an **empty column** plays the exit | Portal renders only while `open` (`activity-timeline.tsx:418`); exit class on the container (`chat-view.tsx:2450-2452`); the code session admits it (`code-session-view.tsx:1210-1216`) | The only exit animation in the product that carries no content. It reads as a flicker |
| **Empty column on the first entrance** | `next/dynamic` without `loading` (`activity-timeline.tsx:30-33`); `thoughtContainer` is set by a ref callback, so the portal needs one more render | A blank card slides in, then the content pops |
| Chat width **snaps** on open and close | In-flow flex sibling with no width transition. Leaving is `absolute` | The whole transcript re-wraps in one frame beside a 220ms slide. No scroll anchoring, so the reader's place drifts |
| **No exit** for the live reasoning and search blocks at done | `hasLiveBlocks` gated on `streaming` (`activity-timeline.tsx:269-272`, `397`) | Up to about 190px layout shift under the reader. The worst single motion defect |
| **Done storm** | Strip swap, block unmount, toolbar mount, sources pill, follow-ups, audit spinner, title cross-fade, memory pill, and the dock vanishing | Six to nine changes in about one second, none of them choreographed |
| **Dock settle flash** (when it survives) | `animate-fade-in-up` is added to every row when `streaming` flips false (`thought-process-panel.tsx:1453-1457`); adding an animation class restarts it with `fill-mode:backwards` from opacity 0 | The whole spine blinks and re-deals at completion. The recap re-keys at the same moment |
| **StreamStatus to strip handoff** | Two components; a new `ThinkingDots` instance; 40px row becomes 36px (`message-item.tsx:175` vs `activity-timeline.tsx:305`) | The matrix phase jumps, the row shrinks 4px, and the text re-fades within the first second |
| `height` animated | `.aicss-tr-viewport { transition: height 360ms }` (`globals.css:2015`) | Breaks ICONS_AND_MOTION §2.2 rule 8 ("width, height never animate"). Layout every frame while it grows |
| Literals off the ladder | `560ms` (`globals.css:2023`), `2.25s` shine, `.34s/.32s/.36s/.22s/.26s/.24s/.28s` in `.aicss-ws-*` | The AIcss port kept its own timings. `--dur-emphasis` is 560ms but is not referenced |
| **Five loop periods** | Matrix 1.8s, shine 2.25s, status-glow 2.8s, sweep 1.4s, pulse-ring 1.6s (plus `animate-pulse` 2s, spin 1s) | Loops beating against each other on one screen |
| Matrix glow | `boxShadow` in the `thinking-matrix` keyframes (`tailwind.config.ts:539-557`) | Paint every frame on 9 nodes, for a glow of 0.05–0.12 alpha that is barely visible |
| `translateY` of the stream | 560ms `ease-out-soft` on every new line | For OpenAI part titles a new line can arrive every few hundred milliseconds, so the stream is almost always mid-glide |
| Clock number jumps at settle | Live `formatSpan(…, {live})` floors to whole seconds on a client clock corrected for server skew; settled uses server timestamps to one decimal | "12s" becomes "11.6s" and moves across the row at the same moment |

### 6.4 Reduced motion

- **Handled well:**
  - `ThinkingDots` falls back to an opacity pulse on the centre dot.
  - `.aicss-*` loops, transitions and the shine stop (`globals.css:2755-2779`, `3746-3757`).
  - `.stream-tail` is removed.
  - The shell sweep becomes a static hairline.
  - The dock and canvas **entrances** fade only.
  - The SMIL globe renders a static glyph.
- **Not handled:**
  - **All three right-column exits** use a bare `slide-out-to-right-4` without `motion-safe:`
    (`chat-view.tsx:2452`, `2506`, `2553`). They slide 16px under the preference. Code's `DOCK_EXIT`
    guards it (`code-session-view.tsx:136-137`), so the two surfaces diverge.
  - The panel's scroll-to-bottom and citation jump read `prefers-reduced-motion` once on mount into
    a ref (`thought-process-panel.tsx:548-551`) and do not follow changes. Minor.

### 6.5 Performance (re-renders per token, heavy animations)

1. **Per answer token:** `MessageItem` (memoised, but its `content` changed) re-renders
   `ActivityTimeline`. That calls `toReasoningLines(reasoning, parts)` **unmemoised**
   (`activity-timeline.tsx:269`), which re-splits the *entire* trace with a lookbehind regex on every
   token of the answer. `ThinkingReasoning` then re-renders all lines as `<p>`s. None are windowed:
   a 5,000-word trace is about 150 absolutely stacked 40px nodes, of which 4 are visible.
2. **Per reasoning delta:** `use-chat.ts:617-638` copies `reasoningParts` into a fresh array every
   delta, so `buildRun`'s memo misses every time and rebuilds phases, facts, sources and steps.
3. **With the dock open:**
   - `ThoughtProcessPanel` is not memoised and receives a fresh `live` object every render.
   - So on every token, every reasoning delta and every 1Hz tick, it rebuilds `allSteps`, `counts`,
     `visible` and `sections`, and re-renders every `StepRow`.
   - Each `StepRow` renders a Radix `Tooltip`, `Pressable` and `IconSwap`.
   - With 60 rows during a long answer, that is thousands of component renders per second of
     streaming.
4. `useRunClock` re-renders the strip at 1Hz for each streaming message (fine), and the dock
   follows it (see 3).
5. **Always-on animation:** `.stream-progress::before` animates `transform` forever at `opacity:0`
   on every page, because `StreamProgress` is always mounted (`app-shell.tsx:625`). The cost is
   small per frame but the compositor is never idle, which costs battery on laptops.
6. **Paint-bound loops:** matrix `box-shadow`, shine `background-position`, the `height` transition.
7. **Transcript re-wrap** at a 480px width change on dock open or close: a full layout of the
   transcript, including KaTeX and code blocks, in one frame.

### 6.6 Accessibility

- **Silent between "Sending" and "Response complete"** for screen-reader users with the dock
  closed. `StreamStatus` (the only `role=status`) unmounts at the first event. The strip's
  `aria-label` stays "Open thought process, in progress" for the whole run, by design, to avoid
  per-second noise. Phase changes (searching, using a tool, **waiting for your approval**, writing)
  are never announced unless the dock is open, and approvals are not announced even then.
- **The resting strip's accessible name omits the nouns and the warning.** It reads "Open thought
  process, complete, 12s". The visible "3 sources · 1 tool call · Usage limit reached" is hidden
  from assistive tech (`activity-timeline.tsx:258-265`, `367-371`).
- **The dock's focus handling is good:** focus moves to the `<aside>` on open and returns to the
  trigger on close with `preventScroll`. But when the dock self-closes at done (B1), focus is moved
  to the strip without any user action.
- **Splitter.** A `<button>` carries `role="separator"` with `aria-value*`, plus a native `title`
  tooltip instead of the product's Tooltip. The handle is `display:none` below the split, which is
  correct.
- **Hidden actions.** Row actions stay invisible until hover, focus-within or coarse pointer. That
  is reachable, but the only visible cue for "you can copy this call" is hover.
- **No landmark for the dock column.** The `aside` is portalled in, so during the 180ms exit the
  container is empty and not `inert` (code's version is `inert`).
- **Target sizes:** strip at least 32px (44px coarse), panel icon buttons `md`, find close `sm`
  28px. All within the product's rules.

### 6.7 Consistency with Juno's design language

| Rule (doc) | Status |
|---|---|
| ICONS_AND_MOTION §2.2.4: a docked panel enters on `ease-drawer` | Entrance ✓. Exit ✓ curve, but slides under reduced motion, and exits empty |
| §2.2.5: lists are dealt, capped at about 8 rows | Cap is 10 (`motion.ts:249`). Every section restarts at index 0. Re-dealt at settle |
| §2.2.6: disclosure through `grid-rows` | ✓ rows and Details. ✗ the reasoning viewport animates `height`. ✗ the live blocks have no collapse at all |
| §2.2.8: only transform and opacity travel | ✗ `height` (viewport), `box-shadow` (matrix) |
| §2.2.9: loops only for live state | ✓ in principle. ✗ `stream-progress` loops while hidden |
| ICONS_AND_MOTION §3: stacking only from named rungs | ✗ `z-40` on all three right columns (`chat-view.tsx:2426`, `2502`, `2549`). Code removed it for this reason (`code-session-view.tsx:1222-1227`) |
| FLAT_UI §2.4: one accent, for state | ✗ coral matrix on the artifact card, green checks on every source (legacy path), coral ring on the running row (arguably state) |
| PREMIUM_AUDIT rule 5: two type voices in chrome | ✗ about five in the dock |
| Rule 8: 16px gutters, panes agree on edges | ✗ 12px dock gutter. Header heights 48, 52 and 56px across adjacent columns |
| Rule 10: nothing in chrome moves except a fill | The dock header runs the matrix. Acceptable as live state, but it duplicates the strip's |
| Rule 11: size by the container | ✓ the split is container-keyed. A good foundation to keep |

### 6.8 Code health

- `thought-process-panel.tsx` is 1,647 lines and `chat-view.tsx` is 2,589. A large share of each is
  prose comments narrating previous iterations ("This used to…", "What this replaced…"). That makes
  the current design hard to see and invites preserving arbitrary decisions.
- **Stale documentation:**
  - `docs/JUNO.md:490-493` ("PROFILE (real durations) vs FACTS") describes a panel that no longer
    exists.
  - `activity-timeline.tsx:107-111` makes the same-node/same-slot claim, which is false.
  - `chat-view.tsx:2417-2420` says "`duration-slow` … a 400ms slide", but the class is
    `duration-base` (220ms).
  - The `tailwind.config.ts` header still lists `animate-shimmer-text (thinking status)`.
- **Two dock implementations** (chat-view and code-session-view) have already diverged: `inert`,
  the reduced-motion exit, `z-40`, and the resize handle (code's dock has none).
- **Two status components** (`StreamStatus`, `liveCopy`) keep duplicated copy ladders.
- **The dock is keyed on `message.id`,** which is not stable across `done` (B1). `renderKey` exists
  precisely for this (`use-chat.ts:1251-1263`, `message-list.tsx:345`) and is ignored.
- **No `/dev` gallery and no render tests** for the strip or the dock. The memory notes say to
  verify in `/dev/*` galleries. Tests exist only for `run-receipt`, `reasoning-lines`,
  `split-layout` and `use-split-pane`.
- `localStorage` keys use two conventions: `juno.reasoning-view` and `juno:thought-width`.

---

## 7. Bugs (with evidence)

- **B1 (high). An open dock closes itself when the answer completes.**
  - The assistant placeholder id is `temp-<ts>-<n>` (`use-chat.ts:123`, `1251`).
  - At `done` it is replaced with `settleClientMessage(chunk.message)`, which carries the server id
    (`use-chat.ts:668-676`).
  - `ActivityTimeline`'s `messageId` prop changes, so `open` becomes false, and chat-view's
    reconciliation (`chat-view.tsx:1096-1104`) sets `thoughtOpenId` to null with no exit.
  - `ActivityTimeline` then focuses the strip (`activity-timeline.tsx:165-174`).
  - The code session has the same logic, and its comment states the id swap outright ("the live
    streaming bubble is REPLACED by its persisted row when a run settles",
    `code-session-view.tsx:806-814`). It treats the close as self-healing, not as a defect.
  - Reproduce: open the dock during a streaming answer and wait for completion.
- **B2 (high). Layout jump at done.** The live reasoning viewport (up to 180px + 6px + 12px margin)
  and the search block unmount with no collapse the moment `streaming` is false
  (`activity-timeline.tsx:269-272`, `397-413`). With `overflow-anchor:none`, a reader who is not
  pinned to the bottom sees the answer jump up.
- **B3 (medium). Wrong live copy during approvals.** `requestApproval` emits a `tool` activity
  titled "X needs approval" (`route.ts:2901-2906`). `liveCopy` ignores it and falls through to
  "Thinking", then "Still thinking…" after 2 minutes (`activity-timeline.tsx:73-94`). `buildRun`
  drops it from the spine (`model.tsx:405-407`).
- **B4 (medium). Normal web search is invisible while it runs.** Only the deep-research path emits
  `"Searching the web"`, so `researchActive` is never true in normal chat and the strip says
  "Thinking" while sources are being fetched (`model.tsx:373`, `activity-timeline.tsx:63`).
- **B5 (medium). In-flight tool calls are not marked running** in the dock, although the payload
  carries `resultNote: "pending"` (`model.tsx:689-691`).
- **B6 (medium). The dock exits with no content,** and on first open enters with no content (§6.3).
- **B7 (low). Reduced-motion exits slide 16px** on the thought, canvas and document columns
  (`chat-view.tsx:2452`, `2506`, `2553`).
- **B8 (low). Settle flash in the dock:** rows re-animate when `streaming` flips
  (`thought-process-panel.tsx:1455-1457`). After a normal completion B1 hides it, because the dock
  is already gone. It does show after Stop or an error: those paths keep the temp id
  (`use-chat.ts:689-705`, `1765-1767`), so the dock survives and flashes.
- **B9 (low). Legacy search rows are always `done`,** so the three-state bullet (dashed → globe →
  check) documented in `web-search.tsx:11-18` never plays in chat (`model.tsx:100-107`).
- **B10 (low). Performance:** `toReasoningLines` is unmemoised per token; the dock re-renders in
  full per token and tick; `stream-progress` animates while invisible (§6.5).

---

## 8. What to keep, and what the redesign needs to decide

**Worth keeping (the foundations are sound):**

- A container-keyed split (`@container/split`, `splitEngaged`) and `useSplitPane`'s drag, keyboard
  and persistence contract.
- **One clock per run**, calibrated once to server skew (`useRunClock`). The reasoning for a single
  owner is correct.
- The honesty rules that prevent invented data: no fake per-row timestamps, durations only when
  measured, no inferred reasoning boundaries, stated notes instead of empty payloads, "listed"
  versus "read" sources.
- Tool payload plumbing (`ClientToolDetail`: redacted args and result, truncation notes, status,
  duration) and the memory receipt with **Forget**. Both are good and distinctive.
- The reduced-motion tier model (A: keep state, B: drop travel, C: kill decoration).

**Requirements the new design must meet (derived from the defects above):**

1. **A single, ordered run timeline from the server.** Each item carries a sequence number and a
   lifecycle (`pending → running → done | failed | waiting_for_user`) for:
   - reasoning segments
   - search (with query)
   - source read
   - tool call
   - approval wait
   - artifact write
   - memory read
   - answer

   With these the UI can interleave thinking and tool calls truthfully and show live state for
   every kind (fixes B3, B4, B5 and §6.1 item 4).
2. **Inline-first thinking.** The user's reading path should be a collapsible block in the
   transcript that shows the thinking text and tool rows directly (one click, not two). The right
   panel becomes an optional *detail* surface (sources, tool payloads, run details) and does not
   have to be opened to read the thinking.
3. **Stable identity.** Key the dock and every run by `renderKey` (or a client-stable run id), never
   by `message.id` (B1).
4. **Stable geometry.** Nothing that is shown during streaming may unmount without a collapse. Keep
   reasoning in a block that folds (`grid-rows` or framer `layout`) into the resting summary at done
   (B2). Choreograph the done moment as one or two beats, not nine.
5. **One live indicator per turn and one loop period.** Pick one period and one ink (muted, never
   the accent) for "working". Drop the shell sweep's permanent animation. Replace `box-shadow` and
   `background-position` loops with opacity or transform only.
6. **Phase-aware live copy from the timeline**, with announcements at phase boundaries: "Searching
   the web", "Reading 4 sources", "Running Python", "Waiting for your approval", "Writing". Include
   nouns and warnings in accessible names.
7. **Right column unification.** One right-column shell (header height, fill, gutter, close/back,
   enter and exit with content, reduced-motion safe, no `z-40`) shared by the dock, canvas and file
   viewer, and by the code session. Decide whether the three become tabs of one inspector. They are
   already mutually exclusive, so tabs would make that visible and let the user switch without
   losing state.
8. **Mobile:** a sheet over the chat that keeps the composer reachable, or the inline block alone,
   instead of a full takeover with two stacked headers.
9. **Performance budget:** memoise the reasoning derivation, window or virtualise long traces,
   isolate the 1Hz clock into a leaf component, memoise rows, and do not re-render the panel per
   answer token.
10. **A `/dev/thinking` gallery** with scripted fixtures: OpenAI parts, Anthropic flat trace, tool
    call pending→done→failed, approval wait, web search, deep research, stop, network drop and
    recovery, long trace. Add Playwright snapshot coverage, per the project's visual verification
    practice.

---

## 9. Appendix: motion tokens in play

| Token | Value | Used here by |
|---|---|---|
| `--dur-press` | 70ms | `.pressable` dips (strip, rows) |
| `--dur-fast` | 120ms | Hover fills, keyed copy fades, toolbar fade, composer face morph |
| `--dur-exit` | 160ms | Dock, canvas and viewer exit |
| `--dur-base` | 220ms | Dock entrance, row expand (`grid-rows`), rise-in, fade-in-up, pop-in |
| `--dur-slow` | 360ms | Reasoning line fade, viewport height, handoff travel |
| `--dur-emphasis` | 560ms | *Not referenced.* The reasoning stream uses a literal `560ms` |
| `--ease-out-soft` | cubic-bezier(.33,1,.68,1) | Most fades, viewport translate |
| `--ease-drawer` | cubic-bezier(.32,.72,0,1) | Dock and canvas entrance |
| `--ease-in` | cubic-bezier(.4,0,1,1) | Exits |
| `--ease-in-out` | cubic-bezier(.65,0,.35,1) | Chevrons, shell sweep |
| `--ease-breathe` | cubic-bezier(.45,0,.55,1) | Matrix, shine, pulse loops |
| `--ease-spring` | cubic-bezier(.22,1,.36,1) | Live pill pop-in, IconSwap |

Keyframes involved: `thinking-matrix`, `thinking-pulse` (`tailwind.config.ts:539-572`, `845-848`);
`aicss-shine`, `aicss-fade-in`, `aicss-ws-enter` (`globals.css:1940`, `2043`, `2290`);
`stream-progress` (`globals.css:3578`); `fade-in`, `fade-in-up`, `rise-in`, `pop-in`, `cite-flash`
(tailwind); and tailwindcss-animate's `animate-in`/`animate-out` with `slide-*-right-4`.
