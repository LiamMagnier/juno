# Alevr Code v2: interaction and motion spec

Companion to [DESIGN.md](DESIGN.md). Every moving thing in Alevr Code v2 is listed here with its trigger, what moves, duration, curve, the web and SwiftUI parameters, and its reduced-motion fallback. If a motion is not in this file, it does not ship.

## 0. Vocabulary

One easing family, three durations, two springs. All are existing tokens except `--dur-mid` and `--dur-wide` (DESIGN §3.2).

| Name | Web | SwiftUI | Use |
|---|---|---|---|
| `fast` | 120 ms, `--ease-out-strong` = cubic-bezier(0.32, 0.72, 0, 1) | `.timingCurve(0.32, 0.72, 0, 1, duration: 0.12)` | Hover fills, colour and opacity changes on the element under the pointer, press |
| `mid` | 180 ms, same curve | `duration: 0.18` | Popover content swaps, row reveals, label changes |
| `wide` | 240 ms, same curve | `duration: 0.24` | Dock, sheets, takeovers: things that move the layout |
| `exit` | 0.75 × the enter duration, cubic-bezier(0.4, 0, 1, 1) (`--ease-in`) | `.easeIn(duration:)` | Anything leaving: always faster than it arrived |
| spring `standard` | CSS `--spring-standard` (linear() 250 ms); framer `{ type: "spring", stiffness: 420, damping: 40, mass: 1 }` | `.spring(duration: 0.25, bounce: 0)` | Fold/unfold, rail bar, dock snap, list reorder |
| spring `pop` | CSS `--spring-pop` (370 ms, 2.8% overshoot); framer `{ type: "spring", stiffness: 520, damping: 30, mass: 1 }` | `.spring(duration: 0.37, bounce: 0.12)` | Popover and sheet entrance, approval takeover, hunk decision stamp |
| press | 70 ms `--dur-press`, scale 0.97 | `.buttonStyle` press scale 0.97 | Buttons, rows |

Rules:
- Animate `transform` and `opacity` only (and `clip-path` / `stroke-dashoffset` where stated). Never `top/left/width/height` (the dock resize is a drag, not an animation; see I-10).
- Nothing loops forever except while the work it represents is running, and loops pause when the tab is hidden (`document.visibilityState`) or the window is occluded (Mac `controlActiveState` / `NSWindow.occlusionState`).
- No continuously repainting effects: the glow travels by rotating a pre-rendered conic layer (`transform: rotate`) on its own compositor layer; shimmer is a `background-position` animation on a short label only.
- Reduced motion (`prefers-reduced-motion: reduce`, `accessibilityReduceMotion`): every transform becomes an opacity cross-fade at `fast`; loops stop; springs become `fast` fades. This matches globals.css's existing Tier B.
- Reduced transparency: glass and blur become solid surfaces; motion is unchanged.

## 1. Catalogue

Each entry: **Trigger** · **What moves** · **Timing** · **Reduced motion**.

### I-1 Composer glow (the signature)
- **Trigger**: turn state changes. `idle → working` when the first event of a turn arrives; `working → needs-you` on an approval or input request; `→ idle` when the turn settles.
- **What moves**:
  - Idle: no glow; `--shadow-float`.
  - Working: a 1 px coral edge (`--signal` at 0.38) plus a 4 px halo at 0.07 fades in; a conic highlight (`--signal` at 0.55 over 70°) travels once round the perimeter every 4.8 s (`--loop-calm`), masked to the 1.5 px border ring.
  - Needs you: travel stops; the edge rises to 0.75 and the halo to 0.10 and holds. One single "breath" (halo 0.10 → 0.16 → 0.10 over 1.2 s, `--ease-breathe`) on entry only.
  - Settle: the edge fades to nothing and the float shadow returns.
- **Timing**: in `mid`; to needs-you `wide` (edge) + breath; settle `wide` with a 300 ms hold after the last token so a quick follow-up event doesn't flicker it.
- **Web**: one `::before` (ring mask via `mask-composite: exclude`) with a conic-gradient, `animation: rotate 4.8s linear infinite`; `will-change: transform` only while working.
- **Mac**: `JunoComposerAura` gains a `.signal` tone; travel uses `TimelineView(.animation(minimumInterval: 1/30))` rotating an `AngularGradient` masked with `strokeBorder(lineWidth: 1.5)`; glass tint `.regular.tint(.junoSignal.opacity(0.10))` in working, 0.16 in needs-you.
- **Reduced motion**: no travel; the edge and halo cross-fade in at `fast` and hold. Needs-you is a stronger static edge.

