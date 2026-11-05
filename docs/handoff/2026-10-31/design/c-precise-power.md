# Direction C: Precise Power

Alevr's whole UI system (web, macOS 26 and iOS 26) built for keyboard-first craft: dense but calm, one floating "command surface" for every list of choices, compact 32px rows with a fixed trailing column for shortcuts, strong focus and selected states, and motion that settles in 70 to 160ms.

Companion mockup: `c-precise-power.html` (open it locally; use the "Slow motion 4×" switch to inspect each motion step). Screenshots: `c-precise-power-*.png`.

---

## 0. Thesis in one screen

| | Today (from the maps) | Precise Power |
|---|---|---|
| Menus | 6 systems: radii 8/12/14/16/18; rows 32/34/36/46; type 13/14/15; three highlight motions | **One command surface** (`.cmd`): radius 12, inset 4, rows 32 (44 coarse), 13/20 type, instant highlight, one trailing slot, search row on every menu longer than 7 items |
| Model picker, `+`, `/`, ⌘K | 4 different primitives | The **same component** in four sizes (M 272, L 320, palette 560) with the same row, search row and footer hints |
| Composer | 26 radius, 36 disc, 7 glyph sizes, grey voice disc as the weakest object | 20 radius, 8 inset, every control 32×32 at radius 12 (concentric), one 16px glyph size, ink primary disc always the strongest object, inline tools row |
| Motion | 11 entrance recipes, 220ms pop for menus | 3 recipes: **layer** (70 opacity + 120 transform), **modal** (120 + 160), **sheet** (spring). Highlights are instant. No duration rung added |
| Icons | Lucide/house split, 4 line weights | One family drawn with SF Symbols geometry, line 1.25/1.5/1.75 by optical size, round caps, mapped 1:1 to SF Symbols on native |
| Native | Glass on content, custom orbit switch, 32 button styles, bitmap icons | Glass only on toolbar, sidebar, floating composer, system menus/popovers/sheets; system `Menu`/`Picker`/`confirmationDialog`; SF Symbols; same IA and row metrics as web |

**Kept as-is (hard constraints honoured).** Token pipeline (globals.css + tailwind.config.ts → TS + Swift), closed duration ladder 70/120/160/220/360/560, no blur entrances, no `backdrop-filter` in product, no opacity on text-colour tokens, presence/signal/destructive semantics, keyboard-only focus ring, Inter/Newsreader/JetBrains jobs, 12px type floor, the shell contract (send/stop/voice/busy faces, `+` row ids), flat transcript, owner rules 1–9 (no chips above the composer: the landing has none above or below).

**Rules this direction asks to change** (each one is explicit and reversible):

| # | Rule today | Change | Why |
|---|---|---|---|
| R1 | "iOS and Mac draw the web's icons, never SF Symbols" (`sficons` gate: iOS hard zero, Mac ratchet) | Invert: native chrome uses **SF Symbols** for every concept that has one (table §I.4). `juno.*` custom symbols remain only for brand marks: Alevr, orbit, galaxy, agent face, incognito ghost. Web redraws its family on SF geometry so the two read as one | Dynamic Type scaling, weight matched to SF Pro, symbol effects for morphs, system menus render them natively; today's bitmaps ignore Dynamic Type (iOS map #7) |
| R2 | `check-native-glass.mjs` exempts the phone; Mac allow-list of 5 sites | Remove the phone exemption; one allow-list per platform (§I.2) | 114 phone glass sites put glass on content |
| R3 | Hover articulation on destination icons (`data-jicon-articulate`, icons.css "Icon buttons" block) | Remove all icon articulation and the 1.08 SVG hover scale | Icons are type, not toys; the scale resamples fitted drawings (icons map §5) |
| R4 | `--input` ≥ 3:1 on every field | Kept for form fields. **Exception:** search fields inside overlays/toolbars and the composer are identified by fill + glyph + placeholder; `prefers-contrast: more` restores the `--input` border | Removes the heaviest edge on every page (components map §6.1) while keeping WCAG 1.4.11 |
| R5 | `menu-recipe.ts` widths `w-56`/`w-72`, row 36 | Widths 224 / 272 / 320 / 560 (palette), row 32 | Density and ChatGPT/Linear parity |
| R6 | `text-label` = JetBrains Mono 12/500 | `text-label` = Inter 12/16/400. New `text-label-mono` for paths, ids, receipts | 720 mono metadata sites read as a dev console |
| R7 | Tooltip delay 200 / skip 400 | 400 / 300 | Keyboard users get shortcuts from the menus; tooltips should not flash on casual hover |

---

## A. Foundations

### A1. Spacing scale (4px base; the 2px half-step survives only inside controls)

| Token (Tailwind) | px | Role |
|---|---|---|
| 0.5 | 2 | thumb inset in segmented/switch, icon optical nudges |
| 1 | 4 | **menu inset**, gap between composer controls, gap label→description |
| 1.5 | 6 | tooltip offset, chip inner gap |
| 2 | 8 | row padding-x, icon→label gap, composer inset, button gap in footers |
| 3 | 12 | card inner gap, dialog header→body |
| 4 | 16 | panel gutter, card padding, sidebar edge, field text inset in composer |
| 5 | 20 | dialog padding-x |
| 6 | 24 | transcript turn gap, section gap in settings |
| 8 | 32 | page gutter ≥1024 |
| 10 | 40 | group gap in settings |
| 16 | 64 | empty-state vertical padding |

Banned in components: 10, 14, 18, 22 (half-steps above 6) and every arbitrary `[..px]` spacing. Heights snap to 4: 16, 20, 24, 28, 32, 36, 44, 48, 56.

### A2. Radius ladder (concentric: container > inset > item)

| Rung | px | Used by | Change |
|---|---|---|---|
| micro | 2 | progress track, focus nubs | — |
| sm | 4 | kbd, badges, checkbox, skeleton lines | — |
| xs | 6 | tooltip, segmented thumb (inside 8 − 2), tokens 24px | — |
| control / md | 8 | buttons, fields, icon buttons, rows (menu, list, sidebar), segmented track | — |
| field | **8** | (alias of control) | 10 → 8 |
| card / popover / bubble | 12 | cards, toasts, popovers, hover cards | — |
| menu | **12** | every command surface | 14 → 12 |
| panel | 16 | dialogs, sheets (top corners), canvas panel, ⌘K on native | — |
| composer | **20** | composer shell | 26 → 20 |
| composer-control | **12** | every composer control (20 − 8 inset) | 14 → 12 |
| composer-action | **12** | send/stop disc | 16 → 12 |
| full | 9999 | avatars, switch, radio, status dots | — |

Concentric pairs (the `design-system/concentric-radius` table): menu 12 − inset 4 = row 8 · composer 20 − 8 = control 12 · segmented 8 − 2 = thumb 6 · card 12 − 4 = thumb/preview 8 · dialog 16 − 8 = inset well 8 · app content card 12 (8px frame) · image chip in composer 20 − 8 = 12.

### A3. Hairlines (three, and only three)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--border` | 220 4.9% 88.0% `#DFE0E2` | 225 3.6% 22.0% `#36373A` | dividers, card edges, separators inside menus |
| `--border-float` (new) | = `--border` | 225 4% 28% `#45464A` | edge of every floating layer (dark floats are lighter, so their edge is lighter) |
| `--border-strong` (new) | 220 5% 80% `#C9CBCF` | 225 4% 32% `#4E5055` | hover edge on interactive cards, secondary button edge |
| `--input` (value change) | 214 3% 58% `#919397` (3.08:1 on white) | 220 2.6% 45.1% `#707276` (3.26:1 on card) | form fields, checkbox, radio, switch-off ring |

All 1px. `0.5px` on ≥2dppx is not used: a 1px line at 88% L already reads as a hairline.

### A4. Surfaces and fills

| Token | Light | Dark | Notes |
|---|---|---|---|
| `--background` (page/content) | `#FCFCFD` | `#18191B` | unchanged |
| `--sidebar` (frame) | `#F3F4F5` | `#111213` | unchanged |
| `--card` (composer, cards) | `#FFFFFF` | `#222326` 14.1% | unchanged |
| `--popover` (menus, popovers, dialogs, toasts) | `#FFFFFF` | **`#2C2D30` 18%** | dark 16.1 → 18: elevation = lighter surface + `--border-float` |
| `--muted` (wells, search fields) | `#F5F6F7` | `#1F2023` | unchanged |
| `--accent` (hover) | `#EFF0F1` | `#2D2E31` | unchanged |
| `--menu-highlight` (new; active row in any list overlay) | 220 8% 92.5% `#EAEBED` | 225 4% 24% `#3B3C40` | fg on it 14.5 / 8.8:1; descriptions use `--muted-foreground-on-fill` (5.1 / 4.85:1) |
| `--selected` (on/held) | `#E6E7E9` | **228 4.4% 24.5% `#3C3D41`** | dark 22.5 → 24.5 so it no longer equals `--border` |
| `--destructive-tint` (new; destructive row highlight) | 356 72% 96% `#FCEDEE` | 356 35% 20% `#452124` | destructive-ink on it 5.7 / 5.1:1 |
| `--primary` / `-hover` (new) / `-press` (new) | `#191B1E` / 216 8% 22% `#34373D` / 216 7% 28% `#42464C` | `#E8E9EB` / 220 8% 97% `#F7F7F8` / 220 6% 84% `#D4D5D9` | primary hover is a real tone step (brightness() was invisible) |
| `--tooltip` (new) / `--tooltip-foreground` / `--tooltip-muted` | 220 9% 12% `#1C1E21` / `#FAFAFA` / 220 5% 70% `#AFB1B6` (7.8:1) | 225 5% 26% `#3F4146` / 220 7% 95% / 220 4% 72% (5.1:1) | replaces raw `hsl(222 9% 12%)`; keycaps inside tooltips read |
| `--composer-border` / `-focus` (new) | 220 6% 86% `#D9DBDD` / 220 5% 70% `#AFB1B6` | 225 4% 24% / 225 4% 38% | replaces `fg/.10` / `fg/.18` alphas |
| `--grabber` (new) | 220 5% 78% | 225 4% 36% | one grabber ink |
| `--scrim` (value change) | 220 10% 8% / 0.32 | 0 0% 0% / 0.60 | rehued from warm 48°; light raised .26 → .32 (ChatGPT .30) |
| `--hairline` (value change) | 220 9% 11% / 0.06 | 220 7% 92% / 0.08 | rehued from warm |
| `--muted-foreground-on-fill` dark | 68% `#AAACB1` | | 66.5 → 68 so it clears 4.5:1 on `--menu-highlight` |
| `--destructive-ink` dark | 356 72% 70% `#EA7B83` | | 66 → 70: 5.0:1 on `--popover` dark |

