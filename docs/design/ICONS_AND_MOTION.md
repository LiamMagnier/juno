# Icons and motion: the September 2026 premium pass

`FLAT_UI.md` is still the material law (one plane, hairlines, tonal state, one
accent) and `PREMIUM_AUDIT.md` still governs composition. This brief covers the
two things those documents left to each call site, which is why they drifted:
**the icon set** and **how things move under the pointer**.

The reference is the chrome of Claude and ChatGPT. Their icons are light,
even-weight line drawings from one family, and their motion is small, physical
and always caused by the reader.

## 1. The icon set

### 1.1 One module
Every glyph comes from `@/components/ui/icons`. It is the only file allowed to
import a glyph library (ESLint `no-restricted-imports` enforces it). The export
names are Juno's (`ChevronDown`, `Loader2`, `Settings`, …). The drawings are
Phosphor's 256-unit grid at designed weights.

- Take an icon as a prop with `icon: IconComponent` (from the same module).
- Four glyphs are Juno's own drawings rather than Phosphor's (§1.4). They
  come through the same module; never import `juno-glyphs.tsx` directly.
- The shared registries in `src/lib/app-icons.ts` (`AppIcons`, `CodeIcons`,
  `ComposerIcons`, `StatusIcons`, `ActionIcons`, `DesignIcons`,
  `SettingsIcons`) still come first. One concept, one drawing.
- **Never hand-draw an interface icon** (an inline `<svg>` of a chevron, a
  check, a spinner, a plus, …). Exempt: brand and product logos (connector
  logos, the GitHub mark, model-lab marks, the Juno mark), data visualisation
  (charts, sparklines, progress rings, teaching diagrams), the dot-matrix
  signature, the bespoke animated live-state marks (the private-chat ghost,
  the web-search globe whose meridians morph while it fetches), and the
  design canvas's own rendering.
- No emoji as icons.

### 1.2 Weight and size
- The house weight is `regular`: a 1px line at 16px, 1.25px at 20px. Do not
  pass `strokeWidth`. At `size-3` (12px) and under, `icons.tsx` switches to the
  `bold` cut on its own.
- `weight="fill"` means **on** or **selected**: a pinned pin, a starred star,
  the active favourite. It is a state, never decoration. A `fill-current` class
  also selects it.
- The size ladder is `size-3` (12, dense metadata only), `size-3.5` (14,
  inline with caption text), `size-4` (16, the default for buttons, menus and
  rows), `size-4.5` (18, sidebar destinations only), `size-5` (20, large touch
  targets and page headers), `size-6` and up (empty-state art only). An icon
  sits optically centred on its text: `gap-2` beside `text-ui`, `gap-1.5`
  beside `text-caption`.
- Ink: chrome glyphs are `text-muted-foreground` at rest and take the row's
  foreground on hover or selection (`group-hover:text-foreground`,
  `transition-colors duration-fast ease-out-soft`). Status glyphs keep their
  status colour. Menu rows already do this: `menuGlyphInkClass` in
  `src/components/ui/menu-recipe.ts` lights the glyph with its row on
  `data-highlighted`, an open submenu (`data-state=open`), hover and keyboard
  focus, in every menu that uses the recipe. A glyph that states its own
  `text-*` keeps it.

### 1.3 Hover articulation
Each glyph carries at most one hover gesture (`data-motion`), declared in
`icons.tsx` and played by `globals.css` when the interactive element around it
(`a`, `button`, `[role=menuitem|option|tab|button|link]`, `summary`, `label`,
or anything marked `data-icon-trigger`) is hovered, keyboard-focused or
highlighted by a Radix menu. It never plays inside a disabled control and
never under `prefers-reduced-motion`.

| Motion | Meaning | Glyphs |
|---|---|---|
| `nudge-r/l/u/d/ne` | the action goes where the arrow points | arrows, send, external link, sign out, upload/download |
| `turn` | make one more / dismiss | plus, x |
| `spin` | configuration, appearance | settings gear, sun |
| `cw` / `ccw` | run again, go back | refresh, repeat, rotate-ccw |
| `tilt` | a tool picked up | search, pencils, pin, mic, link, key, wrench, thumbs |
| `lift` | an object picked up | copy, trash, archive, folder, stacks, library |
| `pop` | a mark you set | star, sparkle, bookmark, play, zap |
| `parts` | one part of a Juno mark moves, not the whole glyph | JunoChat, JunoCode, JunoDesign |

