# Juno Soft UI — the 2026 design direction

This is the single brief every surface (web, macOS, iOS) follows from September 2026.
It replaces the "flat editorial" language described in `docs/JUNO.md` §3 where the two
disagree. The goal: Juno should feel like a product a billion-dollar company shipped —
calm, tactile, coherent, and fast — and compete head-on with ChatGPT and Claude.

## 1. Principles

1. **One material, three depths.** Everything is cut from the same warm base. Depth is
   expressed as *raised* (extruded from the page), *inset* (recessed into it), or
   *floating* (lifted above it). Nothing is a random card with a random shadow.
2. **Light comes from the top-left.** Every raised surface carries a soft light
   highlight top-left and a soft dark shadow bottom-right; every inset surface carries
   the inverse. Throws are low (2–6px offsets, 6–24px blur) — never the 2020
   "putty" look.
3. **Boundaries stay accessible.** Neumorphic shadows alone fail WCAG 1.4.11 (3:1 for
   UI boundaries). Every interactive surface *also* carries a hairline
   (`--border` at 50–70% alpha) and every primary action carries real colour.
   Text contrast is never traded for softness.
4. **The transcript stays flat.** Depth is for chrome and controls. Chat messages are
   prose on the page; user bubbles are a gently inset well. No shadows on reading
   surfaces, no glass on reading surfaces.
5. **Motion is physical.** Springs, not linear tweens. Enter with scale 0.96→1 +
   opacity; press dips to 0.97 in 70ms; nothing over 360ms except a deliberate
   one-shot emphasis (560ms). Reduced-motion drops travel, keeps opacity.
6. **Native first on Apple platforms.** iOS 26 / macOS 26 Liquid Glass stays for
   floating chrome (composer, toolbars, tab bars, menus, docks). Content is opaque.
   Soft UI on Apple shows up as tonal layering + inset wells, not CSS-style shadows.

## 2. Web tokens (globals.css)

### 2.1 Ground

| Token | Light | Dark |
|---|---|---|
| `--background` | `50 22% 96%` | `30 7% 9%` (warm charcoal — **not** true black; dual shadows need a ground) |
| `--card` | `50 30% 98%` | `30 7% 12%` |
| `--popover` | `50 30% 98.5%` | `30 7% 14%` |
| `--secondary` / `--muted` | `48 22% 93%` | `30 6% 15%` |
| `--accent` (hover fill) | `48 24% 90%` | `30 6% 18%` |
| `--border` | `46 18% 86%` | `30 6% 20%` |
| `--sidebar` | `48 20% 94%` (inset well) | `30 7% 8%` |

Foreground, primary (coral), success/warning/destructive/source stay as they are.

### 2.2 Depth kit (new, replaces the dead `.neumorphic-*` rules)

```
--neu-light   : 0 0% 100% / 0.9    (dark: 45 20% 96% / 0.07)
--neu-dark    : 46 18% 20% / 0.14  (dark: 0 0% 0% / 0.6)
--neu-dark-lg : 46 18% 20% / 0.2   (dark: 0 0% 0% / 0.72 — the large throw's denser ink)

--shadow-raised : -2px -2px 6px hsl(var(--neu-light)),  3px  4px 10px hsl(var(--neu-dark))
--shadow-raised-lg: -4px -4px 12px hsl(var(--neu-light)), 6px 8px 20px hsl(var(--neu-dark-lg))
--shadow-inset  : inset 2px 2px 6px hsl(var(--neu-dark)), inset -2px -2px 6px hsl(var(--neu-light))
--shadow-pressed: inset 1px 1px 3px hsl(var(--neu-dark)), inset -1px -1px 3px hsl(var(--neu-light))
--shadow-float  : 0 1px 2px hsl(var(--neu-dark)), 0 16px 40px -20px hsl(46 18% 20% / 0.28), inset 0 1px 0 hsl(var(--sheen))
```

Composed utilities (the only ones components may use):

