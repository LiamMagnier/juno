# Evidence: chat UX, design and motion (Claude desktop, ChatGPT desktop)

REA plan section 4, rows 5 (chat UX) and 6 (design and motion). Static analysis only, run 2026-10-17. Neither app was launched, no user data was read, and nothing was fetched from claude.ai or chatgpt.com. Token values below are reference only; Alevr keeps its own identity under `docs/design/UI_UX_MOTION_SPEC_2026-10.md`.

## 1. Targets and evidence records

| Target | Artifact | SHA-256 |
|---|---|---|
| Claude desktop 2.42304.0 | `/Applications/Claude.app/Contents/Resources/app.asar` | `bfa22ac393906762fa04b9607ff202907405b089c1ae7db257159202f31bb3d0` |
| ChatGPT desktop 26.1013.31256 | `/Applications/ChatGPT.app/Contents/Resources/app.asar` (582 MB, 21,171 entries) | `bf9c41fa9770fbfacfba93042ff71c24cb65c82935819377275faac08103383f` |

REA records (rea-agents 6.5.0, `analyze_javascript_application`, `detail: "summary"`):

| ID | What it is |
|---|---|
| `ev_bb6525ff9cdee75a9c1332ee08e1b5c8b1e7a377be4fe2dbe4d6808905d56179` | Claude complete application analysis (parent, from an earlier session agent). Its summary view is `ev_3a8006832c83575b99175e2382a89d03525c2e373e50e311620f1d1ec4b6723e`: 454 relevant files, 436 parsed JS, 14 BrowserWindows, 52 contextBridge APIs, coverage partial. |
| `ev_80295ab2b535d3323a821577712161425f3730a56124c0d4401e5c3f12f40e6a` (summary `ev_ecf5eb46d42f8e54f7af59053625ba073a16e46129a840c2870bf31a651fda99`) | Claude, focused on `main_window/index.html`, `quick_window/quick-window.html`, the quick-window renderer bundle, `quickWindow.js` and `mainWindow.js`. It reports 2 inline scripts in `main_window/index.html` (lines 16 and 196) that it did not analyse. |
| `ev_45cf0fb26c981df94948838c3d47771de5342aabe8b33a07a688fb1a6f89c2a4` (summary `ev_d1eb2c3ce0dc243a67c4b9bb631d1099e6927de9192aecfcee6171d66413cdfd`) | Claude Quick Entry renderer (`quick_window/assets/main-B8ZHL16F.js`) and its main-process window module. |
| `ev_75dce560e20d342c783ad0c65605052154b68365007e9cfd1bc146eed7b4a3e4` | Trace on the record above with the string seed `cubic-bezier`: no match. REA's graph does not index CSS text (see §6). |
| `ev_b6f75e29ba60833abd2221e8001df4a3bbd87e4a63d907b691c3cd7c6dd1b9d1` (summary `ev_0e03d2d6a3a812eaf7284ca17c792e23945e160354acbe8bcfca41d091f372e7`) | ChatGPT, focused on `webview/index.html`, the markdown view, markdown, conversation runtime, quick-chat window, keyboard-shortcut settings, conversation UI and `.vite/build/conversation-turn-mutations`. 16,320 relevant files, 16,312 left unselected. |
| `ev_9b998b3070d5b4a1de02556fea6289b1d54cc8d1c612ed34962c36805d59a1bd` | Outgoing trace from `webview/assets/chatgpt-markdown-view-bf6b04069534.js`: 442 nodes, 51 JS modules, 195 assets. Among the reachable modules: `observe-layout-motion`, `lazy-response`, `message-submission`, `editable-writing-block`, `chatgpt-memory-citation-analytics`, `chatgpt-saved-memory-state`, `citation-pill`, `prism-light`, `model-and-reasoning-effort-translations`, `pending-edits-dialog`. |