Carets, spinners and status marks carry none. If a gesture is wrong in context
(for example an arrow that is a label rather than an action), pass
`motion="none"`. On a custom clickable container that is not a
button or link, add `data-icon-trigger` so its icon plays.

`parts` is the one articulation that does not move the whole glyph. Juno's
marks are drawn with their moving part as a separate element
(`juno-part juno-part--ball`, `--spark`, `--disc`), and the same trigger rule
that plays the other gestures sets `--icon-on: 1` on the svg, which the part
reads: Chat's ball terminal pops out of the ring's gap (a message leaving),
Code's spark turns a quarter and swells (it is four-fold, so it lands where it
started), Design's circle slides back from the square in front of it (two
layers parting). Offsets are in the drawing's own 256-unit space. Under
reduced motion `--icon-on` stays 0 and nothing moves. A new Juno mark that
articulates gets a `juno-part--*` class and one rule beside the others in the
`svg.icon` section of `globals.css`.

A glyph that turns to show a state (a plus rotating to an x while its menu is
open) passes `motion="none"`, so the hover turn does not add to the open
rotation. The Code and Work composers' `+` buttons are the example.

**The sidebar.** Gestures belong to the glyph, not to the place it is drawn.
A sidebar destination moves the way its glyph moves everywhere (the plus
turns, the gear turns, the library lifts, the Juno marks move their part), and
`SidebarMotionIcon` (`src/components/app/sidebar-motion-icon.tsx`) never
assigns a gesture. It only silences a default that is wrong in a navigation
column: the folder and projects marks (their gesture is the closed-to-open
folder cross-fade, the one morph the sidebar owns), the panel toggle (its
effect is the whole column moving), the overflow dots (they open a menu, they
are not a place) and a conversation (a document, not a destination). A new
destination gets its gesture from `icons.tsx` or not at all.

### 1.4 Juno's own marks
`JunoChat`, `JunoCode`, `JunoDesign` and `Send` are drawn for Juno in
`src/components/ui/juno-glyphs.tsx` and exported through `icons.tsx` like
every other glyph, so they get the optical weight choice, aria and hover
articulation from `glyph()`. They are the three places the product is known
by and its one verb, the marks a reader sees on every screen, so they carry
the two motifs of the Juno logo (`public/juno-mark.png`): the **open ring**
that stops short with a **ball terminal** beside the gap, and the
**four-point spark** with concave sides.

- `JunoChat` (`AppIcons.home`, `AppIcons.conversation`): the logo's bubble as
  a line, a ring open at the top right with the ball in the gap and the tail
  at the lower left. Its `fill` weight is the logo itself, the solid bubble
  with the spark cut out, for the selected state.
- `JunoCode` (`AppIcons.code`): the spark between two chevrons, where `</>`
  puts a slash. Code that Juno writes.
- `JunoDesign` (`AppIcons.design`): a square in front of a circle, stacked
  like cut paper. The circle stops short of the square instead of crossing
  it, so the mark stays quiet at 16px.
- `Send`: an up arrow whose head has the spark's concave flanks. Every "send
  this" in the product draws it.

They are drawn on Phosphor's grid so they sit in a row of Phosphor glyphs
without looking borrowed: a 256-unit box, a 16-unit line at `regular` (1px at
16px), round caps and joins, the live area inside 24 to 232. They are strokes,
so every weight is the same drawing at a different line (thin 8, light 12,
regular 16, bold 24), and `fill` is a solid drawing of its own. Replacing any
other mark with a Juno drawing is a one-line change in `icons.tsx` that
reaches every surface; draw it on the same grid.

## 2. Motion