### I-2 Composer focus, expand, rest
- **Trigger**: focus, typing past one line, blur, send.
- **What moves**: focus changes nothing but the caret (no ring on the shell). Growth: the shell height follows content with a `standard` spring on `transform: scaleY`-free layout (framer `layout="size"` on the shell only, children `layout="position"`), capped at 40 vh then the draft scrolls. On send: the draft text translates up 6 px and fades (`mid` exit) as the user bubble appears in the thread (I-6); the shell springs back to its rest height.
- **Mac**: `.animation(.spring(duration: 0.25, bounce: 0), value: editorHeight)`.
- **Reduced motion**: height snaps; text fades only.

### I-3 Popover open (model, traits, tier, orchestrate, mode, slash, mention)
- **Trigger**: click / shortcut on the control; Esc or outside click closes.
- **What moves**: the popover scales 0.97 → 1 and fades 0 → 1 from its anchor's edge (`transform-origin` at the control), `y` 6 px → 0. Rows inside do not stagger (pickers must be instantly scannable). The control takes its `open` fill at `fast`.
- **Timing**: enter spring `pop` (opacity at `mid`), exit `exit` (135 ms) to scale 0.98 + fade.
- **Narrow (sheet)**: slides up from `translateY(100%)` with spring `standard` (`wide` cap), scrim fades to `--scrim` at `mid`; drag down to dismiss (velocity > 600 px/s or 30% travel), follows the finger 1:1, rubber-bands above the top at 0.3×.
- **Mac**: system `.popover` (its own animation); sheets are system sheets.
- **Reduced motion**: fade only at `fast`.

### I-4 Provider rail switch (model picker)
- **Trigger**: click a rail item, ⌘⇧↑/↓, or typing a search that matches another instance.
- **What moves**: the 3 × 18 px selection bar slides to the new item (`translateY`, spring `standard`); the old item's fill fades out and the new one's in at `fast`; the list content cross-fades with a 4 px horizontal shift in the direction of travel (down the rail = content enters from below, `mid`); the instance header sentence swaps with the same cross-fade. Keyboard focus stays in search.
- **Reduced motion**: bar jumps; content cross-fades at `fast`.

### I-5 Traits label change (effort cycle ⌘⇧E, tier pick)
- **Trigger**: effort or tier changes from the picker or shortcut.
- **What moves**: the changed word in "High · 1M" rolls: old word `y 0 → −6` and fades, new word `y 6 → 0` and fades in (`mid`). Only the changed segment moves; the dot and the other segment are still. The control's width animates with framer `layout` (spring `standard`).
- **Reduced motion**: cross-fade at `fast`, width snaps.

### I-6 Tool row streaming
- **Trigger**: a new `TurnItem` arrives or an existing one updates (coalesced at 50 ms per SPEC §3.1).
- **What moves**:
  - New row: opacity 0 → 1 and `y 4 px → 0` (`--shift-row`) at `mid`. Rows arriving in the same coalesced batch stagger 30 ms (`--stagger-row`), max 5 staggered, the rest appear together.
  - Running row: the glyph is the spinner (rotates 360° per 0.9 s, linear); the verb and object shimmer (a 40% wide highlight sweeps across the text every 2.4 s, `--loop`).
  - Completion: spinner cross-fades into the result glyph (check / terminal / edit) at `fast`; shimmer stops; elapsed freezes; counts (`+84 −6`) fade in.
  - Output tail lines (command rows): each new line fades in at `fast`, the block keeps the last 3 lines (older lines leave by clipping, no animation).
  - Assistant prose: the existing stream reveal (word-level fade, 120 ms per token group) and the scroll-down fade from the Oct 8 polish pass.
- **Mac**: same with `.transition(.opacity.combined(with: .offset(y: 4)))`, spinner as `JunoIconView(.spinner)` with `.symbolEffect`-free rotation via `rotationEffect` in a `TimelineView`.
- **Reduced motion**: rows fade in at `fast` without offset; spinner replaced by a static `loading` glyph; no shimmer (verb stays full ink).

