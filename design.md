# Juno — Design System & Liquid Glass Adaptation

> **Purpose of this file.** Give an AI agent everything needed to rebuild Juno's
> interface **with the same look, feel, and personality**, but with components
> re-materialised in Apple's **Liquid Glass**. Every token below is the *real*
> value from this codebase (`src/app/globals.css`, `tailwind.config.ts`,
> `src/app/layout.tsx`, `src/components/**`), not an approximation.
>
> **The one-line brief:** keep Juno's warm-paper / warm-charcoal editorial soul
> exactly as it is — coral accent, Newsreader serif, dot signature, calm flat
> reading surfaces — and let a *few* pieces of **chrome** float above it as
> warm-tinted glass. Glass is the garnish, never the plate.

---

## 0. Prime directives (read before touching anything)

1. **Preserve the identity.** Warm paper (light) / warm charcoal (dark), coral
   primary, editorial serif, dot/ASCII signature, mono metadata, film grain.
   None of this changes. Glass is layered *onto* it.
2. **Glass is warm, never blue-grey.** System/CSS glass defaults to cool grey.
   Every glass surface here carries a warm tint pulled from `--card` / `--popover`
   (or coral for active state). Audit new glass against a warm reference.
3. **Glass is for chrome only.** Toolbars, tab/nav bars, popovers, menus,
   selects, sheets, command palette, chips, floating controls, the composer's
   floating affordances. **Never** the chat transcript, message bodies, long-form
   text, or dense tables — those stay flat, opaque, and calm.
4. **Contrast with calm.** Large flat warm fields, a few glass surfaces floating
   above. Glass everywhere destroys hierarchy and reads as generic system chrome.
5. **The coral accent, serif, and dot signature are fixed anchors.** Glass may
   *tint* toward coral sparingly; it never *replaces* coral, and the serif and
   dots are never rendered as glass.
6. **Accessibility is not optional.** Every custom glass surface gates on Reduce
   Transparency (→ solid warm fill), Increase Contrast (→ stronger warm borders /
   full-contrast text), and Reduced Motion (→ no shimmer/morph). Details in §7.

---

## 1. The soul — identity that must survive the redesign

### 1.1 Color system (HSL, theme-aware)

All colors are CSS variables in `hsl(H S% L%)` form, defined for `:root` (light)
and `.dark`. **Never hardcode hex in components.** Values are exact.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `48 33% 97%` | `28 9% 9%` | Page — warm paper / warm charcoal |
| `--foreground` | `30 3% 12%` | `45 24% 93%` | Default text |
| `--card` | `0 0% 100%` | `28 7% 12.5%` | Card / surface fill |
| `--card-foreground` | `30 3% 12%` | `45 24% 93%` | Text on cards |
| `--popover` | `0 0% 100%` | `28 6% 18%` | Menu / popover fill |
| `--popover-foreground` | `30 3% 12%` | `45 24% 93%` | Text in popovers |
| `--primary` | `15 54% 51%` | `15 54% 51%` | **Coral** — the accent (see §1.2) |
| `--primary-foreground` | `0 0% 100%` | `0 0% 100%` | Text on coral (white) |
| `--secondary` | `50 23% 95%` | `30 7% 15%` | Secondary fills |
| `--secondary-foreground` | `30 3% 18%` | `45 22% 90%` | Text on secondary |
| `--muted` | `50 23% 95%` | `30 7% 15%` | Muted bg (skeleton, disabled) |
| `--muted-foreground` | `40 4% 40%` | `37 7% 63%` | Secondary labels, help text |
| `--accent` | `48 28% 92%` | `28 6% 18%` | Accent bg (hover/highlight) |
| `--accent-foreground` | `30 3% 18%` | `45 22% 90%` | Text on accent |
| `--destructive` | `11 51% 50%` | `11 51% 56%` | Error / destructive |
| `--destructive-foreground` | `0 0% 100%` | `0 0% 100%` | Text on destructive |
| `--success` | `140 33% 46%` | `140 33% 53%` | Success (green) |
| `--warning` | `40 57% 51%` | `40 60% 58%` | Warning (amber) |
| `--source` | `187 62% 34%` | `187 58% 49%` | Source / info (teal) |
| `--border` | `43 23% 88%` | `30 6% 21%` | Default borders |
| `--input` | `43 23% 85%` | `30 6% 24%` | Input fill |
| `--ring` | `15 54% 51%` | `15 54% 51%` | Focus ring (= accent) |
| `--sidebar` | `50 23% 95%` | `28 10% 7.5%` | Sidebar bg |
| `--sidebar-foreground` | `40 4% 30%` | `37 7% 70%` | Sidebar text |
| `--sidebar-border` | `43 23% 88%` | `28 7% 16%` | Sidebar border |
| `--sidebar-accent` | `48 28% 91%` | `30 8% 14%` | Sidebar active/hover |