### 2.1 Tokens (unchanged, now used everywhere)
Durations: `duration-press` 70, `duration-fast` 120, `duration-exit` 160,
`duration-base` 220, `duration-slow` 360, `duration-emphasis` 560.
Curves: `ease-out-soft` (default), `ease-out-strong` (things the user moves),
`ease-out-expo` (long travel), `ease-in` (exits), `ease-in-out` (A-to-B with
both ends visible), `ease-spring` (arrivals), `ease-drawer` (sheets).
In framer, use `transition`, `spring`, `variants` and `stagger` from
`@/lib/motion`, never hand-typed numbers.

### 2.2 The interaction recipe
1. **Hover is a tonal cross-fade.** `transition-colors duration-fast
   ease-out-soft` to `hover:bg-accent` (rows, ghost buttons) or the control's
   own hover. Never `transition-all`, and nothing lifts or casts a shadow.
2. **Press is physical.** A control under the finger dips to `scale(0.97)` in
   `duration-press` (the `.pressable` class, or `Pressable` / `Button`, which
   already do it). Large surfaces (cards, panels, rows) do not scale; they
   press tonally instead. `Pressable kind="row"` steps to `bg-secondary` while
   held, the pressed tone `.control-neu` and the ghost `IconButton` use. A
   component that declares its own `transition` after `.pressable` in the
   same layer replaces the class's list, so it must name `transform` on
   `--dur-press` itself or the dip snaps.
3. **Focus is visible and quiet.** The global `:focus-visible` rule in
   `globals.css` is authoritative. Do not add ring offsets (they paint a
   page-coloured halo on cards and dialogs), and never remove an outline
   without replacing it. An inset ring in place of the outline is only for a
   control flush inside a clipping parent, where the outline's offset would
   be cut off (the composer's armed marks, which sit in the field's clipped
   overlay, are the example). The composer's chips, icon buttons and send
   circle draw the global outline.
4. **Floating layers arrive from their trigger.** Menus, popovers and
   selects use `data-[state=open]:animate-pop-in
   data-[state=closed]:animate-pop-out` with `origin-popper`. Tooltips use
   their own quieter pair (§2.3). Dialogs use `animate-modal-in/out`, sheets
   `animate-sheet-in/out`, scrims `animate-overlay-in/out`, and a panel that
   docks from an edge enters on `ease-drawer`. The recipes in
   `menu-recipe.ts` already carry this; use them rather than restating it.
5. **Lists are dealt, not dumped.** Rows entering together use
   `motion-safe:animate-rise-in [animation-fill-mode:backwards]` with
   `staggerDelay(i)` (or framer `stagger()`), capped at the first ~8 rows.
6. **Disclosure is continuous.** A caret rotates with `transition-transform
   duration-base ease-in-out`. Content expands through `grid-rows-[0fr]` to
   `grid-rows-[1fr]` or framer `layout`, never an instant `hidden`. `Collapse`
   (§2.3) does the second part for you.
7. **State swaps cross-fade.** Copy to check, play to pause, send to stop: the
   two glyphs overlap and swap opacity plus a small scale (0.8 to 1) in
   `duration-fast` rather than one replacing the other in a frame. Use
   `IconSwap` (§2.3); do not write another.
8. **Only `transform` and `opacity` travel.** Colour may cross-fade. Width,
   height, top and left never animate (use `grid-rows`, `scale` or framer
   `layout`).
9. **Loops are for live state only.** Thinking, streaming and recording may
   pulse. Nothing idle loops.
10. **Reduced motion is honoured everywhere.** `motion-safe:` /
    `motion-reduce:` variants in CSS and `useReducedMotion()` in framer. Under
    reduced motion, travel and scale collapse and fades keep their timing.
    A framer subtree mounted outside `AppShell` needs its own
    `<MotionConfig reducedMotion="user">` (the settings modal has one). Rules
    that must beat a Tailwind utility under the preference go in the
    unlayered block at the end of `globals.css`, never in `@layer base`,
    where every utility outranks them: that is where `animate-spin` becomes a
    slow fade in place and `animate-ping` / `animate-pulse` stop.

### 2.3 What already exists
Use these rather than building them again.