**Static reads (SR-n).** REA rejects CSS as a `source_paths` entry because CSS is not a "relevant file", and its graph does not keep string literals or CSS values (`ev_75dce560…`). Exact token values were therefore read by a read-only static byte read of single ASAR members. The script parses the ASAR header, then reads one member at its header offset into the session scratchpad. Nothing was executed. Each SR row names the ASAR logical path, and its artifact digest is the one in the table above.

## 2. Architecture observations

| # | Observation | Source | Evidence |
|---|---|---|---|
| O1 | The Claude main window is a thin local shell. The chat UI is remote, per the file's own comment: "everything else gets loaded from claude.ai". | `.vite/renderer/main_window/index.html`, line 1 | SR-1, `ev_80295ab2…` |
| O2 | Before the remote app paints, Claude shows a **boot placeholder**: a cached sidebar "frame" (row rectangles with top/left/width/height/radius, scaled by zoom) repainted from `globalThis.desktopBootPlaceholder`. It collapses below `narrowViewportMaxWidth`, and its 48px drag strip keeps the window draggable. | same file, inline scripts at lines 16 and 196 (REA did not analyse them) | SR-1 |
| O3 | First-frame grounds are pinned: `#fcfcfb` light and `#151515` dark. The comment says a test keeps them equal to `window-shared.css`. | same | SR-1 |
| O4 | Claude ships its whole design system (**CDS**) locally in `MainWindowPage-DTxMhyWF.css` (251 KB), with chat components marked by `data-cds`: `AssistantMessage`, `UserMessage`, `MessageActions`, `ChatComposerDock`, `ChatComposerEditor`, `ChatComposerChin`, `ChatComposerQueuedMessages`, `ChatComposerNotices`, `TurnStatus`, `TurnStatusStep`, `AskUserQuestion`, `ModelSelectorEffort`, `MessageAttachments*`, `Skeleton`, `Pulse`, `FileDiff`. | `.vite/renderer/main_window/assets/MainWindowPage-DTxMhyWF.css` | SR-2 |
| O5 | ChatGPT ships its **entire renderer locally** (`webview/`, 19,486 asset files). Its CSP allows a short list of embeds and a sandbox origin for generated web content. The conversation, markdown, voice, quick chat, projects and memory UI are all local chunks. | `webview/index.html`, `webview/assets/*` | `ev_b6f75e29…`, `ev_9b998b30…` |
| O6 | Neither ASAR ships source maps: 0 `.map` entries in either inventory, although ChatGPT chunks carry `sourceMappingURL` comments. | ASAR header inventories | SR-0 |
| O7 | ChatGPT's bundles carry React Compiler memo-cache output (`(0,x.c)(N)` with `react.memo_cache_sentinel`) throughout the turn and thread chunks. | `chatgpt-markdown-view-*.js`, `local-conversation-thread-*.js` | SR-9 |

## 3. Chat UX observations

### 3.1 Streaming render (ChatGPT)

| # | Observation | Source | Evidence |
|---|---|---|---|
| S1 | **Segment fade-in, not a typewriter.** The `streaming-text` component sets `fadeSegmentDelayMs` (default **24**), `fadeSegmentMaxDelayMs` **800** and `completionFallbackMs` **2500**. Each segment gets a `--fade-delay` CSS variable, and completion fires when the segment with the largest delay ends (`onAnimationEnd`). | `webview/assets/streaming-text-59566c5556be.js` (1,808 B) | SR-3 |
| S2 | The delay timeline is keyed per segment (a `WeakMap` from element to key, `startAtMsByKey`, `settledKeys`, `nextSegmentStartAtMs`, using `performance.now()`), so a re-render does not restart segments that have already settled. Delay = min(index × step, max). | `webview/assets/app-initial-3ccf4886957f.js` | SR-4 |
| S3 | Segments are word-level: token segment entries render as `span.FadeIn`. `Intl.Segmenter` with `granularity: word` appears in the same bundle. | same | SR-4 (inferred link) |
| S4 | Fade CSS: `animation: fade-in var(--duration) var(--fade-easing, cubic-bezier(.37,.55,.86,.88)) both`. Under `AdaptiveStreaming`, `--duration: var(--animation-duration-streaming-text)` = **0.7s**. List markers, rules, table rows and blockquotes fade too. Under `prefers-reduced-motion: reduce` every duration and delay drops to 0s. | CSS module `_MarkdownRoot_1fgd0_2` in `app-*.css` | SR-5 |
| S5 | Content references (citations, entity and image placeholders) carry `isStreaming`. A `hidden` reference renders only while streaming and disappears once the message status is `finished_successfully`. | `chatgpt-markdown-view-bf6b04069534.js` | SR-6 |
| S6 | Mermaid has a streaming state (`[data-mermaid-streaming]`) that keeps a stable wide-block width while the diagram grows. | `app-shared-*.css` | SR-5 |
| S7 | Markdown stack: `micromark` and `mdast` identifiers appear in the shared bundles. No `remark`/`rehype` names were found, and KaTeX is present. | `app-shared-*.js`, `app-initial-*.js` | SR-4 (inferred) |

