# Micro-interaction catalog for Juno Chat (web, Mac, iPhone)

- **Task:** Refoundation research, Task C: micro-interaction craft from primary sources.
- **Date:** 2026-09-30. Every source was fetched on that day. Source IDs `[Sn]` resolve in §7.
- **Scope:** every small interaction a person meets in a conversation: the composer, the streaming reply, the transcript, message actions, system feedback, approvals, and the web and native specifics behind them.
- **Evidence standard:**
  - Numbers were read from source code or specifications where possible, for example the Sonner constants, the AI Elements source, `use-stick-to-bottom`, the Material token file, the Apple docs JSON and the SwiftUI declarations.
  - A claim that rests only on secondary sources is marked **UNVERIFIED**.
  - A recommendation that is Juno's own proposal, with no external precedent, is marked **(proposal)**.
- **Mobbin:** unavailable. Every Mobbin call returned "Mobbin MCP requires a paid plan" on 2026-09-30, so no reference images were collected for this task.
- **Existing Juno material this builds on:**
  - `docs/design/ICONS_AND_MOTION.md` §2 (the interaction recipe).
  - `src/lib/motion.ts` and `src/lib/design/tokens.generated.ts` (the token ladder).
  - `src/components/chat/message-list.tsx` (the follow rule).
  - `docs/rework/audit/web-shell-chat.md` R7 ("a motion diet").
  - This catalog confirms most of the recipe, corrects a few parts, and adds the chat-specific behaviour the recipe does not cover.

---

## 0. The ten laws (what "premium" means here)

These are distilled from the sources. Every entry in §2 applies them.

1. **Frequency decides motion.** The more often a person does something, the less it should animate.
   - An action done 100+ times a day, such as anything keyboard-initiated, the command palette or thread switching, gets **no animation**.
   - An action done tens of times a day (hover, list navigation) is tonal or reduced.
   - An occasional action (dialogs, sheets, toasts) gets standard motion.
   - A rare or first-run moment may delight.
   - Sources: [S1][S6][S8]. Apple says the same: "generally avoid adding motion to UI interactions that occur frequently" [S21].
2. **Never animate a keyboard-initiated action.** It makes the key feel late [S1][S6].
3. **Respond on the same frame and settle quickly.** Feedback starts at input, and UI transitions stay under about 300 ms [S1][S4][S6]. Apple: "Everything needs to respond instantly" [S27].
4. **Everything is interruptible.**
   - Use CSS transitions or springs, not keyframes, for anything that can retarget [S2][S6].
   - "Let people cancel motion… don't make people wait for an animation to complete" [S21].
   - Springs carry velocity through an interruption [S19][S27][S28].
5. **Motion comes from where the thing lives.**
   - Popovers scale from their trigger.
   - Entering and exiting follow symmetric paths.
   - Nothing starts from `scale(0)`: start from 0.9–0.97 [S4][S6][S8][S27].
6. **Only `transform` and `opacity` travel.** Colour may cross-fade. Layout properties never tween, with the one documented exception in `ICONS_AND_MOTION.md` §2.2(8) [S5][S6][S10].
7. **Show state by the thing itself, not by decoration.** This follows the owner rule: no status pills, badges or decorative dots.
   - The send button becomes Stop, and the text itself arrives.
   - A one-line status is set in type.
   - Loading appears only after a short delay (~150–300 ms) and then stays at least ~300–500 ms, so it never flashes [S10].
8. **Reduced motion means "fewer and gentler", not "none".**
   - Keep fades.
   - Remove travel, scale, depth, blur-in and bounce.
   - Tighten springs.
   - Track gestures directly.
   - Sources: [S6][S24].
9. **Announce outcomes, not tokens.** A screen reader hears one announcement per reply, when it completes, never a stutter of partial text [S18][S39].
10. **Nothing consequential happens on a stray key.**
    - Approval is deterministic: a named verb button, never Enter in the composer.
    - Destructive or irreversible steps need a confirmation or an undo window [S10][S8].

---

## 1. Motion tokens: reconcile, don't reinvent

Juno already has a coherent ladder. It lives in `globals.css`, is projected to Swift, and is mirrored in `src/lib/motion.ts`. Here it is against the four reference systems:

| Rung (Juno) | Juno | Emil Kowalski [S6] | IBM Carbon [S31] | Material 3 [S30] | Apple [S28][S29] |
|---|---|---|---|---|---|
| press | 70 ms, ease-out-soft | 100–160 ms, `scale(0.97)` | fast-01 **70 ms** (buttons and toggles) | short1–2, 50–100 ms | system button styles |
| fast (hover, glyph swap) | 120 ms | tooltips 125–200 ms | fast-02 110 ms | short3 150 ms | — |
| exit | 160 ms, **ease-in** | "never ease-in on UI"; use ease-out | exit curves accelerate | emphasized-accelerate `(0.3,0,0.8,0.15)` | fades |
| base | 220 ms | dropdowns 150–250 ms | moderate-02 240 ms | short4–medium1, 200–250 ms | `.smooth` / `.snappy`, default 0.5 s perceptual |
| slow | 360 ms | modals and drawers 200–500 ms | slow-01 400 ms | medium3–4, 350–400 ms | — |
| emphasis | 560 ms | "rare / marketing" | slow-02 700 ms (dimming) | long3–4, 550–600 ms | — |
| drawer curve | `(0.32,0.72,0,1)` | same, the Vaul/iOS sheet curve at 500 ms [S3] | — | — | the iOS sheet feel |
| springs | standard 0.22 s / bounce 0.05; emphasized 0.36 s / 0.1; layout bounce 0 | duration 0.5 / bounce 0.2 recommended, 0.1–0.3 max | — | spatial ζ 0.9, k 1400 / 700 / 300; effects ζ 1, k 3800 / 1600 / 800 | bounce 0 default, ~0.15 brisk, ~0.3 playful, >0.4 avoid |

**Findings and recommendations**

- **T1. Keep the ladder.** It sits inside the consensus band of all four systems. Carbon's 70 ms button rung matches Juno's press rung exactly.
- **T2. Collapse the curve sprawl.**
  - `src` contains **16 distinct `cubic-bezier()` literals**, against 8 named tokens.
  - They include three "back" overshoot curves: `(0.34,1.56,0.64,1)`, `(0.34,1.4,0.64,1)` and `(0.34,1.3,0.64,1)`.
  - An overshoot on a bezier cannot be interrupted gracefully. Replace every literal with a token.
  - Where an overshoot is truly wanted, use a spring: framer `bounce ≤ 0.1`, SwiftUI `bounce ≤ 0.15`.
  - There are also 6 `transition-all` uses, which [S10] and `ICONS_AND_MOTION.md` both forbid.
- **T3. Exit easing (a conflict, resolved).**
  - Emil rejects `ease-in` because it delays the moment the eye is watching.
  - Carbon, Material and Apple accelerate exits and make them shorter.
  - **Keep Juno's 160 ms ease-in for exits**, but only as an opacity-led fade the person already caused. The eye has moved on, so the delay Emil objects to is not seen.
  - Never use ease-in on an *entrance* or a *response*.
- **T4. Add a frequency tier to every component spec (proposal).**
  - **F0:** 100+ times a day, or keyboard. No motion.
  - **F1:** tens a day. Tonal only, ≤120 ms.
  - **F2:** occasional. Base or slow.
  - **F3:** rare. Up to emphasis.
  - The tier sits beside the duration token, so review can check it.
- **T5. Stagger conflicts with the frequency law.**
  - `ICONS_AND_MOTION.md` §2.2(5) says "lists are dealt", and 214 `staggerDelay` sites follow it.
  - Audit R7 and [S6] ("stagger is decorative — never block interaction") point the other way.
  - **Recommendation:** stagger only on F3 surfaces (first run, an empty-to-populated Library the first time), at 30–50 ms per item, capped at 6 items.
  - Never stagger the sidebar, the transcript, the command palette, menus or skeletons.

---

## 2. The catalog

Each entry follows the same template:

- **Trigger**
- **Feedback**
- **Timing / easing** (with a frequency tier F0–F3)
- **Interruption**
- **Reduced motion**
- **A11y / ARIA**
- **Failure mode**
- **Web / Native** notes
- **Sources**

The Juno token names come from §1.

### A. Composer

#### A1. Focus and autofocus
- **Trigger:**
  - A new chat is opened.
  - A send completes.
  - The person presses `⇧Esc`, or `/` when no field has focus.
  - The person types a printable key while focus is on the transcript **(proposal: type-to-focus)**.
- **Feedback:**
  - The caret appears in the field.
  - The focus ring comes from the global `:focus-visible` rule and is not shown for mouse focus.
- **Timing:** F0, instant.
- **Interruption:** n/a.
- **Reduced motion:** the same.
- **A11y:**
  - Autofocus on desktop when the field is the single primary input.
  - **Do not autofocus on mobile.** Raising the keyboard hides half the screen [S10].
  - Focus stays in the composer after send, so the person never has to click back in.
