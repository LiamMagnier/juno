# Design: chat UX, design and motion — Alevr on web, macOS and iOS

Evidence: `docs/rea/evidence/chat-ux-design-motion.md`. Its IDs are cited below as E-x, using that file's row numbers (S1, A2, Q1 and so on). The governing spec is `docs/design/UI_UX_MOTION_SPEC_2026-10.md` ("Editorial Calm, Finished"). Every value below is an Alevr token from that spec. Competitor values were read for calibration only and are not adopted.

## 1. Alevr today

| Area | What exists | Paths |
|---|---|---|
| Streaming render (web) | A frame-paced pacer that follows the arrival rate, with `rateTau` 900ms and a buffer behind the network. On top of it, a 5-band CSS Custom Highlight fade (5 × 56ms ≈ 280ms) that wraps no words. Block entrance on `[data-streaming]`. Half-formed markdown constructs are held back. Under reduced motion the pacing stays and the fade goes. | `src/components/chat/stream-text.tsx`, `src/lib/chat/stream-pacer.ts`, `src/components/chat/markdown.tsx`, `src/lib/chat/markdown-plugins.ts` |
| Transcript scroll | A windowed transcript (virtualises after 24 turns) with `[overflow-anchor:none]`, `scrollbar-gutter: stable both-edges`, and ResizeObserver re-anchoring through `transcriptAnchor`/`anchoredTranscriptTop`. Bottom-follow uses a 24px `BOTTOM_SLOP`, and any upward move breaks the follow. "Jump to latest". Older pages prefetch about two screens ahead. | `src/hooks/use-transcript-window.ts`, `src/components/chat/message-list.tsx` |
| Live status | LiveLine plus GalaxyMark: truthful phase words, a minimum phase hold (`TIMING.phaseMinHold` 1000), elapsed time shown after 3s. | `src/components/chat/live-line.tsx`, `src/lib/interaction.ts`, `src/lib/chat/reasoning-headline.ts` |
| Branching | Web branch model and navigator; regenerate and regenerate-at, edit, resend, fork. Native branch navigator and conversation tree. | `src/lib/chat/branch-model.ts`, `src/lib/chat/branches.ts`, `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeBranchNavigator.swift`, `NativeConversationTree.swift` |
| Canvas and artifacts | Canvas panel, live blueprint, sandboxed frames; artifact inline cards; native artifact canvas and runtime web view. | `src/components/canvas/*`, `src/components/chat/artifact-inline-card.tsx`, `JunoChatKit/ArtifactCanvasView.swift`, `NativeArtifactRuntimeWebView.swift` |
| Memory | Answer memory, memory fact rows, "memory updated" notice, memory receipts; Mac memory parts. | `src/components/chat/answer-memory.tsx`, `memory-*.tsx`, `src/lib/chat/memory-receipts.ts`, `native/macOS/JunoDesktop/App/DesktopMemoryParts.swift` |
| Motion tokens (web) | Durations press/fast/exit/base/slow/emphasis = 70/120/160/220/360/560; curves out-soft, out-strong, out-expo, in, in-out, breathe, out-back, spring; `--spring-standard`/`--spring-pop` as linear(); a Tier-B reduced-motion remap. | `src/app/globals.css` (lines ~378–428, ~885) |
| Motion (native) | `JunoMotion` with `.reduced(_:when:tier:)`. | `native/Packages/JunoCode/Sources/JunoCodeUI/Studio/*`, JunoNativeKit |
| Quick Entry (macOS) | NSPanel 640×132 placed 12% above mid-screen. Hard-coded ⌥Space (keyCode 49 plus option). Needs the Accessibility permission. | `native/macOS/JunoDesktop/App/DesktopQuickEntry.swift` |
| Native stream state | `ChatStreamPhase` and tool-phase reducer. | `JunoChatKit/ChatStreamReducer.swift`, `native/macOS/JunoDesktop/App/MessageRow.swift` |

## 2. Gaps (Alevr compared with its own spec and the competitors)

