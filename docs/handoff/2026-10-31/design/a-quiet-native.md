# Alevr direction A: Quiet Native

**Status:** design direction for owner review. Nothing in the repo is changed. The mockup is
`a-quiet-native.html` in this folder and its screenshots are `a-quiet-native-*.png`.
The values come from the live tokens in `src/app/globals.css` and `tailwind.config.ts`
(parity-base, 31 Oct 2026) and from the ten maps in this folder.

**The idea in one line.** Alevr should feel like a first-class Apple app on every platform. Every
surface is opaque and crisp, with one hairline and one soft shadow. Corners nest concentrically
(16 window, 12 container, 8 item). Rows are 32px on a desktop and 44pt on touch, and all rows share
one anatomy: an icon column, a label and one trailing slot. Selection is always a check mark. Layers
grow out of the control that opened them, settle without bouncing, and leave faster than they came.
Liquid Glass belongs only to the native control layer.

---

## 0. The twelve decisions

| # | Decision | Replaces |
|---|---|---|
| 1 | **One floating surface.** Menus, selects, popovers, hover cards and toasts use radius 12, a 4px inset, rows at radius 8, a 1px `--hairline` and `--shadow-float`. | Six menu systems: 18/14/12/16 radii, four shadow recipes, three hairlines (map-menus §6) |
| 2 | **One row.** 32px tall (44 on coarse pointers), 8px padding, a 16px icon column, an 8px gap, a 14/20 label and **exactly one trailing slot** (shortcut, chevron, check, value or count). | Row heights of 32/34/36/46, type at 13/14/15, labels at x = 32/34/36/38 |
| 3 | **Selection is a trailing 16px check in `--foreground`, everywhere.** Native platforms draw their own placement (see I.6). | About 16 selection idioms (map-menus §6.13) |
| 4 | **The highlight is an alpha fill** (`--fill-selected`: ink 7.5% in light, white 8.5% in dark). It appears in 0ms and fades out over 120ms. A keyboard highlight adds an inset 1.5px ring. | `bg-accent` in light, which measures 1.09:1 in dark. The 120ms in-and-out smear (map-motion J1). |
| 5 | **Concentric radius ladder** `16 > 12 > 8 > 6 > 4`, plus capsules. Every 28–36px control (button, field, select, segmented track, icon button) takes 8. | Fields at 10, buttons at 8, segmented tracks at 14 and thumbs at 9 side by side (map-components §4.1) |
| 6 | **Dark mode rises by lightness.** Card 14%, float 17.5%, modal 19.6%, each with a white 9% hairline. Shadows stay soft. | One `--shadow-float` for everything; popover at 16% with a heavy black throw |
| 7 | **Icons redrawn on SF-like construction**: 24-unit grid, 20-unit live area, round caps and joins, the line matched to the paired text stem (1.33px at 16), and fill only for "on". Natively the same drawings ship as **vector custom-symbol templates**, not bitmaps. | Lucide and house drawings mixed; a 1.5/2px "bold pass" that is heavier than the text beside it; rasterised native icons |
| 8 | **One composer geometry** for landing, dock and phone: radius 26, 36px corner controls at an 8px inset (concentric, since 26 − 8 = 18 = r), 16/24 text at a 20px inset, and an ink disc that only swaps its glyph. | Field heights of 56 and 46, a 32/36 disc swap, seven glyph sizes on one row, a grey voice disc |
| 9 | **Motion vocabulary.** Opacity runs on `--dur-fast` (120) out-soft. Transforms run on generated springs (snap, standard, layout) at their own `-dur`. Exits take 120–160 ease-in, scale to 0.98 and do not travel. Anything opened from the keyboard appears in frame 0. | About 11 entrance recipes and 6 easing vocabularies (map-motion §1.2, map-popups §3I) |
| 10 | **Sans for chrome metadata.** Section labels, shortcuts and counts use Inter 12/16 500 with tabular figures. JetBrains Mono is kept for code, paths, receipts and keycaps. | About 720 mono metadata sites that read as a dev console |
| 11 | **Pinned dialog anatomy.** Header, scrolling body and footer. The ✕ is a 28px tonal circle centred on the title line. Cancel is a tonal secondary button. Widths are 400, 520 and 880. | A ✕ that scrolls away, 9 widths, a ghost Cancel that disappears at rest |
| 12 | **Native = same anatomy, native parts.** System `Menu`, `Picker`, `confirmationDialog` and `sheet` with detents. Glass only on toolbars, the sidebar, the floating composer group and system presentations. Content and controls inside content are opaque. | About 230 glass controls on content (Mac) and 114 on iOS; a hand-built `+` panel; an orbit switch in the toolbar |

---

## A. Foundations

### A.1 Spacing

The base is 4px. The allowed rungs are **2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48** (all in `SPACE_STEPS`). Recipes
written for this direction use no 10 or 14 and no arbitrary values.

| Rung | Job |
|---|---|
| 2 | segmented track inset; icon ↔ badge nudge |
| 4 | **floating container inset**; gap between composer controls; separator vertical margin |
| 6 | gap between a chip's icon and its label; gap between a label and its hint |
| 8 | row horizontal padding; icon ↔ label gap; button gap; composer row padding |
| 12 | toast and popover padding; attachment inset in the composer; card gap |
| 16 | card padding; panel gutter; sheet content padding |
| 20 | dialog header top padding; composer field side inset |
| 24 | dialog side and bottom padding; section gap inside a pane |
| 32 / 40 / 48 | page gutter ≥1024; section breaks |

### A.2 Radius ladder (concentric)

| Level | px | Token (rung) | Used by |
|---|---|---|---|
| Window | **16** | `panel` | dialogs, the command palette, bottom-sheet top corners, side sheets, the web content card (today 14 → 16) |
| Container | **12** | `card` = `popover` = `menu` (**menu 14 → 12**) | menus, selects, popovers, hover cards, toasts, in-flow cards, inline alerts, banners |
| Item | **8** | `control` = `field` (**field 10 → 8**) | rows, buttons 28–36, fields, selects, icon buttons, segmented track, tiles |
| Inner | **6** | `xs` | segmented thumb, keycaps, tooltips, small tiles inside rows |
| Micro | **4** | `sm` | checkbox, progress ends, non-pill badges |
| Capsule | full | `full` | chips, pills, switches, composer controls, avatars, the 44px touch primary |
| Composer | **26** | `composer` (unchanged) | composer shell; its attachment tiles take **14** (`composer-control`, at last used) |

Concentric checks. The `design-system/concentric-radius` lint already enforces the rule
"child = parent − padding".

| Parent | Inset | Child | Result |
|---|---|---|---|
| Menu 12 | 4 | row 8 | ✓ |
| Palette 16 | 8 | row 8 | ✓ |
| Segmented track 8 | 2 | thumb 6 | ✓ |
| Composer 26 | 8 | 36px circle (r 18) | ✓, so the `+` and the disc nest in the corners |
| Composer 26 | 12 | attachment tile 14 | ✓ |
| Mac window 26 (Tahoe) | 8 | glass sidebar 18 | ✓ (native) |
| iPhone display ≈55 | 12 | composer bottom corners: `ConcentricRectangle`, minimum 26 | ✓ (native only) |

### A.3 Hairlines and borders

| Token | Light | Dark | Job |
|---|---|---|---|
| `--hairline` (**re-valued, cool**) | ink / 0.10 → #E8E8E9 on white | white / 0.09 | the edge of every floating surface, the composer edge, separators inside floats |
| `--border` (unchanged) | #DFE0E2 | #36373A | in-flow cards, settings groups, dividers on the page ground |
| `--input` (unchanged, 3:1) | #86898D, 3.51:1 on white | #707276 | field, checkbox and radio boundaries. A lighter value fails 3:1 on the sidebar (56% L measures 2.99:1), so it stays. |
| `--ring` (unchanged) | graphite | light ink | focus |

Width is 1px. At dpr ≥ 2, floating surfaces draw the hairline at **0.5px with double alpha**
(`--hairline-hi`: ink 0.16 / white 0.14). This is the Apple retina edge. It falls back to 1px at dpr 1.

### A.4 Surfaces

| Token | Light | Dark | Notes |
|---|---|---|---|
| `--background` (page) | #FCFCFD | #18191B | unchanged |
| `--sidebar` | #F3F4F5 | #111213 | unchanged |
| `--card` (in-flow, composer) | #FFFFFF | #222326 (14.1%) | unchanged |
| `--popover` (float) | #FFFFFF | **#2A2C2F (17.5%)**, was #27282B | dark rises by lightness |
| `--surface-modal` (**new**) | #FFFFFF | **#2F3135 (19.6%)** | dialogs, sheets, the palette |
| `--key` (**new**) | #FFFFFF | #3C3E43 (25%) | segmented thumb, switch knob, slider thumb |
| `--tooltip` / `--tooltip-foreground` (**new**) | #1F2125 / #FAFAFA | #3F4146 / #FAFAFA | replaces the raw `hsl(222 9% 12%)` |
| `--scrim` (**re-valued, cool**) | `220 12% 8% / 0.30` | `0 0% 0% / 0.55` | was warm `48 12% 8% / .26` |
| `--grabber` (**new**) | ink / 0.20 | white / 0.24 | one grabber ink, used by every sheet |

### A.5 Elevation (one level per surface type)

| Level | Surfaces | Light | Dark |
|---|---|---|---|
| **E0 flat** | in-flow cards, settings groups, list containers, the transcript | fill + 1px `--border`, no shadow | fill + 1px `--border`, no shadow |
| **E1 raised** | the composer, segmented thumb, switch knob | composer: `0 1px 2px ink/.04, 0 6px 20px -8px ink/.12` + hairline. Focus: `0 1px 2px ink/.05, 0 10px 28px -10px ink/.18`. Key: `0 .5px 1px ink/.10, 0 1px 3px ink/.08` | composer: card #222326 + white/.09 hairline + `0 1px 2px #000/.3, 0 8px 24px -10px #000/.5`. Key: #3C3E43 + `0 1px 2px #000/.35` |
| **E2 float** | menus, selects, popovers, hover cards, toasts | `--popover` + hairline + `0 1px 2px ink/.05, 0 8px 24px -6px ink/.16` | #2A2C2F + white/.09 hairline + `0 1px 2px #000/.30, 0 10px 24px -8px #000/.45` |
| **E3 modal** | dialogs, sheets, the palette | `--surface-modal` + hairline + `0 2px 4px ink/.05, 0 24px 64px -16px ink/.28` + scrim .30 | #2F3135 + white/.10 hairline + `0 2px 6px #000/.35, 0 24px 56px -16px #000/.60` + scrim .55 |
| Tooltip | ink label | `0 2px 8px -2px ink/.24` | white/.08 hairline + `0 2px 8px #000/.40` |

Shadows are cut from `--shadow-ink` (FLAT_UI law). The primary button loses its three-layer tinted glow.
No in-flow control casts a shadow.

### A.6 Type rungs for chrome (Inter; no new rungs)

| Rung | Size / line | Weight | Tracking | Used for |
|---|---|---|---|---|
| `reading` | 16/26 (composer 16/24) | 400 | −0.006em | transcript, composer field |
| `nav` | **14/20** | 400 (500 for row titles in pickers) | −0.003em | **every row**: menus, selects, sidebar, lists, palette, toasts, field text |
| `ui` | 13/18 | 500 | 0 | buttons, chips, segmented, tabs, the model chip |
| `label` (sans) | 12/16 | 500 | 0 | section labels, descriptions, meta, shortcuts (`tnum`), helper text |
| `kbd` | 11/16 | 500 mono | 0.02em | keycaps and badges only (the existing exception) |
| `heading` | 18/24 | 600 | −0.01em | dialog, sheet and popover titles |
| `title` (serif) | Newsreader 22/28 | 400 | −0.01em | empty-state titles, page h2 |
| `display` (serif) | Newsreader 48/56 (phone 34/40) | 400 | −0.03em | home greeting, page h1 |

The floor stays at 12px. There are no half-pixel sizes (10.5, 12.5) and no 11px mono heads.

### A.7 States, focus and disabled

| State | Light | Dark | Rule |
|---|---|---|---|
| Hover (`--fill-hover`, **new**) | ink / 0.05 | white / 0.06 | appears in 0ms, leaves over 120ms out-soft, only under `(hover:hover)` |
| Highlight / selected (`--fill-selected`, **new**) | ink / 0.075 | white / 0.085 | the menu and list cursor; selected list rows. Muted text on it measures 4.6 (light) and 4.5 (dark) with `--muted-foreground-on-fill`. |
| Pressed (`--fill-pressed`, **new**) | ink / 0.10 | white / 0.11 | rows and wide controls press tonally |
| Sidebar hover / selected | `--sidebar-hover` / `--sidebar-selected` (opaque, unchanged) | same | fill only, no edge |
| Keyboard highlight in lists | `--fill-selected` + `inset 0 0 0 1.5px hsl(var(--ring)/.55)` | same | only with `data-modality=keyboard`. Fixes the 1.07:1 failure noted in WCAG 1.4.11. |
| Focus ring (controls) | `outline: 2px solid hsl(var(--ring)); outline-offset: 2px` | same | keyboard only (owner rule); 3px in high contrast; system Highlight in forced colours |
| Disabled | `opacity: .5`, no pointer events, no hover | same | one value, replacing seven. Disabled menu rows stay focusable and show their reason as a description line. |
| Press (small controls ≤ 64px) | `scale(.97)` over 70ms out-soft; release on `--spring-snap` | same | rows, cards and wide buttons press tonally with no scale |