### 3.2 Scroll anchoring (ChatGPT)

| # | Observation | Source | Evidence |
|---|---|---|---|
| A1 | The thread scroller sets `[overflow-anchor:none]`, so anchoring is done by hand. A controller exposes `scrollToBottom`, `scrollToDistanceFromBottomPx(px, 'instant')`, `holdViewport` and `getResponseSpacer().getHeightPx()`. | `app-initial-*.js`, `local-conversation-thread-5ec41ebdd09b.js` | SR-7 |
| A2 | A **follow-mode state machine** has the modes `user_follow`, `prework_follow`, `prework_watch` and `static`. Its events are `latest_turn_placed`, `latest_turn_phase_changed`, `latest_turn_follow_content_changed`, `latest_turn_removed`, `hold_viewport`, `scroll_distance_changed` and `scroll_to_bottom`. | `local-conversation-thread-*.js` | SR-7 |
| A3 | The near-bottom threshold is **24px** (`distanceFromBottomPx<=24`). Scrolling away from the bottom moves `prework_follow` to `prework_watch`. | same | SR-7 |
| A4 | A **response spacer** sits under the newest turn and has its own height, used to place the latest user turn (`shouldPlaceLatestTurn`) without jumping. Spacer height and scroll padding are folded into the distance-from-bottom calculation. | same | SR-7 |

### 3.3 Branching, edit, regenerate, reasoning (ChatGPT)

| # | Observation | Source | Evidence |
|---|---|---|---|
| B1 | The regenerate menu offers several actions: "Try again" (shown with the model name), "Ask to change response" (a feedback field), "Use {model} mode" (Pro), "Use {model}" (Thinking) and "Think longer". | `chatgpt-conversation-turn-content-ff9e7c891b62.js` | SR-8 |
| B2 | Versions: "Previous response" / "Next response", "See versions", "Loading another version…", "I prefer this version" (pairwise choice), "Retry loading saved responses". | same | SR-8 |
| B3 | Branching: "Branch in new chat", "Branch conversation", "Branch into Work mode". | same | SR-8 |
| B4 | Reasoning: a "Thinking" shimmer label (`thinkingShimmer.default`), a "Thinking effort" control, and **"Answer now"** in two places: steer-turn actions (`thread.steer_turn_actions.answer_now`) and stop-response confirmation (`prompt_textarea.stop_response_confirmation…answer_now`). The second turns Stop into "cut thinking short". | `app-primary-a33cb51a1875.js` | SR-8 |

### 3.4 Quick Entry, shortcuts, voice, memory