- **Failure mode:** hydration must not drop focus or the typed value [S10].
- **Native:**
  - iOS: `@FocusState`, set on explicit intent only.
  - Mac: make the composer the window's `initialFirstResponder`.
- **Sources:** [S10]; ChatGPT uses `⇧Esc` to focus the input [S36, UNVERIFIED].

#### A2. Composer growth
- **Trigger:** the text wraps or a newline is inserted.
- **Feedback:**
  - The field grows line by line up to a cap of about 40% of the viewport height, or 8–12 lines. Past the cap it scrolls internally.
  - On send it returns to one line **instantly**.
  - The transcript's bottom edge stays anchored, so the reply area does not jump.
- **Timing:** F0, because typing is the highest-frequency act in the product. **Recommend snapping** growth (see §5 D3). If the existing 220 ms height spring (`useComposerAutosize`) is kept, cap it at `fast` (120 ms) and never animate the shrink on send.
- **Interruption:** a new line arriving mid-spring retargets. It must never queue.
- **Reduced motion:** snap. This is already implemented.
- **A11y:**
  - `<textarea>` with a visible or accessible label.
  - Font size ≥16 px on mobile web, or iOS zooms the page [S10].
- **Failure mode:** very long pastes are handled by A6, not by growing without limit.
- **Web:**
  - `field-sizing: content` plus `max-height` is **Baseline since 2026-06-16** (Chrome 123, Safari 26.2, Firefox 152) [S40].
  - Keep the JS measure as a fallback for Safari ≤26.1 and Firefox ≤151.
- **Native:**
  - SwiftUI: `TextField(…, axis: .vertical).lineLimit(1...10)`.
  - AppKit: an `NSTextView` in a scroll view with an intrinsic-height constraint.
- **Sources:** [S10][S40][S1].

#### A3. Enter, Shift+Enter, ⌘Enter and IME
- **Trigger:** keydown in the composer.
- **Feedback:**
  - Enter sends.
  - Shift+Enter inserts a newline.
  - ⌘/Ctrl+Enter always sends, whatever the setting.
  - **Enter while an IME composition is active never sends.** Check both React state and `e.nativeEvent.isComposing`.
  - If the send control is disabled, Enter does nothing. It does not queue.
- **Timing:** F0.
- **Interruption:** n/a.
- **Reduced motion:** n/a.
- **A11y:** the behaviour is described in the shortcuts sheet (E8), not in placeholder text.
- **Failure mode:** a double Enter within one frame must not double-send. Guard on `status === "submitted"` and use an idempotency key [S10].
- **Settings (proposal, with precedent):** offer "Enter sends / ⌘Enter sends". Linear added exactly this choice for comments on 2026-03-12 [S34].
- **Native:**
  - iPhone: Return inserts a newline and the send button is explicit. Hardware keyboards get ⌘Return.
  - Mac: Return sends, ⌥/⇧Return inserts a newline.
- **Sources:** [S11 prompt-input.tsx: `isComposing`, `requestSubmit()`, checks the disabled submit][S10 "Textarea: ⌘/Ctrl+Enter submits"][S34].

#### A4. Send (optimistic)
- **Trigger:** A3, or a click or tap on send.
- **Feedback, all in the same frame:**
  - The user turn is appended to the transcript.
  - The composer clears and keeps focus.
  - Attachments move with the message.
  - Send morphs into Stop (A5).
- **Timing:**
  - F0 for the message: no travel. At most a 120 ms opacity from 0.6 to 1 on the new bubble.
  - The button face swap uses `IconSwap` at 120 ms on ease-out-soft.
  - The scroll is covered by C2.
- **Interruption:** Stop is live from `status: "submitted"`, before the first token.
- **Reduced motion:** the same, without the scale.
- **A11y:**
  - The button's `aria-label` flips between "Send message" and "Stop response".
  - Focus does not move.
  - Nothing is announced: sending is self-evident.
- **Failure mode:**
  - The request fails before the stream starts.
  - The turn stays in place with inline text "Not sent", plus Retry and Edit.
  - The draft and attachments are never lost.
  - The error text names the problem and the fix [S10].
- **Native haptics:**
  - Default: rely on the system button's feedback.
  - iOS 26 adds `SensoryFeedback.press(.buttonIconOnly)` for touch-down [S29]. If it is used, use it for every icon-only button, not just send.
  - Do not add a thud of your own.
- **Sources:** [S10 "Optimistic updates", "idempotency key"][S15 status values][S22].

#### A5. Send → Stop, and stopping
- **Trigger:**
  - The Stop button.
  - `Esc` while a reply streams and no palette or menu is open. Precedence: close a palette first, then stop.
  - `⌘.` on the Mac, the platform's cancel convention **(proposal)**.
- **Feedback:**
  - Text stops **within one frame**. Discard late chunks on the client even if the server lags.
  - The partial reply stays, closed by a quiet typeset "Stopped" (a word, not a pill), with Regenerate and Continue.
  - The button returns to Send.
- **Timing:** F1, the glyph swap at 120 ms.
- **Interruption:** Stop cannot be undone. Continue re-requests.
- **Reduced motion:** the same.
- **A11y:** a polite announcement, "Response stopped".
- **Failure mode:** if the server keeps billing, that is a backend problem. The UI promise is that nothing more *appears*.
- **Native:**
  - `.sensoryFeedback(.stop, trigger:)`. It is defined as "an activity stopped" [S29].
  - Use `.start` and `.stop` for dictation as well (A12).
- **Sources:** [S11 prompt-input.tsx: submitted→spinner, streaming→square Stop, error→X][S15]. Esc-to-stop in claude.ai [S44, UNVERIFIED].

#### A6. Paste
- **Trigger:** paste into the composer.
- **Feedback:**
  - **Files or images on the clipboard** become attachment chips, and the default paste is prevented [S11].
  - **Long text** past a threshold becomes a "Pasted text" chip. It shows a two-line preview, its line count, and "Insert as text". Precedent: claude.ai at about 20k characters [S38, UNVERIFIED]; ChatGPT converts long pastes too [S38, UNVERIFIED].
  - **Rich HTML** is pasted as plain text or Markdown. Styles are never carried in.
  - A single URL stays text **(proposal: offer "Add as link" in the token popover)**.
- **Timing:** F0. The chip appears instantly.
- **Interruption:** ⌘Z undoes the conversion back to inline text **(proposal)**.
- **Reduced motion:** the same.
- **A11y:** the chip has a name ("Pasted text, 412 lines") and a remove button.
- **Failure mode:** never disable paste [S10], and never lose the pasted content if conversion fails.
- **Native:**
  - A user-initiated paste (⌘V or the edit menu) triggers no iOS permission prompt.
  - Programmatic pasteboard reads do trigger one, so use `PasteButton` for any "Paste" affordance [S29].
- **Sources:** [S10][S11][S38].

#### A7. File drop overlay
- **Trigger:** `dragenter` with `dataTransfer.types` containing `"Files"` anywhere over the chat window.
- **Feedback:**
  - A full-pane overlay: "Drop to add to this chat". Inside a project it adds "…or to the project" **(proposal)**.
  - Dropping anywhere adds the files to the composer.
  - Non-file drags (text, links) never show the overlay.
- **Timing:**
  - F2, a 120 ms opacity fade.
  - Scale 0.98→1 is allowed on the inner frame, never on the whole pane.
  - Out: the exit rung.
- **Interruption:** use a `dragenter`/`dragleave` counter, or check `relatedTarget`, so moving over child elements does not flicker the overlay.
- **Reduced motion:** opacity only.
- **A11y:**
  - The overlay is `aria-hidden`, because the drop target is pointer-only.
  - Every drop has a click path through `+` and a paste path [S10: "every drag… also works with tap/click and keyboard"].
- **Failure mode:**
  - Validate type, count and size **on drop** and say what was rejected inline ("2 files added · video.mov is over 100 MB").
  - AI Elements exposes exactly these error codes: `accept`, `max_files`, `max_file_size` [S11].
- **Native:**
  - SwiftUI: `.dropDestination(for:action:isTargeted:)` drives the overlay [S29].
  - Mac: `NSDraggingDestination`.
- **Sources:** [S10][S11][S29].

#### A8. Attachment chips
- **Trigger:** a file added through A6, A7 or `+`.
- **Feedback:**
  - The chip appears instantly with a local thumbnail.
  - Upload progress fills the chip's own track (determinate). No separate badge.
  - Remove with ×, or with Backspace in an empty field, which removes the last chip [S11].