Ink rules are unchanged: graphite primary, ultramarine presence = live, ember signal = needs you, destructive
with a circle-x, attention for limits and offline, and no opacity on text inks.

---

## B. Icons

### B.1 Grid and keylines

- The canvas is **24 × 24 units**. The live area is **20 × 20** (2-unit padding). Overshoot zone: 1 unit.
- Keyline shapes: circle Ø 20 · square 17 × 17 (r 3) · portrait 15 × 19 · landscape 19 × 15.
  Circles are about 1 unit larger than squares so they read the same size.
- Containers 15 units or larger take r 3; containers under 15 take r 2.25; device glyphs follow the same rule.
- **Gaps.** A stroke passing behind another stroke stops 1.5 units short (the house gap, kept).
  The slash in a "slashed" composite gets a 1-unit gap and runs corner to corner, so the glyph never breaks into 3–4 islands.
- **Points.** Dots and terminals have r ≥ 0.75 × line. The ellipsis dots are r 1.5.

### B.2 Line weight per size (optical sizes 14, 16 and 20)

| Optical size | Paired text | Line (px) | Units | Detail level |
|---|---|---|---|---|
| **S 14** | 12–13px label | 1.25 | 2.14 | small cut: interior detail removed (no inner lines in documents, two faders not three) |
| **M 16** (default) | 13–14px ui and nav | 1.33 | 2.0 | full drawing |
| 18 | 15–16px | 1.5 | 2.0 | full |
| **L 20** | 16–17px, touch, composer | 1.6 | 1.92 | full; the composer hero glyphs use the bold cut |
| 24 | display, empty states | 1.75 | 1.75 | full |
| Bold cut (+30%) | send, stop and `+` on the ink disc and in the composer | 18px → 1.9px · 20px → 2.0px | 2.5 | used for the composer's primary glyphs only |

**Stem-ratio rule:** icon line ÷ the stem of the text beside it stays between 0.85 and 1.05 (Inter 14 Regular
stem ≈ 1.23px, so 16px glyph at 1.33 → 1.08 with Regular, 0.98 with Medium 13). This reverses the October "bold line
pass" (1.5 @16, 2 @18), which made glyphs read heavier than their labels (map-composer §11).
At dpr 1 the renderer snaps 14/16 to 1px and 20 to 1.5px; at dpr ≥ 2 the geometric weight is used unsnapped.

### B.3 Construction

- Caps and joins are **round** throughout. Corners on containers are continuous (`rr`).
- One bubble, one folder, one capsule and one bell construction, each shared by every variant.
- **New = the compose glyph** (`square.and.pencil` construction) for New chat only. "Add X" variants keep the
  corner plus knocked out of the parent glyph.
- Arrows use a 90° head with arm length 5.75 units at M.

### B.4 Fill vs outline

- **Outline at rest, always**, including sidebar destinations and tabs. Selection is shown by the row fill, not the glyph.
- **Fill means "on"** for toggles that persist: `pin.fill` when pinned, `bell.fill` when notifications are on,
  `thumbs.fill` after rating, `bookmark.fill`, `folder.fill` for the folder currently open in a picker,
  and the stop square, which is always filled.
- A filled glyph knocks its interior detail out at 1.5 units so it keeps the same silhouette as the outline.
- Never fill for decoration. Citation heads and `contrast` become outlines with a half-tone at 50% of `currentColor`.

### B.5 Alignment to text

- An icon box is centred on the **cap-height centre** of its label, not the x-height centre.
  Labels in icon rows use `text-box: trim-both cap alphabetic`, so flex `items-center` lines up on caps.
  Fallback (older Safari): the glyph is translated −0.5px.
- Bottom-heavy glyphs carry an optical offset in their data (lock, agent, crew and cloud move up 0.75–1 unit;
  auto moves down 1 unit). The fit stage then snaps them back to the grid.
- Chevrons in a trailing slot get a −2px end margin to correct the canvas offset (ChatGPT does the same).

### B.6 Glyphs on the current sheet that are off-style, and the redraw

From `icons-sheet.png` (237 glyphs):

| Current glyph | What is wrong | Redraw |
|---|---|---|
| `chat`, `chat-question`, `chats`, `thought` | four bubble constructions (Lucide tail and house tail) | one `BUBBLE`: r 4 body 18 × 14, a 3-unit tail at the bottom left, house gap where the bubbles in `chats` overlap |
| `orbit` | two arcs and three satellites; at 16px the satellites become specks; twice the mass of `code` | one ellipse at 20° and **one** satellite dot r 1.5; target ink coverage 0.21 |
| `code` | the lightest destination (0.15), wider than the live area | brackets 9 units tall at x 4.25 and 19.75, the slash shortened to 12 units, `optical: 1.08` |
| `new-chat` | Lucide's square-pen, off-centre, no gap | SF-like compose: a 15 × 15 frame open at the top right, the pencil crossing with a 1.5-unit gap |
| `search` | the handle touches the lens with no gap | lens r 6.25 at (10.75, 10.75), a 6.4-unit handle at 45° with round cap (attached, SF-style) |
| `folder` vs `folder-plus/-move/-code/-lock` | two tab shapes and two silhouettes | rebuild every variant on one `FOLDER` (21 × 15, a tab 6 units wide, r 2.25) |
| `library` | the spine closes at 16px ("lll") | two books 5 units wide + one leaning at 15°; no spines below 18px |
| `customize` | 9 strokes, dense at 16 | two sliders (S cut) or three (M), knobs r 2 |
| `bell` vs `bell-off` | two different bells | one `BELL` (dome r 5.75, a 1.5-unit flare); `bell-off` adds a corner-to-corner slash with a 1-unit gap |
| `sidebar` vs `panel-right` | different frames (r 2 vs r 3) | `panel-right = flipX(sidebar)`, a 17 × 14 frame r 3, the divider at 1/3 |
| `mic`, `mic-off`, `dictation` | three capsules; `dictation` reads as "ψI" | one capsule 6.5 × 11 r 3.25; `dictation` = the capsule + three text lines (S cut drops the lines) |
| `voice` | 6 bars running to the box edge, centred on 11.56 | 5 bars at x 4/8/12/16/20, heights 3/9/15/9/3, centred on 12 |
| `design` (nib) | the inner dot closes at 14–18px; also used for the Design destination | the destination gets a square + circle mark; the nib stays only for the path tool |
| `crew`, `agent`, `add-member` | overflow the live area; centroid +1.7 to +2.3 units, so they sit 1.5px low | scale into the keyline and raise by 1 unit |
| `cloud`, `offline`, `cloud-upload` | sit about 1.8px low; the arrow falls below the base | move the cloud up 1.5 units; keep the arrow inside the base band |
| `auto` | the gauge sits 1 unit high | move the dial centre down 1 unit |
| `diff` | 0.098 coverage, floats 1.1px high | 13.5 units wide, centred, inside a 17 × 17 frame |
| `contrast`, `citation` | filled at rest; heaviest glyphs on the sheet | outline + 50% half-tone; quote heads r 2.1 |
| `deep-field` | specks at 16px | points r ≥ 1.125, heavier corner brackets |
| `apps` | the tiles become circles ("88") | tiles 6.5 r 1.5, the same as `grid` |
| `pdf` | the label hangs off the page like a hook | label inset inside the page; S cut drops it |
| `review`, `rename`, `accessibility`, `pull-request`, `file-tree`, `versions`, `memory`, `zip` | mud at 16px | S cuts that drop inner detail; `memory` becomes a three-card stack (`rectangle.stack`) |
| `unpin`, `mic-off`, `bell-off`, `disconnect`, `eye-off`, `shield-off`, `image-off`, `offline` | the 1.5-unit knockout fragments the glyph | a corner-to-corner slash with a 1-unit gap, or the slash through the outline only |
| `collapse` vs `expand` | not a mirror pair | collapse diagonals 14.25, 9.75 → 19.5, 4.5 |
| `play` / `pause` | width jumps from 15.25 to 9; mass 0.157 → 0.115 | pause bars 3.5 units wide with r 1; `optical: 1.15` |
| `end-call` | 10 units tall, reads small | `optical: 1.15` |
| `at` | the counter closes | inner r 3.75 |
| `phone` / `tablet` | inverted radii | both r 2.25 |
| `link-off` | reads as `link` | slash across the gap |
| `image-plus` | opens its frame for the plus | `ko(plusAt)` like `connect` |
| `send` | thin (1.5px) on the black disc; `weight="bold"` is ignored | bold cut, 2.5 units (1.9px at 18) |
| `video` alias | the camera shadows `file-video` | rename the drawing `video-camera` |

### B.7 Icon buttons and hit targets

| Size | Box | Glyph | Shape | Where | Hit |
|---|---|---|---|---|---|
| xs | 24 | 14 (S) | r 6 | in-row kebab on hover, toast close, chip remove | ::before to 32 (fine) / 44 (coarse) |
| sm | 28 | 16 | r 8 | message action bar, sidebar header, panel headers | 32 / 44 |
| md | 32 | 16 | r 8 | page and canvas toolbars | 32 / 44 |
| lg | 36 | 20 | **circle** | composer `+`, mic and the disc; scroll-to-latest | 36 / 44 |
| close | 28 | 14 | circle, tonal (`--fill-hover` at rest) | every dialog, sheet and popover header; one plate everywhere | 32 / 44 |

Chrome icon buttons are rounded squares (Apple uses rounded rects for small and medium controls). Circles are
kept for the composer (concentric with its corner) and for floating round controls.

---

## C. Components

### C.1 Buttons

| Size | Height | Pad x | Radius | Text | Icon | Gap | Coarse |
|---|---|---|---|---|---|---|---|
| sm | 28 | 10 | 8 | 13/18 500 | 14 | 6 | 44 hit |
| **md (default)** | 32 | 12 | 8 | 13/18 500 | 16 | 6 | 44 hit |
| lg (dialog footers) | 36 | 14 | 8 | 14/20 500 | 16 | 8 | 44 |
| touch | 44 | 16 | 12 | 16/22 500 | 20 | 8 | — |