| # | Observation | Source | Evidence |
|---|---|---|---|
| Q1 | Claude Quick Entry's default shortcut is **`double-tap-option`**. The alternatives are `off` or `{accelerator}`, and the legacy default is `Alt+Space`. Dictation has its own shortcut (`quickEntryDictationShortcut`, options include `capslock`, default `off`). | `.vite/build/index.chunk-muI2IV6k.js` | SR-10 |
| Q2 | Claude feature flags include `nativeQuickEntry`, `quickEntryDictation`, `customQuickEntryDictationShortcut`, `quickEntryGlobalShortcut` and `artifactsPane`. The window bridge exposes `QuickEntry.setRecentChats` and `onQuickEntrySubmit`. | `index.chunk-muI2IV6k.js`, `.vite/build/mainView.js` | SR-10, `ev_45cf0fb2…` |
| Q3 | Claude's Quick Entry renderer handles Escape on keyup (request dismiss) and ArrowUp/Down for recents, and stops wheel scroll from leaking out of the field. | `quick_window/assets/main-B8ZHL16F.js` | SR-11, `ev_45cf0fb2…` |
| Q4 | ChatGPT quick chat is a **floating surface**: "Minimize chat to corner", "Show compact floating chat", "Resize chat width/height", "Unread response", and recents grouped Today/Yesterday/{days}d. It also has "Add to chat", which promotes the quick chat into the main app. | `quick-chat-window-*.js`, `quick-chat-floating-surface-*.js` | SR-12, `ev_b6f75e29…` |
| Q5 | ChatGPT shortcuts are fully rebindable: a recorder ("Press Esc to cancel a recording"), "Search by keystrokes", global shortcuts that work in any app, ⌘1–9 for chats or tabs, conflict detection, and reset to defaults. | `keyboard-shortcuts-settings-6318f36e1b5f.js` | SR-12, `ev_b6f75e29…` |
| Q6 | The ChatGPT voice orb is drawn with **WebGL2** (with a 2D fallback) on `requestAnimationFrame`, and its states are `idle`, `listening`, `thinking` and `speaking`. Rotation uses a spring (stiffness 70, damping 14, mass 1, restDelta .05). | `horizon-voice-orb-controller-*.js`, `app-initial-*.js` | SR-13 |
| Q7 | ChatGPT memory appears in two forms. One is a file and folder browser ("No memory yet", "This preview is truncated"). The other is inline memory citations with feedback (`chatgpt-memory-citation-analytics`, `chatgpt-memory-source-feedback`, `memory-footnote-icon`). | `memory-8db0a004ee49.js`, trace `ev_9b998b30…` | SR-12 |
| Q8 | Claude's CDS includes `ChatComposerQueuedMessages`, so messages can be queued while a turn is running. Its text size follows `data-text-size=sm/md/lg`. | `MainWindowPage-*.css` | SR-2 |

## 4. Design-system tokens (exact values)

### 4.1 Claude CDS (`MainWindowPage-DTxMhyWF.css`, SR-2)

- **Durations:** `--cds-dur-fast` 60ms, `--cds-dur-snap` .12s, `--cds-dur-base` .2s, `--cds-dur-sheet` .3s, `--cds-dur-slow` .45s.
- **Easings:**
  - `--cds-ease-out`: `cubic-bezier(.165,.84,.44,1)`, with fallback `(0,0,.2,1)`.
  - `--cds-ease-overshoot`: `cubic-bezier(.34,1.3,.64,1)`.
  - `--cds-ease-snap`: `cubic-bezier(.32,.72,0,1)`.
- **Message actions reveal:** in after a .1s delay over `dur-snap` on `ease-snap`; out over `dur-fast` with no delay; origin `top`. Under reduced motion, scale is off.
- **Bubble geometry:**
  - `--cds-message-bubble-radius-meeting` 4px: the corners where consecutive bubbles meet tighten.
  - Stack gap 2–4px.
  - Measure `clamp(85%, 448px, 100%)`.
  - Assistant text stop `clamp(0px, (100% - 384px) * .175, 56px)`.
- **Radius (comfortable density):** `--cds-radius` .5rem, composer `.875rem`, xs/sm/lg .375/.4375/.625rem. All are multiplied by `--cds-rem-scale`. Density and text size are axes (`data-density`, `data-text-size`).
- **Type:**
  - Body .75–.9375rem; prose .8125–1.125rem; title 1.25/1.375rem.
  - Text-entry floor 16px, which avoids iOS zoom.
  - Variable fonts with a weight axis (`--cds-font-axis-wght-*`).
