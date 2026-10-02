# Juno web: design system and motion reference (internal audit)

Audit date: 2026-09-23, branch `web/tools-thinking-research` (worktree `juno-tools`, based on `d0997af2`).
Scope: what exists today, so the redesign of the **thinking animation**, **tool-call rows**, the
**right-hand thought dock** and the **research UI** fits the product. Read-only audit; every value
below was read from source, not from the docs, unless marked *(doc)*.

---

## 0. Sources of truth and their order

| Rank | Source | Status |
|---|---|---|
| 1 | `src/app/globals.css` (3,798 lines): CSS variables, composed classes, plain-CSS keyframes, reduced-motion tiers | **Live values.** Many *comments* inside it are stale (they cite a `#000` / 9% dark ground and a 6.5% `--card` that no longer exist). Trust the declarations, not the prose numbers. |
| 2 | `tailwind.config.ts`: Tailwind mapping, type scale, radius ladder, durations/easings, keyframes + `animation` shorthands | Live. |
| 3 | `src/lib/design/tokens.generated.ts` (from `npm run design:tokens`, checked by `design:tokens:check`) | Live: `DURATION`, `EASING`, `RADIUS`. Feeds `src/lib/motion.ts`, `src/lib/micro.ts` and the Swift package. |
| 4 | `docs/design/FLAT_UI.md` | **The material law** (Sept 2026 flat retune). Its token table matches globals.css. |
| 5 | `docs/design/ICONS_AND_MOTION.md` | The icon + interaction-motion contract. Current. |
| 6 | `docs/design/PREMIUM_AUDIT.md` | Composition law, 17 rules (§3). Mostly current; one stale claim (see §16). |
| 7 | `docs/design/TWO_PRODUCTS.md` | Product shape (Chat + Code; Work lives inside a conversation). |
| 8 | `docs/design/SOFT_UI.md` | **Historical** (neumorphic pass). Names survive, drawings do not. Its motion §2.4 and composer notes are partly still valid. |
| 9 | `docs/JUNO.md` §3 | **Stale.** Still says Archivo, film grain, neumorphic dual shadows, 12px glass blur, old ground values (`50 22% 96%`, `30 7% 9%`), `ring` = coral. Do not copy numbers from it. |
| – | `design-qa.md` (repo root) | A QA log for the landing page + Research plan gate. Result "blocked": the live research states were never visually verified with real data. |
| – | `docs/design/REVIEW_2026-09-02.md`, `CODEX_PROMPT_REMAINING.md` | Historical review + a task list; `CODEX_PROMPT` restates the banned-pattern list (§13). |

Verification path for any redesign: the browser pane has **no signed-in session**, so every new
surface must be verifiable in a `/dev/*` gallery (§15). Never start a second `next dev` in a shared
checkout.

---

## 1. Stack

| Piece | Version / config | Notes |
|---|---|---|
| Tailwind | `^3.4.0`, `darkMode: ["class"]`, content `./src/**/*.{ts,tsx}` | `container`: centered, 1rem padding, `2xl` = 1280px. |
| Plugins | `tailwindcss-animate` `^1.0.7`, `@tailwindcss/container-queries` `^0.1.1`, one inline plugin | Inline plugin adds the `coarse:` variant (`@media (pointer: coarse)`) and `.pt-safe/.pb-safe/.pl-safe/.pr-safe`. |
| shadcn | `components.json`: style `new-york`, RSC, base color `neutral`, CSS variables, **`iconLibrary: "lucide"` (stale: the app uses Phosphor through `icons.tsx`)** | Primitives are heavily customised; do not re-generate from shadcn. |
| Radix | avatar, checkbox, dialog, dropdown-menu, label, popover, progress, radio-group, scroll-area, select, separator, slider, slot, switch, tabs, toggle, tooltip, visually-hidden | No Radix Collapsible/Accordion: disclosure is `Collapse` (framer) or `grid-template-rows` CSS. |
| framer-motion | **`^12.42.2`** (the `motion` package is not installed; nothing imports `motion/react`) | Imported by 34 files. None of the chat run surfaces (`activity-timeline`, `thought-process-panel`, `aicss/*`, `research/*`) import it; they are CSS-only. `AppShell` wraps the app in `<MotionConfig reducedMotion="user">`. |
| Theme | `next-themes`: `attribute="class"`, `enableSystem`, `disableTransitionOnChange` | `.dark` on `<html>`. |
| Accent | `data-accent` on `<html>` (server-rendered from preferences) | See §2.3. |
| Toasts | `sonner ^2.0.7`, restyled by unlayered rules at the end of globals.css (specificity (0,5,0)). |
| Icons | `@phosphor-icons/react ^2.1.10` (SSR entry) wrapped by `src/components/ui/icons.tsx` | `lucide-react ^1.22.0` is still a dependency, used only by `canvas/sandbox-frame.tsx` to shim icons inside **generated artifact code**. ESLint `no-restricted-imports` bans both libraries outside `icons.tsx`. |

---

## 2. Colour

All colours are HSL triplets in CSS variables, consumed as `hsl(var(--x) / <alpha>)`. **No raw hex in
components.** Every neutral is warm (red ≥ green ≥ blue on every rung, gated by a native test).

### 2.1 Neutral and surface ladder

| Token (Tailwind) | Light | Dark | Role |
|---|---|---|---|
| `--background` (`bg-background`) | `48 24% 97.2%` | `30 5% 11.5%` | Page ground: warm paper / warm charcoal. OS theme-color `#faf9f6` / `#1f1d1c` (`ui/theme-color.ts`). |
| `--foreground` | `48 4% 11%` | `45 12% 95%` | Text ink. |
| `--card` | `46 32% 99.2%` | `30 5% 14%` | In-flow raised surface. The thought dock is `bg-card`. |
| `--popover` | `46 32% 99.4%` | `30 5% 16.5%` | Floating layers. |
| `--secondary` | `46 20% 93.5%` | `30 5% 18%` | **Tonal fill, never a state**: user bubble, code block, tracks, badges, the disabled send disc, an expanded step row. |
| `--muted` | `46 20% 93.5%` | `30 5% 18%` | Same value as secondary; skeleton fill, inline code. |
| `--muted-foreground` | `48 4% 40%` | `40 6% 66%` | Secondary ink. ≥ 4.5:1 on page, card, muted and the hover fill (the AA floor for every caption). |
| `--accent` (`bg-accent`) | `46 20% 91.5%` | `30 5% 21%` | **Hover** fill. |
| `--selected` (`bg-selected`) | `46 20% 90%` | `30 5% 24%` | **On / selected / held**: one rung past hover in both themes. |
| `--border` | `44 14% 86.5%` | `30 5% 22.5%` | Hairlines. |
| `--input` | `44 12% 78%` | `30 5% 27%` | The field hairline (composer edge, switch track off). |
| `--ring` | `15 54% 46%` base, **but every preset accent overrides it to neutral** `48 6% 35%` (light) / `45 10% 80%` (dark) | | Focus outline. Focus is neutral ink, not coral. |
| `--knob` | `0 0% 100%` | `45 10% 94%` | Slider knob, light in both themes. |
| `--sidebar` | `46 22% 94.6%` | `30 5% 8.8%` | Left sidebar panel (below the page). |
| `--sidebar-foreground` | `48 4% 30%` | `40 6% 70%` | |
| `--sidebar-border` | `44 14% 84.5%` | `30 5% 21%` | The seam: the strongest hairline on screen. |
| `--sidebar-accent` | `46 20% 90.5%` | `30 5% 17%` | Panel tonal fill (account band, product-switch track). |
| `--sidebar-hover` | `46 20% 92.8%` | `30 5% 13.5%` | Row under the pointer. |
| `--sidebar-selected` | `46 22% 89.8%` | `32 6% 19%` | The row you are on (`.sidebar-row-selected`, fill only, no edge). |
| `--sidebar-selected-border` | `43 16% 81%` | `32 7% 26%` | Defined for the native token table only; nothing draws it. |
| `--scrim` (`bg-scrim`) | `48 12% 8% / .36` | `0 0% 0% / .55` | The one modal dim (+ `backdrop-blur-[2px]`). |
| `--hairline` | `48 12% 18% / .06` | `45 14% 94% / .08` | Skeleton inner ring. |
| `--sheen` | `0 0% 100% / .55` | `45 20% 96% / .07` | Rim light; now only on the video play plate. |
| `--shadow-ink` | `48 10% 18%` | `0 0% 0%` | Shadows are never made from `--foreground` (it inverts to a white halo in dark). |

