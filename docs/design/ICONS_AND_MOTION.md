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
- The shared registries in `src/lib/app-icons.ts` (`AppIcons`, `CodeIcons`,
  `ComposerIcons`, `StatusIcons`, `ActionIcons`, `DesignIcons`,
  `SettingsIcons`) still come first. One concept, one drawing.
- **Never hand-draw an interface icon** (an inline `<svg>` of a chevron, a
  check, a spinner, a plus, …). Exempt: brand and product logos (connector
  logos, the GitHub mark, model-lab marks, the Juno mark), data visualisation
  (charts, sparklines, progress rings), the dot-matrix signature, and the
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
  status colour.

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

Carets, spinners and status marks carry none. If a gesture is wrong in context
(for example an arrow that is a label rather than an action), pass
`motion="none"`. On a custom clickable container that is not a
button or link, add `data-icon-trigger` so its icon plays.

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
   already do it). Large surfaces (cards, panels) do not scale.
3. **Focus is visible and quiet.** The global `:focus-visible` rule in
   `globals.css` is authoritative. Do not add ring offsets (they paint a
   page-coloured halo on cards and dialogs), and never remove an outline
   without replacing it.
4. **Floating layers arrive from their trigger.** Menus, popovers, selects
   and tooltips use `data-[state=open]:animate-pop-in
   data-[state=closed]:animate-pop-out` with `origin-popper`. Dialogs use
   `animate-modal-in/out`, sheets `animate-sheet-in/out`, scrims
   `animate-overlay-in/out`. The recipes in `menu-recipe.ts` already carry
   this; use them rather than restating it.
5. **Lists are dealt, not dumped.** Rows entering together use
   `motion-safe:animate-rise-in [animation-fill-mode:backwards]` with
   `staggerDelay(i)` (or framer `stagger()`), capped at the first ~8 rows.
6. **Disclosure is continuous.** A caret rotates with `transition-transform
   duration-base ease-in-out`. Content expands through `grid-rows-[0fr]` to
   `grid-rows-[1fr]` or framer `layout`, never an instant `hidden`.
7. **State swaps cross-fade.** Copy to check, play to pause, send to stop: the
   two glyphs overlap and swap opacity plus a small scale (0.8 to 1) in
   `duration-fast` rather than one replacing the other in a frame.
8. **Only `transform` and `opacity` travel.** Colour may cross-fade. Width,
   height, top and left never animate (use `grid-rows`, `scale` or framer
   `layout`).
9. **Loops are for live state only.** Thinking, streaming and recording may
   pulse. Nothing idle loops.
10. **Reduced motion is honoured everywhere.** `motion-safe:` /
    `motion-reduce:` variants in CSS and `useReducedMotion()` in framer. Under
    reduced motion, travel and scale collapse and fades keep their timing.

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
- Every icon-only button has an `aria-label` and a tooltip.