**Swappable accent** (set at runtime via `[data-accent]` on `<html>`; drives
`--primary` + `--ring`). Coral is the default. When an accent value is the same
in both themes, `--primary-foreground` is unified.

| Accent | `--primary` light | `--primary` dark | `--primary-foreground` |
|---|---|---|---|
| `coral` (default) | `15 54% 51%` | `15 54% 51%` | `0 0% 100%` (both) |
| `teal` | `180 63% 33%` | `187 58% 49%` | white / `40 6% 10%` |
| `violet` | `249 59% 64%` | `249 66% 71%` | white / `40 6% 10%` |
| `amber` | `39 67% 55%` | `38 73% 63%` | `30 40% 12%` / `30 40% 10%` |
| `sage` | `120 18% 52%` | `120 23% 61%` | white / `40 6% 10%` |

**Texture atoms that make it feel physical:**
- **Text selection:** `background: hsl(var(--primary) / 0.25)`, `color: hsl(var(--foreground))` — branded, readable in both themes.
- **Film grain:** `body::after`, fixed, `opacity: 0.022`, an SVG `feTurbulence` fractal-noise tile. Quiet, non-interactive, `z-index: 70`, `pointer-events: none`. It's the subliminal "paper" cue — keep it.

### 1.2 Typography

Two families only. **Newsreader is the whole UI**; JetBrains Mono is metadata/code.

- `--font-serif` → **Newsreader** (variable, `next/font/google`, optical sizing on). Fallbacks: `Source Serif 4, Georgia, serif`.
- `--font-mono` → **JetBrains Mono** (variable). Fallbacks: `ui-monospace, SFMono-Regular, monospace`.
- Tailwind `font-sans` **and** `font-serif` both resolve to Newsreader on purpose (the UI is serif-first). `font-mono` is JetBrains Mono.
- `<body>`: `font-family: var(--font-serif)`, `font-optical-sizing: auto`, `-webkit-font-smoothing: antialiased`, `text-rendering: optimizeLegibility`.

**Type scale** (size / line-height / letter-spacing / weight). Contrast comes
from **family + 3× size jumps**, not heavy weights.

| Token | Size | Line-height | Tracking | Weight | Use |
|---|---|---|---|---|---|
| `text-hero` | `clamp(2.4rem, 5vw, 4rem)` | 1.1 | -0.02em | — | Empty-state hero |
| `text-display` | `clamp(2rem, 4vw, 3rem)` | 1.08 | -0.02em | 500 | Page display heading |
| `text-title` | `1.375rem` (22px) | 1.25 | -0.012em | 600 | Section title |
| `text-heading` | `1.125rem` (18px) | 1.3 | -0.006em | 600 | Subsection heading |
| `text-body-lg` | `1.0625rem` (17px) | 1.6 | — | 400 | Large body |
| `text-body` | `0.9375rem` (15px) | 1.6 | — | 400 | Default body / prose |
| `text-label` | `0.75rem` (12px) | 1.4 | 0.14em | 500 | **Eyebrow — size only** |
| `text-caption` | `0.6875rem` (11px) | 1.45 | 0.02em | — | **Caption — size only** |