- **`IconSwap` and `IconSwapSet`** (`src/components/ui/icon-swap.tsx`), the
  only glyph cross-fade in the product (five copies were folded into it).
  `<IconSwap swapped from to />` holds two glyphs in one grid cell and trades
  opacity plus the 0.8 to 1 scale in `duration-fast`. `curve="soft"` (the
  default) moves both faces on `ease-out-soft`; `curve="spring"` lands the
  arriving face on `ease-spring` while the leaving one exits on `ease-in` (the
  transcript and the design editor use it). `<IconSwapSet glyphs show
  spinning />` is the same slot for three or more states keyed by name, with
  an optional spinner key that turns while shown and pauses where it stands
  as it fades out. Both are `aria-hidden` (the control owns the name and says
  the state in it), hook-free and server-safe, and put the transition on a
  wrapper so the glyph's own articulation still plays. The Mac design
  editor's stylesheet is built from a separate Tailwind scan
  (`scripts/build-design-editor.mjs`) that lists this file; keep it listed if
  the file moves.
- **`variants.swap`** (`src/lib/motion.ts`) for the same swap in framer, when
  the faces mount and unmount under `AnimatePresence` (both in one grid cell,
  `mode="sync"` or `"popLayout"`): the same 0.8 scale, in on `transition.fast`,
  out on `ease-in` in `duration-fast`.
- **`Collapse`** (`src/components/ui/collapse.tsx`). `<Collapse open={x}>` in
  place of `{x && ...}`: the content unfolds through `grid-template-rows` 0fr
  to 1fr on the symmetric curve with a short fade, folds back before it
  unmounts, and mounts nothing while closed. Padding and borders go in
  `innerClassName`, never on the grid item, or they become the height it
  folds to. Reduced motion snaps the rows and keeps the fade.
- **`Button loading`**. Pass `loading` (true or false; leave it off and the
  children render as before) and the label stays in the box at zero opacity
  while a spinner fades in over it, so the button keeps its width. While
  loading it is `disabled` and `aria-busy` but not dimmed: working is not
  unavailable. Not available with `asChild`.
- **Tooltip motion and timing.** `TooltipContent` enters with
  `animate-tooltip-in` (on `data-[state=delayed-open]`) and leaves with
  `animate-tooltip-out`: a 2px drift toward the trigger and a 0.97 start in
  `duration-fast`, no spring, out on `ease-in`. Do not give a tooltip
  `animate-pop-in`. `TooltipProvider` defaults to `delayDuration` 300 and
  `skipDelayDuration` 400: once one tooltip has opened, the next trigger
  inside that window opens at once with no entrance (`instant-open`), which
  is what makes a row of icon buttons quick to scan. The app shell passes its
  own `delayDuration`.
- **Tooltips on icon-only buttons.** Wrap the button:
  `<Tooltip><TooltipTrigger asChild><IconButton label="Copy" title="">`
  and a `TooltipContent` beside the trigger. `IconButton` stays a plain button
  so it can also be a menu or popover trigger; when it is both, put the menu
  trigger outside the tooltip trigger so `data-state` stays the menu's.
  `label` is required and is the accessible name; pass `title=""` when the
  designed tooltip replaces the native one.

## 3. What a premium surface looks like here
- One accent, used for state and the primary action only.
- Hairline edges (`border-border`, or `border-foreground/10` on floating
  layers), tonal fills for state, `--shadow-float` only on layers that leave
  the page.
- Radii from the ladder only (`rounded-control`, `rounded-field`,
  `rounded-menu`, `rounded-card`, `rounded-panel`, `rounded-full`). ESLint
  rejects arbitrary values.
- Stacking from the four named rungs only (`z-popper`, `z-modal`,
  `z-toolbar`, `z-toast`).
- Empty, loading and error states are designed: a single muted glyph (size-5
  or size-6) in a quiet tile, one sentence, one action. Skeletons match the
  shape of what they stand in for.
- Hit targets are at least 32px on pointer devices and 44px under `coarse:`.
- Every icon-only button has an `aria-label` and a tooltip (§2.3).