1. **Spec timing families are missing from CSS.** None of `--delay-show`, `--hold-reasoning`, `--stream-band`, `--spring-snap`, `--spring-layout` or `--spring-reward` appears in `globals.css`, and `--spring-pop` (2.8% overshoot) is still defined although spec §4.4 retires it. The TS `TIMING` constants partly cover this, but CSS and Swift cannot share them.
2. **There is no pinned user turn and no response spacer.** Spec D11 defers this to "wave 2 G18". ChatGPT ships it as a follow-mode state machine (E-A2–A4). Today Alevr's bottom-follow pulls a long answer's start off screen while the reader is still reading.
3. **There is no queued-message strip.** Spec §6.3 defines it, but grep finds no `cancelQueued` or "Send now" in `src/components/chat`. Claude has `ChatComposerQueuedMessages` (E-Q8).
4. **There is no TurnStatus as a single element.** LiveLine draws the phase, but C1's persistent, never-unmounted TurnStatus with the summary row "Thought for {n}s ›" is not a named component (grep: no `TurnStatus` in `src`).
5. **"Answer now" is not wired.** The string exists only in `src/app/dev/design/juno/states.tsx` and the i18n catalog. ChatGPT puts it on Stop for reasoning models (E-B4).
6. **Native streaming lacks web parity.** No pacer or fade was found in native Swift (grep for pacer/stream-pacer), so Mac and iOS replies reveal at network cadence.
7. **Quick Entry is fixed to ⌥Space.** Claude defaults to double-tap ⌥, has a separate dictation chord, and supports custom accelerators (E-Q1). ChatGPT's quick chat can float, minimise to a corner and show unread answers (E-Q4). Spec §5.7 already says "⌥Space, rebindable".
8. **There is no in-app shortcut editor.** ChatGPT has a recorder, keystroke search and conflict detection (E-Q5). Alevr's chords are fixed (§5.7).
9. **The regenerate menu has no intent options.** The spec has a Regenerate pill with a chevron (§6.2), but the content of the chevron menu is not defined. ChatGPT offers "Think longer" and model switches (E-B1).
10. **Version choice is not recorded.** ChatGPT has "I prefer this version" (E-B2). Alevr's pager "‹ 2/3 ›" does not capture which version the user preferred.

Where Alevr is already better (keep it):

- The Highlight-API fade never wraps words in spans. ChatGPT renders a span for every word segment (E-S3).
- Phase words are truthful and held. Competitors use a generic "Thinking" shimmer (E-B4), and Alevr's law 4 bans shimmer.
- The receipt line shows the model, effort and tokens.

## 3. Original design

### 3.1 "Reading-first follow": answer anchoring (web, macOS, iOS) — closes gap 2

The Alevr principle: **the reader's eyes win over the stream.** This is not a clone of a follow-bottom mode. The rule is "keep the start of the answer readable, then hand over to follow when the reader catches up."

- **On send:**
  - The new user turn is placed so its top sits `--space-6` below the header.
  - A reserved region below it, the *answer bed*, is sized to the viewport minus the turn. It replaces a blank spacer because it carries TurnStatus.
  - Placement is one instant write; there is no smooth scroll (D11).
- **States:**
  - `placed`: the turn is pinned and the answer grows into the bed.
  - `reading`: the answer outgrows the bed; the viewport holds and a "↓ {n} new lines" chip appears.
  - `following`: the reader has scrolled within the 70px zone (§4.6 C13 note).
  - `free`: any upward scroll, wheel-up or text selection.
  - Transitions are pure functions in `src/lib/chat/follow-machine.ts`, unit-tested, with the same table in Swift.
- **The bed collapses** on settle with `--spring-layout` (0.36/0). It never shrinks while the reader is inside it; it collapses on the next send instead.
- **Native:**
  - macOS uses the same machine over `ScrollPosition` and `onScrollGeometryChange`.
  - iOS uses `.defaultScrollAnchor(.top, for: .alignment)` while `placed`, then `.bottom` for `.sizeChanges` only in `following`. This pattern already exists in `JunoMobileCodeRemote.swift`.
- **Reduced motion:** everything here is already instant; only the chip's 120 fade remains (Tier A).

### 3.2 Native "ink-in" streaming — closes gap 6

- Port `stream-pacer.ts` into a Swift `StreamPacer` (same constants, generated from the token pipeline P1) in JunoChatKit, driven by a `TimelineView(.animation)` clock.
- Render the fade as an `AttributedString` with `foregroundColor` opacity bands over the newest graphemes. Use 5 bands, with the first at 35% ink (spec C2). No per-word views.
- Code, math, tables and citations never fade (same rule as web).
- When the app is backgrounded (scenePhase not active), drain immediately.
- Acceptance: identical shown-length curves on web and Swift for the same arrival trace (golden test).

### 3.3 TurnStatus plus "Finish now" — closes gaps 4 and 5