- **Shadows:** `--cds-shadow-popover` `0 8px 24px #0000001f, 0 2px 6px #00000014` light, `#00000052` / `#0003` dark.
- **Keyframes (55):**
  - Pills: `cds-pill-in`/`out`/`pop`/`dip`/`roll-*`.
  - Working dot: `cds-working-dot-halo`/`lands`/`veil`.
  - Shimmer text: `cds-shimmer-text-band`/`shine`, with RTL variants.
  - Skeleton: `cds-skeleton-breathe` (2s ease-in-out, opacity 1→.6), `cds-skeleton-sweep`, `cds-placeholder-reveal` (.15s after a `--placeholder-reveal-delay` of .5s).
  - Reveal: `cds-reveal-in` (opacity plus translateY 4px).
  - Others: `cds-chip-in` (scale .8 plus 2px blur), `cds-attachment-out` (.13s), `cds-resolve-glyph`/`square`.
- **Scroll fades and sticky edges** use `animation-timeline: scroll()` driving registered custom properties (`--cds-scroll-fade-*-raw`, `--cds-sticky-edge-*`).
- **View transitions:** attachments use `view-transition-name: match-element` and `--cds-attachment-vt-name`, with groups at .18s `cubic-bezier(.215,.61,.355,1)`, `root` at 0s, and the active type `cds-attachments`.

### 4.2 ChatGPT (`app-shared-ae384120d279.css`, `app-initial-e7c27dd40beb.css`, `app-primary-71492d0e9e92.css`, SR-5)

- **Durations:** basic .15s, moderate .2s, relaxed .3s; modal enter .6s / exit .3s; streaming text .7s; loading shimmer 2s.
- **Curves:**
  - `--cubic-enter` `(.19,1,.22,1)`; `--ease-enter-snappy` `(.23,1,.32,1)`.
  - `--cubic-exit` `(.8,0,.4,1)`; `--cubic-exit-snappy` `(.65,0,.4,1)`.
  - `--cubic-move` `(.65,0,.35,1)`; `--ease-in-out` `(.4,0,.2,1)`.
  - `--ease-spring-snappy` is a CSS `linear()` spring.
- **JS springs (framer-motion runtime):**
  - Library default: stiffness 100, damping 10, mass 1, duration 800, bounce .3.
  - App configs: 185/18, 360/24, 300/27, 400/40, 500/25 (restSpeed 10), 720/37.7, and 70/14 for the orb.
  - `visualDuration` is used in 5 places.
- **Radius:** `--radius-*-base` scaled by `--corner-radius-scale` (a single global rounding knob). lg .5/.625rem, 2xl 1rem, 3xl 1.25/1.5rem, 4xl 1.5/2rem.
- **Markdown rhythm:** `--markdown-space: calc(var(--markdown-font-size) / 4)`; `--markdown-line-height` up to `calc(font-size * 1.5)`; headings get 4× space after lists.
- **Reduced motion:** the media query (3 rules) plus an app attribute `data-reduced-motion=true|false`, which acts as an in-app override.
- **View transitions:** only for the image preview (`image-preview-backdrop`, `-chrome`, `-editor`, `-toolbar`).
- **Loaders:** `typing-shimmer`, `loading-shimmer`, `loading-shimmer-mask`, `token-pulsing-dot` (scale 1→1.25), and edge fades as `@property` animations (`edge-fade-*`).

## 5. Inferences (not proven by static evidence)

- I1. ChatGPT's 0.7s fade with a 24ms step and an 800ms cap means a burst of up to about 33 words fades in as a wave, and older text is plain. This matches Alevr's intent of no slab and no typewriter, reached by a different method: element spans, not the Highlight API. *Derived from S1–S4.*
- I2. The response spacer plus `latest_turn_placed` points to "send pins the new question near the top, and the answer grows into reserved space", rather than following the bottom. The exact placement offset is unknown. *Derived from A2–A4.*
- I3. Claude's local CDS stylesheet probably matches what claude.ai serves (the component names match web chat surfaces), but the claude.ai JS that drives streaming, branching and artifacts is not in the ASAR. *Derived from O1, O4.*
- I4. "Answer now" on Stop suggests reasoning models get a graceful early finish rather than a hard abort. *Derived from B4.*