High-contrast blocks: `--menu-highlight` → `--selected`; `--border-float` / `--composer-border` → `--input`; menu keyboard ring alpha → 1.

### A5. Elevation per surface type

Light uses shadow; dark uses a lighter surface plus `--border-float`, with a short dark shadow only for separation.

| Level | Surfaces | Light | Dark |
|---|---|---|---|
| e0 flat | transcript, page, sidebar rows | none | none |
| e1 raised | in-flow cards (1px `--border`), composer at rest (1px `--composer-border`) | `--shadow-raised: 0 1px 2px ink/.05` | none (edge only) |
| e2 float | menus, popovers, hover cards, toasts, ⌘K | `--shadow-float: 0 1px 2px ink/.05, 0 8px 24px -4px ink/.14` + 1px `--border-float` | `0 1px 2px #000/.30, 0 12px 32px -4px #000/.50` + 1px `--border-float` on `--popover` 18% |
| e3 modal | dialogs, sheets | `--shadow-modal: 0 2px 6px -1px ink/.08, 0 24px 56px -12px ink/.28` + 1px `--border-float` + scrim .32 | `0 2px 6px #000/.35, 0 24px 64px -8px #000/.60` + 1px `--border-float` + scrim .60 |
| tooltip | tooltips only | `--shadow-tooltip: 0 2px 8px -2px ink/.28` on `--tooltip` | same on `--tooltip` 26% + `inset 0 0 0 1px #fff/.06` |

`ink` = `hsl(var(--shadow-ink))`. No ring baked into shadows (the border carries the edge).

### A6. Type rungs for UI chrome (Inter unless stated)

| Rung | Size / line / weight / tracking | Use |
|---|---|---|
| `reading` | 16/26 · 400 · −0.006em (composer field: 16/24) | transcript, composer field |
| `heading-sm` (new) | 15/20 · 600 · −0.006em | dialog, sheet, popover and panel titles |
| `ui` (line-height change 1.5 → 20px) | 13/20 · 400 | every row, button, input, menu label, sidebar row (sidebar `nav` 14 → `ui` 13) |
| `ui` strong | 13/20 · 500 | buttons, selected rows, model chip |
| `label` (family change, R6) | 12/16 · 400 · 0 | descriptions, shortcut column (tabular-nums), section labels at 500 |
| `label-mono` (new) | JetBrains Mono 12/16 · 400 | paths, ids, receipts |
| `kbd` | JetBrains Mono 11/16 · 500 | keycaps in tooltips and the palette footer only |
| Newsreader | 40/48 · 400 · −0.03em (greeting, opsz 60); 20/26 · 400 (empty-state title) | greeting, page h1, empty states (unchanged jobs) |

No uppercase, no letter-spaced eyebrows. Section labels are 12/16 · 500 · `--muted-foreground`.

### A7. States (one ladder for every interactive object)

| State | Rows (menu, list, sidebar) | Buttons / icon buttons | Fields |
|---|---|---|---|
| rest | transparent; glyph `--muted-foreground`; label `--foreground` | variant fill | `--card` + 1px `--input` (search: `--muted`, no edge) |
| hover (`(hover:hover)` only) | `--accent` (sidebar: `--sidebar-hover`); **0ms in, 70ms out** | ghost → `--accent`; primary → `--primary-hover`; secondary edge → `--border-strong` | edge `--border-strong` |
| active / highlighted (menus, combobox) | `--menu-highlight`, glyph → `--foreground` | — | — |
| keyboard highlight | `--menu-highlight` + `inset 0 0 0 1px hsl(var(--ring)/.6)` (≥3.5:1) | global ring | global ring |
| pressed | fill `--selected`, no scale on rows | scale .97 (≤64px wide) over 70ms + press fill | — |
| selected / on | `--selected` + label 500 + **filled** glyph (sidebar destinations only); in menus a trailing 16px check in `--foreground` | `--selected` + filled glyph (`aria-pressed`) | — |
| focus (pointer) | — | none | edge `--ring`/.72 |
| disabled | label `--muted-foreground`, glyph `--muted-foreground`, reason as trailing `label` text; still focusable by keyboard in menus | label `--muted-foreground`, fill `--muted`, no edge, `cursor: not-allowed`. **No opacity dimming** (no five opacities) | fill `--muted`, edge `--border`, text `--muted-foreground` |
| destructive | label + glyph `--destructive-ink`; highlight `--destructive-tint` | fill `--destructive`, text white | invalid edge `--destructive` |

### A8. Focus ring

One ring: `outline: 2px solid hsl(var(--ring)); outline-offset: 2px` (3px in HC), keyboard modality only. Inside list overlays the row keeps its rounded fill and adds the 1px inset ring of A7 (an outline would clip against the 4px inset). Fields: 1px edge to `--ring` plus the global outline on keyboard focus. Composer: the shell gets the outline (offset 2, follows radius 20). Forced colours: `Highlight`.

---

## B. Icons

### B1. Grid and construction
- **Canvas 24 units**, live area 20 (2-unit padding). Keylines: circle Ø20, square 18, portrait 16×20, landscape 20×16. Nothing touches the canvas edge (fixes `crew`, `connect`, `code`, `share`, `versions` overflow).
- **Strokes**, not outlines, on the web, with `vector-effect: non-scaling-stroke` so the line is set in CSS px per optical size (B2). Native exports via SF Symbols templates (R1).
- **Caps and joins:** round caps, round joins everywhere. Container corners r 2.5 units (≥15 units wide) and r 1.5 units (smaller); no plain arcs vs `rr` split.
- **Gaps:** where a stroke meets another shape, leave 1.5 units (search handle, slash composites). Slashes cut the outline only (no knockout fragments at 16px).
- **Points:** dots are filled circles of radius ≥ 0.6 × line (≥1.4 units at 16px).
- **Mass:** ink coverage at 24px within 0.18–0.30 for the whole family; outliers are redrawn, not nudged.

### B2. Optical sizes and line weights

| Optical size | Line (CSS px) | Line / box | Pairs with | Detail rule |
|---|---|---|---|---|
| 14 | 1.25 | 8.9% | 12px text (chips, metadata, badges) | small cut: max 3 strokes, no inner detail |
| 16 (default) | 1.5 | 9.4% | 13px `ui` (menus, buttons, sidebar, composer) | full drawing |
| 20 | 1.75 | 8.75% | 15–16px text, toolbar on touch, empty states | full drawing |
| send / stop (hero) | 2.0 at 16 | 12.5% | ink disc | bold cut, the only bold |

Stem ratio (identity-v2): line ÷ Inter stem at the paired size stays 1.05–1.15 (Inter 13 regular stem ≈ 1.35px; 1.5/1.35 = 1.11). The composer row uses **only** 16 (send/stop bold cut at 16 too); chevrons are 14.

### B3. Fill vs outline
Outline at rest, always. Filled variant **only** for a persisting on-state: selected sidebar destination, pinned (pin.fill), starred, rated (thumbs), armed tool token (globe.fill when Web search is on). Never fill on hover or focus. Status glyphs (success/alert) are outline circles with the status ink.

### B4. Alignment to text
Glyphs are centred on the **cap-height centre**, not the line box. Labels in icon rows use `text-box: trim-both cap alphabetic` (Chrome 133+, Safari 18.2+); fallback is a `translateY(-0.5px)` on 16px glyphs beside 13px text. Per-glyph nudges live in the drawing data (crew, agent, lock, cloud up 1 unit; auto down 1 unit).

### B5. Off-style glyphs on today's sheet (icons-sheet.png) and the redraw

| Glyph | What is off | Redraw |
|---|---|---|
| `chat` | Lucide bubble, tail barely registers | One `BUBBLE`: 16×13 rounded rect r 2.5, tail as a 3-unit notch at bottom-left; shared by chat, chats, chat-question, thought |
| `orbit` | two arcs + three ring satellites, 2× the mass of `code`; reads as a spinner | Single ellipse (20×10, rotated −20°) + one filled satellite r 1.5; brand mark on native (`juno.orbit`) |
| `code` | lightest destination, wider than live area | `</>` inside 4–20, slash 13.5→10.5 shorter, optical 1.08 |
| `new-chat` | square-pen breaks "New = plus" | Adopt the platform metaphor everywhere: **square + pencil** (`square.and.pencil`); "New" variants of other objects use a corner plus |
| `search` | handle fused to lens | lens Ø13 at (10.5, 10.5); handle from 16.2 to 20 (1.5-unit gap) |
| `folder` vs `folder-plus/-move/-code/-lock` | two silhouettes | one `FOLDER` (19×15, tab 6 units, r 2), variants add a corner badge |
| `library` | spine closes to "lll" at 16 | three upright books 4 units apart, no inner spine below 18px (`books.vertical`) |
| `customize` | 9 strokes | 3 sliders, knobs r 2 (`slider.horizontal.3`) |
| `crew` | widest glyph, centroid +2 | two heads in a 20×16 keyline, raised 1 unit |
| `bell` / `bell-off` | two different bells | one `BELL`, bell-off = bell + outline-only slash |
| `sidebar` / `panel-right` | square vs frame, r 2 vs 3 | one frame 18×16 r 2.5, divider at 7.5; panel-right = mirror |
| `mic` / `mic-off` / `dictation` | three capsules; dictation reads "ψI" | one capsule 6×11 r 3 + arc + stem; dictation = mic (the word disambiguates) |
| `voice` | 6 bars edge to edge, centred on 11.56 | 5 bars at x 6/9/12/15/18, heights 6/10/14/10/6, centred on 12 |
| `design` (nib) | inner dot closes at 16 | destination = square + circle overlapping; nib kept only for the path tool |
| `memory` | stacked cards with 3 inner lines, mud at 16 | two stacked cards (back card offset 3,−3), 2 inner lines on the front card (`rectangle.stack`) |
| `research` | a second magnifier next to Search | binoculars (`binoculars`) |
| `auto` | gauge sits 1 unit high | dial centre moved down 1 unit, needle 45° |
| `pdf` | overhanging label reads as a link | label inside the page, small cut at 14 |
| `send` | 1.5px line on an ink disc (the claimed bold cut never ships) | bold cut 2.0px, arrow head 6 units wide |
| `stop` | fine | 10×10 r 2.5 filled, centred |
| `skill` | doc + slash reads as a file | book-closed with a bookmark (`text.book.closed`) |
| `at` | counter closes at 16 | inner r 3.75, small cut at 14 |
| `contrast`, `citation`, `deep-field` | mass outliers | half disc inset by the gap; heads r 2.1; points r ≥ 1.4 |
| slashed composites (`unpin`, `eye-off`, `offline`, …) | knockout fragments at 16 | slash through the outline only, 1.5-unit gap |

### B6. Icon buttons and hit targets

