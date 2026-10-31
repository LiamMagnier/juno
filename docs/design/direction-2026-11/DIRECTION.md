# Alevr design direction: "Graphite" (for owner approval)

Status: **approved by the owner, 31 Oct 2026** ("Approve Graphite as written").
Built in the order of §9; each step lands as its own change. The
handoff (`docs/handoff/2026-10-31/HANDOFF.md` §1, §8.B) requires the owner to
see and approve one direction before redesign code is written. The owner asked
(31 Oct 2026) to start fresh rather than pick one of the three drafted
directions, and to improve the design "in every way: UI, UX, motion design".
This is that fresh direction. It borrows measured patterns from the drafts and
the competitor map, keeps every hard constraint in `design/map-principles.md`,
and fixes the defects the ten audits measured.

Every value below is exact. Where a value changes, the live value is given as
`was → now`. A change to an existing token value is cheap (regenerated to TS
and Swift); no token is renamed or removed, so no Swift consumer breaks.

---

## 1. The idea in one paragraph

**One quiet graphite surface, one command grammar, one motion voice.** The
interface recedes until something is happening, then responds instantly and
precisely. Chrome is neutral graphite on near-white (light) or soft carbon
(dark), with no warm remnants. Colour appears only to mean state. Every menu,
picker and popover is the same object, so learning one teaches all. Motion is
fast on the way in and faster on the way out, comes from the thing you touched,
and never makes you wait for it. The reference bar is ChatGPT's density and
speed, Claude's typographic calm in the transcript, and Apple's concentric
geometry and native components.

What is deliberately **not** in it: glass on content, warm "paper" tones,
decorative gradients, coloured hover states, bouncy entrances, spinners other
than the one working mark, and any second menu system.

---

## 2. Foundations

### 2.1 Colour (light / dark)

The neutral family is cool graphite, hue 216–225. Three tokens still carry the
retired warm hue 48 (an audit finding); they move into the family.

| Token | Light | Dark | Why |
|---|---|---|---|
| `--background` | `240 20% 99.02%` (keep) | `220 5.88% 10%` (keep) | |
| `--card` | `0 0% 100%` (keep) | `225 5.56% 14.12%` (keep) | |
| `--popover` | `0 0% 100%` (keep) | `225 4.88% 16.08%` (keep) | A lighter dark popover (17%) took the input boundary below 3:1 in the contrast matrix, so it stays |
| `--accent` (hover) | `210 6.67% 94.12%` → `216 8% 94.5%` | `225 4.26% 18.43%` → `225 5% 20%` | Dark hover contrast was 1.09:1 against popover (map-menus); now ≥1.18:1 |
| `--selected` | `220 6.38% 90.78%` (keep) | `228 4.35% 22.55%` (keep) | Not changed. A lighter dark selected rung (proposed 25.5, tried 24.5) takes muted text on it below the 4.9:1 floor `tests/wave2-p1-contrast.test.ts` holds. Separating selected from `--border` is done in the menu step instead (selected rows carry a check, §4), not by lightening the fill |
| `--border` | keep | keep | |
| `--hairline` | `48 12% 18% / 0.06` → `216 9% 11% / 0.07` | `45 14% 94% / 0.08` → `220 7% 92% / 0.08` | Warm remnant removed |
| `--scrim` | `48 12% 8% / 0.26` → `216 12% 6% / 0.30` | `0 0% 0% / 0.55` → `0 0% 0% / 0.50` | Matches the ChatGPT-measured 30 / 50 [map-competitors §3] |
| `--shadow-float` (light) | 3-layer, 0.22 throw | `0 0 0 1px hsl(ink/.04), 0 2px 6px -1px hsl(ink/.06), 0 16px 40px -12px hsl(ink/.18)` | Shorter, tighter throw: menus feel attached to their trigger, not floating away |
| `--shadow-float` (dark) | keep throw, ring `hsl(45 20% 96% / .05)` → `hsl(220 7% 96% / .07)` | | Edge legibility on carbon; warm hue removed |

Status colours (presence, signal, destructive, attention, success) keep their
roles and values; the contrast matrix stays the gate. The recorded failing pair
(muted on `--selected`) stays recorded.

### 2.2 Type

Faces and jobs unchanged (Inter for UI and reading, Newsreader for greetings and
page titles only, JetBrains Mono for numbers and paths). Changes:

| Role | Was | Now |
|---|---|---|
| `reading` (transcript) | 16 / 1.6 | 16 / 1.62, max measure 68ch (was unbounded inside 768px) |
| `ui` | 13 / 1.45 | 13.5 / 20px line ("even line for icon centring", map-competitors §1.1) |
| `label` | 12 | 12 / 16, weight 500 for group labels only |
| Menu row text | mixed 12–14 | always `ui` 13.5/20 |
| Page h1 (Newsreader) | 28 | 30 / 1.15, tracking −0.01em |

Deprecated type rungs still used in call sites (map-components) are migrated to
these four; the transcript chrome law (three sizes) holds.