## 6. Unknowns and limitations

- **Claude chat behaviour is remote.** Streaming render, markdown parsing, branching and edit, artifacts-panel mechanics, projects and memory UI live on claude.ai and were not fetched, as the brief requires. Only the shell, Quick Entry, settings and shared CDS CSS are local.
- **REA retention was volatile.** The Claude parent `ev_bb6525ff…` and the focused parent `ev_80295ab2…` were no longer retained a few calls later (`evidence_integrity_mismatch: missing`), probably because other agents share the server. The quick-window parent `ev_45cf0fb2…` and the ChatGPT parent `ev_b6f75e29…` were used straight after creation.
- **REA does not cover CSS or literals.** CSS cannot be selected, and string seeds such as `cubic-bezier` do not match graph nodes (`ev_75dce560…`). All token values come from SR static reads of single ASAR members. They are exact but not REA-attested beyond the artifact digest.
- **Integrity contradictions.** Both ASARs declare integrity hashes that contradict the unpacked native binaries, so they were analysed with `record-and-continue`. Those bytes are untrusted. This does not affect the JS and CSS findings.
- **Minified code.** Mapping minified identifiers to behaviour (S3, S7, A4) relies on adjacent literals. Runtime ordering, timing under load and A/B flags are unverified.
- **iOS.** No competitor iOS binaries are on this Mac, so iOS claims come only from Alevr's own code and spec.
- **Not investigated in depth:** ChatGPT canvas/writing-block editing mechanics (`editable-writing-block`, `pending-edits-dialog` are reachable in `ev_9b998b30…`), the projects UI (`projects-index-page-*`), the attachment drop flow, and Claude's `clawdQuestEngine` bundle (1.2 MB).

## 7. Static-read index

| SR | ASAR | Member |
|---|---|---|
| SR-0 | both | ASAR header inventory (read-only header parse) |
| SR-1 | Claude | `.vite/renderer/main_window/index.html` |
| SR-2 | Claude | `.vite/renderer/main_window/assets/MainWindowPage-DTxMhyWF.css`, `.vite/renderer/quick_window/window-shared.css` |
| SR-3 | ChatGPT | `webview/assets/streaming-text-59566c5556be.js` |
| SR-4 | ChatGPT | `webview/assets/app-initial-3ccf4886957f.js`, `webview/assets/app-shared-01b9f268c4a3.js` |
| SR-5 | ChatGPT | `webview/assets/app-shared-ae384120d279.css`, `app-initial-e7c27dd40beb.css`, `app-primary-71492d0e9e92.css` |
| SR-6 | ChatGPT | `webview/assets/chatgpt-markdown-view-bf6b04069534.js` |
| SR-7 | ChatGPT | `webview/assets/local-conversation-thread-5ec41ebdd09b.js`, `app-initial-3ccf4886957f.js` |
| SR-8 | ChatGPT | `webview/assets/chatgpt-conversation-turn-content-ff9e7c891b62.js`, `app-primary-a33cb51a1875.js` |
| SR-9 | ChatGPT | thread and markdown chunks (React Compiler output) |
| SR-10 | Claude | `.vite/build/index.chunk-muI2IV6k.js`, `.vite/build/mainView.js` |
| SR-11 | Claude | `.vite/renderer/quick_window/assets/main-B8ZHL16F.js` |
| SR-12 | ChatGPT | `quick-chat-window-2d5dc7bd9c74.js`, `quick-chat-floating-surface-9878b2ac82a3.js`, `keyboard-shortcuts-settings-6318f36e1b5f.js`, `memory-8db0a004ee49.js` |
| SR-13 | ChatGPT | `horizon-voice-orb-controller-eecd97f3ada7.js`, `app-initial-3ccf4886957f.js` |
