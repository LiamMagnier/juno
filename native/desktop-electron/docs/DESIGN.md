# Juno Desktop — design system

The desktop does not have a design system. It has a **projection** of the web's,
and the projection is mechanical.

This document is the contract for that projection: where the values come from,
how to regenerate them, what the palette and the type mean, when a surface is
allowed to be glass, and what happens when the user asks macOS to calm things
down. It is not a style guide written from taste — every number below was read
out of the source files named beside it.

---

## 1. The pipeline

### The source of truth is on the web, and it is not moving

```
src/app/globals.css ──┐
                      ├──> scripts/generate-design-tokens.ts ──> JunoGeneratedTokens.swift   (macOS/iOS native)
tailwind.config.ts ───┤                                     └──> src/lib/design/tokens.generated.ts
                      │
                      └──> native/desktop-electron/scripts/generate-tokens.ts
                                                            └──> src/renderer/styles/tokens.css   (this app)
```

`src/app/globals.css` owns colour, motion, elevation, depth and stacking.
`tailwind.config.ts` owns the ladders that were never CSS variables: the radius
scale, the type scale, the keyframes and the animation shorthands. Both are
hand-authored, both are heavily commented, and — as the Swift generator's header
puts it — the comments beside those values are the most useful documentation in
the repository, so neither will ever be generated from something else.

**The desktop generator reads exactly those two files and nothing else.** There
is no desktop token file, no design JSON, no second opinion. This follows the
existing precedent literally: `scripts/generate-design-tokens.ts` parses
`globals.css` for colour and motion and imports `tailwind.config.ts` for the
radius ladder, and this generator does the same, aimed at CSS instead of Swift.