### 2.3 Geometry

The radius ladder keeps every rung. Two values move so nesting is exactly
concentric everywhere:

| Rung | Was | Now | Nest |
|---|---|---|---|
| menu | 14 | **12** | inset 6 → row radius **6** (ChatGPT's measured 12/6) |
| composer | 26 | **24** (lands with the composer, step 6) | inset 8 → action 16 (keep), control 14 → **16** |
| panel | 16 | 16 (keep) | inset 4 → card **12** |

Spacing stays on the 4px base. Targets unchanged (32 fine / 44 coarse web,
28 Mac, 44 iOS).

### 2.4 Elevation

Two levels only, as FLAT_UI says: **in-flow** (fill + hairline, no shadow) and
**floating** (`--shadow-float`). The 61 raw shadows and 5 card materials the
audit counted collapse onto these two. The composer is in-flow (hairline, focus
darkens the edge) and gets **no** shadow at rest, a 1px contact shadow on focus.

---

## 3. Icons

- **One drawing language.** The 13 navigation glyphs redrawn on Lucide geometry
  are redrawn on the house grid. 24-unit canvas, 1.5 stroke at 16px (renders
  1.0px at 16, 1.25 at 20), round caps and joins, 2-unit corner radius on
  rectilinear shapes, optical centre at y = 12 (the measured 0.75px low bias is
  corrected in the recipe, not per glyph).
- **Mass:** every glyph fits a 18-unit live area; circles 20 units to match
  squares optically.
- **Fill means on.** `weight="fill"` must render filled (it silently rendered
  outline). The Design pen-nib regression and wrong registry picks are fixed.
- Native keeps drawing the web's glyphs (never SF Symbols).

---

## 4. One command surface (replaces six menu systems)

Every menu, the `+` menu, the model picker, slash commands, context menus, the
sidebar kebab, selects and the ⌘K palette share **one** shell and **one** row,
from `menu-recipe.ts`. `.cmenu` and every local override are deleted.

**Shell:** radius 12, inset 6, `surface-float`, width `w-56` (224) or `w-72`
(288) only, max height `min(available − 16, 480)` then scroll with a 1px top
and bottom scroll-shadow. Opens from its trigger (`origin-popper`).

**Row:** 32 tall (44 coarse), padding 6 / 8, radius 6, gap 8, `ui` text,
16px glyph. Anatomy, in this order: selection slot (16, optional) · glyph ·
label · trailing (shortcut, value or chevron).

| State | Value |
|---|---|
| Hover / keyboard highlight | `--accent` fill, **0 ms in**, 120 ms out; text colour unchanged; glyph goes muted → foreground |
| Selected (persisting) | 16px check in the leading slot + label weight 500. One form everywhere (was ~16 styles) |
| Toggle inside a menu | a switch in the trailing slot, never a check (was 4 forms) |
| Disabled | 50% on glyph and label, no highlight; hidden instead in context menus |
| Destructive | `--destructive-ink` label and glyph, always the last group |
| Group label | `label` 12/16 weight 500, muted, 8px top margin (0 on the first) |
| Separator | 1px `--hairline`, full-bleed (negative inset), 6px vertical gap |
| Shortcut | `Kbd` component only (one style, was 7), muted, mono 11 |
| Submenu | chevron at 75% opacity → 100% when open; opens **100 ms** after hover; 300 ms safe triangle; first submenu row aligns to its parent row (was 7px low); keeps parent fill while open |

**Search:** any list longer than 7 items gets a filter field as its first row
(the model picker, connectors, projects). Typing anywhere in an open menu
jumps by typeahead (1 s buffer).

**Keyboard:** ↑↓ moves, → opens a submenu, ← closes it, Enter activates, Esc
closes one level, Home/End jump. The Compare picker gains arrow navigation.

---

## 5. Pop-ups

One dialog engine (shipped in `fix/overlay-defects`, to be reviewed):

- **Dialog:** width 440 (small) / 560 (default) / 720 (wide); radius 16; header
  20/24 padding with title `ui` 15 weight 600 and one close button (24px icon
  button, top-right, was 12 variants); body scrolls, header and footer pinned;
  footer right-aligned, primary trailing, Cancel before it. Esc and ⌘. cancel.
- **Confirm:** the shared `ConfirmDialog`, title ≤ 2 lines, ≤ 3 buttons; the
  destructive button is styled destructive only when the person did not choose
  a destructive action directly.
- **Sheet (mobile web, iOS):** medium and large detents, grabber, inset at
  partial height, swipe to dismiss. One bottom-sheet engine.
- **Toast:** bottom centre, `z-toast`, one line plus an optional action, 4 s,
  pause on hover; never for something already visible in context.
- **Tooltip:** 200 ms intent, 400 ms skip window (the live values; docs are
  corrected to match), `label` text, `Kbd` for shortcuts with ≥ 4.5:1 contrast.

---

## 6. Composer

The pattern ChatGPT and Claude converge on, done more precisely:

- **Card:** radius 24, `composer-surface`, padding 8, max width = reading column
  (768). Text area grows to 10 rows, then scrolls.
- **Bottom row, left:** `+` (attach and tools, the one command surface).
  Armed tools become **removable pills** in the row, so scope is visible before
  send.
- **Bottom row, right:** model chip (model name + effort, opens the picker
  with search) · mic (dictation) · primary button.
- **Primary button, one slot, four faces** (already fixed by the shell
  contract): voice (empty), send (text), stop (streaming), queued. The empty
  face is **foreground-filled**, not pale grey (map-composer's weakest-primary
  finding). Faces cross-fade in 120 ms with a 0.9 → 1 scale; no layout shift.
- **One glyph size** in the row (16) — there were 7.
- **Landing → dock** is one element that moves (shared layout transition,
  `spring-layout`), never a remount that jumps. The draft and send ownership
  carry across, as the constraints require.
- **Drag-over:** one dashed 1.5px `--ring` outline at radius 24 and a
  "Drop to attach" label; the triple outline goes.

---

## 7. Motion storyboard

Durations stay on the closed ladder (70/120/160/220/360/560). Exits take the
rung below on `ease-in`. Only transform, opacity, clip-path and grid-rows
animate.

| Moment | Spec |
|---|---|
| Menu open | scale 0.96 → 1 + opacity, **160 ms** `ease-out-expo`, from trigger; close 120 ms `ease-in` |
| Submenu | slide 4px from its side + opacity, 120 ms; no delay on keyboard |
| Row highlight | 0 ms in, 120 ms out (no smear) |
| Dialog | scale 0.98 → 1 + opacity 220 ms `ease-out-expo`; scrim 160 ms; exit 160 / 120 |
| Sheet | `spring-layout` (0.36 s, no bounce); dismiss follows the finger, releases on velocity |
| Toast | rise 8px + opacity 220 ms; exit 160 ms opacity only |
| Message sent | user bubble rises 6px + opacity 220 ms (`rise-user`); the transcript does not jump |
| Streaming | text appears per token chunk, no per-character fade; the working mark is the only loop |
| Composer face | 120 ms cross-fade + 0.9 → 1 scale |
| Press | 0.97 over 70 ms, small controls only; large surfaces press tonally |
| Route change | 80 ms hold (was 450), content cross-fade 160 ms |
| Sidebar fold | width 220 ms `spring-layout` (one of the four named width cases) |

Reduced motion keeps its three tiers: opacity and colour stay, travel
collapses, loops stop.

---

## 8. Native (macOS 26, iOS 26)

**Same layout as the web, native components, glass only on controls.**

- **macOS:** an opaque content column on `--background`, sidebar on `--sidebar`
  (opaque, was glass), toolbar with system Liquid Glass controls. Glass only in
  the five sanctioned places (composer cluster, ⌘K, find bar, toast host,
  Quick Entry); the ~48 glass-on-glass sites and the custom Chat/Code orbit in
  the toolbar go (a system segmented control replaces the orbit). Menus are
  system `Menu`/`Picker` styled by tokens; sheets are system sheets. One title
  per page (duplicates removed). Text floor 12pt (58 sub-12 calls fixed).
  32 button styles collapse to: primary, secondary, plain, destructive, icon.
- **iOS:** the web's information architecture (sidebar as drawer with the same
  order), one composer (was 5 with radii 26/24/24/22/28) at radius 24, model
  shown as a chip (not a gauge glyph), tool calls rendered in the transcript,
  44pt targets everywhere, icons as template vectors with Dynamic Type (were
  274 bitmaps), glass off content (114 sites → controls only).