| Variant | Rest | Hover | Pressed | Notes |
|---|---|---|---|---|
| **Primary** | `--primary` fill, `--primary-foreground` text, no border, **no shadow** | `--primary-hover` (#2E3135 / #D2D4D8, new token), not `brightness()` | scale .97 + `--primary-hover` | one per surface |
| **Secondary (tonal)** | `--fill-selected` fill, `--foreground` text | `--fill-pressed` | scale .97 | Cancel in every dialog. Replaces both "secondary" and "outline", which looked identical (map-components #24). |
| **Ghost** | transparent, `--foreground` (chrome: `--muted-foreground`) | `--fill-hover` | `--fill-pressed` | toolbars, tertiary |
| **Destructive** | `--destructive` fill, white text | `--destructive` at −4% L | scale .97 | confirms only |
| **Link** | text `--foreground`, 1px underline at offset 3 on hover | — | — | inline |

Loading: the label goes to opacity 0, a 16px spinner fades in from scale .8 (120ms), the width is locked and
`aria-busy` is set. The button is not dimmed. Disabled: `opacity .5`.

### C.2 Icon buttons
See B.7. Ghost by default. `aria-pressed=true` takes `--fill-selected` and the glyph in `--foreground`. The tooltip is
the accessible name.

### C.3 Segmented control

- Track: 32 (md) or 28 (sm), radius 8, padding 2, fill `--fill-hover`. No border.
- Segments: `ui` 13/18 500, padding 0 12, minimum width 64, 14px icons with a 6px gap.
  Inactive segments are `--muted-foreground`; the active one is `--foreground`.
- Thumb: `--key`, radius 6, E1 key shadow. It moves on `--spring-standard` (272ms) with **no squash**.
  Labels cross-fade colour over 120ms (Tier A kept).
- Counts: 12px sans `tnum` muted.

### C.4 Switch, checkbox, radio

| Control | Size | Off | On | Motion |
|---|---|---|---|---|
| Switch | 36 × 20 track (coarse 44 × 26), radius full, padding 2, knob 16 | track `--switch-off` (#CBCDD1 / #46484D) + knob `#fff` with E1 key shadow | track `--primary`; knob white (light) or `--primary-foreground` (dark) | knob translateX 16 on `--spring-standard`; track colour 120 out-soft; on press the knob stretches 16 → 19 over 120 |
| Checkbox | 16, radius 4, 1px `--input`, fill `--card` | — | `--primary` fill, a 12px check with a 2px line in `--primary-foreground`; indeterminate is an 8 × 1.5 bar | fill 70 out-soft; the check draws (dashoffset) over 120 out-soft |
| Radio | 16 circle, 1px `--input` | — | `--primary` fill with a 6px `--primary-foreground` dot | fill 70; dot scales .5 → 1 on `--spring-snap` |

Hit targets: 24 (fine) or 44 (coarse). In a settings row the whole row is the hit area and the accessible name is the title.
**Rule request:** the switch's off track is decorative at 1.6:1 (Apple's is 1.2:1). The knob and track position
carry the state, and in high contrast the track becomes `--input` (3.5:1). See H.4.

### C.5 Inputs

| Part | Value |
|---|---|
| Field | height 36 (sm 32, coarse 44); radius 8; padding 0 12; fill `--field-surface` → **`--card`** (light) / #1F2023 (dark); 1px `--input`; text `nav` 14/20 (16 on coarse) |
| Hover | border `--foreground` at 0.5 alpha over `--input` |
| Focus (pointer) | border `--foreground`, no glow |
| Focus (keyboard) | plus the global 2px ring at offset 2 (one ring, replacing the field's private 1px ring) |
| Label / hint / error | label 13/18 500 with 6px below; hint 12/16 muted with 6px above; error is a 1px `--destructive` border plus a 12/16 `--destructive-ink` message after a 14px circle-x |
| Search field (toolbars, menus, sidebar) | **borderless**: `--fill-hover` fill, radius 8, height 32, a 16px glyph at x 10, text at x 34. On focus it becomes `--card` + 1px `--input`. A trailing `⌘K` keycap; a 16px clear button when filled. |
| Textarea | min-height 80, padding 8 12, resizes vertically, the same states |

### C.6 Chips, pills, badges

| Element | Spec |
|---|---|
| Filter chip | 28 tall, capsule, padding 0 12, 13/18 500. Off: 1px `--border` + `--muted-foreground`. Hover: `--fill-hover`. On: `--fill-selected`, no border, `--foreground`, a leading 14px check. |
| Armed-mode pill (composer) | 28, capsule, padding 0 10 0 8, gap 6, `--fill-selected`, 13/18 500 `--foreground`, a leading 14px glyph that swaps to ✕ on hover (IconSwap 0.8). The whole pill is the remove button: "Web search, remove"; 44 hit on touch. |
| Count badge | min 18 × 18, padding 0 5, capsule, 11/18 600 Inter `tnum` (the kbd rung in sans); neutral `--fill-selected` + `--foreground`, or `--signal` + white for "needs you" |
| Status badge | 22, capsule, padding 0 8, `--fill-hover` + 12/16 500 `--foreground` word + a coloured 6px dot or 12px glyph: Live = presence dot · Needs you = signal glyph · Failed = destructive circle-x |
| Keycap | 20 tall, min-width 20, padding 0 5, radius 6, `--fill-hover`, 11/16 mono 500 `--muted-foreground`. Inside tooltips it re-points to `--tooltip-foreground` at a 14% fill (fixes the 2.0:1 white keycap). |

### C.7 Tabs (level 2, underline)
- Height 36, gap 20, text 14/20 500. Inactive tabs are `--muted-foreground`; the active one is `--foreground`.
  Hover changes only the colour, with no fill.
- Indicator: 2px tall, radius 1, `--foreground`, as wide as the text, flush with a full-width 1px `--border`.
  It moves on `--spring-standard`.
- Panels cross-fade (out 70, in 120) with no height jump (the `Collapse` grid-rows).
- `CustomizeNav`'s boxed tabs are retired in favour of these.

### C.8 Tooltip

- Fill `--tooltip`; text 12/16 500 `--tooltip-foreground`; padding 4 8 (24 tall); radius 6; max width 240; offset 6.
- An optional shortcut sits after an 8px gap in #A9ACB2 `tnum`.
- Delay **500ms**, skip window **300ms** (this matches the governing spec §4.2; today's value is 200/400).
- No `title=` tooltips anywhere. `IconButton` stops writing `title`.

### C.9 Avatars
- Sizes 20, 24, 28, 32 and 40; circle.
- An inner 0.5px ring at ink 10% separates photos from the ground.
- Fallback: `--fill-selected` with initials in Inter 500 at 0.42 × size, in `--muted-foreground-on-fill`.
- Groups overlap by −4 with a 2px ring in the ground colour. No shadow.

### C.10 List rows

| Type | Height | Padding | Content |
|---|---|---|---|
| Single | 36 (coarse 44) | 0 8 | 16 icon · 8 · label 14/20 · trailing meta 12/16 muted `tnum` or a 14 chevron in `--muted-foreground` |
| Two-line | 52 | 8 12 | title 14/20 500 · subtitle 12/16 muted |
| Library entry | 56 | 8 | 40 tile r 8 + two-line |

Radius 8 (inset rows, never square full-bleed). Hover `--fill-hover`, selected `--fill-selected`, pressed
`--fill-pressed`. A row is bare until hover and carries one trailing signal (composition rule kept).

### C.11 Cards
- Radius 12, `--card` fill, 1px `--border`, padding 16, E0.
- Header: title 14/20 600 + meta 12 muted.
- Interactive cards: hover darkens the border to ink 18%; pressed takes a `--fill-hover` overlay. No lift, no shadow.
- Artifact card: a 36 tile (r 8, `--fill-hover`, 18 glyph) · title 14/20 500 · meta 12 · trailing chevron.
- Chat approval and task cards move from `field` 10 to `card` 12 and gain the 1px border (one card material).

### C.12 Sidebar rows (web; native mirrors these)

| Part | Value |
|---|---|
| Column | 260 (`--shell-sidebar`), `--sidebar` ground, rows inset 8 |
| Header | 44: Alevr lockup (14/20 600) · bell sm 28 · collapse sm 28 |
| Product switch | segmented md 32, full width, Chat · Code with 14 icons |
| Row | 32 (coarse 44), padding 0 8 → **icon at x 16**, 16 glyph `--icon-muted`, 8 gap → **label at x 40**, 14/20 400 |
| States | hover `--sidebar-hover`, selected `--sidebar-selected` (fill only, same weight), pressed `--fill-pressed` |
| Trailing slot | one of: a 6px presence dot (live), a signal dot (needs you), a filled pin at 12 (pinned), or the xs 24 kebab (on hover or focus, replacing the signal) |
| Section label | 28 tall, 12/16 500 sans `--muted-foreground` at x 16; the fold chevron appears on hover |
| Account row | 48: avatar 28 · name 14/20 500 + plan 12/16 muted · a 14 chevron-up-down |

### C.13 Skeletons, spinners, progress
- **Skeleton.** Lines 12 tall, r 6, widths 92/76/54%, gap 10 (an exception for text measure). Blocks r 12. Fill `--fill-hover`.
  It breathes opacity 1 → .55 over `--loop-breathe` (1.8s) on `--ease-breathe`. It shows only after `--delay-show`
  (200ms), stays at least `--hold-skeleton` (400ms) and cross-fades to content over 160ms.
- **Spinner.** Only inside the pressed control. 16 (or 20); a 1.5px ring with a track at `currentColor/.2` and a 90° arc;
  it turns over **`--loop-spin` 800ms** (new) linear. Reduced motion: the arc pulses opacity instead.
- **Progress.** Linear: 4 tall, r 2, track `--fill-selected`, fill `--foreground`, `transform: scaleX()` over 360 out-soft.
  Indeterminate: a 30% segment sweeps over 1.4s in-out. Upload ring: 20 with a 2px line and the track at 15%.

---

## D. Menus

### D.1 The one shell

| Property | Value |
|---|---|
| Fill / edge / shadow | `--popover` · 1px `--hairline` (0.5px at 2×) · `--shadow-float` (E2) |
| Radius / inset | **12 / 4**, so rows are 8 (concentric) |
| Widths | **240** (`w-60`, default) · **288** (`w-72`, the composer `+` and anything with shortcuts) · **320** (`w-80`, pickers with descriptions). Selects match the trigger width (min 180). |
| Max height | `min(var(--radix-…-available-height) − 8px, 480px)`; the list scrolls inside the inset |
| Offset | `sideOffset 6`, `collisionPadding 8`; composer menus `sideOffset 8` and open upward |
| Z | `z-popper` (55) |
| Scroll edge | a 12px mask fade, shown only in a direction where content is hidden; no gradients painted over rows |
| Origin | `--radix-dropdown-menu-content-transform-origin` (trigger side + align) |

### D.2 Row anatomy (columns, left to right)

```
| 4 | 8 | [16 icon] | 8 | label 14/20 (+ desc 12/16) ......... | ≥16 | [trailing slot] | 8 | 4 |
```

- **Label x** is 36 from the container edge with icons and 12 without. Every row in a group shares it.
- **Icons are all-or-none per group.** User-made names (projects, skills) carry none.
- **Trailing slot (exactly one):** shortcut (12/16 Inter `tnum`, muted, `⌃⌥⇧⌘` order, no spaces: `⇧⌘U`) ·
  chevron-right 14 muted (submenu) · **check 16 `--foreground` (selected)** · value 13/18 muted + chevron (a submenu
  that holds a value, such as "High ›") · count 12 muted `tnum`.
- **Heights:** 32 single · 48 two-line (6 + 20 + 16 + 6) · coarse 44 / 56.
- **Section label:** 12/16 500 muted at x 12, padding 8 8 4 (the first group uses 4 8 4).
- **Separator:** 1px `--hairline`, margin 4 8, aligned with the row content edge (Apple's inset separator).
- **Search row:** 36 tall; a 16 glyph at x 12; borderless 14/20 input; a full-bleed hairline below (the one full-bleed rule).

### D.3 Row states

| State | Treatment |
|---|---|
| Rest | transparent; label `--foreground`; glyph `--icon-muted`; trailing `--muted-foreground` |
| Highlight (pointer) | `--fill-selected`, appearing in 0ms and fading out over 120ms. The glyph turns `--foreground`; a description uses `--muted-foreground-on-fill`. |
| Highlight (keyboard) | the same, plus an inset 1.5px ring at `--ring`/.55 |
| Open submenu trigger | keeps the highlight while the submenu is open |
| Pressed / select | `--fill-pressed` for 70ms, then the menu exits |
| Checked | trailing check; label unchanged (no accent, no weight change) |
| Disabled | opacity .5; no highlight on hover; focusable from the keyboard; the reason shows as a description line ("Needs Pro") |
| Destructive | `--destructive-ink` label and glyph. Highlight fill is `--destructive` at 10% (dark 16%). Always in the last group after a separator; ends with "…" when it opens a confirm. |

### D.4 Submenus

- **Trigger.** A row with a trailing chevron. **The trigger never runs a command.**
- **Opening.** On hover it opens after `--delay-submenu` 100ms of intent. Click, → and Enter open it at once
  and move focus to its first row.
- **Placement.**
  - It opens to the right. If `trigger.right + width + 8 > viewport` it flips left, and the travel and origin flip with it.
  - **Visible gap 4px:** `sideOffset = 4 + 4 inset + 1 border = 9` from the trigger row.
  - **First row aligned with the trigger row:** `alignOffset = −5` (inset 4 + border 1).
  - The parent menu stays open.
- **Safe triangle.**
  - On pointer-leave, a polygon runs from the pointer (5px bleed toward the submenu) to the submenu's near-top and near-bottom corners.
  - It is valid for `--grace-submenu` 300ms while the pointer moves inside it.
  - When the pointer leaves the polygon or the time runs out, the submenu closes and the row under the pointer takes the highlight.
- **Depth and size.** One level only, at most 8 rows; beyond that the submenu gains a search row.
- **Closing.** ← or Esc closes it and returns focus to the trigger.
- **Phone and coarse pointers.** The submenu drills in place. The parent slides 24px left and fades
  (120 ease-in) while the submenu enters from +24px (`--spring-snap`, opacity 120 after a 40ms delay). A "‹ Project" back row comes first.

### D.5 Menu types

| Type | Width | Trigger and placement | Contents (groups) | Notes |
|---|---|---|---|---|
| **Dropdown** (kebab or header) | 240 | `bottom/end`, offset 6 | per surface | trigger: icon button sm 28, which takes `--fill-selected` while open |
| **Context menu** | 240 | at the pointer (+2, +2); flips at edges; right-click, Shift+F10, Menu key, or a 500ms long press | the kebab's items in the same order | **no shortcuts shown** (HIG). Disabled items are hidden, except Cut/Copy/Paste. |
| **Sidebar row menu** | 240 | kebab `bottom/start`; context menu at the pointer | Share… · Rename · Pin · Add to project › ‖ Archive ‖ Delete… | the Add to project submenu: No project ✓ · user projects (no icons) · ‖ New project… |
| **Select** | trigger width (min 180) | `bottom/start`, offset 4; the selected row is highlighted and scrolled into view; typeahead | options, one line each | trigger: a field (36, r 8) with a trailing chevron-up-down 16 that never rotates |
| **Combobox** | trigger width (max 320) | the input keeps focus; the list opens on typing or ↓ | filtered options; the first match highlighted; "No results" row | Esc clears, then closes |
| **Model picker** | 320 | the composer model chip, `top/end`, offset 8 | Models: Auto ✓ · Opus 5.5 · Sonnet 5 · GPT-5.5 (two-line: name 14/20 500 + one-line description 12/16) ‖ Thinking › "High" ‖ More models › (with a search row) | **one model picker everywhere** (composer, regenerate, settings, compare); Effort is a radio group in the Thinking submenu |
| **Composer `+`** | 288 | `top/start`, offset 8; never covers the composer | Add photos & files `⌘U` · Take a screenshot · Add from Library ‖ Web search ✓ · Deep research · Memory ✓ ‖ Project › · Apps › · Ask first › "Always" | check rows toggle and keep the menu open; each armed mode becomes a pill. The Project / Apps / Skills tray is retired into this menu (shell contract change, H.4). |
| **Message action** (⋯ on the answer bar) | 240 | `bottom/end` or a flip | Copy as Markdown · Read aloud · Branch in new chat ‖ Export › (PDF · Markdown · Word document) ‖ Report a problem… | the regenerate split button gets its own menu: Try again · Switch model › (the model picker rows) |
| **Command palette** | 600 (max 100vw − 32) | modal at top 14vh; radius 16; E3 | a 52px search band (20 glyph, 16/24 input) · list padding 8 · rows 36 (14/20, 16 glyph, trailing shortcut) · group labels as D.2 | no footer; ↑↓ wrap; Home/End; opened by ⌘K it appears at frame 0 |
| **Slash menu** | 360 | anchored to the composer text column, bottom = composer top − 8 | Commands · Skills · Tools: `/command` 14/20 500 + description 13/18 muted on one line | filters as you type; Tab/Enter applies; appears at frame 0 (typed) |

**Keyboard (all menus):** ↑/↓ wrap, Home/End, typeahead (1s buffer), Enter/Space activate, →/← for submenus, Esc closes one
level, and Tab closes the menu and moves on. Focus returns to the opener.

---

## E. Pop-ups

### E.1 Dialogs

| Part | Value |
|---|---|
| Widths | **confirm 400 · form 520 · workspace 880** · full screen (map all 21 `sm` and 26 `md` uses onto 400 and 520) |
| Shell | radius 16; `--surface-modal`; hairline; E3; scrim `--scrim`; `max-height: calc(100dvh − 48px)`; a three-row grid `auto / minmax(0,1fr) / auto` (**pinned header and footer**) |
| Header | padding 20 20 8 24; title `heading` 18/24 600; description 14/20 muted, margin-top 4; right gutter 40 so a title never runs under the ✕ |
| Close | 28 tonal circle, top 18, right 18, so its centre sits on the title line (y 32). Tooltip "Close" + `Esc`. |
| Body | padding 8 24; the only scroller; a hairline appears at the top or bottom edge only while content is hidden there |
| Footer | padding 16 24 24; gap 8; end-aligned: [tertiary link at the start] … [Cancel **secondary tonal** lg 36] [Primary lg 36] |
| Phone (<640) | becomes a bottom sheet (E.3); footer buttons stack full width at 44 (r 12), primary on top |
| Focus | forms: the first field; confirms: Cancel. Return = the default button; Esc = Cancel. |

**Destructive confirm.** 400 wide, **no ✕** (an alert offers Cancel and Esc), title "Delete chat?", body
"“Q3 forecast against Stripe revenue” and its 24 messages will be deleted. This can't be undone."
Footer: Cancel (secondary) and **Delete** (destructive), with focus on Cancel and ⌘⌫ firing Delete.
An optional "Don't ask again" checkbox sits at the start of the footer. On success a toast reads "Chat deleted · Undo".

### E.2 Popovers and hover cards
- Radius 12, E2, padding 12 for content or 4 for lists, width 320 (max 360). No arrow.
- Hover cards (citations, sources, agents): open after `--delay-hovercard` 300ms of intent and close
  `--grace-hovercard` 150ms after leaving.
- From the keyboard: focus the trigger and press Enter or ↓ to open it and move focus inside.
- One implementation (Popover). The `.cite-card` tooltip hack is retired.
- Phone: a content popover becomes a bottom sheet at the medium detent.

### E.3 Sheets
- **Bottom sheet (phone).**
  - Top radius 16; `--surface-modal`; E3.
  - Grabber 36 × 5, r 2.5, `--grabber`, at top 6, with a 44 × 24 hit area.
  - Header 52: title 16/24 600 centred; one close circle (30, tonal) trailing. Cancel, Done and Back never appear together.
  - Detents: **medium 50% (min 320) and large 92%**.
  - Content padding 16; rows 48 at 16/22 with 20 glyphs.
  - Drag from anywhere once the content is scrolled to the top. Dismiss past 30% of the height or at 0.5px/ms;
    otherwise snap to the nearest detent by projected position (y + v·200ms).
  - Keyboard: the sheet's bottom follows `visualViewport`.
- **Side sheet (desktop).** Width 400 or 480; floating inset 8; radius 16; E3. Modal with a scrim, or non-modal without one.
  The header matches the dialog header.
- **One engine.** `BottomSheet`, `sheet.css` and the code-v2 sheet merge into `SheetContent`.

### E.4 Toasts
- **Placement.** Bottom centre, 16px above the composer (`--composer-h` is published by the shell), or 24px from the
  bottom elsewhere. Width 360 (max 100vw − 32), min-height 48.
- **Card.** Radius 12, `--popover`, hairline, E2, padding 12 12 12 14.
- **Anatomy.** A 16 status glyph (success-ink check, destructive-ink circle-x, muted info) · text 14/20 with an optional
  13/18 muted second line · an action (ghost sm 28, "Undo") · a close (xs 24, shown on hover or focus).
- **Timing.** `--hold-toast` 4000ms; `--hold-toast-action` 6000ms when there is an action; paused on hover, focus or window blur.
- **Stack.** At most 3 visible. The newest sits in front; behind it, toasts sit at translateY −8 / −16 and scale .96 / .92.
  The 4th fades out. Hover or focus expands the stack into a list with an 8px gap.
- **Dismissal.** Swipe right or down; dismiss past 45% of the width or at 0.5px/ms.
- **Plumbing.** `z-toast` (70) is actually applied to the toaster. `aria-live=polite`; Alt+T focuses the region.
- **The memory notice** becomes a toast variant with a 32 tile, using the same values, with no top-centre placement.

### E.5 Banners, inline alerts, empty states
- **Banner** (in-flow, at the top of the content column):
  - 40 tall, radius 12, fill: the status colour at 8% (offline uses `--attention`).
  - A 16 glyph in the status ink, text 13/18 `--foreground`, a trailing 13/18 500 link, and an xs ✕.
- **Inline alert:**
  - Radius 12, 1px `--border`, `--card`, padding 12 14.
  - A 16 glyph top-aligned with a 14/20 500 title, a body 13/18 muted, and actions (sm buttons) 8 below.
- **Empty state:**
  - A centred column, max 360.
  - A 24 glyph in a 48 `--fill-hover` circle (or the dot-matrix mark at page level).
  - Title in Newsreader 22/28 400; body 14/20 muted, margin-top 6.
  - Actions margin-top 16: primary md + ghost.

---

## F. Composer

### F.1 Geometry (one composer for landing, dock and phone)

```
┌──────────────────────────────────────────────────────── r26 ─┐
│ ↕16                                                           │
│ ←20→ How can I help?  (16/24 reading)                    ←20→ │
│ ↕4                                                            │
│ ↕4  ( + )  [pill][pill]            [Auto ⌄] (mic) (●)        │  row 36, padding 4 8 8 8, gap 4
│ ↕8  ↑ corner circles 36 at inset 8 → concentric (26−8=18)     │
└───────────────────────────────────────────────────────────────┘
rest height = 1 + 16 + 24 + 4 + 4 + 36 + 8 + 1 = 94
```

| Part | Value |
|---|---|
| Shell | radius 26; `--card`; 1px `--hairline` (hover ink .14, focus ink .18; dark white .09/.12/.16); `--shadow-composer` → `--shadow-composer-focus`. Border and shadow both change over 120 out-soft, replacing today's 120 edge / 360 shadow split. |
| Width | dock = the transcript column (704 at 48rem minus gutters). **Landing = the same 704** at every breakpoint and transcript setting, which removes the 660 → 704 jump. |
| Field | padding 16 20 4; text 16/24; placeholder `--muted-foreground` ("How can I help?" on the landing, "Ask a follow-up" in the dock; Claude's exact phrase is retired). Grows from 1 to 8 lines (24 → 192), then scrolls inside with a 12px mask. |
| Text alignment | the `+` glyph (20px, a plus 15 units wide → 12.5px of ink) is centred at x 26 (= R), so its ink starts at x 19.75: **aligned with the text column at 20** (−0.25px). |
| Above region | padding 12 12 0; holds attachments, the quote card (r 14, `--fill-hover`), and the long-paste hint |
| Controls row | padding 4 8 8; height 36. **Leading:** `+` (lg circle, ghost, plus 20 bold cut) then armed pills (28, gap 6, margin-left 4). **Trailing (gap 4):** model chip · mic · disc. |
| Model chip | 32 tall, capsule, padding 0 8 0 12, 13/18 500 `--muted-foreground` → `--foreground` on hover or open; chevron-down 14 in `--muted-foreground` (the same ink as the label; deletes the 16px full-ink chevron override); text only ("Auto", "Opus 5.5 · High"); truncates at 200px |
| Mic | lg circle, ghost, mic 20; `aria-pressed` while dictating |
| Disc | 36 circle, `--primary`, glyph in `--primary-foreground`. **Faces:** voice (empty draft) waveform 18 bold · send (content) arrow-up 18 bold (1.9px) · stop (streaming) square 12 r 2.5 filled · busy (preflight) spinner 16 · blocked (upload, quota) `--secondary` disc + a muted arrow + a tooltip naming the blocker. The fill never changes between voice, send and stop; only the glyph does. |
| Task-mode chip | **moved into `+` → "Ask first ›"** (it frees the crowded right cluster: map-composer #20) |
| Tray (Project · Apps · Skills · Mac app) | **retired into `+`**; a chosen project shows as an armed pill "Renewals 2026 ✕" |
| Dimming while streaming | none. The field and every control stay live; only the disc swaps to stop. Disabled controls alone take opacity .5. |
| Footnote (dock) | 12/16 muted, centred, 8 below the shell |
| Landing | greeting Newsreader 48/56 −0.03em, centred, 28px above the shell; the shell's centre at 42% of the viewport height; no tray, no starters (owner rule 3 asks to confirm "none below") |

### F.2 Attachments

| State | Spec |
|---|---|
| Image tile | 56 × 56, radius **14**, `object-fit: cover`, an inner 1px ink/.08 ring |
| File chip | 56 tall, up to 220 wide, radius 14, `--fill-hover`; a 20 file glyph in a 40 column · name 13/18 500 (one line, ellipsis) · meta 12/16 muted ("PDF · 1.2 MB") |
| Uploading | content at full ink under a `--card` 60% veil (the veil sits over the image, not over text); a 20 progress ring (2px, track 15%) centred; meta "Uploading · 42%" |
| Error | an inset 1px `--destructive` edge; a 16 circle-x in `--destructive-ink` replaces the file glyph; meta "Couldn't upload" + a **Retry** text button (12/16 600) |
| Remove ✕ | a 20 circle at the tile's top-right corner, offset (−6, −6) outside the edge; `--foreground` fill, a 10 ✕ (2px) in `--background`, a 2px ring in `--card` (the cut-out); fine pointer: on hover or focus-within (opacity 120); coarse: always, with a 44 hit |
| Row | gap 8; wraps; height animates through `grid-rows` (the composer-height exception) |

### F.3 States
- **Focus:** see the shell. The keyboard ring is the global 2px ring at offset 2 on the shell. Its `::after` follows
  the shell's radius and `corner-shape` (fixes the hard-coded 26px).
- **Drag-drop:**
  - Window level: dropping anywhere in the chat window attaches.
  - While dragging, the shell edge becomes **1.5px dashed `--foreground` at 45%**.
  - The field area shows "Drop files to attach" (14/20 500) with a 20 attach glyph, and the page takes a `--fill-hover` wash.
  - One edge change only: no ring, no inner dashed box, and the lift shadow is kept.
- **Slash and skills:** see D.5. Choosing a skill makes an armed pill ("Summarise ✕") and clears the slash text.
- **Streaming:** the disc shows stop; Esc stops; Enter queues the next message (the field stays live).
- **Private:** the shell edge is 1px dashed at `--input` (the squircle dash issue is solved by using `border-radius` with no `corner-shape` in private mode).

### F.4 Mobile (390px)

| Part | Value |
|---|---|
| Placement | margin 0 8; bottom 8 + safe area; width 374 |
| Shell | radius 26 (native iOS: concentric bottom corners, see I.4) |
| Field | padding 14 16 4; 16/24 (no zoom) |
| Row | `+` 36 (44 hit) · model chip 32 (44 hit) · mic 36 (44) · disc 36 (44), gap 4; rest height 92 |
| `+` | opens a **bottom sheet** (E.3) at the medium detent, not a dropdown |
| `+` sheet | grabber · title "Add" · a tile row of three (Camera · Photos · Files: 72 tall, r 12, `--fill-hover`, 24 glyph + 13/18 500 label) · rows 48: Web search (switch), Memory (switch), Deep research (check), Project › "None", Apps ›, Ask first › "Always" |
| Model chip | opens the model picker as a sheet (medium detent, two-line rows 56) |

---

## G. Motion

### G.1 The vocabulary (mapped onto the existing ladder; no new duration rungs)

| Name | Token | Value | Use |
|---|---|---|---|
| Fade in | `--dur-fast` + `--ease-out-soft` | 120ms, (.33, 1, .68, 1) | every entrance's opacity |
| Fade out (small layers) | `--dur-fast` + `--ease-in` | 120ms, (.4, 0, 1, 1) | menus, popovers, toasts' siblings |
| Fade out (modal) | `--dur-exit` + `--ease-in` | 160ms | dialogs, the toast leaving, scrims |
| Instant out | `--dur-press` + `--ease-in` | 70ms | tooltips, submenus, keyboard-opened layers |
| Pop (transform) | `--spring-snap` over `--spring-snap-dur` | visual 0.18s, bounce 0, settles 256ms | menus, submenus, popovers, tooltips, check marks, the composer disc release |
| Settle | `--spring-standard` over `--spring-standard-dur` | 0.22s, bounce 0.05, 272ms | dialogs, thumbs, the switch knob, toasts, layout of chips |
| Travel | `--spring-layout` over `--spring-layout-dur` | 0.36s, bounce 0, 511ms | sheets presenting, panel travel |
| Handoff | `--spring-emphasized` | 0.36s, bounce 0.10, 377ms | **only** the landing → dock composer move |
| Press | `--dur-press` + out-soft | 70ms, scale .97 | small controls; release on `--spring-snap` |
| Hover | 0ms in / `--dur-fast` out-soft | — | every fill |

**Rules.**
- Entrances decelerate; exits accelerate, take 120–160ms and **do not travel** (scale to .98 only).
- **Origin-aware.** Floating layers scale from `transform-origin` = the trigger edge and align, and travel 4px from the
  trigger direction (`--pop-shift`, already Tier B).
- **Frame 0 for the keyboard.** Menus, selects and the palette opened from the keyboard have no entrance (their exit is 70ms).
- **No blur, no `backdrop-filter`, no overshoot on chrome.** Springs keep bounce ≤ 0.10 (`reward` and `articulate`
  retire to icon micro-moments only).
- **Interruption.** Every transition retargets from the current presentation value. CSS transitions do this natively;
  WAAPI and framer read the computed value and keep velocity. Reopening during an exit reverses from where it is,
  without restarting. Hover fills never queue.
- **Stagger** at most 4 items, 30ms (`--stagger-row`), and never when opened from the keyboard. Menus never stagger.

### G.2 Reduced motion

| Tier | Keeps | Drops |
|---|---|---|
| A (always kept) | opacity, colour and fill transitions at the same durations | — |
| B (travel) | — | `--motion-shift: 0`; `--motion-scale-from: 1`; springs flatten to `--ease-out-soft` at `--dur-base`; sheets and panels fade instead of travelling (opacity 220 in / 160 out) |
| C (loops) | — | spinners pulse opacity; skeletons hold at .8; the galaxy is still |

Under Reduced, direct manipulation (dragging a sheet or swiping a toast) still tracks the finger 1:1; the release is a fade.
Read the preference only through `@/lib/motion-preference`.

### G.3 Storyboard (every step)

Columns: **Property from → to · Duration (token) · Curve · Delay/stagger · Origin · Interrupt · Reduced · SwiftUI**.
"snap / std / layout" are the generated springs; "fast / exit / press / base" are `--dur-*`.

| # | Interaction · step | Property from → to | Duration | Curve | Delay | Origin | Interrupt | Reduced | SwiftUI |
|---|---|---|---|---|---|---|---|---|---|
| **M** | **Menu open (pointer)** | | | | | | | | |
| M1 | trigger takes the open state | bg → `--fill-selected` | 0 | — | 0 | — | — | same | system `Menu` |
| M2 | shell fades in | opacity 0 → 1 | fast 120 | out-soft | 0 | — | reverses from current | same | system |
| M3 | shell grows from the trigger | scale .97 → 1; translateY ∓4 → 0 (toward the trigger) | snap 256 | `--spring-snap` | 0 | trigger edge + align | retarget, keep velocity | none | system |
| M4 | rows | no stagger, no content fade | — | — | — | — | — | — | — |
| M5 | **keyboard open** | appears complete; first row highlighted | 0 | — | 0 | — | — | same | system |
| **H** | **Row highlight** | | | | | | | | |
| H1 | pointer enters a row | bg → `--fill-selected`; glyph → `--foreground` | 0 | — | 0 | — | immediate | same | system |
| H2 | pointer leaves | bg → transparent | fast 120 | out-soft | 0 | — | the next row lights at once (no two-row smear: in = 0) | same | system |
| **S** | **Select an item** | | | | | | | | |
| S1 | row press | bg → `--fill-pressed` | press 70 | out-soft | 0 | — | — | same | system |
| S2 | hold | — | 70 | — | — | — | — | 0 | — |
| S3 | shell exits | opacity 1 → 0; scale 1 → .98 | fast 120 | ease-in | after S2 | as M3 | a reopen reverses | opacity only | system |
| S4 | trigger open fill clears | bg → rest | fast 120 | out-soft | with S3 | — | — | same | — |
| S5 | check toggled (menu stays) | check opacity 0 → 1, scale .8 → 1 / off: opacity → 0 | 120 + snap / 70 | out-soft + snap / ease-in | 0 | check centre | retarget | opacity only | `Toggle` in `Menu` |
| **U** | **Submenu** | | | | | | | | |
| U1 | intent | hover on the trigger for `--delay-submenu` | 100 | — | — | — | leaving cancels | same | system |
| U2 | sub fades in | opacity 0 → 1 | fast 120 | out-soft | 0 | — | reverse | same | system |
| U3 | sub slides from its side | translateX ∓4 → 0; scale .98 → 1 | snap 256 | spring | 0 | near top corner (left-top when opening right) | retarget | none | system |
| U4 | diagonal travel | safe polygon kept alive | ≤ `--grace-submenu` 300 | — | — | — | leaving the polygon closes at once | same | system |
| U5 | sub closes | opacity → 0 | press 70 | ease-in | 0 | — | — | same | system |
| U6 | flip | sign of U3 travel and origin flip | — | — | — | right edge | — | — | system |
| U7 | phone drill-in | parent opacity → 0, x 0 → −24; sub x 24 → 0, opacity 0 → 1 | 120 ease-in / snap 256 + fast | ease-in / spring | sub +40 | — | back reverses | fade only | `NavigationStack` inside the sheet |
| **D** | **Dialog** | | | | | | | | |
| D1 | scrim in | opacity 0 → 1 | fast 120 | out-soft | 0 | — | reverse | same | `.sheet`/`.alert` dimming |
| D2 | panel fades in | opacity 0 → 1 | fast 120 | out-soft | 0 | centre | reverse | same | system |
| D3 | panel settles | scale .96 → 1; translateY 8 → 0 | std 272 | `--spring-standard` | 0 | centre | retarget | none | system |
| D4 | focus moves in | — | — | — | after D2 | — | — | — | `.defaultFocus` |
| D5 | panel exits | opacity → 0; scale → .98 (no travel) | fast 120 | ease-in | 0 | centre | a reopen reverses | opacity | system |
| D6 | scrim out (trails) | opacity → 0 | exit 160 | ease-in | 40 | — | — | same | system |
| D7 | destructive confirm busy | the label fades, a spinner fades in from .8 | fast 120 | out-soft | shown only after 200 | — | — | same | `ProgressView` in the button |
| **B** | **Bottom sheet** | | | | | | | | |
| B1 | scrim in | opacity 0 → 1 | base 220 | out-soft | 0 | — | tracks drag | same | system dimming |
| B2 | sheet rises | translateY 100% → detent | layout 511 | `--spring-layout` | 0 | bottom | retarget with velocity | opacity 220 | `.sheet` + `presentationDetents` |
| B3 | drag | translateY = dy (1:1); upward overscroll dy × 0.2 (max 24); scrim = 1 − progress | live | — | — | — | — | same (direct) | system |
| B4 | release → snap | y → nearest detent by projection y + v·200 | snap 256 (carries v) | spring | 0 | — | — | fade to rest | system |
| B5 | release → dismiss | y → 100% (past 30% or v > .5 px/ms) | layout 511 (carries v) | spring | 0 | — | — | opacity 160 | system |
| B6 | dismiss from button or scrim | y → 100%; scrim → 0 | base 220 | ease-in | 0 | — | — | opacity 160 | system |
| **T** | **Toast** | | | | | | | | |
| T1 | enters | opacity 0 → 1; translateY 16 → 0 | fast 120 / std 272 | out-soft / spring | 0 | bottom centre | — | opacity | `JunoToastHost`, `.transition(.move+.opacity)` |
| T2 | the stack re-deals | each older toast translateY −8·i, scale 1 − .04·i | std 272 | spring | 0 | bottom centre | retarget | instant | `.animation(.junoStandard)` |
| T3 | the 4th fades | opacity → 0 | fast 120 | ease-in | 0 | — | — | same | — |
| T4 | hover expands | translateY → −(h + 8)·i; scale 1 | std 272 | spring | 0 | — | collapse on leave after 120 | instant | — |
| T5 | leaves (timeout or ✕) | opacity → 0; translateY 0 → 6 | exit 160 | ease-in | after `--hold-toast` | — | hover pauses the timer | opacity | — |
| T6 | swipe | x follows the pointer; release → x ±120% + opacity 0 (exit 160) or back (snap) | live / 160 / 256 | ease-in / spring | — | — | — | fade | `DragGesture` |
| **P** | **Tooltip** | | | | | | | | |
| P1 | intent | `--delay-tooltip` 500; `--delay-tooltip-skip` 300 → instant | 500 | — | — | — | leaving cancels | same | `.help()` (system) |
| P2 | in | opacity 0 → 1; translateY 2 → 0; scale .98 → 1 | fast 120 / snap 256 | out-soft / spring | 0 | the side facing the trigger | — | opacity | system |
| P3 | out | opacity → 0 | press 70 | ease-in | 0 | — | — | same | system |
| P4 | peer within the skip window | the old one cuts; the new one fades 0 → 1 | 70 | out-soft | 0 | — | — | same | system |
| **C** | **Composer** | | | | | | | | |
| C1 | focus | border ink .10 → .18; shadow composer → composer-focus | fast 120 | out-soft | 0 | — | — | same | `@FocusState` + `.animation(.easeOut(0.12))` |
| C2 | grow and shrink | height to the line count (24/line) | fast 120 | out-soft | 0 | top edge (the dock grows upward) | retarget per keystroke | instant | `TextField(axis:.vertical)` + `.lineLimit(1...8)` |
| C3 | an armed pill appears | opacity 0 → 1; scale .9 → 1; following items FLIP | 120 / snap 256 | out-soft / spring | 0 | left centre | — | opacity | `.transition(.scale(0.9).combined(with:.opacity))` |
| C4 | disc press | scale 1 → .97 → 1 | press 70 / release snap | out-soft / spring | 0 | centre | — | none | `JunoPressButtonStyle` |
| C5 | **send → stop**: the old glyph | opacity 1 → 0; scale 1 → .8 | press 70 | ease-in | 0 | centre | — | opacity | `.contentTransition(.symbolEffect(.replace.offUp))` |
| C6 | send → stop: the new glyph | opacity 0 → 1; scale .8 → 1 | fast 120 | out-soft | 70 (sequential: no two glyphs at once) | centre | stop → send reverses the same way | opacity | same |
| C7 | disc fill | constant `--primary` (voice, send, stop); → `--secondary` when blocked | fast 120 | out-soft | 0 | — | — | same | `.tint` |
| C8 | the field clears on send | text cut; height → 1 line | 0 / fast 120 | — / out-soft | 0 | — | — | instant | — |
| C9 | the user bubble appears | opacity 0 → 1 (120); translateY 8 → 0 (220) | fast / base | out-soft | painted in the send frame (≤100ms) | bottom right | — | opacity | `.transition(.opacity.combined(with:.offset(y:8)))` |
| C10 | attachment added | above-row grid-rows 0fr → 1fr; tile opacity 0 → 1, scale .92 → 1 | std 272; fast + snap | spring; out-soft | tile +40; several: 30ms stagger, max 4 | tile centre | — | opacity, rows instant | `.transition(.scale(0.92).combined(with:.opacity))` in `withAnimation(.junoStandard)` |
| C11 | upload progress | ring dashoffset per update | fast 120 | linear | — | — | retarget | same | `ProgressView(value:)` |
| C12 | attachment removed | tile opacity → 0, scale → .92; siblings FLIP; the last one collapses the row | fast 120 ease-in; std 272 | ease-in; spring | the row after 120 | tile centre | — | opacity | same |
| C13 | `+` opens | the button takes the open fill (**no 45° rotation**: nothing in chrome moves except a fill) | 0 | — | — | — | — | — | — |
| C14 | drag over | the edge becomes dashed; the label fades in | fast 120 | out-soft | 0 | — | leave 120 ease-in | same | `.dropDestination(isTargeted:)` |
| C15 | landing → dock | greeting opacity → 0, y −4 (exit 160 ease-in); **the same mounted composer** FLIPs y | exit 160; emphasized 377 | ease-in; `--spring-emphasized` | composer starts at 0 | — | — | cross-fade 160 | `matchedGeometryEffect` / one view |
| **R** | **Messages** | | | | | | | | |
| R1 | "Thinking" status | opacity 0 → 1 | fast 120 | out-soft | after `--delay-show` 200, held ≥ `--hold-phase` 600 | — | — | same | — |
| R2 | streaming text | per-frame reveal, 5-band ink fade about 280ms | — | — | — | — | — | the bands become one 120 fade | `JunoPacedStream` |
| R3 | a new block (code, table, image) | opacity 0 → 1 (**no travel**) | fast 120 | out-soft | 0 | — | — | same | `.transition(.opacity)` |
| R4 | stream end | the tail drains ≤ `--stream-tail-max` 250; the action row fades in | fast 120 | out-soft | `--delay-action-row` 180 | — | — | same | — |
| R5 | jump to latest | button opacity + y 8 → 0 (in) / opacity (out 120); scroll smooth when < 1 viewport, else instant | fast + snap; base 220 | out-soft / spring | — | bottom centre | — | opacity | `.scrollPosition` + `withAnimation(.smooth(0.22))` |
| **N** | **Page and panel** | | | | | | | | |
| N1 | sidebar selection | fill moves instantly (no gliding pill) | 0 | — | — | — | — | — | `List(selection:)` |
| N2 | route content | old opacity → 0 (70); new opacity 0 → 1 (120), **no travel** | press / fast | ease-in / out-soft | new +70 | — | the latest wins | same | `NavigationStack` (system) |
| N3 | right panel opens | panel x 24 → 0 + opacity; the split column resizes | base 220 out-strong + fast; base 220 in-out | — | 0 | right edge | retarget | opacity, instant size | `.inspector` (Mac), `.sheet` (iPhone) |
| N4 | right panel closes | x → 16 + opacity → 0; the split settles | exit 160 | ease-in | 0 | — | — | opacity | system |
| N5 | sidebar collapse | width 260 → 52 (named case) + labels opacity → 0 (70) | base 220 | in-out | labels first | left | — | instant | `NavigationSplitView` (system) |
| N6 | tab switch | indicator x and width; the panel cross-fades | std 272; 70 / 120 | spring; ease-in / out-soft | — | — | retarget | instant indicator | `Picker(.segmented)` system |
| **Q** | **Hover and press micro** | | | | | | | | |
| Q1 | hover fill | in 0 / out 120 | fast | out-soft | — | — | never queues | same | `.onHover` → `JunoHoverFill` |
| Q2 | press, small control | scale .97 | press 70; release snap 256 | out-soft; spring | — | centre | — | colour only | `JunoPressButtonStyle` |
| Q3 | press, row or wide control | bg → `--fill-pressed` | 0 | — | — | — | — | same | `.buttonStyle(.junoRow)` |
| Q4 | switch | knob x 0 → 16 (std); track colour (fast); press stretch 16 → 19 (fast) | 272 / 120 | spring / out-soft | — | left or right | retarget | colour only | `Toggle(.switch)` system |
| Q5 | segmented | thumb x and width | std 272 | spring | — | — | retarget | instant | `Picker(.segmented)` system |
| Q6 | checkbox | fill (press 70); check draws (fast 120) | 70 / 120 | out-soft | — | — | — | same | `Toggle(.checkbox)` (mac) |
| Q7 | copy → check | IconSwap .8: out 70 ease-in, in 120 out-soft; held 1500, then back | 70 / 120 | — | — | centre | — | opacity | `.contentTransition(.symbolEffect(.replace))` |

### G.4 SwiftUI timing equivalents (`JunoMotion`, generated)

| Web | SwiftUI |
|---|---|
| `--spring-snap` (0.18, 0) | `.smooth(duration: 0.18)` |
| `--spring-standard` (0.22, 0.05) | `.snappy(duration: 0.22, extraBounce: -0.10)` (snappy is 0.15 bounce, so this gives 0.05) |
| `--spring-layout` (0.36, 0) | `.smooth(duration: 0.36)` |
| `--spring-emphasized` (0.36, 0.10) | `.snappy(duration: 0.36, extraBounce: -0.05)` |
| fade in 120 / out 120 / out 160 / out 70 | `.easeOut(duration: 0.12)` / `.easeIn(duration: 0.12)` / `.easeIn(duration: 0.16)` / `.easeIn(duration: 0.07)` |
| Reduced motion | `@Environment(\.accessibilityReduceMotion)`: transitions → `.opacity`, springs → `.easeOut(duration: 0.22)` |

The macOS `platformFactor` (0.75) stays for springs only. `sendMorph` and `drawerSettle` retire and map to standard and layout.

---

## H. Token changes

### H.1 `src/app/globals.css`, exact additions and re-values

```css
:root {
  /* state fills (new): alpha over any ground, so one recipe works on the page, card, float and sidebar */
  --fill-hover: 216 9% 11% / 0.05;
  --fill-selected: 216 9% 11% / 0.075;
  --fill-pressed: 216 9% 11% / 0.1;

  /* surfaces (new) */
  --surface-modal: 0 0% 100%;
  --key: 0 0% 100%;
  --tooltip: 220 9% 13%;
  --tooltip-foreground: 0 0% 98%;
  --switch-off: 220 5% 80.5%;
  --primary-hover: 216 9% 20%;
  --grabber: 216 9% 11% / 0.2;
  --hairline-hi: 216 9% 11% / 0.16;       /* 0.5px edge at dpr ≥ 2 */

  /* re-valued */
  --hairline: 216 9% 11% / 0.1;           /* was 48 12% 18% / 0.06 (warm, retired palette) */
  --scrim: 220 12% 8% / 0.3;              /* was 48 12% 8% / 0.26 */
  --field-surface: var(--card);           /* was var(--muted): white fields */

  /* elevation (composed, CSS only) */
  --shadow-raised: 0 0.5px 1px hsl(var(--shadow-ink) / 0.1), 0 1px 3px hsl(var(--shadow-ink) / 0.08);
  --shadow-float: 0 1px 2px hsl(var(--shadow-ink) / 0.05), 0 8px 24px -6px hsl(var(--shadow-ink) / 0.16);
  --shadow-modal: 0 2px 4px hsl(var(--shadow-ink) / 0.05), 0 24px 64px -16px hsl(var(--shadow-ink) / 0.28);
  --shadow-composer: 0 1px 2px hsl(var(--shadow-ink) / 0.04), 0 6px 20px -8px hsl(var(--shadow-ink) / 0.12);
  --shadow-composer-focus: 0 1px 2px hsl(var(--shadow-ink) / 0.05), 0 10px 28px -10px hsl(var(--shadow-ink) / 0.18);
  --shadow-tooltip: 0 2px 8px -2px hsl(var(--shadow-ink) / 0.24);

  /* timing families (named waits: not duration rungs) */
  --delay-tooltip: 500ms;                 /* was 200 */
  --delay-tooltip-skip: 300ms;            /* was 400 */
  --delay-submenu: 100ms;                 /* new */
  --grace-submenu: 300ms;                 /* new */
  --delay-hovercard: 300ms;               /* new */
  --grace-hovercard: 150ms;               /* new */
  --hold-toast: 4000ms;                   /* new */
  --hold-toast-action: 6000ms;            /* new */
  --loop-spin: 800ms;                     /* new */

  /* motion scalars (new; Tier B already zeroes --motion-*) */
  --scale-pop: 0.97;                      /* menus, popovers (was 0.96) */
  --scale-modal: 0.96;
  --scale-exit: 0.98;
  --scale-swap: 0.8;                      /* IconSwap; composer faces move from 0.5 */
}
.dark {
  --fill-hover: 0 0% 100% / 0.06;
  --fill-selected: 0 0% 100% / 0.085;
  --fill-pressed: 0 0% 100% / 0.11;
  --popover: 225 5% 17.5%;                /* was 225 4.878% 16.078% */
  --surface-modal: 225 5% 19.6%;
  --key: 225 5% 25%;
  --tooltip: 225 5% 26%;
  --tooltip-foreground: 0 0% 98%;
  --switch-off: 225 4% 29%;
  --primary-hover: 220 7% 83%;
  --grabber: 0 0% 100% / 0.24;
  --hairline: 0 0% 100% / 0.09;           /* was 45 14% 94% / 0.08 */
  --hairline-hi: 0 0% 100% / 0.14;
  --shadow-raised: 0 1px 2px hsl(0 0% 0% / 0.35);
  --shadow-float: 0 1px 2px hsl(0 0% 0% / 0.3), 0 10px 24px -8px hsl(0 0% 0% / 0.45);
  --shadow-modal: 0 2px 6px hsl(0 0% 0% / 0.35), 0 24px 56px -16px hsl(0 0% 0% / 0.6);
  --shadow-composer: 0 1px 2px hsl(0 0% 0% / 0.3), 0 8px 24px -10px hsl(0 0% 0% / 0.5);
  --shadow-composer-focus: 0 1px 2px hsl(0 0% 0% / 0.35), 0 12px 32px -10px hsl(0 0% 0% / 0.6);
  --shadow-tooltip: 0 2px 8px hsl(0 0% 0% / 0.4);
}
@media (prefers-contrast: more) {            /* and html[data-contrast=more] */
  :root { --fill-hover: 216 9% 11% / 0.08; --fill-selected: 216 9% 11% / 0.12; --switch-off: var(--input); --hairline: var(--border); }
  .dark { --fill-hover: 0 0% 100% / 0.1;  --fill-selected: 0 0% 100% / 0.15; --switch-off: var(--input); --hairline: var(--border); }
}
```

**Composed classes.**
- `.surface-float` and `.overlay-glass` become one rule (popover, hairline, shadow-float); `.overlay-glass` is kept as an alias.
- `.surface-modal` (new): surface-modal, hairline, shadow-modal.
- `.control-primary` drops its three-layer glow and `brightness()` hover.
- `.composer-surface` reads `--shadow-composer*` and `--hairline`. Its `::after` drops the literal 26px for `border-radius: inherit`.
- `.ui-tooltip` reads `--tooltip*` and re-points `--background` (fixes the keycap) and an alpha-free `--border`.

### H.2 `tailwind.config.ts`

| Change | Before → After |
|---|---|
| `borderRadius.menu` | 14px → **12px** |
| `borderRadius.field` | 10px → **8px** |
| colours | add `fill-hover`, `fill-selected`, `fill-pressed`, `surface-modal`, `key`, `tooltip`, `tooltip-foreground`, `switch-off`, `primary-hover`, `grabber` |
| `boxShadow` | add `modal`, `composer`, `composer-focus`, `tooltip`; delete the legacy `soft`, `lift` and `glass` (alias them to `raised`, `raised` and `float` first, with a codemod) |
| `transitionDuration.DEFAULT` | add `var(--dur-fast)` (kills Tailwind's implicit 150ms) |
| Recipes | `menu-recipe.ts`: `nest-menu` → 12, `nest-p-1`, rows `min-h-8 text-nav gap-2 px-2`, highlight `bg-fill-selected`, label `font-sans text-label`, separator `mx-2 my-1 bg-hairline`, widths `w-60` / `w-72` / `w-80`; `field-recipe.ts`: `rounded-control`, fill `--field-surface`, the global ring; `.cmenu`, `.composer-layer` and `.cv2-pop` are deleted in favour of the recipe |

The same change must update `RADIUS_TOKENS`, `SCALE_HELP` and the concentric table in `eslint-rules/design-system.mjs`.

### H.3 Native regeneration
- **Yes. Run `npm run design:tokens`.**
  - `JunoGeneratedColors` gains `fillHover`, `fillSelected`, `fillPressed`, `surfaceModal`, `key`, `tooltip`,
    `tooltipForeground`, `switchOff`, `primaryHover`, `grabber` and `hairlineHi` (4 appearances each).
  - `popover` and `hairline` change value.
  - `JunoGeneratedRadius.menu` becomes 12 and `.field` becomes 8.
  - `JunoGeneratedTiming` gains the new delays and holds.
  - The digest changes, so `design:tokens:check` passes only with the regenerated `tokens.generated.ts` and `JunoGeneratedTokens.swift` in the same commit.
- **Elevation is not projected.** Hand-port the four levels into `JunoElevation` (flat, raised, float, modal) and delete
  the ad-hoc alpha shadows (iOS black 0.14/0.6 on the drawer).
- **Generator.** Add `scale-*` and the new delay families to `TIMING_FAMILIES` so `JunoMotion` reads them.
  `scripts/generate-native-icons.mjs` outlines symbol **templates** (see I.6).
- **Contrast matrix.** Add `fill-selected` and `fill-pressed` (composited over popover, card and sidebar) to `FILLS`;
  muted-on-fill holds at 4.6 (light) and 4.5 (dark). Add `tooltip` to `GROUNDS`. The recorded failing pair
  (muted on `--selected`, 4.32) stays recorded.
- **Design editor.** `npm run design:editor` (the bundle hashes `globals.css` and the recipes).

### H.4 Rule changes this direction asks for

| Rule (map-principles) | Change | Why |
|---|---|---|
| §1.6 "JetBrains Mono for … `text-label` metadata" | Chrome labels, shortcuts and counts use **`font-sans text-label`** with `tnum`. Mono stays for code, paths, receipts, keycaps and numeric table cells. | Mono section heads and shortcuts read as a developer console (map-components §6.4, map-menus §7.4). Apple and ChatGPT set shortcuts in the UI face. |
| §1.8 "iOS and Mac draw the web's icons, never SF Symbols" | **Kept.** The family is redrawn on SF construction and shipped natively as **vector custom-symbol templates** (`Image("alevr.plus")`), with an SF twin recorded per glyph (I.6) as its drawing reference. The `sficons` gate stays at 0; the bitmap path in `JunoIconView` is banned by the `symbols` gate. | One identity, with native behaviour: Dynamic Type, `.imageScale`, weight following `.font` and symbol effects. |
| §1.8 the October "bold line pass" | Lines go to 1.33px at 16 (2 units), matched to the text stem | glyphs read heavier than their labels |
| §1.3 "`--input` … control boundaries ≥ 3:1" | **One exception:** the switch off track is decorative (1.6:1); the knob and its position carry state; high contrast restores `--input` | Apple-grade switches; a 54% L slab reads as a heavy grey bar |
| §1.11 shell contract (`+` rows) | The `+` menu gains "Ask first ›" (the task-mode chip moves in) and the Project / Apps tray rows always show (the tray retires) | the right cluster is crowded; the landing reads as two toolbars |
| §1.11 "Send circle … disabled = neutral `--secondary` disc" | Kept for *blocked*. The **voice** face becomes an ink disc (not grey) | the primary action is the strongest object on the row |
| §1.9 menu motion | Menus 120 fade + snap spring (from .97) and 120 exit to .98; keyboard-opened layers at frame 0 | spec C7 (frequent overlays) and identity-v2 |
| `--delay-tooltip` 200/400 | 500/300 | the governing spec §4.2 already says 500/300 |
| Owner rule 3 (no chips above the composer) | Also none **below** on the landing (starters retire) | quiet, conversation-first. **Needs owner confirmation.** |

### H.5 Lint

Add `eslint-rules/enforce/quiet-native.json` to ratchet the recipes, `globals.css` and the composer to errors.
New checks:
- raw `cubic-bezier(` outside `globals.css`;
- `*_MS` identifiers passed as a framer `duration`;
- `motion-reduce:transition-none` on colour-only transitions (Tier A);
- `title=` on buttons inside a `Tooltip`;
- any `rounded-menu` on an in-flow element.

---

## I. Native (macOS 26, iOS 26, SwiftUI + Liquid Glass)

### I.1 Same information architecture, rendered natively

| Region | Web | macOS 26 | iOS 26 (iPhone) |
|---|---|---|---|
| Navigation container | flat `--sidebar` column (260) + an inset content card (8 gutter, r 16) | `NavigationSplitView`: the system **inset glass sidebar** (8 margin, r 18 concentric with the window's 26) + content on `junoCanvas`. Two panes, one inset rounded panel, so the two read as the same structure in mirror depth. | `NavigationStack` with a drawer for the sidebar (overlay, 85%, max 320, `--drawer-dim` 0.12 / 0.30), or `NavigationSplitView` on iPad |
| Sidebar header | lockup · bell · collapse | traffic lights · then **bell and collapse as toolbar items** in the sidebar's titlebar region | drawer header: lockup · search (`.searchable` inside the drawer) |
| Product switch | segmented Chat · Code under the lockup | `Picker("", selection:) { Chat; Code }.pickerStyle(.segmented)` at the top of the sidebar (the orbit is deleted) | the same segmented `Picker` at the top of the drawer |
| Rows | New chat · Search · Activity · Projects · Library · Customize ‖ Orbit (busy agents) ‖ Recent (pins first) ‖ account | `List(selection:)` with `.listStyle(.sidebar)`, the same rows and sections (generated `JunoShellChatSidebar`) | the same list in the drawer, rows 44 |
| Chat header | in-card band: title (crumb) · Outputs · Share · More · Incognito | **unified toolbar**: `.navigationTitle` + `.navigationSubtitle(project)` at the leading edge; `ToolbarItemGroup(.primaryAction) { Share; Menu(More) }` as one glass capsule; incognito as a separate item | nav bar: leading sidebar button; inline title + `.toolbarTitleMenu`; `ToolbarItemGroup(.topBarTrailing) { search; compose }` |
| Transcript | measure 768, same anatomy | unchanged (already at parity) | the same anatomy at 16 gutter; **adds the tool-call timeline** |
| Composer | §F | floating `GlassEffectContainer` in `.safeAreaBar(edge: .bottom)` | the same, in `.safeAreaBar(edge: .bottom)` |
| Canvas / artifact | right panel in the card | `.inspector(isPresented:)` for every right panel (chat and code) | `.sheet` (large detent) on iPhone; `.inspector` on iPad |
| Settings | modal, 12 sections | `Settings` scene with `NavigationSplitView` and `.searchable(placement: .sidebar)` | sheet: `NavigationStack` + `List(.insetGrouped)` on brand neutrals |

### I.2 Liquid Glass rules

1. **Glass lives only on the control layer that floats above content.**
   - macOS: the sidebar (system), toolbar items (system), the **composer group**, ⌘K, the find bar, the toast host, scroll-to-latest and Quick Entry.
   - iOS: bar items (system), the composer group, scroll-to-latest, the find bar, and system menus, popovers and sheets.
2. **Never on content:**
   - messages, cards, artifacts, page bodies, and buttons that live in content;
   - those buttons use `.bordered` / `.borderedProminent` / `.borderless` with **rounded rectangles at
     `.controlSize(.regular)`** on macOS (Apple: small and medium controls are rounded rects; capsules are for large).
3. **No glass on glass.**
   - Inside `.sheet`, `.popover` and the composer, controls are opaque or plain.
   - Several shapes inside **one** `GlassEffectContainer` count as one material; nesting a glass button inside another glass view's content does not.
4. **Tint sparingly.**
   - The composer card is `.regular.tint(.junoCard.opacity(0.55))`, so it reads as the web's white card while still refracting the transcript scrolling beneath.
   - The send disc is the one prominent element: `.glassProminent` tinted `.junoForeground`.
   - Nothing else is tinted.
5. **Morphing with `glassEffectID`:**
   - composer card ⇄ voice capsule (`"composer.card"`);
   - send disc ⇄ voice End capsule (`"composer.action"`);
   - scroll-to-latest merging into the composer (`glassEffectUnion(id: "composer")` when within 24pt).
6. **Scroll edges.** `.scrollEdgeEffectStyle(.hard, for: .top)` under the macOS toolbar; `.soft` for the composer's bottom edge on both platforms and for the iOS top edge. One per pane.
7. **Accessibility.**
   - **Reduce Transparency:** every custom glass view swaps to `junoCard` + a hairline + `JunoElevation.raised`.
   - **Increase Contrast:** hairline → `border`.
8. **Gate.** The glass gate (`check-native-glass.mjs`) removes the phone exemption and the `JunoGlassControls.swift` exemption. The allowed list is the eight sites above.

### I.3 Per-surface table: web component → SwiftUI

| Web component | SwiftUI component | Modifiers and values (generated tokens) |
|---|---|---|
| App shell | `NavigationSplitView(columnVisibility:)` | `.navigationSplitViewColumnWidth(min: 224, ideal: 260, max: 352)`; content `.background(.junoCanvas)`; macOS `.containerBackground(.junoCanvas, for: .window)` |
| Product switch | `Picker(selection:) { Label("Chat", image: "alevr.chat").tag(...) … }` | `.pickerStyle(.segmented)` `.labelsHidden()` `.controlSize(.regular)` in a `.safeAreaInset(edge: .top)` of the sidebar list, padding 8 |
| Sidebar row | `NavigationLink(value:)` in `List(selection:)` | `.listStyle(.sidebar)`; `.listItemTint(.monochrome)` (a neutral selection that removes the custom `listRowBackground` hack); `Label { Text(title).font(.junoNav) } icon: { Image("alevr.x").imageScale(.medium) }`; macOS row 32 (system), iOS 44 |
| Sidebar section | `Section(isExpanded:) { … } header: { Text("Recent").font(.junoLabel) }` | sans 12/500 `junoSecondaryInk`; pins first |
| Row trailing signal | `.badge()` or a trailing `Circle().fill(.junoPresence).frame(width: 6, height: 6)` | one signal per row |
| Account row | `Menu { … } label: { HStack { AvatarView(28); VStack { name .junoNav.weight(.medium); plan .junoLabel } ; Image("alevr.chevrons-up-down") } }` | `.menuStyle(.button)` `.buttonStyle(.plain)` `.menuIndicator(.hidden)` |
| Chat header | `.navigationTitle(title)` `.navigationSubtitle(project)` | macOS `.toolbarTitleDisplayMode(.inline)`; `.toolbarTitleMenu { Rename; Pin; Move to project; Delete }` |
| Header actions | `ToolbarItemGroup(placement: .primaryAction) { ShareLink(…) ; Menu("More", image: "alevr.more") {…} }` | grouped automatically into one glass capsule; `ToolbarSpacer(.fixed)` before the incognito item |
| Transcript | `ScrollView { LazyVStack(spacing: 24) }` | `.defaultScrollAnchor(.bottom)`; `.contentMargins(.horizontal, 16/24/32)`; `.frame(maxWidth: 768)`; `.scrollEdgeEffectStyle(.hard, for: .top)` (mac) / `.soft` (iOS) |
| User bubble | `Text` in `UnevenRoundedRectangle(topLeading: 12, bottomLeading: 12, bottomTrailing: 8, topTrailing: 12)` | fill `.junoUserBubble` (iOS adopts it, along with the 8 tuck and 85% max) |
| Message action bar | `HStack(spacing: 2)` of `Button` | `.buttonStyle(.junoIcon(size: 28))` (one style: hover fill, press fill), glyph 16, `.help("Copy")` |
| Message ⋯ | `Menu { … }` | `.menuStyle(.button)` `.buttonStyle(.junoIcon(28))` `.menuIndicator(.hidden)`; on iOS `.contextMenu` on the bubble only, not the action row |
| Composer | `JunoComposerShell` (one, shared) | `GlassEffectContainer(spacing: 12) { card.glassEffect(.regular.tint(.junoCard.opacity(0.55)).interactive(false), in: .rect(cornerRadius: JunoRadius.composer)).glassEffectID("composer.card", in: ns) }`; field `TextField(axis: .vertical).lineLimit(1...8).font(.junoReading)`; padding 16/20/4/20; row padding 4/8/8/8 |
| Composer `+` | `Menu { … } label: { Image("alevr.plus").font(.system(size: 20, weight: .semibold)) }` | `.menuStyle(.button)` `.buttonStyle(.junoComposerControl)` (36 circle, hover `fillHover`); iOS: `Menu` with `ControlGroup { Camera; Photos; Files }.controlGroupStyle(.palette)` at the top |
| Model chip | `Menu { Picker("Model", selection:) { … } ; Menu("Thinking") { Picker(...) } }` | label `Text(model).font(.junoUI)` + `Image("alevr.chevron-down").imageScale(.small)`; `.buttonStyle(.junoChip)` (capsule 32, padding 12/8) |
| Send / stop disc | `Button { … } label: { Image(face.symbol) }` | `.buttonStyle(.glassProminent)` `.buttonBorderShape(.circle)` `.tint(.junoForeground)` `.controlSize(.large)` (36); `.contentTransition(.symbolEffect(.replace.offUp))`; `.glassEffectID("composer.action", in: ns)` |
| Attachments | `ScrollView(.horizontal) { HStack(spacing: 8) }` | tiles `ConcentricRectangle()` inside the card's `.containerShape(.rect(cornerRadius: 26))`, which yields 14 at a 12 inset; remove ✕ 20 circle with `.contentShape(Circle().inset(by: -12))` (44) |
| Dropdown menu | `Menu` | system; `Section("Label")`; `Divider()`; `Button(role: .destructive)`; shortcut `.keyboardShortcut("u", modifiers: .command)` (macOS shows it) |
| Context menu | `.contextMenu { same items }` | system; no shortcuts |
| Submenu | nested `Menu("Add to project") { … }` | system safe-triangle and flip |
| Select | `Picker("Theme", selection:) { … }` | `.pickerStyle(.menu)` (macOS pop-up button) |
| Combobox | `TextField` + `.searchSuggestions { … }` / `.textInputSuggestions` (macOS) | — |
| Command palette | custom panel (allowed glass site) | `.glassEffect(.regular, in: .rect(cornerRadius: 16))`; width 600; field 52; rows 36 |
| Dialog (form) | `.sheet { NavigationStack { Form { … }.formStyle(.grouped) .toolbar { cancel; confirm } } }` | `.presentationSizing(.form)` (macOS), `.presentationDetents([.medium, .large])` (iOS); **no fixed frames** |
| Destructive confirm | `.confirmationDialog("Delete chat?", isPresented:, titleVisibility: .visible) { Button("Delete", role: .destructive) {…} }` | system (iOS 26 springs from the source control) |
| Alert | `.alert` | system |
| Bottom sheet | `.sheet` | `.presentationDetents([.medium, .large])` `.presentationDragIndicator(.visible)` only with two detents; `.presentationBackgroundInteraction(.enabled(upThrough: .medium))` when it should not block |
| Popover / hover card | `.popover(isPresented:, arrowEdge: .top)` | `.presentationCompactAdaptation(.sheet)` on iPhone; content `.frame(width: 320)` |
| Tooltip | `.help("Copy ⌘C")` | system (macOS); none on iOS |
| Toast | `JunoToastHost` (allowed glass) | capsule → **r 12 card** to match the web; `.glassEffect(.regular, in: .rect(cornerRadius: 12))`; slides from the bottom, as T1–T6 |
| Buttons | `Button` | primary `.borderedProminent.tint(.junoForeground)`; secondary `.bordered`; ghost `.borderless`; destructive `role: .destructive` + `.borderedProminent`; `.controlSize(.regular)` (32 on mac); iOS 44 `.controlSize(.large)` capsule |
| Segmented | `Picker(.segmented)` | system (glass on iOS 26 is correct in bars; on page content use `.pickerStyle(.segmented)` on macOS, which is opaque) |
| Switch, checkbox | `Toggle` | `.toggleStyle(.switch)`; macOS `.checkbox`; tint `.junoForeground` |
| Search fields | `.searchable(text:, placement: .toolbar / .sidebar / .navigationBarDrawer)` | replaces both hand-rolled fields |
| Lists in pages | `List` / `Table` (macOS) | rows 36 (mac) / 44 (iOS); `.listStyle(.inset)`; no card grids where the web shows rows |
| Page title | `Text(title).font(.junoDisplaySerif)` (Newsreader 32 regular) | `.toolbar(removing: .title)` on macOS pages that draw a header; iOS `.navigationTitle` with `.toolbarTitleDisplayMode(.inlineLarge)` and a serif `largeTitle` via `UINavigationBarAppearance` |
| Empty chat | `VStack { Text("What's next, \(name)?").font(.junoGreeting) ; composer }` | Newsreader 40/46 (mac) or 34/40 (iOS) regular −0.03em |

### I.4 Values for the two platforms

| Item | macOS 26 | iOS 26 |
|---|---|---|
| Type | SF Pro through `junoFont`: nav 14, ui 13, label 12, reading 16. Menus and alerts stay system (13). | Dynamic Type relative: nav = `.body` (17), ui = `.subheadline` (15), label = `.footnote` (13), reading 17; Newsreader scales with `relativeTo:` |
| Row height | 32 sidebar and menus (system); 36 lists | 44 minimum; 48 in sheets |
| Targets | 28 minimum, 32 typical | 44 |
| Icons | `Image("alevr.*")`, `.imageScale(.medium)` in rows (≈16), `.large` in the composer (20) | `.imageScale(.large)` in bars and the composer (≈22), `.medium` in rows |
| Hover | one `JunoHoverFill` modifier (fill-hover, 0 in / 0.12 out) replacing 70 hand-written `.onHover` machines; `.pointerStyle(.link)` on links | — (pressed state only) |
| Keyboard | every menu item that has a web shortcut declares `.keyboardShortcut`; `⌘K`, `⌘N`, `⇧⌘O`, `⌘U` and `⌘,` in `CommandGroup`s | hardware Return sends; ⇧Return is a newline |
| Composer shape | `.rect(cornerRadius: 26)` | `ConcentricRectangle(corners: .concentric(minimum: 26), isUniform: false)`: the bottom corners follow the display (≈43) when the keyboard is down, and 26 when it sits on the keyboard |
| Scroll edge | `.hard` (top), `.soft` (bottom) | `.soft` both |

### I.5 Motion (SwiftUI)

Every storyboard row in G.3 has its SwiftUI column. System components (`Menu`, `Picker`, `.sheet`, `.alert`,
`.confirmationDialog`, `.popover`, `NavigationSplitView`) keep Apple's own motion. That is the native rendering of the
same intent: origin-aware, springs, fast exits. Custom motion uses `JunoMotion`:

- Composer focus: `.animation(.easeOut(duration: 0.12), value: isFocused)`.
- Send → stop: `.contentTransition(.symbolEffect(.replace.offUp))` inside `withAnimation(.junoSnap)`.
- Composer ⇄ voice: `withAnimation(.junoStandard) { mode = .voice }` with `glassEffectID` (the glass morphs).
- Attachments: `withAnimation(.junoStandard)` + `.transition(.scale(0.92).combined(with: .opacity))`.
- Toasts: `.transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity.animation(.easeIn(duration: 0.16))))`.
- Scroll to latest: `withAnimation(.smooth(duration: 0.22)) { position.scrollTo(edge: .bottom) }`.
- Reduced motion: `@Environment(\.accessibilityReduceMotion)` turns every custom transition into `.opacity` and every spring into `.easeOut(duration: 0.22)`.
- Glass morphs fall back to cross-fades. Sheets keep system behaviour, which already honours Reduce Motion.

### I.6 Icons: web glyph → SF twin → native asset

Native draws `Image("alevr.<name>")`. These are custom symbol templates generated from the web drawings, with three weights
(regular 2.0u, medium 2.3u, semibold 2.6u) and three scales. They follow `.font` and Dynamic Type like SF Symbols.
The SF twin is the reference metaphor and proportion.

| Web glyph | SF twin | Asset |
|---|---|---|
| plus | `plus` | `alevr.plus` |
| close | `xmark` | `alevr.close` |
| check | `checkmark` | `alevr.check` |
| chevron-down / -right / up-down | `chevron.down` / `chevron.right` / `chevron.up.chevron.down` | `alevr.chevron-*` |
| more | `ellipsis` | `alevr.more` |
| search | `magnifyingglass` | `alevr.search` |
| send | `arrow.up` (bold cut ≈ `.semibold`) | `alevr.send` |
| stop | `stop.fill` | `alevr.stop` |
| mic | `mic` | `alevr.mic` |
| voice | `waveform` | `alevr.voice` |
| attach | `paperclip` | `alevr.attach` |
| model | `sparkle` | `alevr.sparkle` |
| settings | `gearshape` | `alevr.settings` |
| copy | `doc.on.doc` | `alevr.copy` |
| edit | `pencil` | `alevr.edit` |
| retry | `arrow.clockwise` | `alevr.retry` |
| share | `square.and.arrow.up` | `alevr.share` |
| trash | `trash` | `alevr.trash` |
| pin / pinned | `pin` / `pin.fill` | `alevr.pin` / `alevr.pin.fill` |
| folder | `folder` / `folder.fill` | `alevr.folder` |
| globe (web search) | `globe` | `alevr.globe` |
| image | `photo` | `alevr.image` |
| file | `doc.text` | `alevr.document` |
| memory | `rectangle.stack` | `alevr.memory` |
| agent | `person.crop.square` | `alevr.agent` |
| new chat | `square.and.pencil` | `alevr.compose` |
| sidebar | `sidebar.left` | `alevr.sidebar` |
| bell | `bell` / `bell.fill` | `alevr.bell` |
| code | `chevron.left.forwardslash.chevron.right` | `alevr.code` |
| arrow-down (jump) | `arrow.down` | `alevr.arrow-down` |
| activity | `chart.bar` | `alevr.activity` |
| library | `books.vertical` | `alevr.library` |
| customize | `slider.horizontal.3` | `alevr.customize` |
| error | `xmark.circle` | `alevr.error-circle` |
| info | `info.circle` | `alevr.info` |
| camera | `camera` | `alevr.camera` |
| thumbs-up / -down | `hand.thumbsup` / `hand.thumbsdown` | `alevr.thumbs-*` |
| read-aloud | `speaker.wave.2` | `alevr.read-aloud` |
| branch | `arrow.triangle.branch` | `alevr.branch` |
| incognito | `eye.slash` (native ghost retires) | `alevr.eye-off` |
| screenshot | `camera.viewfinder` | `alevr.screenshot` |
| apps | `square.grid.2x2` | `alevr.apps` |

Weight and scale are matched to text. In a row, `Label` with `.font(.junoNav)` gives regular at `.medium` scale
(≈16 at 14pt). The composer uses `.font(.system(size: 20, weight: .semibold))` for `+`, send and stop.

### I.7 The 25 worst native offences and their fixes (Mac + iOS)

| # | Offence (source) | Fix |
|---|---|---|
| 1 | Mac: the layout is inverted and the product switch is a custom dot-orbit in the toolbar centre; the sidebar has no header (`ChatToolbar.swift:54`, `JunoProductOrbit.swift`) | Sidebar top: segmented `Picker` Chat · Code + bell/collapse in the sidebar titlebar; delete the orbit; toolbar title at the leading edge as on the web |
| 2 | Glass capsules on content: Mac 97 × `.junoGlass` + 64 × `.junoProminent`; iOS ~114 (`JunoGlassControls.swift`, `JunoMobileCapsuleControls.swift`) | Content buttons become `.bordered/.borderedProminent/.borderless` rounded rects at `.regular`; glass only on the I.2 list; the gates lose their exemptions |
| 3 | Glass on glass: ~48 glass controls in Mac sheets and popovers; capsules, dictation and `.thinMaterial` chips inside the iOS composer | Opaque controls in every presentation; one `GlassEffectContainer` per floating group |
| 4 | The Mac composer is an edgeless glass slab with no focus state (`JunoComposerShell.swift:296-318`) | Card-tinted glass + hairline + focus step (F.1); Reduce Transparency → opaque card |
| 5 | Five iOS composers with radii 26/24/24/22/28; none uses the shared shell | One `JunoComposerShell` on both platforms (incognito, code voice and link are modes of it) |
| 6 | The iOS `+` is a hand-built 264pt glass panel with a 4000 × 4000 tap catcher (`JunoMobileComposer.swift:655`) | System `Menu` with a `ControlGroup(.palette)` top row and nested `Menu`s (morphs from the button) |
| 7 | iOS: the model is invisible (a 19pt gauge; long-press for the catalogue) | A labelled model chip `Menu` on the row; Thinking as a nested picker |
| 8 | Page titles in SF Medium 32–44 instead of the serif; the title is shown twice (toolbar + header) | Newsreader 32 regular; `.toolbar(removing: .title)` when a page header shows |
| 9 | Black prominent capsules overused (several per view: agent computer) | One prominent action per surface, a `.borderedProminent` rect |
| 10 | Custom segmented controls: `JunoSegmented` (60 Mac uses), 3 hand-rolled on iOS | `Picker(.segmented)` |
| 11 | iOS icons rasterised at fixed sizes (274 sites, 13 sizes); Mac uses 15 icon sizes | Vector symbol templates; three scales; size from `.font` / `.imageScale` |
| 12 | The sidebar fights `List`: a custom `listRowBackground` over the system selection, offset arithmetic, a "+10 leadingShift" | `.listItemTint(.monochrome)`, system insets, the generated 16 edge |
| 13 | An oversized "prominent" New chat row (Mac 40pt) and a 52pt ink "Chat" capsule at the bottom of the iOS drawer | An ordinary 32/44 row at the top of the list + a toolbar compose button |
| 14 | Three typography APIs; 58 sites at 10.5/11pt | `junoFont(.nav/.ui/.label/.reading/.heading)` only; floor 12 (11 for kbd and badge) |
| 15 | Ad-hoc tones: 8 border alphas and ~22 foreground alphas (Mac); ~35 opacity fills (iOS) | Generated `fillHover`, `fillSelected`, `fillPressed`, `hairline` and `surfaceModal` |
| 16 | The artifact canvas header mixes four button idioms with a hand-drawn separator | `.inspector` with a toolbar: `ToolbarItemGroup` of `.junoIcon(28)` + one `.borderedProminent` Save |
| 17 | Panel headers inconsistent (`.bar` / `junoSurface 0.5` / none); Chat uses a custom `TrailingDock`, Code uses `.inspector` | `.inspector` for every right panel on Mac and iPad |
| 18 | The empty chat diverges: a 30pt "What can I help with?" (Mac) and an empty page (iPhone) | "What's next, {Name}?" in Newsreader 40 (Mac) or 34 (iOS) above the landing composer |
| 19 | Hand-rolled settings search (radius 9) and black-disc section tiles (Mac); system greys in iOS settings | `.searchable(placement: .sidebar)`; plain row icons; iOS `.scrollContentBackground(.hidden)` on `junoCanvas` |
| 20 | Sign-in: a painted landscape JPG, a card form, `.roundedBorder` fields, glass capsules | Web parity: the galaxy plate, a cardless form, 44pt fields, a `.borderedProminent` rect |
| 21 | Fixed-size sheets and popovers (560 × 520 ×4, 880 × 640, hard-coded heights) clip at large text | `.presentationSizing(.form/.page)`; content-sized popovers |
| 22 | 32 bespoke `ButtonStyle`s and 70 hover state machines (Mac); 7 press styles and 88 `.plain` (iOS) | Four styles: `.junoRow`, `.junoIcon(size)`, `.junoChip`, `.junoComposerControl` + system `.bordered*`; one `JunoHoverFill` |
| 23 | Four treatments for the iOS primary slot (ink disc, ink glass, red disc, red glass) | One disc: `.glassProminent` ink; End is the same disc tinted `junoDanger`, morphing by `glassEffectID` |
| 24 | The iOS push drawer: a hard-coded corner table, dim 0.04 (token 0.12), black 0.6 shadows, a 22pt edge strip | An overlay drawer on tokens (`drawerDimLight/Dark`, `JunoElevation.modal`), `ConcentricRectangle` corners, the system edge-swipe |
| 25 | The iOS transcript renders no tool calls (`NativeRunTimeline` unused); the bubble drifted (no tuck, 80%, `junoMuted`) | Render the run timeline rows; the bubble uses `userBubble`, the 8 tuck and 85% |

Also noted, below the top 25:
- The Code Studio second design system (radii 22 and 18, hand-typed coral) moves onto the generated tokens.
- The snapshot pipeline renders fake glass. The CI job should use `--juno-preview-snapshot` for real composites.
- Grabbers show on single-detent sheets (5 places on iOS).

---

## J. Rollout order (smallest change, largest felt gain)

1. **Tokens (H.1, H.2) + the menu recipe.** One floating surface, one row, one highlight. Delete `.cmenu`, `.composer-layer` and `.cv2-pop`.
2. **Composer geometry (F.1)**, disc faces and the glyph swap (C5/C6). Landing width = dock width. The tray moves into `+`.
3. **Motion vocabulary (G.1)** in `lib/motion.ts` + the WAAPI helper; frame-0 keyboard opening; the hover 0-in rule; the Tier A sweep.
4. **Dialog anatomy (E.1)** with the pinned header and footer; one sheet engine; the toast family with the memory notice.
5. **Icon redraw (B)**, the 40 most-used glyphs first (the board's set), then the S cuts; native symbol templates.
6. **Native shell (I.1–I.3)**: sidebar header + segmented switch, toolbar, composer group, system menus.
7. **Native content cleanup (I.7)**: buttons, segmented controls, type and sheets.

Each step ships its before/after screenshots (light, dark, desktop, phone) and its regenerated native tokens in the same commit.