| Size | Box | Glyph | Radius | Hit target | Use |
|---|---|---|---|---|---|
| xs | 24 | 14 | 6 | `::before` expands to 32 (fine) / 44 (coarse) | inline row actions (kebab in sidebar row, chip remove) |
| sm | 28 | 16 | 8 | 32 / 44 | dialog close, toolbar in dense panels |
| md (default) | 32 | 16 | 8 | 32 / 44 | message actions, headers, composer (radius 12 there) |
| lg | 36 | 20 | 8 | 36 / 44 | touch-first toolbars on web phone |

Every icon button has an accessible name and a tooltip with its shortcut. No `title=` tooltips.

---

## C. Components

| Component | Spec |
|---|---|
| **Button** | Sizes: xs 24 (px 8, 12/16, gap 4, r 6) · sm 28 (px 10, 13/20 · 500, gap 6) · **md 32 default** (px 12) · lg 36 (px 14). Radius 8 at every size ≥ sm. Coarse: min-height 44 via `hit-44`. Variants: **primary** `--primary` fill, `--primary-foreground`, no shadow, hover `--primary-hover`, press `--primary-press` + scale .97 · **secondary** `--card` fill + 1px `--border`, `--shadow-raised`; hover edge `--border-strong` + fill `--accent` · **ghost** transparent → `--accent` · **destructive** `--destructive` fill, white · **destructive-ghost** `--destructive-ink` text → `--destructive-tint`. Optional trailing shortcut: kbd glyphs as 12px text, ink `--primary-foreground` mixed 70% for primary (new token `--kbd-on-primary`: light 0 0% 72%, dark 216 6% 36%). Loading: label kept, spinner 14 replaces the leading glyph, `aria-busy`, width locked |
| **Icon button** | B6. Ghost by default; `aria-pressed` → `--selected` + filled glyph; open (menu trigger) → `--menu-highlight` |
| **Segmented control** | Track 32 (sm 28), r 8, `--muted` fill + inset 1px `--border`, padding 2. Thumb r 6, `--card`, `--shadow-raised` + 1px `--border` (light) / `--selected` with `--border-float` (dark). Labels 13/20 · 500; inactive `--muted-foreground`, active `--foreground`. Thumb moves on `--spring-snap` (no squash). Keyboard: ←/→ moves and selects |
| **Switch** | Track 32×18, r full; off: `--muted` fill + inset 1px `--input`; on: `--primary` (or the user accent). Thumb 14, `#fff` (dark on-state: `--primary-foreground`), `0 1px 2px ink/.20`, 2px inset. Whole settings row is the hit area; accessible name = title only |
| **Checkbox** | 16×16, r 4, 1px `--input`, `--card` fill; checked: `--primary` fill, 1.75px white tick drawn by stroke-dashoffset; indeterminate: 8×1.75 bar. Hit 24 (44 coarse) |
| **Radio** | 16 circle, 1px `--input`; checked: `--primary` fill + 6px `--primary-foreground` dot |
| **Input** | 32 (sm 28, lg 36; coarse 44), r 8, px 10, 13/20 (coarse 16/24 to stop iOS zoom), `--card` + 1px `--input`; hover edge 214 3% 50%; focus edge `--ring`; invalid `--destructive` + message 12/16 below with a 14px alert glyph. Leading glyph 16 at x 10, text at 34 |
| **Search field** (R4) | 32, r 8, `--muted`, no edge, 16 glyph at x 10, placeholder `--muted-foreground`, trailing `⌘K`/`/` hint 12px; focus: fill `--card` + 1px `--ring` |
| **Textarea** | min 3 lines (13/20 × 3 + 16 = 76 → snap 80), px 10, py 8, resize vertical, same edges as input |
| **Token** (armed tool, mention) | 24 (composer: 28 hit), r 6, px 6, gap 4, 14 glyph (filled), 12/16 · 500, `--selected` fill, `--foreground`; remove ✕ 14 appears in place of the trailing space on hover/focus, always on touch |
| **Chip** (filter) | 28, r 8, px 10, 13/20, 1px `--border`; selected `--selected` + edge `--border-strong` |
| **Badge** | 18, r 4, px 6, 12/16 · 500 tabular (`kbd` 11 mono only for counts ≥ 100); neutral `--muted`; live: 6px `--presence` dot + text; needs-you: `--signal-ink` text on `--card` |
| **Tabs** (level-2 nav) | 32 tall, 13/20 · 500, gap 16, 2px `--foreground` bar r 1 under the active label (label width), bar moves on `--spring-snap`; bottom 1px `--border` |
| **Tooltip** | `--tooltip` fill, r 6, padding 4/8, 12/16 · 500 `--tooltip-foreground`, max-width 240, offset 6, `--shadow-tooltip`; shortcut as kbd 16 tall, r 4, `#fff/.12` fill, 11 mono `--tooltip-muted` |
| **Avatar** | 16/20/24/32/40; initials 0.42×size · 600; ring `inset 0 0 0 1px ink/.08`; presence dot 8 (32+) with 2px ground ring |
| **List row** | compact 28 (code lists), **default 32**, two-line 48 (13/20 + 12/16); r 8; px 8; glyph 16; gap 8 → label at x 32. One trailing slot |
| **Card** | r 12, 1px `--border`, `--card`, padding 16, e1 only if interactive; hover edge `--border-strong` (no lift, no translate) |
| **Sidebar row** | 32 (44 coarse), inset 8 inside the column (glyph at x 16), 13/20, glyph 16 `--muted-foreground` (selected: `--foreground` + filled), r 8; hover `--sidebar-hover`; selected `--sidebar-selected` + 500; trailing: kebab xs (hover/focus), run dot 6 or shortcut `⌘1`. Section label 28 tall, 12/16 · 500 muted, sentence case, chevron 12 on hover |
| **Skeleton** | `--accent` blocks (visible on page and card grounds), text lines 10 tall r 4 (60/80/45% widths), breathe 1 → .55 on `--loop-breathe`; show after `--delay-show` 200, hold ≥ `--hold-skeleton` 400 |
| **Spinner** | 14/16, 1.5px arc 270°, `--loop-spin` 0.8s linear; only inside the control just pressed |
| **Progress** | 4 tall, r 2, track `--muted` + inset 1px `--border`, fill `--foreground` via `scaleX` (`transform-origin: left`); indeterminate segment 30% sliding on `--loop-beat` |

---

## D. Menus: one command surface

### D1. Shell

| Property | Value |
|---|---|
| Fill / edge / depth | `--popover`, 1px `--border-float`, e2 |
| Radius / inset | 12 / 4 (rows r 8) |
| Widths | **S 224** (row and context menus) · **M 272** (`+`, filters, selects with descriptions) · **L 320** (model picker, slash) · **palette 560**. Min 180; select = trigger width (min 180) |
| Max height | `min(420px, var(--radix-*-available-height) − 16px)`; palette list `min(400px, 60svh)` |
| Offsets | sideOffset 6, collisionPadding 8, align start; composer menus open **upward** and never cover the composer |
| z | `z-popper` 55 (portalled, Code v2 included) |
| Scrolling | `overflow-y:auto; overscroll-behavior:contain`; 16px top/bottom fade masks (`mask-image`) only when scrolled; scrollbar 6px thumb `--border-strong`; keyboard highlight scrolls into view with `block: nearest` |

### D2. Row anatomy (identical in every menu)

```
| 8 | glyph 16 | 8 | label 13/20 (flex, truncate) [ + description 12/16 ] | 12 | trailing slot | 8 |
```
- Height 32 single-line, 48 with description (model picker, slash), 44/56 on coarse pointers.
- **Glyphs are all-or-none per group**; user-made names (projects, skills) get none. With no glyph, the label starts at x 8 for the whole group.
- **One trailing slot**, right-aligned, min-width 16: shortcut (12/16, `--muted-foreground`, tabular, `letter-spacing:.02em`, modifier order ⌃⌥⇧⌘) · chevron 14 (submenu) · check 16 (`--foreground`) · value text 12/16. Never two.
- Section label: 28 tall (pad 8 8 4), 12/16 · 500 `--muted-foreground`. First group has no top gap.
- Separator: 1px `--border`, full-bleed (−4px margins), 4px above and below.
- Highlight: `--menu-highlight`, instant; keyboard adds the inset ring (A7).
- Check / radio items: trailing check 16; checkbox items do **not** close the menu; radio items close it.
- Destructive: last group, own separator, `--destructive-ink` label + glyph, `--destructive-tint` highlight; label ends with "…" when it opens a confirm.
- Disabled: `--muted-foreground` label and glyph, trailing reason ("Pro", "Offline"); focusable by keyboard, skipped by pointer highlight.

### D3. Search in menu
Any surface with more than 7 items gets a search row: 36 tall, 16 glyph at x 12, 13/20 input, placeholder ("Search models", "Add or search…", "Type a command"), bottom 1px `--border`. Printable keys typed anywhere in the open menu go to the search. Filtering is instant; matched characters render 600; groups with no match hide; empty result is one row "No match · ↵ Ask Alevr" (12px hint). Menus without search use Radix typeahead (1s buffer).

### D4. Keyboard map (all surfaces)
↑/↓ move and **wrap** · Home/End · PageUp/PageDown jump 8 · ↵/Space activate · → open submenu (focus its first row) · ← / Esc close one level · Esc on root closes and returns focus to the trigger (or the caret in the composer) · Tab closes and moves on · ⌘1–⌘9 pick the n-th model in the model picker. Opening from the keyboard highlights the selected row (or the first) immediately.

### D5. Submenus
- One level only; ≤ 8 items (more → search inside the parent).
- **Open delay** `--delay-submenu` 100ms of pointer rest on the trigger, or → instantly.
- **Safe triangle:** on pointer-leave a grace polygon from the pointer (5px bleed) to the submenu's near corners stays valid for `--hold-submenu-grace` 300ms while the pointer moves toward it (Radix `menu` behaviour, made explicit as tokens).
- **Placement:** right of the parent, `sideOffset` 4 (4px gap, no touching borders), `alignOffset` −5 so the first submenu row sits level with the trigger row (1px border + 4px inset). **Flips** to the left when the right side has < width + 8px; on phones it drills in place.
- Trigger keeps `--menu-highlight` while its submenu is open; its chevron turns `--foreground`; the trigger never runs a command.

### D6. Surface catalogue