| Class | Meaning | Used by |
|---|---|---|
| `.surface-raised` | `bg-card` + `--shadow-raised` + hairline | cards, composer shell, tiles, sidebar active row |
| `.surface-raised-lg` | bigger throw | hero cards, pricing, project tiles |
| `.surface-inset` | `bg-background` + `--shadow-inset` + hairline | inputs, textareas, search fields, segmented tracks, sidebar frame, user bubbles |
| `.surface-float` | `bg-popover` + `--shadow-float` + sheen (glass optional via `.overlay-glass`) | popovers, dropdowns, dialogs, toasts, tooltips, sheets |
| `.control-neu` | raised at rest → pressed inset on `:active` / `[data-state=on]` | secondary buttons, icon buttons, toggles, chips |
| `.control-primary` | coral gradient + `--glow-primary` + `--shadow-raised` | primary buttons, send |

### 2.3 Radius ladder (single source)

`control 10` · `field 12` · `card 16` · `panel 20` · `popover 16` · `menu 14` · `full`.
Concentric rule: outer radius = inner radius + padding. Remove `lg/surface` duality.

### 2.4 Motion

- Add `--ease-spring: cubic-bezier(0.34, 1.16, 0.64, 1)` and `--ease-drawer:
  cubic-bezier(0.32, 0.72, 0, 1)`. Keep the duration ladder (70/120/160/220/360/560).
- New named animations: `pop-in` (scale .96→1 + fade, 220ms spring), `rise-in`
  (translateY 6px + fade), `sheet-in` (drawer easing), `shimmer-text` (thinking
  status), `check-morph` (copy → check).
- Stagger lists with `staggerDelay()` at 30–50ms; decorative only.
- `framer-motion` `layout` for sidebar collapse, chip add/remove, model picker
  and settings section switches. Reduced-motion: opacity only.

## 3. Web components

- **Sidebar**: an inset well (`.surface-inset` frame) with raised active row.
  Structure (top→bottom): brand + collapse; search (⌘K); New chat; Projects (with
  folders collapsible); Pinned; Recents grouped by date (Today / Yesterday / Previous
  7 days / Older); footer: user + plan meter. Collapsed rail mode (icon-only, 64px)
  with tooltips. Hover/float mode on narrow widths.
- **Composer**: raised soft card; inset field; one `+` menu; mode chips above the
  field (Search, Research, Canvas, Image, Study…); `@` mentions; `/` commands;
  model + effort control left of send; send morphs to stop.
- **Messages**: user = inset well, right-aligned; assistant = flat prose; actions
  row on hover: copy (→check morph), thumbs, read aloud, regenerate ▾ (with model
  submenu), branch, share. Version pager keeps alternatives.
- **Dialogs/popovers/sheets/toasts**: all use `.surface-float`. Radius: dialog 20,
  popover/menu 16/14, toast 16, sheet 20 on the inner edge.
- **Page frame**: `AppPage` with `measure="reading" (48rem) | "wide" (64rem) | "full"`
  + `AppPageHeader` for every page. Kill the five ad-hoc `max-w-*`.
- **Settings**: one modal (ChatGPT style) with left rail sections: General,
  Personalization, Memory, Models, Connectors, Data & privacy, Account, Billing.
  `/settings` route renders the same content in a page frame.

## 4. Apple platforms

- **Depth on Apple** = tonal: `junoCanvas` ground, `junoSurface` raised tile with a
  hairline and a *very* soft shadow (`radius 10, y 3, opacity 0.05` light /
  `0.35` dark), `junoWell` inset (secondary fill + inner hairline). Glass only on
  floating chrome. Never `.thinMaterial` on a content banner.
- **Motion** = `JunoMotion` rungs only. `.navigationTransition(.zoom)` for
  card → detail, `matchedGeometryEffect` / `glassEffectID` for morphing chrome,
  `sensoryFeedback` for send / stop / copy / approve / deny / pin / delete.
- **iOS**: keep the drawer shell, but the drawer gets date-grouped recents, swipe
  actions, `.searchable`, and glass bottom bar. Content screens use native `List`
  / `Form` where the content is a list, custom cards only for hero tiles.
- **macOS Code**: three-part hierarchy — sessions column · thread · context rail.
  The thread is the object; review is a split pane beside it, never a mode swap.

## 5. Copy

Sentence case everywhere. No all-caps. Product names: "Juno", "Juno Code",
"Juno Work". Buttons are verbs. Empty states say what to do next in one line.