Ranking rule (FLAT_UI §3.1): **rest → hover (`--accent`) → on/held (`--selected`)**, each a step
deeper (darker in light, lighter in dark). `bg-secondary` is never a selected state.

### 2.2 Semantic colours

| Token | Light | Dark | Text ramp (what `text-*` resolves to) | Meaning |
|---|---|---|---|---|
| `--primary` | `15 54% 46%` (coral) | `15 54% 46%` | `--primary-ink` `15 54% 44%` / `15 62% 66%` | The accent: **state and the primary action only**. |
| `--primary-foreground` | `0 0% 100%` | `0 0% 100%` | | Ink on the accent fill. |
| `--destructive` | `11 51% 48%` | `11 51% 49.5%` | `--destructive-ink` `11 55% 41%` / `11 51% 66%` | Errors, dangerous hovers (`.danger-hover`). |
| `--success` | `140 33% 46%` | `140 33% 53%` | `--success-ink` `140 38% 33%` / `140 33% 53%` | Done / read (web-search check, to-do done). Dark `--success-foreground` is the ground (`30 7% 9%`). |
| `--warning` | `40 57% 45%` | `40 60% 58%` | `--warning-foreground` `40 57% 32%` / `40 70% 72%` | Failed steps, run notices ("Failed" is **warning**, not destructive, in the dock). |
| `--source` | `187 62% 34%` | `187 58% 49%` | (no ink ramp) | Teal: "this came from somewhere" (sources, citations); the aura's "Juno answering". |
| `--ultra` (+ `--ultra-from/-to`) | `258 90% 66%` | `258 92% 74%` | | Violet. **Only consumer today: the voice aura** (`--aura-thinking`). The `ultra-*` keyframes are dead. |
| `--code-string` / `--code-number` | `152 56% 30%` / `32 80% 34%` | `152 50% 56%` / `38 90% 60%` | | highlight.js tokens (keywords use `--primary-ink`, comments `--muted-foreground` italic). |
| `--canvas-selection/-guide/-measure` | `229 78% 60%` / `11 72% 50%` / `40 85% 45%` | `229 86% 68%` / `11 78% 60%` / `40 88% 55%` | | Design-canvas chrome only. The one sanctioned blue. |
| `--aura-you/-thinking/-juno` | aliases of `--primary` / `--ultra` / `--source` | | | Voice aura inks. |

`tailwind.config.ts` overrides **`textColor`** so `text-primary`, `text-destructive`, `text-success`
and `text-warning` resolve to the AA **ink** ramps; `bg-*`/`border-*` keep the fill tones.
`text-*-foreground` keeps the fill-contrast ink.

### 2.3 Accents

`src/lib/accents.ts` + `[data-accent]` rules in globals.css. Six presets (light fill / dark fill):
`coral` 15 54% 46% / same · `juniper` 152 44% 31% / 152 42% 54% · `teal` 180 63% 31.5% / 187 58% 49% ·
`violet` 249 59% 60% / 249 66% 71% · `amber` 39 67% 55% / 38 73% 63% · `sage` 120 18% 42.5% / 120 23% 61%.
Each preset also sets `--primary-foreground` (dark text on the light fills: amber in both themes,
juniper/teal/violet/sage in dark) and `--primary-ink`, and neutralises `--ring`.
`swatchInk()` picks readable ink on an arbitrary swatch. Custom `#hex` accents: `app-provider.tsx`
clamps lightness (≤55% light, ≥55% dark) and writes `--primary`, `--ring`, `--primary-foreground`
inline (see bug in §16: it never writes `--primary-ink`).

**Design consequence:** anything the redesign colours with the accent must read under all six
accents in both themes, and must use `text-primary` (ink) for type, `bg-primary` for fills.

### 2.4 Colour rules the docs lay down

- **One accent, used for state and the primary action.** Never furniture, never a placeholder, never a
  decorative glow (FLAT_UI §2.4, JUNO §3.6 "Coral is for state, not for furniture", skeleton note).
- **Run UI is monochrome by kind.** Step markers differ by drawing, never by hue; only *running*
  (primary) and *failed* (warning) colour anything (`StepMarker` doc comment, thought-process-panel).
- **Armed tools are neutral** (`bg-accent`, foreground ink), never a tinted accent pill (PREMIUM_AUDIT §2d).
- A mention token inside the composer is neutral `--accent` and must not move a character.
- Status pills change without colour blooms (a success colour must never "congratulate a failure").
- `--ultra` means "Juno is working" only in the voice aura; `--source` means provenance.

---

## 3. Typography

### 3.1 Families (`src/app/layout.tsx`, `next/font/google`, `display: swap`)

| Variable | Face | Weights | Use |
|---|---|---|---|
| `--font-sans` (`font-sans`) | **Inter** | 400, 500, 600 | Everything: controls, headings, transcript prose. |
| `--font-serif` (`font-serif`) | **Newsreader** roman + italic | 400, 500, 600 | Human moments only: empty-chat greeting, wordmark. Never inherited, never at UI size. |
| `--font-mono` (`font-mono`) | **JetBrains Mono** | 400, 500, 600 | Code, ids, durations, counts, token figures, metadata labels. |

`body`: `font-synthesis: none`, antialiased, `optimizeLegibility`. Weights in use: **400/500/600 only**
(bold renders as 600; 425/450/550 were purged). A reader text-size preference is applied to the root
font size before first paint (`FONT_SIZE_BOOT_SCRIPT`), so everything must be rem-based.

### 3.2 Scale (`tailwind.config.ts` `fontSize`)

| Class | Size | Line height | Tracking / weight | Use |
|---|---|---|---|---|
| `text-hero` | clamp(2.4rem, 1.7739rem + 2.7826vw, 4rem) | 1.1 | -0.02em | Landing only (the one `vw` rung). |
| `text-display` | clamp(2rem, 0.3333rem + 4.1667cqi, 3rem) | 1.08 | -0.02em, 500 | Marketing-size display (measured in the `page` container). |
| `text-page-title` | clamp(1.625rem, 1rem + 1.5625cqi, 2rem) | 1.15 | -0.02em, 600 | App page `<h1>`. |
| `text-title` | 1.375rem (22px) | 1.25 | -0.012em, 600 | Section head (research console title). |
| `text-heading` | 1.125rem (18px) | 1.3 | -0.006em, 600 | Dialog titles, gallery section heads. |
| `text-body-lg` | 1.0625rem (17px) | 1.6 | | Report reader, research field. |
| `text-reading` | 1rem (16px) | 1.7 | | **Conversation size**: assistant prose (`.prose-juno`), user bubble, the live strip sentence and the stream status line. |
| `text-body` | 0.9375rem (15px) | 1.6 | | Descriptions, dialog copy, sidebar-like rows (`Pressable kind=row`), dock reasoning prose. |
| `text-nav` | 0.875rem (14px) | 1.25rem | | Sidebar rows, titles, account name. |
| `text-ui` | 0.8125rem (13px) | 1.5 | | Dense UI: menu rows, chips, dock step labels, resting strip, dock header. |
| `text-label` | 0.75rem (12px) | 1.4 | 0.01em, 500 | Section labels (pair with `font-mono`, sentence case). |
| `text-caption` | 0.6875rem (11px) | 1.45 | 0.02em | Detail lines, tooltip text, durations. |
| `text-micro` | 0.65625rem (10.5px) | 1.45 | 0.02em | Mono metadata floor (model ids, token counts). |