- **Timing:** F1. Enter: 120 ms opacity with scale 0.96→1. Removal: the exit rung, and the remaining chips close up with a layout spring (`spring.layout`).
- **Interruption:** removing a chip mid-upload cancels the upload.
- **Reduced motion:** opacity only, and the layout snaps.
- **A11y:**
  - Each chip is a group named after its file.
  - Progress uses `role="progressbar"` with `aria-valuenow`.
  - "Remove {name}" is announced on removal.
- **Failure mode:** the chip turns to the error tone, with Retry and Remove. Send is disabled with a reason, "1 file failed to upload". Do not silently drop the file.
- **Sources:** [S11][S10].

#### A9. `@` tokens (Crew, Files, Projects, Apps, Chats)
- **Trigger:** typing `@`.
- **Feedback:**
  - The palette opens **instantly**, anchored to the caret. It is F0 and keyboard-initiated [S1][S6].
  - Typing filters the list. ↑/↓ move the highlight **with no animated highlight**.
  - Enter or Tab inserts the token. Esc closes the palette and leaves the literal `@`.
  - A token is an atomic object drawn with the thing's own mark.
  - The first Backspace next to a token selects it; the second deletes it **(proposal)**, so nobody deletes one by accident.
- **Timing:** F0. When opened with a pointer, a 120 ms origin-aware pop is allowed. When opened from the keyboard, none.
- **Interruption:** typing never waits for the palette.
- **Reduced motion:** the same.
- **A11y:**
  - The WAI-ARIA combobox pattern: `aria-expanded`, `aria-controls`, `aria-activedescendant` on the field, and `role="listbox"`.
  - Tokens are `contenteditable=false` with an accessible name ("Mira, crew member").
  - A token that needs connecting, or that will require approval, says so in its popover before send (product §5).
- **Failure mode:** no match shows "No matches — search all files" rather than an empty box [S10 "No dead ends"].
- **Sources:** [S1][S6][S8 "context menus appear instantly; selected items briefly highlight"][S10].

#### A10. `/` skills and commands
The same behaviour as A9. The only difference is the source list. The palette's first row is the best match, preselected, so `/res` then Enter runs `/research`.

#### A11. The model control
- **Trigger:** a click or tap on the control, or its shortcut.
- **Feedback:**
  - A popover from the trigger (`--radix-popper-transform-origin`).
  - The list: Auto, favourites and the top models, each with one line of description, plus an effort control.
  - Choosing closes the popover immediately.
  - The control's label cross-fades to the new short name.
- **Timing:**
  - Pointer: F2, 150–200 ms, scale 0.96→1 plus opacity on ease-out-soft.
  - Keyboard: instant.
  - The label cross-fade is 120 ms.
  - If the label's width changes, the neighbouring controls move with `spring.layout`, or the width is fixed.
- **Interruption:** a CSS transition retargets if the popover is reopened while closing.
- **Reduced motion:** opacity only.
- **A11y:**
  - `role="menu"` or `listbox` with typeahead.
  - The current model is `aria-checked`.
  - Focus returns to the trigger on close.
- **Native:**
  - iOS: `.sensoryFeedback(.selection, trigger:)` on each change, the documented meaning of "values changing" [S22]. `JunoThinkingControl` already does this.
- **Sources:** [S4][S6][S32][S22].

#### A12. Dictate and voice
- **Trigger:** the mic button, or holding the shortcut.
- **Feedback:**
  - The button's own face shows the state: idle, then listening with a live level, then processing, then text inserted.
  - Esc cancels and discards.
  - Listening, thinking and answering are distinguishable by motion **and** by accessible text (product §9).
- **Timing:**
  - The state change is F2 on the base rung.
  - The level meter is the only permitted loop, and it tracks the live input with no fixed animation.
- **Interruption:** tap to stop at any point. The inserted text is editable before send, and nothing is ever sent automatically.
- **Reduced motion:** the meter becomes a static intensity bar with text ("Listening").
- **A11y:** `aria-pressed` on the toggle, and a polite announcement "Listening" / "Stopped listening".
- **Failure mode:** mic permission denied gives an inline explanation and a link to Settings.
- **Native:** `.sensoryFeedback(.start)` and `.sensoryFeedback(.stop)` [S29][S22 watchOS start/stop semantics]. `JunoMobileVoice*` already uses `connect` and light impacts.
- **Sources:** [S21 "make motion optional"][S22][S29].

### B. The reply

#### B1. Waiting (submitted, before the first token)
- **Trigger:** `status === "submitted"`.
- **Feedback:**
  - **Nothing for the first ~300 ms.**
  - After that, one typeset line in the reply slot: "Thinking". Where it is known, use the real phase ("Searching the web", "Reading Q3 Forecast.xlsx").
  - Once shown, the line stays at least 300–500 ms so it never flashes.
  - **No dots, no orbs, no pills.** The audit's `phase-orb` and the three-dot typing indicator both break the owner rule.