> **Eyebrow rule:** `text-label` / `text-caption` set size only. For the real
> metadata voice, pair them with `font-mono uppercase`. Examples in the wild:
> `MEMORY`, `THINKING`, `WRITING`, `SOURCE`, `TOKENS`, `EDIT`.

### 1.3 Motion

Three easings, three (+one) durations. Mirrored as CSS vars and Tailwind utilities.

| Token | Value | Use |
|---|---|---|
| `ease-spring` | `cubic-bezier(0.32, 0.72, 0, 1)` | Snappy feedback, `rise-in` |
| `ease-out-soft` | `cubic-bezier(0.33, 1, 0.68, 1)` | Default UI transitions |
| `ease-out-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` | Overlays, sheen sweep |
| `duration-fast` | `120ms` | Press feedback, removals |
| `duration-base` | `220ms` | Hover/focus/state transitions |
| `duration-slow` | `360ms` | Dialog entrance, emphasis |
| `--dur-flash` | `4000ms` | Auto-dismiss (toast) |

Named animations to preserve: `rise-in` (translateY(8px)→0 + fade, spring —
entrance for messages/chips), `pop-in`/`pop-out` (overlays: 180ms expo /
120ms soft), `overlay-in`/`overlay-out` (backdrop fade), `title-in`/`title-out`,
and the thinking cluster `dot-think` (2.1s) / `dot-tint` (3.4s) / `dot-breathe`
(5.6s) — deliberately out of phase so it never reads as a loop.

### 1.4 Radius scale

| Class | Value | Use |
|---|---|---|
| `rounded-sm` | 4px | Tiny inline elements |
| `rounded-md` | 8px | Menu/select items, tooltip, tabs content |
| `rounded-lg` (`--radius`) | **24px** | Cards, large surfaces |
| `rounded-panel` | **28px** | Floating layers (composer, command palette, sheets) |
| `rounded-xl` | (Tailwind default) | Buttons, inputs |
| `rounded-[18px]` | 18px | Popovers |
| `rounded-[14px]` | 14px | Dropdown/select content, tabs list |
| `rounded-[10px]` | 10px | Small buttons, tabs trigger, dialog close |
| `rounded-full` | pill | Badges, switch, avatar, icon buttons |

**Concentricity:** nested radii follow *outer = inner + padding*. Keep to this
scale; don't invent arbitrary radii.

### 1.5 Elevation & the "depth kit"

Theme-aware shadows (values differ light/dark — warm, low-throw, with a 1px
inner top-highlight on floats):

- `shadow-soft` — subtle ambient (small cards).
- `shadow-float` — floating panels; includes inset top sheen.
- `shadow-glass` — frosted floating layers (menus, palette); crisp rim + deep throw.
- `shadow-pop` — crisp shadow for buttons/chips.
- `shadow-glow-primary` — colored halo driven by `--primary` (CTAs).
- `shadow-well` (`--well-inset`) — recessed inset for inputs.

Composed utility classes (the "lighting model" — one light source above, warm
ambient below). **These are the seed of the glass look; §3 evolves them:**

| Utility | Composes | Applied to |
|---|---|---|
| `.surface-raised` | top sheen gradient + hairline inset + `shadow-soft` | Cards, raised panels |
| `.btn-glossy` | white specular top-highlight gradient | Primary buttons |
| `.halo-primary` | inset rim + `--glow-primary` | Primary buttons (with `.btn-glossy`) |
| `.field-well` | `--well-inset` | Inputs, textareas, tabs track |
| `.glass-raised` | `inset 0 1px 0 hsl(var(--sheen))` + `shadow-glass` | **Floating layers → the glass anchor** |
| `.sheen-sweep` | one-way diagonal highlight on hover (620ms expo) | Primary buttons, interactive cards |
| `.skeleton` | warm base + primary-tinted shimmer | Loading states |
| `.scroll-fade-y` | alpha mask, 18px fade top/bottom | Scrollable text |
| `.text-shimmer` | primary band sweeps across mono label | Streaming eyebrow labels |