Rules: sentence case everywhere, **no `uppercase`** (initials in avatars excepted; 3–4 legacy sites
remain: `composer-shell.tsx:907`, `engineering/article.tsx`). **Two type voices in chrome** (`ui` for
rows, `label` for sections); `micro` at most once per surface; no numerals above `ui` in chrome;
figures are `font-mono tabular-nums`. Hierarchy by weight, not by alpha (AIcss note).
`.prose-juno`: 16/1.7, `max-inline-size: 75ch`, block rhythm `0.85em`, model headings demoted to
h3–h6 (1.5em/1.3em/1.12em, 600), inline code `0.875em` on `--muted` at 6px radius, tables with
horizontal rules only. Lint ratchets: `design-system/no-arbitrary-text` and `no-raw-text-size` (warn).

---

## 4. Radius ladder (`tailwind.config.ts`, enforced by `design-system/no-arbitrary-radius`)

| Class | px | Used for |
|---|---|---|
| `rounded-micro` | 2 | heatmap cells, crop handles |
| `rounded-sm` | 4 | |
| `rounded-xs` | 6 | chips, dots, tiny badges, inline code, `<mark>` |
| `rounded-md` | 8 | |
| `rounded-control` | 10 | sm buttons, menu rows, list rows, tooltips, kbd, dock step rows |
| `rounded-field` | 12 | inputs, wells, icon tiles, the live strip row, notes |
| `rounded-menu` | 14 | dropdown/select/tabs shells |
| `rounded-card` = `rounded-lg` = `popover` = `surface` | 16 (`--radius`) | cards, toasts, popovers, user bubble (`rounded-br-md` tuck) |
| `rounded-panel` = `composer` | 20 | dialogs, sheets (inner edge), composer |
| `composer-control` / `composer-action` | 10 / 12 | derived composer children |
| `rounded-logo` | 24% | provider marks |
| `rounded-full` | pill | icon Pressables, chips, dots |

**Concentric rule:** inner radius = outer radius − padding (`design-system/concentric-radius`, error).
Off-ladder values that live in raw CSS (the lint cannot see them): `.aicss-cb` and `.aicss-todo` 14px
(comment claims "card"), `.aicss-ig` 12px, `.composer-mention` 5px, `.aicss-ws-chevron` and
`.aicss-cite-mark` 4px.

---

## 5. Spacing, layout, sizing, stacking

- Spacing is Tailwind's 4px scale plus `4.5` (18px, the sidebar-glyph rung), `dot` (`--dot-size` 5px)
  and `dot-gap` (`--dot-gap` 3px) for the dot signature.
- **Page gutter**: `--page-gutter` via `.page-gutter` / `.app-page-content`: 16 → 24 → 32px at
  `@container page` 40rem / 64rem. `<main>` is `container-type: inline-size; container-name: page`
  (`.app-main-canvas`). Rule: size by the container, never the viewport (`@sm:`/`@[40rem]:` variants).
- Measures: `AppPage measure="reading"` = `max-w-3xl` (48rem), `wide` = `max-w-5xl` (64rem), `full`.
  Transcript column `page-gutter mx-auto max-w-3xl space-y-6 py-6`; assistant prose capped at 75ch.
- **Split container** (`chat/split-layout.ts`): the chat mount is `@container/split`; docked columns
  (thought dock, canvas) sit beside the chat at `@[50rem]/split:` (800px = `CHAT_MIN_WIDTH` 320 +
  `THOUGHT_DEFAULT_WIDTH` 480). Below it the dock is full-bleed and shows a Back chevron.
  Thought dock: default `w-[30rem]`, min 400, floor 280, max 60% of the mount, drag/keyboard resize,
  persisted in `localStorage` `juno:thought-width`.
- Row metrics: menu rows 32px (`min-h-8`, 44px `coarse:`), 13px label, 16px muted glyph, `gap-2.5`,
  `px-2.5`; menu shell `rounded-menu p-1`, widths `MENU_W` = `w-56`, `MENU_W_WIDE` = `w-72`,
  separator `bg-foreground/10`. Dock step row: grid `1.25rem | 1fr | auto | 1.75rem`, `gap-x-2.5`,
  `min-h-8`, 20px marker with `ring-4 ring-card` punching the spine.
- Hit targets: ≥ 32px pointer, ≥ 44px `coarse:` (Button sizes: `h-9`/`h-8`/`h-11`, icon `size-9`/`size-8`,
  Pressable icon `size-7/8/9`).