The existing generator's source **is** reusable, and it was reused. The only
things that could not be shared are noted under [Known gaps](#8-known-gaps).

### Regenerating

```bash
npm run tokens         # write src/renderer/styles/tokens.css
npm run tokens:check   # verify; exits 1 with a diff if the committed file is stale
```

`tokens.css` is **committed**. It has to be: the renderer builds from the
repository, not from a generator run, and a build that silently produced
different colours depending on whether someone had run a script would be the
drift this whole mechanism exists to prevent. `tokens:check` is wired into
`npm run gates` so CI fails on a stale file instead of a user's Mac failing on a
wrong colour. This mirrors `npm run design:tokens:check`, which
`.github/workflows/native.yml` already gates the Swift projection on.

`--check` prints a real diff, not just a verdict:

```
[desktop-tokens] DRIFT src/renderer/styles/tokens.css no longer matches its sources.

@@ line 45 @@  -committed  +regenerated
  ---primary: 15 54% 46%;
  +--primary: 15 54% 40%;

[desktop-tokens] Run: npm run tokens
```

It also warns — without failing — when the generator emits a `--radius-*`,
`--text-*` or `--anim-*` token that `tailwind.config.ts` never names. That is
the exact shape of "the web grew a step and the desktop did not notice".

### What each file in this pipeline is allowed to contain

| File | Written by | Contains |
| --- | --- | --- |
| `scripts/generate-tokens.ts` | hand | the projection itself |
| `src/renderer/styles/tokens.css` | **generator — never edit** | every value |
| `src/renderer/styles/base.css` | hand | resets, `@font-face`, base element styles, the a11y behaviour |
| `tailwind.config.ts` | hand | **names only** — every entry points at a token |
| `postcss.config.mjs` | hand | Tailwind v3 + autoprefixer |

`base.css` is the renderer's single stylesheet entry. Import it once, from the
renderer entry module; it pulls in `tokens.css` and carries the three `@tailwind`
directives, so nothing else should.

### What the generator emits

69 light tokens, 48 dark overrides, 6 accents (light + dark), 16 radii, 8 type
steps, 27 keyframes, 32 animation shorthands, 4 registered `@property` rules, and
the reduced-motion token overrides — the last emitted **twice**, once under the
media query and once under `:root[data-reduce-motion]`, for the reason in §7.

The digest in the file header fingerprints the *projection*, not the source
bytes. The Swift generator hashes `globals.css` wholesale, which is right for it;
here the same choice would fail CI every time someone edited one of the ~2,000
lines of commentary in `globals.css` that this generator does not read.

---

## 2. Palette identity

**Warm paper light. Warm charcoal dark that went all the way to true black.
Coral emphasis.**

Every neutral in the product sits at hue 48–54. That is the identity: greys that
belong to paper rather than to a UI kit, and an accent that has something to be
warm *against*.

### Light — warm paper

| Token | HSL | Hex | Role |
| --- | --- | --- | --- |
| `--background` | `54 18% 97%` | `#f9f8f6` | the paper ground |
| `--foreground` | `48 3% 12%` | `#201f1e` | ink |
| `--card` / `--popover` | `54 44% 99%` | `#fefdfb` | raised and floating surfaces |
| `--secondary` / `--muted` | `50 23% 95%` | `#f5f4ef` | recessed fills |
| `--accent` | `48 28% 92%` | `#f0eee5` | hover / selected fill |
| `--border` | `48 23% 88%` | `#e7e5d9` | hairlines |
| `--primary` (coral) | `15 54% 46%` | `#b55636` | the one warm emphasis |
| `--muted-foreground` | `48 4% 40%` | | secondary text |
| `--input` | `48 12% 53%` | | field outline |

A 2.2%-opacity film grain sits over the light theme (`body::after` in
`base.css`). It is a *paper* effect and it is switched off in dark — see below
for why that is not a taste call.

### Dark — true black

`--background` in dark is `0 0% 0%`. Not a charcoal that photographs as black:
the actual value, so an OLED panel keeps those pixels switched off and the app's
edge dissolves into the bezel. Two consequences run through the whole dark ramp:

- **Elevation cannot come from shadow.** A black drop shadow on a black ground is
  nothing. Every rung lifts by *lightness*, and the ladder is re-based from 0
  rather than from the old 9% — what used to be a 3.5-point step is now 6.5,
  because a step measured against black has to be bigger to read the same.
- **Hue has to thin out.** 7% saturation at 9% lightness is a tint you cannot
  name; the same 7% over pure black is brown sludge in the shadows. Saturation
  drops to 4–5% and the hue stays at 48.

| Token | HSL | Hex | Note |
| --- | --- | --- | --- |
| `--background` | `0 0% 0%` | `#000000` | OLED-off |
| `--foreground` | `45 14% 94%` | `#f2f1ee` | off-white — pure `#fff` on `#000` is a 21:1 glare that makes long prose vibrate; 94% lands at 18.4:1 |
| `--card` | `48 5% 6.5%` | `#111110` | |
| `--secondary` / `--muted` | `48 5% 9.5%` | `#191917` | |
| `--popover` / `--accent` | `48 5% 13%` | `#23221f` | floating layers lift furthest — on black nothing else separates them |
| `--border` | `48 5% 16%` | `#2b2a27` | down from 21%: a border is read as a *difference* from its surface, and that surface dropped nine points |
| `--sidebar` | `0 0% 0%` | `#000000` | flush with the ground; separation moves entirely to `--sidebar-border` |

The dark ordering is **ground < card < muted/secondary < popover/accent**, and
it is load-bearing. The film grain is *removed* in dark, not dimmed: a fixed
full-viewport layer at any non-zero opacity means no pixel is ever `#000`, which
is the entire thing true black buys.

### Accents

Coral is the default. Five alternates swap `--primary`, `--ring`,
`--primary-foreground` and `--primary-ink` via `[data-accent]` on `<html>`.

| Accent | Light `--primary` | Hex | Dark `--primary` | Hex |
| --- | --- | --- | --- | --- |
| coral (default) | `15 54% 46%` | `#b55636` | `15 54% 46%` | `#b55636` |
| juniper | `152 44% 31%` | `#2c7251` | `152 42% 54%` | `#58bb8d` |
| teal | `180 63% 31.5%` | `#1e8383` | `187 58% 49%` | `#34b5c5` |
| violet | `249 59% 60%` | `#6f5dd5` | `249 66% 71%` | `#9384e6` |
| amber | `39 67% 55%` | `#d9a33f` | `38 73% 63%` | `#e6b35c` |
| sage | `120 18% 42.5%` | `#598059` | `120 23% 61%` | `#85b285` |

Amber is the exception in both directions: its fill already passes at 7.13:1
because its foreground is dark ink, so the fill is left alone — but its `--ring`
is decoupled to `39 67% 44%`, because `39 67% 55%` measures 2.14:1 against the
page and a focus indicator nobody can see is an SC 1.4.11 failure.

### Fill is not text

This is the single most load-bearing rule in the palette, and it is wired into
`tailwind.config.ts` rather than left to discipline. `--warning` measures 2.36:1
as text on its own chip; `--success` only reaches ~3:1 as small light-mode text.
So `bg-warning` uses the fill token and `text-warning` resolves to a **different**
token:

| Utility | Resolves to |
| --- | --- |
| `bg-primary`, `border-primary` | `--primary` |
| `text-primary` | `--primary-ink` |
| `bg-destructive` | `--destructive` |
| `text-destructive` | `--destructive-ink` |
| `bg-success` | `--success` |
| `text-success` | `--success-ink` |
| `bg-warning` | `--warning` |
| `text-warning` | `--warning-foreground` |

Also present and deliberately *not* state colours: `--code-string`
(`152 56% 42%` light / `152 50% 56%` dark) and `--code-number` (`32 80% 46%` /
`38 90% 60%`), exposed as `text-code-string` / `text-code-number`. A string
literal is not "a run passed", and tying code colour to a state colour means a
theme change to one repaints the other. The desktop has more code on screen than
the web does, which makes that separation matter more here, not less.

---

## 3. Typography

Two faces, two jobs, and the contrast comes from **family and 3× size jumps, not
from timid weights**.

| Family | Variable | Role |
| --- | --- | --- |
| **Newsreader** (serif) | `--font-serif` | expressive. Display and continuous reading: hero, headings, page titles, greetings, assistant prose. |
| **Archivo** (grotesque) | `--font-sans` | the interface voice. Controls, menus, tables, metadata — anything at or below ~15px. |
| **JetBrains Mono** | `--font-mono` | technical. Labels, model ids, code, diff, terminal, and the dot/ASCII signature layer. |

Serif is **asked for**, never inherited — `body` is sans. Archivo's x-height
ratio (~0.52) is within 5% of Newsreader's, so no `size-adjust` is needed and
every px size holds across the swap.

| Step | Size | Leading | Tracking | Weight |
| --- | --- | --- | --- | --- |
| `text-hero` | `clamp(2.4rem, 1.7739rem + 2.7826vw, 4rem)` | 1.1 | −0.02em | |
| `text-display` | `clamp(2rem, 1.6087rem + 1.7391vw, 3rem)` | 1.08 | −0.02em | 500 |
| `text-title` | 1.375rem | 1.25 | −0.012em | 600 |
| `text-heading` | 1.125rem | 1.3 | −0.006em | 600 |
| `text-body-lg` | 1.0625rem | 1.6 | | |
| `text-body` | 0.9375rem | 1.6 | | |
| `text-label` | 0.75rem | 1.4 | 0.10em | 500 |
| `text-caption` | 0.6875rem | 1.45 | 0.02em | |

The `rem` intercept in the two clamps is not stylistic: a pure-vw preferred value
ignores the user's base font size, so browser text zoom would have no effect at
all on the largest type in the product (WCAG 1.4.4).

`text-label` is the eyebrow — pair it with `font-mono` + `uppercase`. Its 0.10em
is the editorial maximum for caps: above ~0.12em, uppercase micro-labels stop
grouping into words and read as decoration, and tracking stacks with a
user-forced 0.12em under SC 1.4.12.

`font-synthesis: none` is set on `body`. Both families carry a real weight axis,
so a faked bold is always a bug.

---

## 4. Radius, elevation, depth, stacking

**Radius** — a continuous ladder, on purpose. Every gap in it was previously
being filled by a hand-written `rounded-[Npx]`, and a scale you cannot land on is
a scale people step off.

| Utility | Value | For |
| --- | --- | --- |
| `rounded-micro` | 2px | heatmap cells, crop handles, anything under ~12px square |
| `rounded-sm` | 4px | |
| `rounded-xs` | 6px | chips, dots, tiny badges |
| `rounded-md` | 8px | |
| `rounded-control` | 9px | sm buttons, menu items, list rows |
| `rounded-field` | 10px | inputs, wells, segmented thumbs, icon tiles |
| `rounded-menu` | 12px | dropdown / select / tabs shells |
| `rounded-card` / `rounded-popover` | 14px | cards, toasts, tiles, popovers |
| `rounded-surface` / `rounded-lg` | 16px | in-flow panels and section wells |
| `rounded-panel` | 18px | floating panels |
| `rounded-composer` | 26px | the composer shell |
| `rounded-composer-control` | 12px | derived — composer-seated control at 44px |
| `rounded-composer-action` | 14px | derived — composer-seated action at 36px |
| `rounded-logo` | 24% | provider/product marks — a **percentage**, so one value is one shape at every size |

`rounded-inherit` is mapped literally rather than through a token: a CSS-wide
keyword cannot travel through a custom property, so `border-radius: var(--x)`
where `--x` holds `inherit` is invalid at computed-value time, not an inherited
radius. The generator excludes it for that reason.

**Elevation** — `shadow-soft < shadow-lift < shadow-glass < shadow-float`,
monotonic and theme-aware. An element that has not left the flow must never
out-elevate one that has. On dark, the two floating rungs carry an
`inset 0 1px 0 hsl(var(--sheen))` top highlight, because on `#000` the drop
shadow is invisible and the rim light is the only cue left.

Depth kit: `shadow-pop` (crisp shadow for buttons/chips), `shadow-glow-primary`
(accent halo — follows `[data-accent]`, because `var()` substitution happens on
the element), `shadow-well` (inset for recessed fields). Plus `--sheen` /
`--sheen-strong` (rest and focused rim light) and `--hairline`.

`--shadow-ink` is declared per theme and **stays dark in both** (`48 10% 18%`
light, `0 0% 0%` dark). Shadow ink is not text ink: writing shadows as
`hsl(var(--foreground) / a)` inverts every one of them into a glowing white halo
the moment the theme flips.

**Stacking** — `z-modal` 50 < `z-popper` 55 < `z-toolbar` 60 < `z-toast` 70.
Popper is above modal by five and the gap is the point: they were both 50, so a
select or tooltip opened inside a dialog tied with the dialog's own panel and
resolved on DOM order.

---

## 5. Motion

One vocabulary, and the number follows **how far something travels and how much
of the screen changes underneath it** — not how important it is.

| Utility | Token | Value | For |
| --- | --- | --- | --- |
| `duration-press` | `--dur-press` | 70ms | transform only, on the element under the finger. 120ms is above the direct-manipulation threshold for movement. |
| `duration-fast` | `--dur-fast` | 120ms | a property changing on the element the pointer already touches: hover fill, text colour, press dip. |
| `duration-exit` | `--dur-exit` | 160ms | the exit rung — roughly 0.65 of its entrance. The user has already decided. |
| `duration-base` | `--dur-base` | 220ms | the default. Something small moving a short distance under its own steam. |
| `duration-slow` | `--dur-slow` | 360ms | a whole region changing: a panel, a page's worth of content. |
| `duration-emphasis` | `--dur-emphasis` | 560ms | the only rung reserved for a change the **user did not cause**. Deliberately more than double base: at 250–350ms an unannounced change reads as a glitch. |

| Utility | Token | Curve | For |
| --- | --- | --- | --- |
| `ease-out-soft` | `--ease-out-soft` | `cubic-bezier(0.33, 1, 0.68, 1)` | the default decelerate |
| `ease-out-strong` | `--ease-out-strong` | `cubic-bezier(0.32, 0.72, 0, 1)` | things the user is moving — they should leave under the finger |
| `ease-out-expo` | `--ease-out-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` | long travel that must not feel slow. Below ~440ms it front-loads so hard the motion appears instantly and then hangs. |
| `ease-in` | `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | the accelerate curve. Entrances decelerate, **exits accelerate**. |
| `ease-in-out` | `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | A-to-B moves where both endpoints are on screen: a chevron, an accordion, a sidebar resizing |
| `ease-breathe` | `--ease-breathe` | `cubic-bezier(0.45, 0, 0.55, 1)` | the only symmetric **loop** curve — an ease-out loop visibly pulses at the seam |
| `ease-out-back` | `--ease-out-back` | `cubic-bezier(0.34, 1.32, 0.64, 1)` | the only overshoot, ~3%, for elements with apparent mass. Never for opacity or colour. |
| `ease-spring` | `--ease-spring` | alias of `out-strong` | **deprecated**, kept only so ported call sites compile |

Animation shorthands arrive as tokens too (`--anim-pop-in`, `--anim-rise-in`, …)
and each still names `var(--dur-*)` / `var(--ease-*)` rather than inlining
numbers, so a curve flattened under reduced motion reaches every animation built
on it. The corresponding `@keyframes` are projected into `tokens.css` from the
web config, which is why `tailwind.config.ts` here has no `keyframes` key: that
would be the one place a body could drift.

Notable timings that are not on the ladder, and are on purpose: `pop-in` runs
180ms (a popper travels 4px — base overshoots it, fast clips the scale),
`overlay-in` leads the panel at 120ms while `overlay-out` trails it at 220ms (the
scrim must outlast the panel it dims), and every loop (`shimmer`, `ultra-pan`) is
`linear` because an eased loop pulses where it turns around.

---

## 6. Glass vs opaque

**Glass is for transient chrome. Reading surfaces are opaque.**

| Glass | Opaque |
| --- | --- |
| composer shell | transcript / message prose |
| dropdown, select, context menus | code editor |
| popovers, tooltips | diff view |
| command palette | terminal |
| floating toolbars | tables, lists, settings |
| scroll-fade edges | cards and tiles |

The rule is about **what is behind the surface**. Chrome that appears, is used,
and disappears can afford to admit what it covers — that is how a menu says "I am
temporarily over your work". A surface you *read from* cannot: text over a moving,
low-contrast, user-controlled backdrop is the fastest way to fail SC 1.4.3 in a
way no palette audit will ever catch, because the failing contrast depends on the
user's wallpaper.

Two knobs, declared in `base.css`, and components read them instead of writing a
blur radius or an alpha:

```css
backdrop-filter: blur(var(--glass-blur));            /* 18px */
background-color: hsl(var(--popover) / var(--glass-veil));  /* 0.72 */
```

That indirection is what makes §7 a switch instead of a hunt.

**These two are desktop-only and have no web counterpart.** The web's
`.overlay-glass` is deliberately *opaque* — it sets `backdrop-filter: none` and a
solid `hsl(var(--popover))`, because a browser tab has nothing worth blurring
behind it, and what "glass" means there is the recipe of hairline + fill + rim
light + `--shadow-glass`. A native window is different: it sits on the user's
wallpaper and their other windows, so transient chrome can be real glass here in
a way it never was there. The material recipe (border `hsl(var(--border))` at full
strength, `inset 0 1px 0 hsl(var(--sheen))`, `var(--shadow-glass)`) is unchanged
and still comes from the tokens.

Two traps carried over from the web, both learned the expensive way:

- **Do not thin the hairline.** `--border` was already dropped from 21% to 16% to
  hold its contrast against the black ground; discounting it again by 0.82 lands
  the edge at ~13.5% — the same value as `--popover`, so the panel's own outline
  becomes a half-point step and disappears.
- **Utilities beat components at equal specificity.** A competing `shadow-*` or
  `bg-*` utility on the same element silently wins over a glass class.

---

## 7. Reduced motion and reduced transparency

### Reduced motion, in three tiers rather than as a kill switch

The preference asks for non-essential motion to be reduced or replaced. It does
not say "no motion at all", and the blanket `*{animation-duration:0.001ms
!important}` clamp this policy replaced took away every hover colour transition
and every press response — including the ones that were already safe — while its
`!important` meant no component could opt back in where the motion carried
meaning.

- **Tier A — untouched.** Opacity, colour, `background-color`, and anything
  carrying real state: the thinking matrix, the status glow, the generation
  sweep, the stream tail. Removing feedback is not an accessibility win.
- **Tier B — transforms collapse to identity.** `--motion-shift` → 0 and
  `--motion-scale-from` → 1, so an entrance keeps its fade and loses its travel;
  `--ease-out-strong` and `--ease-out-expo` flatten onto `--ease-out-soft` and
  `--dur-slow` drops to `--dur-base`. **Generated into `tokens.css`** from
  `globals.css`, so the desktop cannot pick different fallbacks.
  Every travelling keyframe reads `var(--motion-shift, 1)` with its own original
  value as the fallback. **Any new transforming keyframe must do the same**, or
  Tier B silently does not apply to it.
- **Tier C — decorative loops stop outright.** Enumerated one by one in
  `base.css`, never blanket, or Tier A goes with them.

### Reduced transparency

`--glass-blur` → `0px`, `--glass-veil` → `1`. Every component that reads the two
knobs becomes opaque without knowing why. Explicit `backdrop-filter: none` covers
the surfaces that blur without a veil (edge fades, media placeholders).

### Why a media query is not enough

Both blocks are written **twice** — once as a media query, once as an attribute
selector on `<html>` — and the duplication is the whole point.

`prefers-reduced-transparency` answers the hint Chromium knows about, and on
macOS it largely does not map to the real setting: "Reduce transparency" lives in
System Settings → Accessibility → Display, outside what the media query sees. So
`src/main/appearance.ts` reads the genuine values —
`nativeTheme.prefersReducedTransparency` and
`systemPreferences.getAnimationSettings().prefersReducedMotion` — and
`applyAppearanceToDocument` stamps them on `<html>`. The media query does fire
for reduce-motion, but the attribute is also the hook for an in-app override and
the only way to force the state on for testing.

**Match the value, not the presence.** `applyAppearanceToDocument` writes
`String(appearance.reduceMotion)`, so the attribute is *always* on `<html>` — as
`"false"` when the preference is off. A bare `[data-reduce-motion]` selector
matches an empty string just as happily as `"true"`, so it would flatten motion
in every window in the product. Every rule here and in the generated
`tokens.css` therefore keys on `[data-reduce-motion="true"]` /
`[data-reduce-transparency="true"]`.

`:root[data-reduce-transparency="true"]` is specificity (0,2,0) against `:root`'s
(0,1,0), so it wins wherever it appears in the file. **Both paths must set
identical values**, or the app behaves differently depending on which one asked.
That is why the generator emits the reduced-motion overrides twice rather than
leaving the attribute copy to be typed by hand.

`applyAppearanceToDocument` also stamps `data-increase-contrast`, which nothing
in this stylesheet reads yet. It is a real macOS setting (Accessibility →
Display → Increase contrast) and the natural response — thicker hairlines, no
tinted-on-tinted fills — is a token change, so it belongs in this pipeline
whenever it is picked up. Listed as a gap rather than guessed at.

**The main process has a matching obligation.** A window created with a
`vibrancy` / `NSVisualEffectView` backing stays translucent no matter what this
stylesheet says, so it must drop vibrancy under the same setting.

---

## 8. Font follow-up — REQUIRED, not yet done

The web loads its three families from Google Fonts through `next/font`
(`src/app/layout.tsx`):

```ts
const sans  = Archivo({ subsets: ["latin"], variable: "--font-sans" });
const serif = Newsreader({ subsets: ["latin"], variable: "--font-serif",
                           style: ["normal", "italic"], axes: ["opsz"] });
const mono  = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });
```

There is no `public/fonts/` in the repository — the web has never needed one.
**Electron under our CSP has no network, so the desktop must ship the files.**
`base.css` already declares the four `@font-face` rules that bind them; until the
files land, `font-display: swap` keeps text visible and the stacks fall through
to `system-ui` / Georgia / `ui-monospace`. Nothing is broken; it is unbranded.

### The four files

| File | Family | Axes | Style |
| --- | --- | --- | --- |
| `Archivo-Variable.woff2` | Archivo | `wght 100–900` | normal |
| `Newsreader-Variable.woff2` | Newsreader | `opsz 6–72`, `wght 200–800` | normal |
| `Newsreader-Italic-Variable.woff2` | Newsreader | `opsz 6–72`, `wght 200–800` | italic |
| `JetBrainsMono-Variable.woff2` | JetBrains Mono | `wght 100–800` | normal |

Requirements, in order of how quietly they fail if ignored:

1. **Variable, not static instances.** All three families carry a real weight
   axis and `base.css` sets `font-synthesis: none`, so a static Regular means
   every bold in the app renders at Regular rather than being faked.
2. **Newsreader must include the `opsz` axis.** `body` sets
   `font-optical-sizing: auto`; without the axis in the file that declaration is
   a silent no-op. This is the exact trap the web hit — the declaration was
   inert until `axes: ["opsz"]` was added to the `next/font` call.
3. **Newsreader italic is a separate file.** The web requests
   `style: ["normal", "italic"]`; assistant prose uses it.
4. **Latin subset**, matching `subsets: ["latin"]` on the web, to keep the
   bundle down.

### Where they go

`base.css` references them as **`/fonts/<file>.woff2`** — root-absolute on
purpose. A relative URL to a file that does not exist is a hard failure in Vite's
asset resolver, so this file could not be written correctly ahead of the assets;
a root-absolute one is passed through untouched. It also gives the main process a
single stable path to serve.

Either placement satisfies it:

- drop the files in the renderer's public directory, so they are copied to the
  build output and served at `/fonts/…` in dev and prod; **or**
- vendor them under `resources/fonts/` as electron-builder `extraResources` and
  have the main process map that directory onto `/fonts/…` on the app's custom
  protocol.

The CSS URL is the same either way. **Licensing:** all three are SIL OFL 1.1;
ship `OFL.txt` alongside them.

---

## 9. Known gaps

1. **The parser is duplicated.** `scripts/generate-design-tokens.ts` is a
   top-level script — it parses, derives and writes on import and exports
   nothing — so `parseBlocks` / `declsFor` are carried over near-verbatim rather
   than imported. The one extension is that this copy *keeps* conditional blocks
   (tagged with their at-rule chain) instead of dropping them, because CSS has
   `@media` and Swift does not, and the reduced-motion overrides live inside one.
   Factoring out a shared module means editing the root generator, which this
   change did not own. Both scripts read the same file and both gate CI, so a
   drifting parser shows up as a diff in a generated artifact.
2. **The icon stroke ladder is transcribed, not generated.** `svg.lucide` optical
   sizing in `base.css` is byte-for-byte from `globals.css`, because those are
   *rules* and the generator projects *tokens*. If the ladder moves, this block
   must be moved with it.
3. **Base-layer rules are content-filtered.** Tailwind drops `@layer base` rules
   whose selectors it cannot attribute to a candidate found in `content`. The web
   ships `svg.lucide` because 135 `.tsx` files contain the string `lucide` (the
   `lucide-react` imports). Until this app depends on `lucide-react`, those rules
   compile away — verified, not theorised. Nothing to fix; worth knowing before
   someone debugs a missing stroke weight.
4. **Prefixes belong to autoprefixer, and it prefixes both ways.** Measured
   against the default browserslist it *adds* `-webkit-mask-image` and *removes*
   `-webkit-backdrop-filter`. `base.css` therefore writes no prefixes at all.
   Follow-up: pin `browserslist` to the Chromium in this Electron so autoprefixer
   targets one known engine instead of the generic default query.
5. **`tailwind.config.ts` and `postcss.config.mjs` are outside both tsconfig
   graphs.** `tsconfig.node.json` does not include them, so `npm run typecheck`
   does not check the Tailwind config. Adding it to that `include` list is a
   one-line follow-up for whoever owns the tsconfigs.
6. **The web's `@property --aura-tint` fallback has drifted from `--primary`.**
   Its comment says it is "kept in step with `--primary` at light value", but the
   declared `#b64f2e` is not `hsl(15 54% 46%)` (`#b55636`). Harmless — the
   composer host always sets a real value and the initial is never used — and it
   is projected verbatim rather than silently corrected, because `globals.css` is
   the source of truth and this pipeline does not get to have opinions about it.
7. **`data-increase-contrast` is stamped and unread.** See §7. Picking it up
   means a token change (hairline weight, tinted fills), so it goes through this
   generator, not through component CSS.
8. **ADR-0003 records a different decision than the one implemented.** It says
   the desktop's `tokens.css` should become another entry in the root
   `scripts/generate-design-tokens.ts` `outputs` array. What exists — and what
   `package.json` already wires into `npm run gates` — is a separate
   `native/desktop-electron/scripts/generate-tokens.ts`. The ADR's *reasoning*
   holds and was followed (same sources, raw HSL verbatim, Tailwind 3.4 pinned);
   only the file layout differs, so that the desktop's gate lives in the desktop
   package. The ADR should be amended rather than the code moved.
9. **Not ported, deliberately:** the web's `container` (a page-width helper for a
   document; this is a window), the `coarse:` pointer variant and `p{t,b,l,r}-safe`
   insets (touch and notches), and `tailwindcss-animate` (its `data-[state]`
   helpers are covered by the `pop-in`/`pop-out` pair, and it is not a dependency
   of this package).