Depth-kit color vars: `--sheen` (`0 0% 100% / 0.55` light, `45 40% 96% / 0.06`
dark — warm white, **this is the specular highlight; reuse it for glass, don't
swap in a cool white rim**), `--hairline` (`30 12% 18% / 0.06` light,
`45 24% 93% / 0.08` dark).

### 1.6 Signature language & product voice

- **Dot / ASCII constellation** across scales: `ThinkingDots` (5-dot breathing
  cluster, the "Juno is thinking" affordance), `DotMatrixMark` (5×5 logo),
  `DotIdenticon` (deterministic avatars), `DotFillBar` (progress), `AsciiHero`
  (orbital-sun empty-state graphic, `drift` 18s), `DotField` (interactive
  background grid), `DottedDivider` (whisper-quiet editorial rule with optional
  mono label). Dots are **never static** — breathing is the resting state.
  Coral is the only saturated color in dot systems.
- **Voice:** calm, direct, non-corporate. Actions are short verbs (`Copy`,
  `Edit`, `Regenerate`, `Try again`), no gerunds/marketing. Reassuring
  empty/error copy ("Juno can be wrong — worth a second look on anything that
  matters."). Metadata is mono + uppercase.
- **`.pressable`** press feedback (`active:scale-[0.97]`, fast + out-soft) on
  small interactive elements; large surfaces **lift** (`hover:-translate-y-0.5`)
  instead of scaling.
- **Touch:** `coarse:` variant bumps hit areas to ≥44px (`coarse:h-11`).
- **Safe-area:** `pt-safe` / `pb-safe` / `pl-safe` / `pr-safe` for iOS notch /
  home-indicator on full-bleed surfaces.

### 1.7 THE FLAT-TRANSCRIPT LAW (hard-won, do not break)

> Depth, gloss, and now **glass** are for **chrome and controls only**. The chat
> transcript / reading content stays **minimal and flat** — ChatGPT-clean.
> - User messages: plain text in a simple rounded container. No syntax
>   highlighting, no gloss.
> - Assistant messages: markdown prose only; code blocks get sparse chrome
>   (header + border + minimal theme-aware highlighting), nothing else.
> - Metadata (tokens, finish reason, sources) sits *below*, mono + muted.
> - **Zero** `.btn-glossy` / `.halo-primary` / `.sheen-sweep` / glass inside
>   message content.
> - `ThinkingDots` + phase label show **only** while streaming with no content
>   yet; the moment content arrives they're swapped out (never both at once).

This law is the reason the glass version stays legible and calm. It is also what
keeps glass *performant* (§6): the constantly-scrolling message list has no
backdrop-filter, so the few glass chrome surfaces are affordable.

---

## 2. Liquid Glass — what it actually is

Apple's Liquid Glass (iOS/iPadOS/macOS 26, WWDC 2025) is **one dynamic
material**, not a static blur. Five real behaviors:

1. **Refraction / lensing** of content behind it, strongest at the edges.
2. **Specular edge highlight** that traces the contour and shifts with motion.
3. **Adaptivity / vibrancy** — samples the background luminance/color and adjusts
   tint, shadow, and light/dark appearance in real time.
4. **Concentricity** of nested corner radii.
5. **Strict layering** — glass is the functional/navigation layer that floats
   *above* content; it is never the content itself.

**Two variants, never mixed on one surface:**
- **Regular** — medium translucency, full adaptivity, legible over anything. The
  house default; use for essentially all chrome.
- **Clear** — high transparency, minimal adaptivity, needs its own dimming scrim.
  Only over bright full-bleed media. **In a warm reading app, clear is almost
  never correct — default to regular.**

**Our warm-glass override:** every glass surface carries a low-opacity **warm**
wash (paper in light, warm-charcoal in dark, from `--card` / `--popover`), and
reuses Juno's existing warm specular highlight (`--sheen`) — *not* a cool system
rim. Coral may tint glass only for active/selected chrome.

---

## 3. The warm-glass material (how to build it)

Juno already ships a credible warm-glass approximation on the web
(`.glass-raised` + `bg-popover/80` + `backdrop-blur-xl` on popovers, selects,
dropdowns, dialogs, toasts). The redesign **formalises and extends** that; it
does not reinvent it.

### 3.1 Web / CSS recipe

Build every glass surface from these five layers, all using existing tokens:

```css
.glass {
  /* 1. blur + saturate — saturate keeps warm content vibrant through the pane */
  backdrop-filter: blur(20px) saturate(1.25);            /* ~ backdrop-blur-xl */
  -webkit-backdrop-filter: blur(20px) saturate(1.25);

  /* 2. warm tint (identity-critical — NOT neutral) */
  background: hsl(var(--popover) / 0.80);                 /* chrome: card/popover token */

  /* 3. warm specular top highlight + frosted throw (reuse Juno's own recipe) */
  box-shadow: inset 0 1px 0 hsl(var(--sheen)), var(--shadow-glass);

  /* 4. warm hairline border */
  border: 1px solid hsl(var(--border) / 0.60);

  /* 5. concentric radius from the scale (panel/18/14/full) */
  border-radius: 18px;
}

/* active/selected chrome only — a faint coral edge, never on reading surfaces */
.glass--active {
  border-color: hsl(var(--primary) / 0.45);
  box-shadow: inset 0 1px 0 hsl(var(--sheen)), var(--glow-primary);
}
```

- **Skip `feDisplacementMap`.** True edge-lensing via SVG displacement is
  expensive, flickers on scroll, breaks across browsers' backdrop compositing,
  and is tonally wrong for a calm app. The blur+saturate+sheen stack reads as
  glass without it. (At most, one *static* hero showpiece — never chrome.)
- **Concentric radii on web:** panels `rounded-panel` (28) / cards `rounded-lg`
  (24) / popovers `rounded-[18px]` / menus & selects `rounded-[14px]` / chips
  `rounded-full`, outer = inner + padding.

### 3.2 SwiftUI native recipe

Availability: iOS/iPadOS/macOS(Tahoe)/watchOS/tvOS/visionOS **26**, Xcode 26.
**Gate every glass call and always fall back.**

Core: `.glassEffect(_:in:isEnabled:)`. Default `.glassEffect()` == `.regular` in
a `Capsule`. Pass a shape and warm tint:

```swift
// Warm regular glass on a concentric rounded rect
.glassEffect(.regular.tint(Color("PaperGlass")),
             in: .rect(cornerRadius: 18))

// Active/selected chrome — coral tint, sparingly
.glassEffect(.regular.tint(Color("Coral").opacity(0.18)), in: shape)

// Interactive control (press scale / shimmer / touch illumination)
.glassEffect(.regular.interactive(), in: Capsule())

// Toggle off without relayout
.glassEffect(isEnabled ? .regular : .identity, in: shape)
```

- **Grouping / morphing:** wrap clusters (e.g. composer action buttons) in
  `GlassEffectContainer(spacing: 16) { … }`. Glass can't sample glass — the
  container gives them a shared sampling region and lets them merge/split fluidly.
- **Fluid transitions:** `@Namespace var ns` + `.glassEffectID("send", in: ns)`
  so a control can morph into an expanded panel/sheet and back.
  `glassEffectUnion` fuses adjacent shapes into one blob when wanted.
- **Buttons:** `.buttonStyle(.glass)` for secondary chrome; `.glassProminent`
  for the *single* primary action, tinted coral (`.tint(.coral)`) so the accent
  survives. One prominent action per context.
- **Concentric shapes:** `RoundedRectangle(cornerRadius: .containerConcentric,
  style: .continuous)` so nested glass aligns to the container/window radius.
- **Free system chrome (still verify warmth + tint it):** toolbars,
  `NavigationStack` bars, `TabView` (`.tabBarMinimizeBehavior(.onScrollDown)`,
  `.tabViewBottomAccessory { }`), `.sheet` + `.presentationDetents`, popovers,
  menus.

**Reusable warm-glass modifier with graceful fallback** (matches Juno's existing
frosted look on older OSes, solid warm fill under Reduce Transparency):

```swift
extension View {
  @ViewBuilder
  func warmGlass(in shape: some Shape = Capsule(), tint: Color? = nil) -> some View {
    if #available(iOS 26, macOS 26, *) {
      self.glassEffect(tint.map { .regular.tint($0) } ?? .regular, in: shape)
    } else {
      self.background(shape.fill(.ultraThinMaterial))                    // frosted
          .overlay(shape.fill((tint ?? Color("PaperGlass")).opacity(0.14))) // warm
          .overlay(shape.strokeBorder(Color.white.opacity(0.18)))        // sheen rim
    }
  }
}
```

> Define `Paper`, `Card`, `PaperGlass`, `Coral` as asset-catalog colors with the
> §1.1 HSL values converted to sRGB, each with a light + dark appearance, so the
> whole app is theme-driven exactly like the CSS vars.

---

## 4. Component-by-component: current → glass

Juno's primitives already lean into this — the "floating layer" family
(`.glass-raised` + `backdrop-blur-xl`) *becomes* true Liquid Glass; the "reading"
and "field" families mostly stay as-is. For each: current anatomy, and the glass
treatment.

| Component | Current (radius / key material) | Glass treatment |
|---|---|---|
| **Button — primary** | `rounded-xl`, `.btn-glossy` + `.halo-primary` + `.sheen-sweep`, `hover:brightness-[1.06]`, `active:scale-[0.97]` | The **one** prominent glass action: native `.buttonStyle(.glassProminent).tint(.coral)`; web keeps `.btn-glossy`+`.halo-primary` (already glassy). Keep coral fill — do not turn the primary into clear glass. |
| **Button — secondary / outline / ghost** | `rounded-xl` / `rounded-[10px]`, subtle fills, no gloss | Secondary chrome buttons → `.buttonStyle(.glass)` (native) / `.glass` warm recipe (web). Ghost stays hover-only (no glass) inside transcripts. |
| **Card** | `rounded-lg` (24px), `.surface-raised`, interactive variant lifts + glows | **Stays a solid warm surface.** Cards hold content/reading — keep `.surface-raised`. Only *floating* cards (command palette, sheets) go glass. |
| **Input / Textarea** | `rounded-xl`, `.field-well` (recessed), `focus-visible:ring-[3px] ring-ring/25` | **Stay recessed wells, not glass** (you type *into* them). Keep `.field-well`. The composer *container* around them may float as glass; the fields stay opaque. |
| **Badge / chip** | `rounded-full`, mono 11px, solid variants get sheen inset; `soft` = primary/12 | Interactive/floating chips (upload, project, filter) → warm glass capsule (`.glassEffect(in: Capsule())`). Static status badges stay flat tinted. |
| **Dialog / Sheet** | Content `rounded-panel`, `bg-card/85` + `backdrop-blur-xl`; overlay `bg-black/40 backdrop-blur-md` | Content → regular warm glass (native `.sheet` + `.presentationDetents`; web `.glass` at panel radius). Keep the dimmed blurred backdrop. Close button stays a `rounded-full` glass icon control. |
| **DropdownMenu** | Content `rounded-[14px]`, `bg-popover/80` + `.glass-raised` + `backdrop-blur-xl`; items `rounded-md focus:bg-accent` | Already glass — promote to native menu glass. Items stay flat with `bg-accent` hover; gradient separators kept. |
| **Popover** | `rounded-[18px]`, `bg-popover/80` + `.glass-raised` + `backdrop-blur-xl`, `pop-in`/`pop-out` | Direct → warm regular glass. Keep `origin-popper` so scale anchors to trigger. |
| **Select** | Trigger `rounded-xl` `.field-well`; content `rounded-[14px]` `.glass-raised` | Trigger stays a field-well (input family); the **dropdown content** is glass. |
| **Switch** | `rounded-full`; unchecked `.field-well`, checked `.btn-glossy bg-primary` + pop thumb | Keep as-is — it's a control with its own gloss/coral. Native `Toggle` picks up glass automatically; keep the coral checked state. |
| **Tabs** | List `rounded-[14px]` `.field-well` (recessed track); active trigger `bg-card` + sheen inset | List can become a glass segmented control (native `.glass`); active pill stays a warm raised chip. Nav tab bars → native `TabView` glass. |
| **Avatar** | `rounded-full`, `ring-inset` hairline | No glass. Identity element — keep the hairline ring (and `DotIdenticon` fallback). |
| **Separator** | 1px gradient fade (`from-transparent via-border`) | No glass. Editorial divider — unchanged. |
| **Toast (Sonner)** | `rounded-[16px]`, `bg-popover/85` + `backdrop-blur-xl` + `shadow-glass` | Direct → warm regular glass, floating. |
| **Tooltip** | `rounded-md`, inverse `bg-foreground` | No glass (tiny, high-contrast). Unchanged. |
| **Top bar / Nav / Tab bar** | app chrome | Prime glass surfaces — native toolbars / `NavigationStack` / `TabView`, warm-tinted, `.onScrollDown` minimize. |
| **Composer** | floating, `rounded-panel`, `shadow-float`, inset sheen | The floating *shell* is warm glass; the textarea + send/model controls inside stay their own materials (field-well input, coral send). Group the action buttons in a `GlassEffectContainer`. |
| **Message list / transcript** | flat, opaque, no backdrop-filter | **NEVER glass** (§1.7). Stays flat warm. This is load-bearing for legibility *and* scroll performance. |
| **Signature (dots, dividers, hero, orb)** | coral + muted, breathing | **Never glass, never recolored.** Fixed identity anchors that float *over* or *beside* glass, not as it. |

---

## 5. Where glass goes — and where it must not

**Glass (chrome / controls / floating):** top bar, nav bar, tab bar, toolbars,
popovers, menus, select dropdowns, dialogs & sheets, command palette, toasts,
the composer shell, interactive chips, secondary chrome buttons, the one
prominent coral action.

**Never glass (reading / identity / fields):** chat transcript & message bodies,
long-form or dense text, tables, cards that hold content, text inputs/textareas
(recessed wells), avatars, separators, and the entire dot/ASCII signature.

Rule of thumb: *if text is read inside it for more than a glance, it's not
glass.* Glass carries short labels, icons, and controls only.

---

## 6. Performance (a chat app scrolls constantly)

- **Cap live backdrop-filters** to **one per visual stack**. Never nest glass
  popover → glass bar → glass sheet. Native: one `GlassEffectContainer`.
- **The message list stays opaque** — no `backdrop-filter`. (Today the chat
  header uses `bg-card/45 backdrop-blur-md` but the list itself is flat; keep it.)
- `will-change: backdrop-filter` only on *persistent* chrome (top bar), never on
  transient popovers.
- Web fallback: `@supports not (backdrop-filter: blur(1px)) { … solid warm fill }`.
- Each `feDisplacementMap` is a per-frame GPU cost — don't (§3.1).

---

## 7. Accessibility (gate every custom glass surface)

| Setting | Native | Web | Behavior |
|---|---|---|---|
| **Reduce Transparency** | `@Environment(\.accessibilityReduceTransparency)` | `@media (prefers-reduced-transparency: reduce)` | Drop **all** blur/translucency → **solid warm fill** (`Color("Card")` / `hsl(var(--card))` at full opacity). Keep the warm hue — never fall back to grey/white. |
| **Increase Contrast** | system strengthens borders | `@media (prefers-contrast: more)` | Hairline → solid `hsl(var(--border))`; text → full `--foreground`; drop decorative sheen. |
| **Reduced Motion** | `@Environment(\.accessibilityReduceMotion)` | `@media (prefers-reduced-motion: reduce)` | Disable specular shimmer, tilt highlights, `.interactive()` bounce, glass morphs → plain fade. (Juno already uses `motion-safe:` + kills sheen-sweep/shimmer here.) |

**Contrast-over-glass throughline:** never put long-form or dense text directly
on live glass. Reading text lives only on flat opaque warm surfaces. On chrome,
glass carries short labels/icons only, and the warm tint + `--sheen` highlight
keep them legible as the background scrolls. If a label risks dropping below
WCAG AA (4.5:1 body / AA chrome) over glass, add a local scrim or fall back to a
solid chip — don't trust adaptivity alone.

Also keep: focus ring `2px solid hsl(var(--ring))`, 2px offset; primary-tinted
text selection; `-webkit-tap-highlight-color: transparent`; thin theme-aware
scrollbars.

---

## 8. Pitfalls checklist (review new glass against this)

- [ ] **Warm, not blue-grey.** Every glass surface carries a `--card`/`--popover`
      (or coral) tint. Audited against a warm reference.
- [ ] **No glass on the transcript / reading content.** Messages, article bodies,
      dense text stay flat opaque.
- [ ] **No glass-on-glass.** One `GlassEffectContainer` (native) / one live
      backdrop-filter per stack (web).
- [ ] **Not overused.** Large flat warm fields with a few floating glass surfaces.
- [ ] **Regular, not clear** (clear only on full-bleed media, with a scrim).
- [ ] **Coral/serif/dots untouched** — tint is selective; identity anchors never
      become glass.
- [ ] **Concentric radii** from the 28/24/18/14/full scale (outer = inner + gap).
- [ ] **Accessibility fallbacks present** — Reduce Transparency → solid warm,
      Increase Contrast → stronger warm borders, Reduced Motion → no shimmer/morph.
- [ ] **Availability gated** (native `#available(iOS 26)` → `.ultraThinMaterial`
      → solid warm under Reduce Transparency).
- [ ] **Performance** — message list opaque, filters capped, `will-change` only
      on persistent chrome.
- [ ] **Reuse `--sheen`** for the specular highlight — no cool white rim.

---

## 9. Build order (suggested)

1. Port the **color tokens** (§1.1, incl. accents) into asset-catalog colors /
   CSS vars, with light + dark. Wire film grain + selection.
2. Set up **type** (Newsreader + JetBrains Mono) and the scale (§1.2).
3. Establish **motion + radius + depth-kit** tokens (§1.3–1.5).
4. Rebuild the **flat reading surfaces first** (transcript, cards, inputs) — prove
   the calm editorial base before any glass.
5. Add the **`warmGlass` primitive** (§3) and apply it to **chrome only** in the
   §4 order: nav/tab/top bars → popovers/menus/selects → sheets/dialogs → toasts
   → composer shell → chips.
6. Layer the **signature** (dots, dividers, hero, orb) over the top.
7. Run the **§8 checklist** and the **§7 accessibility** passes on every glass
   surface.

*Golden test:* screenshot the result next to the current Juno. It should read as
the same app — same warmth, same serif, same coral, same calm — with its chrome
now catching light like glass. If the glass reads cool, generic, or is anywhere
near the reading text, it's wrong.