- Every animation names a `JunoMotion` token; every colour comes from the
  generated tokens.

---

## 9. Build order and gates

Built in the handoff's order, each step its own reviewable change with
before/after screenshots at 1280 and 390, light and dark:

1. Tokens (§2) — `npm run design:tokens`, contrast matrix, Swift regenerated.
2. Icons (§3) — `npm run native:icons`.
3. Recipes and primitives (Button, Badge, Kbd, Slider scope, focus ring).
4. The command surface (§4), replacing all six menu systems.
5. Pop-ups (§5).
6. Composer (§6).
7. Motion (§7).
8. Call-site migration (lint ratchets to zero).
9. macOS, 10. iOS (§8) — `native.yml` and `native-snapshots.yml` green.

Then the loop the owner asked for: capture web screenshots and native CI
snapshots, compare side by side with ChatGPT, Claude and Apple apps, fix,
repeat.

---

## 10. What the owner is approving

1. The character (§1): graphite, one command surface, fast quiet motion.
2. The value changes in §2 (menu radius 14 → 12, composer 26 → 24, dark hover
   and selected rungs, warm remnants removed, shorter float shadow, `ui` 13.5).
3. The single menu anatomy and its states (§4).
4. The composer layout and the foreground-filled primary (§6).
5. The native rule: web layout, native components, glass on controls only (§8).

Anything not listed keeps its current value.