| Surface | Width | Anatomy |
|---|---|---|
| Dropdown (kebab, header More) | S 224 | groups with glyphs; shortcuts trailing; destructive last |
| Context menu | S 224 | the kebab's items, opened at the pointer (right-click, Shift+F10, long-press); Shift+right-click keeps the browser menu |
| Select | trigger width (≥180) | **item-aligned**: the selected row sits exactly over the trigger; trailing check; field trigger shows `chevrons-up-down` 14, no rotation |
| Combobox | trigger width | input is the trigger; same rows; `aria-activedescendant` |
| **Model picker** | L 320 | search row; "Recommended" (3 rows with ⌘1–⌘3) and "All models" groups; 48px rows: 20px provider mark (r 4), name 13/20 · 500, description 12/16 `--muted-foreground-on-fill` when highlighted; trailing check on the current model; footer 40 tall: "Effort" label + segmented sm (Low · Medium · High) + "Thinking" switch; hint `⇥ details` |
| **Composer `+`** | M 272 | search "Add or search…"; group 1 Add photos & files ⌘U · Take a screenshot ⌘⇧2 · Add from Library ⌘L; group 2 tools (checkbox items): Web search ✓ · Deep research · Create image · Memory ✓; group 3 Project › · Apps ›. Opens upward from `+`, align start |
| **Slash palette** | L 320 | opens on "/" at the field start, anchored so row labels align with the field text column (x 16); groups Commands / Skills / Tools / Go to; rows 32, label `/model` 13/20 · 500 + inline description 12px muted; footer hints ↑↓ ↵ ⇥ esc |
| Message actions | S 224 | Copy ⌘C · Copy as Markdown ⌘⇧C · Read aloud · Branch from here · Share… · — · Report… |
| Sidebar row menu | S 224 | Rename F2 · Pin ⌘⇧P / Unpin · Add to project › · Share… · Archive ⌘E · — · Delete… ⌘⌫ |
| **Command palette** ⌘K | 560 | top 12svh; search 48 tall (20 glyph, 14/20 input); results grouped (Recent chats, Actions, Go to); rows 32; footer 32 with ↑↓ navigate · ↵ open · ⌘↵ new tab · esc close (kbd keycaps) |

---

## E. Pop-ups

### E1. Dialogs

| Part | Value |
|---|---|
| Widths | confirm **400** · form **520** · workspace **720** · full screen (`< 640` → bottom sheet) |
| Shell | `--popover`, r 16, 1px `--border-float`, e3, scrim `--scrim`; 3-row grid (header / body scroll / footer) so chrome never scrolls away |
| Header | padding 16 20 0; title `heading-sm` 15/20 · 600; description 13/20 `--muted-foreground`, 4 below; close = icon button sm 28, r 8, glyph 16, at top 12 / right 12 — its centre sits on the title's first line centre (title box top 16 + 10 = 26 = 12 + 14) |
| Body | padding 12 20 20, the only scroller, fade masks |
| Footer | padding 12 20 16, end-aligned, gap 8; **[Cancel secondary] [Primary]**, 32 tall; hairline `--border` only while the body is scrolled; primary shows its `↵` hint |
| Keyboard | Esc / ⌘. cancel; ↵ fires the primary (default button); initial focus = first field, else the primary (non-destructive) |
| Phone | bottom sheet (E3) with Cancel leading and the primary trailing in the header |

### E2. Destructive confirm
400 wide, `role="alertdialog"`, no ✕, no outside-click dismiss. Title names the object: "Delete “Q3 forecast”?"; body says what is lost ("Removes the chat and its 3 files from all devices. This can’t be undone."). Footer **[Cancel] [Delete]** (destructive fill), initial focus **Cancel**, ⌘⌫ confirms. On confirm the row collapses and an "Deleted · Undo ⌘Z" toast appears for 8s.

### E3. Sheets
- **Bottom sheet (phone):** `--popover`, top radius 16, e3, grabber 36×5 r 2.5 `--grabber` at top 6 inside a 20px band; header 48: leading "Cancel"/✕, centred title `heading-sm`, trailing "Done"; detents **medium (50%)** and **large (100% − safe-top − 12)**, grabber only with ≥ 2 detents; drag anywhere on the header or grabber, and on the body when scrolled to top; keyboard avoidance via `--sheet-keyboard`.
- **Side sheet:** 400 wide (nav drawer 280), edge-attached, radius 16 on the inner edge only, same header anatomy.

### E4. Popovers and hover cards
Popover: `--popover`, r 12, padding 12 (lists: 4), widths 280 / 320, e2, title `heading-sm`. Hover card (citations, sources, people): opens after `--delay-hover-card` 300ms, closes `--hold-hover-card` 150ms after leave, focusable (↵ or ↓ moves focus in); one implementation replaces `.cite-card` and the citation Popover.

### E5. Toasts
Bottom-centre, above the composer: `bottom = var(--composer-h) + 12px` (published by the composer), 16px on pages. 360 wide (phone: 100% − 16), r 12, e2, padding 10 12, gap 8; icon 16 (status ink), text 13/20, description 12/16 muted; action = ghost button xs "Undo ⌘Z"; ✕ xs on hover/focus. Stack: max 3 visible; collapsed, toast n sits `translateY(−8n px) scale(1 − .04n)`; hover/focus expands to a column with 8px gaps. Lifetime `--hold-toast` 4000 (with action `--hold-toast-action` 8000), paused on hover, focus and window blur. F6 / ⌥T focuses the region. `z-toast` 70 actually applied. Memory-updated notice becomes a toast of this shape.

### E6. Banners, inline alerts, empty states
- **Banner** (in-flow, top of the content card): 36 tall, padding 0 12, 16 glyph + 13/20 text + ghost xs action + ✕; tones: neutral `--muted`, attention (`--attention` glyph, `--muted` fill).
- **Inline alert:** r 8, padding 10 12, 1px `--border`, `--card`; 16 glyph in tone ink; title 13/20 · 500, body 13/20 muted; actions xs ghost.
- **Empty state:** centred, max 320; 40 tile, r 8, `--muted` with a 20 glyph `--muted-foreground`; title Newsreader 20/26; body 13/20 muted; one secondary sm button with its shortcut. Panel variant drops the tile.

---

## F. Composer

### F1. Geometry (dock and landing share it; one mounted component, FLIP between positions)