- **One `TurnStatus` per assistant turn,** never unmounted, with the states in the spec C1 table. It lives in the answer bed (§3.1).
- **For reasoning models,** pressing Stop while thinking opens a two-option inline choice anchored to the stop disc, rather than a modal: **Finish now** (the model writes its answer from the reasoning so far) or **Stop**.
  - The words are Alevr's own: "Finish now", not "Answer now".
  - ⌘. stops and ⌥⌘. finishes now.
  - When the run ends early the summary row reads "Thought for {n}s · finished early".
- Hold reasoning open for `--hold-reasoning` (1000) after it ends, unless the reader toggled it (spec C1).

### 3.4 Queued messages — closes gap 3

- Strip contents, per spec §6.3: Queued · 2-line clamp · Edit · Remove · Send now. It sits in the composer chin and enters on `--spring-standard` over 220. Exit is 160 ease-in.
- **Alevr addition, "steer":** when the running turn is a tool loop (Code or Work), Send now is labelled "Send as steer". The message joins the running turn as guidance rather than waiting. This follows the runner's existing steer semantics, if available; otherwise the label falls back to Send now.
- Native: the same strip in `NativeComposerTray.swift` on Mac and `JunoMobileComposer.swift` on iOS.

### 3.5 Regenerate with intent and version preference — closes gaps 9 and 10

- **Regenerate chevron menu:**
  - Try again (same model)
  - Think harder (raises effort one step and shows the new effort in the receipt)
  - Shorter / Longer
  - Different model ›
  - Ask for a change… (an inline field)
- Each produces a sibling version in the branch model (`branch-model.ts`).
- **Pager "‹ 2/3 ›":** a long-press or right-click on the pager offers "Keep this version". The kept version becomes the branch head for context, and it is recorded as a preference signal that feeds model routing (Auto).
- Rendered in label 12 with no new motion; the version swap is a 120 cross-fade.

### 3.6 Quick Entry 2 (macOS) and Quick Compose (iOS) — closes gaps 7 and 8

- **macOS:**
  - The chord is chosen in Settings › Keyboard. Options: ⌥Space (default, unchanged for existing users), double-tap ⌥, double-tap ⌘, or a custom chord recorded in place.
  - Dictation gets its own chord, default off, with Fn-hold as an option.
  - The panel scales from 0.98 over `--spring-layout`, and its height follows the content on the same spring.
  - Recents: ↑/↓ moves through them, Esc dismisses on keyup, and the wheel is contained.
- **Alevr addition, "Park":** ⌘↓ shrinks an in-flight Quick Entry answer to a 280pt corner capsule. The capsule shows the galaxy and phase word and lights the presence dot when the answer is ready. Clicking it re-expands; ⌘↩ opens it in the main window. This differs from a floating chat because the capsule is status-first, never a second transcript.
- **Shortcut editor:** a searchable list grouped by Chat, Composer and App. It records in place and detects conflicts with OS and app chords, saying "⌃⌘F is reserved by macOS". Reset per row or for all. On the web it is limited to non-browser-reserved chords.
- **iOS:** an App Intent "Ask Alevr" for the Action button, Control Center and Shortcuts. It opens a compact sheet at the medium detent and reuses the Quick Entry model.

### 3.7 Token pipeline completion — closes gap 1

- Generate the §4.2 families (`--delay-*`, `--hold-*`, `--stream-*`, `--spring-snap|standard|layout|emphasized|reward|articulate`) from one source into `globals.css`, `src/lib/interaction.ts` and Swift `JunoMotion`.
- Delete `--spring-pop` and migrate its users to `--spring-reward`.
- Adopt two ideas from the evidence, in Alevr's own values:
  - **Scroll-driven edge fades** (`animation-timeline: scroll()` over a registered `@property`), replacing JS mask toggles such as `SCROLL_FADE_STYLE` in `message-list.tsx`. Gate them with `@supports`, and fall back to the current static mask.
  - **Attachment-chip view transitions** with `view-transition-name: match-element` under a `alevr-attachments` transition type, at `--dur-fast` and out-soft. Tier B turns them into a 160 cross-fade, per spec §4.7.

## 4. Acceptance tests

