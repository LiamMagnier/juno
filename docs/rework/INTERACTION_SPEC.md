# Alevr interaction spec

> **2026-10-01 brand editorial update:** Alevr / Alevr Orbit / Alevr Code are the working design direction. Read [the brand package](brand/README.md) and the separate [Chat](brand/CHAT_SYSTEM.md), [Orbit](brand/ORBIT_SYSTEM.md), [Code](brand/CODE_SYSTEM.md) systems. Names in current proposed product prose are updated; source identifiers, routes, fenced code and dated evidence retain their actual spelling. Name availability and final artwork remain unresolved. This documentation pass does not authorize or claim a code rename. D-027–D-034 and the new brand specification override older visual rules; in particular D-033 allows restrained blur only on floating web layers and D-034 governs the new character direction. Original dated status below remains historical; HANDOFF.md is the current implementation record.

The definitive micro-interaction and component-behaviour spec for the Alevr Refoundation. It covers the web (Next.js, React, Tailwind, framer-motion 12) and maps every behaviour to the Mac (SwiftUI + AppKit) and to iPhone and iPad (SwiftUI + UIKit, Liquid Glass, haptics). An engineer should be able to build any interaction here without guessing a number, a string, a key or an ARIA attribute.

- **Status:** v1, written 2026-10-01 on `rework/refoundation` (head `cdb09e56`). Spec only; no code was changed.
- **Owner rules (hard, override everything below):**
  1. No status pills, badges or decorative dots.
  2. Native platform materials on Apple platforms. Under D-033, web floating layers use restrained translucent blur with solid fallbacks; content surfaces stay opaque.
  3. Nothing consequential happens without a deterministic approval.
- **Built on:**
  - the product model in `PRODUCT_REFOUNDATION.md` §3–§11;
  - four research files in `docs/rework/research/`: `ai-chat-ui-references-web.md` (**[web §n]**), `ai-chat-ui-references-ios.md` (**[ios §n]**), `micro-interactions.md` (**[micro Xn]**) and `premium-design-2026.md` (**[premium §n]**);
  - the shipped motion system: `docs/design/ICONS_AND_MOTION.md` §2, `src/lib/motion.ts`, the `--dur-*` / `--ease-*` tokens in `src/app/globals.css`, and `JunoMotion` in `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoDesignTokens.swift`;
  - `CODE_AGENT_SPEC.md` §1.10, §1.11, §2.8, §3.7 and §4.7 for the Code workspace.
- **References and citations.** Mobbin could not be used: every call on 2026-09-30 returned "Mobbin MCP requires a paid plan", so this spec has **no `mobbin_url` citations**. Borrowed behaviour is cited to first-party pages (URL inline or in §8) and to the reference board image that shows it, written `web/<file>` or `ios/<file>`. The board is `juno-references.html` (71 images, grouped by moment). It currently lives in session scratch space and should be copied to `docs/rework/research/board/` if it is kept.
- **Supersedes** the parts of existing docs listed in §7. Where this spec and an older doc disagree, this spec wins.

## How to read an entry

Every interaction has an ID (`C12`, `M6`, `T6`…). Tests, PRs and design reviews cite the ID. Each entry uses the same fields; a field that does not apply is left out.

| Field | Meaning |
|---|---|
| **Trigger** | What starts it: pointer, key, touch, voice, a server event. |
| **Feedback** | What the person sees, hears or feels, in order, with exact strings. |
| **Timing** | Frequency tier (F0–F3, §1.5), then the token: duration, curve or spring. |
| **Interrupt** | What happens if the person acts again mid-way. |
| **Reduced** | The reduced-motion form (§1.7). "Same" means it has no motion to reduce. |
| **A11y** | Roles, names, focus movement, announcements. |
| **Failure** | What the person sees when it goes wrong, and the recovery. |
| **Native** | The SwiftUI / AppKit / UIKit mapping and the haptic, where it differs from the web. |
| **Ref** | Where the behaviour comes from, and **Alevr differs:** what Alevr does that the reference does not. |

**Semantic colour roles** used throughout. The values come from `DESIGN_LANGUAGE.md` (Phase 2); this spec only fixes what each role may be used for.

| Role | Today's token | May be used for |
|---|---|---|
| `ink-1` | `--foreground` | Content text, active labels. |
| `ink-2` | `--muted-foreground` | Secondary text, inactive labels, trace verbs. |
| `ink-3` | new `--faint-foreground` | Tertiary text: receipts, timestamps, trace objects, placeholders. Must still reach 4.5:1 on its surface. |
| `surface-0/1/2` | `--background`, `--card`, `--accent` | Tone steps. Structure comes from these steps, not from borders. |
| `line` | `--border` | Hairlines, only where a boundary is interactive, and under Increase Contrast. |
| `primary` | `--primary` (becomes the §12 ultramarine) | **Only** where Alevr or an agent is acting *now* (the live line, a working face, a live meter) and the armed send button. At most two spots on a screen. |
| `attention` | new `--attention` (amber) | **Only** the words that say someone needs the person ("needs your answer"), and the waiting face. Never a fill, never a dot. |
| `danger` | `--destructive` | Destructive verbs and error glyphs. Never on a non-destructive primary action. |
| `data-add` / `data-remove` | `--success-ink` / `--destructive-ink` | Diff counts and data only, as text. |

Every other colour comes from an entity's own mark: an app icon, a file type, an agent face.

---

## 0. The feel, in ten rules and three signatures

These rules are the test every entry in §2 passes. They come from the research ([micro §0], [premium §6]) and the owner's rules.

1. **Frequency decides motion.** Anything done 100+ times a day, and anything started from the keyboard, does not animate. Tens a day is tonal only. Occasional things get standard motion. Only rare moments may delight (§1.5).
2. **The keyboard never waits for an animation.** A keyboard-initiated action takes effect in the same frame, with no entrance.
3. **Respond on the same frame; settle fast.** Feedback starts at input. UI transitions finish within 360 ms. Only F3 moments may reach 560 ms.
4. **Everything is interruptible.** Anything that can reverse uses a CSS transition or a spring, never keyframes. Input always cancels motion.
5. **Motion starts where the thing lives.** Popovers grow from their trigger. Nothing enters from `scale(0)`; entrances start at 0.96–0.98.
6. **Only `transform` and `opacity` travel.** Colours may cross-fade. Layout never tweens.
7. **State is words, and colour means alive.** Every state is a sentence ("Mira is drafting the renewal summary"). `primary` appears only on what is acting now; `attention` only on the words that say someone needs you.
8. **Loading waits, then stays.** A pending indicator appears only after 200 ms and, once shown, stays at least 400 ms, so nothing flashes.
9. **Reduced motion means fewer and gentler, not none.** Fades stay. Travel, scale, blur, bounce and loops go.
10. **Nothing consequential happens on a stray key.** Approval is a named verb button that ignores input for its first 500 ms, never Enter in the composer, never a voice "yes".

**The novelty budget.** Alevr spends invention in exactly three places ([premium §6.1-9]). Everything else is deliberately familiar.

- **S1 · Tokens drawn with the thing's own mark.** Files, apps, agents, projects and chats are atomic objects in the sentence, identical in the draft, the sent message and the receipt (C8–C10, M23).
- **S2 · Original characters with readable state.** An agent's appearance is customizable under D-034; words say what it is doing. Motion follows the scoped D-032 exception and §2.9.
- **S3 · The hand-off.** When a request becomes a task, the sentence that described it becomes the task card in place (T1).

---

## 1. Motion tokens

The existing ladder stays. It sits inside the consensus band of Emil Kowalski's standards, IBM Carbon, Material 3 and Apple ([micro §1], T1). This section adds the rules for using it, the timers that are not motion, and the few token changes listed in §7.

### 1.1 Durations

| Token | ms | CSS | Tailwind | framer (`@/lib/motion`) | SwiftUI (`JunoMotion`) | Use it for |
|---|---|---|---|---|---|---|
| instant | 0 | none | none | no transition | `Transaction(animation: nil)` / `.animation(nil, value:)` | Every F0 interaction (§1.5). |
| press | 70 | `--dur-press` | `duration-press` | `transition.press` | `.press` | The `scale(0.97)` dip on a small control under the pointer; the tonal press on rows. |
| fast | 120 | `--dur-fast` | `duration-fast` | `transition.fast` | `.fast` | Hover tone, glyph swaps, the action row reveal, label cross-fades, chip entrances. |
| exit | 160 | `--dur-exit` | `duration-exit` | `transition.exit` | `.exit` | Anything leaving that the person caused. Opacity-led, `ease-in`. |
| base | 220 | `--dur-base` | `duration-base` | `transition.base` | `.base` | Menus and popovers, dialogs in, disclosures, card arrival, toasts. |
| slow | 360 | `--dur-slow` | `duration-slow` | `transition.slow` | `.slow` | A region changing: the artifact panel, the send scroll, an AI title cross-fade. |
| emphasis | 560 | `--dur-emphasis` | `duration-emphasis` | `transition.emphasis` | `.Duration.emphasis` | A one-shot the person did not cause and must notice. F3 only. |

### 1.2 Timers (not motion)

These are behaviour constants, not animations. They live in a new `src/lib/interaction.ts` (`export const TIMING = { … } as const`) and a matching Swift `enum JunoTiming`. No component hand-types them.

| Name | Value | Meaning | Used by |
|---|---|---|---|
| `showDelay` | 200 ms | Wait before showing any pending indicator. | §3.1, M1, buttons |
| `minVisible` | 400 ms | Once shown, a pending indicator stays at least this long before another *status* replaces it. Content arriving replaces it at once. | §3.1 |
| `tooltipDelay` / `tooltipSkip` | 300 / 400 ms | First tooltip in a group waits; later ones open at once. (Existing `TooltipProvider` values.) | O3 |
| `hoverCardOpen` / `hoverCardClose` | 300 / 150 ms | Citation and token hover cards. | M6, O8 |
| `copiedHold` | 1500 ms | Copy → check before reverting. | M11, M7 |
| `approvalArm` | 500 ms | An approval's verb button ignores activation after it appears or its payload changes. | T6, X6, A8 |
| `phaseMinHold` | 1000 ms | A live line holds each phase at least this long. | M1, M5, T2 |
| `elapsedAfter` | 3000 ms | Elapsed seconds join the live line after this. | M1 |
| `reconnectQuiet` | 1000 ms | Silence on a live stream before "Reconnecting…" shows. | §3.7 |
| `reconnectGiveUp` | 10 000 ms | "Reconnecting…" becomes "Connection lost · Retry". | §3.7 |
| `slowFirstToken` | 10 000 ms | The live line admits the model is slow. | §3.10 |
| `toastLife` | 4000 ms | Sonner default; pauses on hover and on a hidden tab. | O6 |
| `undoWindow` | 10 000 ms | Every Undo affordance, everywhere. Pauses while hovered or focused. | §2 passim |
| `followThreshold` | 48 px | "At the bottom" for the stream follow. (From 24 px.) | M17 |
| `anchorPeek` | 64 px | Previous turn left visible above a newly sent message. | M18 |
| `jumpShowDistance` | 120 px | Distance from the bottom before Jump to latest appears. | M19 |
| `pasteChipLines` / `pasteChipChars` | 120 lines / 8000 chars | A paste larger than either becomes a "Pasted text" chip. | C4 |
| `dragThreshold` | 4 px (pointer) · 10 pt (touch) | Movement before a press becomes a drag. | S4, A4 |
| `longPress` | 450 ms (web touch) · system (native) | Long-press on web touch surfaces. Native uses the system recogniser. | G3 |
| `draftSave` | 300 ms debounce | Draft persistence. | C21 |

### 1.3 Curves

| Token | cubic-bezier | CSS / Tailwind | framer | SwiftUI | Use | Never for |
|---|---|---|---|---|---|---|
| out-soft | (0.33, 1, 0.68, 1) | `--ease-out-soft` / `ease-out-soft` | `ease.outSoft` | `JunoMotion.outSoft(_:)` | The default: hovers, fades in, swaps. | Exits. |
| out-strong | (0.32, 0.72, 0, 1) | `--ease-out-strong` | `ease.outStrong` | generated | Things the person moves: press, release without a spring. | Ambient motion. |
| out-expo | (0.16, 1, 0.3, 1) | `--ease-out-expo` | `ease.outExpo` | `.slow` | Long travel and region changes: panels, the send scroll. | Small controls (it looks instant, then hangs). |
| in | (0.4, 0, 1, 1) | `--ease-in` | `ease.in` | `.exit` | Exits the person caused, opacity-led, 160 ms at most. | Any entrance or response ([micro T3]). |
| in-out | (0.65, 0, 0.35, 1) | `--ease-in-out` | `ease.inOut` | generated | A→B with both ends visible: chevrons, disclosures, a segmented thumb without a spring. | Arrivals. |
| drawer | (0.32, 0.72, 0, 1) | `--ease-drawer` | `ease.drawer` | generated | Web sheets and docking panels. | — |
| spring (curve) | (0.22, 1, 0.36, 1) | `--ease-spring` | `ease.spring` | generated | `animate-pop-in` arrivals. No overshoot despite the name. | — |
| breathe | (0.45, 0, 0.55, 1) | `--ease-breathe` | `ease.breathe` | generated | The sanctioned live loops in §1.6, and nothing else. | Anything idle. |

**Retired.** `--ease-out-back` `(0.34, 1.32, 0.64, 1)` and the three hand-typed overshoot literals `(0.34, 1.56, 0.64, 1)`, `(0.34, 1.4, 0.64, 1)` and `(0.34, 1.3, 0.64, 1)` go ([micro T2]). An overshoot drawn with a bezier cannot be interrupted cleanly. Overshoot, where it is wanted at all, comes only from a spring in §1.4.

### 1.4 Springs

Springs use the `duration` + `bounce` form on both platforms, so the web and SwiftUI share one parameterisation. The Mac multiplies spring durations by `JunoMotion.platformFactor` (0.75) and keeps the bounce.

| Spring | framer | SwiftUI | Use | Bounce cap |
|---|---|---|---|---|
| standard | `{ type: "spring", duration: 0.22, bounce: 0.05 }` | `.spring(duration: 0.22, bounce: 0.05)` | Selection moves, a segmented thumb, a face pose change, a token's popover. | 0.05 |
| emphasized | `{ type: "spring", duration: 0.36, bounce: 0.1 }` | `.spring(duration: 0.36, bounce: 0.1)` | The task hand-off (T1) and a face turning toward you (P3). Nothing else. | 0.1 |
| layout | `{ type: "spring", duration: 0.36, bounce: 0 }` | `.spring(duration: 0.36, bounce: 0)` | Neighbours moving because something was added or removed, panels docking, the composer moving from the home to the dock (C18). | 0 |
| interactive | `{ type: "spring", duration: 0.32, bounce: 0.15 }` (**changed** from stiffness 320 / damping 30 / mass 0.8) | `.interactiveSpring(response: 0.32, dampingFraction: 0.85)` | Anything following a pointer or finger, and its release. | 0.15 |
| reward | `{ type: "spring", duration: 0.36, bounce: 0.15 }` (**new on web**) | `.spring(duration: 0.36, bounce: 0.15)` (**changed** from 0.18) | Exactly two sites: an approved action's receipt settling (T6), and long work (a task, research run, goal or Code run) completing while on screen (T9, R4, X2, X10). A third kind of site fails review. | 0.15 |

### 1.5 Frequency tiers

Every entry in §2 carries its tier. Review rejects a motion that is louder than its tier allows.

| Tier | How often | Motion allowed | Examples |
|---|---|---|---|
| **F0** | 100+ a day, or keyboard-initiated | None. Same-frame change. | Typing; composer growth; ⌘K open and close; any palette opened by a key; arrow-key navigation; switching threads; a sent message appearing; sidebar selection; find. |
| **F1** | Tens a day | Tonal change or ≤ 120 ms opacity/scale. | Hover, press, the action row, glyph swaps, attachment chips, tooltips. |
| **F2** | Occasional | `base` or `slow`, standard or layout springs. | Menus and popovers opened with a pointer, dialogs, sheets, disclosures, the artifact panel, toasts, an approval card arriving, the drop overlay. |
| **F3** | Rare | Up to `emphasis`; the `reward` spring; stagger of ≤ 6 items at 40 ms. | First run, a new agent arriving, the Library filling for the first time, a long task finishing on screen, a first publish. |

A pointer-opened menu is F2; the same menu opened from the keyboard is F0 and appears instantly. Components implement this with a single flag: `data-opened-by="keyboard" | "pointer"`, set on the trigger's `onKeyDown` / `onPointerDown`, read by the CSS (`[data-opened-by="keyboard"] { animation: none; transition: none; }`).

### 1.6 What may loop

Loops are for live state except D-032's subtle idle on the visible large character in its own thread, stopped when hidden or under Reduce Motion. Small sidebar/list/token faces remain cached and still. The live-state list follows; decorative logo and orbit loops fail review.

1. **The voice level** (C16) and the dictation meter (C15), driven by the audio level, never by a timer.
2. **An agent face in `thinking` or `working`**, at 32 px or larger, in the focused context only: the open thread's header or the roster card being viewed. One loop on `breathe`, 2400 ms. Sidebar, list and token faces never loop.
3. **The Code "Alevr is driving" edge glow** on the Preview pane and the screen-control outline (X8, X9), and the goal row while `working` (X2): the owner-approved "glow = state", on `breathe`, 2400 ms, opacity 0.6 ↔ 1.
4. **The elapsed-seconds counter** in a live line. A number changing once a second is information, not animation.
5. **A spinner inside a control the person pressed** (`Button loading`), shown only after `showDelay`, 16 px, `ink-2`, one turn per 800 ms, linear.

Banned as loops: shimmer sweeps across text, typing dots, streaming carets, orbs, idle faces outside the D-032 exception, blinking and glancing on timers, animated gradient borders, pulsing badges.

### 1.7 Reduced motion

**Triggers.** Web: `prefers-reduced-motion: reduce`, plus `<MotionConfig reducedMotion="user">` at the root (already in `app-shell.tsx`). Mac: `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion`. iOS: `@Environment(\.accessibilityReduceMotion)` / `UIAccessibility.isReduceMotionEnabled`. A Alevr setting, Settings › Appearance › Motion (System · Reduced · Full), overrides the system by setting `data-motion` on `<html>` (web) and an environment value (native).

| Normal | Reduced |
|---|---|
| Translate or scale entrance | Opacity only, same duration. |
| Exit | Opacity only, `exit`. |
| Spring move (layout, position, shared element) | Instant. |
| Emphasized or reward spring | `base` opacity fade, no bounce. |
| Disclosure height (`Collapse`) | Height snaps; the content fades over 120 ms. |
| Smooth scroll (send anchor, jump to latest, scroll to a card) | Instant. |
| Per-word stream fade (M2) | None: words append. |
| Glyph swap | 120 ms cross-fade, no scale. |
| View Transition or native zoom transition | 160 ms cross-fade. |
| Face pose morph, face attention turn | 160 ms cross-fade; no loop at any size. |
| Voice level, dictation meter | A static bar whose length updates at most 4 times a second, with no easing, plus the state word. |
| Glow (§1.6 item 3) | A static 1 px `primary` outline, no breathe. |
| Native blur or material transitions | Not animated ([micro §4]: "avoid animating into and out of blurs"). |

Haptics are unaffected by reduced motion; they have their own setting (§2.14). **Reduce Transparency** (native) needs no work when only system glass is used, which is why custom glass is limited to `glassEffect` system variants. **Increase Contrast** turns every tone-step boundary that carries meaning (tokens, cards, the composer) into a 1 px `line` outline.

### 1.8 Web implementation rules

1. **CSS first.** CSS transitions for state (they retarget); `@starting-style` for entrances without JavaScript; keyframes only for one-shots that never retarget. framer only for springs, `layout`, `layoutId` and `AnimatePresence`.
2. **Presets only.** framer transitions come from `@/lib/motion`; Tailwind durations and curves from the tokens. No hand-typed milliseconds or beziers anywhere else.
3. **What may move.** `transform` and `opacity`. `color`, `background-color` and `border-color` may cross-fade on `fast`. `box-shadow` never animates; fade a pseudo-element's opacity instead. `transition: all` is banned.
4. **Hover** rules sit inside `@media (hover: hover) and (pointer: fine)`, so taps never leave phantom hovers.
5. **Theme switching** disables transitions for one frame (inject `* { transition: none !important }`, switch, force a style flush with `getComputedStyle(document.body)`, remove) ([micro E9]).
6. **View Transitions** (same-document, Baseline since 2025-10-14) only at the sites listed in §2 (A2, M9, L2, L3), behind `if (document.startViewTransition)`. Never for thread switching.
7. **Layout never tweens.** Disclosures use `grid-template-rows: 0fr → 1fr` (`Collapse`). `interpolate-size` is Chromium-only (2026-09) and may be a progressive enhancement at most.
8. **Lint gate** (in `eslint-rules/design-system.mjs`; §6 Q-M8): no `transition-all`; no `cubic-bezier(` outside `globals.css`; no arbitrary `duration-[…]`; no `animate-pulse` / `animate-ping` / `.shimmer-text` outside the allowlist in §1.6; `staggerDelay` / `stagger()` only in the F3 allowlist (§7).

### 1.9 Native implementation rules

1. **SwiftUI** animations come from `JunoMotion`; timers from `JunoTiming`. F0 changes run inside `withTransaction(Transaction(animation: nil))`. Reduced-motion substitutes go through `JunoMotion.reduced(_:when:tier:)`.
2. **Liquid Glass** is for the functional layer only: the composer bar, floating controls, toolbars, the tab bar, Jump to latest, the dock rows above the composer. Never in the transcript or on cards (HIG Materials: "Don't use Liquid Glass in the content layer").
   - Group sibling controls in `GlassEffectContainer(spacing:)` and give the send, stop and voice faces the same `glassEffectID(_:in:)`, so they morph into each other.
   - Custom controls use `.glassEffect(.regular.interactive())`. `.clear` only over media, with a 35% dim if the media is bright.
   - Tint only the armed send (the one primary action). No glass on glass.
   - `scrollEdgeEffectStyle(.soft, for: .bottom)` under the composer and `.top` under the toolbar, instead of dividers.
   - Test at both ends of the iOS 27 Liquid Glass slider (ultra-clear and fully tinted), and with Reduce Transparency and Increase Contrast on.