### I-7 Turn fold / unfold
- **Trigger**: the turn settles (auto-fold after 1.2 s if the user isn't hovering it or has text selected inside it) or the user clicks the turn header.
- **What moves**: height animates via a measured container (framer `AnimatePresence` + `height: auto` on a wrapper, spring `standard`); the steps inside fade (exit `exit` at 100 ms before the height starts collapsing; enter fades in 60 ms after the height opens). The chevron rotates 0 → 90° (`mid`). Scroll anchoring keeps the final answer still on screen: the collapse happens above the viewport's anchor, so the page does not jump (CSS `overflow-anchor` plus an explicit `scrollTop` correction in the same frame).
- **Mac**: `DisclosureGroup`-style custom view with `.animation(.spring(duration: 0.25, bounce: 0))`; `ScrollViewReader` keeps the anchor.
- **Reduced motion**: instant height, fade at `fast`.

### I-8 Subagent fan-out tree
- **Trigger**: the lead spawns children; a child changes state; a child closes.
- **What moves**:
  - Spawn: the head row appears (I-6), then the spine draws downward (`clip-path: inset(0 0 100% 0) → inset(0)`, `wide`), and each child row enters as the spine reaches it (stagger 50 ms, `--stagger-fav`), with its elbow drawing left-to-right (`scaleX 0 → 1`, origin left, `mid`).
  - State change: the child's glyph cross-fades (`fast`); a new live line replaces the old with the I-5 roll; "Waiting for you:" fades in at `mid` together with the composer takeover (I-9) so the two coral objects arrive as one event.
  - Close: finished children collapse to their title line after 2 s (I-7 timing); the order never changes (no reorder animation in the tree, DSH rule: settlement changes status, not position).
  - Run head counters (elapsed, cost) tick with `tabular-nums`, no animation; cost crossing 80% of budget fades the figure to `--signal-ink` at `mid`.
  - Selecting a child: the underline grows under the title from the left (`scaleX`, `mid`); the dock switches tab (I-10) and the agent pane content slides 8 px from the right with a fade (`mid`).
- **Reduced motion**: spine and elbows appear at full length; rows fade in at `fast`.

### I-9 Approval takeover
- **Trigger**: `approval_request` or `user_input_request` for the visible thread.
- **What moves**: the queue dock fades out (`exit`). The composer draft and footer fade out (`exit`, 90 ms) and the approval content fades in with `y 6 → 0` (spring `pop`, opacity `mid`). The shell's height follows (spring `standard`). The glow moves to needs-you (I-1). Focus moves to the approval's primary action (screen readers: `role="alertdialog"` announced with the header sentence).
  - Resolve: the chosen button gets the press state, then the approval content fades out at `exit`, a one-line receipt row appears in the thread (I-6), and the draft returns with whatever the user had typed (drafts are never lost).
  - Multiple pending: ← / → slide between them (content `x ±12 px` + fade, `mid`); "1 of 2" rolls (I-5).
- **Mac**: content swap inside the same glass shell with `.transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 6)), removal: .opacity))`, `.animation(.spring(duration: 0.37, bounce: 0.12))`.
- **Reduced motion**: cross-fade at `fast`; height snaps.

### I-10 Dock open, switch, resize, expand
- **Open / close** (⌘J ⌘D ⌘P ⌘⇧J ⌘⇧G or top-bar toggles): the dock column animates its grid track from 0 to `--dock-w` (CSS `grid-template-columns` transition is avoided; instead the dock is absolutely positioned during the animation and translates `x 100% → 0` with spring `standard` capped at `wide`, while the thread column's content is FLIP-translated to its new centre). Close reverses at `exit`. The toggle button takes its on-fill at `fast`.
- **Switch tab**: content cross-fades with 4 px horizontal shift toward the new tab's side (`mid`); the selected fill slides between tabs (framer `layoutId="dock-tab"`, spring `standard`).
- **Resize**: direct manipulation, no animation while dragging (pointer-captured, `requestAnimationFrame`-batched width writes to a CSS variable). On release, snaps to 360 / 460 / 760 if within 16 px of them (spring `standard`). Double-click the edge: spring back to 460.
- **Expand** (⌘⇧D): the dock grows over the thread (`translateX` of the thread out by 24 px + fade, `wide`); the composer re-parents into the dock bottom with a shared-element transition (framer `layoutId="composer"`).
- **Narrow overlay**: sheet from the right, `translateX(100%) → 0`, spring `standard`, scrim fades at `mid`.
- **Mac**: `.inspector` system animation; tab switch via `matchedGeometryEffect` on the selection fill.
- **Reduced motion**: open/close fades at `fast` with no translation; tab fill jumps.

### I-11 Diff hunk accept / reject
- **Trigger**: click Accept / Reject, or A / R with the hunk focused; ] / [ move focus.
- **What moves**:
  - Accept: the hunk header's buttons fade out (`fast`) and "Accepted" fades in (`mid`); the added lines' fill briefly strengthens to `--diff-add-strong` and returns to `--diff-add` (one 400 ms pulse, `--ease-breathe`); the file header's counts roll (I-5).
  - Reject: the hunk content cross-fades to the original lines (removed lines lose their `−` and fill, added lines collapse with height spring `standard`), header shows "Rejected", the hunk dims to 0.6 at `mid`. Undo appears in the header for 6 s.
  - Focus move: the focused hunk gets a 1 px ink outline at `fast` and scrolls into view with `scrollIntoView({block: "nearest", behavior: "smooth"})` (instant under reduced motion).
- **Reduced motion**: no pulse, no collapse animation; text swaps at `fast`.

### I-12 Checkpoint rewind ("Edit from here")
- **Trigger**: hover a checkpoint divider shows "Edit from here"; click it.
- **What moves**: a one-line confirmation replaces the divider label ("Revert 3 files and 2 turns? Revert · Cancel", `mid` cross-fade). On Revert: every turn after the checkpoint fades to 0.35 and gets a hairline strikethrough-free "Reverted" label (`wide`), then folds away with I-7; the user message at that checkpoint moves into the composer draft (shared-element `layoutId` from bubble to draft, spring `standard`), caret at the end. The Changes tab counts roll down.
- **Reduced motion**: turns fade out at `fast`, the draft text appears without travel.

### I-13 Queue dock
- **Trigger**: Enter while a turn runs (queue), ⌘↵ (steer), edit, delete, reorder.
- **What moves**:
  - Queue: the draft text lifts out of the composer into a new queue row (shared-element `layoutId` from draft to row, spring `standard`); the dock grows with height spring.
  - Steer: the row's text travels from the queue into the thread as a user bubble with a small "Steered" caption (shared element, spring `standard`); the queue dock shrinks; the composer glow does a single brighter travel lap (1.2 s) to acknowledge the steer.
  - Reorder: drag with the row lifted (`scale 1.01`, `--shadow-raised`), neighbours move with FLIP translate 150 ms ease-out (T3 sidebar timing), max 40 animated rows.
  - Delete: row fades and its height collapses (`exit` then spring).
- **Reduced motion**: rows appear/disappear with fades at `fast`; no shared-element travel.

### I-14 List reorders (sidebar threads, Needs you, agent list in the dock)
- **Trigger**: a thread moves to Needs you, a new thread is created, a thread finishes and re-sorts.
- **What moves**: FLIP: displaced rows translate from their old position to the new one in 150 ms ease-out; travel clamped to 40 px for rows without a moving neighbour; entering rows fade in, leaving rows fade out from a noninteractive clone; if more than 40 rows would fade in one update, skip the fades and translate only (T3 `Sidebar.motion.ts` constants).
- **Reduced motion**: instant reorder.

### I-15 Context gauge fill
- **Trigger**: usage updates after each model response, compaction, tier change.
- **What moves**: the wedge's sweep angle animates to the new value over `wide` with `--ease-out-strong` (SVG path re-computed per frame from an animated number via framer `useSpring(value, { stiffness: 260, damping: 34 })`). Crossing the 80% threshold cross-fades the wedge colour to `--signal` at `mid`. Compaction: the wedge sweeps back down over 600 ms (`--dur-emphasis`-adjacent; the user did not cause it) and the hover card, if open, rolls its numbers (I-5).
- **Mac**: `Canvas` wedge with `.animation(.spring(duration: 0.25, bounce: 0), value: fraction)`.
- **Reduced motion**: wedge jumps; colour change at `fast`.

### I-16 Tier selection with live price delta
- **Trigger**: hover or arrow-key through tier rows; click / Enter selects.
- **What moves**: the ruler shows a ghost window bracket for the hovered tier (a 1 px ink outline box from 0 to the tier's boundary at 0.25 opacity) that slides between tiers (`translateX` / `scaleX` with spring `standard`); the hovered row's estimate stays put, but the trigger control in the composer previews the price change as a muted delta after the label ("Medium · 1.05M  +$0.00" or "−$0.17") rolling in (I-5) and disappearing on exit (`exit`). Selecting: check glyph draws in (`stroke-dashoffset`, `mid`, the icon set's `draw` behaviour), the popover closes after 120 ms, the traits label rolls.
- **Reduced motion**: bracket jumps; check appears without drawing.

### I-17 Send, stop, steer buttons
- **Send → Stop**: when a turn starts with an empty draft, the arrow glyph rotates 90° and cross-fades into the square (`mid`); the button keeps its size.
- **Stop press**: press scale 0.94 (`press`), then the square shrinks to 0 and the arrow returns when the turn settles (`mid`).
- **Esc Esc**: the first Esc shows "Press Esc again to stop" as a 12 px muted line under the composer for 600 ms (fade `fast`); the second within the window triggers Stop.
- **Reduced motion**: glyph swaps without rotation.

### I-18 Computer-use frames
- **Trigger**: a `computer_action` frame arrives.
- **What moves**: the filmstrip scrolls left to keep the newest frame in view (`scrollTo` smooth, `wide`); the new frame scales 0.96 → 1 and fades in (`mid`); the previous "latest" frame shrinks from 240 to 120 width (framer `layout`, spring `standard`). In Dock › Screen the pointer ring moves to the action point (spring `pop`, 370 ms) and, for clicks, pulses once (ring scale 1 → 1.6, opacity 1 → 0, 400 ms). On the Mac overlay, the window outline fades in at `wide` and stays still (no marching ants).
- **Reduced motion**: no pulse, no scale; frames fade at `fast`; pointer ring jumps.

### I-19 Connections row actions
- **Install / Sign in**: the button shows a spinner glyph in place of its icon while the terminal opens (Dock › Terminal slides in per I-10). When the probe detects success, the row's sentence cross-fades to the new facts (`mid`) and the meters line grows in (height spring + fade). No celebration.
- **Re-check**: the sentence dims to 0.5 during the probe and returns at `fast`.
- **Expired → signed in**: the coral sentence cross-fades to muted (`mid`); the sidebar Needs-you row for it (if any) leaves via I-14.
- **Reduced motion**: text swaps at `fast`.

### I-20 Command palette and toasts
- **Palette**: scale 0.98 → 1 + fade, spring `pop`; results update without animation (typing must feel instant); highlighted row fill moves with `layoutId` spring `standard` (disabled under reduced motion).
- **Toasts** (undo after remove/reject only): rise 8 px + fade at `mid`, auto-dismiss 6 s with exit `exit`. No toasts for state changes the UI already shows.

## 2. Hover and press baseline (every control)

| Element | Hover | Press | Focus-visible |
|---|---|---|---|
| Text control (composer footer, tabs) | `--accent` fill at `fast` | scale 0.97 at `press` | 2 px `--ring` outline, offset 2 |
| Outline button | fill `--accent` | scale 0.97 | same |
| Ink button | lightness +6% (light) / −6% (dark) | scale 0.97 | same |
| Row (list, picker) | `--accent` fill | fill `--selected` | inset 2 px ring |
| Icon button | ink to `--foreground`, fill `--accent`; icon plays its own hover articulation from the icon set (`hover` in drawings.ts) | scale 0.94 | ring |

Pointer modality hides focus rings on click (DSH `data-input-modality` rule); keyboard modality shows them.

## 3. Verification

- Web: each interaction gets a `/dev/code-v2` gallery entry with a "reduced motion" toggle (the lane must not start a second `next dev`; galleries are verified with Playwright per the owner's web verification note) and a recorded clip (Playwright `video: "on"`) of I-1, I-6, I-8, I-9, I-10, I-11 for the owner's review.
- Mac: offscreen snapshot tests for every state of I-1, I-9 and the pickers in light and dark; motion verified with `XCTest` timing assertions on the animation values (no screen control).