| # | Test | Platform | Type |
|---|---|---|---|
| T1 | Sending in a 40-turn thread places the new user turn's top within ±2px of header + `--space-6`, in one scroll write (no smooth-scroll frames). | web, mac, iOS | Playwright plus XCUITest |
| T2 | While the answer streams past the bed, `scrollTop` does not change unless the reader is in `following`. The chip appears within one frame of overflow. | web, mac, iOS | e2e |
| T3 | The follow machine's transition table matches a shared JSON fixture on TS and Swift (every state × event). | web, native | unit |
| T4 | For a recorded arrival trace, the Swift `StreamPacer` shown-length matches TS within 1 grapheme at every 16ms tick. | native | golden |
| T5 | Reduced motion (OS or in-app): no highlight bands or attributed fades are applied; pacing still runs. | web, mac, iOS | unit plus snapshot |
| T6 | The TurnStatus DOM node / SwiftUI identity is unchanged from send to settle (existing C1 assertion), including through Finish now. | web, mac, iOS | e2e |
| T7 | Finish now on a reasoning run yields a completed answer, the summary "finished early", and a receipt carrying the effort. Stop yields "You stopped this answer · Continue". | web, mac, iOS | integration with a mocked runner |
| T8 | A second send while streaming shows the Queued strip. A third send says "One message is already waiting". Edit restores the text and cancels the queue. | web, mac, iOS | e2e |
| T9 | Each regenerate intent creates a sibling version. "Keep this version" changes the branch head used in the next request's context. | web, native | integration |
| T10 | Quick Entry chord change persists and works with the app in the background. Double-tap ⌥ fires only for two taps within 300ms with no other key. A conflict with a system chord is refused with its name. | mac | XCUITest plus unit |
| T11 | Park: ⌘↓ during a run shows the capsule, and the presence dot lights within 100ms of settle. Click restores the same conversation. | mac | XCUITest |
| T12 | Token lint: no CSS or framer literal outside §4.1/§4.2 tokens; `--spring-pop` is absent; the TS, CSS and Swift generated tokens are byte-identical in value. | all | CI lint |
| T13 | The scroll-driven edge fade renders under `@supports (animation-timeline: scroll())` and falls back to the static mask otherwise, with no layout shift (CLS 0). | web | visual snapshot |

## 5. Prioritised backlog

| # | Item | Impact (1–5) | Effort | Platforms | Depends on |
|---|---|---|---|---|---|
| 1 | Reading-first follow: follow machine plus answer bed (§3.1) | 5 | L | web, macOS, iOS | G18 slot in spec D11; TurnStatus (#3) |
| 2 | Token families plus `--spring-pop` retirement (§3.7, part one) | 4 | S | web, macOS, iOS | P1 pipeline |
| 3 | TurnStatus as one persistent element (§3.3) | 4 | M | web, macOS, iOS | #2 |
| 4 | Native StreamPacer plus ink-in fade (§3.2) | 4 | M | macOS, iOS | #2 |
| 5 | Queued-message strip plus steer (§3.4) | 4 | M | web, macOS, iOS | runner steer API (check `runner/agent-core`) |
| 6 | Finish now on Stop for reasoning models (§3.3) | 3 | M | web, macOS, iOS | provider support for early finish; #3 |
| 7 | Regenerate intents plus Keep this version (§3.5) | 3 | M | web, macOS, iOS | branch model |
| 8 | Quick Entry 2: chord choice, dictation chord, double-tap detection (§3.6) | 3 | M | macOS | Accessibility onboarding |
| 9 | Shortcut editor with conflict detection (§3.6) | 3 | M | web, macOS | #8 |
| 10 | Park capsule for Quick Entry (§3.6) | 3 | M | macOS | #8 |
| 11 | iOS "Ask Alevr" App Intent and Quick Compose sheet (§3.6) | 3 | S | iOS | App Intents target |
| 12 | Scroll-driven edge fades (§3.7) | 2 | S | web | #2 |
| 13 | Attachment-chip view transitions (§3.7) | 2 | S | web | `src/lib/view-transition.ts` |

## 6. Notes and limits

- Claude's chat behaviour (streaming, branching, artifacts, projects, memory) is served from claude.ai and was not analysed. Its Claude rows rest on the local shell, Quick Entry and CDS CSS only.
- ChatGPT values are minified static reads with stated inferences (evidence §5). Nothing here copies their code, strings or assets. The "Finish now", "Park", "answer bed" and "Keep this version" designs are Alevr-original, and their names differ on purpose.
- Nothing has been built. This note feeds the REA backlog in `.claude/handoff/REA_RESUME_PLAN.md` once the owner says to resume.