- **z-index scale** (`z-*` utilities over CSS vars): `aura` 40, `modal` 50, `popper` 55 (above modal
  on purpose), `toolbar` 60, `toast` 70. `design-system/no-ad-hoc-stacking` rejects picked numbers
  (the dock itself still uses Tailwind's stock `z-40`).

---

## 6. Elevation and surfaces (FLAT_UI)

### 6.1 Shadows (`--shadow-*`, Tailwind `shadow-*`)

| Token | Light | Dark |
|---|---|---|
| `raised` | `0 1px 2px ink/.04` | `0 1px 2px black/.25` |
| `raised-lg` | + `0 6px 16px -6px ink/.08` | + `0 8px 20px -8px black/.5` |
| `inset`, `pressed` | `0 0 0 0 transparent` (kept as names only) | same |
| `float` | `0 0 0 1px ink/.03, 0 2px 6px ink/.05, 0 14px 36px -10px ink/.16` | `0 0 0 1px hsl(45 20% 96%/.05), 0 4px 12px black/.35, 0 18px 44px -12px black/.6` |
| `soft` (legacy) | `0 1px 2px ink/.04` | (not redefined: resolves to black/.04, near-invisible) |
| `lift` (legacy) | `0 1px 2px ink/.04, 0 4px 12px -4px ink/.08` | (not redefined) |
| `glass` (legacy) | `0 2px 6px ink/.05, 0 14px 36px -10px ink/.16` | `0 4px 12px black/.35, 0 18px 44px -12px black/.6` |
| `pop` | `0 1px 2px ink/.06` | `0 1px 2px black/.38` |

### 6.2 Composed classes (`@layer components`), the only sanctioned way to draw a surface

| Class | Draws |
|---|---|
| `.surface-raised` / `-raised-lg` | `--card` + 1px `border/.8` + `raised` / `raised-lg` |
| `.surface-inset` (legacy alias `.field-well`) | `--background` + `border/.8`, no shadow |
| `.surface-float` | `--popover` + `border/.9` + `float` |
| `.overlay-glass` | opaque `--popover` + `border/.7` + `float` (no blur since the flat retune; name is legacy) |
| `.glass-raised` | `float` shadow only (legacy; no live consumer) |
| `.control-neu` | `--card` + `--border` hairline → hover `--accent` + edge `foreground/.18` → on/held `--selected` + edge `foreground/.22`; `:active` `scale(.97)` |
| `.control-primary` | solid accent fill + border, no shadow; hover `brightness(1.06)`, active `brightness(.94)` + `scale(.97)` |
| `.composer-surface` | `--card` + `--input` hairline + `0 1px 2px ink/.04, 0 10px 30px -12px ink/.14`; `:focus-within` edge `foreground/.3` + `0 14px 36px -12px ink/.18` |
| `.sidebar-row-selected` (`-on-open`) | `--sidebar-selected` fill only |
| `.app-sidebar-frame` | `--sidebar` + inset seam; `[data-floating]` adds `float` |
| `.skeleton` | `--muted` + inset `--hairline` ring, breathing opacity |
| `.danger-hover` | hover fills destructive, ink goes white |

Principles: **flat by default** (an in-flow surface is fill + hairline, at most a 1px contact shadow);
**shadows leave the page** (only menus, popovers, dialogs, toasts, tooltips, floating sidebar get
`float`); **nothing in the reading column casts a shadow**; every surface keeps a hairline (WCAG 1.4.11);
**the transcript is flat** (no card around assistant prose; embedded blocks use sparse hairline
chrome); **no glass/blur on reading surfaces**; no gradients, grain or sheen on fills.
Floating layer radii: dialog `panel` (20), popover `card`/`popover` (16), menu `menu` (14), toast
`card`, tooltip `control` (10), sheet `panel` on the inner edge. Callers pass width/padding/position
only; a `bg-*`/`border-*`/`shadow-*` utility on a floating layer silently beats the material (§14).

Chat-adjacent "not prose" blocks: code block `.aicss-cb` (`--secondary` tonal fill, no ring, 14px,
header divider), to-do `.aicss-todo` (`--card` + 1px border ring, 14px), research `.research-surface`
(`rounded-card border bg-card p-4 sm:p-5`), the dock (`bg-card`, `border-l border-border/70`, header
`border-b border-border/60`).

---

## 7. Icons

### 7.1 The set

- **One module:** `src/components/ui/icons.tsx` (223 `glyph()` exports), Phosphor 256-unit geometry,
  Juno names (`ChevronDown`, `Loader2`, `Settings`, …). Take an icon as a prop with `IconComponent`.
- **Juno's own marks** (`juno-glyphs.tsx`, exported through `icons.tsx`): `JunoChat`, `JunoCode`,
  `JunoDesign`, `JunoLibrary`, `Send` (up arrow with the spark's concave flanks). Drawn on the same grid,
  16-unit line, round caps; motifs = open ring with ball terminal + four-point concave spark.
- **Registries** (`src/lib/app-icons.ts`) come first: `AppIcons` (destinations; `research: Telescope`,
  `connections: Plug`, `artifacts: Layers3`), `CodeIcons`, `ComposerIcons` (`web: Globe`,
  `research: Telescope`, `memory: NotebookPen`, `task: Workflow`, `canvas: SquarePen`), `DesignIcons`,
  `StatusIcons` (`warning`, `error`, `info`, `success: Check`, `verified`, `security`), `ActionIcons`
  (`edit`, `delete`, `dismiss`, `copy`, `refresh`, `restore`, `external`, `share`, `download`, `more`,
  `filter`, `parameters`), `SettingsIcons`. One concept, one drawing.
- **Current tool-step glyphs in the dock** (`StepMarker`): search → `ComposerIcons.web` (Globe), tool →
  `AppIcons.connections` (Plug), memory → `ComposerIcons.memory`, notice → `CodeIcons.error`,
  other → `AppIcons.artifacts`, think → a 7px dot, source → the site favicon cluster. All `size-3`.
  There is **no per-tool glyph map** today.
- Never hand-draw an interface icon. Exempt: brand/provider logos, data-viz, the dot-matrix
  signature, **bespoke live-state marks** (the private-chat ghost, the web-search SMIL globe), the
  design canvas. No emoji as icons.

### 7.2 Weight, size, ink

- House weight `regular` = 1px line at 16px, 1.25px at 20px. **Do not pass `strokeWidth`.** At ≤ 12px
  (`size-3`, `size-2.5`, `size-2`, `h-3`, or `size <= 13`) `icons.tsx` switches to `bold` automatically.
- `weight="fill"` (or any `fill-*` class) means **on/selected** (pinned pin, starred star, selected
  `JunoChat`). Never decoration.
- Size ladder: `size-3` (12, dense metadata), `size-3.5` (14, beside caption text), **`size-4` (16,
  default)**, `size-4.5` (18, sidebar destinations only), `size-5` (20, large targets, page headers),
  `size-6+` (empty-state art only). `gap-2` beside `text-ui`, `gap-1.5` beside `text-caption`.
- Ink: chrome glyphs `text-muted-foreground` at rest → row foreground on hover/selection
  (`transition-colors duration-fast ease-out-soft`); `menuGlyphInkClass` does this for every menu.
  Status glyphs keep their status colour.

### 7.3 Hover articulation (`data-motion`, played by `svg.icon[data-motion]` in globals.css)

One gesture per glyph, declared in `icons.tsx`, played when the enclosing interactive element
(`a, button, summary, label, [role=button|link|menuitem*|option|tab], [data-icon-trigger]`) is
hovered or `:focus-visible`, or a Radix row is `[data-highlighted]`. Only under
`(hover: hover) and (prefers-reduced-motion: no-preference)`; never inside disabled controls.

| `motion` | Transform | Meaning | Glyphs |
|---|---|---|---|
| `nudge-r/l/u/d/ne` | `translate` ±12% (9%/−9% for ne) | action goes where it points | arrows, Send, external, sign out, upload/download |
| `turn` | `rotate: 90deg` | make one more / dismiss | Plus, X |
| `spin` | `rotate: 60deg` | configuration/appearance | Settings, Sun |
| `cw` / `ccw` | `rotate: ±180deg` | run again / go back | RefreshCw, Repeat / RotateCcw |
| `tilt` | `rotate: -12deg` | a tool picked up | Search, pencils, Pin, Mic, Link, Key, Wrench, thumbs, Paperclip, Moon |
| `lift` | `translate: 0 -9%` | an object picked up | Copy, Trash, Archive, Folder, Layers |
| `pop` | `scale: 1.14` | a mark you set | Star, Sparkles, Bookmark, Play, Zap |
| `parts` | moves one `.juno-part--*` of a Juno mark via `--icon-on` | | JunoChat (ball), JunoCode (spark), JunoDesign (disc), JunoLibrary (volume) |

Transitions: `translate`/`scale` `--dur-base` + `--ease-out-back`, `rotate` `--dur-slow` +
`--ease-out-back`, colour/opacity `--dur-fast`. Uses the individual `translate/rotate/scale`
properties so a call site's `rotate-180` (which writes `transform`) composes. **Carets, spinners and
status marks carry none**; a caret's rotation belongs to the call site. Pass `motion="none"` where a
gesture is wrong (e.g. a plus that rotates to an x as state).

---

## 8. Motion tokens

### 8.1 Durations (`--dur-*`, `duration-*`, `DURATION`, framer `duration`)

| Token | ms | When |
|---|---|---|
| `press` | 70 | transform only, the element under the finger (the 0.97 dip) |
| `fast` | 120 | a property changing on the thing already touched: hover fills, ink, tooltips, icon swaps |
| `exit` | 160 | exits (~0.65 of the entrance) |
| `base` | 220 | **the default**: menu open, thumb slide, row settle, caret rotation, rise-in |
| `slow` | 360 | a region changing: panel, page of content, disclosure rows |
| `emphasis` | 560 | a one-shot the user did **not** cause (background run finished); used in 3 files |

The number follows distance and area changed, not importance. Nothing over 360ms except a deliberate
one-shot. **Loop periods are deliberately off-ladder** (§9.3).

### 8.2 Easings (`--ease-*`, `ease-*`, `EASING`, framer `ease`)

| Token | cubic-bezier | Use |
|---|---|---|
| `out-soft` | (0.33, 1, 0.68, 1) | default decelerate, things arriving on their own |
| `out-strong` | (0.32, 0.72, 0, 1) | front-loaded, overshoot-free: things the user moves |
| `out-expo` | (0.16, 1, 0.3, 1) | long travel (≥ ~440ms), toast arrival, composer handoff |
| `in` | (0.4, 0, 1, 1) | every exit |
| `in-out` | (0.65, 0, 0.35, 1) | A-to-B with both ends visible: caret turns, accordions, widths, digit roll |
| `breathe` | (0.45, 0, 0.55, 1) | **the only loop curve** (no seam) |
| `out-back` | (0.34, 1.32, 0.64, 1) | ~3% overshoot, elements with mass; icon articulations; never opacity/colour |
| `spring` | **CSS var / framer: (0.22, 1, 0.36, 1)** · **Tailwind `ease-spring` utility: (0.34, 1.16, 0.64, 1)** | entrances that pop into place (see §16: the two disagree) |
| `drawer` | (0.32, 0.72, 0, 1) | sheets and docked panels (same numbers as out-strong, named for the job) |

### 8.3 framer presets (`src/lib/motion.ts`; all numbers derived from the generated tokens)

- `transition`: `press` (70, outStrong), `fast` (120, outSoft), `exit` (160, in), `base` (220, outSoft),
  `slow` (360, **outExpo**), `emphasis` (560, outExpo), `symmetric` (220, inOut).
- `spring` (mirrors Swift `JunoMotion`): `standard` {duration .22, bounce .05} · `emphasized`
  {.36, bounce .1} · `interactive` {stiffness 320, damping 30, mass .8} · `layout` {.36, bounce 0}.
  (Swift also has `reward` = spring(slow, bounce .18).)
- `variants`: `fade`, `rise` (y 6), `fadeUp` (y 6), `pop` (y 4, scale .96, in on `ease.spring`),
  `stage` (x 12, in on `transition.slow`), `swap` (scale .8, fast). `stagger(step=.03, delay)` exits
  reverse at half step. `flatten()` / `reducedVariants` strip x/y/scale/rotate.
- **CSS stagger**: `staggerDelay(i, rung, offsetMs)` with `STAGGER` = `tight` 30ms (dense rows),
  `base` 45ms (cards), `loose` 60ms; capped at index 10. Pair with
  `motion-safe:animate-rise-in [animation-fill-mode:backwards]`. The dock's step rows use
  `motion-safe:animate-fade-in-up` + `staggerDelay(i, "tight")` only when not streaming.
- Usage counts: `transition.base` 17, `transition.exit` 12, `spring.standard` 10, `transition.fast` 9,
  `transition.symmetric` 8; `layoutId` travelling thumbs in `tabs`, `segmented-control`,
  `surface-tabs`, `settings-rail`, sidebar nav (ids must be per-mount `useId()`).

### 8.4 Micro-interactions (`src/lib/micro.ts` + `ui/micro.tsx`)

`useTravelSquash` (stretch 0.10, squash ratio 0.6, peak at 0.35 of travel, `STRETCH_MS` = base),
`Swell` (on-switch overshoot 1.18), `Burst`, `RollingNumber`. Fired by a gesture nonce, never on
mount/hydration; all collapse to the endpoint under reduced motion.

---

## 9. Keyframes and animations (inventory)

### 9.1 Tailwind (`tailwind.config.ts`): `animate-*` → consumers

| Utility | Keyframe / timing | Reads `--motion-shift`? | Consumers (files) |
|---|---|---|---|
| `fade-in` | opacity 0→1, base, out-soft | n/a | 60 files; the live strip sentence, stream status, dock find bar |
| `fade-in-up` | 6px rise + fade, base, out-soft | yes | 15 (dock step rows, research run-controls, onboarding) |
| `rise-in` | 6px rise + fade, base, out-soft | yes | 104 (message turns, lists, approval card, source deck) |
| `pop-in` / `pop-out` | 4px drift (`--pop-shift`) + scale .96, base spring / fast in | yes | menus (`menuShellClass`), popover, composer shell, command palette, dock "jump to latest" pill |
| `modal-in` / `modal-out` | same keyframes, base spring / exit in | yes | `DialogContent`, skill dialog |
| `tooltip-in` / `-out` | half drift + scale .97, fast out-soft / fast in | yes | `TooltipContent` (`delayed-open` only; `instant-open` has no entrance) |
| `sheet-in` / `-out` | `--sheet-from` travel + fade, base drawer / exit in | yes | `SheetContent` |
| `overlay-in` / `-out` | fade, fast out-soft / base in | n/a | `DialogOverlay` (scrim leads on open, trails on close) |
| `check-morph` | scale .5 + −14° → 1, base spring | yes | 3 utility users + `.check-morph` class users |
| `stage-in` | x `--stage-dx` (12px), base out-strong | yes | plus-menu sub-panels, clarification popover, import dialog, step lab |
| `nudge` | 3px shake, base | yes | quiz wrong answer |
| `stroke-draw` | dash offset, slow out-expo | n/a | step lab |
| `title-out` | 4px up + fade, exit in | yes | chat-view memory note |
| `cite-flash` | `primary/.18` bg → transparent, slow out-soft | colour only (deliberately unguarded) | dock jump-to-source, memory entry row |
| `pulse-ring` | scale .9→1.3 + fade, 1.6s breathe ∞ | no (loop) | `research/run-timeline.tsx` (current stage) |
| `pulse-ring-once` | same, one shot | no | chat-view, quiz |
| `blink` | 1.1s steps(1) ∞ | | step lab caret |
| `thinking-matrix` | 3×3 travelling dark point, 1.8s breathe ∞ | loop (Tier A) | `signature/thinking-dots.tsx` only |
| `thinking-pulse` | opacity .3↔1, 1.8s breathe ∞ | reduced substitute | `thinking-dots.tsx` (centre dot under reduce) |
| `status-glow` | colour muted↔foreground, 2.8s breathe ∞ | colour only | canvas-panel, compare-pane |
| `icon-breathe` | scale 1↔1.1 + opacity, 2.6s breathe ∞ | killed under reduce | design page, artifact inline card |
| `gen-sweep` | 1/3-width hairline sweep, 1.8s breathe ∞ | killed under reduce | artifact inline card |
| `accordion-*`, `shimmer`, `dot-wave`, `title-in`, `fade-out`, `gen-drift-a/b`, `gen-grid-pulse`, `ultra-pan`, `ultra-spark`, `ultra-pop`, `shimmer-text` (utility) | | | **No consumers (dead)** |

tailwindcss-animate utilities are also used: the thought dock (and Code's session dock) enter with
`motion-safe:animate-in fade-in slide-in-from-right-4` at `duration-base ease-drawer` and leave with
`animate-out fade-out slide-out-to-right-4 duration-exit ease-in fill-mode-forwards`. Its hard-coded
16px translate cannot read `--motion-shift`, so reduced motion gets `motion-reduce:animate-in fade-in`.

### 9.2 Plain-CSS keyframes and classes (`globals.css`)

| Class → keyframe | Timing | Consumer | Reduced motion |
|---|---|---|---|
| `.aicss-shine` → `aicss-shine` (a *valley* of alpha sweeps a 300% gradient; `data-settled` stops it in place) | 2.25s breathe ∞ | `ThinkingState` → `ThinkingReasoning` header, `WebSearchBlock` label, `research/run-timeline`, `generation-placeholder` | stops (in-layer rule + unlayered kill list) |
| `.aicss-todo-item[data-state=active] .aicss-todo-label::before` → `aicss-shine` | 2.25s | `TodoList` | stops |
| `.shimmer-text` → `shimmer-text` (bright band muted→fg→muted, 250%) | 2.2s linear ∞ | `composer-dictation.tsx` only | static muted text |
| `.aicss-tr` / `.aicss-tr-sentence` → `aicss-fade-in` | 320ms / slow, out-soft | `ThinkingReasoning` | off |
| `.aicss-tr-stream` translate | **560ms** out-soft transition | live trace viewport (40px slots, 180px cap, 16px mask) | off |
| `.aicss-tr-collapsible` / `.aicss-ws-collapsible` / `.aicss-todo-collapsible` | `grid-template-rows` slow (+ base opacity) | AIcss disclosures | off |
| `.aicss-ws-site` → `aicss-ws-enter` (4px rise) | .34s out-strong | web search rows | off |
| `.aicss-ws-*` bullet (dashed ring → globe → check crossfade, check in `--success-ink`) | .22–.36s out-strong, .06s delay | web search rows | globe via render-time `matchMedia`; SMIL globe 7.2s |
| `.aicss-todo-item` → `aicss-todo-in` (−7px drop) | slow out-soft, 50ms × `--aicss-todo-i` | `TodoList` | off |
| `.aicss-todo-pie` (`@property --aicss-todo-pie`) / `.aicss-todo-digit-inner` roll | slow out-soft / slow in-out | to-do header | off |
| `.aicss-ig-glow` → `aicss-ig-morph` | 4.2s breathe ∞ | `ImageGenerationCanvas` | held at .7 |
| `.skeleton` → `skeleton-breathe` (opacity 1↔.62) | 1.8s breathe ∞ | 95 files | stops (unlayered) |
| `.stream-progress::before` → `stream-progress` (40% coral band) | 1.4s in-out ∞ | `app-shell.tsx` top 2px line while streaming | static `primary/.5` hairline |
| `.stream-tail` (mask, last 1.35em at 30% alpha) | not an animation | message-item prose > 140 chars | mask removed |
| `.voice-meter` / `voice-think` | 1.4s breathe, 0.12s stagger | voice | fixed height |
| `.animated-title--resolving` → `title-fade-out/in` | exit in / base out-soft | sidebar + chat title rename | old label hidden |
| `.ambient-aura` → `ambient-aura-in` | slow out-soft | `AmbientAura` (voice only) | base duration |
| `.research-enter`, `.research-tab-body` → `research-arrive` (4px rise) | exit out-soft; declared only under `no-preference` | `research-console.tsx` | none |
| `.animate-research-detail-in` → `research-detail-in` (−4px drop) | base out-soft | run-controls, run-timeline, report-reader (all `motion-safe:`) | n/a |
| `.check-morph` | base spring | settings, onboarding, auth forms, clarification popover | fade only |
| `.pressable`, `.control-*` press | transform `--dur-press`, rest `--dur-fast` | everywhere | no dip |
| `reduced-working` | 1.6s breathe | stand-in for `.animate-spin` under reduce | — |
| `.animate-research-stage`, `.juno-mark-popping`, `.reasoning-fast-toggle`, `.work-status-shift`, `.work-breathing`, `.work-crossfade(-ghost)`, `.glass-raised`, `.research-field` | | | **No consumers (dead CSS)** |

### 9.3 Loop periods (all off the `--dur-*` ladder on purpose)

thinking-matrix / thinking-pulse 1.8s · skeleton 1.8s · gen-sweep 1.8s · pulse-ring 1.6s ·
reduced-working 1.6s · stream-progress 1.4s · voice-think 1.4s · shimmer-text 2.2s · aicss-shine 2.25s ·
icon-breathe 2.6s · status-glow 2.8s · aicss-ig-morph 4.2s · web-search globe 7.2s · aura breath:
connecting 2.4s, thinking 3.4s, tool 5.2s.

### 9.4 The current thinking signature

`ThinkingDots` (`signature/thinking-dots.tsx`): an 18px (`size-4.5`) 3×3 grid of 4px dots, `gap-[3px]`,
base dots `bg-current opacity-25`, one `bg-foreground` point travelling clockwise then through the
centre (sequence 0,1,2,5,8,7,6,3,4), 0.2s offsets starting mid-cycle, 1.8s breathe loop with a faint
`box-shadow` trail. Under reduced motion only the centre dot pulses (opacity). Used by: the live strip
(`activity-timeline`), the stream status line (`message-item` `StreamStatus`), the dock header,
memory panels, artifact card, compare pane, learning renderer. The resting (settled) mark is a static
6px dot (`bg-muted-foreground/45`), hovering to `primary/70` on the strip. While the dock is open the
strip replaces the matrix with a static `bg-primary/70 ring-2 ring-primary/20` dot ("one breathing
element on screen at a time").

---

## 10. Motion rules from the docs (the contract)

From ICONS_AND_MOTION §2.2 (the interaction recipe), PREMIUM_AUDIT §3 and component notes:

1. **Hover is a tonal cross-fade** (`transition-colors duration-fast ease-out-soft` → `bg-accent`).
   Never `transition-all`; nothing lifts or casts a shadow on hover.
2. **Press is physical**: controls dip to `scale(.97)` in `--dur-press` (`.pressable`, `Button`,
   `Pressable`). **Large surfaces (rows, cards, panels) never scale**; they press tonally to `bg-selected`.
3. **Focus** is the global `:focus-visible` 2px `--ring` outline at 2px offset; no ring offsets, no
   local rings (text fields darken their border to `foreground/70` instead).
4. **Floating layers arrive from their trigger** (`origin-popper` + `--pop-shift`); tooltips use the
   quieter pair; dialogs `modal-in/out`; sheets `sheet-in/out`; a panel docking from an edge enters on
   `ease-drawer`.
5. **Lists are dealt, not dumped**: `rise-in` + `staggerDelay`, capped at ~8–10 rows.
6. **Disclosure is continuous**: caret rotates `duration-base ease-in-out`; content via
   `grid-rows-[0fr]→[1fr]` or `<Collapse>`; never an instant `hidden`.
7. **State swaps cross-fade** (`IconSwap` / `IconSwapSet` / `variants.swap`: opacity + scale .8→1 in
   `duration-fast`); copy→check holds ~1.5s.
8. **Only `transform` and `opacity` travel.** Width/height/top/left never animate (the composer textarea
   height tween is the single documented exception). Colour may cross-fade.
9. **Loops are for live state only** (thinking, streaming, recording). Nothing idle loops.
10. **Reduced motion is honoured everywhere** (§11).
11. **Nothing in chrome moves except a fill** (PREMIUM_AUDIT rule 10; ICONS_AND_MOTION later allows one
    hover articulation per glyph).
12. **Ambient motion must not borrow a loading gesture** (rule 14): no travelling highlight band on
    something that is not loading; a resting state that must look alive changes slowly as a whole.
13. **One breathing element on screen at a time** (activity-timeline): two indicators for one state read
    as two things happening.
14. **A phase change animates once; clock ticks and token growth never restart an animation**
    (strip `copyKey`, `aria-hidden` ticking text, stable `aria-label` that changes once on settle).
15. **Settle without reflow**: the live node keeps its box and stops moving (`data-settled`); the
    duration lives in the same node/slot/typeface in live and resting states.
16. **Nothing reflows under the reader**: fixed-slot live trace (40px slots, 2-line clamp, 180px cap,
    translate not scroll), `.stream-tail` mask instead of per-token animation, no trailing caret/orb,
    auto-scroll follows only if the reader was already at the bottom (24px slop).
17. **Spinners are for the button you just pressed**, not long-running rows (Work note): long runs use
    slow breaths or static state marks.
18. **Ambient light belongs to voice only** and sits behind content (aura, rule 9).

---

## 11. Reduced motion

Policy (globals.css "Reduced motion, in tiers"):

- **Tier A (kept):** opacity, colour, background-colour and anything carrying real state
  (thinking-matrix, status-glow, gen-sweep's state, the stream tail's meaning). Removing feedback is not
  an accessibility win.
- **Tier B (travel collapses):** under `prefers-reduced-motion: reduce`, `:root` sets
  `--motion-shift: 0`, `--motion-scale-from: 1`, and flattens `--ease-out-strong`, `--ease-out-expo`,
  `--ease-spring`, `--ease-drawer` to `--ease-out-soft` and `--dur-slow` to `--dur-base`. Every
  transforming keyframe multiplies its travel by `var(--motion-shift, 1)` and starts from
  `var(--motion-scale-from, x)`. **Any new transforming keyframe must do the same.**
- **Tier C (decorative loops stop):** the **unlayered** kill list at the end of globals.css:
  `.skeleton`, `.shimmer-text`, `.aicss-shine`, `[class*="animate-icon-breathe"]`,
  `[class*="animate-gen-"]`, `[class*="animate-ultra-"]` → `animation: none !important`. Stock
  `.animate-spin` becomes `reduced-working` (fade in place, 1.6s); `.animate-ping`/`.animate-pulse` stop.
  Rules that must beat a utility **must live in that unlayered block**, never in `@layer base`.
- Components: `motion-safe:` (162 files) / `motion-reduce:` (136 files) variants; framer
  `useReducedMotion()` (25 files) and `<MotionConfig reducedMotion="user">` in AppShell (a framer subtree
  outside AppShell needs its own); `Collapse` snaps rows and keeps the fade; `Pressable` keeps colour
  timing and drops the dip; icon articulations and `.juno-part` transitions are off; `ThinkingDots`
  falls back to a centre-dot opacity pulse; SMIL (the web-search globe) cannot be stopped by CSS, so
  the component checks `matchMedia` at render and draws the static Globe glyph; the aura freezes its
  clock but stays visible (it is information); `work-breathing`-style state rings hold a mid value rather
  than disappearing. Also honoured: `prefers-reduced-transparency` (scroll-fade blur off) and
  `prefers-contrast: more` (float borders at full `--border`).

---

## 12. What the run UI looks like today (the vocabulary a redesign replaces or reuses)

- **Live strip** (`chat/activity-timeline.tsx`, above each assistant turn): a `Pressable kind="row"`
  (`rounded-field`, `-mx-2 px-2 py-1`, `min-h-9` live / `min-h-8` resting, 44px coarse). Live:
  `ThinkingDots` + one `text-reading text-muted-foreground` sentence ("Thinking", "Searching for “…”",
  "Reading domain.com · 9 sources", "Using Tool · detail", "Writing", then "Still thinking…" at 2 min,
  "Still working. You can leave…" at 10 min) + `formatSpan` elapsed, fading in once per phase. Below it
  (live only, `aria-hidden`): `WebSearchBlock` and headless `ThinkingReasoning`. Resting: a 6px dot,
  `text-ui` "Thought process" / "Run" in `text-foreground/80 font-medium` + "· N searches · N sources ·
  N tool calls", mono caption duration, `ChevronRight` inking on hover. Pressing it docks the panel.
- **Thought dock** (`chat/thought-process-panel.tsx`, 1,647 lines, lazy-loaded, portalled into a
  `bg-card` column in `chat-view.tsx`): header `min-h-12 border-b border-border/60` with Back chevron
  (below split), `ThinkingDots`/static dot, `text-ui font-medium` status word (Researching / Thinking /
  Writing / Done / Stopped), mono elapsed, filter dropdown (find, kinds with counts, Summary/Full trace),
  a find bar (`h-10`, `animate-fade-in`), a figures row (mono `text-ui` values over mono `text-label`
  captions: Elapsed, Cost, …), a warning Notice block, and **one spine of step rows** (marker / label +
  caption detail / mono figure / hover-revealed 28px action; running = primary marker ring, failed =
  warning; expandable body with `ChevronRight` rotate-90 and `grid-rows` transition; tool bodies are
  args/result via `AicssCodeBlock`), sticky mono section labels, a `rounded-full` "jump to latest" pill
  (`shadow-float`, `animate-pop-in`), cite-flash on jump-to-source. Dock enter/exit as in §9.1; resize
  handle tints `primary/40` on hover (the one accent use on the edge).
- **AIcss blocks** (`components/aicss`, ported from aicss.dev onto tokens; gallery `/dev/aicss`):
  `ThinkingState`, `ThinkingReasoning`, `WebSearchBlock`, `TodoList`, `AicssCodeBlock`, `FileDiff`
  (3px add bar solid / delete bar hatched, `success`/`destructive` at .12/.18), `CitationFooter`,
  `ImageGenerationCanvas`. Their CSS still carries off-ladder px timings and sizes (§16).
- **Research** (`components/research/*`): `.research-surface` cards, `.research-icon` header controls,
  `research-arrive` / `research-detail-in` entrances, `pulse-ring` on the current stage in
  `run-timeline`, staggered source deck (`tight`), report reader at `text-body-lg`. Depth names come
  from `research/effort-copy.ts` (`Quick`, `Standard`, `Deep`, `Max` + "N researchers · up to N pages"
  + "~N min"), consumed by `run-controls.tsx`, `composer.tsx`, `composer-shell.tsx`, `lib/chat/request.ts`,
  `api/research/protocol.ts`. The thinking-effort slider (`chat/reasoning-slider.tsx`, Instant…Max)
  is a separate control; its top rung no longer animates.
- **Status badge** (`ui/agent-status-badge.tsx`): mono label pill with a dot that `animate-ping`s for
  thinking/running/waiting/streaming. Note: it uses `bg-primary/10` fills and `animate-ping`, both of
  which the newer rules discourage (tinted pills, idle-looking pings).

---

## 13. Banned patterns and how they are enforced

| Pattern | Enforcement |
|---|---|
| Direct `lucide-react` / `@phosphor-icons/*` import outside `icons.tsx` | ESLint `no-restricted-imports` (error) |
| `rounded-[Npx]` off the ladder | `design-system/no-arbitrary-radius` (error, autofix to a rung; allow `0.25em`) |
| Nested radius ≠ parent − padding | `design-system/concentric-radius` (error) |
| Hand-picked `z-[n]` | `design-system/no-ad-hoc-stacking` (error) |
| `text-[Npx]`, stock `text-xs/sm/base/lg…` | `no-arbitrary-text`, `no-raw-text-size` (warn, ratchet) |
| Token drift web ↔ native | `npm run design:tokens:check` |
| Raw hex, `shadow-2xl`, raw `shadow-[…]`/rgba, `rounded-2xl/3xl`, `transition-all`, numeric `duration-[…]`, `uppercase` eyebrows, `backdrop-blur` on reading surfaces, gradient gloss overlays, film grain, tinted glows/halos under buttons, travelling shimmer bands on non-loading UI, per-icon hover choreography in the sidebar, coral on furniture, meters beside numbers in chrome, all-caps, more than two panes in a picker, borders/fills on unselected list rows, glyphs on documents (only on destinations) | Docs only (FLAT_UI, PREMIUM_AUDIT §3, ICONS_AND_MOTION, CODEX_PROMPT). Current tree: 0 live `transition-all`; ~4 non-avatar `uppercase`. |

---

## 14. Implementation gotchas (each one has bitten this codebase)

1. **Layer order:** `.surface-*`, `.control-*`, `.aicss-*`, `.pressable` are `@layer components`; any
   `bg-*`/`border-*`/`shadow-*`/`transition-*` utility on the same element wins silently.
2. **tailwindcss-animate reads `duration-*` and `ease-*` as animation timing too.** `duration-fast
   motion-safe:animate-fade-in` retimes the fade (used on purpose). Where you do not want that, write
   `[transition-duration:var(--dur-fast)]` (as `Pressable` and `menuGlyphInkClass` do).
3. A later `transition` list replaces `.pressable`'s; name `transform var(--dur-press)` yourself or the
   dip snaps.
4. Tailwind only emits a keyframe when its `animate-*` utility appears in the content glob; a plain-CSS
   class needs its own `@keyframes` in globals.css (why `shimmer-text`/`check-morph` exist twice).
5. `globals.css` **cannot be split into `@import`ed files** (it drops the whole `@layer components`
   block). highlight.js and pdf.js rules must stay unlayered (runtime-stamped classes get tree-shaken).
6. New transforming keyframes must read `--motion-shift` / `--motion-scale-from`; tailwindcss-animate's
   `slide-in-*`/`zoom-in-*` cannot, so pair them with a `motion-reduce:` fade.
7. Reduced-motion overrides that must beat utilities go in the **unlayered** block at the file end.
8. `ease-spring` (utility) ≠ `var(--ease-spring)` (keyframes, framer). Pick deliberately.
9. Icons animate individual `translate/rotate/scale`; put your own transforms on a wrapper (as
   `IconSwap` does) so the glyph's articulation still composes.
10. framer `layoutId` is page-global: derive it from `useId()` (the sidebar mounts twice).
11. Radix content is portalled to `<body>`: style highlighted rows via `[data-highlighted]` on the
    content itself, never through an app ancestor selector.
12. A thing that animates `transform` becomes a containing block for `fixed` children (why page
    transitions are opacity-only and the aura canvas owns its own `translateZ(0)`).
13. Live-updating text inside a button is read by screen readers on every tick: hide it (`aria-hidden`)
    and carry state in a stable `aria-label`.
14. `Collapse`: padding/borders go in `innerClassName`, never on the grid item.
15. Sonner overrides need (0,5,0) specificity (its CSS is appended at runtime).

---

## 15. Verification: dev galleries (all `notFound()` in production, no auth, real components on fixtures)

| Route | What it renders | Useful for the redesign |
|---|---|---|
| `/dev/aicss` | Every AIcss block in every state: Thinking State, Thinking + Reasoning (±1 line stepper), Image Generation, Web Search (done/loading/pending rows), Code Block, File Diff, To-do List (step back/forward), Inline Citations, Streaming Text; theme toggle via `useTheme` | Thinking label shimmer, live trace, search rows, tool-result code/diff bodies |
| `/dev/polish` | Real `MessageItem`: reading size, **Thinking** (the stream status line, then the line above a live reasoning trace), editing a sent message, starter chips, empty/error states, text field, skeletons | Live strip + stream status + reasoning trace in the transcript column |
| `/dev/controls` | Button variants/sizes, SegmentedControl, Pressable chip/row/tile/icon, tonal state ladder, Badge, every menu side by side (incl. composer `+` menu), toolbars, icon registries (AppIcons, ActionIcons, StatusIcons) | Row/hover/selected states, menu recipe, icon vocabulary |
| `/dev/glyphs` | Juno marks at every size/weight, in sidebar, menu, settings rail, articulation held on | New tool glyphs |
| `/dev/composer-landing` | Landing + docked composer frames, in-chat task panel (`WorkRunPanel`) | Composer tool marks, run panel in transcript |
| `/dev/task-handoff` | `ApprovalCard`: above cost bar, outside content, settled, connector approval | Tool approval UI |
| `/dev/library` | Library grid, drop overlay, empty/loading, model picker stage one, `ReasoningSlider` | Effort control |
| `/dev/shell` (`?shell=1`, `?many=1`, `?quota=near`, `?w=224…336`) | Real `AppSidebar` / `AppShell` (incl. `stream-progress` line) | Shell context, left sidebar |
| `/dev/settings` (`?section=`, `?frame=modal`, `?frame=logos`, `?hosts=0`) | Settings rail/pane/modal, provider marks | Provider logos for tool/connector rows |
| `/dev/memory` (`?state=full|paused|empty|loading|project|activity`) | Memory page + activity sheet (uses `ThinkingDots`, sheets) | Sheet motion, memory steps |
| `/dev/documents`, `/dev/learning`, `/dev/skills` (`?view=`) | File tiles/viewer; learning blocks; skills library | Peripheral |
| `/aura-preview` | Voice aura bench driving every `AuraState` (`window.__aura`) | Aura inks (`--ultra`, `--source`) |

**Gaps (no gallery exists):** the **thought dock** (`ThoughtProcessPanel`) in any state; the
`ActivityTimeline` with **search / visit / tool / memory / warning events** (the polish fixture has
reasoning only); **tool-call rows** and tool args/result bodies in context; the **research** console,
plan gate, live run timeline, source rail/deck, evidence panel, report reader and recap (design-qa.md
records these as never visually verified); `AgentStatusBadge` / `SubagentTree`. A redesign should add
e.g. `/dev/run?state=live|tools|research|done|failed&dock=1` and `/dev/research?state=plan|live|report`
following the same contract (`page.tsx` with `notFound()` in production, fixture events fed to the real
components, a portalled dock container, both themes via the browser's colour scheme or a toggle,
reduced motion via emulation).

---

## 16. Inconsistencies and bugs found (fix or design around)

1. **Two different "spring" curves.** `--ease-spring` / `EASING.spring` / framer `ease.spring` =
   `(0.22, 1, 0.36, 1)` (no overshoot), but Tailwind's `ease-spring` utility = `(0.34, 1.16, 0.64, 1)`
   (≈2% overshoot). The globals.css comment, SOFT_UI §2.4, JUNO.md §3.3 and motion.ts all claim they are
   the same overshooting curve. Effect: `animate-pop-in`/`modal-in`/`check-morph`/framer `variants.pop`
   do not overshoot; only `checkbox`, `radio-group` and `IconSwap curve="spring"` do.
2. **Dead motion code** a redesign can delete or reuse: Tailwind keyframes `accordion-*`, `shimmer`,
   `dot-wave`, `title-in`, `fade-out` (utility), `gen-drift-a/b`, `gen-grid-pulse`, `ultra-pan/spark/pop`,
   `shimmer-text` (utility); CSS classes `.animate-research-stage`, `.juno-mark-popping`,
   `.reasoning-fast-toggle`/`reasoning-fast-charge`, `.work-status-shift`, `.work-breathing`,
   `.work-crossfade(-ghost)`, `.glass-raised`, `.research-field`. The Tier C kill list still names
   `animate-ultra-*`.
3. **PREMIUM_AUDIT says "And Max moves"** (a sheen on the top effort rung); `reasoning-slider.tsx`
   says the top rung is still, and the `ultra-*` keyframes have no consumer. The doc is stale.
4. **JUNO.md §3 is stale** throughout (see §0). FLAT_UI §3 has the live table.
5. **Custom hex accent never sets `--primary-ink`** (`app-provider.tsx`), and `data-accent="#hex"`
   matches no rule, so `text-primary` (ink) stays coral while fills use the custom colour. It also
   sets `--ring` to the accent where presets use a neutral ring.
6. **AIcss CSS is off the ladder** in places: timings 320ms, 560ms (hard-coded, equals `emphasis`),
   .22/.24/.26/.28/.32/.34/.36s, .16s (citations), 360ms (to-do label), 50ms stagger (not a `STAGGER`
   rung); raw `font-size` 13/12/11px and **9px** (`.aicss-cite-mark`, below the 10.5px floor);
   radii 14/12/5/4px.
7. `activity-timeline.tsx` comment says Pressable's selected state is "primary tint plus an inset
   ring"; the actual row selected state is `bg-selected` only.
8. Dark `--shadow-soft`/`--shadow-lift` are not redefined in `.dark`; they resolve to black at 4–8%
   alpha on charcoal (effectively invisible). Harmless unless a redesign relies on them.
9. `components.json` still says `iconLibrary: "lucide"`.
10. `research-detail-in` and `research-arrive` do not read `--motion-shift` (they are only used behind
    `motion-safe:` / `no-preference`, so no current leak, but they break the stated rule).
11. `AgentStatusBadge` uses `animate-ping` and `bg-primary/10` tinted pills, which conflict with the
    newer "armed tools are neutral" and "loops only for live state, no idle pings" guidance.
12. Numerous globals.css comments describe a `#000` dark ground, `--card` 6.5% and a "9% charcoal" era;
    the live dark ground is 11.5%. Do not reason from those numbers.

---

## 17. Design constraints for the redesign, in one list

- Draw with the existing tokens: `bg-card`/`bg-popover`/`bg-secondary` surfaces, `border-border`
  hairlines, `--accent` hover → `--selected` on, `text-muted-foreground` secondary ink, accent only for
  running/live state and the primary action; success/warning/destructive via their ink ramps.
- Type: `text-reading` for transcript-level status sentences, `text-ui` for rows, `text-caption` for
  detail lines, `font-mono tabular-nums` (`text-caption`/`text-ui`) for durations, counts, cost;
  sentence case; 400/500/600.
- Radii: rows `rounded-control`, blocks/wells `rounded-field`, cards `rounded-card`, dock inner corners
  none (it is a column), pills `rounded-full`; keep concentric math.
- Icons: new tool glyphs through `icons.tsx` + a registry (a per-tool map would be new); 12–16px;
  monochrome by kind; articulation only on actionable glyphs; status marks static.
- Motion: durations from the ladder (fast for hover/ink, base for rows/carets/menus, slow for panel
  regions, exit for leaving, emphasis only for unrequested completions); curves by job (out-soft default,
  in for exits, in-out for carets/rolls, drawer for the dock, breathe for loops); one live loop visible
  at a time; phase changes animate once; no reflow under the reader; every transforming keyframe reads
  `--motion-shift`; decorative loops added to the unlayered kill list; framer only where interruption,
  layout continuity or physics is needed, using `@/lib/motion` presets.
- Verify in a new `/dev/*` gallery, both themes, all six accents where accent is used, reduced motion on.