| Part | Value |
|---|---|
| Width | `min(720px, 100% − 2 × gutter)` in both landing and dock (fixes 660 vs 704) |
| Shell | `--card`, r 20, 1px `--composer-border`, e1 (`--shadow-raised`) plus, only while transcript content scrolls beneath, `0 -8px 24px -12px ink/.10` (static, toggled by IntersectionObserver) |
| Inset | 8 all round; field text inset 16 (= the `+` glyph's left edge 8 + 8) |
| Field | 16/24 (the `reading` size on a 24px line so heights land on the 4 grid), padding 12 8 4 8 inside the inset → text at x 16, first baseline 12 + 18; min 1 line; grows to 10 lines (240) then scrolls |
| Tools row | 32 tall, gap 4; left: `+` · tokens · tool buttons ("Search", "Research" as icon+label ghost controls when space ≥ 560); right: model chip · mic · primary |
| Controls | all 32×32 (chips 32 tall, px 10), r 12, ghost, glyph 16 `--muted-foreground` (label and glyph share one ink); hover `--accent`; open `--menu-highlight` |
| Primary disc | 32×32 r 12, `--primary` fill always (strongest object on the row); faces: **voice** (waveform 16) when empty, **send** (arrow-up bold cut) with text, **stop** (10×10 r 2.5) while streaming; never grey, never passes through voice while submitting |
| Model chip | 13/20 · 500 "Opus 5.5" + chevron 14; provider mark 16 hidden below 520px width; effort shown as a second word in `--muted-foreground` ("High") |
| Rest height | 1 + 8 + (12 + 24 + 4) + 32 + 8 + 1 = **90** (landing and dock) |
| Focus | pointer: edge `--composer-border-focus` (120ms); keyboard: the A8 outline on the shell |

### F2. States
- **Landing:** greeting Newsreader 40/48 centred 32px above the shell; nothing above or below the composer (tray retired: Project, Apps and Skills live in `+`; an active project is a token on the tools row).
- **Docked:** pinned to the content bottom with `pb = 16 + safe-area`; footnote 12/16 muted 8px under the shell.
- **Typing multi-line:** shell grows by 24px per line, 120ms (`--ease-snap`).
- **Attachments row:** above the field inside the shell, padding 0 (shares the 8 inset), gap 8. Image chip 56×56 r 12 (top-left chip is concentric with the shell). File chip 56 × 216: 40 tile r 8 `--muted` with the file glyph and a 11 mono extension, name 13/20 · 500 truncate, meta 12/16 muted "PDF · 1.2 MB". Remove: 20 circle, `--foreground` fill, 12 ✕ in `--background`, at the chip's top-right corner offset (−6, −6), visible on hover/focus, always on touch (44 hit). **Uploading:** 2px bar along the chip bottom inside r 12, meta "Uploading · 42%". **Error:** 1px `--destructive` edge, meta "Failed · Retry" (Retry is a link button).
- **Drag-drop overlay:** window-level target. Over the content card: `--background` at 92% opacity, 1.5px dashed `--border-strong` inset 12 r 16, centred 24 glyph + "Drop to attach" `heading-sm` + "Images, PDFs and code · up to 20 files" 13 muted. The composer edge does not change (one signal only).
- **Slash / skill menu:** D6. A chosen skill becomes a token at the head of the field.
- **Streaming:** field stays live, Enter queues; primary = stop; Esc stops; controls are **not** dimmed (only disabled controls change).
- **Voice call / dictation:** the row keeps 32 controls and the 32 disc (End = `--destructive` fill; dictation ✓ = `--primary` fill), so nothing shifts between modes.

### F3. Mobile (390)
Composer full width minus 8 (374), r 20, field 16/24 (no iOS zoom), controls 36 visual / 44 hit, gap 4, model chip shows the short name ("Opus"); `+` opens a **bottom sheet** (medium detent) with the same rows at 48 tall, a search field and drill-in submenus with a back row. Toasts sit 12 above the composer.

---

## G. Motion

### G0. Tokens (no new duration rung)

| Token | Value | Job |
|---|---|---|
| `--dur-press` | 70 | opacity of layers, exits of frequent layers, hover-out, glyph-out |
| `--dur-fast` | 120 | transforms of layers, glyph-in, composer height, toasts out, dialog panel opacity |
| `--dur-exit` | 160 | dialog transform-in, toast-in, disclosure open, dialog scrim-out |
| `--dur-base` | 220 | panel/inspector open, sidebar fold |
| `--dur-slow` | 360 | not used by chrome (kept for content morphs) |
| `--ease-snap` **(new)** | `cubic-bezier(0.25, 1, 0.5, 1)` | every entrance ≤ 160ms (quart-out: 80% done at 40% of the time, no hang) |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | every exit |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | A→B moves (fold, shrink) |
| `--ease-out-strong` | `cubic-bezier(0.32, 0.72, 0, 1)` | panels and drawers (220) |
| `--spring-snap-params` | 0.18 0 | thumbs, tab bar, toast re-stack |
| `--spring-standard-params` | 0.22 0.05 | bottom-sheet settle with gesture velocity |
| `--delay-submenu` **(new)** | 100ms | submenu hover intent |
| `--hold-submenu-grace` **(new)** | 300ms | safe-triangle grace |
| `--delay-swap` **(new)** | 50ms | incoming glyph overlap in face swaps |
| `--delay-tooltip` / `-skip` | **400 / 300** (was 200 / 400) | tooltip intent / skip window |
| `--delay-hover-card` / `--hold-hover-card` **(new)** | 300 / 150 | hover cards |
| `--hold-toast` / `--hold-toast-action` **(new)** | 4000 / 8000 | toast lifetime |
| `--loop-spin` **(new)** | 0.8s | spinner rotation |

Rules: entrances use `--ease-snap`, exits `--ease-in` on the rung below; highlights and selection are instant; nothing staggers in a menu or list overlay; everything is interruptible (CSS transitions or WAAPI `reverse()` from the current value; springs keep velocity); no blur; no width/height animation except composer height, panel resize and sidebar fold.

### G1. Storyboard

Columns: **step · property · from → to · duration · curve · delay · origin**. "RM" = reduced motion (Tier A keeps opacity and colour, Tier B removes travel and scale, Tier C stops loops).

| # | Interaction | Steps | Exit / interruption | RM |
|---|---|---|---|---|
| 1 | **Hover** (row, button, chip) | ① background rest→hover · 0ms · — · on `pointerenter` | ② hover→rest · 70 · ease-in on leave. Re-enter mid-fade: jumps to hover (no ramp) | same (colour) |
| 2 | **Press** (controls ≤ 64px) | ① scale 1→.97 · 70 · ease-snap · center ② press fill 0ms | ③ release .97→1 · `--spring-snap` (~256 settle). Rows: fill only, no scale | no scale; fill only |
| 3 | **Menu open** (pointer) | ① opacity 0→1 · 70 · ease-snap ② transform `translateY(∓4px) scale(.97)` → none · 120 · ease-snap · origin = Radix transform-origin (trigger side) ③ no content stagger, no row highlighted | Keyboard open: ① only (opacity 70), first/selected row highlighted at t=0. Close requested during ①/②: reverses from the current values | opacity 70 only |
| 4 | **Menu close** | ① opacity 1→0 · 70 · ease-in ② scale 1→.98 · 70 · ease-in (no translate) | On activate: the chosen row keeps its highlight through ① (no blink), check set at t=0. Total: 70ms | opacity 70 |
| 5 | **Submenu open** | ① intent 100ms rest on trigger (`--delay-submenu`) or → (0ms) ② opacity 0→1 · 70 · ease-snap ③ `translateX(−4px)`→0 (from the parent side) · 120 · ease-snap · origin top-left (top-right when flipped) | Leave: grace 300ms toward the panel, then opacity 1→0 · 70 · ease-in. Sibling switch: outgoing removed at 0ms, incoming plays ②③ — never two panels | opacity only |
| 6 | **Highlight move** | keyboard: fill moves at 0ms; pointer: new row fill 0ms, old row fill out 70 ease-in | held arrow key: no trail | same |
| 7 | **Select in menu** | ① check glyph opacity 0→1, scale .8→1 · 120 · ease-snap (old check removed 0ms) ② composer chip label: old out 70 ease-in, new in 120 ease-snap with `--delay-swap` 50; chip width snaps at t=50 | — | opacity only |
| 8 | **Select / listbox open** | item-aligned: ① opacity 0→1 · 70 ② `scale(.98)`→1 · 120 · ease-snap · origin = selected row centre | close = #4 | opacity |
| 9 | **⌘K palette** | ① scrim 0→1 · 120 · ease-out-soft ② panel opacity 0→1 · 70 · ease-snap ③ `translateY(−8px) scale(.98)`→none · 120 · ease-snap · origin top centre ④ input focused at t=0 | close: panel opacity 70 ease-in, scrim 120 ease-in (trails); result list changes are instant | opacity only |
| 10 | **Dialog open** | ① scrim 0→1 · 120 · ease-out-soft ② panel opacity 0→1 · 120 · ease-snap ③ `translateY(8px) scale(.96)`→none · 160 · ease-snap · origin center ④ focus to initial element at t=0 | close: ① panel opacity→0 + `scale(.98)` · 120 · ease-in ② scrim→0 · 160 · ease-in (trails 40ms). Interrupt: reverse from current | opacity 120 / 120 |
| 11 | **Destructive confirm → delete** | open = #10. Confirm: ① button press #2 ② dialog close #10 ③ at t=120 the row: opacity 1→0 · 120 · ease-in, then `grid-rows` 1fr→0fr · 160 · ease-in-out ④ toast in (#13) at t=120 | Undo: row grid-rows 0→1fr 160 ease-snap + opacity 120 | opacity; rows snap |
| 12 | **Bottom sheet** | ① scrim 0→1 · 220 · ease-out-soft ② `translateY(100%)`→detent · `--spring-standard` (~272) ③ drag: translateY = finger (0ms); above the top detent rubber-band `d × 0.55`; scrim tracks progress linearly ④ release: project `y + v × 200ms` → nearest detent, spring with gesture velocity | dismiss when projected > 50% of height or `v > 0.5 px/ms` down: `translateY(100%)` · 160 · ease-in, scrim · 160 · ease-in. Esc/✕: same | sheet cross-fades in place (opacity 120); drag still tracks the finger |
| 13 | **Toast** | in: ① opacity 0→1 · 70 ② `translateY(12px)`→0 · 160 · ease-snap ③ older toasts re-stack `translateY(−8n) scale(1−.04n)` · `--spring-snap` | out: opacity→0 + `translateY(4px)` · 120 · ease-in; swipe: follows finger in x, release > 40% or `v > .5` → `translateX(±110%)` · 160 · ease-in. Hover: expand to a column (8 gap) · 160 · ease-snap; collapse · 120 · ease-in-out after leave | opacity only; stack positions snap |
| 14 | **Tooltip** | ① wait 400 (`--delay-tooltip`) ② opacity 0→1 · 70 · ease-snap ③ 2px travel from its side · 70 · ease-snap | out: opacity · 70 · ease-in. Within the 300 skip window: the next tooltip appears at 0ms and the previous is removed at 0ms (no doubled labels) | opacity only |
| 15 | **Hover card** | ① wait 300 ② opacity 70 + `scale(.98)`→1 · 120 · ease-snap · origin trigger | out after 150 grace · 70 · ease-in | opacity |
| 16 | **Composer focus** | ① edge `--composer-border`→`-focus` · 120 · ease-snap ② keyboard outline at 0ms | blur · 120 · ease-in-out; no shadow change | same |
| 17 | **Composer grow / shrink** | height h→h+24n · 120 · ease-snap (the documented height exception); transcript keeps its last line in view in the same frame | shrink · 120 · ease-in-out; paste of many lines animates once to the final height; > 10 lines: inner scroll | instant |
| 18 | **Send → stop** | ① press #2 ② t=0 arrow: opacity 1→0, `translateY(−4px) scale(.6)` · 70 · ease-in ("leaves upward") ③ t=50 stop square: opacity 0→1, `scale(.6)`→1 · 120 · ease-snap ④ disc fill unchanged (ink → ink), aria-label swaps at t=0 | stop → send/voice at stream end: stop out 70 ease-in (scale .6), new face in 120 ease-snap at +50. Fast toggles retarget from current values | glyph cross-fade 70/120, no scale |
| 19 | **Voice ⇄ send (typing)** | first character: waveform out 70 ease-in (scale .6), arrow in 120 ease-snap at +50 (from `translateY(4px) scale(.6)`) | clearing the field reverses | cross-fade |
| 20 | **Attachment add** | ① first chip only: attachments row `grid-rows` 0fr→1fr · 120 · ease-snap (composer height exception) ② chip opacity 0→1, `scale(.92)`→1 · 120 · ease-snap · center ③ upload bar `scaleX` follows progress (no easing beyond 120) ④ done: bar opacity→0 · 120 | remove: chip opacity→0 + `scale(.92)` · 70 · ease-in; siblings FLIP to new x · 120 · ease-snap (t=0); last chip: row 1fr→0fr · 120 · ease-in-out at t=70 | opacity; layout snaps |
| 21 | **Drag-drop overlay** | `dragenter` (window): overlay opacity 0→1 · 120 · ease-snap | leave: 70 · ease-in; drop: 70 then #20 | same |
| 22 | **Slash palette** | opens like a keyboard-opened menu (#3 keyboard: opacity 70) as soon as "/" is typed; filtering instant | closes 70 on space, Esc or blur | same |
| 23 | **User message appears** | optimistic, same frame as send: opacity 0→1, `translateY(8px)`→0 · 120 · ease-snap · origin bottom-right | — | opacity 120 |
| 24 | **Assistant streams** | ① pending galaxy mark: opacity 0→1 · 120 after `--delay-show` 200 (only if no token yet) ② first block opacity 0→1 · 120 · ease-snap (no travel) ③ text: frame-paced reveal with the existing 280ms `--stream-band` ④ tail drains at ≤ 4× rate, ≤ 250ms, never one slab ⑤ action row opacity 0→1 · 120 after `--delay-action-row` 180 | stop: reveal halts at once; "Stopped" note fades in 120 | ① ② ⑤ opacity; ③ band kept (colour) |
| 25 | **Route change** | old content opacity→0 · 70 · ease-in; new content opacity 0→1 + `translateY(4px)`→0 · 120 · ease-snap at t=70; view-transition hold ≤ 80ms (`ROUTE_WAIT_MS`) | sidebar selection moves at t=0 | opacity |
| 26 | **Panel (canvas / inspector)** | panel `translateX(24px)`→0 + opacity · 220 · ease-out-strong; transcript column width settles · 220 · ease-out-strong with `contain: layout`; `alevr:layout-settled` fires at the end | close · 160 · ease-in | opacity; width snaps |
| 27 | **Sidebar fold** | width 260→52 · 220 · ease-in-out; labels opacity→0 · 70 · ease-in at t=0; glyphs stay pinned at x 16 | expand: width 220 ease-in-out; labels in · 120 · ease-snap at t=100 | width snaps; labels fade |
| 28 | **Segmented / tab thumb** | thumb FLIP (transform only) · `--spring-snap`; labels colour 0ms | retarget keeps velocity | instant |
| 29 | **Switch / checkbox / radio** | switch thumb `translateX(14px)` · 120 · ease-snap, track colour 120; check path dashoffset 1→0 · 120 · ease-snap; radio dot `scale(.5)`→1 · 120 · ease-snap | off: 70 ease-in | colour only |
| 30 | **Disclosure** | chevron rotate 0→90° · 120 · ease-snap; content `grid-rows` 0fr→1fr · 160 · ease-snap + opacity 120 | close: 120 · ease-in-out | opacity; rows snap |
| 31 | **Skeleton → content** | show after 200, hold ≥ 400; swap: skeleton opacity→0 and content 0→1 simultaneously · 120 | — | same |
| 32 | **Spinner** | rotate 360° per `--loop-spin` 0.8s linear, only inside the pressed control | — | Tier C: 1.2s opacity pulse |

---

## H. Token changes

### H1. `src/app/globals.css`

`:root` (light) additions and value changes:
```css
/* layer states */
--menu-highlight: 220 8% 92.5%;
--destructive-tint: 356 72% 96%;
--border-float: var(--border);
--border-strong: 220 5% 80%;
--primary-hover: 216 8% 22%;
--primary-press: 216 7% 28%;
--kbd-on-primary: 0 0% 72%;
--tooltip: 220 9% 12%;
--tooltip-foreground: 0 0% 98%;
--tooltip-muted: 220 5% 70%;
--composer-border: 220 6% 86%;
--composer-border-focus: 220 5% 70%;
--grabber: 220 5% 78%;
--input: 214 3% 58%;                 /* was 214.286 2.979% 53.922% */
--scrim: 220 10% 8% / 0.32;          /* was 48 12% 8% / 0.26 */
--hairline: 220 9% 11% / 0.06;       /* was 48 12% 18% / 0.06 */
/* elevation (CSS only; hand-port to JunoElevation) */
--shadow-raised: 0 1px 2px hsl(var(--shadow-ink) / 0.05);
--shadow-float: 0 1px 2px hsl(var(--shadow-ink) / 0.05), 0 8px 24px -4px hsl(var(--shadow-ink) / 0.14);
--shadow-modal: 0 2px 6px -1px hsl(var(--shadow-ink) / 0.08), 0 24px 56px -12px hsl(var(--shadow-ink) / 0.28);
--shadow-tooltip: 0 2px 8px -2px hsl(var(--shadow-ink) / 0.28);
/* motion */
--ease-snap: cubic-bezier(0.25, 1, 0.5, 1);
--ease-spring: cubic-bezier(0.33, 1, 0.68, 1);   /* deprecated alias of out-soft (it never sprang) */
--delay-submenu: 100ms;
--hold-submenu-grace: 300ms;
--delay-swap: 50ms;
--delay-tooltip: 400ms;              /* was 200ms */
--delay-tooltip-skip: 300ms;         /* was 400ms */
--delay-hover-card: 300ms;
--hold-hover-card: 150ms;
--hold-toast: 4000ms;
--hold-toast-action: 8000ms;
--loop-spin: 0.8s;
```
`.dark`:
```css
--popover: 225 4.5% 18%;             /* was 16.078% */
--selected: 228 4.4% 24.5%;          /* was 22.549% */
--muted-foreground-on-fill: 222.9 4.1% 68%;  /* was 66.5% */
--destructive-ink: 356 72% 70%;      /* was 356 70% 66% */
--menu-highlight: 225 4% 24%;
--destructive-tint: 356 35% 20%;
--border-float: 225 4% 28%;
--border-strong: 225 4% 32%;
--primary-hover: 220 8% 97%;
--primary-press: 220 6% 84%;
--kbd-on-primary: 216 6% 36%;
--tooltip: 225 5% 26%;
--tooltip-foreground: 220 7% 95%;
--tooltip-muted: 220 4% 72%;
--composer-border: 225 4% 24%;
--composer-border-focus: 225 4% 38%;
--grabber: 225 4% 36%;
--scrim: 0 0% 0% / 0.6;
--hairline: 220 7% 92% / 0.08;
--shadow-float: 0 1px 2px hsl(0 0% 0% / 0.3), 0 12px 32px -4px hsl(0 0% 0% / 0.5);
--shadow-modal: 0 2px 6px hsl(0 0% 0% / 0.35), 0 24px 64px -8px hsl(0 0% 0% / 0.6);
```
High contrast (both): `--menu-highlight: var(--selected)`, `--border-float: var(--input)`, `--composer-border: var(--input)`, `--border-strong: var(--input)`.
Reduced motion block adds `--ease-snap: var(--ease-out-soft)`.
Composed classes: `.surface-float` → `--popover` + 1px `--border-float` + `--shadow-float`; new `.surface-modal` (`--shadow-modal`); `.overlay-glass` retired (alias of `.surface-float`); `.composer-surface` → r 20, `--composer-border`, `--shadow-raised`, `::after` radius `inherit` (no literal 26).
Contrast matrix: add `--menu-highlight`, `--destructive-tint`, `--tooltip` to GROUNDS/FILLS; pairs listed in A4 all pass; the recorded failing pair (muted on `--selected`, 4.32) stays recorded.

### H2. `tailwind.config.ts`
- `borderRadius`: `menu: '12px'` (14), `field: '8px'` (10), `composer: '20px'` (26), `'composer-control': '12px'` (14), `'composer-action': '12px'` (16). Same names (Swift reads them). Update `RADIUS_TOKENS`, `SCALE_HELP` and the concentric table in `eslint-rules/design-system.mjs`.
- `fontSize`: `ui` lineHeight `1.25rem`; new `'heading-sm': ['0.9375rem', { lineHeight: '1.25rem', letterSpacing: '-0.006em', fontWeight: '600' }]`; `label` becomes sans (move the mono family to new `label-mono`).
- `transitionTimingFunction.snap: 'var(--ease-snap)'`; `transitionDuration.DEFAULT: 'var(--dur-fast)'`; `future.hoverOnlyWhenSupported: true`.
- Keyframes (each gets a tier-table row; travel reads `--motion-shift`, scale reads `--motion-scale-from`): `layer-in` (opacity 70 + transform 120), `layer-out` (70), `sub-in`, `modal-in` (120/160), `modal-out` (120), `toast-in` (70/160), `toast-out` (120), `tip-in` (70), `face-in` / `face-out` (120 / 70).
- `menu-recipe.ts`: `MENU_W` 224, new `MENU_W_MD` 272 (`w-68`), `MENU_W_WIDE` 320 (`w-80`); row `min-h-8` (32), `gap-2`, `px-2`, shortcut slot primitive `DropdownMenuShortcut`; SubContent defaults `sideOffset={4} alignOffset={-5}`. `.cmenu`, `.composer-layer` and `.cv2-pop` deleted in favour of the recipe.

### H3. Native regeneration
**Yes.** `npm run design:tokens` regenerates `tokens.generated.ts` and `JunoGeneratedTokens.swift`: new colours (`menuHighlight`, `destructiveTint`, `borderFloat`, `borderStrong`, `primaryHover`, `primaryPress`, `tooltip*`, `composerBorder*`, `grabber`), radius values (menu 12, field 8, composer 20, composerControl 12, composerAction 12), `JunoGeneratedEasing.snap`, and the new timing tokens. Then hand-port: `JunoElevation` (e1–e3, tooltip), `JunoSurfaces.swift`, `JunoMotion.snap` (`.timingCurve(0.25, 1, 0.5, 1, duration: 0.12)`). Run `npm run design:editor`, `native:icons` (after the redraw), `shell:contract:check` (only if `+` rows change; this direction keeps the contract's row ids and adds the search row as chrome).

---

## I. Native (macOS 26 and iOS 26, SwiftUI + Liquid Glass)

### I1. Same IA and layout as the web

| Region | Web | macOS 26 | iOS 26 (iPhone) |
|---|---|---|---|
| Frame | sidebar column + inset content card (r 12) | `NavigationSplitView` (sidebar 224 / **260** / 352); the system floating glass sidebar is the navigation layer (declared rendering difference); detail = `junoCanvas` | `NavigationStack` with the same sidebar as a leading **overlay** drawer, width `min(0.8W, 320)`, scrim `--scrim` (no push, no parallax, no hardware-radius table) |
| Sidebar header | lockup · bell · collapse; Chat \| Code segmented | traffic lights row; `Picker(.segmented)` Chat \| Code under it (`.controlSize(.small)`); bell as a toolbar item in the sidebar toolbar | drawer header: wordmark, Chat \| Code `Picker(.segmented)` |
| Sidebar rows | New chat ⌘N · Search ⌘K · Activity · Projects · Library · Customize · folds (Pinned, Agents, Recent) · account row | same rows, 32pt, 13pt, `Label` with SF Symbols, `Section` folds | same rows, 44pt, `.body`, `Section` folds; New chat and Search at the **top** |
| Title band | 56px band in the card: title + project crumb; Outputs · Share · More · Incognito | unified toolbar: `.navigationTitle` + `.navigationSubtitle` + `.toolbarTitleMenu`; trailing `ToolbarItemGroup` (Share, More) and `ToolbarSpacer(.fixed)` before Incognito | nav bar: leading sidebar button, inline title with `.toolbarTitleMenu`, trailing New chat |
| Thread | 768 measure, bubble, prose, action row | unchanged (already parity), `scrollEdgeEffectStyle(.soft)` | `LazyVStack` (not `VStack`), tool-run rows rendered from `NativeRunTimeline` |
| Composer | floating card, tools row | floating **glass** bar via `safeAreaBar(edge: .bottom)` | glass bar via `safeAreaBar(edge: .bottom)` (keyboard-attached) |
| Canvas / artifact | right panel in the card | `.inspector` for Chat **and** Code | `.sheet(.large)`; iPad `.inspector` |
| Settings | modal, 12 sections | `Settings` scene, `NavigationSplitView`, same 12 sections, `.searchable(placement: .sidebar)` | `List(.insetGrouped)` sheet on `junoCanvas` (`.scrollContentBackground(.hidden)`) |

### I2. Liquid Glass rules
1. **Glass only on the control layer that floats above content:** toolbar and sidebar (system), the floating composer bar, ⌘K panel, find bar, toast host, Quick Entry, scroll-to-latest (Mac); nav bar items, composer bar, find bar, jump button (iOS). System menus, popovers and partial sheets bring their own glass. Everything else (messages, cards, artifacts, pages, settings rows) is opaque. One allow-list per platform in `check-native-glass.mjs` (R2).
2. **No glass on glass.** Nothing inside a sheet, popover or the composer bar uses `.glass` / `.glassProminent` / `glassEffect`; inside them use `.bordered`, `.borderless`, `.accessoryBar` (Mac) or `.plain`.
3. **Morphing groups** use one `GlassEffectContainer(spacing: 8)` with `glassEffectID`: the composer bar, its `+` and primary (`"plus"`, `"primary"`), and the scroll-to-latest button merging into the bar.
4. **Prominent once:** `.buttonStyle(.glassProminent).tint(.junoInk)` only on the composer primary; page and sheet primaries are `.borderedProminent` (`.buttonBorderShape(.roundedRectangle(radius: 8))`).
5. **Tint sparingly:** ink on the primary only; destructive End uses `.tint(.junoDanger)` on the same disc; no tinted capsules elsewhere.
6. **Reduce Transparency:** composer bar → `Color.junoCard` + 1pt `junoComposerBorder` + e1; glass toasts → `junoPopover`.
7. **System components first:** `Menu`, `.contextMenu`, `Picker(.menu/.segmented)`, `.confirmationDialog`, `.alert`, `.sheet` + `.presentationDetents`, `.popover`, `.inspector`, `.searchable`, `.help` tooltips. The hand-built `+` panel, segmented controls, search fields and pager dots go.

### I3. Per-surface table: web component → SwiftUI

| Web | SwiftUI component + modifiers | Values (generated tokens) |
|---|---|---|
| Sidebar row | `List(selection:) { Label(title, systemImage:) }.listStyle(.sidebar)`; trailing `.badge(n)` or kebab `Menu { … } label: { Image(systemName: "ellipsis") }.menuIndicator(.hidden).buttonStyle(.borderless)` shown on hover; `.contextMenu` with the same items | Mac row 32 (`.environment(\.defaultMinListRowHeight, 32)`), `.font(.junoUI)` 13; iOS 44, `.body`; selection = the system sidebar selection, tinted with `.tint(.junoSidebarSelected)` on the `List`; no `.listRowBackground` overrides |
| Section label | `Section(isExpanded:) { … } header: { Text("Recent") }` | system sidebar header (Mac 11pt semibold secondary; acceptable platform rendering) |
| Product switch | `Picker("", selection: $product) { Label("Chat", systemImage: "bubble.left").tag(.chat); Label("Code", systemImage: "chevron.left.forwardslash.chevron.right").tag(.code) }.pickerStyle(.segmented).labelsHidden()` | `.controlSize(.small)` Mac / `.regular` iOS; delete `JunoProductOrbit` |
| Title band | `.navigationTitle(chat.title)`, `.navigationSubtitle(project)`, `.toolbarTitleMenu { RenameButton(); … }`, `.toolbar { ToolbarItemGroup(placement: .primaryAction) { ShareLink(…); Menu("More", systemImage: "ellipsis") { … } }; ToolbarSpacer(.fixed); ToolbarItem { Toggle("Private", systemImage: "eye.slash", isOn:) } }` | system toolbar glass; no duplicate page title on pages (drop the in-content header **or** the `navigationTitle`, never both: pages keep the serif in-content title and set `.toolbar(removing: .title)`) |
| Composer shell | `GlassEffectContainer(spacing: 8) { VStack(spacing: 0) { AttachmentStrip(); TextField("Ask a follow-up", text: $draft, axis: .vertical).lineLimit(1...10).font(.junoReading).padding(.horizontal, 8).padding(.top, 12).padding(.bottom, 4); ComposerToolsRow() }.padding(8).glassEffect(.regular, in: .rect(cornerRadius: JunoRadius.composer)).glassEffectID("composer", in: ns) }.safeAreaBar(edge: .bottom) { … }` | r 20 (`JunoGeneratedRadius.composer`), inset 8, max width 720, field 16/24 (Mac `junoFont(16)`, iOS `.body` with Dynamic Type) |
| Composer controls | Mac: `Button { } label: { Image(systemName: "plus") }.buttonStyle(.accessoryBar)` (native hover + pressed); iOS: `.buttonStyle(.plain)` + `.frame(width: 44, height: 44).contentShape(.rect)` | 32×32 (Mac) / 36 visual in 44 (iOS), `ConcentricRectangle()` shape so corners follow the bar (12) |
| `+` menu | `Menu { Section { Button("Add Photos & Files", systemImage: "paperclip") {}.keyboardShortcut("u"); Button("Take Screenshot", systemImage: "camera.viewfinder") {}; Button("Add from Library", systemImage: "books.vertical") {} }; Section { Toggle("Web Search", systemImage: "globe", isOn: $web); Toggle("Deep Research", systemImage: "binoculars", isOn: $research); Toggle("Create Image", systemImage: "photo", isOn: $image); Toggle("Memory", systemImage: "rectangle.stack", isOn: $memory) }; Section { Menu("Project", systemImage: "folder") { Picker("Project", selection: $project) {…} }; Menu("Apps", systemImage: "square.grid.2x2") {…} } } label: { Image(systemName: "plus") }.menuOrder(.fixed)` | iOS: top `ControlGroup { Camera; Photos; Files }.controlGroupStyle(.menu)` (medium palette); system glass menu morphs from the `+` |
| Model chip + picker | Mac: `Button { showPicker = true } label: { Text("Opus 5.5"); Image(systemName: "chevron.down") }.buttonStyle(.accessoryBar).popover(isPresented:arrowEdge: .top) { ModelPicker() }` with `ModelPicker` = `VStack { TextField("Search models", …).textFieldStyle(.plain); List(selection:) { Section("Recommended") {…} }.listStyle(.plain); EffortFooter() }.frame(width: 320)`; iOS: `.sheet` + `.presentationDetents([.medium, .large])` + `NavigationStack { List { … }.searchable(text:) }` | rows 48 (name 13 semibold + description 12 secondary), `.keyboardShortcut("1")`…`("3")`; effort `Picker(.segmented)` + `Toggle("Thinking")` |
| Send ⇄ stop | `Button(action:) { Image(systemName: face.symbol).font(.system(size: 15, weight: .bold)).contentTransition(.symbolEffect(.replace.downUp)) }.buttonStyle(.glassProminent).tint(.junoInk).buttonBorderShape(.roundedRectangle(radius: 12)).glassEffectID("primary", in: ns).keyboardShortcut(.return, modifiers: [])` | faces `waveform` / `arrow.up` / `stop.fill`; 32 Mac, 36 iOS |
| Attachment chip | `HStack { thumbnail(56).clipShape(.rect(cornerRadius: 12)) … }` + remove `Button { } label: { Image(systemName: "xmark") }.buttonStyle(.plain)` in a 20pt `Circle().fill(.junoInk)` with `.frame(44)` hit on iOS | opaque (`junoCard` / `junoMuted`), never `.thinMaterial` |
| Message actions | inline `HStack(spacing: 2)` of `Button { } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless).help("Copy  ⌘C")`; the same items in `.contextMenu` on the **bubble/prose only** (not the action row) | glyph 16 (`.imageScale(.medium)` at `.font(.junoUI)`), 32 targets Mac / 44 iOS |
| Sidebar row menu / context menu | `.contextMenu { Button("Rename", systemImage: "pencil") {}.keyboardShortcut(.init("r")); Button(isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.slash" : "pin") {}; Menu("Add to Project", systemImage: "folder.badge.plus") {…}; ShareLink(…); Divider(); Button("Delete…", systemImage: "trash", role: .destructive) {} }` | system; iOS adds `.swipeActions` (Pin leading, Delete trailing) |
| Dropdown / select | `Picker(selection:) {…}.pickerStyle(.menu)` (pop-up button) for selects; `Menu` for verbs | system |
| Command palette ⌘K | Mac: floating panel (allowed glass) `VStack { searchField(48); results List(.plain) rows 32; hintFooter }.frame(width: 560).glassEffect(.regular, in: .rect(cornerRadius: 16))`, `.keyboardShortcut("k")`; iOS: `.searchable` + search tab/sheet | rows 32, `.onKeyPress(.upArrow/.downArrow)` + `.focusable()` |
| Dialog | Mac: `.sheet { Form { … }.formStyle(.grouped) .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") {} }; ToolbarItem(placement: .confirmationAction) { Button("Save") {} } } }.presentationSizing(.form)`; iOS: `.sheet { NavigationStack { Form {…}.toolbar {…} } }.presentationDetents([.large])` | no fixed frames (`.presentationSizing(.form/.page)`); no glass buttons inside |
| Destructive confirm | `.confirmationDialog("Delete “\(title)”?", isPresented: $confirm, titleVisibility: .visible) { Button("Delete", role: .destructive) {…}; Button("Cancel", role: .cancel) {} } message: { Text("Removes the chat and its files from all devices. This can’t be undone.") }` | system (Mac sheet-style alert; iOS anchored action sheet) |
| Bottom sheet | `.sheet { … }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible).presentationBackground(.junoPopover)` only for opaque-at-large content | grabber only with ≥ 2 detents |
| Popover / hover card | `.popover(isPresented:attachmentAnchor:arrowEdge:) { content.padding(12).frame(width: 320) }` (Mac hover: `.onContinuousHover` with 300ms task delay) | no fixed heights (crash rule respected with `.fixedSize(horizontal: false, vertical: true)`) |
| Toast | `JunoToastHost`: `HStack { Image(systemName:); Text; Button("Undo") {}.buttonStyle(.borderless) }.padding(.horizontal, 12).padding(.vertical, 10).glassEffect(.regular, in: .rect(cornerRadius: 12))` above the composer | 360 wide Mac; full width − 16 iOS |
| Tooltip | `.help("Copy  ⌘C")` (Mac only) | system |
| Buttons | primary `.borderedProminent` + `.tint(.junoInk)`; secondary `.bordered`; ghost `.borderless`; destructive `role: .destructive`; all `.buttonBorderShape(.roundedRectangle(radius: 8))`, `.controlSize(.regular)` (Mac 28pt ≈ web sm) or `.large` (32pt ≈ web md) | 32 → 1 style family (delete the 32 custom ButtonStyles except `JunoPressButtonStyle` for custom rows) |
| Segmented | `Picker(...).pickerStyle(.segmented)` | delete `JunoSegmented`, `JunoMobileSegmented`, `JunoMobileCapsuleSegmented` |
| Switch / checkbox | `Toggle(...).toggleStyle(.switch).controlSize(.small)` (Mac rows), `.toggleStyle(.checkbox)` (Mac forms); iOS default | — |
| Text field / search | `TextField(...).textFieldStyle(.roundedBorder).controlSize(.large)` in forms; search: `.searchable` | delete hand-rolled search fields (settings rail r 9, drawer, code home) |
| List row (two-line) | `Label { VStack(alignment: .leading, spacing: 2) { Text(name).font(.junoUI.weight(.medium)); Text(detail).font(.junoLabel).foregroundStyle(.secondary) } } icon: { Image(systemName:) }` | 48 Mac / 60 iOS |
| Skeleton / spinner / progress | `.redacted(reason: .placeholder)` + `phaseAnimator` opacity 1↔.55 (1.8s); `ProgressView().controlSize(.small)`; `ProgressView(value:).tint(.junoInk)` | — |
| Empty state | `ContentUnavailableView { Label("No chats yet", systemImage: "bubble.left") } description: { Text(…) } actions: { Button("New Chat") {}.buttonStyle(.bordered) }` with the title in Newsreader 20 | — |
| Icons in custom views | `Image(systemName:)` with `.font(.junoUI)` (inherits size and weight), `.imageScale(.medium)`; `.symbolVariant(.fill)` for on-states; brand marks `Image("juno.orbit")` (SF template) | weight `.regular` beside 13pt text, `.medium` beside 15pt, `.semibold` for the send arrow |

### I4. SF Symbols mapping (web icon → SF Symbol; weight/scale matched to adjacent text)

| Web | SF Symbol | | Web | SF Symbol |
|---|---|---|---|---|
| plus | `plus` | | trash | `trash` |
| attach | `paperclip` | | pin / unpin | `pin` / `pin.slash` (on: `pin.fill`) |
| mic (dictation) | `mic` | | folder / project | `folder` (`folder.fill` selected) |
| voice | `waveform` | | globe (web search) | `globe` (armed: `globe` + token) |
| send | `arrow.up` (`.bold`) | | image | `photo` |
| stop | `stop.fill` | | file | `doc` |
| model / sparkle | `sparkle` | | memory | `rectangle.stack` |
| search | `magnifyingglass` | | agent | `juno.agent` (brand) |
| settings | `gearshape` | | new chat | `square.and.pencil` |
| copy | `doc.on.doc` | | sidebar | `sidebar.left` |
| edit | `pencil` | | code | `chevron.left.forwardslash.chevron.right` |
| retry | `arrow.counterclockwise` | | bell | `bell` (`bell.slash`) |
| share | `square.and.arrow.up` | | research | `binoculars` |
| more | `ellipsis` | | library | `books.vertical` |
| chevron right / down | `chevron.right` / `chevron.down` | | activity | `chart.bar` |
| chevrons up-down | `chevron.up.chevron.down` | | customize | `slider.horizontal.3` |
| check | `checkmark` | | skills | `text.book.closed` |
| close | `xmark` | | apps | `square.grid.2x2` |
| thumbs up / down | `hand.thumbsup` / `hand.thumbsdown` | | read aloud | `speaker.wave.2` |
| branch | `arrow.triangle.branch` | | screenshot | `camera.viewfinder` |
| archive | `archivebox` | | private chat | `juno.ghost` (brand) |
| success / alert / warning / info | `checkmark.circle` / `exclamationmark.circle` / `exclamationmark.triangle` / `info.circle` | | orbit (agents) | `juno.orbit` (brand) |

Scale: Mac chrome symbols at `.font(.system(size: 13))` `.imageScale(.medium)` (≈ 16px glyph, matches web 16 beside 13 text); iOS at `.body` `.imageScale(.medium)`; toolbar items use the system size. Weight follows the adjacent text (`.regular` with 13 regular, `.medium` with 13 medium labels); the send arrow is `.bold`.

### I5. Motion on native

| Web token / storyboard | SwiftUI |
|---|---|
| press (#2) | `JunoPressButtonStyle`: `.scaleEffect(isPressed ? 0.97 : 1).animation(isPressed ? .easeOut(duration: 0.07) : .spring(duration: 0.18, bounce: 0), value: isPressed)` |
| `--ease-snap` 120 (#3–#20 entrances) | `JunoMotion.snap = .timingCurve(0.25, 1, 0.5, 1, duration: 0.12)` |
| exits 70 | `JunoMotion.exit = .easeIn(duration: 0.07)` |
| `--spring-snap` (#28) | `.spring(duration: 0.18, bounce: 0)` (= `.smooth(duration: 0.18)`) |
| `--spring-standard` (#12) | system sheet presentation (no custom animation) |
| menus, popovers, sheets, confirmation dialogs (#3–#12) | system: do not animate them; glass menus morph out of the source control by themselves |
| send ⇄ stop (#18–#19) | `withAnimation(JunoMotion.snap) { face = .stop }` + `.contentTransition(.symbolEffect(.replace.downUp.byLayer))`; the glass shape keeps its `glassEffectID("primary")` so only the symbol changes |
| composer tools morph (`+` tokens appearing) | `GlassEffectContainer` + `withAnimation(.smooth(duration: 0.22))`; tokens `.transition(.scale(0.92).combined(with: .opacity))` |
| composer grow (#17) | `.animation(JunoMotion.snap, value: lineCount)` |
| attachment add/remove (#20) | insert `.transition(.asymmetric(insertion: .scale(0.92).combined(with: .opacity), removal: .opacity.animation(JunoMotion.exit)))` |
| toast (#13) | `.transition(.move(edge: .bottom).combined(with: .opacity))` with `.spring(duration: 0.16, bounce: 0)`; removal `.easeIn(duration: 0.12)` |
| message appears (#23) | `.transition(.opacity.combined(with: .offset(y: 8)))` with `JunoMotion.snap` |
| scroll-to-latest | `glassEffectID("jump")` merges into the composer container with `.smooth(duration: 0.22)` |
| inspector (#26) | system `.inspector` animation |
| Reduce Motion | `@Environment(\.accessibilityReduceMotion)`: replace transforms with `.opacity`, cap durations at 0.12, `.contentTransition(.opacity)` for symbols, `GlassEffectTransition.identity` for glass morphs |
| macOS `platformFactor` | 1.0 for the snap family (already short); 0.75 stays only for `layout`/`emphasized` |

### I6. The 25 worst native offences and their fix

| # | Offence (map ref) | Fix |
|---|---|---|
| 1 | Mac: custom dot-orbit Chat/Code switch in the toolbar centre (`ChatToolbar.swift:54`) | `Picker(.segmented)` in the sidebar header; delete `JunoProductOrbit` |
| 2 | Mac: glass capsules on the content layer (97 `.junoGlass`, 64 `.junoProminent`) | `.borderedProminent` / `.bordered` / `.borderless` rect r 8 in content; glass only per I2 |
| 3 | Mac + iOS: glass on glass in sheets and popovers (~48 Mac; composer capsules, dictation, `+` panel on iOS) | I2 rule 2; lint check 4 stops exempting `JunoGlassControls.swift` |
| 4 | Mac: edgeless glass composer slab (`JunoComposerShell.swift:296-318`) | glass bar with the system edge highlight over scrolling content + Reduce Transparency fallback (opaque card + 1pt border); r 20, inset 8 |
| 5 | iOS: hand-built glass `+` panel with a 4000×4000 tap catcher (`JunoMobileAttachmentMenu.swift`) | system `Menu` with `Section`s, `Toggle`s and a `ControlGroup` palette |
| 6 | iOS: no model name on the composer; long-press gauge (`JunoMobileThinkingDial.swift:15-39`) | model chip `Button` with the name → sheet picker with detents |
| 7 | iOS: 114 custom glass call sites incl. content (bubble "Show more", Work cards, Library controls) | remove; allow-list per I2; checker exemption removed (R2) |
| 8 | Mac: page titles SF Medium 32–44 + duplicate toolbar title (`JunoTypography.swift:168`, `ChatDetail.swift:30-34`) | Newsreader page title in content, `.toolbar(removing: .title)` on pages |
| 9 | Both: bitmap custom icons, 13–15 sizes, no Dynamic Type (`JunoBrand.swift:980-1040`) | SF Symbols per I4; brand marks as SF templates; two glyph sizes (16 Mac / `.body` iOS, 20 for toolbars) |
| 10 | iOS: five composers with radii 26/24/24/22/28 | one `JunoComposerShell` (r 20) for Chat, Incognito, Code voice, link and terminal |
| 11 | iOS: push drawer with parallax, card corners from a screen-width table, 52pt ink-tinted "Chat" capsule at the bottom | overlay drawer (web parity); New chat + Search rows at the top; plain 44pt rows; account row at the bottom |
| 12 | Mac: 32 custom ButtonStyles, 70 hand-written hover state machines | system styles + `.accessoryBar` for composer controls (native hover); `JunoPressButtonStyle` only for custom rows |
| 13 | Mac: `JunoSegmented` glass track everywhere (60 uses); iOS: 3 hand-rolled segmented controls | `Picker(.segmented)` |
| 14 | Mac: sidebar fights `List` (row background painted over selection, `leadingShift` +10, negative pads) | plain `List(.sidebar)` rows, `defaultMinListRowHeight` 32, no `listRowBackground` overrides, glyph at the system edge |
| 15 | Mac: oversized 40pt "prominent" New chat row | ordinary 32pt row with ⌘N shortcut |
| 16 | Mac: three typography APIs; 58 sites at 10.5/11pt | `junoType` only; rungs ui 13, label 12, reading 16, heading-sm 15; 11 only for kbd |
| 17 | Mac: canvas header mixes four button idioms + hand-drawn separator | `.inspector` with a toolbar: `ToolbarItemGroup` of `.borderless` icon buttons, `Divider()`, one `.borderedProminent` Save |
| 18 | Mac: chat uses a custom `TrailingDock`, Code uses `.inspector` | `.inspector` for both; one panel header |
| 19 | iOS: tool calls not rendered in the transcript | render `NativeRunTimeline` rows (web run-line parity) |
| 20 | Both: four treatments in the primary slot (ink disc, ink glass, red disc, red glass) | one `glassProminent` disc: ink for send/stop/✓, `.junoDanger` tint for End |
| 21 | Mac/iOS: fixed-size sheets and popovers (560×520, computed heights) | `.presentationSizing(.form/.page)`, `.fixedSize(horizontal:false, vertical:true)` |
| 22 | iOS: grabber on single-detent sheets (5 places) | `.presentationDragIndicator(.visible)` only with ≥ 2 detents |
| 23 | iOS: `.thinMaterial` banners and chips beside Liquid Glass; iPad sidebar `.regularMaterial` | opaque banners (web banner spec E6); remove materials |
| 24 | Both: ad-hoc fills (≈22 Mac / 35 iOS `opacity()` values), `Color.red` destructive | generated tokens only: `junoAccent`, `junoMenuHighlight`, `junoSelectedFill`, `junoDanger` |
| 25 | Both: sign-in with painted landscapes, card form, tiny bezel fields (Mac) and umber shadows (iOS) | web sign-in parity: dark galaxy plate, lockup, cardless form, 44pt fields, one `.borderedProminent` Sign in |

---

## J. Rollout (smallest diff, biggest felt gain)
1. Tokens H1/H2 + regenerated Swift (one commit, CI gates green).
2. `menu-recipe.ts` → command surface; delete `.cmenu`, `.composer-layer`, `.cv2-pop`; model picker, `+`, `/`, ⌘K on one component.
3. Composer F (radius, inset, controls, faces, attachments, overlay).
4. Motion keyframes G + tier table rows; tooltip and toast tokens.
5. Icon redraw B5 + native SF Symbols switch (R1) + `native:icons`.
6. Native shell I1/I2/I6 in that order: Mac product switch and glass removal, iOS `+` menu and composer, then pages.