- **Timing:**
  - A shimmer sweep across the text is allowed, about a 1–2 s cycle (AI Elements' `Shimmer` defaults: `duration=2`, and 1 inside Reasoning).
  - This is the one sanctioned loop, because it is live state.
- **Interruption:** the first token replaces the line with no exit animation. Text replaces text.
- **Reduced motion:** static text with no shimmer.
- **A11y:**
  - `aria-busy="true"` on the pending message.
  - One polite status announcement, "Juno is thinking".
- **Failure mode:** see B9.
- **Sources:** [S10 "show-delay ~150–300 ms and minimum visible time ~300–500 ms"][S11 shimmer.tsx, reasoning.tsx][S25 "Show something as soon as possible"].

#### B2. Streaming text reveal
- **Trigger:** tokens arrive.
- **Feedback:**
  - **Words** (not characters) fade in as they mount. Streamdown's default is `fadeIn`, **150 ms, `ease`**, per word.
  - `blurIn` masks bursty batches from fast models better than plain opacity.
  - Never slide body text: a 4 px `slideUp` makes lines jitter while you read.
  - **No caret.** Streamdown's circle caret `●` is a decorative dot, which the owner rule forbids. The arriving words and the Stop button are the liveness signal.
- **Pacing:**
  - Smooth on the server with word chunking (AI SDK `smoothStream`, default `delayInMs: 10`, `chunking: 'word'`, `Intl.Segmenter` for CJK and Thai) [S14].
  - Or smooth on the client with a rAF buffer that **never falls behind arrival**. If the backlog passes about one line, release it faster. Never fake a typewriter slower than the model **(proposal)**.
- **Render cost:**
  - Throttle React commits: AI SDK `experimental_throttle`, off by default [S15]. About one commit per frame, or 30–50 ms for very long replies.
  - Memoize completed blocks.
  - When streaming ends, drop the animation wrappers. Streamdown excludes its animate plugin when `isAnimating=false`, leaving "zero DOM overhead" [S13].
- **Interruption:** the person can scroll, select and copy at any time, and nothing yanks them (C1).
- **Reduced motion:** no fade. Words append as they arrive.
- **A11y:**
  - The transcript is `role="log"` with `aria-relevant="additions"`. `role="log"` implies `aria-live="polite"`.
  - The **streaming message has `aria-busy="true"` until it finishes**.
  - Announce once on completion (B7). Never point a live region at the growing text [S18][S39].
- **Sources:** [S13 Animation][S14][S15][S18][S39].

#### B3. Markdown under streaming
- **Behaviour:**
  - Unterminated syntax renders as if it were closed: `**bold`, `*italic`, `` `code ``, `~~strike`, and links.
  - It is replaced when the real closer arrives (Streamdown's `remend`).
  - A code fence renders as a code block from its first line.
  - Tables render row by row.
  - Nothing flashes as raw asterisks.
- **Layout stability:** reserve image boxes, and keep any block from reflowing text already above it [S10 "Stable skeletons… avoid layout shift"].
- **Sources:** [S13 "Unterminated Block Parsing"][S10].

#### B4. The reasoning disclosure ("Thought for 12 s")
- **Reference behaviour (AI Elements):**
  - It auto-opens while reasoning streams, **unless the person explicitly closed it**.
  - It auto-closes **1000 ms** after streaming ends, once only.
  - The label changes from `Thinking…` (with shimmer) to "Thought for N seconds" [S11 reasoning.tsx].
- **Juno recommendation:** stay **collapsed**, showing one live line with the latest step in type (product §9: "plan behind a disclosure", "telemetry one disclosure down").
  - If the person opens it, never auto-close it. Respect explicit state, as AI Elements does.
  - Opening and closing use the grid-rows 0fr→1fr technique (`Collapse`) on base, 220 ms ease-in-out.
  - The duration shows in tabular numbers.
- **Reduced motion:** the height snaps and the opacity fades.
- **A11y:** a disclosure button with `aria-expanded`.
- **Sources:** [S11][S10 tabular-nums].

#### B5. The tool, task and research progress line
- **Behaviour:**
  - One line: "Reading 14 sources · 3 of 5 questions answered".
  - Text changes cross-fade in 120 ms. Where two strings overlap badly, add 2 px of blur during the cross-fade [S4][S6].
  - Numbers use `tabular-nums` on the web and `.contentTransition(.numericText())` on native [S29].
  - Hold each phase at least about 1 s, so the line is readable rather than flickering **(proposal)**.
  - The plan and trace sit behind a disclosure.
- **A11y:**
  - Announce phase changes politely, at most one per few seconds (debounce) [S39].
  - Announce completion once.
- **Sources:** [S4][S6][S29][S39].

#### B6. Code blocks
- **While streaming:**
  - The language label appears as soon as the fence opens.
  - Syntax highlighting is lazy (Shiki grammars load on demand).
  - **Copy is visible but disabled until the fence closes**, with the tooltip "Available when finished" (Streamdown disables controls while `isAnimating`).
- **Controls:**
  - Copy: the raw code, without line numbers.
  - Download, with an extension that matches the language.
  - Wrap toggle.
  - Controls show on hover or focus on desktop and are **always visible on touch** [S13].
- **Copy feedback:** see D2.
- **Scroll:** long lines scroll horizontally inside the block, with `overscroll-behavior-x: contain`. They never scroll the page.
- **Sources:** [S13 Code Blocks, Interactivity][S11 code-block.tsx].

#### B7. Completion
- **Trigger:** the stream ends.
- **Feedback:**
  - The shimmer and live line disappear.
  - The action row appears on the finished message (D1) with a 120 ms opacity fade.
  - Stop becomes Send.
  - Focus stays in the composer.
  - No sound and no toast.
- **A11y:**
  - `aria-busy` becomes false.
  - A polite announcement, "Juno replied", with optionally the first sentence [S39].
  - Pass completion through `useChat`'s `onFinish` [S15].
- **Native haptics:**
  - **None for an ordinary reply.** HIG: haptics are for discrete events, "avoid overusing", and long-running haptics dilute meaning [S22].
  - `.sensoryFeedback(.success)` only when a *long* task or research run finishes while that chat is on screen. In the background it becomes a notification instead.
  - ChatGPT's iOS app vibrates *while* responding, and users publish guides to turn it off [S37, UNVERIFIED]. Do not copy it.
- **Sources:** [S22][S37][S39].

#### B8. A stopped reply
See A5. The partial text is kept, followed by "Stopped", Regenerate and Continue. Continue appends to the same message, and the version pager (D3) does not advance.

#### B9. Errors, retries and reconnection
- **Pre-stream failure:** see A4.
- **Mid-stream failure:**
  - The partial text stays.
  - An inline line in plain words names the cause and the fix ("Connection lost. Retry").
  - Retry resends idempotently.
- **Rate limit:** show when the person can try again, from `retry-after`, in tabular numbers. Show the time, not a spinner.
- **Network drop:** try to **resume** the stream (AI SDK `resume`, `resumeStream()`) with a quiet "Reconnecting…" line. It becomes the Retry line after about 10 s **(proposal)**.
- **Offline:** composing still works. Send is disabled with the reason "You're offline".
- **Timing:** F2, base.
- **A11y:** errors are announced politely. The Retry button is reachable by Tab from the composer with a single Shift+Tab **(proposal)**.
- **Sources:** [S10 "Error guidance: state problem and solution"][S15 status `error`, `clearError`, `resume`].

### C. The transcript

#### C1. Following the stream, and escaping it
- **Rule (Juno already has it, keep it):** follow new content only if the reader was at the bottom **before** it arrived. Scrolling away holds the view still, and returning to the bottom resumes the follow. See `message-list.tsx`, `ATTACH_SLOP_PX = 24`.
- **Precedent:** `use-stick-to-bottom`, used by AI Elements' `Conversation`:
  - "Near bottom" is ≤ **70 px**.
  - **Any wheel with `deltaY < 0` escapes immediately**, because the browser can cancel wheel scrolling if an animation writes `scrollTop` at the same time.
  - **An active text selection inside the transcript escapes the lock.**
  - Content resizing (not scrolling) is detected with `ResizeObserver`.
  - Its follow is a velocity spring (damping 0.7, stiffness 0.05, mass 1.25 in its own per-frame units) [S12].
- **Gaps to verify in Juno:**
  - (a) **Text selection**: `message-list.tsx` has no `getSelection` check. Dragging a selection inside a streaming reply at the bottom may be dragged away by the follow. **PLAUSIBLE, needs a test.**
  - (b) Keyboard scrolling (PageUp, ↑) must escape exactly as a wheel does.
- **Reduced motion:** the follow is always an instant pin. It already is.
- **Native:** SwiftUI iOS 18 / macOS 15.
  - Use `onScrollGeometryChange` to compute near-bottom.
  - Use `ScrollPosition.scrollTo(edge: .bottom)` only when it was near the bottom.
  - `defaultScrollAnchor(_:for:)` roles control the initial offset and size changes [S29].
  - Do not blanket-anchor `.sizeChanges` to the bottom, or the reader can never escape.
- **Sources:** [S12][S11 conversation.tsx][S29].

#### C2. Anchoring the new turn on send (decision D5)
- **Pattern (ChatGPT; assistant-ui `turnAnchor="top"`; shadcn Message Scroller):**
  - On send, scroll the **user's message to near the top** of the viewport, leaving a small peek of the previous turn (the shadcn example uses 64 px).
  - The reply streams *below* it without auto-follow.
  - When the reply outgrows the viewport, "Jump to latest" appears.
- **Details:**
  - Tall user messages clamp: assistant-ui's `topAnchorMessageClamp` defaults to `{ tallerThan: "10em", visibleHeight: "6em" }`.
  - The last turn needs a min-height spacer (the viewport height minus the peek) so the anchor can reach the top even when the reply is short.
  - With a top anchor, `autoScroll` defaults to false [S16].
- **Timing:** the send scroll is one smooth scroll of about 360 ms (slow) on ease-out-expo, or instant under reduced motion. It is the only automatic smooth scroll in the product.
- **Why:** the question stays readable above the answer, and the view does not chase a growing bottom edge.
- **Sources:** [S16][S18][S45, a secondary write-up].

#### C3. Jump to latest
- **Trigger:** the reader is not at the bottom and there is content below.
- **Feedback:**
  - An icon button above the composer with the accessible name "Jump to latest".
  - **No unread count and no dot** (owner rule).
  - It becomes inert when there is nowhere to go (shadcn: `tabIndex=-1`, `data-active=false`). assistant-ui disables it at the bottom [S16][S18].
- **Timing:**
  - Appear and disappear: F1, 120 ms opacity with scale 0.96→1.
  - The scroll: smooth if the distance is under about 2 viewports. Beyond that, jump instantly to one viewport above the end, then smooth-scroll the rest **(proposal)**, because smooth-scrolling 40 screens feels broken.
- **Interruption:** any wheel or touch during the scroll cancels it (C1).
- **Reduced motion:** an instant jump.
- **A11y:** a real `<button>`. After jumping, focus stays on it until it hides, then moves to the composer.
- **Native:** the same button on glass, `.glassEffect(.regular.interactive())`.
- **Sources:** [S16][S18][S11].

#### C4. Loading older history (prepend)
- **Behaviour:** the visible content must not move when older turns are prepended.
  - shadcn: `preserveScrollOnPrepend` is on by default [S18].
  - Chrome and Firefox do this through `overflow-anchor`. **Safari gains scroll anchoring only in Safari 27** (WWDC26 beta, confirmed in a 2026-09 write-up), so keep the manual `scrollTop += Δheight` fallback [S43].
- **Loading indicator:** a spinner at the top only after the show-delay (B1).

#### C5. Switching threads and restoring position
- **Behaviour:**
  - Switching is instant (F0: ⌘K, sidebar, keyboard).
  - Each thread restores its own scroll position.
  - A thread opened fresh starts at the **top of its last turn** ("last-anchor", the shadcn default), not the bottom, so the last answer reads from its start.
  - Back and Forward restore position too [S10 "Scroll persistence"].
- **Sources:** [S10][S18].

#### C6. Find in conversation (⌘F)
- **Behaviour:**
  - A bar opens instantly. Enter and ⇧Enter step through matches, and matches scroll into view with no smooth scroll.
  - Esc closes the bar and returns focus to where it was.
  - The count ("3 of 12") is in tabular numbers. Juno already has `conversation-find.tsx`.

### D. Message actions

#### D1. Revealing the action row
- **Pattern (assistant-ui `autohide: "not-last"`):**
  - The **last** reply always shows its actions.
  - Earlier replies show them on hover or `:focus-within`.
  - The row is hidden on a message that is still generating (`hideWhenRunning`) [S17].
- **Timing:** F1, 120 ms opacity. **No hover-intent delay**, because the actions are in place. Hover rules sit behind `@media (hover:hover) and (pointer:fine)` so taps don't fire phantom hovers [S6].
- **Touch:** the last reply's row is always visible. Earlier replies get a long-press context menu (D6).
- **A11y:**
  - The row is reachable by Tab even while it is visually hidden: use opacity, never `display:none`.
  - Every icon button has an `aria-label` and a tooltip [S10].
- **Sources:** [S17][S6][S10].

#### D2. Copy (a message, a code block, a table)
- **Trigger:**
  - The copy button.
  - ⌘⇧C copies the last reply and ⌘⇧; copies the last code block (ChatGPT's bindings) [S36, UNVERIFIED].
- **Feedback:**
  - The glyph swaps from copy to a check in place (`IconSwap`: overlapping glyphs, opacity plus scale 0.8→1, 120 ms).
  - The check holds, then reverts. Juno uses about 1.5 s; AI Elements and Streamdown use **2000 ms**. Anything from 1.5 to 2 s is fine (§5 D2).
  - The timer is restarted by a second copy and cleared on unmount.
  - The button's width never changes.
  - **No toast.** The feedback sits where the eye already is. Juno's `message-item.tsx` already follows this.
- **What is copied:**
  - A message: Markdown as `text/plain` plus rendered HTML as `text/html` through `ClipboardItem`, so it pastes richly into documents.
  - A code block: raw code only.
  - A table: Markdown, CSV or TSV, plus HTML (Streamdown offers all of these) [S13].
- **Reduced motion:** the glyph cross-fades with no scale.
- **A11y:**
  - A polite live announcement, "Copied".
  - The tooltip changes to "Copied".
  - assistant-ui exposes `[data-copied]` for styling [S17].
- **Failure mode:** if the Clipboard API is unavailable or denied, show "Couldn't copy" and **select the text** so ⌘C works [S11 code-block.tsx `onError`].
- **Native:**
  - `.contentTransition(.symbolEffect(.replace))` on the SF Symbol.
  - iOS haptic: none, or `.impact(weight: .light, intensity: 0.5)`. Pick one and use it for every copy.
- **Sources:** [S11][S13][S17][ICONS_AND_MOTION §2.2(7)].

#### D3. Regenerate and the version pager
- **Trigger:** the Regenerate button in the row.
- **Feedback:**
  - The reply is replaced in place by a new stream.
  - The earlier version is kept.
  - A pager "‹ 2 / 2 ›" appears on the message.
- **Timing:** F1. Switching versions with the pager is **instant**; at most a 120 ms cross-fade. Numbers are tabular.
- **Interruption:** Stop applies (A5). Moving back to version 1 while version 2 streams is allowed, and version 2 keeps streaming in the background **(proposal)**.
- **A11y:**
  - The pager is a group labelled "Version 2 of 2", with its buttons as siblings.
  - ←/→ step through versions while the pager has focus.
- **Sources:** assistant-ui BranchPicker and ActionBar `Reload` [S17]. Common ChatGPT and Claude behaviour (observed; UNVERIFIED as a spec).

#### D4. Editing a sent message
- **Trigger:** the pencil in the user message's row, or ↑ in an empty composer to edit your last message **(proposal: the Slack convention)**.
- **Feedback:**
  - The bubble becomes an editor **in place**, at the same width, with the caret at the end.
  - The turns below dim to about 50% while editing, to show what will be replaced **(proposal)**.
  - Esc cancels and restores the text exactly.
  - ⌘↩ (and Enter, per A3) saves, which creates a new branch; the pager shows "2 / 2" and the new reply streams.
- **Timing:** F2. The dim is 220 ms. The editor swap is instant.
- **Interruption:** this is not destructive. The old branch survives behind the pager, which is the undo, so no confirmation is needed [S10 "Confirm or provide Undo"].
- **A11y:**
  - Focus moves into the editor.
  - On save, focus returns to the composer.
  - On cancel, focus returns to the edit button.
- **Sources:** [S10][S17 `Edit`, "disabled when already editing"].

#### D5. Feedback (thumbs)
- **Behaviour:**
  - A toggle with `aria-pressed`. The filled glyph swaps in 120 ms.
  - Thumbs down opens an optional small popover asking why. Skipping it still records the vote.
  - There is no toast.
- assistant-ui marks the state with `[data-submitted]` [S17].

#### D6. Context menus (iOS long-press, Mac right-click)
- **Behaviour:** the native context menu offers Copy, Edit, Regenerate, Share, Select Text and Read aloud.
  - iOS: `.contextMenu` with a message preview.
  - Mac: a standard `NSMenu`.
  - The menu appears instantly [S8 "Context menus appear instantly"].
  - **Select Text** is essential on iOS, because long-press is otherwise taken by the menu.

### E. System feedback

#### E1. Toasts
- **Use them only for:**
  - Events outside the current view: a background task finished, a crew member needs you while you're in another chat.
  - Errors not tied to a visible element.
- **Never use them for:** copy, save, send, or anything the person just watched happen.
- **Defaults, from the Sonner source [S7]:**
  - 4000 ms lifetime.
  - The timer pauses on hover and while the tab is hidden.
  - 3 visible, with a 14 px gap.
  - Swipe dismisses at **45 px or velocity > 0.11 px/ms**.
  - Friction when dragged the wrong way.
  - The region is `aria-live="polite"`, labelled "Notifications alt+T", and reachable with **Alt+T**.
  - Sonner deliberately uses `ease` over a slightly longer duration to feel "elegant" [S6].
- Juno already ships Sonner 2.x.
- **Native:** use no toasts on iOS. Use a transient banner on glass only for background events, and otherwise the system notification.

#### E2. Approval cards (deterministic approval)
- **Trigger:** a task or crew member needs a consequential action approved: send, post, buy, delete, change permissions.
- **Feedback:**
  - A card arrives inline in the task (base rung, rising 6 px).
  - It says who, what and where, and names the verb: "**Post to #design**". Secondary: "Not now".
  - The consequence is shown before the click ("Visible to 42 people").
- **Deterministic rules:**
  - **Enter in the composer never approves.**
  - Focus is **not stolen** when the card appears.
  - The primary button ignores activation for about 500 ms after the card appears, or after its content changes, so a click or keypress aimed elsewhere cannot land on it **(proposal)**. Browsers use the same "security delay" idea on install and permission dialogs; Firefox's pref is `security.dialog_enable_delay` [UNVERIFIED current value].
  - A keyboard approve works only when the card itself has focus.
- **After approval:**
  - The button shows inline progress.
  - The card collapses (`spring.layout`) into a one-line receipt: "Posted to #design · Undo" where undo exists.
  - **Failure:** the card stays open with the error and a Retry.
- **Reduced motion:** opacity only.
- **A11y:**
  - A polite announcement: "Mira needs your approval to post to #design".
  - The card is a `role="group"` named by its title.
  - It is also listed in *Needs you* (E4).
- **Native:** `.sensoryFeedback(.success)` when the action *completes*, `.error` on failure. Nothing when the card appears; the notification carries that.
- **Sources:** product §7–§8; [S10 "Destructive confirmations", "No dead ends"][S8 "destructive actions trigger only on gesture end"][S22].

#### E3. Setup-change cards (Apply / Undo)
- **Behaviour:**
  - The card shows before → after.
  - A change that *narrows* access applies at once and shows "Undo" for about 10 s **(proposal; [S10] "safe window")**.
  - A change that *widens* access needs the E2 approval path.
  - Apply collapses the card to a receipt, using the same motion as E2.

#### E4. *Needs you* and the bell
- **Behaviour:**
  - A new row arrives in the *Needs you* fold. Existing rows shift with `spring.layout`, and the new row fades in over 220 ms.
  - The row names who and what.
  - **No count badge and no unread dot** (owner rule). The bell glyph may swap to its filled form, a glyph change rather than a dot.
  - The row is polite-announced once.
- **Reduced motion:** the layout snaps and the row fades.

#### E5. Tooltips
- **Behaviour:**
  - The first tooltip in a group waits a hover-intent delay. Every later one in the group is **instant, with no animation**, and inside the skip window.
  - Radix's defaults are 700 ms and 300 ms. Juno uses **300 ms**, a good choice for a pro tool.
  - The tooltip scales from `--radix-tooltip-content-transform-origin`.
  - `data-state="instant-open"` should carry `transition-duration: 0ms` [S4][S32].
- **A11y:**
  - The tooltip shows on focus, and Esc closes it.
  - It is never the only label: icon buttons carry an `aria-label` [S10].
- **Touch:** no tooltips. Labels or long-press take their place.

#### E6. Menus, popovers, dialogs and sheets
- **Menus and popovers:** F2, 150–200 ms, scale 0.96→1 plus opacity from their trigger. Exits use the exit rung. Opened from the keyboard, they appear instantly.
- **Dialogs:**
  - Centred, with `transform-origin: center` [S6], on the slow rung.
  - Focus is trapped, starts on the first sensible control, and returns to the trigger.
  - Esc closes.
  - Radix's Presence waits for the exit animation before unmounting [S32].
- **Mobile web sheets (Vaul):**
  - A drag follows the finger one-to-one.
  - Dismissal is by velocity, not a fixed distance.
  - Dragging past the top is damped.
  - A drag only starts from scroll-top, with a 100 ms guard after scrolling.
  - Curve `(0.32,0.72,0,1)` at 500 ms [S3].
  - `overscroll-behavior: contain` [S10].
- **Native:** system sheets and detents. The glass comes for free.

#### E7. The sidebar
- **Behaviour:**
  - Collapse and expand with `ease-drawer` on the base rung (220 ms). Pointer and keyboard (`⌘\`) share one motion for spatial consistency, capped at 200 ms because it is often keyboard-initiated.
  - It must be interruptible: a CSS transition, never keyframes.
  - Reduced motion: instant.
- **Mac:** `NavigationSplitView` or `NSSplitViewController` native behaviour.
- **Sources:** [S6][S27 "symmetric paths"].

#### E8. Keyboard shortcuts and the help sheet
- **The sheet:** opens with `⌘/` instantly, with no animation because it is keyboard-initiated. Shortcuts are shown with platform symbols and non-breaking spaces (`⌘ K`) [S10].
- **Baseline map (proposal)**, aligned with product §3 and §4 and with ChatGPT parity where it doesn't clash:

| Action | Mac | Notes |
|---|---|---|
| New chat | ⌘N | product §4.1 |
| Search | ⌘K | product §4.1 |
| Chat / Code | ⌘⇧1 / ⌘⇧2 | product §3 |
| Focus composer | ⇧Esc, or `/` when no field has focus | ChatGPT ⇧Esc [S36, UNVERIFIED] |
| Send | ↩ (or ⌘↩ per setting) | A3 |
| Stop | Esc, ⌘. | A5 |
| Copy last reply / last code block | ⌘⇧C / ⌘⇧; | ChatGPT [S36, UNVERIFIED] |
| Edit last message | ↑ in an empty composer | proposal |
| Toggle sidebar | ⌘\ | pick one and document it |
| Shortcuts | ⌘/ | ChatGPT and claude.ai both use it [S36][S44, UNVERIFIED] |

- Shortcuts are internationalised for non-QWERTY layouts: bind to `KeyboardEvent.code` where the position matters and to `key` where the letter matters [S10].

#### E9. Switching theme
- Switch **instantly**.
- **Disable every transition for the frame of the switch**, or a hundred elements each fade at their own speed. The technique:
  1. Inject a `* { transition: none !important }` sheet.
  2. Switch the theme.
  3. Force a style flush with `getComputedStyle(document.body)`.
  4. Remove the sheet.
- `next-themes` does this with `disableTransitionOnChange` [S33].

#### E10. Crew presence (the face)
- Motion happens **only on change**: arrival, needs-attention, settling (product §7).
- A state change is a one-shot `spring.standard` with no idle loop. The only permitted loop is the B1 shimmer on the text line while live.
- The state is always also text: "Mira · waiting for you".
- Reduced motion: a cross-fade between face states.

### F. The haptics map (iOS; Mac trackpad)

HIG rules [S22]:

- Use each system pattern for its documented meaning.
- Keep a strict cause and effect.
- Match the haptic's sharpness to the animation it accompanies.
- Don't overuse haptics, and prefer short haptics on discrete events.
- Make them optional, with a Juno setting.
- The best haptics are the ones people "may not be conscious of, but miss when it's turned off".

| Moment | Feedback | Rationale |
|---|---|---|
| Model or effort changed, a picker value changed | `.selection` | "values… changing" [S22]. Already used in `JunoThinkingControl` |
| Dictation starts / stops | `.start` / `.stop` | the activity start/stop semantics [S29] |
| Reply stopped by the person | `.stop` | an activity stopped |
| Long task or research done, with the chat on screen | `.success` | a notification of an outcome [S22] |
| An approved action failed | `.error` | outcome |
| A drag crosses a commit threshold (swipe to archive, sheet detent) | `.impact(weight: .light)` **at the threshold, during the gesture** | Rauno: light actions fire mid-gesture, destructive ones on release [S8] |
| Send, copy, ordinary reply finished | none by default | avoid overuse. Never tick while streaming [S22][S37] |
| Mac: a drag snaps to an alignment (sidebar width, split) | `NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)` or `.sensoryFeedback(.alignment)` | the macOS patterns are alignment, levelChange and generic [S22] |

---

## 3. Web implementation notes

- **Order of preference:** CSS, then WAAPI, then JS libraries [S10].
  - Use CSS **transitions** for state (they retarget), `@starting-style` for entry without JS [S6], and keyframes only for one-shots that never retarget.
- **Juno uses framer-motion 12:**
  - Keep `MotionConfig reducedMotion="user"`, which the audit found at `app-shell.tsx:460`.
  - Prefer `type: "spring", duration/visualDuration, bounce` [S46] over stiffness, damping and mass, so the web and SwiftUI share one parameterisation. `motion.ts` already does this for three of its four springs; `interactive` still uses stiffness 320, damping 30, mass 0.8.
  - Emil reports that framer's `x`/`y`/`scale` shorthands run on the main thread and drop frames under load, and advises a full `transform` string for animations that must survive streaming load [S6]. **Measure this on the transcript** before acting on it.
- **Never animate layout.** Use `grid-template-rows: 0fr → 1fr` for disclosures.
  - `interpolate-size: allow-keywords` is still **Chromium-only** (not in Safari 27 or Firefox as of 2026-09) [S41], so it may only be a progressive enhancement.
- **Same-document View Transitions** have been Baseline since 2025-10-14 (Firefox 144) [S42].
  - Reserve them for F3 moments: a Library item opening from its card in the transcript, or an artifact expanding into its panel.
  - Never use them for thread switching (F0).
- **Scroll:** see C1–C4. Safari before 27 has no `overflow-anchor` [S43].
  - `content-visibility: auto` on off-screen turns keeps long threads light, but measure its effect on anchoring first.
  - Virtualise only with a library that supports stick-to-bottom and anchor preservation [S10].
- **Pointer hygiene:**
  - `touch-action: manipulation`.
  - Set `-webkit-tap-highlight-color`.
  - Hit targets ≥24 px on desktop and ≥44 px on mobile.
  - Gate hover motion behind `(hover:hover) and (pointer:fine)` [S6][S10].
- **Clipboard:** `navigator.clipboard.write([new ClipboardItem({ "text/plain": …, "text/html": … })])`, with the fallback in D2.
- **Loading:** show-delay about 150–300 ms and minimum visible time about 300–500 ms, on every async surface [S10].
- **Debugging feel:**
  - Slow animations 2–5× in DevTools.
  - Step through them frame by frame in the Animations panel.
  - Test on a real phone.
  - Re-check with fresh eyes the next day [S6].

## 4. Native notes (SwiftUI, AppKit, UIKit)

- **Springs:** SwiftUI's default animation is a spring.
  - `.smooth`, `.snappy` and `.bouncy` all default to a **0.5 s perceptual duration** (checked against the declarations), with no bounce, a small bounce and a higher bounce respectively [S29].
  - WWDC23 guidance: bounce 0 by default, about 0.15 for briskness, about 0.3 for playful, never above 0.4 in UI [S28].
  - WWDC18: start at 100% damping, and allow about 80% only where the gesture carries momentum in the direction of travel [S27].
  - `JunoMotion` (0.22 s at bounce 0.05; 0.36 s at 0.1) fits this. Keep `platformFactor` for the Mac.
- **Gestures:**
  - Track one-to-one.
  - Wait for about 10 pt of hysteresis before committing to a direction.
  - Project the end point from velocity, with the deceleration rate of `UIScrollView`.
  - Rubber-band at the edges.
  - Keep enter and exit paths symmetric.
  - Detect all candidate gestures in parallel and cancel the losers.
  - Source: [S27].
- **Liquid Glass (the owner rule: native glass):**
  - Glass is for the **functional layer**: the composer bar, floating controls, toolbars, the jump-to-latest button. **Never** use it in the transcript content layer [S23].
  - Group sibling controls in a `GlassEffectContainer` so send, stop and dictate morph through `glassEffectID(_:in:)`. The default is the `matchedGeometry` transition; use `materialize` for effects further apart than the container's spacing.
  - Custom controls get `.glassEffect(.regular.interactive())`.
  - Limit the number of glass effects on screen, for performance [S26].
  - The **regular** variant is for text-heavy components. The **clear** variant is only over media, with a 35% dim if the media is bright [S23].
  - Use the scroll edge effect under the composer and toolbars (`scrollEdgeEffectStyle(_:for:)`, iOS/macOS 26) so the transcript softens under the glass instead of colliding with it [S23][S29].
- **Composer and keyboard (iOS):**
  - `.scrollDismissesKeyboard(.interactively)` [S29].
  - Keep the composer attached to the keyboard's safe area.
  - Return inserts a newline, and the send button is explicit (A3).
- **Scroll (iOS 18 / macOS 15):**
  - Use `ScrollPosition`, `onScrollGeometryChange` and `defaultScrollAnchor(_:for:)` with the "was near bottom" rule from C1 [S29].
  - For turn anchoring (C2), `scrollTo(id:anchor: .top)` on the new user turn.
- **Symbol and number transitions:**
  - `.contentTransition(.symbolEffect(.replace))` for copy→check and send→stop.
  - `.contentTransition(.numericText())` for counters.
  - Both cross-fade gracefully under Reduce Motion.
- **Reduce Motion:**
  - SwiftUI `@Environment(\.accessibilityReduceMotion)`.
  - UIKit `UIAccessibility.isReduceMotionEnabled`.
  - AppKit `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion`.
  - Apple's list: tighten springs to reduce bounce, track gestures directly, avoid animating z-depth, replace x/y/z transitions with fades, and **avoid animating into and out of blurs** [S24]. That last point means B2's `blurIn` must fall back to plain appending.
  - The Swift side already has 212 reduce-motion references.
- **Announcements:**
  - SwiftUI: `AccessibilityNotification.Announcement("Juno replied").post()`.
  - UIKit: `UIAccessibility.post(notification: .announcement, argument:)`.
  - AppKit: `NSAccessibility.post(element:notification: .announcementRequested, userInfo:)`.
- **Haptics:** follow §2F.
  - `.sensoryFeedback(_:trigger:)` fires when the trigger *changes*. `JunoMobileFeedback.swift` already documents this.
  - iOS 26 adds `.press(...)` and `.release(...)` for touch-down and touch-up on buttons, icon-only buttons, sliders, tabs and toggles [S29]. Adopt them consistently or not at all.

---

## 5. Decisions and conflicts for the owner

| # | Question | Evidence | Recommendation |
|---|---|---|---|
| D1 | Exit easing: ease-in or ease-out? | Emil: never ease-in. Carbon, M3 and Apple: exits accelerate and are shorter | Keep 160 ms ease-in, opacity-led, only for exits the person caused (T3) |
| D2 | Copy check hold | Juno about 1.5 s; AI Elements and Streamdown 2 s | Either. Standardise one value in `IconSwap` |
| D3 | Does the composer height animate? | Frequency law [S1][S6] against the existing 220 ms spring | **Snap**. If you keep the spring, cap it at 120 ms and never animate the shrink |
| D4 | Stagger | Recipe §2.2(5) against audit R7 and [S6] | F3 surfaces only, capped at 6 items |
| D5 | Turn anchoring: top or bottom? | ChatGPT, assistant-ui `turnAnchor="top"`, shadcn Message Scroller | **Top**, with a 64 px peek and a clamp on tall user messages (C2) |
| D6 | Reasoning disclosure: auto-open? | AI Elements auto-opens, then closes after 1 s; product §9 wants it quiet | Collapsed, with one live line. Never auto-close something the person opened |
| D7 | Haptics while streaming | ChatGPT does it [S37, UNVERIFIED]; the HIG advises against it [S22] | **No** |
| D8 | Streaming caret | Streamdown `●` and `▋` | **None**. The owner rule, and the words themselves are the signal |
| D9 | Tooltip delay | Radix 700 ms; Juno 300 ms | Keep 300 ms. Make later tooltips instant with no animation |
| D10 | Enter or ⌘Enter to send | Linear added the choice on 2026-03-12 [S34] | Default Enter; offer the setting |
| D11 | Esc precedence | Esc closes palettes, cancels edits and stops streaming | Order: palette or menu → inline edit → stop streaming → nothing. Esc never clears the draft |
| D12 | Curve literals | 16 literals in `src`, 3 of them overshoot "back" beziers | Replace them all with tokens; overshoot only through springs (T2) |

## 6. QA checklist (each item is testable)

1. Enter during a Japanese IME composition does not send. Neither does Enter while the submit button is disabled.
2. Double-pressing Enter within 50 ms sends once.
3. The user turn appears in the same frame as the keypress. Stop is available before the first token.
4. When the network drops before the stream starts, the draft and attachments remain, and the turn shows "Not sent · Retry".
5. With the reader at the bottom, streaming follows. **Selecting text in the streaming reply does not move the view.** One wheel notch up escapes; End or Jump returns and re-attaches.
6. On send, the user turn lands near the top with a peek of the previous turn, and a short reply does not snap the view back (D5).
7. Prepending 50 older turns does not move the visible text, in Safari 26, Safari 27, Chrome and Firefox.
8. With VoiceOver on, one reply produces exactly one "replied" announcement, and no partial text is read.
9. Code-block Copy is disabled until the fence closes, then copies the raw code. The check lasts 1.5–2 s. On clipboard failure the text is selected.
10. With Reduce Motion on (macOS, iOS and the browser), nothing translates, scales, blurs or bounces. Fades remain, and the follow scroll is an instant pin.
11. Keyboard-opened palettes, menus, the shortcuts sheet and thread switches show no animation.
12. Dragging a PDF over the window shows the overlay, and dragging text does not. A 200 MB video is rejected inline, by name.
13. A pasted 30,000-character log becomes a "Pasted text" chip with an "Insert as text" option (A6).
14. An approval card cannot be approved by Enter in the composer, nor by a click within 500 ms of the card appearing (E2).
15. An iPhone reply produces no haptics while streaming. Model changes tick with `.selection`.
16. With CPU throttled 4× in DevTools, streaming a 3,000-word reply keeps the scroll smooth and typing into the composer has no visible lag. Verify commit throttling and memoised blocks (B2).
17. Switching theme shows no staggered colour fades (E9).
18. `grep -rhoE 'cubic-bezier\(' src | sort -u` returns only the token file (T2), and `transition-all` returns 0 hits.

---

## 7. Sources (all accessed 2026-09-30)

**Craft and motion**

- [S1] Emil Kowalski, "You don't need animations". https://emilkowal.ski/ui/you-dont-need-animations (undated on page)
- [S2] Emil Kowalski, "Building a toast component" (Sonner). https://emilkowal.ski/ui/building-a-toast-component
- [S3] Emil Kowalski, "Building a drawer component" (Vaul): `cubic-bezier(0.32,0.72,0,1)`, 500 ms, damping, the scroll-top rule. https://emilkowal.ski/ui/building-a-drawer-component
- [S4] Emil Kowalski, "7 practical animation tips": `scale(0.97)` press, start at ≥0.9 not 0, instant later tooltips, 180 ms vs 400 ms, 2 px blur. https://emilkowal.ski/ui/7-practical-animation-tips
- [S5] Emil Kowalski, "Great animations". https://emilkowal.ski/ui/great-animations
- [S6] Emil Kowalski, `review-animations/STANDARDS.md`: the frequency table, curves `(0.23,1,0.32,1)` / `(0.77,0,0.175,1)` / `(0.32,0.72,0,1)`, the duration table, stagger at 30–80 ms, velocity 0.11, reduced-motion rules. https://github.com/emilkowalski/skills/blob/main/skills/review-animations/STANDARDS.md (main branch, fetched 2026-09-30)
- [S7] Sonner source `src/index.tsx`: `TOAST_LIFETIME=4000`, `VISIBLE_TOASTS_AMOUNT=3`, `GAP=14`, `SWIPE_THRESHOLD=45`, velocity > 0.11, hotkey Alt+T, `aria-live="polite"`. https://github.com/emilkowalski/sonner
- [S8] Rauno Freiberg, "Invisible details of interaction design". https://rauno.me/craft/interaction-design
- [S9] Rauno Freiberg, *Devouring Details* (23 chapters: inferring intent, simulating physics, motion choreography, responsive interfaces…). https://devouringdetails.com/
- [S10] Vercel, Web Interface Guidelines. https://vercel.com/design/guidelines
- [S19] Josh W. Comeau, "A friendly introduction to spring physics" (2020-09-21, updated 2025-11-03). https://www.joshwcomeau.com/animation/a-friendly-introduction-to-spring-physics/
- [S20] Josh W. Comeau, "Springs and bounces in native CSS" (`linear()`) (2025-10-28, updated 2026-05-05). Interrupted `linear()` transitions lose velocity. https://www.joshwcomeau.com/animation/linear-timing-function/
- [S33] Paco Coursey, "Disable transitions on theme toggle" (2020-03-19). https://paco.me/writing/disable-theme-transitions ; `next-themes` `disableTransitionOnChange`, https://github.com/pacocoursey/next-themes
- [S34] Linear, "A calmer interface for a product in motion" (2026-03-12). https://linear.app/now/behind-the-latest-design-refresh ; changelog "UI refresh" (2026-03-12), Enter or ⌘Enter for comments: https://linear.app/changelog/2026-03-12-ui-refresh
- [S35] Linear, "How we redesigned the Linear UI (part II)" (2024-03-28): LCH, three theme variables. https://linear.app/now/how-we-redesigned-the-linear-ui

**AI chat components**

- [S11] Vercel AI Elements: https://elements.ai-sdk.dev/ . Source, `github.com/vercel/ai-elements` `packages/elements/src/`:
  - `reasoning.tsx`: `AUTO_CLOSE_DELAY = 1000`, "Thought for N seconds".
  - `conversation.tsx`: `use-stick-to-bottom`, `role="log"`.
  - `prompt-input.tsx`: IME, Backspace, paste, drop, the status→icon mapping.
  - `code-block.tsx`: copy `timeout = 2000`.
  - `shimmer.tsx`: `duration = 2`.
- [S12] StackBlitz Labs, `use-stick-to-bottom`, `src/useStickToBottom.ts`: `STICK_TO_BOTTOM_OFFSET_PX = 70`, spring `{damping 0.7, stiffness 0.05, mass 1.25}`, selection and wheel escape, `ResizeObserver`. https://github.com/stackblitz-labs/use-stick-to-bottom
- [S13] Streamdown docs (`llms.txt`): Animation (per-word `fadeIn` 150 ms `ease`; `blurIn`; `slideUp` 4 px), Carets, Unterminated Block Parsing (`remend`), Interactivity (copy check 2 s, controls disabled while streaming, always visible on mobile). https://streamdown.ai/
- [S14] AI SDK `smoothStream`: `delayInMs` 10 ms, `chunking: 'word'`, `Intl.Segmenter`. https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream
- [S15] AI SDK UI `useChat` reference: `status: 'submitted'|'streaming'|'ready'|'error'`, `stop`, `regenerate`, `resume`, `resumeStream`, `experimental_throttle` (off by default). https://github.com/vercel/ai/blob/main/content/docs/07-reference/02-ai-sdk-ui/01-use-chat.mdx
- [S16] assistant-ui, Thread primitive: `turnAnchor`, `autoScroll` defaults, `topAnchorMessageClamp {tallerThan:"10em", visibleHeight:"6em"}`, ScrollToBottom disabled at the bottom. https://www.assistant-ui.com/docs/primitives/thread
- [S17] assistant-ui, ActionBar primitive: `autohide` always / not-last / never, `hideWhenRunning`, `[data-copied]`, Edit, Reload. https://www.assistant-ui.com/docs/api-reference/primitives/action-bar
- [S18] shadcn/ui, Message Scroller: scroll anchor with previous-item peek, `preserveScrollOnPrepend`, "last-anchor", `role="log"`, `aria-relevant="additions"`, `aria-busy`. https://ui.shadcn.com/docs/components/radix/message-scroller
- [S32] Radix Primitives:
  - Tooltip: `delayDuration` 700, `skipDelayDuration` 300, `data-state` instant-open, transform-origin variable. https://www.radix-ui.com/primitives/docs/components/tooltip
  - Dialog: focus trap and return, Presence. https://www.radix-ui.com/primitives/docs/components/dialog
- [S46] Motion (framer-motion) transitions: spring `visualDuration`, `bounce`. https://motion.dev/docs/react-transitions

**Apple**

- [S21] Apple HIG, Motion. The change log adds Liquid Glass guidance on 2025-09-09. https://developer.apple.com/design/human-interface-guidelines/motion
- [S22] Apple HIG, Playing haptics. https://developer.apple.com/design/human-interface-guidelines/playing-haptics
- [S23] Apple HIG, Materials (Liquid Glass regular and clear, the 35% dim, no glass in the content layer, scroll edge effects). https://developer.apple.com/design/human-interface-guidelines/materials
- [S24] Apple HIG, Accessibility (the Reduce Motion practices). https://developer.apple.com/design/human-interface-guidelines/accessibility
- [S25] Apple HIG, Loading. https://developer.apple.com/design/human-interface-guidelines/loading
- [S26] Apple, "Applying Liquid Glass to custom views" (`GlassEffectContainer`, `glassEffectID`, `matchedGeometry` / `materialize`, performance). https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views
- [S27] WWDC18 session 803, "Designing Fluid Interfaces". https://developer.apple.com/videos/play/wwdc2018/803/
- [S28] WWDC23 session 10158, "Animate with springs". https://developer.apple.com/videos/play/wwdc2023/10158/
- [S29] SwiftUI documentation (read through the docs JSON):
  - `Animation.snappy`, `.smooth` and `.bouncy` (`duration: TimeInterval = 0.5, extraBounce: Double = 0.0`).
  - `SensoryFeedback`: `press(_:)` and `release(_:)` (iOS 26), `start`, `stop`, `selection`, `alignment`, `levelChange`, `pathComplete`.
  - `defaultScrollAnchor(_:for:)` and `onScrollGeometryChange` (iOS 18 / macOS 15).
  - `scrollEdgeEffectStyle(_:for:)` (iOS/macOS 26).
  - `scrollDismissesKeyboard(_:)`, `dropDestination(for:action:isTargeted:)`, `PasteButton`, `ContentTransition.numericText`.
  - https://developer.apple.com/documentation/swiftui

**Design systems**

- [S30] Material 3 motion tokens, `material-web/tokens/versions/latest/sass/_md-sys-motion.scss`:
  - Durations: short1–4 = 50/100/150/200 ms; medium1–4 = 250–400 ms; long1–4 = 450–600 ms; extra-long1–4 = 700–1000 ms.
  - Curves: standard `(0.2,0,0,1)`; emphasized-decelerate `(0.05,0.7,0.1,1)`; emphasized-accelerate `(0.3,0,0.8,0.15)`.
  - Springs: spatial ζ 0.9 with k 1400/700/300; effects ζ 1 with k 3800/1600/800.
  - https://github.com/material-components/material-web
- [S31] IBM Carbon, Motion overview:
  - Productive and expressive curves.
  - Durations: fast-01 70, fast-02 110, moderate-01 150, moderate-02 240, slow-01 400, slow-02 700 ms.
  - https://carbondesignsystem.com/elements/motion/overview/

**Platform support**

- [S40] `field-sizing`: Baseline newly available 2026-06-16 (Chrome 123, Safari 26.2, Firefox 152). https://web-platform-dx.github.io/web-features-explorer/features/field-sizing/
- [S41] `interpolate-size`: Chromium only (129+). https://caniuse.com/mdn-css_properties_interpolate-size
- [S42] Same-document View Transitions: Baseline 2025-10-14 (Firefox 144). https://caniuse.com/view-transitions
- [S43] `overflow-anchor` in Safari 27 beta. https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/ ; https://csswizardry.com/2026/09/web-perf-wednesday-010-safari-keeps-scrolled-content-in-place/

**Secondary and UNVERIFIED**

- [S36] ChatGPT keyboard shortcuts (⌘⇧O, ⌘⇧C, ⌘⇧;, ⇧Esc, ⌘/), from secondary cheat sheets: https://shortcutref.com/en/chatgpt/ , https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-keyboard-shortcuts-guide . **UNVERIFIED** against OpenAI's own documentation.
- [S37] Haptics in the ChatGPT iOS app while responding, and how to disable them: https://wccftech.com/how-to/disable-annoying-haptic-feedback-vibrations-in-chatgpt-for-iphone-tutorial/ . The OpenAI help FAQ (https://help.openai.com/en/articles/7885016-chatgpt-ios-app-faq) returned 403. **UNVERIFIED**.
- [S38] Long pastes become attachments:
  - Claude (~20k characters): https://fast.io/resources/claude-character-limit/
  - ChatGPT: https://www.notebookcheck.net/ChatGPT-now-turns-long-pastes-into-attachments-for-Plus-Pro-and-Business-users.1259699.0.html (403)
  - **UNVERIFIED**.
- [S39] Accessible AI chat: announce on completion, `aria-busy`, debounced announcements. https://accessibility.build/guides/accessible-ai-chat (secondary)
- [S44] claude.ai shortcuts (Esc to stop, ⌘/): third-party lists such as https://freeacademy.ai/blog/claude-keyboard-shortcuts-hidden-features . **UNVERIFIED**. The same results note that Anthropic publishes no official list.
- [S45] "The scroll problem nobody talks about when building AI chat interface" (Medium), secondary. https://medium.com/@disgcfrguy/the-scroll-problem-nobody-talks-about-when-building-ai-chat-interface-987c223cafc0

**Not obtained:** Mobbin (paid plan required). The Material 3 site's HTML (JS-rendered) was replaced by the token source. Geist was not reviewed beyond AI Elements. No first-party ChatGPT or Claude interaction teardown exists; the behaviour cited here is observed or secondary and is marked as such.