3. **Mac conventions** (Raycast 2's list, [premium §2.6]): no pointing-hand cursor except on links; no hover highlights on most controls (toolbar buttons use the system style); native `NSMenu`, `NSPopover` and sheets; nothing flickers. Springs use `platformFactor`.
4. **Symbols and numbers:** `.contentTransition(.symbolEffect(.replace))` for glyph swaps; `.contentTransition(.numericText())` for counts. Both degrade to a cross-fade under Reduce Motion.
5. **Announcements:** `AccessibilityNotification.Announcement("…").post()` (SwiftUI), `UIAccessibility.post(notification: .announcement, argument:)`, `NSAccessibility.post(element:notification: .announcementRequested, userInfo:)`.
6. **Haptics** follow the map in §2.14 and nothing else.

### 1.10 Reference implementation

The shapes an engineer starts from. Values are the ones above; nothing here is new.

```ts
// src/lib/interaction.ts (new): behaviour timers, never motion.
export const TIMING = {
  showDelay: 200, minVisible: 400,
  tooltipDelay: 300, tooltipSkip: 400,
  hoverCardOpen: 300, hoverCardClose: 150,
  copiedHold: 1500, approvalArm: 500, phaseMinHold: 1000, elapsedAfter: 3000,
  reconnectQuiet: 1000, reconnectGiveUp: 10_000, slowFirstToken: 10_000,
  toastLife: 4000, undoWindow: 10_000, draftSave: 300, longPress: 450,
} as const;
export const DISTANCE = {
  followThreshold: 48, anchorPeek: 64, jumpShowDistance: 120, dragThreshold: 4,
  pasteChipLines: 120, pasteChipChars: 8000,
} as const;

// src/lib/motion.ts (changed rungs only)
export const spring = {
  standard:    { type: "spring", duration: duration.base, bounce: 0.05 },
  emphasized:  { type: "spring", duration: duration.slow, bounce: 0.1 },
  layout:      { type: "spring", duration: duration.slow, bounce: 0 },
  interactive: { type: "spring", duration: 0.32, bounce: 0.15 },   // was stiffness 320 / damping 30 / mass 0.8
  reward:      { type: "spring", duration: duration.slow, bounce: 0.15 }, // two sites only (§1.4)
} satisfies Record<string, Transition>;
```

```css
/* Keyboard-opened layers never animate (§1.5). Set on the trigger's keydown / pointerdown. */
[data-opened-by="keyboard"],
[data-opened-by="keyboard"] * { animation: none !important; transition: none !important; }

/* Per-word stream fade (M2). Removed when the message finishes streaming. */
@keyframes juno-word-in { from { opacity: 0; } }
.stream-word { animation: juno-word-in 160ms var(--ease-out-soft); }
@media (prefers-reduced-motion: reduce) { .stream-word { animation: none; } }
:root[data-motion="reduced"] .stream-word { animation: none; }

/* The live line (M1): presence colour, tabular seconds, no sweep. */
.live-line { color: hsl(var(--primary)); font-size: 14px; }
.live-line .elapsed { color: hsl(var(--faint-foreground)); font-variant-numeric: tabular-nums; }
```

```swift
// JunoTiming (new), mirroring src/lib/interaction.ts.
public enum JunoTiming {
    public static let showDelay: Duration = .milliseconds(200)
    public static let minVisible: Duration = .milliseconds(400)
    public static let copiedHold: Duration = .milliseconds(1500)
    public static let approvalArm: Duration = .milliseconds(500)
    public static let phaseMinHold: Duration = .milliseconds(1000)
    public static let undoWindow: Duration = .seconds(10)
}

// JunoMotion changes (§7): reward bounce 0.18 → 0.15; handoff uses layout.
public static let reward = Animation.spring(duration: Duration.slow, bounce: 0.15)
public static func handoff(reduceMotion: Bool) -> Animation {
    reduceMotion ? outSoft(Duration.exit) : layout
}

// F0: a keyboard-initiated change never animates.
withTransaction(Transaction(animation: nil)) { model.selectThread(id) }
```

---

## 2. Components

### 2.1 Composer

One composer everywhere: Chat, an agent thread, a project, and Code (PRODUCT_REFOUNDATION §5). At rest it holds a field and four objects on one row: `+` on the left; the model control, dictate and the send/voice button on the right. Nothing is permanently armed. In Code, a quiet context row above the field names the repository, environment and mode.

**Anatomy and resting state (web).**
- Under D-030 and V3, the composer uses a surface fill, 22 px radius and a crisp edge, with no drop shadow, glow or gradient. Floating popovers have separate elevation/material rules; the composer itself does not.
- Field text is 16 px (never smaller on touch web, or iOS zooms), `ink-1`; placeholder `ink-3`.
- The send button is a 32 px circle. Empty field: `surface-2` fill with an `ink-3` glyph. Armed (text or attachments present): `primary` fill with a white glyph. This is one of the two permitted `primary` spots.
- The transcript fades under the composer with a `mask-image` gradient over the 24 px above it. This is the web's stand-in for Apple's scroll-edge effect; it is not glass.
- Above the composer is the **dock**: a single row attached to its top edge that can hold, in priority order, a *Needs you* row (T4), a queued message (C14), a goal (X2) or an offline notice (§3.6). Only one row shows; if more exist, the row ends with "2 more" (a text button opening a menu of the others).

**Native.** iPhone: the `+` is its own glass circle left of the capsule (the Messages and Siri shape, `ios/04`, `ios/02`); the capsule holds the field, the model label and dictate; the send/voice circle trails. Mac and iPad: one glass capsule. All controls sit in one `GlassEffectContainer` so send, stop and voice morph through `glassEffectID`. The dock row is glass in the same container, never a second stacked glass layer on its own.

**Ref.** Claude's "Opus High ⌄" plus one send (`web/composer__claude.png`, https://claude.com/product/overview); ChatGPT's role-grouped row (`web/composer__chatgpt-goal.png`, https://learn.chatgpt.com/docs/long-running-work); Messages iOS 26 (`ios/04`). **Alevr differs:** the dock is one shared slot for everything that attaches to the composer, instead of a goal-only tab.

#### C1 · Focus and type-to-focus (F0)
- **Trigger:** a new chat opens; a send completes; ⇧Esc; any printable key (including `/` and `@`) pressed while focus is on the page body or the transcript, with no modifier other than Shift.
- **Feedback:** the caret appears in the field and the typed character is inserted. Keyboard focus shows the global `:focus-visible` ring around the whole composer. Pointer focus shows no ring; the composer's surface and edge remain stable.
- **Timing:** F0, instant.
- **A11y:** the field has the accessible name "Message Alevr" ("Message Mira" in an agent thread, "Describe the change" in Code). Focus stays in the composer after send, stop, regenerate and model changes. A skip link "Skip to message field" is the first tab stop on every chat page.
- **Failure:** hydration must not drop focus or typed text; the field is uncontrolled until hydrated, then adopts its value.
- **Native:** iOS never autofocuses (the keyboard would cover half the screen); it focuses only on an explicit tap or on "Reply" from a notification. Mac: the field is the window's `initialFirstResponder`, and type-to-focus works from the transcript.
- **Ref:** [micro A1]. **Alevr differs:** type-to-focus from anywhere in the transcript, so reading and replying need no click.

#### C2 · Growth (F0)
- **Trigger:** the text wraps or a newline is inserted.
- **Feedback:** the field grows one line at a time up to `min(40vh, 12 lines)`, then scrolls internally with `overscroll-behavior: contain`. On send it returns to one line in the same frame. The transcript's bottom padding tracks the composer's height through a `ResizeObserver`, so the last message is never hidden; if the reader was attached to the bottom (M17), they stay attached.
- **Timing:** F0. **Growth snaps.** The 220 ms height spring in `useComposerAutosize` is removed (decision D3 in [micro §5]; typing is the highest-frequency act in the product).
- **Web:** `field-sizing: content` with `max-height` (Baseline since 2026-06-16); keep the JS measure only as the fallback for Safari ≤ 26.1 and Firefox ≤ 151. The rich field (C8) grows naturally as a `contenteditable` block.
- **Native:** SwiftUI `TextField(…, axis: .vertical).lineLimit(1...12)`; AppKit `NSTextView` in a scroll view with an intrinsic-height constraint capped at 12 lines.
- **Ref:** [micro A2].

#### C3 · Placeholder that teaches (F0)
- **Trigger:** the field is empty.
- **Feedback:** one line of `ink-3` text chosen for the context. It never animates, rotates or types itself out while visible; a new hint is chosen only when a new empty composer appears.

  | Context | Placeholder |
  |---|---|
  | New chat (first 20 chats) | "Ask anything. @ adds files, apps or agents; / runs skills" |
  | New chat (after the person has used `@` three times) | one of: "/research digs in and writes a report", "/deck makes a presentation", "@ an agent to hand it off" |
  | Thread | "Reply…" |
  | Orbit thread | "Message Mira…" |
  | Code | "Describe the change. @ files, / commands" |
  | Voice session (C16) | "Add to the conversation" |
  | Offline | "You're offline. Keep writing; it sends when you're back." |

- **A11y:** the placeholder is not the label (C1 gives the name). Placeholder contrast is at least 4.5:1 on `surface-1`.
- **Ref:** Grok's "Type @ to search your apps" (`web/composer__grok.png`); Raycast's "Ask anything, @ tools, or / for commands…" (`web/composer__raycast.png`). **Alevr differs:** the hint retires itself once the person has learned it, and it never rotates while visible.

#### C4 · Paste (F0)
- **Trigger:** ⌘V / Ctrl+V or the edit menu while the composer has focus.
- **Feedback:**
  - **Files or images on the clipboard** become attachment chips (C6); the default paste is prevented.
  - **Text over `pasteChipLines` (120 lines) or `pasteChipChars` (8000 characters)** becomes one chip: "Pasted text · 412 lines", with a two-line `ink-3` preview on hover or focus and an "Insert as text" item in its menu.
  - **Rich HTML** is converted to Markdown (headings, lists, links, code, tables). Styles, colours and fonts are dropped.
  - **A single URL** stays text. If it points to something a connected app can resolve (a Linear issue, a GitHub PR, a Google Doc), a one-line suggestion appears under the caret: "Turn into [DRV-364] · Tab" **(proposal)**. Tab accepts; any other key dismisses it.
- **Timing:** F0. Chips appear in the same frame.
- **Interrupt:** ⌘Z immediately after a conversion restores the raw text inline **(proposal)**.
- **A11y:** chips have names ("Pasted text, 412 lines"); the URL suggestion is announced once, politely: "Press Tab to add as a Linear issue".
- **Failure:** paste is never disabled or swallowed. If conversion fails, the raw text is inserted.
- **Native:** a user-initiated paste raises no iOS permission prompt; any "Paste" affordance Alevr draws is a `PasteButton`. Mac: `NSPasteboard` types read in order: file URLs, images, HTML, string.
- **Ref:** [micro A6]; long-paste chips in Claude and ChatGPT (UNVERIFIED thresholds, [micro S38]). **Alevr differs:** a pasted app URL can become a token (S1).

#### C5 · Drop overlay (F2)
- **Trigger:** `dragenter` anywhere over the chat pane with `"Files"` in `dataTransfer.types`. Text and link drags never trigger it.
- **Feedback:** the chat pane (not the sidebar) is covered by `surface-0` at 92% opacity with a 1 px `line` inset frame 12 px from the edges and centred text: "Drop to add to this chat" (`ink-1`) over "PDFs, images, code, spreadsheets · up to {limit} each" (`ink-3`). Inside a project: a second target on the lower third, "…or add to Acme project" **(proposal)**. On drop, the overlay leaves and the files become chips in the composer; focus moves to the field.
- **Timing:** F2. In: 120 ms opacity; the inner frame goes from scale 0.98 to 1 on `base`. Out: `exit`.
- **Interrupt:** a `dragenter`/`dragleave` counter prevents flicker over child elements; leaving the window hides the overlay in `exit`.
- **Reduced:** opacity only.
- **A11y:** the overlay is `aria-hidden`; every drop has a click path (`+`) and a paste path (C4).
- **Failure:** type, count and size are validated on drop and reported inline under the composer, by name: "2 files added · video.mov is over 100 MB". Rejected files never become chips.
- **Native:** SwiftUI `.dropDestination(for:action:isTargeted:)` drives the overlay; Mac `NSDraggingDestination`. iPad: the overlay also accepts drags from other apps.
- **Ref:** [micro A7]; AI Elements' error codes `accept`, `max_files`, `max_file_size`.

#### C6 · Attachment chips (F1)
- **Trigger:** a file added by C4, C5 or `+`.
- **Feedback:** a 40 px chip above the text: a local thumbnail (images) or the file-type mark (in its own colour), the name truncated in the middle ("Q3 Forec…ast.xlsx") and the size in `ink-3`. Upload progress is a 2 px track along the chip's bottom edge, filling in `ink-2`; after 5 s a percentage appears in `ink-3` tabular figures. The remove × shows on hover or focus on pointer devices and is always visible on touch.
- **Timing:** F1. Enter: 120 ms opacity with scale 0.96 → 1. Remove: `exit`; the remaining chips close the gap with `spring.layout`.
- **Interrupt:** removing a chip mid-upload cancels the upload. Sending while uploads are in flight queues the send (C12).
- **Reduced:** opacity only; the gap snaps closed.
- **A11y:** each chip is a group named by its file, with `role="progressbar"` and `aria-valuenow` while uploading, and a "Remove Q3 Forecast.xlsx" button. Removal is announced. Tab order: chips, then the field. Backspace at the start of an empty field selects the last chip; a second Backspace removes it. Enter or Space on a chip opens a preview.
- **Failure:** the chip's glyph turns `danger`, its second line reads "Upload failed · Retry", and send is disabled with the reason as its tooltip: "1 file failed to upload". Nothing is dropped silently.
- **Native:** iOS chips are 44 pt tall; `.contextMenu` offers Preview, Replace, Remove.
- **Ref:** [micro A8]; Claude's file tiles (`ios/30`). **Alevr differs:** progress is the chip's own edge, never a separate badge or pill.

#### C7 · The @ palette (F0)
- **Trigger:** `@` typed at the start of the field or after whitespace or an opening bracket. Not after a letter or digit, so "liam@acme.com" never opens it.
- **Feedback:**
  - The palette opens **in the same frame**, anchored to the caret: above the composer on desktop (360 px wide, 8 rows visible), and as a full-width panel directly above the keyboard on phones (the Copilot shape, `ios/05`).
  - With no query it shows recents, then sections in this order: Orbit, Files, Projects, Apps, Chats. With a query, exact prefix matches first, then fuzzy matches, grouped by section. iPhone adds filter tabs: All · Orbit · Files · Apps · Chats.
  - Each row: the thing's mark (face, app icon, file type), its name in `ink-1`, and one `ink-3` line (Orbit: role and "now"; Files: location and modified date; Apps: "Connected as liam@acme.com" or "Not connected"; Chats: date).
  - The first row is preselected. Local sources filter synchronously. Remote sources (files in Drive, Linear issues) append below a "Searching Drive…" line that appears only after `showDelay`. **Rows never reorder under the highlight once shown;** late results append.
- **Keys:** ↑/↓ and ⌃P/⌃N move the highlight instantly (no animated highlight). PageUp/PageDown jump 8 rows. Enter or Tab inserts (C8). Esc closes and leaves the literal "@query" as text. A space typed directly after `@` closes the palette. Pointer hover moves the highlight without scrolling the list; click inserts.
- **Timing:** F0. When opened with a pointer (the `+` menu's "Mention…" item), a 120 ms origin-aware pop is allowed.
- **Interrupt:** typing never waits for the palette.
- **A11y:** WAI-ARIA combobox: the field has `aria-expanded`, `aria-controls`, `aria-autocomplete="list"` and `aria-activedescendant`; the palette is `role="listbox"` with `role="option"` rows and `aria-selected`. Section headings are `role="presentation"` with the section name in each option's accessible description.
- **Failure:** no matches gives one row, "No matches. Search all files ↵", never an empty box. A remote source that fails shows "Couldn't search Drive · Retry" as a row.
- **Native:** iPhone: a panel inserted with `.safeAreaInset(edge: .bottom)` above the composer, moving with the keyboard's own animation curve; inserting a token plays `.sensoryFeedback(.selection)`. Mac: a non-activating child `NSPanel` anchored to the caret rectangle (`firstRect(forCharacterRange:actualRange:)`).
- **Ref:** Copilot's `/` palette above the keyboard (`ios/05`); Raycast's `@` apps (`web/tool-calls__raycast.png`); [micro A9]. **Alevr differs:** one palette for five kinds of thing, with late results that never reshuffle under the highlight.

#### C8 · Token insertion (F0) — signature S1
- **Trigger:** Enter, Tab or click on a palette row.
- **Feedback:**
  - "@mir" is replaced by the token in one step, followed by a space; the caret sits after the space.
  - The token is an atomic inline object at the sentence's own type size: the mark at 16 px, the name in `ink-1`, a `surface-2` fill one step above the field, radius 6, 4 px horizontal padding, baseline-aligned. **Colour comes only from the mark.**
  - The token *settles*: its fill starts at the palette's highlight tone and relaxes to the token tone over `base`. Nothing moves; the caret is already where it belongs.
  - A token that needs something before it can resolve shows its mark at 40% opacity (an app that is not connected, a file with no access). Its popover (C10) says why. There is no dot and no warning badge.
- **Timing:** F0 for the insertion; the tone relaxation is a colour cross-fade on `base`.
- **Data:** the draft is structured, not styled text. Each token carries `{ kind: "crew" | "file" | "project" | "app" | "chat" | "command", id, label, mark }`, and the request sends `context: [ … ]` (PRODUCT_REFOUNDATION §5). The field must be an editor with atomic inline nodes (ProseMirror or Lexical). The current textarea-plus-mirror (audit R9) cannot meet C9 and is replaced.
- **A11y:** each token is `contenteditable="false"` with an accessible name ("Mira, agent"; "Q3 Forecast.xlsx, file in Drive").
- **Native:** tokens are text attachments (`NSTextAttachment` with a view provider on Mac and iOS) so the system caret, selection and VoiceOver treat each as one character.
- **Ref:** Raycast's inline "[◐ Linear]" in draft and sent message (`web/tool-calls__raycast.png`); Gemini's "Images ×" mode token (`ios/11`); Canvas lab's brand-mark tokens ([premium §7.2]). **Alevr differs:** the same token object appears in the draft, the sent message and the receipt (M23), and it knows whether it can resolve before you send.

#### C9 · Token caret, deletion and clipboard (F0)
- **Keys:** ←/→ step over a token as one character; ⇧←/⇧→ extend the selection over it. Double-click selects it.
- **Deletion:** on a hardware keyboard, Backspace after a token first **selects** it (a 1.5 px `ink-1` outline; screen readers hear "Mira, agent, selected. Press Backspace to remove"); a second Backspace deletes it. Delete is symmetric. On a touch keyboard, one Backspace deletes the whole token and ⌘Z / shake restores it.
- **Undo:** ⌘Z restores a deleted token with its data.
- **Clipboard:** copying a selection that contains tokens writes `text/plain` ("@Mira", file names), `text/html`, and `application/x-juno-tokens+json`. Pasting inside Alevr recreates the tokens; pasting elsewhere gives plain text.
- **IME:** a composition is never split by a token, and Enter during composition never inserts or sends (C20).
- **Ref:** [micro A9] (two-step delete, proposal); [premium §6.3] ("deletes as one unit").

#### C10 · Token popover (F2)
- **Trigger:** click or tap a token in the draft, or Space / Enter on a selected token. Long-press on iOS.
- **Feedback:** a popover grows from the token (`base`, scale 0.96 → 1, origin at the token):
  - the mark, the full name, and what it resolves to ("File · Drive › Finance › Q3 Forecast.xlsx · 2.1 MB");
  - verbs: **Open**, **Replace…**, **Remove**;
  - for an app: "Connected as liam@acme.com · Can read issues · Creating issues asks you first"; if not connected, a primary text button **Connect Linear** that runs K3 in place;
  - for an agent: the face and "Mira will take this as a task";
  - for an action that will need approval: "Posting to #design will ask you first".
- **Interrupt:** clicking another token moves the popover (it retargets with `spring.standard`); Esc closes it and returns focus to the token.
- **Reduced:** opacity only.
- **A11y:** `role="dialog"` with `aria-labelledby` on the name; focus moves to the first verb.
- **Native:** SwiftUI `.popover` (Mac, iPad); a medium-detent sheet on iPhone.
- **Ref:** PRODUCT_REFOUNDATION §5. **Alevr differs:** connection and approval are resolved *before* send, from the token itself.

#### C11 · The / palette: skills and commands (F0)
- **Trigger:** `/` at the start of a line or after whitespace.
- **Feedback:** the same palette machinery as C7. Sources in order: commands (`/research`, `/design`, `/deck`, `/model`, `/voice`; in Code also `/goal`, `/ask`, `/plan`, `/code`), then enabled skills by name, each with its one-line description and origin ("Skill · by Linear"), then a last row, "Browse skills in Customize". The best match is preselected, so `/res` then Enter runs `/research`.
  - Choosing a command inserts a **command token** at the start of the message (mark + name, like C8). The placeholder after it changes to the command's prompt ("What should Alevr research?"), and the send button's accessible name changes ("Start research plan"). One command per message; choosing a second replaces the first.
  - `/model` and `/voice` act immediately instead of inserting a token: they open the model menu (§2.8) and start voice (C16).
- **A11y, keys, failure:** as C7.
- **Ref:** Raycast's "/ for commands"; ChatGPT and Claude skills [web §2.2]. **Alevr differs:** research, design and decks are commands, not toggles in `+` (PRODUCT_REFOUNDATION §5).

#### C12 · Send, optimistic (F0)
- **Trigger:** Enter (C20), ⌘Enter, or a click or tap on the armed send button.
- **Feedback, all in the same frame:**
  1. The user turn is appended to the transcript with its tokens and attachments, drawn exactly as they were in the draft. No flying bubble.
  2. The composer clears, returns to one line and keeps focus.
  3. Send morphs into Stop (C13) through `IconSwap` (web) or the shared `glassEffectID` (native).
  4. The turn-anchor scroll starts (M18).
  5. The reply slot appears below the turn, empty (M1).
- **Timing:** F0 for the turn. At most a 120 ms opacity from 0.6 to 1 on the new turn. Glyph swap on `fast`.
- **Queueing:** Enter while uploads are in flight queues the send: the dock (C14) reads "Sends when the upload finishes · Cancel". Enter while a reply is streaming queues the message (C14).
- **Guards:** a second Enter within the same frame, or while `status === "submitted"`, is ignored. Every send carries an idempotency key.
- **A11y:** the button's name flips "Send message" → "Stop response". Nothing is announced; sending is self-evident.
- **Failure (before the stream starts):** the turn stays in place with an `ink-2` line under it, "Not sent · Retry · Edit". The draft, tokens and attachments are never lost. The line names the cause when known: "Not sent: you're offline" (§3.6).
- **Native:** rely on the system button's press feedback. iOS 26 adds `SensoryFeedback.press(_:)` for touch-down; it must be used on every icon-only button or on none, and Alevr chooses **none**. No custom haptic on send.
- **Ref:** [micro A4]; Vercel guidelines "Optimistic updates" and "idempotency key". **Alevr differs:** the send button is `primary` only while armed, so the one bright spot on the composer means "ready".

#### C13 · Stop (F1)
- **Trigger:** the Stop button; Esc when focus is in the composer or transcript and no layer is open (§4, Esc ladder); ⌘. on the Mac.
- **Feedback:** new text stops **within one frame**; late chunks are discarded on the client even if the server lags. The partial reply stays, followed by "Stopped" set in `ink-3` (a word, not a pill). The action row shows **Continue** and **Regenerate** (M15). Stop becomes Send.
- **Timing:** F1, glyph swap on `fast`.
- **Scope:** Stop ends the *reply stream* only. A task started by the reply has its own Stop on its card (T10). If a chat has a running task but no streaming reply, the composer shows Send, not Stop.
- **A11y:** polite announcement "Response stopped". Focus stays in the composer.
- **Native:** `.sensoryFeedback(.stop, trigger:)` on iOS.
- **Ref:** [micro A5]; Dia's stop square in the send slot (`web/composer__dia.png`); Linear (`web/composer__linear.png`).

#### C14 · Queue while streaming (F1)
- **Trigger:** Enter with text in the field while a reply is streaming.
- **Feedback:**
  - The message does not send. It docks to the composer's top edge as a row: "Queued · also check the EU numbers" (the text truncated to one line, `ink-2`), then **Send now**, **Edit** and ×.
  - The field clears and keeps focus. The Stop button does not move or change.
  - Enter again with more text **appends** it to the queued message as a new paragraph. There is only ever one queued message.
  - When the reply finishes normally, the queued message sends at once, exactly as C12, and the row leaves on `exit`.
  - If the reply ends in an error, or the person stopped it, the queued message does **not** send: the row changes to "Queued · also check the EU numbers · Send" and waits, because the context changed.
- **Keys:** ⌘Enter with text while streaming is **Send now**: it stops the current reply (kept as "Stopped") and sends. Esc with focus on the dock row removes the queued message; ⌘Z restores it.
- **Timing:** F1. Row enter: 120 ms opacity with a 4 px rise; exit: `exit`.
- **A11y:** the row is `role="status"`; it announces "Message queued. It sends when Alevr finishes." once.
- **Native:** the dock row is glass inside the composer's `GlassEffectContainer`. On iPhone, swiping the row left removes the message.
- **Ref:** queued messages in Claude Code and Codex [web §2.8]; the goal row's placement on the composer edge (`web/composer__chatgpt-goal.png`). **Alevr differs:** one queued message, merged on repeat, that never auto-sends after a stop or an error.

#### C15 · Dictation (F2)
- **Trigger:** the mic button. There is no custom shortcut: system dictation (the Globe key on the Mac, the keyboard mic on iOS) also works in the field because it is a native text view, and on the web it is the browser's.
- **Feedback:**
  1. **Idle:** mic glyph in `ink-2`.
  2. **Asking permission:** the system prompt. Nothing else changes.
  3. **Listening:** the glyph swaps to a 5-bar level meter in `primary` (something is live), driven by the input level. The words appear at the caret as provisional `ink-3` text and turn `ink-1` when final.
  4. **Stopped:** tapping the mic again, or pressing Enter, stops and keeps the text. **Dictation never sends.** Esc stops and discards the provisional text.
  5. After 60 s of silence listening stops by itself and a line under the composer reads "Stopped listening" **(proposal)**.
- **Timing:** F2 for the state change (`fast` glyph swap). The meter follows the analyser each animation frame with smoothing 0.8; there is no timed loop.
- **Reduced:** the meter becomes a static bar updated at most 4 times a second, and "Listening" appears as text beside the mic.
- **A11y:** `aria-pressed` on the button, whose name is "Dictate"; announcements "Listening" and "Stopped listening". Provisional text is not announced.
- **Failure:** microphone blocked: a line under the composer, "The microphone is blocked. Allow it in this site's settings." Native: "Alevr can't use the microphone. Open Settings" with a deep link (`UIApplication.openSettingsURLString`).
- **Native:** `.sensoryFeedback(.start)` / `.sensoryFeedback(.stop)` on iOS.
- **Ref:** Mistral Vibe's "Autosend OFF" separating dictation from conversation (`ios/16`); [micro A12]. **Alevr differs:** dictation has no autosend at all; conversation is a separate thing (C16).

#### C16 · Voice conversation (F2)
- **Trigger:** the send/voice button while the field is empty (it shows the voice glyph in `ink-1` on `surface-2`: nothing is live yet), or `/voice`.
- **Feedback:**
  - Voice happens **in the thread**. The composer's control row cross-fades into the voice row: **Mute**, the state word, the level, the audio route, and **End**. The field stays, with the placeholder "Add to the conversation".
  - The state word is one of "Listening", "Thinking", "Speaking", "Muted", "Paused", in `ink-1`. "Waiting for your approval" uses `attention` for "your approval".
  - The person's speech appears as a user turn in real time (provisional `ink-3`, final `ink-1`). Alevr's speech streams as a normal reply (M2), and tool lines keep arriving (M5).
  - **The voice glow** (owner-approved "glow = state") lights the composer's edge **only while audio is live** (either direction), with its intensity driven by the level. At rest it is off. There is no orb.
  - **Barge-in:** if the person speaks while Alevr speaks, Alevr stops speaking within 200 ms and the word becomes "Listening".
  - **Approvals are never spoken.** If a task needs approval during voice, Alevr says "I need your approval on screen", the card appears (T6), and the state word reads "Waiting for your approval". A spoken "yes" does nothing.
  - **End** (or Esc while focus is in the voice row) cross-fades the row back to the text composer. The transcript stays.
- **Full screen** only when the camera or screen share is the input (iPhone, iPad). Controls sit on `.clear` glass with the 35% dim over bright video.
- **Timing:** F2. Row cross-fade on `base`; state word changes on `fast`, held at least `phaseMinHold`.
- **Reduced:** the glow becomes a static 1 px `primary` outline while audio is live; the level becomes a stepped bar.
- **A11y:** the state word is a polite live region, debounced so flips faster than every 2 s are not announced. With VoiceOver running, voice starts in **hold-to-talk** (Space held while the voice row has focus; press and hold the voice button on touch) so Alevr's speech and the screen reader do not collide **(proposal)**.
- **Failure:** network loss: the word becomes "Reconnecting…", audio pauses; after 10 s, "Voice disconnected · Resume". Microphone blocked: as C15.
- **Native:** the voice row morphs out of the composer through `glassEffectID`. `.sensoryFeedback(.start)` on start, `.stop` on end, nothing continuous. On iPhone, a live session becomes the `tabViewBottomAccessory` when the person leaves the thread (G6).
- **Ref:** ChatGPT voice inside the chat since 2025-11-25 (https://techcrunch.com/2025/11/25/chatgpts-voice-mode-is-no-longer-a-separate-interface/; `web/voice__chatgpt.png`, `ios/15`), "Spoken approval is not supported" (`research/openai.md`); Gemini Live full screen with the camera (`ios/17`). **Alevr differs:** no orb. The composer itself is the voice object, its glow lights only while sound is actually moving, and every state is also a word.

#### C17 · The model control in the composer (F1)
- **Trigger:** a click or tap on the label; `/model`.
- **Feedback:** the label reads the short model name in `ink-2`, followed by the effort in `ink-3` only when it is not Standard: "Auto", "Opus", "Opus Deep". One chevron. No logo, no pill, no border. Opening shows the menu in §2.8. After a choice, the label cross-fades to the new text on `fast`; if its width changes, the cluster slides with framer `layout="position"` on `spring.standard` (pointer-initiated) or snaps (keyboard-initiated).
- **Ref:** "Opus High", "6 Sol Medium", "Instant High" [web §2.3] (`web/composer__claude.png`, `web/composer__chatgpt-goal.png`, `web/composer__kimi.png`). **Alevr differs:** Standard effort is not printed, so the common case is one word.

#### C18 · Home to dock: the first send (F2)
- **Trigger:** the first send from the empty home.
- **Feedback:** the greeting and any suggestions leave on `exit`. The composer travels from the centre to the bottom dock as a shared element (framer `layoutId="composer"`; SwiftUI `matchedGeometryEffect`) on **`spring.layout`** (0.36 s, no bounce). The user turn is placed in its final position in the same frame, without animation. The field keeps focus and accepts typing throughout; input is never blocked by the move.
- **Timing:** F2. This is the one keyboard-initiated action that moves something, and it is allowed because the move is secondary: the message itself appears instantly.
- **Reduced:** a 160 ms cross-fade (the existing `JunoMotion.handoff(reduceMotion:)`).
- **Native:** `JunoMotion.handoff` changes from `emphasized` to `layout` (§7).
- **Ref:** ChatGPT and Claude move the composer on first send [web §2.1, MEM]. **Alevr differs:** no bounce, and the move never delays the message.

#### C19 · The + menu (F2)
- **Trigger:** the `+` button.
- **Feedback:** a menu from the button: "Add files or photos", "Take a screenshot" (Mac), "From Library…", a separator, then the two per-message switches people actually flip: **Web search** and **Use memory**, as checkable items. The `+` glyph turns 45° into × while the menu is open (`base`, `in-out`; instant when keyboard-opened).
- **State as words:** a switch that differs from the person's default leaves one `ink-3` line under the field for this message, "No web search" or "Memory off". Nothing is drawn as an armed chip.
- **A11y:** `role="menu"`; switches are `menuitemcheckbox` with `aria-checked`.
- **Native:** iPhone: the `+` glass circle opens a native `Menu` with Photos, Camera, Files, Screenshot, From Library and the two switches ([ios §3.2]).
- **Ref:** PRODUCT_REFOUNDATION §5; the slop it replaces is AI Elements' armed "Search" chip (`web/home__ai-elements-chatbot.png`).

#### C20 · Keys in the composer (F0)
- **Enter** sends; **⇧Enter** inserts a newline; **⌘Enter / Ctrl+Enter** always sends, whatever the setting. A setting, "Send with ⌘Enter", swaps Enter and ⇧Enter's roles for people who write long messages (Linear shipped the same choice on 2026-03-12).
- **IME:** Enter while a composition is active (`e.nativeEvent.isComposing` or the tracked composition state) never sends and never inserts a token.
- **↑ in an empty composer** edits your last message (M14) **(proposal: the Slack convention)**.
- **Esc** follows the ladder in §4. It never clears the draft.
- **Native:** iPhone: Return inserts a newline and the send button is explicit; a hardware keyboard's ⌘Return sends. Mac: Return sends, ⌥Return or ⇧Return inserts a newline.
- **Ref:** [micro A3]; AI Elements `prompt-input.tsx` (`isComposing`, `requestSubmit()`).

#### C21 · Drafts (F0)
- **Behaviour:** every thread keeps its own draft (text, tokens, attachment references, command token) saved `draftSave` (300 ms) after the last change, to IndexedDB on the web and to disk natively. Switching threads, reloading or quitting never loses a draft. A successful send clears it. A draft that is older than 30 days is dropped silently.
- **A11y:** returning to a thread with a draft places the caret at the end of the draft.

### 2.2 Message and transcript

**Anatomy.** User turns are a `surface-1` bubble aligned right at reading width, text `ink-1`. Alevr's replies are plain text on the page (no bubble, no avatar per turn), at a reading measure of 680–720 px, body 16/26. An agent's reply carries its face (20 px) and name once, above the first line of a run of consecutive replies. Nothing is nested inside a bordered bubble; only real outputs (a file, a deliverable, a task, an approval) get a container ([premium §5.1-7]).

The transcript is `role="log"` with `aria-relevant="additions"` (implying `aria-live="polite"`); it is never pointed at growing text.

#### M1 · Waiting for the first word: the live line (F1)
- **Trigger:** `status === "submitted"`.
- **Feedback:**
  1. For the first `showDelay` (200 ms): nothing.
  2. Then one line in the reply slot, 14 px, in **`primary`** (something is acting): "Thinking". Where the real phase is known, it says so: "Searching the web", "Reading Q3 Forecast.xlsx", "Asking Linear". In an agent thread it leads with the face at 16 px in its `thinking` pose: "Mira is thinking".
  3. After `elapsedAfter` (3 s) the line gains elapsed seconds in `ink-3` tabular figures, ticking once a second: "Thinking · 4s".
  4. A phase change cross-fades the text on `fast` and holds at least `phaseMinHold` (1 s).
  5. **The first token replaces the line in the same frame**, without an exit. Text replaces text.
- **No shimmer, no dots, no orb, no caret.** The line's colour and its changing words are the liveness signal (§1.6). This retires `.shimmer-text`, `PhaseOrb` and the typing indicator.
- **Reduced:** same; the text cross-fade becomes a swap.
- **A11y:** the pending message has `aria-busy="true"`; one polite status announcement, "Alevr is thinking" (or "Mira is thinking"). Phase changes are not announced individually.
- **Failure:** §3.10 (slow first token) and M16.
- **Ref:** Vercel's show-delay rule; Cursor's "Thought 4s" (`web/thinking__cursor.png`); Apple's generative-AI HIG: "instead of 'Processing…', say 'Finding substitutions for ingredients'". **Alevr differs:** no shimmer sweep. Every assistant ships the shimmer ([premium §4]); the audit traced Alevr's to Claude's and ChatGPT's own ([premium §5], crew audit §3.2-6). Alevr's live line is set in its presence colour and counts real seconds instead.

#### M2 · Streaming reveal (F0 per word)
- **Trigger:** tokens arrive.
- **Feedback:**
  - **Words** fade in as they are appended: opacity 0 → 1 over 160 ms on `out-soft`, applied by a CSS class on each newly appended word span. No slide, no blur. (A blur-in paired with a text sweep is the Claude "thinking" tell the agents audit found.)
  - **Pacing.** The server smooths by word (AI SDK `smoothStream`, `chunking: "word"`, `Intl.Segmenter` for CJK and Thai). The client keeps a buffer and, on each animation frame, releases `max(1, ceil(pendingWords / 12))` words, so a backlog drains within about 12 frames and the display never lags arrival by more than ~200 ms. When the stream ends, everything left is released in one frame. The client never fakes a typewriter slower than the model.
  - **Render cost.** React commits at most once per frame (`experimental_throttle: 16` in `useChat`; 32 for replies over 2000 words). Completed Markdown blocks are memoised by index. When streaming ends, the per-word spans are flattened: the final message re-renders without wrappers.
  - **No caret.** The arriving words and the Stop button are the signal.
- **Interrupt:** the reader can scroll, select and copy at any time; nothing pulls them (M17).
- **Reduced:** no fade; words append.
- **A11y:** `aria-busy="true"` on the streaming message until it finishes; one announcement on completion (M26).
- **Native:** `Text` built from an `AttributedString` that is appended to; words fade through a per-run opacity attribute animated on `fast`. On the Mac, `NSTextView` with `NSLayoutManager` temporary attributes.
- **Ref:** Streamdown per-word fade (150 ms default) and its March 2026 code-fence fix; AI SDK `smoothStream` (10 ms default). [micro B2]. **Alevr differs:** the pacing never lags the model, and no caret or cursor is drawn.

#### M3 · Markdown while streaming (F0)
- Unterminated syntax renders as if closed and is replaced when the closer arrives (Streamdown `remend`): `**bold`, `*italic`, `` `code ``, `~~strike`, links. Nothing ever flashes raw asterisks or `|---|`.
- A code fence renders as a code block from its first line (M7).
- A table renders as a table once its separator row arrives; rows append without animation (M8).
- Maths renders when its closing delimiter arrives; until then the TeX shows in `ink-3` monospace.
- A link is plain `ink-1` text until its URL is closed, then becomes a link without shifting layout.
- Images reserve their box from metadata before they load (M9). Nothing reflows text already above it.

#### M4 · Reasoning disclosure (F2)
- **While reasoning:** collapsed. The live line (M1) carries the latest reasoning summary as its phase.
- **After:** a quiet line above the answer, `ink-3`: "Thought for 12s ▸". The chevron rotates 90° on open (`base`, `in-out`).
- **Opening:** the reasoning summary appears in `ink-2` at 14 px through `Collapse` (`grid-template-rows`, `base`, `in-out`). If the person opens it while reasoning is still streaming, it stays open and streams inside.
- **Never auto-closes something the person opened; never reopens something the person closed.** The choice is kept per message for the session.
- **Answer now:** while effort is Deep, after 5 s of thinking the live line gains a text button, **Answer now**, which ends reasoning and answers with what the model has.
- **Reduced:** height snaps, content fades.
- **A11y:** a `<button>` with `aria-expanded` and `aria-controls`.
- **Native:** `DisclosureGroup` with a custom label; Mac uses the system disclosure triangle.
- **Ref:** AI Elements Reasoning auto-opens and closes 1000 ms after streaming (`web/thinking__ai-elements-reasoning.png`); Linear "Worked for 10 sec ▸" (`web/thinking__linear.png`); ChatGPT "Answer now" ([ios §3.4], secondary). **Alevr differs:** closed by default with one live line, and the person's choice is never overridden (decision D6 in [micro §5]).

#### M5 · Tool activity: the work trace (F1)
- **Trigger:** a tool call starts, updates or ends.
- **Feedback:**
  - Each step is **one sentence with the app's mark** (16 px): "Reading Q3 Forecast.xlsx in Drive". While live, the verb is present tense in `primary`. When done, it becomes past tense, the verb in `ink-2` and the object in `ink-3`: "Read Q3 Forecast.xlsx".
  - Consecutive steps of one kind merge: "Read 3 files in Drive", the count updating with a numeric transition.
  - While the reply works, at most the three latest steps show. Older steps fold into one `ink-3` line, "4 earlier steps".
  - When the answer starts streaming, the whole trace collapses into one summary line above it: "Worked 12s · searched the web, read 3 files ▸". It expands through `Collapse`.
  - Inside the expanded trace, each step has one more disclosure, **Details**, with its arguments and result in monospace. Telemetry lives one disclosure down, never in the default view.
  - A failed step: "Couldn't open Q3 Forecast.xlsx: Drive isn't connected · Connect" (verb `ink-2`, the recovery a text button).
- **Copy contract:** the tool registry supplies, for every tool, `present`, `past` and `failed` sentence templates and an object formatter. **A raw function name never renders.** A tool without templates renders "Used {App}".
- **Timing:** F1. A step appears with 120 ms opacity; the fold into "earlier steps" and the final collapse use `Collapse` (`base`). No stagger.
- **Reduced:** opacity only; heights snap.
- **A11y:** the trace is a `role="group"` named "Alevr's steps". Phase changes are announced politely, debounced to one every 3 s; the finished summary is not announced separately (M26 covers it).
- **Native:** SF Symbols or app marks at 16 pt; the live row may use `.symbolEffect(.pulse)` on its glyph (the only moving thing), with the text itself static. Everything else is still.
- **Ref:** Cursor "Read AppManager.tsx / Searched expose patterns" (`web/thinking__cursor.png`); Raycast "Checked new bugs in Linear" (`web/tool-calls__raycast.png`); Mistral Vibe's past-tense steps (`ios/12`, `ios/13`). The slop it replaces: AI Elements Tool's `database_query`, "PARAMETERS {}" and status pills (`web/tool-calls__ai-elements-tool.png`). **Alevr differs:** the live verb is the only coloured thing, and a sentence contract makes raw names impossible.

#### M6 · Citations (F1 chip, F2 card)
- **Chip:** after the sentence that makes the claim, following its punctuation, a chip joined to the last word by a non-breaking space: the source's favicon or app mark (12 px, its own colour) and domain in `ink-2`, 12 px, `surface-2`, radius 6, 18 px tall: "reuters.com +2". Personal data shows the app: "Slack · #design".
- **Hover card:** on pointer hover for `hoverCardOpen` (300 ms), a card grows from the chip (`base`): source title (`ink-1`, two lines), domain and date (`ink-3`), the passage that supports the claim (`ink-2`, three lines, the supporting words on a `surface-2` highlight), and **Open ↗**. With several sources, a pager "1 of 3" in tabular figures and ←/→.
- **Click or tap** pins the card open (the same content, for touch and keyboard). The title link, or **Open**, opens the source in a new tab. Esc or a click outside closes it.
- **Sources list:** at the end of the message, a collapsed "Sources · 8 ▸" in `ink-3` lists every source with title and domain. No numbered footnotes anywhere.
- **Unsourced claims:** when the citation audit finds any, one `ink-3` line under the message reads "2 claims have no source · Show". **Show** underlines those sentences with a dotted `ink-3` line. Never a warning badge; never a chip on unsourced text.
- **A11y:** chips are focusable buttons named "Source: reuters.com and 2 more"; Enter opens the card; focus moves into it; Esc returns to the chip.
- **Native:** iPad and Mac use `.popover`; iPhone uses a medium-detent sheet. Open uses `SFSafariViewController` on iOS.
- **Ref:** AI Elements Inline Citation (`web/citations__ai-elements-inline.png`); the Siri app's "wikipedia.org +6" (`ios/02`); Dia's app-marked source cards (`web/citations__dia.png`); AYDesign, "AI citation and source UI design patterns for 2026" (2026-09-11). **Alevr differs:** a click pins the card instead of navigating away, and the audit states what is unsourced in words.

#### M7 · Code blocks (F1)
- **Header** (sticky under the thread header while the block scrolls past): language in `ink-3` 12 px mono, and the filename when known; on the right, **Copy** (icon button with a tooltip) and ⋯ (Wrap lines, Download `.{ext}`, Open in Library).
- **While the fence is open:** the block renders from its first line; highlighting loads lazily (Shiki grammars on demand); **Copy is visible but disabled**, with the tooltip "Available when finished".
- **Copy:** copies the raw code without line numbers. Feedback as M11.
- **Long lines** scroll horizontally inside the block (`overscroll-behavior-x: contain`), with a 24 px fade mask on the overflowing edge. They never scroll the page. **Wrap lines** is remembered per person.
- **Collapse:** a block over 40 lines *loaded from history* renders its first 24 lines, a fade, and "Show all 142 lines" (`ink-2` text button, `Collapse` on `base`). **A block that streamed in is never collapsed afterwards;** that would move text the person is reading.
- **Diff blocks** (```` ```diff ````) get +/− gutters with `data-add` / `data-remove` text colour.
- **Visual:** `surface-1`, radius 10, no border, no shadow. A syntax palette of three or four hues on the neutral base, generated from the tokens.
- **Keys:** ⌘⇧; copies the last code block (§4). The block is focusable (`tabindex="0"`) so arrow keys can scroll it.
- **A11y:** `role="region"` named "Code, TypeScript, greet.ts".
- **Native:** a horizontal `ScrollView` around monospace `Text`; the copy glyph uses `.contentTransition(.symbolEffect(.replace))`.
- **Ref:** Streamdown disables controls while animating and keeps them visible on touch; AI Elements `code-block.tsx` (2000 ms check) (`web/code__ai-elements-code-block.png`). **Alevr differs:** no collapse after streaming, and wrap is a remembered choice.

#### M8 · Tables (F0)
- A table sits in a container that scrolls horizontally, with a fade mask on the overflowing edge. Numeric columns are right-aligned in tabular figures; text columns wrap at 320 px.
- Rows stream in without animation.
- Actions show on hover or focus (always on touch): **Copy** (a menu: Markdown, CSV, TSV; the default clipboard write is TSV as `text/plain` plus HTML, so it pastes into spreadsheets and documents) and, for tables over 20 rows, **Open as sheet** (creates a private Library sheet).
- **A11y:** a real `<table>` with `<th scope>`; the container is a focusable `role="region"` named "Table, 6 columns, 24 rows".

#### M9 · Images (F2)
- **Loading:** the box is reserved at the known aspect ratio (1:1 until known for generated images) on `surface-2`. A generated image shows a live line inside the box, "Making the image · 12s" (M1 rules). When the image loads it fades in on `base`. No blur-up, no mosaic reveal.
- **Lightbox:** a click opens it with a View Transition from the thumbnail (`slow`, `out-expo`); the scrim fades on `base`. ←/→ move between the chat's images; Esc or a click on the scrim closes it along the reverse path on `exit`. Double-click toggles 1:1. Actions: Download, Copy image, Edit, Open in Library.
- **Touch:** pinch and double-tap to zoom; swipe down to dismiss, following the finger with `spring.interactive` and dismissing on velocity.
- **Reduced:** 160 ms cross-fade.
- **A11y:** generated images use their prompt as `alt`; uploaded images use the file name. The lightbox is a dialog that traps focus and returns it to the thumbnail.
- **Failure:** "Couldn't load the image · Retry" inside the reserved box.
- **Native:** `.matchedTransitionSource` + `.navigationTransition(.zoom(sourceID:in:))` on iOS; Quick Look (`QLPreviewPanel`) on the Mac.

#### M10 · The action row (F1)
- **Contents.** Assistant reply: Copy, Regenerate (with a menu: "Try again", "Try again with {model}" for each favourite), Good response and Bad response as outline thumb glyphs, ⋯ (Share, Read aloud, Branch into new chat), and the version pager when there is more than one version (M13). User turn: Edit and Copy.
- **Reveal:** the **last** reply always shows its row. Earlier replies show it on hover or `:focus-within`, fading on `fast` with no hover-intent delay. A streaming message hides its row. Hover rules sit behind `(hover: hover) and (pointer: fine)`.
- **Touch:** the last reply's row is always visible; earlier replies use the long-press context menu (M24).
- **Visual:** 28 px icon buttons (24 px minimum target) in `ink-3`, turning `ink-1` on hover; 2 px apart; aligned to the text's left edge under the message.
- **A11y:** the row is hidden with opacity, never `display: none`, so Tab reaches it. Every button has an `aria-label` and a tooltip.
- **Ref:** assistant-ui ActionBar `autohide: "not-last"`, `hideWhenRunning` ([micro D1]).

#### M11 · Copy (F1)
- **Feedback:** the glyph swaps copy → check in place (`IconSwap`: overlapping glyphs, opacity plus scale 0.8 → 1, `fast`), holds for `copiedHold` (1500 ms), then swaps back. A second copy restarts the timer; unmount clears it. The button never changes width. The tooltip reads "Copied" while the check shows. **No toast.**
- **What is written:** a message as Markdown `text/plain` plus rendered `text/html` through `ClipboardItem`; a code block as raw code; a table as in M8.
- **Keys:** ⌘⇧C copies the last reply (§4).
- **Reduced:** the glyphs cross-fade without scale.
- **A11y:** polite announcement "Copied".
- **Failure:** if the Clipboard API is unavailable or denied, the tooltip reads "Couldn't copy. Text selected" and the content is **selected** so ⌘C works.
- **Native:** `.contentTransition(.symbolEffect(.replace))`; no haptic on copy.

#### M12 · Feedback (F1)
- Good response and Bad response are toggles (`aria-pressed`); the thumb glyph swaps to its filled form on `fast`.
- Bad response also opens a small popover from the button: four reasons as checkboxes ("Not accurate", "Didn't follow instructions", "Too long", "Unsafe or offensive"), a text field and **Send**. Dismissing the popover keeps the vote. After Send the popover closes; the filled glyph is the confirmation. No toast.

#### M13 · Regenerate and the version pager (F1)
- **Regenerate** replaces the reply in place: the old text leaves on `exit`, the live line (M1) appears, and the new reply streams. The old version is kept.
- **Pager:** "‹ 2 / 2 ›" in the action row, tabular figures. Switching versions is instant (at most a 120 ms cross-fade). Turns after a message follow the version selected.
- **Interrupt:** Stop applies (C13). Moving back to version 1 while version 2 streams is allowed; version 2 keeps streaming in the background **(proposal)**.
- **A11y:** a `role="group"` named "Version 2 of 2"; ←/→ step versions while the pager has focus.
- **Ref:** assistant-ui BranchPicker; ChatGPT and Claude (observed).

#### M14 · Edit and branch (F2)
- **Trigger:** Edit in the user turn's row, or ↑ in an empty composer for the last turn.
- **Feedback:** the bubble becomes an editor in place at the same width, with tokens intact and the caret at the end. The turns below dim to 50% opacity on `base` to show what will be replaced **(proposal)**. **Save** (Enter, following the C20 setting, or ⌘Enter) creates a new branch: the pager reads "2 / 2" on the user turn and the new reply streams. **Cancel** or Esc restores the text exactly.
- **Interrupt:** not destructive; the old branch survives behind the pager, so no confirmation is asked.
- **A11y:** focus moves into the editor; on save it returns to the composer; on cancel it returns to the Edit button.
- **Branch into new chat** (⋯): a new chat opens (F0) holding the history up to that message; its sidebar row enters Recent at the top with `spring.layout`, titled "{original title} (branch)".

#### M15 · Stopped reply (F1)
The partial text stays, followed by "Stopped" in `ink-3`. The row offers **Continue** (appends to the same message; the pager does not advance) and **Regenerate**.

#### M16 · Errors in a reply (F2)
Errors appear **where they happened**, as one line in `ink-1` with a small `danger` glyph and one recovery verb. The partial text stays. No red banner, no toast.

| Cause | Line |
|---|---|
| Network, before stream | "Not sent: you're offline · Retry" (C12) |
| Network, mid-stream | "Connection lost · Retry" (after §3.7's reconnect attempt) |
| Provider overloaded | "Opus is busy right now · Retry · Use Sonnet" |
| Rate limit | "You've reached the limit for Opus. Available again at 14:20 · Use Sonnet" (the time from `retry-after`, tabular) |
| Context too long | "This chat is too long for Sonnet · Continue in a new chat with a summary · Use Opus" |
| Content refused | "Alevr can't help with that." (no verb) |
| Unknown | "Something failed on Alevr's side · Retry", with "Details" disclosing the request ID |

Retry resends with the same idempotency key. **A11y:** errors are announced politely; Retry is reachable with one ⇧Tab from the composer.

#### M17 · Following the stream (F0)
- **Rule (kept from `message-list.tsx`):** follow new content only if the reader was at the bottom (within `followThreshold`, 48 px, up from 24) **before** it arrived. Following is an instant pin each frame, never a smooth chase.
- **Escapes (new):** any wheel event with `deltaY < 0`; PageUp, ↑, Home or ⇧Space in the transcript; a touch drag upward; **an active text selection inside the transcript**. Returning to within 48 px of the bottom, or Jump to latest, re-attaches.
- Content growth is detected with a `ResizeObserver` on the message list, separately from scroll events.
- **Reduced:** the same (it is already instant).
- **Native:** `onScrollGeometryChange(for:of:action:)` computes "near bottom"; `ScrollPosition.scrollTo(edge: .bottom)` only when it was near the bottom. `defaultScrollAnchor(.bottom, for: .sizeChanges)` is **not** applied blanket, or the reader could never escape.
- **Ref:** `use-stick-to-bottom` (70 px, wheel and selection escapes) [micro C1]. **Alevr differs:** a plain pin rather than a velocity spring, which cannot lag or overshoot.

#### M18 · Anchoring the new turn on send (F2)
- On send, the transcript scrolls so the **user's turn sits `anchorPeek` (64 px) below the transcript's top edge**, leaving the end of the previous turn visible above it. This is one smooth scroll on `slow` / `out-expo`, and the only automatic smooth scroll in the product.
- The reply then streams **below** the question without auto-follow. When it outgrows the viewport, Jump to latest appears (M19). If the reader scrolls to the bottom, M17 attaches.
- User turns taller than 10em are clamped to 6em with "Show more" (`ink-2`) while anchored.
- The last turn gets a spacer (viewport height − `anchorPeek` − composer height) so the anchor can reach the top even for a short reply. The spacer shrinks as the reply grows and is removed at the next send or thread switch, so a short reply never snaps the view back.
- **Reduced:** the anchor scroll is instant.
- **Native:** `scrollTo(id:anchor: .top)` on the new user turn inside `withAnimation(JunoMotion.slow)`.
- **Ref:** ChatGPT; assistant-ui `turnAnchor="top"` and `topAnchorMessageClamp { tallerThan: "10em", visibleHeight: "6em" }`; shadcn Message Scroller (64 px peek) [micro C2]. Decision D5 in [micro §5].

#### M19 · Jump to latest (F1)
- **Shows** when the reader is more than `jumpShowDistance` (120 px) from the bottom and there is content below. It is a 32 px circular button centred on the composer's top edge (part of the composer group; glass on native) with an arrow-down glyph.
- **While new content streams below the fold**, the arrow is drawn in `primary` (something is alive down there). **No count, no dot, no "New" pill.**
- **Scroll:** under two viewports away, a smooth scroll on `slow`. Further, jump instantly to one viewport above the end, then smooth-scroll the rest **(proposal)**. Any wheel or touch during the scroll cancels it.
- **Timing:** F1. Appear and disappear: 120 ms opacity with scale 0.96 → 1.
- **Reduced:** the scroll is instant.
- **A11y:** a real `<button>` named "Jump to latest"; inert (`tabindex="-1"`, `aria-hidden`) when hidden. After it is used, focus moves to the composer. Keys: ⌘↓, or End with focus in the transcript.
- **Native:** `.glassEffect(.regular.interactive())` in the composer's container.

#### M20 · Loading older messages (F0)
- An `IntersectionObserver` one viewport from the top loads earlier turns. The visible text must not move when they are prepended: `overflow-anchor` in Chrome and Firefox; in Safari before 27, the manual `scrollTop += Δheight` fallback.
- A line at the top, "Loading earlier messages…" (`ink-3`), appears only after `showDelay`.

#### M21 · Switching threads (F0)
- Instant: no transition, no fade. Each thread restores its own scroll position and draft (C21).
- A thread opened for the first time on this device starts at the **top of its last turn**, so the last answer reads from its start.
- Back and Forward restore position.
- A reply streaming in a thread you return to appears in its current state at once.

#### M22 · Find in conversation (F0)
- ⌘F opens a find bar at the top right of the transcript, instantly, with focus in its field. All matches get a `surface-2` highlight; the current match a stronger one. Enter / ⇧Enter step through matches; the view jumps (no smooth scroll) to put the match at a third of the viewport. The count reads "3 of 12" in tabular figures. Collapsed code blocks and traces that contain a match expand.
- Esc closes the bar and returns focus to where it was. A second ⌘F while the bar is focused passes through to the browser's own find.
- **Native:** Mac uses the standard find bar (`NSTextFinder` behaviour); iOS the `findNavigator`.

#### M23 · The resolution receipt (F1) — signature S1
- **Trigger:** the server confirms how the sent message's tokens resolved.
- **Feedback:** one `ink-3` line, 12 px, under the user's turn and aligned with it: "Q3 Forecast.xlsx and Stripe added · Mira takes the renewal risk · Posting to #design will ask you first". It fades in on `fast`. If resolution is quick (under `showDelay`), no pending state ever shows. If slower, the line first reads "Adding 2 files…".
- **Failure:** "Couldn't read Q3 Forecast.xlsx: no access · Request access" (the recovery a text button).
- **Tokens in sent turns** are the same component as in the draft (C8). On hover (after `hoverCardOpen`) they show a read-only version of the C10 popover.
- **Ref:** Linear's "◐ DRV-364 added to context" (`web/thinking__linear.png`). **Alevr differs:** the receipt also says who takes the work and what will ask first.

#### M24 · Context menus (native)
- **iOS:** long-press a message → `.contextMenu(menuItems:preview:)` with a preview of the message and: Copy, Select Text, Edit (user turns), Regenerate, Branch into new chat, Share, Read aloud, Good response, Bad response. **Select Text** matters because long-press is otherwise taken by the menu.
- **Mac:** right-click → a standard `NSMenu` with the same items, plus the system text services when text is selected.
- Menus appear instantly; the system provides the haptic.

#### M25 · Quote a selection (F1)
- When a pointer selection ends inside a reply, a small toolbar appears 200 ms later just above the selection's end: **Quote** (inserts the selection into the composer as a quote block) and **Ask about this** (the same, with focus in the composer after it). It does not follow the pointer and disappears when the selection collapses.
- Keyboard selections use the context menu item "Quote in reply".
- **Ref:** Alevr's existing `quoted-selection.tsx`.

#### M26 · Completion (F1)
- **Feedback:** the live line and trace settle (M4, M5); the action row fades in on `fast`; Stop becomes Send; focus stays in the composer. No sound, no toast.
- **A11y:** `aria-busy` becomes `false`, then one polite announcement: "Alevr replied" plus the first sentence, or "Mira replied". Completion is passed through `useChat`'s `onFinish`.
- **Native:** **no haptic for an ordinary reply**, and never a haptic while streaming (Apple HIG, Playing haptics: avoid long-running haptics).
- **Ref:** [micro B7]; ChatGPT's streaming haptics are the counter-example (UNVERIFIED, [micro S37]).

### 2.3 Task card

A task is delegated work inside a chat. The card leads with four things, in this order (PRODUCT_REFOUNDATION §9): **what** is being done (one sentence), **what needs you** (only when something does), **progress** (one line, the plan behind a disclosure), and, when done, **the result**. Executor telemetry is one disclosure down.

**Anatomy.** A flat `surface-1` card, radius 12, no border (a `line` outline under Increase Contrast), no shadow (the composer is also shadow-free under D-030). Header: the owner's face (Alevr's mark or an agent face) at 20 px, then the title sentence in `ink-1` 15/500. The card lives in the transcript where the reply that started it is; it keeps working when the person leaves.

#### T1 · The hand-off (F2) — signature S3
- **Trigger:** Alevr decides a request becomes a task, or the person named an agent with a token.
- **Feedback:** the live line (M1) already reads the work in words: "Drafting the renewal summary". **That line becomes the card.** Its text is the card's title; its box grows into the card header (framer `layoutId` shared between the line and the header), and the card's body opens below through `Collapse`. The receipt under the user turn (M23) gains "Mira takes the renewal risk", and if an agent owns it, the face in the header plays its arrival (P6) the first time that member appears in the chat.
- **Timing:** F2, `spring.emphasized` (0.36 s, bounce 0.1). This is one of only two uses of `emphasized`.
- **Interrupt:** a scroll or click during the morph never blocks; the card is interactive from its first frame.
- **Reduced:** a 160 ms cross-fade from line to card.
- **A11y:** polite announcement "Mira started a task: drafting the renewal summary". Focus does not move.
- **Native:** `matchedGeometryEffect(id:in:)` between the line and the card header.
- **Ref:** none; this is Alevr's (the novelty budget, [premium §6.1-9]). Closest precedents: Cursor's "Started 3 agents" tree (`web/agent-progress__cursor.png`) and Copilot Cowork's "Working on it" disclosure (`ios/19`).

#### T2 · Live progress (F1)
- **Feedback:** one line under the title, `ink-2`: "Reading 14 sources · 3 of 5 questions answered". The live verb is `primary`; numbers are tabular and change with a numeric transition. Below it, a disclosure: "Plan · 3 of 6 steps ▸" (`ink-3`), with the elapsed time in that disclosure's header only ("Plan · 3 of 6 · 4 min"). **Elapsed time is never the main progress signal.**
- **Progress bars** appear only when the work is determinate and countable ("Uploading 3 of 12 files"): a 2 px `ink-3` track filling in `ink-1`, no percentage. Otherwise, words only.
- **Timing:** text changes cross-fade on `fast` and hold at least `phaseMinHold`.
- **A11y:** phase changes are announced politely, at most one every 3 s.
- **Native:** the same line; on iPhone a task running longer than 2 minutes also starts a Live Activity (T11).
- **Ref:** Cursor's state sentences (`web/thinking__cursor.png`); [web §2.8] ("Worked for 2m 30s" as the main signal is slop).

#### T3 · The plan disclosure (F2)
- Steps are listed as sentences: done steps past tense with an `ink-3` check glyph; the current step in `primary`, present tense; upcoming steps `ink-3`. Sub-agents appear as an indented tree: "Started 3 helpers: Health · Deployments · Incidents", each with its own one-line state.
- Opens and closes through `Collapse` (`base`, `in-out`). Its open state persists per card for the session.

#### T4 · Needs you (F2)
- **Trigger:** the task needs an answer or an approval.
- **Feedback:**
  - A line appears under the title: "**Needs your answer:** send the revised quote today?" with the bolded words in `attention`. The question (T5) or approval (T6) opens below it. The card does not move in the transcript.
  - The owner's face turns toward the person once (P3).
  - If the card is off-screen in the open chat, the composer's dock (§2.1) shows the row: "Mira needs your answer on the Acme renewal · Show". **Show** scrolls to the card (smooth under two viewports, as M19) and focuses the question's first control.
  - The sidebar's *Needs you* fold gains a row (S7). If the chat is not in view, a notification follows (T11).
- **Timing:** the line and question enter on `base` with a 6 px rise.
- **Reduced:** opacity only.
- **A11y:** polite announcement "Mira needs your answer: send the revised quote today?". **Focus is never stolen.**

#### T5 · Question card (F2)
- **Feedback:** the question in `ink-1`; options as radio or checkbox rows (as the tool declares), each a full-width 36 px target; a last row "Something else…" that expands into a text field; then **Skip** (ghost) and **Continue** (an `ink-1` filled button; `primary` is reserved for things that are acting). Continue is disabled until an option is chosen or text entered.
- **Keys:** with focus in the card, 1–9 choose options, Enter activates Continue. Questions are not consequential, so Enter is allowed here. Esc returns focus to the composer and answers nothing.
- **After answering:** the card collapses (`spring.layout`) into one line, "You answered: Real-time metrics · Change". **Change** works until the task consumes the answer.
- **Native:** on iPhone the options are native chips in a wrapping layout and Skip / Continue are equal-width capsules (the Perplexity shape, `ios/14`).
- **Ref:** Cursor's checkbox question with Skip / Continue (`web/agent-progress__cursor.png`); Perplexity's clarifying question (`ios/14`).

#### T6 · Approval card (F2) — deterministic approval
- **Trigger:** a task or agent needs a consequential action approved: send, post, buy, delete, transfer, change permissions, use credentials.
- **Anatomy:**
  1. Title naming the actor and the exact verb: "Mira wants to post to #design".
  2. The exact payload: the channel's mark and name, the full message text (up to 8 lines, then "Show all"), attachments. For email: recipients as tokens, subject, body. For a purchase: item, amount, payment method. For a deletion: the items by name and count.
  3. The consequence, `ink-2`: "Visible to 42 people in Acme Slack".
  4. Actions:
     - **Primary: the verb itself**, "Post to #design", an `ink-1` filled button. A destructive verb ("Delete 3 files") uses the `danger` fill. Never the brand colour.
     - A split caret on the primary opens a menu with **"Post once"** (the default) and **"Always allow Mira to post to #design"**, which writes a scoped rule. The "Always" item exists **only for actions that are not on the always-confirm floor**; for floor actions the caret is absent.
     - **Not now** (ghost): denies.
     - **Tell Mira what to do** (text button): opens a field inside the card; what the person types is sent to Mira as an instruction, and the card becomes "You redirected: use the shorter version".
- **Deterministic rules:**
  - **Enter in the composer never approves.** There is no global approve shortcut.
  - **Focus is never moved** to the card when it appears.
  - **Arming:** for `approvalArm` (500 ms) after the card appears, and again after its payload changes, the primary and its caret ignore activation (`aria-disabled="true"`, drawn at 50% ink), then take their full tone on `fast`. No countdown is shown.
  - A keyboard approval works only when the button itself has focus (Tab into the card; Enter or Space).
  - The approval is bound to a digest of the payload. If the agent revises the payload, the card updates in place, shows "Changed just now" in `ink-3` above the payload, and re-arms.
  - Esc with focus in the card moves focus back to the composer. **Esc never denies.**
- **After approval:** the primary shows its pending state after `showDelay` (`Button loading`). On success the card collapses (`spring.layout`) into a receipt, "Posted to #design · 14:02", with **Undo** for `undoWindow` when the app supports reversal. The receipt settles on the **`reward`** spring (one of its two sites).
- **Deny:** the card collapses to "Not posted · you said not now" in `ink-3`. The task carries on or ends as the agent decides.
- **Failure:** the card stays open with the reason in words and **Try again** (which re-arms): "Slack said the channel is archived · Try again".
- **Timing:** F2. Arrival on `base` with a 6 px rise.
- **Reduced:** opacity only; the receipt settles without bounce.
- **A11y:** `role="group"` labelled by the title; polite announcement "Mira needs your approval to post to #design"; the primary's accessible name is the full verb. The card is also listed in *Needs you*.
- **Native (Mac):** the same card; the primary is a `.borderedProminent` button tinted `ink-1` (or `.red` for destructive). **iPhone and iPad:** T7.
- **Ref:** Codex's Approve / Always approve / Tell Codex what to do / Deny (`research/openai.md`); Copilot Cowork's Send Email sheet (`ios/19`). The slop it replaces: "This tool wants to delete… [Reject][Approve]" with a blue primary (`web/approvals__ai-elements-confirmation.png`) and Claude's lone full-width Approve (`ios/20`). **Alevr differs:** the button *is* the verb, it arms after 500 ms, it re-arms when the payload changes, and "Always" can never appear on a floor action.

#### T7 · Approval on iPhone and iPad (F2)
- **Low-stakes questions** stay inline, always with two buttons, never one.
- **Floor actions** show a compact card in the chat with one button, "Review and post". It opens a sheet (medium detent, expandable to large) with the exact payload (recipients as removable tokens, subject, body; or the diff; or the amount) and, at the bottom in thumb reach, **Cancel** and the verb ("Post", "Send", "Publish", "Delete") as equal-width capsules, the verb filled (`.red` tint when destructive).
- **Money, credentials and permission widening** then require device authentication (`LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Approve paying $240 to Figma")`) after the verb is tapped.
- **Haptics:** none when the sheet appears; `.success` when the action completes; `.error` if it fails.
- **From a notification:** every approval action is registered with `UNNotificationActionOptions.authenticationRequired`. Floor actions offer only **Review** (which opens the sheet); only non-floor approvals (such as Code's "Allow once" for a command) may be answered from the notification itself (CODE_AGENT_SPEC §1.11).
- **Ref:** Copilot Cowork (`ios/19`); [ios §3.6–§3.7].

#### T8 · Setup-change card (F2)
- An agent configured by talking ("Only notify me when you need a decision") produces a card showing **before → after** as two rows and what it affects.
- A change that **narrows** access applies at once; the card reads "Applied · Undo" with Undo for `undoWindow`.
- A change that **widens** access (a new app, a looser approval mode, spending) is an approval (T6) whose verb says exactly what widens: "Let Mira use Linear".
- Applying collapses the card into its receipt with the same motion as T6.

#### T9 · Completion and the result (F2, F3 when long)
- **Feedback:** the progress line leaves on `exit`; the result enters on `base` with a 6 px rise: an outcome sentence in `ink-1` ("The renewal summary is ready"); deliverables as Library cards (A1); changes made; "12 sources ▸"; receipts ("Sent to 3 people"); and one next action as a text button ("Review the draft"). The face settles to `available` (P2).
- **Reward:** if the task ran longer than 60 s **and** its chat is on screen, the outcome line settles on the `reward` spring and iOS plays `.sensoryFeedback(.success)`. Otherwise nothing celebrates; a notification carries it (T11).
- **A11y:** polite announcement "Mira finished: the renewal summary is ready".

#### T10 · Pause and stop (F1)
- The card's header has two text buttons while running: **Pause** and **Stop**.
- **Pause** keeps everything resumable: "Paused · Resume". No confirmation.
- **Stop** ends the task and keeps the work done so far: "Stopped by you after 3 of 6 steps · Start again". No confirmation, because nothing is undone or deleted.
- There is no third verb. (Codex separates Pause, Stop and Cancel; two verbs are enough when Stop never discards.)

#### T11 · Away from the chat
- **In Alevr, another chat open:** the *Needs you* fold gains a row (S7). For needs-you events only, a toast (O6): "Mira needs your answer on the Acme renewal · Show".
- **App not in view:** an OS notification. Copy names the member and carries the question: "Mira needs your answer · Acme renewal: send the revised quote today?". Web: the Notification API, after the person has allowed it from Settings (never prompted on first visit). Native: `UNNotification` with the categories in CODE_AGENT_SPEC §1.11.
- **Long tasks on iPhone** (running more than 2 minutes): one Live Activity whose text is the T2 line; the Dynamic Island's compact leading slot shows the member's face. It ends with the outcome sentence.
- **No app-icon badge, anywhere.**
- **Ref:** Linear's "Cursor Agent needs input: Which repository…?" (`ios/22`); Claude Dispatch (`ios/21`); Live Activities (`ios/24`).

---

### 2.4 Research

#### R1 · The plan gate (F2)
- **Trigger:** `/research`, or the model choosing research.
- **Feedback:** if the request is ambiguous, one clarifying question first (T5 shape). Then a plan card:
  - Title: "Research plan".
  - The questions Alevr will answer, each an editable row (click to edit in place; ⌫ on an empty row removes it; "Add a question").
  - **Sources:** rows for Web, and each connected app that can be read (read-only, stated as "Drive · read-only"), plus "Prioritise sites…" and "Only these sites…" fields.
  - The estimate: "About 6 minutes" (`ink-3`).
  - **Start research** (`ink-1` filled) and **Not now** (ghost).
- The gate waits indefinitely. Typing in the composer refines the plan ("also look at the EU"): the plan updates in place and each changed row carries a `surface-2` highlight that fades over `emphasis`.
- **Keys:** with focus in the card, ⌘Enter starts. Reading is not consequential, so no arming delay.
- **Ref:** Gemini's Edit plan / Start research; ChatGPT's editable plan with source scoping ([web §2.9]); Perplexity's clarifying question (`ios/14`). **Alevr differs:** the plan is edited in place and by typing in the composer, and source scope is part of the plan.

#### R2 · Progress (F1)
- One line: "Reading 14 sources · 3 of 5 questions answered" (T2 rules).
- The disclosure lists each question with its state, and the last five sources read (favicon, domain, title).
- After 20 s: an `ink-3` line, "You can leave. Alevr will let you know when the report is ready."
- **No** percentage bar, no source-count odometer, no auto-scrolling step list.

#### R3 · Steering a run (F1)
- A message sent during a run is added to the research: the receipt under it reads "Added to the research". The plan updates in place.
- **Answer now** (a text button on the progress line) stops reading and writes the report from what has been read.
- **Stop** (T10) ends the run and keeps the sources read so far.

#### R4 · The report (F2)
- On completion, the card's result is a Library document card (A1): title, "12 min · 38 sources · 5 of 5 questions" in `ink-3`, and the first paragraph. **Open report** opens it in the artifacts panel (§2.5) at reading width with a table of contents. The trace lives in the document's Activity section, behind a disclosure.
- Completion follows T9 (reward only if on screen) and T11 (notification if away).
- Citations follow M6, including the audit line.
- **Ref:** Dia's editorial brief (`web/research-report__dia.png`); ChatGPT's full-screen report with table of contents and activity history ([web §2.9]).

---

### 2.5 Artifacts panel

A deliverable (document, deck, sheet, design, app) is a Library item with its own owner, project, immutable versions and lifecycle (PRODUCT_REFOUNDATION §10). In a chat it appears as a card; opened, it docks beside the chat.

#### A1 · The inline card (F1)
- A `surface-1` card, radius 12: the type's mark (its own colour) at 20 px, the title in `ink-1`, and "Document · v3 · edited 2 min ago" in `ink-3`. While being written: the title and a live line, "Writing section 3 of 5".
- Hover: one tone step on `fast`. No lift, no shadow. Click opens the panel (A2).
- **Ref:** Claude's deliverable card (`ios/30`); Mistral's document card (`ios/13`).

#### A2 · Open (F2)
- **Layout:** on windows 1200 px or wider, the panel docks to the right at the person's last width (default 50%). Between 768 and 1199 px it replaces the transcript, with "← Chat" at its top left. On phones it is a full-screen sheet.
- **Motion:** a View Transition from the card to the panel's header (`slow`, `out-expo`) where supported; otherwise the panel enters with opacity and a 16 px slide from the right on `slow`. The transcript column glides to its new position with framer `layout="position"` on `spring.layout`; its text reflows once, at the start, rather than animating width.
- **Focus** moves to the document's title (a heading), so screen readers land on it. The URL gains `?a={id}`, so Back closes the panel and the link can be shared.
- **Keys:** ⌥⌘\ toggles the panel on the web; ⌥⌘I (the system "Show Inspector") and ⌥⌘\ on the Mac.
- **Reduced:** 160 ms cross-fade; the transcript snaps.
- **Native:** Mac: an inspector column (`.inspector(isPresented:)`); iPad: the third column; iPhone: a large sheet with the chat visible behind it, opened by `.navigationTransition(.zoom(sourceID:in:))` from the card.
- **Ref:** Cursor's docked document pane (`web/artifacts__cursor.png`); Claude's artifact sheet over the chat (`ios/31`); Figma's return to fixed panels on 2024-10-10 ([premium §2.9]). **Alevr differs:** the panel docks rather than floats, and the link is part of the URL.

#### A3 · Close (F2)
- Esc (focus inside the panel, no inner layer open), the × button, Back, or the shortcut. The panel leaves on `exit` (opacity with an 8 px slide); the transcript glides back on `spring.layout`. Focus returns to the card that opened it.

#### A4 · Resize (F1)
- A handle between the columns: 8 px hit area, `col-resize` cursor on the web (none on the Mac, per its conventions). It follows the pointer one-to-one. Snap points at 40, 50 and 60% (the Mac trackpad plays `.alignment` at each). Double-click resets to 50%. Minimums: transcript 420 px, panel 480 px. The handle is focusable; ←/→ move it in 5% steps. The width persists per person.

#### A5 · Versions (F1)
- The panel header shows "v3 ⌄" in `ink-2`. Its menu lists versions: "v3 · Mira · 2 min ago", "v2 · You · 1 h ago"; the current one checked.
- Choosing an earlier version shows it read-only with a bar across the top: "Viewing v2 · Restore as v4 · Back to latest". Restoring creates a new version; versions are never overwritten.
- Switching is instant (at most a 120 ms cross-fade). ⌥[ and ⌥] step versions when the panel has focus.
- While a new version is being written, the document updates live under M2's rules and the header reads "v4 · Writing…". Editing is paused meanwhile. Afterwards, **Show changes** marks insertions with a `surface-2` underline and deletions struck through in `ink-3`.

#### A6 · Point to revise (F1)
- Hovering an element in the preview draws a 1 px `ink-2` outline on `fast` and a small **Revise** button at its corner. Clicking inserts a token for that element into the composer ("[Pricing table in Section 2]") and focuses the composer.
- Keyboard: **Revise…** in the panel toolbar enters pick mode; ↑/↓ move between elements; Enter picks; Esc leaves pick mode.
- **Ref:** ChatGPT's "point at a specific part of a supported preview" ([web §2.7]).

#### A7 · Share (F2)
- **Share** is the panel's one primary toolbar verb (an `ink-1` text button with its glyph). It opens a dialog:
  - a preview of exactly what the recipient will see;
  - access: "Only people you add" · "Anyone at Acme with the link";
  - a people field (tokens);
  - one sentence stating the result: "Only the 3 people you add can open it. They can't edit.";
  - **Copy link**, which morphs to "Copied" in place (`IconSwap` plus a label swap at a fixed width), and **Share** when people were added (sending invitations is the person's own explicit action, so the click is the approval).
- **Ref:** Claude's share/publish split and Dia's quiet Share ([web §2.14]).

#### A8 · Publish (F2) — floor action
- **Publish…** sits in the panel's ⋯ menu. Its dialog shows the URL (editable slug), the version to serve (default latest), "Anyone on the internet can see this version", and the verb **Publish v3**, which arms after `approvalArm`.
- After publishing, the dialog shows the receipt, "Published v3 · juno.page/acme-renewal · Copy link", and the panel's subtitle reads "Published v3" as text.
- The Publish menu then offers **Update to v4**, **Roll back…** and **Unpublish**. Unpublish narrows exposure, so it applies at once with Undo for `undoWindow`.
- On iPhone, publishing is a sheet (T7).
- **Ref:** ChatGPT Sites' versioned deployments; Grok's "Not Published Yet" as text (`ios/32`).

#### A9 · Export, duplicate, download (F1)
- In the ⋯ menu. Export lists the formats for the type (Docs: Word, PDF, Markdown; Slides: PowerPoint, PDF; Designs: PDF, HTML, .zip). The item shows its pending state after `showDelay`. The file goes to the browser's download, the iOS share sheet, or a Mac save panel.

#### A10 · An app that errors (F1)
- A line inside the panel, not a toast: "This app hit an error: TypeError: rows is undefined · Fix it". **Fix it** inserts a token for the error into the composer and focuses it; the person sends.
- **Ref:** Claude's "Try fixing with Claude" ([web §2.7]). **Alevr differs:** the error arrives as a token the person can still edit around before sending.

---

### 2.6 Sidebar

Structure is PRODUCT_REFOUNDATION §4.1. The sidebar sits one tone step dimmer than the content ([premium §6.1-3]). Rows are plain text, 32 px tall on desktop, with no per-row icons except agent faces and project marks, no timestamps, no counts on rows, and no dividers.

#### S1 · Rows: hover, press, selection (F1 / F0)
- **Hover:** `surface-2` fill on `fast`. **Press:** one tone deeper while held, no scale. **Selected:** the `selected` fill with `ink-1` text; inactive rows are `ink-2`.
- **Selection is F0:** clicking a row switches the thread instantly (M21).
- **Keys:** with focus in the sidebar, ↑/↓ move a roving focus (no animated highlight), Enter opens, → / ← expand and collapse a section, ⇧F10 or the context-menu key opens the row menu. ⌥↑ / ⌥↓ go to the previous and next chat from anywhere **(proposal, the Slack convention)**.
- **Native Mac:** `List` with sidebar style inside `NavigationSplitView`; no hover highlight (system behaviour).

#### S2 · New chat (F0)
- ⌘⇧O on the web (browsers reserve ⌘N), ⌘N natively, or the New chat row. The empty home appears instantly with focus in the composer. The new chat's row appears in Recent only after its first send, at the top, pushing others down with `spring.layout`.

#### S3 · The AI title arriving (F2)
- A new chat's row first shows its first message, truncated. When the generated title arrives, the text cross-fades on `slow` (`JunoMotion.slow`). The row does not move.

#### S4 · Rename inline (F1)
- **Trigger:** double-click the title, **Rename** in the row menu, or F2 on Windows.
- **Feedback:** the title becomes a text field in place at the same font, size and padding, so nothing shifts, with all text selected. Enter or blur commits; Esc restores. An empty title reverts. The change is optimistic.
- **Failure:** the old title returns and the row's tooltip reads "Couldn't rename · Try again".

#### S5 · Drag (F2)
- **Trigger:** a press that moves `dragThreshold` (4 px) on a row; on touch, a long press.
- **Feedback:** the row lifts: it follows the pointer one-to-one at 90% opacity with a two-layer shadow (the only shadow in the sidebar, and only while dragging). Valid targets (Pinned, a project) take a `surface-2` fill and a label, "Move to Acme". An insertion indicator (a 2 px `ink-1` line between rows) shows where it will land in Pinned. The list scrolls when the pointer nears its edges.
- **Drop:** the row settles into place on `spring.layout`. **Esc** cancels and the row returns to its origin on `spring.layout`.
- **Keyboard path:** the row menu's **Move to…** and **Pin**; in Pinned, ⌥⌘↑ / ⌥⌘↓ reorder.
- **Native:** iOS `.draggable` / `.dropDestination`, with `.impact(weight: .light)` when the lift is recognised; the Mac plays `.alignment` when the insertion point changes.

#### S6 · Collapse and resize (F0 / F1)
- ⌘\ on the web; ⌃⌘S (the system "Toggle Sidebar") with ⌘\ as an alias on the Mac. The sidebar collapses on `base` with `ease-drawer`, as a CSS transition so a second press reverses it mid-way. From the keyboard it still moves (spatial consistency) but is capped at 200 ms. **Reduced:** instant.
- The resize handle follows the pointer one-to-one between 220 and 360 px, snaps to 260 (Mac `.alignment`), and double-click resets it.

#### S7 · Needs you (F2)
- The fold exists only when non-empty. A new row fades in on `base` while existing rows move with `spring.layout`.
- Each row names who and what: the face (20 px, static) and "Mira wants your answer on the Acme renewal", with "wants your answer" in `attention`. No count badge, no dot. The fold's header carries a count in `ink-3` only when there are more than three rows ("Needs you · 5").
- Clicking a row opens the chat, scrolls to the card and focuses its first control.
- A resolved row leaves on `exit`; the rest close the gap on `spring.layout`.
- **A11y:** the row's arrival is announced politely once.
- **Ref:** Cursor's "READY FOR REVIEW 5" grouping (`web/thinking__cursor.png`, [premium §2.14]).

#### S8 · Orbit rows (F0)
- Face (20 px, static, its colour following P1), name in `ink-1`, and one "now" line in `ink-3`: "Drafting the renewal summary", "Free", "Paused". The words carry the state; the face never loops here.
- The section header opens the roster.

#### S9 · Row menu and delete (F2)
- ⋯ on hover or focus (always visible on touch), right-click, or the context-menu key: Rename, Pin, Move to…, Branch, Delete.
- **Delete** moves the chat to Trash at once and shows a toast, "Chat deleted · Undo", for `undoWindow`. Permanent deletion happens only from Trash, behind a confirm dialog with the verb "Delete forever".

#### S10 · The bell (F1)
- The record of past events lives behind a quiet bell in the sidebar header. When unseen records exist, the bell's glyph is its filled form; after the popover is opened it returns to outline. **No dot, no count.**

---

### 2.7 Menus, popovers, tooltips, dialogs, sheets, toasts

| ID | Surface | Opens | Closes | Keyboard-opened | Focus | Notes |
|---|---|---|---|---|---|---|
| O1 | **Menu** | `base`, scale 0.96 → 1 + opacity, origin at the trigger (`--radix-dropdown-menu-content-transform-origin`) | `exit` | Instant, first item focused | Trapped; returns to the trigger | Typeahead; `menuitemcheckbox` for switches; submenus open on → or after a 100 ms hover along the safe triangle. |
| O2 | **Popover** | `base`, from the trigger | `exit` | Instant | Moves to the first control | Retargets with `spring.standard` if reopened while closing. |
| O3 | **Tooltip** | After `tooltipDelay` (300 ms): `fast`, a 2 px drift from the trigger and scale 0.97 → 1. Later tooltips within `tooltipSkip` (400 ms): instant, no animation (`data-state="instant-open"` → `transition-duration: 0ms`) | `exit` | On focus, after the same delay | Never takes focus | Never the only label: icon buttons always have `aria-label`. No tooltips on touch. |
| O4 | **Dialog** | `base`: scale 0.97 → 1 + opacity, centred; scrim opacity on `base` | `exit` | Instant | Trapped; starts on the first sensible control (never on a destructive verb); returns to the trigger | Esc closes unless the dialog holds unsaved input, in which case Esc asks "Discard changes?" inline. |
| O5 | **Sheet (web, mobile widths)** | `slow` on `ease-drawer`, from the bottom | `exit` | n/a | Trapped | Drag follows the finger one-to-one; dismisses on velocity (> 0.11 px/ms) or past half height; damped past the top; a drag starts only at scroll-top, with a 100 ms guard after scrolling (Vaul). `overscroll-behavior: contain`. |
| O6 | **Toast** | `base`, from the bottom-right on desktop and the top on mobile web | `exit` | n/a | Reachable with ⌥T; never takes focus | Sonner: `toastLife` 4 s, pauses on hover and on a hidden tab, 3 visible, 14 px gap, swipe to dismiss at 45 px or 0.11 px/ms. **Only** for events outside the current view (an agent needs you in another chat, a background task finished) and for Undo after a deletion. **Never** for copy, save, send or anything the person just watched happen. |
| O7 | **Command palette (⌘K)** | Instant | Instant | Instant | Field focused; returns on close | Results update without animation; the highlight moves without animation; Enter opens; ⌘Enter opens in a new window; recents first when empty. |
| O8 | **Hover card** (citations, tokens in sent turns, agent faces in the sidebar) | After `hoverCardOpen` (300 ms), `base`, from the trigger | After `hoverCardClose` (150 ms) grace, `exit` | Click or Enter pins it | Focus moves in only when pinned | Moving the pointer into the card keeps it open. |

**Native.** Menus are `Menu` / `NSMenu`; popovers `.popover` / `NSPopover` (which may extend past the window on the Mac); dialogs are alerts or sheets; sheets use `.presentationDetents([.medium, .large])` with `.presentationDragIndicator(.visible)`. There are **no toasts on iOS**: background events use system notifications, and Undo after a deletion uses a transient glass bar above the composer or tab bar for `undoWindow` (the one toast-like element).

**Ref:** Radix Tooltip and Dialog behaviour; Sonner source constants; Vaul ([micro E1–E6]).

---

### 2.8 Model popover

#### MP1 · Open (F2 / F0)
- From the composer label (C17): a popover anchored to the label, 320 px wide. Pointer: `base` pop from the label. Keyboard (`/model`, or Enter on the focused label): instant.
- **Contents, top to bottom:**
  1. **Auto** · "Picks the right model for each message".
  2. The person's favourites.
  3. The four or five current best models, each with its short name in `ink-1` and one line in `ink-3` saying what it is good at ("Fastest for everyday questions", "Best for long, careful work"). A model that uses much more of the person's allowance says so in words at the end of its line: "· uses more of your limit". No bars, no prices, no context sizes here.
  4. **Effort:** a segmented control, Light · Standard · Deep, under the list.
  5. **All models…**
- The current model is checked.

#### MP2 · Choose (F1)
- Clicking a row selects it, closes the popover at once, and cross-fades the label (C17). ↑/↓ move, typing jumps by name (typeahead), Enter selects.
- A model change inside an existing chat leaves one `ink-3` line in the transcript at that point: "Switched to Opus Deep". The chat header's subtitle records the model of the latest reply.

#### MP3 · Effort (F1)
- The segmented thumb moves on `spring.standard`; ←/→ move it with focus on the control. Changing effort does not close the popover.
- **Native:** a `Picker` with `.segmented` style inside the menu or popover; iPhone plays `.sensoryFeedback(.selection)` on each change.

#### MP4 · All models (F2)
- A dialog (web and Mac) or large-detent sheet (iPhone): a provider rail, then each model's full specifications (context window, modalities, speed, intelligence, price). Grades that are estimates are labelled "estimate" or not drawn (audit R8). **Make default** sets the default for new chats.
- **Ref:** ChatGPT's model guide, three models with one-line purposes (`web/model-picker__chatgpt.png`).

#### MP5 · Model for one message (F2)
- Long-press (touch) or right-click (pointer) on the armed send button opens **Send with…**: the favourites and Auto. Choosing one sends this message with that model only; the label does not change.
- **Ref:** ChatGPT iOS long-press on Send (2026-06-08, `research/openai.md`).

**Native.** iPhone uses a native `Menu` from the label (Copilot's and Meta AI's shape, `ios/08`, `ios/09`): Auto, favourites and current models with subtitles, then the effort `Picker`, then "All models…". **Ref and slop:** the menu replaces spec-sheet pickers and the AI Elements context meter (`web/model-picker__ai-elements-context.png`). **Alevr differs:** Standard effort is invisible in the label, and model changes leave a line in the transcript so history records which model answered.

### 2.9 Agent faces in Orbit: states and transitions

> **Superseded in part by DECISIONS D-032 (2026-10-01).** Agents are now cute, premium 3D characters with deep customization. The state contract below (six states, words always present, event-driven transitions, P3 attention, P4 pointer gaze and event blinks, P6 arrival) still applies. What changes: faces may be characters with personality (accessories, expressive eyes, reactions such as a small happy bounce when thanked); the large character in a member's own thread may carry a subtle idle (breathing/sway, occasional blink) that stops when the tab is hidden or Reduce Motion is on; small faces (≤ 28 px) stay still sprites.


A face supports the **state contract** and is also an original customizable character under D-032–D-034. Use the short-flocked designer-toy direction in [Orbit's system](brand/ORBIT_SYSTEM.md), not a Grok Bot derivative. State remains readable words; appearance never determines runtime state. The state semantics below still apply, with D-032's limited visible-large-character idle exception and reduced-motion rules.

`FaceState = available | thinking | working | waitingForYou | paused | offline`

#### P1 · The states

| State | Pose (principle) | Colour | Loop (§1.6) | The words (always present) |
|---|---|---|---|---|
| `available` | Neutral, at rest | `ink-2` | Never | The last thing done: "Finished the Acme summary · 10 min ago", or "Free" |
| `thinking` | Attention inward (the elements gathered or looking aside) | `primary` | Only at ≥ 32 px in the focused context, `breathe` 2400 ms, subtle | "Mira is thinking" |
| `working` | Attention on the work (the elements aligned, purposeful) | `primary` | As `thinking` | "Mira is drafting the renewal summary" (the task's T2 line) |
| `waitingForYou` | Facing the viewer, open | `attention` | Never | "Mira needs your answer on the Acme renewal" |
| `paused` | At rest, dimmed to 60% | `ink-3` | Never | "Paused · Resume" |
| `offline` | Outline only | `ink-3` | Never | "Offline · last active 2 h ago" |

- **Sizes:** 16 px (inline in live lines), 20 px (sidebar rows, tokens, card headers), 32 px (thread header), 64 px (roster card, profile).
- **Removed** everywhere: the radial halo, the conic sheen, gradient washes behind faces, the bottom-edge light sweep on busy cards, idle breathing, and blinking or glancing on timers (crew audit §3.2-1 to -4).
- **Derivation:** the face shows the most urgent state across all of the member's tasks: `waitingForYou` > `working` > `thinking` > `paused` > `available` > `offline` (fixing the audit's newest-session-only bug, crew audit §3.1-2).

#### P2 · Changing state (F1)
- Any state to any state: the pose morphs on `spring.standard` (× 0.75 on the Mac) and the colour cross-fades on `base`. The words change on `fast`, held at least `phaseMinHold`.
- **Settling** (`working` → `available` after a task completes) is the same morph; it is not a celebration. The celebration, if any, belongs to the result (T9).

#### P3 · Attention: turning toward you (F2)
- When a member enters `waitingForYou` **while its face is on screen**, it turns toward the person once: `spring.emphasized`, then still. It never repeats, never loops, and plays only on the most recently changed face if several change at once. Off screen, the notification carries it (T11).
- **Reduced:** a 160 ms cross-fade to the waiting pose.

#### P4 · Attention to the person (F1) — owner-directed, event-driven only
The owner asked for faces with real presence ("blink, subtly track attention, respond to pointer proximity, become more attentive when waiting, visibly settle while working", calm, no Tamagotchi). Everything here is triggered by an event; nothing runs on an idle timer.
- **Gaze (pointer proximity):** on faces ≥ 28 px (thread header, roster, profile, setup sheet), the eyes (or the drawing's equivalent element) may follow the pointer within a small range (≤ 1.5 px at 32 px, scaled) on `spring.interactive` while the pointer is within ~160 px of the face, easing back to centre when it leaves. Never in the sidebar, tokens or lists (16–20 px faces stay still).
- **Blink:** a single blink is allowed as *punctuation for an event*: when the face first appears in view, when its state changes, when the person starts typing in that member's thread, or when the pointer arrives over the face. Never on a repeating timer; at most one blink per 4 s per face.
- **Working settle and thinking:** the `thinking`/`working` motion from P1 (≥ 32 px, focused context only) is a slow, low-amplitude movement that reads as concentration, and it stops when the run stops.
- **Waiting:** P3's single turn toward the person, then a still, slightly more open pose. No repetition.
- **Reduced motion:** no gaze, no blink, no working motion; state changes cross-fade on 160 ms.
- **Mac native:** gaze uses `onContinuousHover` on the header and profile faces only; iOS has no gaze (no pointer) but keeps the event blink and P3.

#### P5 · Accessibility
- The face is decorative (`aria-hidden`); the words are the state. Where a face stands alone (roster grid), it has `role="img"` with the label "Mira, working on the renewal summary".

#### P6 · Arrival (F3)
- A new agent's face appears once, on the roster and in its sidebar row: scale 0.9 → 1 with opacity on `emphasis` / `out-expo`. Nothing else about it moves.

**Native.** `JunoAgentFace` renders the same contract; `JunoAgentPresence`'s `RadialGradient` and `AngularGradient` are removed; the thread bar uses system materials. **Ref:** Cursor's and Claude Code's state words ([premium §2.2, §2.14]); the crowded "AI with a face" space (OpenAI dots 2026-09-29, Superhuman Hero, Notion's face; `web/crew__notion.png`). **Alevr differs:** the face mostly moves in response to events, with D-032's visible-large-character idle exception; it always has readable state words.

---

### 2.10 Library

#### L1 · The grid (F1)
- Cards in a grid with a 220 px minimum column: a rendered preview thumbnail (`surface-1`, radius 10), the title in `ink-1`, and "Document · edited 2 d ago" in `ink-3`, with the owner's face (16 px) when an agent made it. A list view shows the same fields as 40 px rows.
- **Hover:** one tone step on the card on `fast`. The thumbnail does not zoom; the card does not lift.
- **Keys:** the grid is `role="grid"` with a roving focus; arrow keys move, Enter opens, **Space opens Quick Look** (L2), ⌘⌫ (Mac) or Delete (Windows) moves to Trash, ⌘A selects all. ⌘-click and ⇧-click multi-select; on touch, long-press enters selection mode.

#### L2 · Quick Look (F2)
- Space on a focused card opens a large preview dialog with a View Transition from the card (`slow`, `out-expo`). ←/→ move to the next and previous items; Space or Esc closes it along the reverse path.
- **Reduced:** 160 ms cross-fade.
- **Ref:** the Finder's Quick Look; `QLPreviewPanel` on the Mac itself.

#### L3 · Open (F2)
- Enter or click opens the item in the artifacts panel from a chat, or at `/a/{id}` from the Library, with a View Transition from the thumbnail to the page header. iPhone: `.navigationTransition(.zoom(sourceID:in:))`.

#### L4 · Filter and search (F0)
- A type menu (All, Documents, Decks, Sheets, Designs, Apps, Files), an owner menu and a project menu, plus a search field that filters as you type with no animation. No results: "Nothing matches 'acme'. Search your chats instead ↵".

#### L5 · Adding files (F2)
- Dropping files anywhere on the Library page shows "Drop to add to Library" (C5's overlay). New cards appear at the start of the grid with their upload track (C6); existing cards move on `spring.layout`. No stagger.

#### L6 · Empty and first population
- Empty: one sentence, "Everything Alevr makes and every file you add lives here.", and one action, **Upload files**. No illustration.
- The first time the Library fills (F3 allowlist), up to the first 6 cards may stagger in at 40 ms.

#### L7 · Delete
- Moves to Trash with the toast "Moved to Trash · Undo" for `undoWindow`. **Delete forever** exists only in Trash, behind a dialog whose verb is "Delete forever" in `danger`.

---

### 2.11 Customize: apps, skills, routines

Customize is a native `Form` on Apple platforms and a single 640 px column on the web: each row is a label, a one-line description and a control on the right. **Changes apply instantly; there is no Save button** ([web §2.13], [ios §3.10]).

#### K1 · The apps directory (F1)
- A curated first page: rows with the app's mark (28 px, its own colour), name, one line on what Alevr can do with it, and on the right **Connect**, or "Connected" in `ink-3`. Search filters instantly; the long tail (Composio) appends below "Searching more apps…" after `showDelay`.
- Provenance is written as text ("Built by Linear", "Community"), never as a "Verified" or "Beta" pill.

#### K2 · Connect (F2)
- **Trigger:** **Connect** on a row or app page.
- **Feedback:**
  1. The web opens the provider's sign-in in a centred 520 × 680 popup; native uses `ASWebAuthenticationSession`.
  2. The row reads "Connecting… finish in the window that opened · Cancel" (`ink-2`).
  3. On success the row's text cross-fades on `fast` to "Connected as liam@acme.com", and the app's page opens at "What Linear can do", showing the default policy (reads: Allow; changes: Ask). Focus goes to that heading. Announced: "Linear connected".
- **Failure:** a blocked popup: "Your browser blocked the sign-in window · Open it" (opens in the same tab with a return URL). Cancelled or denied: "Linear wasn't connected: the sign-in was cancelled · Try again". No answer within 5 minutes: back to **Connect**.

#### K3 · Connect from a token (F2)
- **Connect Linear** in a token's popover (C10) runs K2 without leaving the chat. On success the token's mark returns to full opacity on `base`, the popover shows the connected summary, and the draft is untouched.

#### K4 · Per-action policy (F1)
- Each action group on an app page has a segmented control, **Allow · Ask · Off**, whose thumb moves on `spring.standard`.
- Actions on the always-confirm floor show no control, only the words "Always asks" and, on hover, why.
- **Narrowing** (toward Ask or Off) applies at once and shows "Changed · Undo" beside the control for `undoWindow`.
- **Widening** (to Allow on an action that changes things) opens a confirm popover from the control: "Let Alevr create Linear issues without asking?" with the verb **Allow without asking** and **Cancel**. The verb arms after `approvalArm`.
- **Who can use it** (you, and which agents) follows the same narrowing and widening rules.

#### K5 · Disconnect (F2)
- **Disconnect Linear** (`danger` text button) opens a dialog that states the consequences ("Mira's routine 'Triage bugs' will stop working") with the verb **Disconnect**. No undo; the dialog notes that reconnecting is possible.

#### K6 · Skills (F1)
- Each skill row: name, what it does, its origin ("by Linear · commit a1b2c3"), and an enable switch that applies at once (the skill appears in the `/` palette immediately).
- Installing from a URL or package opens a trust sheet: source, author, commit, what it can access, which apps it needs, which surfaces it works on. The verb is **Install {name}**; it is a widening, so it arms.
- An available update is a line of text in the row, "Update available · v1.3 → v1.4 · What's new". No badge. Updating is always explicit.

#### K7 · Routines (F1)
- Schedules are written as prose with the next run: "Every weekday at 08:00 · next Thursday 08:00". A switch turns a routine off; editing opens a sheet.
- **Ref:** Raycast automations (`web/routines__raycast.png`).

---

### 2.12 Code workspace

Alevr Code shares the composer, trace, approval and panel behaviour above. This section covers what is specific to it. The runtime behaviour is `CODE_AGENT_SPEC.md`; this is how it looks and responds. Code uses the dark appearance's register by default (the Instrument direction's remit, [premium §7.3]), with the same rules.

#### X1 · The context row (F0)
- Above the field, one quiet `ink-2` line: repository · environment · mode, for example "juno · this Mac · Code". The mode is a segmented control, **Ask · Plan · Code**. The keyboard path is `/ask`, `/plan` and `/code` (C11); there is no chord, because ⇧Tab must stay focus navigation in a GUI.

#### X2 · The goal row (F1)
- Docked to the composer's top edge (the dock, §2.1) while a goal exists. Text only (CODE_AGENT_SPEC §2.8):
  > **Goal** Make the settings menu open on click and keyboard · 2 of 3 criteria · 38 min · turn 7 · $1.12
  > Checking: c2 has no Preview evidence yet · **Pause** · **Edit** · **Clear**
- Numbers are tabular with numeric transitions. While `working`, the row's edge carries the owner-approved glow (§1.6 item 3); otherwise it is still.
- `needsYou`: the second line starts with the reason, its key words in `attention`, and the first action becomes **Resume** or **Keep going**.
- Achieved: "Goal met in 52 min · 11 turns · $2.40 · Clear". The change to met settles on the `reward` spring if the session is on screen.
- Clicking the row opens the goal sheet.

#### X3 · Step rows (F1)
- M5's rules, with code objects: "Read SettingsMenu.tsx", "Searched for `onOpenChange` · 6 results", "Edited SettingsMenu.tsx +12 −3" (the counts in `data-add` / `data-remove` text). Clicking an edit opens that file in the diff (X4).
- A running command shows the command in monospace and its last three output lines in `ink-3`, collapsed into the terminal (X5) when it finishes: "Ran `npm test` · passed · 38 tests · 9 s".
- A verbosity setting (Verbose · Normal · Summary) controls how many step rows show ([premium §2.2], Claude Code desktop).

#### X4 · The diff (F1)
- An inspector tab, **Changes**: a file list (path, then +/− counts in tabular `data-add` / `data-remove` text) and the selected file's diff, unified or split (a remembered toggle).
- **Keys:** ⌥↓ / ⌥↑ next and previous hunk; ⌥⌘↓ / ⌥⌘↑ next and previous file **(proposal)**.
- **Comment on a line:** a `+` appears in the gutter on hover or focus; clicking opens a field; submitting inserts a token for the location ("[SettingsMenu.tsx:41]") and the comment into the composer.
- **Revert file** applies at once (the workspace keeps a snapshot) with Undo for `undoWindow`. **Commit, push and opening a PR are approvals** (X6).
- Files over 1000 changed lines render collapsed: "Large diff · Load".
- **When it appears:** the inspector opens by itself on the first edit only if the window is at least 1280 px wide and the person has not closed it in this session. Otherwise the transcript shows "3 files changed · Show changes". It docks on `spring.layout`.

#### X5 · The terminal (F1)
- Output streams with M17's follow rules (at the bottom, follow; wheel up escapes). Monospace 12.5 px; ANSI colours mapped to the token palette. Selecting copies nothing until ⌘C.
- A long-running process shows as a line: "Running `pnpm dev` · 4 min · Stop". Words, no dot.
- With focus in the terminal, ⌃C sends an interrupt and ⌃L clears. ⌘K keeps its global meaning (search) everywhere, including here.
- Output beyond the spill limit: "Output continues in a log file · Open".

#### X6 · Command and change approvals (F2)
- T6's card with code content: "Alevr wants to run" and the full command in a monospace block (wrapped, never truncated), its working directory, and the model's one-line reason. Risk is stated in words: "Changes files outside the repository" in `danger` text when true.
- **Actions:** **Run once** (the verb); its split caret offers **"Always allow `npm test` in this repository"**, which writes the exact rule (DECISIONS D-019); **Not now**; **Tell Alevr what to do**.
- Digest-bound, arming after `approvalArm`, never decaying into a denial: an unanswered approval parks the session as needing you and reminds at 15, 60 and 240 minutes (CODE_AGENT_SPEC §1.11).
- Notification actions **Allow once** and **Decline** carry `authenticationRequired`. "Always" exists only in the app, where the rule it writes can be read.

#### X7 · The inspector (F0)
- Tabs appear only when useful: Changes, Files, Terminal, Tests, Preview, Git, Computer. Switching tabs is instant. ⌥⌘\ toggles the inspector on the web; ⌥⌘I on the Mac.

#### X8 · Preview while Alevr drives (F2)
- While Alevr drives the Preview, the pane's edge carries the glow (§1.6 item 3) and its toolbar subtitle reads "Alevr is using the preview · Stop". Esc in the pane stops agent control. Any real input from the person pauses the agent: "You took over · Resume".
- State is words in the toolbar subtitle: "Running `pnpm run dev` in apps/web on :3000". The floating status capsule and shield badges are removed (CODE_AGENT_SPEC §4.7).

#### X9 · Screen control on the Mac (F2)
- One plain row at the top of the thread: the last frame's thumbnail, "Alevr is using Safari", **Stop** and **Take over**. On screen: a click-through glass caption under the menu bar, "Alevr is using TextEdit · Esc to stop", and the glow outline on the target window.
- **Esc anywhere stops screen control.** This is the one place Esc stops an agent, because it is a safety control (CODE_AGENT_SPEC §3.7).

#### X10 · The run report (F1)
- The final row, text only (CODE_AGENT_SPEC §1.10): outcome, What changed, Checked, Not checked, Left. It enters on `base`. "Checked" rows render only from the ledger. A run longer than 60 s that ends checked, on screen, settles its outcome line on `reward`.

**Ref (Code):** Cursor's grouped agent list with state sentences and diff counts (`web/agent-progress__cursor.png`, `web/artifacts__cursor.png`); ChatGPT's goal row (`web/composer__chatgpt-goal.png`). **Alevr differs:** the goal row, queued messages and needs-you rows share one dock, and approvals from notifications require an unlocked device.

---

### 2.13 Mobile gestures

**iOS and iPadOS (primary).**

| ID | Gesture | Where | Result | Feedback |
|---|---|---|---|---|
| G1 | Edge swipe from the left | Any pushed view | Back (system, interactive, cancellable). Never overridden. | System |
| G2 | Row swipe | Search tab history, Library list | Leading full swipe: **Pin**. Trailing: **Delete** (to Trash; the undo bar shows for `undoWindow`) and **More**. Destructive actions fire on release, never at the threshold. | `.impact(weight: .light)` when the leading swipe crosses its commit threshold, during the gesture |
| G3 | Long-press | A message | Context menu with preview (M24) | System |
| G4 | Drag down on the transcript | A thread with the keyboard up | Dismisses the keyboard interactively (`.scrollDismissesKeyboard(.interactively)`); the composer rides the keyboard's edge. A tap on the transcript also dismisses it. | None |
| G5 | Drag the grabber | Sheets | Medium ↔ large detents; down to dismiss. A sheet holding unsaved input sets `interactiveDismissDisabled` and asks "Discard draft?" in an action sheet. | System detent haptic |
| G6 | Scroll down | Chat, Orbit and Code roots | The tab bar minimises (`tabBarMinimizeBehavior(.onScrollDown)`). A live voice session, or the most urgent running task's T2 line, sits in `tabViewBottomAccessory` and folds inline when the bar minimises. **Inside a thread the tab bar yields to the composer**, so there is only ever one glass layer at the bottom. | None |
| G7 | Long-press the armed send | Composer | **Send with…** (MP5) | `.selection` on choice |
| G8 | Long-press a token | Composer | Token popover (C10) as a medium sheet | System |
| G9 | Pinch, double-tap, swipe down | Image lightbox | Zoom; toggle zoom; dismiss, following the finger and dismissing on projected velocity | None |
| G10 | Pull to refresh | Library and Search lists only | Refresh (`.refreshable`). Never on a chat. | System |
| G11 | Press and hold the voice button | Composer | Hold to talk: speak while held, release to send the utterance **(proposal)**. A tap opens the voice session (C16). | `.start` on press, `.stop` on release |
| G12 | Swipe left on a dock row | Composer dock | Removes a queued message (C14) | None |

**Web on phones.** Sheets follow O5 (Vaul). Toasts swipe away (O6). **No custom horizontal swipes on the transcript**, because they fight the browser's own back gesture. Long-press uses `longPress` (450 ms) with `contextmenu` as the trigger where the platform provides it.

**Gesture physics (native, from WWDC18 "Designing Fluid Interfaces"):** track the finger one-to-one; wait about 10 pt of movement before committing to a direction; project the end point from velocity with the scroll view's deceleration rate; rubber-band at the edges; keep entry and exit paths symmetric; run candidate gestures in parallel and cancel the losers.

---

### 2.14 Haptics map (iOS; Mac trackpad)

The complete map. Anything not listed plays no haptic. A Alevr setting (Settings › Sounds & Haptics › Haptics, on by default) turns them all off.

| Moment | Feedback | Why |
|---|---|---|
| Model, effort or any picker value changes; a token inserted from the palette | `.sensoryFeedback(.selection, trigger:)` | Apple's documented meaning: values changing. Already used by `JunoThinkingControl`. |
| Dictation or voice starts / ends; hold-to-talk press / release | `.start` / `.stop` | An activity starting and stopping. |
| The person stops a reply | `.stop` | An activity stopped. |
| A long task, research run or goal completes **while its chat is on screen** | `.success` | A notification of an outcome (T9, X2). |
| An approved action completes / fails | `.success` / `.error` | Outcome (T6, T7). |
| A swipe or drag crosses a commit threshold (row swipe, sheet detent, drag lift) | `.impact(weight: .light)`, during the gesture | Light actions fire mid-gesture; destructive ones on release (Rauno Freiberg). |
| Mac: a drag snaps (sidebar width, panel split, insertion point) | `.sensoryFeedback(.alignment)` / `NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)` | The macOS pattern for alignment. |
| Send, copy, an ordinary reply finishing, an approval card appearing, a question appearing | **None** | Avoid overuse; the notification or the screen carries it. |
| While a reply streams | **Never** | Apple: long-running haptics dilute meaning. ChatGPT's streaming haptics are the counter-example (UNVERIFIED). |

**Ref:** Apple HIG, Playing haptics; [micro §2F]; [ios §6-10]. **Alevr differs from [ios §6-10]:** no impact on send and no `.warning` when an agent needs you in the foreground; the face's turn (P3) and the words carry that, and a warning haptic for a routine question would train people to ignore it.

---

## 3. Loading, empty, error, offline and reconnect

### 3.1 The timing rule
Every asynchronous surface follows one rule ([micro §3], Vercel Web Interface Guidelines):
1. For the first `showDelay` (200 ms), show nothing new. Most operations finish inside it and never flash.
2. Then show the pending state. Busy labels end in a real ellipsis character: "Loading…", "Saving…", "Connecting…".
3. Once shown, a pending state stays at least `minVisible` (400 ms) before another status replaces it. Real content replaces it at once.
4. A button keeps its label and width while pending (`Button loading`): the spinner fades in over the invisible label, and the button is `aria-busy` but not dimmed.

### 3.2 Skeletons
- Only where the final shape is known and stable: the sidebar's Recent list on a cold load, the Library grid, an app page, the model catalogue.
- A skeleton mirrors the final layout exactly (same row heights, radii, gaps) in `surface-2`. **Static: no shimmer sweep, no pulse.**
- Never for chat messages. A conversation renders from cache, or shows "Loading conversation…" (`ink-3`) after `showDelay`.
- Skeletons are replaced in one frame, without stagger.

### 3.3 Empty states
One sentence and at most one action. No illustrations, no mascots, no generic suggestions.

| Surface | Copy | Action |
|---|---|---|
| New chat home | A one-line upright Newsreader greeting under D-027, e.g. "What’s next, Liam?", then up to three suggestions **derived from the person's own state**: an agent who needs them, an app just connected, a project touched today. Each is a plain text row with the relevant token mark. When nothing real exists, there are no suggestions. | — |
| Library | "Everything Alevr makes and every file you add lives here." | Upload files |
| Projects | "Projects keep chats, files and instructions together." | New project |
| Orbit roster | "No agents yet. An agent has a role, their own thread, and keeps working when you leave." | Create agent |
| Needs you | Not shown at all when empty. | — |
| Search, no results | "Nothing matches 'acme'." | Search all files ↵ |
| Customize › Apps | The curated directory is the empty state. | — |
| Code sessions | "Start a session on this Mac or in the cloud." | New session |
| Trash | "Trash is empty. Items here are deleted after 30 days." | — |

**Ref:** Grok, ChatGPT, Gemini: one sentence, one composer (`web/home__grok.png`, `ios/01`). Slop: t3.chat's starters, AI Elements' suggestion carousel, Manus's blocking modal (`web/home__t3chat.png`, `web/home__ai-elements-chatbot.png`, `web/home__manus.png`).

### 3.4 Errors
- **Where it happened.** An error appears next to the thing that failed, as one line: what happened, then one recovery verb. Never a red banner across the page, never a toast for an error tied to something visible.
- **Words.** "What happened. What to do." Not "Oops", not "Something went wrong" on its own, no exclamation marks. When the cause is unknown: "Something failed on Alevr's side · Retry", with **Details** disclosing the request ID for support.
- **Colour.** The text is `ink-1`; only the small glyph is `danger`.
- **Retry** is idempotent everywhere.
- The reply-level table is M16; tool failures are M5; upload failures C6; connection failures K2.

### 3.5 Partial failure
When some steps failed but Alevr still answered, the trace shows the failed lines (M5) and the answer says what it could not use in one sentence ("I couldn't open Q3 Forecast.xlsx, so the totals below leave out Q3.").

### 3.6 Offline
- **Detection:** `navigator.onLine`, a failed fetch, or a missed WebSocket heartbeat (15 s). Native: `NWPathMonitor`.
- **Composer:** writing keeps working. The placeholder (C3) says so when empty. Pressing Enter queues the message in the dock: "Waiting for a connection · Send now · Remove". When the connection returns, it sends at once (the person already pressed Enter).
- **Everywhere else:** cached chats, the Library and Customize stay readable. One `ink-3` line in the sidebar footer reads "Offline · showing saved chats". No banner, no modal.
- **Actions that need the network** (connect, share, publish, approve) are disabled with the reason as their tooltip: "You're offline".
- **Back online:** the sidebar line disappears; missed events apply without animation (F0), except new *Needs you* rows, which fade in (S7).

### 3.7 Reconnecting a live stream
1. After `reconnectQuiet` (1 s) of silence on a live stream, the live line (M1) reads "Reconnecting…".
2. The client resumes the stream (AI SDK `resume` / `resumeStream()`). On success the line disappears and text continues where it stopped; nothing else changes.
3. After `reconnectGiveUp` (10 s) the line becomes "Connection lost · Retry" (M16). The partial text stays.
4. **Background tabs:** on `visibilitychange` to visible, the client re-syncs missed events and applies them without animation.

### 3.8 Session expired
- An inline line in the composer: "Your session ended · Sign in again". Sign-in opens in a popup; the draft and the page stay. After signing in, nothing is resent automatically; the person presses Send.

### 3.9 Limits and quotas
- Always the time, never a spinner: "You've reached the limit for Opus. Available again at 14:20" (from `retry-after`, tabular figures), with the alternative as a verb ("Use Sonnet").

### 3.10 Slow first token
- After `slowFirstToken` (10 s) without a first token, the live line adds "· Opus is slower than usual". After 20 s it gains a text button, **Try Sonnet**, which stops this attempt and resends with that model.

---

## 4. Keyboard map

Symbols are macOS; Windows and Linux replace ⌘ with Ctrl and ⌥ with Alt. Bindings use `KeyboardEvent.key` where the letter matters and `KeyboardEvent.code` where the position matters (so they survive non-QWERTY layouts). The shortcuts sheet (⌘/) shows them with platform symbols and non-breaking spaces ("⌘ K").

**The web must not bind** keys browsers reserve: ⌘N, ⌘T, ⌘W, ⌘Q, ⌘L, ⌘R, ⌘1–9, ⌘⇧T, ⌘⇧N, ⌘[ and ⌘], and ⌥⌘I (Chrome's developer tools). Where the product model names one of these (PRODUCT_REFOUNDATION §4.1's ⌘N), the web uses the fallback in the table and the Mac app uses the original.

### 4.1 Global

| Action | Web | Mac app | iPad (hardware keyboard) | Notes |
|---|---|---|---|---|
| New chat | ⌘⇧O | ⌘N | ⌘N | ChatGPT uses ⌘⇧O on the web (UNVERIFIED, [micro S36]). |
| New Code session | ⌘⇧O in Code | ⌘N in Code | ⌘N in Code | |
| Search and commands | ⌘K | ⌘K | ⌘K | O7. |
| Chat / Code workspace | ⌘⇧1 / ⌘⇧2 | ⌘⇧1 / ⌘⇧2 | ⌘⇧1 / ⌘⇧2 | PRODUCT_REFOUNDATION §3. |
| Toggle sidebar | ⌘\ | ⌃⌘S (system), ⌘\ | ⌃⌘S | S6. |
| Toggle artifact panel / inspector | ⌥⌘\ | ⌥⌘I (system "Show Inspector"), ⌥⌘\ | ⌥⌘I | A2, X7. |
| Previous / next chat | ⌥↑ / ⌥↓ | ⌥↑ / ⌥↓ | ⌥↑ / ⌥↓ | Proposal (Slack). |
| Shortcuts sheet | ⌘/ | ⌘/ | ⌘/ | Opens instantly. |
| Settings | via ⌘K | ⌘, | ⌘, | Browsers reserve ⌘, in some builds. |
| Focus composer | ⇧Esc, or type anywhere | same | same | C1. |
| Find in conversation | ⌘F (a second ⌘F passes to the browser) | ⌘F | ⌘F | M22. |
| Toasts | ⌥T | — | — | Sonner's region. |

### 4.2 Composer

| Action | Keys | Notes |
|---|---|---|
| Send | ↩ (or ⌘↩ under the "Send with ⌘Enter" setting) | C20. Never during IME composition. |
| Newline | ⇧↩ (or ↩ under the setting); ⌥↩ on the Mac | |
| Always send | ⌘↩ | Also **Send now** while a reply streams (C14). |
| Stop the reply | Esc (ladder, §4.6); ⌘. on the Mac | C13. |
| Edit your last message | ↑ in an empty composer | Proposal (Slack). |
| @ palette / / palette | `@` / `/` | C7, C11. |
| In a palette | ↑ ↓, ⌃P ⌃N, PageUp PageDown, ↩ or ⇥ to insert, Esc to close | |
| Over a token | ← → step over; ⇧← ⇧→ extend; ⌫ selects then deletes; Space or ↩ opens its popover | C9, C10. |
| Model menu | `/model` | No chord; every candidate collides with a browser. |
| Voice | `/voice` | C16. |
| Accept a URL-to-token suggestion | ⇥ | C4 (proposal). |

### 4.3 Transcript and messages

| Action | Keys | Notes |
|---|---|---|
| Jump to latest | ⌘↓, or End with focus in the transcript | M19. |
| Copy last reply | ⌘⇧C | Web: only where the browser delivers it (Chrome's ⌘⇧C opens the element inspector when developer tools are open); always available from ⌘K. |
| Copy last code block | ⌘⇧; | M7. |
| Version pager | ← → with the pager focused | M13. |
| Open a focused citation | ↩; Esc returns to the chip | M6. |
| Answer a focused question card | 1–9 choose; ↩ continues | T5. Questions only. |
| Approve | **No shortcut.** Tab to the verb button, then ↩ or Space, after it has armed | T6. |

### 4.4 Panels, Library, sidebar

| Action | Keys |
|---|---|
| Previous / next version (panel focused) | ⌥[ / ⌥] |
| Pick an element to revise | **Revise…**, then ↑ ↓ ↩, Esc to leave |
| Resize a focused split handle | ← → in 5% steps |
| Library: move, open, Quick Look | arrows, ↩, Space |
| Library: move to Trash | ⌘⌫ (Mac), Delete (Windows) |
| Sidebar: move, open, expand, menu | ↑ ↓, ↩, → ←, ⇧F10 |
| Sidebar: rename | Double-click, or F2 (Windows) |
| Pinned: reorder | ⌥⌘↑ / ⌥⌘↓ |

### 4.5 Code

| Action | Keys |
|---|---|
| Stop the run | ⌘. |
| Next / previous hunk | ⌥↓ / ⌥↑ (proposal) |
| Next / previous file in the diff | ⌥⌘↓ / ⌥⌘↑ (proposal) |
| Interrupt / clear (terminal focused) | ⌃C / ⌃L |
| Mode | `/ask`, `/plan`, `/code` |
| Goal | `/goal`, `/goal pause`, `/goal resume`, `/goal edit`, `/goal clear` |
| Stop screen control | Esc, anywhere (consumed) |

### 4.6 The Esc ladder
One Esc does exactly one thing, in this order:
1. Close the topmost transient layer: tooltip, then menu, popover or palette, then hover card, then lightbox, then dialog or sheet. A layer holding unsaved input asks "Discard changes?" instead of closing.
2. Cancel an inline edit: message edit (M14), rename (S4), a redirect field in an approval card.
3. Leave a mode: point-to-revise pick mode (A6), the find bar (M22).
4. Stop a streaming reply, when focus is in the composer or the transcript (C13).
5. Otherwise, nothing.

With focus inside a task, question or approval card, Esc returns focus to the composer and answers nothing.

**Esc never** clears the draft, denies an approval, stops a task, or ends a voice session unless focus is in the voice row. **The one exception** is Code's screen control, where Esc anywhere stops Alevr, because it is a safety control (X9).

### 4.7 Focus rules
- `:focus-visible` rings on everything interactive, from the global rule; never removed without a replacement.
- Closing any layer returns focus to what opened it.
- After a send, focus stays in the composer.
- Nothing Alevr does on its own (a card arriving, a reply finishing, a notification) moves focus.
- Every icon-only control has an accessible name and a tooltip; touch targets are at least 24 px on desktop and 44 px on touch.
- Lists (sidebar, palette, Library, menus) use a roving focus, so Tab enters and leaves them in one step.

---

## 5. Banned

Each item is banned in every Alevr surface. "Detect" says how review or CI catches it.

### 5.1 Visual state
| # | Banned | Instead | Detect |
|---|---|---|---|
| B1 | Status pills or badges ("Running", "Pending", "Completed", "Beta", "Verified", "Pro", "New") | State as words in `ink-2`/`ink-3`; provenance as text | Review; visual QA; grep for `Badge` in product surfaces |
| B2 | Decorative, unread or presence dots | The filled bell glyph; the words; the face | Review |
| B3 | Count badges on icons, tabs or the app icon | A count in the section header's text when needed | Review; no `UIApplication.shared.applicationIconBadgeNumber` writes |
| B4 | Coloured icon tiles in chrome | Colour only from entity marks | Review |
| B5 | Brand colour on anything not acting now, or on more than two spots | `primary` only per the roles table | Frame review (§6 Q-F2) |
| B6 | Amber on anything but the words that say someone needs you | `attention` rules | Frame review |
| B7 | A blue or brand-coloured primary on a destructive action | `danger` fill for destructive verbs | Review |
| B8 | Cards inside cards; every turn in a bordered bubble with an avatar | Plain replies; containers only for real outputs | Review |
| B9 | One radius everywhere (16 px on everything); a grey 1 px border on every card | Concentric radii; borders only where a boundary is interactive | Review |
| B10 | Row dividers in lists | Space and tone | Review |

### 5.2 Motion
| # | Banned | Instead | Detect |
|---|---|---|---|
| B11 | Animating anything keyboard-initiated (palettes, ⌘K, arrow navigation, thread switching) | Instant (F0) | Q-M3 |
| B12 | Overshoot beziers (`--ease-out-back` and the three literals) | Springs within the §1.4 caps | Lint: no `cubic-bezier(` outside `globals.css` |
| B13 | `transition: all`, `transition-all` | Named properties | Lint |
| B14 | Stagger on the sidebar, transcript, palettes, menus, skeletons or any F0–F2 list | Stagger only in the F3 allowlist, ≤ 6 items at 40 ms | Lint: `staggerDelay` / `stagger()` allowlist |
| B15 | Idle loops of any kind; anything in §1.6's banned list (shimmer sweeps, typing dots, carets, orbs, breathing faces, timed blinks, animated gradient borders, border beams) | Motion only on change | Lint: `animate-pulse`, `animate-ping`, `.shimmer-text` allowlist; review |
| B16 | Entering from `scale(0)` or from far away | 0.96–0.98, from the trigger | Review |
| B17 | Animating height or width (the composer's old exception is removed too) | `Collapse`, `layout="position"` | Review |
| B18 | Smooth-scrolling long distances; any automatic smooth scroll other than M18 | M19's jump-then-smooth; instant elsewhere | Review |
| B19 | Blur-in text, gradient text sweeps | Per-word opacity (M2) | Review |
| B20 | Auto-closing a disclosure the person opened; reopening one they closed | Respect explicit state (M4) | Test Q-S4 |
| B21 | Animated theme switching | Transitions disabled for one frame | Q-M7 |

### 5.3 AI-product tells
| # | Banned | Instead | Detect |
|---|---|---|---|
| B22 | Sparkles, gradient orbs, the `thinking-orbs`, `voice-glow` (outside C16), `metal-fx`, `img-fx` and `bot-avatars` effects | The live line; faces as instruments; the voice glow only while audio is live | `package.json` review |
| B23 | A glowing, gradient or beaming composer border | The composer's crisp surface/edge; meaningful voice feedback only while audio is live | Review |
| B24 | "Good morning, Name" in a serif over starter cards; generic suggestions ("Write a poem", "How many Rs in strawberry?") | One sans line; ≤ 3 state-derived suggestions or none | Review |
| B25 | Raw tool names, JSON, "PARAMETERS {}" in the default view | Sentence templates (M5); Details one disclosure down | Test: every registered tool has templates |
| B26 | "This tool wants to…", anonymous actors, generic Approve/Reject | Actor + exact verb (T6) | Review |
| B27 | A single consequential button with no alternative next to it | Verb + Not now; sheet on iPhone | Review |
| B28 | A model picker as a spec sheet in the first layer; a context-percentage meter in Chat | MP1's short list; specs in All models | Review |
| B29 | A top segmented control that splits the product into modes (Ask · Imagine · Build) | One composer; `/` commands | Review |
| B30 | Emoji section headers and bold-everything in model output | Output style rules in the system prompt; the renderer never adds emoji | Output QA |
| B31 | Mascot faces with personalities, accessories or idle antics | P1 state contract | Review |

### 5.4 Interaction
| # | Banned | Instead | Detect |
|---|---|---|---|
| B32 | Toasts for copy, save, send or anything just seen | Feedback in place (M11) | Review |
| B33 | Stealing focus when something arrives | §4.7 | Test Q-A5 |
| B34 | Enter, ⌘Enter, a voice "yes" or any global key approving anything | T6's deterministic rules | Test Q-S1 |
| B35 | Auto-sending dictation | C15 never sends | Test |
| B36 | Hover-only controls on touch; tooltips as the only label | Always-visible on touch; `aria-label` | Q-A3 |
| B37 | Disabling or swallowing paste | C4 | Test |
| B38 | Blocking modals or promotions on first visit; consent walls beyond the legal minimum | Nothing between the person and the composer | Review |
| B39 | Pulling the reader while they scroll, select or read | M17's escapes | Test Q-T2 |
| B40 | "Are you sure?" on reversible actions | Undo for `undoWindow` | Review |
| B41 | Confirmation dialogs whose primary button is the destructive default focus | Focus starts on the safe control (O4) | Test |
| B42 | Progress shown as elapsed time alone, percentage bars without meaning, source odometers | T2 lines in words | Review |

### 5.5 Platform
| # | Banned | Instead | Detect |
|---|---|---|---|
| B43 | Faked glass on the web (`backdrop-filter` blur panels, frosted cards) | Solid tone steps; one shadow on the composer | Lint: `backdrop-filter` allowlist (none in product surfaces) |
| B44 | Liquid Glass in the content layer; glass on glass; tinting anything but the one primary action | §1.9 | Native review |
| B45 | Custom toggles, pickers or menus on native where a system control exists | `Toggle`, `Picker`, `Menu` | Native review |
| B46 | Web conventions in the Mac app: pointing-hand cursors on buttons, hover washes on toolbar controls, flicker on transitions | §1.9 item 3 | Native review |
| B47 | Haptics while streaming; any haptic not in §2.14 | §2.14 | Test Q-N4 |
| B48 | Live Activities for short work; progress notifications | Live Activity only for tasks over 2 minutes; notifications only for decisions and results | Review |

### 5.6 Words
| # | Banned | Instead |
|---|---|---|
| B49 | "Oops", "Uh-oh", exclamation marks, "Something went wrong" alone | "What happened. What to do." |
| B50 | "Processing…", "AI is thinking…", "Your agent needs attention", "Your agent" | The real phase; the member's name ("Mira needs your answer") |
| B51 | Three dots instead of the ellipsis character; straight quotes in UI copy | "…"; curly quotes |
| B52 | Title Case in UI labels | Sentence case |

---

## 6. The premium checklist (QA gate)

A UI change merges only when every applicable item passes. Items are testable; the method is in brackets. **[E2E]** is a Playwright test (Chrome channel, web); **[XCT]** an XCTest or XCUITest; **[Rec]** a screen recording attached to the PR, slowed 5× in DevTools or the Simulator; **[Frame]** a static screenshot review at phone, tablet and desktop widths in both appearances, with real content.

### 6.1 Frames
- **Q-F1** Every validation frame uses real transcripts, real agent names, real files and at least one real failure state. Concept boards remain clearly labelled and do not substitute for validation. [Frame]
- **Q-F2** Count the chromatic spots: `primary` appears at most twice and only on something acting or the armed send; `attention` only on needs-you words; every other colour comes from an entity's mark. [Frame]
- **Q-F3** No pill, badge, dot or count badge anywhere (B1–B3). [Frame]
- **Q-F4** Exactly one elevated object per screen (usually the composer). [Frame]
- **Q-F5** The content is the brightest surface; the chrome sits one tone step dimmer. [Frame]
- **Q-F6** Every state on screen is readable as words without the colour. [Frame, grayscale]
- **Q-F7** The frame holds up next to its reference on the board and beats today's Alevr at the same frame (DECISIONS D-016). [Frame]

### 6.2 Motion
- **Q-M1** No animation exceeds its tier (§1.5); F2 motions finish within 360 ms, F3 within 560 ms. [Rec]
- **Q-M2** Every animation can be interrupted mid-way and reverses from where it is, without a jump. [Rec: reverse each F2 motion at 50%]
- **Q-M3** Palettes, ⌘K, menus opened from the keyboard, thread switches, find and sidebar selection change in the same frame. [E2E: assert no running `Animation` via `document.getAnimations()` the frame after the key]
- **Q-M4** Nothing loops outside §1.6's list; the page is still after 3 s idle. [E2E: `document.getAnimations().filter(a => a.playState === "running")` is empty on an idle chat]
- **Q-M5** With reduced motion (system and the Alevr setting), nothing translates, scales, blurs or bounces; fades remain; scrolls are instant. [E2E with `reducedMotion: "reduce"`; XCT with Reduce Motion]
- **Q-M6** Streaming a 3000-word reply with the CPU throttled 4× keeps scrolling smooth and typing in the composer without visible lag. [Rec + Performance panel: no long task over 50 ms attributable to the transcript]
- **Q-M7** Switching theme shows no staggered colour fades. [Rec]
- **Q-M8** `grep -rhoE 'cubic-bezier\(' src | sort -u` finds only the token file; `transition-all` finds nothing; the lint gate in §1.8 passes. [CI]

### 6.3 Composer and input
- **Q-C1** Enter during a Japanese IME composition neither sends nor inserts a token. [E2E]
- **Q-C2** Two Enters within 50 ms send once. [E2E]
- **Q-C3** The user turn appears in the same frame as the key press; Stop is available before the first token. [E2E]
- **Q-C4** With the network cut before the stream starts, the draft, tokens and attachments remain, and the turn reads "Not sent · Retry · Edit". [E2E offline]
- **Q-C5** "@" after a letter ("liam@acme") does not open the palette; "@" after a space does, in the same frame. [E2E]
- **Q-C6** Backspace after a token selects it; a second Backspace removes it; ⌘Z restores it with its data. [E2E]
- **Q-C7** A pasted 30 000-character log becomes one "Pasted text" chip with "Insert as text". [E2E]
- **Q-C8** Dragging a PDF over the window shows the overlay; dragging text does not; a 200 MB video is rejected inline by name. [E2E]
- **Q-C9** Enter while a reply streams queues one message; a second Enter appends to it; the queued message sends when the reply finishes and does not send after Stop. [E2E]
- **Q-C10** Dictation never sends. [E2E / XCT]
- **Q-C11** Drafts survive a thread switch and a reload. [E2E]

### 6.4 Transcript and streaming
- **Q-T1** At the bottom, streaming follows; one wheel notch up escapes; End or Jump to latest re-attaches. [E2E]
- **Q-T2** Selecting text in a streaming reply never moves the view. [E2E]
- **Q-T3** On send, the user turn lands 64 px below the top, and a short reply does not snap the view back. [E2E]
- **Q-T4** Prepending 50 older turns does not move the visible text in Safari 26, Safari 27, Chrome and Firefox. [E2E cross-browser]
- **Q-T5** Unterminated Markdown never shows raw `**`, `|---|` or half links during a stream. [E2E with a scripted stream]
- **Q-T6** Code-block Copy is disabled until the fence closes, then copies raw code; the check holds 1.5 s; on clipboard failure the code is selected. [E2E]
- **Q-T7** No streaming caret, typing dots, orb or shimmer appears at any point of a reply's life. [Rec]
- **Q-T8** No raw tool name renders in the default view for any registered tool. [Unit: the registry test]

### 6.5 Approval and safety
- **Q-S1** An approval card cannot be approved by Enter in the composer, by ⌘Enter, by a voice "yes", or by a click within 500 ms of its appearing or of its payload changing. [E2E]
- **Q-S2** The primary button's text is the exact verb and object; a destructive verb uses `danger`. [Frame]
- **Q-S3** Floor actions never offer "Always allow". [Unit + Frame]
- **Q-S4** A disclosure the person opened is never closed by the system, and vice versa. [E2E]
- **Q-S5** On iPhone, floor actions go through the sheet; money, credentials and permission widening require device authentication; notification approval actions require an unlocked device. [XCT]
- **Q-S6** Widening a permission in Customize requires the confirm popover; narrowing applies at once with Undo. [E2E]

### 6.6 Accessibility
- **Q-A1** With VoiceOver (and NVDA on Windows), one reply produces exactly one "replied" announcement and no partial text. [Manual, recorded]
- **Q-A2** The whole send → answer → approve → open deliverable flow completes with the keyboard alone. [E2E keyboard-only]
- **Q-A3** Every icon-only control has an accessible name and a tooltip; every touch target is ≥ 44 pt, every desktop target ≥ 24 px. [axe + E2E]
- **Q-A4** Contrast: `ink-3` and placeholders reach 4.5:1 on their surfaces in both appearances. [Automated contrast check]
- **Q-A5** No arriving card, reply, notification or toast moves focus. [E2E]
- **Q-A6** Increase Contrast and Reduce Transparency keep every boundary that carries meaning visible. [XCT snapshots]

### 6.7 Native
- **Q-N1** Glass appears only on the functional layer; there is never more than one glass layer at the bottom of the screen (the tab bar yields to the composer in threads). [XCT snapshots]
- **Q-N2** Send, stop and voice morph through one `glassEffectID`. [Rec]
- **Q-N3** The app is legible at both ends of the iOS 27 Liquid Glass slider. [XCT snapshots, both settings]
- **Q-N4** A streaming reply plays no haptic; a model change plays `.selection`; nothing outside §2.14 plays. [XCT with a haptics spy on `sensoryFeedback` triggers]
- **Q-N5** Mac: no pointing-hand cursor on buttons, no hover wash on toolbar controls, native menus and popovers. [Manual]

### 6.8 Words
- **Q-W1** Every error states what happened and what to do; none says only "Something went wrong". [Copy review]
- **Q-W2** Busy labels use "…"; UI labels use sentence case; quotes are curly. [Lint on string files]
- **Q-W3** Orbit events always name the member. [Copy review]

---

## 7. Changes to existing code and docs

This spec changes the following. Each line is a task for the implementation pass; none has been done.

| Where | Change | Why |
|---|---|---|
| `src/lib/motion.ts` | `spring.interactive` → `{ type: "spring", duration: 0.32, bounce: 0.15 }`; add `spring.reward` `{ type: "spring", duration: 0.36, bounce: 0.15 }`; restrict `stagger()` to the F3 allowlist | §1.4: one parameterisation with SwiftUI |
| `src/lib/interaction.ts` (new) + Swift `JunoTiming` (new) | The timers in §1.2 | No hand-typed timings |
| `src/app/globals.css` | Remove `--ease-out-back`; replace the 16 `cubic-bezier()` literals in `src` with tokens; remove the 6 `transition-all` | §1.3, B12, B13 ([micro T2]) |
| `globals.css` icon articulation (`svg.icon[data-motion]`) | Off inside the composer, the message action row, sidebar rows and menus (F0/F1 surfaces); never plays on keyboard focus; curves move from `--ease-out-back` to `--ease-out-soft` with half the travel. It stays on F2 destination buttons (New chat, Library, Customize). Off entirely in the Mac app | Rules 1–2; Mac conventions |
| `ICONS_AND_MOTION.md` §2.2 | Rule 5 ("lists are dealt") replaced by §1.5's F3-only stagger; rule 8's composer-height exception removed (C2); rule 9 ("loops for live state") replaced by §1.6's exhaustive list; §1.3's articulation scope as above | This spec supersedes |
| `useComposerAutosize` (`src/components/ui/composer-shell.tsx`) | Remove the height spring; `field-sizing: content` with the JS fallback | C2 |
| Composer editor (`composer.tsx`, `composer-shell.tsx`) | Replace the textarea + mirror with an atomic-node editor; typed `context` payload | C8–C10, audit R9 |
| `src/components/chat/message-list.tsx` | `ATTACH_SLOP_PX` 24 → 48; escapes for wheel up, keyboard scrolling and text selection; top turn anchoring with the spacer; jump-then-smooth | M17–M19 |
| `.shimmer-text` (`globals.css`), `PhaseOrb` (`effects/phase-orb.tsx`), `AgentStatusBadge`'s orb | Removed; replaced by the M1 live line | M1, B15, B22 |
| `thinking-orbs`, `bot-avatars`, `metal-fx`, `img-fx` in `package.json` | Removed once unused; `voice-glow` kept only for C16 pending the owner's re-confirmation (§9) | B22 |
| `staggerDelay` (72 files) | Removed except the F3 allowlist: onboarding, first Library population, agent arrival | B14, audit R7 |
| `agent-face.css`, `agent-presence.tsx`, `face-rig.ts`, `agents.css`, `JunoAgentFace.swift`, `JunoAgentPresence.swift`, `NativeAgentsHome.swift` | Remove halos, sheens, gradients, idle breathing, timed blinks and glances; implement the P1 contract and derivation | §2.9 |
| `JunoMotion.reward` | Bounce 0.18 → 0.15 | §1.4 cap; parity with the web |
| `JunoMotion.handoff` | `emphasized` → `layout` (no bounce); reduced form unchanged | C18 |
| `approval-card.tsx`, native approval views | Verb button, split caret for "Always", arming, digest re-arm, redirect field, receipt collapse | T6, T7, X6 |
| `tool-receipt.tsx`, `activity-timeline.tsx`, `thought-process-panel.tsx` | Sentence templates, three-row live window, collapse to summary, Details disclosure | M4, M5 |
| `source-chip.tsx`, `sources-pill.tsx`, `citation-audit.tsx` | Domain chip after the claim, hover card, pinned card, "Sources · N", the audit line; the "pill" component name retires | M6 |
| Sonner usage | Audit every `toast(` call against O6; remove copy/save/send toasts | B32 |
| `eslint-rules/design-system.mjs` | The rules in §1.8 item 8 and the `backdrop-filter` allowlist | §1.8, B43 |
| `contracts/product/juno-shell-v1.json` → v2 | Record the keyboard map and the dock as shared behaviour so the native clients must map them | PRODUCT_REFOUNDATION §4.5 |
| Reference board | Copy `juno-references.html` and its source folders from scratch into `docs/rework/research/board/` if it is kept | The images expire with the session |

---

## 8. References

Everything was read or captured on 2026-09-30 unless dated otherwise. Board files are in the reference board (`juno-references.html`), which also links each image's source.

**No Mobbin citations.** Every Mobbin call (`search_screens`, `search_flows`, deep and standard) returned "Mobbin MCP requires a paid plan" on 2026-09-30. If the plan is upgraded, rerun the moments in `ai-chat-ui-references-web.md` §2 and `ai-chat-ui-references-ios.md` §3 and add `mobbin_url` citations next to the board files cited here.

**Products (behaviour borrowed, with board files)**
- Raycast AI, inline app tokens and teaching placeholder: https://www.raycast.com/core-features/ai (`web/composer__raycast.png`, `web/tool-calls__raycast.png`, `web/routines__raycast.png`); Raycast 2, 2026-05-14: https://www.raycast.com/blog/the-new-raycast
- Linear agent, context receipt, "Worked for 10 sec": https://linear.app/ (`web/thinking__linear.png`, `web/composer__linear.png`, `web/agent-progress__linear.png`); Linear refresh, 2026-03-12: https://linear.app/now/behind-the-latest-design-refresh
- Cursor, trace typography, question card, grouped agent list, document pane: https://cursor.com/ (`web/thinking__cursor.png`, `web/agent-progress__cursor.png`, `web/artifacts__cursor.png`)
- ChatGPT, goal row, model guide, voice in the thread: https://learn.chatgpt.com/docs/long-running-work , https://learn.chatgpt.com/docs/model-selection , https://learn.chatgpt.com/docs/features/voice (`web/composer__chatgpt-goal.png`, `web/model-picker__chatgpt.png`, `web/voice__chatgpt.png`, `ios/01`, `ios/15`); voice inline since 2025-11-25: https://techcrunch.com/2025/11/25/chatgpts-voice-mode-is-no-longer-a-separate-interface/
- Claude, composer and artifacts: https://claude.com/product/overview , https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them (`web/composer__claude.png`, `ios/30`, `ios/31`; `ios/20` as slop)
- Grok, teaching placeholder: https://grok.com/ (`web/home__grok.png`, `web/composer__grok.png`; `ios/10` as slop)
- Dia, stop square, app-marked sources, editorial brief: https://www.diabrowser.com/ (`web/composer__dia.png`, `web/citations__dia.png`, `web/research-report__dia.png`); "The strategy behind Dia's design", 2025-06-17: https://browsercompany.substack.com/p/the-strategy-behind-dias-design
- Microsoft Copilot, palette over the keyboard, model menu, Send Email sheet: https://apps.apple.com/us/app/microsoft-copilot/id541164041 (`ios/05`, `ios/08`, `ios/19`, `ios/27`)
- Meta AI model menu: https://apps.apple.com/us/app/meta-ai/id1558240027 (`ios/09`)
- Google Gemini, mode token, Live with the camera: https://apps.apple.com/us/app/google-gemini/id6477489729 (`ios/11`, `ios/17`)
- Vibe by Mistral, trace, skill loading, dictation autosend: https://apps.apple.com/us/app/vibe-by-mistral-ex-le-chat/id6740410176 (`ios/03`, `ios/12`, `ios/13`, `ios/16`)
- Perplexity, clarifying plan gate: https://apps.apple.com/us/app/perplexity-ai-search-chat/id1668000334 (`ios/14`)
- Linear Mobile, agent push, tab bar morph: https://apps.apple.com/us/app/linear-mobile/id1645587184 (`ios/06`, `ios/22`, `ios/26`)
- Things 3, quick entry, Magic Plus: https://culturedcode.com/things/features/ (`ios/07`, `ios/28`, `ios/33`)
- Apple: Siri app and Notify Me (iOS 27): https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/ (`ios/02`, `ios/18`, `ios/23`, `ios/25`); Messages and Live Activities (iOS 26): https://www.apple.com/newsroom/2025/06/apple-elevates-the-iphone-experience-with-ios-26/ (`ios/04`, `ios/24`)

**Slop references (designed against)**
- Vercel AI Elements defaults: https://elements.ai-sdk.dev/ (`web/tool-calls__ai-elements-tool.png`, `web/approvals__ai-elements-confirmation.png`, `web/artifacts__ai-elements-artifact.png`, `web/agent-progress__ai-elements-queue.png`, `web/model-picker__ai-elements-context.png`, `web/thinking__ai-elements-cot.png`, `web/home__ai-elements-chatbot.png`). Their behaviour (reasoning state, tool states, citations, copy timing) is borrowed; their skin is not.
- t3.chat, Manus, v0, Kimi mode chips: `web/home__t3chat.png`, `web/home__manus.png`, `web/home__v0.png`, `web/home__kimi.png`.

**Craft and platform sources**
- Emil Kowalski, review-animations standards: https://github.com/emilkowalski/skills/blob/main/skills/review-animations/STANDARDS.md ; "7 practical animation tips": https://emilkowal.ski/ui/7-practical-animation-tips ; Vaul: https://emilkowal.ski/ui/building-a-drawer-component ; Sonner source: https://github.com/emilkowalski/sonner
- Rauno Freiberg, "Invisible details of interaction design" (2023): https://rauno.me/craft/interaction-design
- Vercel, Web Interface Guidelines: https://vercel.com/design/guidelines
- Streamdown: https://streamdown.ai/ ; AI SDK `smoothStream`: https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream ; `useChat`: https://github.com/vercel/ai/blob/main/content/docs/07-reference/02-ai-sdk-ui/01-use-chat.mdx
- `use-stick-to-bottom`: https://github.com/stackblitz-labs/use-stick-to-bottom ; assistant-ui Thread and ActionBar: https://www.assistant-ui.com/docs/primitives/thread ; shadcn Message Scroller: https://ui.shadcn.com/docs/components/radix/message-scroller
- Radix Tooltip and Dialog: https://www.radix-ui.com/primitives/docs/components/tooltip
- Apple HIG: Motion, Playing haptics, Materials, Accessibility, Loading, Generative AI, Tab bars, Sheets: https://developer.apple.com/design/human-interface-guidelines/ ; "Applying Liquid Glass to custom views": https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views ; WWDC18 803 "Designing Fluid Interfaces"; WWDC23 10158 "Animate with springs"; WWDC25 219 and 356
- Platform support: `field-sizing` Baseline 2026-06-16; same-document View Transitions Baseline 2025-10-14; `overflow-anchor` in Safari 27 (https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/)
- AYDesign, "AI citation and source UI design patterns for 2026" (2026-09-11): https://www.aydesign.ai/blog/ai-citation-source-ui-patterns-2026
- NN/G, "Liquid Glass Is Cracked" (2025-10-10): https://www.nngroup.com/articles/liquid-glass/

**UNVERIFIED claims this spec relies on only lightly:** ChatGPT's keyboard shortcuts (⌘⇧O, ⌘⇧C, ⌘⇧;) from secondary cheat sheets; ChatGPT's streaming haptics; long-paste chip thresholds in Claude and ChatGPT. Each is marked where used.

---

## 9. Decisions this spec takes, and the ones left for the owner

**Taken here** (reversible, each with its evidence):

| # | Decision | Evidence |
|---|---|---|
| I-1 | Composer growth snaps; the height spring goes | Frequency law; [micro D3] |
| I-2 | New turns anchor to the top with a 64 px peek | ChatGPT, assistant-ui, shadcn; [micro D5] |
| I-3 | No shimmer, caret, dots or orb; the live line is `primary` text with real seconds | Owner rules; [premium §4, §5]; crew audit §3.2-6 |
| I-4 | Reasoning stays closed with one live line; explicit choices are never overridden | [micro D6] |
| I-5 | Stagger only in F3, ≤ 6 items at 40 ms | Audit R7; [micro D4] |
| I-6 | Overshoot beziers retired; reward spring at two sites, bounce 0.15 | [micro T2]; WWDC23 |
| I-7 | Icon hover articulation limited to F2 destinations, never on keyboard focus, never on the Mac | Rules 1–2; Raycast 2's Mac conventions |
| I-8 | Approval arms after 500 ms and re-arms on payload change; no global approve key; "Always" never on floor actions | Owner rule 3; browser security delays (UNVERIFIED value) |
| I-9 | One queued message while streaming, never auto-sent after a stop or an error | Codex and Claude Code queues; safety |
| I-10 | The dock above the composer holds needs-you, queued, goal and offline rows, one at a time | ChatGPT's goal row, generalised |
| I-11 | No haptic on send and no warning haptic for needs-you | Apple HIG ("avoid overuse") |
| I-12 | Web fallbacks for browser-reserved keys (⌘⇧O, ⌥⌘\) | Browser reservations |

**For the owner:**
1. **The voice glow.** Keep it as the single light effect, on only while audio is live, or replace it with the static outline for everyone? (The crew audit asked for re-confirmation under the no-glow-blob rule.)
2. **The two reward sites.** Approval accepted and long work finished on screen. Keep both, one, or none?
3. **Enter or ⌘Enter as the default send.** This spec keeps Enter with a setting.
4. **Re-authentication for spending and credentials on the web** (a passkey prompt after the verb), matching Face ID on iPhone. Proposed, not specified in T6 until decided.
5. **Type-to-focus** from the transcript (C1). It is fast for keyboard users, but it means a stray key while reading lands in the composer.
