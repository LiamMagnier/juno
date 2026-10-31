# Direction B: Editorial Calm

**Alevr UI system: web, macOS 26 and iOS 26.** Design direction, 31 Oct 2026. Companion mockup: `b-editorial-calm.html`, with screenshots in `b-editorial-calm-*.png`.

This direction is built from the current-state maps (`map-*.md`). Every "today" value below comes from them. Nothing here changes product source. It is a spec to approve before building.

---

## 0. The idea in one paragraph

Alevr should feel like a well-set page, not a dashboard.

- **Type carries hierarchy, not boxes.** There are fewer borders. Section labels, item names and the descriptions under them form a clear three-step type ladder.
- **Rows are roomy.** Items are 36px tall, and hover is a faint tint rather than a slab.
- **Surfaces are warm neutrals.** Paper-white, not cream, and graphite ink stays graphite.
- **Every floating layer is one material with one radius.**
- **The composer is one calm surface** with a quiet tools row, and every control sits on its corner's centre line.
- **Motion is soft and nearly invisible.** Things fade in and drift 2–4px from where they came from. Nothing zooms, bounces or blurs.
- **One family across platforms.** Web, Mac and iPhone share the same information architecture, the same anatomy and the same vocabulary. Each renders it natively: CSS on the web, SwiftUI with Liquid Glass only on the floating control layer natively.

### What this direction fixes, by the maps' own numbering
- **Menus.** Six menu systems become one (map-menus §0). The highlight changes from 1.09:1 to a tint plus a keyboard ring (§6.18). About 16 selected idioms become one (§6.13).
- **Composer.** One row carried seven glyph sizes; now it has three (map-composer §11). The face flicker (§24) and the attachment layout jump (§27) are gone.
- **Motion.** About 11 overlay entrances and six menu entrances become two recipes (map-popups §3I, map-motion #3). Highlight smear is fixed (J1), and the dead turn entrance is restored (M1).
- **Icons.** The Lucide/house split is resolved (map-icons S1). There is now a stroke ladder (S2) and optical centring (S6).
- **Native.** There were 114 phone glass sites, glass capsules on content, edgeless glass composers, and a toolbar orbit. These go (map-native-ios §5, map-native-macos §7).

---

## A. Foundations

### A1. Spacing scale (px, 4-base)

| Step | 2 | 4 | 6 | 8 | 10 | 12 | 16 | 20 | 24 | 32 | 40 | 48 | 64 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Tailwind | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16 |
| Use | hairline gaps, icon-to-badge | intra-chip | **float inset**, label↔desc | icon↔label in chips, button gaps | **concentric composer inset** | card inner, row gutters | panel/page gutter, dialog body | dialog header top | dialog padding, section gap | group gap | page section | — | landing |

**Rules**
- Half-steps are allowed only where a concentric rule derives them: 6 is the float inset, and 10 is the composer control inset (26 − 16). `SPACE_STEPS` stays as it is.
- Row gutters: the text column in every list starts at **12px** from the row edge, or **12 + 16 + 10 = 38px** when there is a leading glyph.
- The gutters stay at 16 / 24 / 32 (from map-principles §1.5).

### A2. Radius ladder: container > inset > item, with no value changes

The rungs keep their px values. Only their **use** changes, so Swift and the radius lint are untouched. One literal is fixed: `.composer-surface::after` `26px` becomes `var(--radius-composer)`.

| Rung (px) | Used for (direction B) | Concentric pair |
|---|---|---|
| `xs` 6 | badges, keycaps, the 16px tile behind a provider logo | — |
| `control` 8 | **every interactive rectangle**: buttons (all sizes, no radius jump at lg), rect icon buttons, menu items, sidebar rows, list rows, tooltips, tab hover | item inside a float: 14 − 6 = **8** ✓ |
| `field` 10 | text-holding wells and tracks: input, textarea, search, select trigger, **segmented track** | segmented thumb: 10 − 2 = **8** ✓ |
| `card` 12 | in-flow cards, attachment tiles, code blocks, images, approval and task cards | card image inset 4 → 8 ✓ |
| `menu` 14 | **every floating layer**: dropdown, context menu, submenu, select list, popover, hover card, toast, model picker, slash/@ palettes, and the web content-card frame (already 14) | rows 8 at inset 6 ✓ |
| `panel` 16 | dialogs, confirm dialogs, side sheets, bottom-sheet top corners, the ⌘K palette, the canvas panel | 16 − 8 (header ✕ inset) = 8 ✓ |
| `composer` 26 | the composer surface (landing and dock alike) | 32px icon buttons at inset 10 have radius 16 = 26 − 10 ✓. The 36px disc at inset 8 has radius 18 = 26 − 8 ✓. **Every control centre sits 26px from both the bottom edge and its side edge.** |
| `full` | avatars, the send disc, composer icon buttons, mode pills, filter chips, count badges | — |

**Retired uses (each was an inconsistency in the maps)**
- Popover at 12, now 14.
- Toast at 12, now 14.
- Memory notice at 16, now 14.
- Cite card at a raw 14, now `menu`.
- Segmented track at 14, now 10.
- Skill and MCP dialogs at an inline 20, now 16.
- Sketch at 28, now 16.
- `.cmenu` at 18/12, now 14/8.

### A3. Surfaces (warm neutral, graphite ink)

All neutrals now share one hue family (38–45°, chroma ≤ 0.006). This also removes the warm-hairline/cool-ink drift (map-components §6.10).

The values are given as hex; the HSL triplets for `globals.css` are in §H. Contrast was measured with the WCAG formula (script in `scratchpad/b-work/contrast.mjs`).

| Role | Token | Light | Dark | Note |
|---|---|---|---|---|
| Sidebar ground | `--sidebar` | `#F3F2EF` | `#181716` | dark is the darkest plane |
| Page canvas | `--background` | `#FAF9F7` | `#1E1D1C` | |
| In-flow card / composer | `--card` | `#FFFFFF` | `#262523` | dark is L+1 |
| Floating layer | `--popover` | `#FFFFFF` | `#2C2B29` | dark is L+2 |
| Modal | `--modal` **(new)** | `#FFFFFF` | `#31302D` | dark is L+3; light alias of popover |
| Recessed well | `--muted` | `#F3F2EF` | `#232220` | code blocks, approval card, field rest fill |
| Hover tint | `--hover` **(new, alpha)** | ink / .05 (rows) or .06 (menus) | `#FFFDF8` / .06 (rows) or .075 (menus) | instant-in |
| On / selected / open | `--selected` | ink / .085 | `#FFFDF8` / .10 | one rung deeper than hover |
| Hairline | `--border` | ink / .09 (≈ `#E9E8E5` on white) | `#FFFDF8` / .08 | decorative |
| Strong hairline | `--border-strong` **(new)** | ink / .14 | `#FFFDF8` / .13 | dividers that must read |
| Field edge at rest | `--field-edge` **(new)** | `#D9D6D0` (1.45:1) | `#3E3C39` | see §A9 rule change |
| Control boundary | `--input` | `#8C8881` (3.5:1 on card) | `#77736C` (3.0:1 on popover) | checkbox, radio, switch-off |
| Ink | `--foreground` / `--primary` | `#1F1E1C` | `#EDEBE7` | 16.7:1 / 11.9:1 |
| Secondary ink | `--muted-foreground` | `#6B6862` (5.5:1 on card, 4.96 on sidebar) | `#A8A49D` (5.7:1 on popover) | descriptions, labels, glyphs at rest |
| Secondary ink on a fill | `--muted-foreground-on-fill` | `#625F59` | `#B4B0A9` | dark: needed, because `#A8A49D` on selected is 4.17 |
| Tertiary (glyph or disabled only) | `--ink-tertiary` | `#8F8B84` (3.4:1) | `#7E7A73` (3.3:1) | never body text |
| Live | `--presence` | `#2D49C9` (unchanged) | `#9AA8F0` | |
| Needs you | `--signal` / `--signal-ink` | unchanged | unchanged | |
| Destructive | `--destructive` | unchanged `hsl(356 72% 42%)` | unchanged | plus `--destructive-wash` .08 / .14 **(new)** |
| Scrim | `--scrim` | `hsl(30 12% 8% / .32)` | `hsl(0 0% 0% / .55)` | raised from .26 (map-popups §4.4) |
| Tooltip | `--tooltip` / `--tooltip-foreground` **(new)** | `#2A2926` / `#F5F4F1` | `#3A3936` / `#F5F4F1` | replaces the raw `hsl(222 9% 12%)` |

### A4. Elevation levels (per surface type)

Light mode separates by shadow. Dark mode separates by **a lighter surface plus a 1px light edge**, with a shadow only to ground the edge. Shadows are cut from a warm `--shadow-ink` (`hsl(30 12% 10%)`), so dark mode never shows a white halo.

| Level | Surfaces | Light | Dark |
|---|---|---|---|
| **e0 flat** | page, sidebar, transcript, messages, artifacts | none | none |
| **e1 contact** | in-flow interactive card on hover only, segmented thumb | `0 1px 2px ink/.05` | `inset 0 1px 0 #FFFDF8/.04` |
| **e2 composer** (`--shadow-composer`, **new**) | composer at rest | `0 0 0 1px ink/.08, 0 1px 2px ink/.04, 0 8px 24px -12px ink/.12` | `0 0 0 1px #FFFDF8/.08, inset 0 1px 0 #FFFDF8/.04, 0 12px 32px -16px #000/.6` |
| e2 composer focus (`--shadow-composer-focus`) | composer, pointer focus | edge ink/.16, throw `0 10px 30px -12px ink/.18` | edge `#FFFDF8/.14` |
| **e3 float** (`--shadow-float`, value change) | menus, selects, popovers, hover cards, toasts, tooltips (tooltip: no edge) | `0 0 0 .5px ink/.12, 0 2px 6px -1px ink/.06, 0 12px 32px -8px ink/.14` (the .5px ring is 1px at dpr 1) | `0 0 0 1px #FFFDF8/.09, inset 0 1px 0 #FFFDF8/.05, 0 12px 32px -8px #000/.55` |
| **e4 modal** (`--shadow-modal`, **new**) | dialogs, sheets, ⌘K | `0 0 0 .5px ink/.12, 0 8px 24px -8px ink/.12, 0 32px 80px -24px ink/.28` | `0 0 0 1px #FFFDF8/.10, inset 0 1px 0 #FFFDF8/.06, 0 32px 80px -20px #000/.7` |

**Retired:** `--shadow-soft`, `--shadow-lift`, `--shadow-glass`, `--shadow-pop`, the `.control-primary` glow, `.cmenu`'s own stack, `--cv2-shadow-pop`, the tooltip's private shadow, and the foreground-tinted computer-screen shadow. Each becomes an alias of the nearest level, and the legacy lint warns on it.

### A5. Type rungs for UI chrome

Faces keep their jobs.
- **Inter** for every control.
- **Newsreader** for the greeting, page h1s, empty-state titles and sign-in.
- **JetBrains Mono** only for code, ids, paths, receipts and keycaps. **Mono no longer sets labels.**

| Rung | Size / line / weight / tracking | Ink | Jobs |
|---|---|---|---|
| `label` (**changed**: mono → sans) | 12 / 16 / 500 / +0.005em | muted | menu section labels, sidebar section heads ("Recent", "Orbit"), eyebrows, badges |
| `ui` (line-height changed: 1.5 → 18px) | 13 / 18 / 400 | muted | **descriptions under item names**, metadata, tooltips, chips, shortcut column, helper text |
| `nav` | 14 / 20 / 400; 500 for buttons | ink | **item names** in menus, sidebar rows, list rows, inputs, buttons, tabs |
| `heading` | 18 / 24 / 600 / −0.01em | ink | dialog and sheet titles, settings group titles |
| `reading` | 16 / 26 | ink | transcript, composer field |
| `page-title` (serif) | 32 / 40 / 400 / −0.015em | ink | page h1 |
| `greeting` (serif, uses `home-title`) | 44 / 52 / 400 / −0.025em (phone 32/38) | ink | the landing greeting |
| `meta` (**new**, mono) | 12 / 16 / 400, tabular | muted | ids, receipts, file sizes ("PDF · 1.2 MB"), keycaps |

**The hierarchy rule.** A row has at most three type steps: a section label (12/500 muted), an item name (14/400 ink) and a description (13/400 muted).
- Weight changes only for buttons (500) and dialog titles (600). **Selection never changes weight.**
- The transcript and composer chrome law (16 / 13 / 12) still holds. The composer's own chips use 13. Floating layers use `nav` 14 for item names; they are not "chrome" under `wave2/transcript-chrome-type`. **Clarification for the rule's doc, not a rule change:** the composer `+` menu is a float.

### A6. Focus ring (keyboard only, every platform)
- **Global.** A 2px `--ring` (ink) outline at a 2px offset, shown only for keyboard modality. High contrast makes it 3px. Forced colours use `Highlight`. This is unchanged.
- **Inside lists, menus, segmented controls and the sidebar,** where an outside ring would clip: the row gets the `--selected` fill **plus** `inset 0 0 0 2px hsl(var(--ring) / .5)`. That inset ring is 3.1:1 against the fill and 3.7:1 against the popover in light, and 3.5:1 / 4.8:1 in dark. It replaces the fill-only cue (1.09:1).
- **Fields.** At rest, an edge of `--field-edge`. On hover, `ink/.24`. On pointer focus, `ink/.40` plus a `--card` fill. **Keyboard focus adds the global ring.** No more 1px field-ring variant.
- **Composer.** Pointer focus uses `--shadow-composer-focus`. Keyboard focus adds a 2px ring at offset 2 that follows the 26px radius through `outline` and `outline-offset`. The `::after` hack goes.

### A7. State fills (one ladder everywhere)

| State | Fill | Ink | Motion |
|---|---|---|---|
| Rest | none | name: ink; glyph and description: muted | — |
| Hover (fine pointer, `(hover:hover)` only) | `--hover` | name: ink; **glyph: ink** | in **0ms**; out 120 out-soft |
| Keyboard highlight | `--selected` + inset ring | as hover | in 0, out 0 (no smear) |
| Pressed | `--selected`; scale .96 only on controls ≤ 44px | — | 70 press, released on `--spring-snap` |
| Selected / on / open trigger | `--selected` | name: ink; description: `--muted-foreground-on-fill` | 0 in navigation (selection is instant) |
| Disabled | no fill | **`--ink-tertiary` for name and glyph** (no opacity on inks) | — |
| Destructive row | none; highlight `--destructive-wash` | `--destructive-ink` | as hover |

Disabled was seven opacities (map-components §4.5). It is now one ink token. Disabled menu items stay focusable and say why in their description line.

### A8. Hit targets

| Context | Minimum |
|---|---|
| Web fine pointer | 32 visible (a 28 kebab gets a 32 hit via `::before`) |
| Web coarse pointer | 44 everywhere. This fixes the 40px task chip. |
| Mac | 28 |
| iOS | 44 |

### A9. Rule changes this direction asks for (owner sign-off)

1. **`--field-border` stops aliasing `--input`.**
   - Text fields rest on `--field-edge` (1.45:1) plus a `--muted` fill and a visible label or placeholder. They reach 3:1 on hover, focus and always in high contrast. `--input` keeps 3:1 for checkbox, radio and the switch-off track.
   - *Why:* the 54% edge is "the heaviest object on the page" (map-components §6.1). Apple, Claude and ChatGPT all identify text fields by fill and placement.
   - *Cost:* a recorded exception row in `scripts/check-contrast-matrix.ts` for field rest edges, mirroring how the muted-on-selected 4.32 failure is recorded.
2. **`text-label` becomes sans.**
   - *Why:* about 720 mono metadata sites read as a dev console (map-components §6.4, map-menus §7.4).
   - *Cost:* visual only. The rung name stays, so Swift `JunoGeneratedType.label` regenerates automatically.
3. **Native icons: SF Symbols for the generic set.**
   - The current rule is "iOS and Mac draw the web's icons, never SF Symbols". The `sficons` gate is a hard zero on iOS and a ratchet on Mac.
   - The proposed rule: **SF Symbols for the 1:1 generic set in §I4, and custom variable-symbol templates only for the 10 Alevr concepts** (galaxy, orbit, agent face, crew, memory, skill, deep field, auto, ghost and the lab logos).
   - *Why:*
     - `JunoIconView` rasterises at a fixed size, so 274 iOS icons ignore Dynamic Type.
     - Mac menus show custom bitmaps at the wrong weight.
     - The native set renders at 0.67× the web's line weight (map-icons S2).
   - **One family is kept by redrawing the web set onto SF proportions:** the same metaphors, round caps and 1.5px line (§B).
   - *Gates:* `sficons` becomes an allow-list fed by the §I4 table, and `symbols` checks that every `Image(systemName:)` is in it.
4. **The phone loses its glass exemption** (`check-native-glass.mjs:31-37`). The allow-list is in §I1.

---

## B. Icons

### B1. Grid and construction
- **Canvas and live area.** The canvas is 24×24 units. The live area is 3–21 (18 units), with round shapes allowed to 2.5–21.5. Nothing may touch the canvas edge. This fixes the S5 overflow on crew, connect, chats and code.
- **Stroke.** It is set in **physical px** (non-scaling), so the weight tracks text rather than box size:

  | Optical size | Line | Detail level | Typical pairing |
  |---|---|---|---|
  | **14** | 1.25px | reduced cut: no inner detail, slash gap 0.75u | 12–13px text, dense metadata |
  | **16** | 1.5px | full drawing | 13–14px text: menus, rows, buttons (default) |
  | **20** | 1.5px | full drawing, more air | composer row, header actions, touch |
  | hero 16 | 2px | send arrow and stop only | inside the 36px ink disc |

  - The stem-ratio rule holds: line ÷ paired Inter stem is 0.95–1.05 for 14px/400 and 13px/500.
  - The 18px size is retired. The about 20 `size-[18px]` call sites go to 20.
  - At dpr 2, 1.5px lands on 3 device px. The 14 cut's 1.25px is drawn on a 0.25u lattice, and its anti-aliasing is accepted, as SF Symbols does.
- **Caps, joins and corners.**
  - Round caps and round joins.
  - Container corners are **r 2.5u below 15u wide and r 3u at 15u and above**, for devices too (`phone` and `tablet` used to be inverted).
  - Continuous corners everywhere: `PAGE`, share, trash and the trays are rebuilt with `rr`.
- **Points.** Dots are radius ≥ 0.6 × line, so 1.35u at 16px. Ellipsis dots are r 1.4u. There are no specks.
- **Gaps.** The house gap is 1.5u, reserved for knockout composites ("New X" plus-at-corner). **Search keeps a joined handle**, as SF's `magnifyingglass` does: a gapped handle at 16px is a 1px speck. Slashed composites get a 0.75u gap and the slash crosses the outline only, so they no longer split into 3–4 fragments at 16px (S8).
- **Fill versus outline.**
  - Outline at rest, always.
  - **Fill means "on"** and is reserved for persistent toggled states: pin (pinned), thumbs (rated), star (favourite), bookmark (saved) and bell (has unread), plus the stop square inside the disc.
  - Selection in navigation never fills a glyph. The row fill carries it, and the glyph ink goes from muted to ink.
- **Baseline alignment.**
  - Glyphs centre on Inter's **cap-height** centre, not the box.
  - Every fit gets a −0.5px vertical offset, and labels in icon rows use `text-box: trim-both cap alphabetic` where supported. This fixes the 0.75px-low bias (S6).
  - Bottom-heavy glyphs (crew, agent, add-member, cloud, cloud-upload, lock, eraser) rise by 0.75–1u in the data. Top-heavy glyphs (auto, diff, thought, chat-question) drop by 1u.
- **Optical mass.** The target coverage band at 24px is 0.20–0.30. Outliers get `optical` multipliers: code ×1.08, diff ×1.12, deep-field ×1.1, end-call ×1.15, key ×1.06. Contrast, library, sheet and citation are lightened.

### B2. Off-style glyphs in today's sheet (`icons-sheet.png`) and the redraw

| Group | Glyphs | What's wrong | Redraw |
|---|---|---|---|
| Lucide-geometry Navigation set | `chat`, `orbit`, `code`, `new-chat`, `search`, `folder`, `folder-open`, `library`, `customize`, `bell`, `sidebar`, `mic`, `voice` | a ninth-unit lattice, plain arcs, no house gap, different traits from their siblings | Rebuilt on the ⅛-unit lattice with the B1 rules. Keep the metaphors, because SF uses the same ones (bubble, magnifier, folder, books, bell, sidebar, mic, waveform). |
| Siblings that never followed | `bell-off`, `mic-off`, `dictation`, `folder-plus`, `folder-move`, `folder-code`, `folder-lock`, `panel-right`, `chat-question`, `chats`, `thought` | three capsules, two folders, four bubbles | Each pair shares one constant: `BELL`, `CAPSULE`, `FOLDER`, `BUBBLE`. `panel-right` = `flipX(sidebar)`. |
| Retired metaphors back in use | `design` (pen nib as the Design destination) | the inner dot closes at 14–16px | The destination becomes square + circle; the nib stays for the path tool only. |
| Mass outliers | `contrast` (.417), `citation` heads, `library` ("lll" at 16), `deep-field` (.137 specks), `diff` (.098), `orbit` (.314 vs code .152) | they jump out of rows or vanish | Contrast: the half-disc is inset by the 1.5u gap. Citation: heads at r 2.1. Library: two books plus one leaning, with no spine line below 20. Deep-field: points r ≥ 1.35. Diff: widened to 13.5u. Orbit: a single satellite. |
| Composites that fragment | `unpin`, `mic-off`, `bell-off`, `disconnect`, `eye-off`, `shield-off`, `image-off`, `offline`, `link-off` | the 1.5u knockout splits them | A 0.75u gap, with the slash over the outline only. `link-off` gets a slash across the gap. |
| Grammar breaks | `new-chat` (square-pen vs "corner plus"), `image-plus` (opens the frame), `apps` (reads "88"), `pdf` (hook label), `collapse` (not a mirror of `expand`), `play`/`pause` (width jump), `end-call` (10u tall), `at` (closed counter) | — | **Square-pen is adopted** as "new conversation" family-wide (it is SF's `square.and.pencil`). "Add X" composites use `ko(plusAt)`. Apps tiles at r 1.5. The PDF label goes inside the page. Collapse diagonal to 19.5,4.5. Pause gets optical 1.15. End-call is redrawn 13u tall. The @ counter inner r goes to 3.75. |
| Vertical bias | `crew`, `agent`, `add-member`, `cloud`, `cloud-upload`, `lock`, `eraser` (low); `auto`, `diff`, `thought`, `chat-question` (high) | 1.3–1.7px off the cap centre | Data-level offsets (B1). |

The mockup's §2 shows 48 glyphs redrawn this way: the 24 required, plus chat, new-chat, sidebar, bell, library, code, sliders, activity, thumbs, branch, skill, apps, info, warning, error, success, chevrons, arrow-up-right and sun/moon.

### B3. Icon-button sizes

| Button | Glyph | Hit target | Use |
|---|---|---|---|
| 24, `xs` | 14 | 32 (`::before`) / 44 coarse | inline in chips (remove ✕), toast close |
| 28, `sm` | 16 | 32 / 44 | row kebab, card header, message action row |
| 32, `md` (default) | 16, or 20 in the composer | 32 / 44 | toolbars, composer `+` and mic (round) |
| 36, `lg` | 20 | 36 / 44 | dialog ✕, page header actions, the primary disc (16 hero glyph) |

- **Shape.** Composer and transcript controls are **round** (they live inside a 26 surface). Everything else is an **8px rect**. This is one rule instead of the 68-circle / 156-rect split.
- **Press feedback.** Press scales the *button*, never the SVG (map-icons §5.4). Hover articulation is dropped entirely; icons do not move.

---

## C. Components (web values; native twins in §I)

### C1. Buttons
- **Shared.** Radius **8 at every size**. `nav` 14/500. Glyph 16 with an 8px gap. **No shadows on any button.**
- **Press.** Scale .97 for ≤ 160px wide and .985 above, at 70ms, released on `--spring-snap`.

| Variant | Rest | Hover | Pressed | Disabled |
|---|---|---|---|---|
| Primary | fill `--primary` (ink), text `--primary-foreground` | fill `color-mix(ink 88%, card)` (**new token `--primary-hover`**) | `ink 80%` | fill `--muted`, text `--ink-tertiary` (no shadow, no opacity) |
| Secondary | fill `--card`, **1px `--border-strong`** | fill `--hover`, edge ink/.20 | `--selected` | edge `--border`, text tertiary |
| Ghost | none | `--hover` | `--selected` | text tertiary |
| Destructive (confirm only) | fill `--destructive`, white text | `destructive 90%` | `80%` | as primary |
| Destructive-quiet (menus, inline) | none, text `--destructive-ink` | `--destructive-wash` | wash ×1.6 | — |

| Size | Height (coarse) | Padding-x | Use |
|---|---|---|---|
| sm | 28 (44) | 10 | inline cards, toast actions |
| md | **32** (44) | 12 | default, page headers |
| lg | 36 (44) | 16 | dialog footers, empty states, sign-in (48 on sign-in only) |

*Change:* the primary loses its three-layer glow and its invisible `brightness(1.06)` hover. Secondary is no longer identical to outline; "outline" is retired into secondary.

### C2. Icon buttons
See B3. Ghost by default. On hover the glyph goes muted → ink. A toggle (`aria-pressed`) uses `--selected` and keeps the outline glyph, unless the concept has a fill state.

### C3. Segmented control
- **Track:** `--muted` fill, no border, radius 10, inset 2, height 32 (sm 28).
- **Thumb:** `--card` with e1, radius 8. In dark the thumb is `--popover` with a 1px `#FFFDF8/.08` edge.
- **Labels:** 13/500. Inactive muted, active ink.
- **Motion.** The thumb slides on `--spring-standard`; **squash is deleted**. Labels cross-fade 120.
- **Keyboard:** arrows move selection. The focus ring is inset on the thumb.

### C4. Switch
- **Geometry.** Track 32×18 (iOS proportion), radius full. Thumb 14 with a 2px inset.
- **Colours.** Off track: `--input` at 35% mix with `--muted` (visible, not 54% grey). On: `--primary`. The thumb is `--card` with `0 1px 2px ink/.18`.
- **Motion.** The thumb travels 14px on `--spring-standard`; the track colour runs 120 out-soft. There is no squash.
- **Settings rows.** The whole row is the hit area, and the accessible name is the title only.

### C5. Checkbox and radio
- **Size.** 16 boxes with a 24 hit (44 coarse). Checkbox radius 4 (`sm`); radio full.
- **Rest.** Edge 1.5px `--input` (3.5:1) on a `--card` fill.
- **Checked.** `--primary` fill with a `--primary-foreground` mark. The tick is a 1.75px stroke drawn by `stroke-dashoffset` over 120 out-soft. The radio dot is 6px and fades and scales from .9 over 120.
- **Hover.** The edge goes to ink/.6. Indeterminate is a 8×1.75 bar.

### C6. Inputs, textarea and search
- **Field.** Height 36 (44 coarse), radius 10, `--muted` fill, 1px `--field-edge`. `nav` 14 text. Padding-x 12; a leading search glyph 16 at x=12 puts the text at 36.
- **States.** Hover edge ink/.24. Focus edge ink/.40 and fill `--card`. Keyboard: the global ring. Invalid: the edge is `--destructive` and a 13/18 message sits below with a 14 circle-x.
- **Textarea.** min-h 80 (on grid), padding 10/12, grows to 8 lines.
- **Search.** The same field with a ⌘K hint at the right: `ui` 13 muted, no keycap box. It is one search field (the settings rail's borderless r8 search is retired).

### C7. Chips, pills and badges
- **Mode token (armed tool in the composer).**
  - Height 28, radius full, `--hover` fill, 13/500 ink.
  - Glyph 16, plus an ✕ 14 that appears on hover and is always visible on coarse pointers.
  - Its name is "Web search, remove". Coarse hit 44.
- **Filter chip:** height 28, radius full, 1px `--border-strong`, 13/400. Selected: `--selected` fill with no edge.
- **Badge:** height 20, radius 6, padding 0/6, `label` 12/500, tabular. Neutral is `--muted` with ink-2; live is presence/10 with `--presence` ink. **No mono.** The `soft` fill bug (`bg-primary/12` not generated) disappears.
- **Count dot:** 6px, presence only for live.

### C8. Tabs
- **Level-2 navigation** uses an underline tab: `nav` 14, height 36, gap 20, inactive muted, active ink. The bar is 1.5px ink, radius full, spanning the **text width only**, and moves on `--spring-standard`. The list sits on a 1px `--border` baseline.
- **Panels** cross-fade: out 70 → in 120, with height animated via `Collapse` (grid-rows).
- **CustomizeNav's boxed tabs** become this underline.

### C9. Tooltips
- **Geometry.** `--tooltip` fill, radius 8, padding 6/8, `ui` 13/18 with `--tooltip-foreground`. Max width 240. The shortcut is `ui` muted (`#B9B5AE`) after an 8px gap. No keycap box.
- **Timing.** Delay **400**, skip window **300** (§G).
- **Hygiene.** No native `title=` anywhere. `IconButton`'s default `title` is removed.

### C10. Avatars
- **Sizes:** 20 / 24 / 32 / 40 / 64, circle, **no border, no shadow**.
- **Fallback.** A `--muted` fill with ink-2 initials in Inter 500 at **40% of the diameter** (8 / 10 / 13 / 16 / 26). It is not mono.
- **Presence.** An 8px dot with a 2px ring in the ground colour.

### C11. List rows
- **Single line:** 36 tall, radius 8, padding 0/12, a 16 glyph at x=12, the name at x=38.
- **Two-line:** 52 tall (name 14/20 + description 13/18 + 2+4 padding).
- **Trailing slot:** one only (meta 13 muted *or* chevron 14 *or* kebab on hover).
- **Rows are bare until hover** (PREMIUM_AUDIT §3).
- **Library rows** become 52 two-line rows with a 32 thumb (r 6). The square full-bleed selection is retired.

### C12. Cards
- **In-flow card:** `--card`, **either** a 1px `--border` **or** a `--muted` fill, never both. Radius 12, padding 16.
  - Interactive card on hover: e1 plus edge ink/.14, with no lift.
- **Well:** `--muted`, no border, radius 12. Used by approval and question cards, code blocks and the thought panel.
- **The five card materials collapse to these two.** Approval, work-run and routine cards move from radius 10 to 12.

### C13. Sidebar rows
- **Row.** 32 tall (44 coarse), radius 8, inset 8 from the column edge. Glyph 16 at x=16+8 and label at x=50. `nav` 14.
- **States.** Hover `--sidebar-hover`. Selected `--sidebar-selected` (instant) with an ink label; the glyph goes muted → ink.
- **Section heads.** "Recent", "Orbit" and "Pinned" use `label` 12/500 muted (sans, not mono). They are 28 tall with 16 above, and fold on click with a 12 chevron that rotates over 120.
- **Trailing.** Pin glyph 14 muted, *or* run dot 6 (presence), *or* kebab 28 on hover. One at a time.
- **New chat** is an ordinary row; there is no 40pt "prominent" row.

### C14. Skeletons and spinners
- **Skeleton.** A `--muted` bar with radius 6. Line heights match the text they stand in for (12/14/16 bars at 60% of the line). The breathe loop keeps the existing opacity 1 → .62 over 1.8s.
- **Gating:** shown after `--delay-show` 200, held for at least `--hold-skeleton` 400, and cross-faded to content over 120/160.
- **Spinner.** Only inside the pressed button: a 16 ring, 1.5px, ink at 25% track with an ink 90° arc, 0.8s linear.
- **The galaxy** is the working mark for agents and runs only.

### C15. Progress
- **Bar.** Track 4px `--muted`, radius full. The fill is `--primary`, or `--presence` while live. It moves by `transform: scaleX` from the left over 220 out-calm.
- **Indeterminate.** A 30% segment sweeps across over 1.2s on `--ease-breathe`.
- **Upload ring.** 16px, 1.5px stroke, `stroke-dashoffset`.
- **One progress look.** The library's 2px width-animated bar is retired.

---

## D. Menus: one system

### D1. The shell (dropdown, context menu, submenu, select list, popover list, model picker, composer menus, palettes)

| Property | Value |
|---|---|
| Material | `--popover`, e3 `--shadow-float`. Dark adds a 1px `#FFFDF8/.09` edge plus a top inset highlight. **Opaque, no blur.** |
| Radius | **14** |
| Inset | **6**. The first and last rows sit 6 from the edge. |
| Width ladder | **240** (`w-60`, verb menus), **288** (`w-72`, menus with descriptions or a search), **340** (model picker, two-line). Selects match the trigger width with a minimum of 160. Nothing else. |
| Max height | `min(var(--radix-…-available-height) − 8, 480)`. The select list is capped at 320. |
| Scroll | `overflow-y: auto; overscroll-behavior: contain`, plus **16px edge fades** (popover → transparent masks) shown only when there is more content in that direction. No arrow buttons. |
| Offsets | trigger gap `sideOffset 6`; `collisionPadding 8`; composer menus `sideOffset 8`, opening **up**, and they never cover the composer |
| z | `z-popper` 55 |

### D2. The row

| Part | Value |
|---|---|
| Height | **36** single line; **52** with a description; 44 on coarse pointers |
| Padding | 0 / 10 |
| Columns | `[16 lead slot] 10 gap [name / description, flex] 12 gap [trailing slot]` |
| Lead slot | 16 glyph in muted ink, going to ink with its row. **Icons are all-or-none per group**, and groups without icons keep no empty slot. User-named items (projects, skills) have no glyph. |
| Name | `nav` 14/20/400, ink, truncated with an ellipsis |
| Description | `ui` 13/18 muted, under the name with a 0px gap; on-fill ink when highlighted |
| Trailing slot | **One** of: shortcut (`ui` 13 muted, tabular, modifier order ⌃⌥⇧⌘, no keycap), submenu chevron (14, muted, 75% → 100% when open), check (16 ink), switch (28×16 mini, inline toggles that keep the menu open), value text (13 muted) |
| Radius | 8 (14 − 6) |
| Highlight | `--hover` (light ink .06, dark `#FFFDF8` .075), **instant in, 120 out**. It does not glide (the `.cmenu` glide animated width/height). Text colour does not change. |
| Keyboard highlight | `--selected` plus the `inset 0 0 0 2px ring/.5` ring |
| Press | tonal (`--selected`), no scale |

### D3. Selection grammar (one, everywhere)
- **Single choice** (radio): a **trailing 16 check in ink**. The name does not change weight or colour, and there is no dot, bar, filled row or coloured label.
- **Multiple choice:** the same trailing check (`menuitemcheckbox`).
- **Binary setting that should not close the menu:** a trailing mini switch, 28×16 (thumb 12). Used for Web search and Memory in `+`. Clicking toggles it and **the menu stays open**.
- **Select (form control):** the same trailing check, and the trigger shows the value.
- **Defaults** are tagged with a `ui` 13 muted "Default" in the description line, not mono.

### D4. Section labels and separators
- **Label:** `label` 12/500 muted, padding 8/10/4 (top 8; the first group gets 4). Sentence case. Use one only when a group needs naming (Apple: "seldom").
- **Separator:** 1px `--border`, **inset 10px** (aligned to the row text inset, not full bleed), with 6px vertical margin. At most three groups in a context menu.

### D5. Destructive items
- **Always last**, after a separator, with `--destructive-ink` for the name and glyph and a `--destructive-wash` highlight.
- An irreversible one ends with "…" and opens the destructive confirm (§E2).
- **Never mid-menu.** The design context menu moves Delete to the end.

### D6. Submenus

| Property | Value |
|---|---|
| Depth | **one level** only; at most about 5 items, beyond which the submenu becomes its own menu |
| Trigger | a normal row with a trailing chevron. **The trigger never runs a command.** It keeps the `--selected` fill while its submenu is open. |
| Open | **hover intent 100ms** (`--delay-submenu`), or click, → or Enter. Keyboard opens instantly and focuses the first item. |
| Safe triangle | Radix grace polygon from the pointer (5px bleed) to the submenu's near corners, valid **300ms** (`--hold-submenu-grace`) while the pointer keeps moving toward it. The mockup implements this exactly. |
| Placement | `side=right`, **`sideOffset 4`**: a 4px visible gap, so the two shadows never smear into each other. **`alignOffset −6`** (the 6 inset; −7 if a shell keeps a 1px layout border), so the submenu's first row lines up with the trigger row (it sat 7px low before). The edge is a box-shadow ring, not a layout border. |
| Side flip | when the right side lacks width + 8, the submenu opens left, and its travel direction flips |
| Close | ← or Esc closes only the submenu and returns focus to the trigger. Pointer leaving both, or the grace expiring, closes it after 0ms. The parent never closes because a child does. |
| Phone (<640) | drill-in in place: the pane slides 16px with a cross-fade, and a "‹ Back" row sits at the top |

### D7. Selects and comboboxes
- **Trigger.** A field (36, r 10) with the value in `nav` 14 and a chevrons-up-down 14 muted at the right, with no rotation. On open the trigger goes to its focus state.
- **List.** The D1 shell, sized to the trigger width. The selected item scrolls into view and is **aligned over the trigger** when it opens below (macOS `item-aligned`) or in a pop-up.
- **Combobox.** The same shell with a 40px search row at the top (16 glyph, `nav` 14 input, 1px `--border` under it). Results filter as you type. ↑↓ wrap, Home/End work, and Enter commits.

### D8. Model picker (composer chip → one picker everywhere)

```
┌ 340 ────────────────────────────────────┐
│ ⌕ Search models                         │ 40 search row (only if >8 models)
│─────────────────────────────────────────│
│ Recommended                             │ label 12/500
│ ✦  Auto                              ✓  │ 52 row: name 14 + desc 13
│    Picks the right model for each turn  │
│ ◐  Alevr Pro                            │
│    Deepest reasoning · slower           │
│ ◌  Alevr Fast                           │
│    Quick answers, lower cost            │
│─────────────────────────────────────────│
│ Thinking                     ●──  On    │ 36 row with inline switch (stays open)
│ Effort                    High  ›       │ 36 row → submenu: Low / Medium / High ✓ / Max
│─────────────────────────────────────────│
│ More models                        ›    │ → submenu by lab (logos 16 in 16 tile r6)
└─────────────────────────────────────────┘
```

- The trailing check is the only selection mark. Lab logos are 16 in the lead slot.
- "Effort" is a submenu of radio items. Thinking is an inline switch.
- The 640×500 three-pane catalogue is retired from the composer. "More models ›" opens the lab submenu, and the full catalogue lives in Settings › Models.

### D9. The composer `+` menu
- **Width and placement.** 288, opening up and aligned to the `+` start. **The `+` glyph does not rotate**: it cross-fades to ✕ only while the menu is open, over 120.
- **Group 1:** Add photos and files ⌘U · Take a screenshot · Add from library.
- **Group 2:** Web search [switch] · Memory [switch] · Deep research [switch].
- **Group 3:** Project › · Apps › · Skills › (submenus with search).
- These are the shell-contract rows, unchanged in ids. The visual kind changes from switch-or-tick to the D3 grammar.

### D10. The message action menu (⋯ under an answer)
- **Width and contents.** 240. Copy ⌘C · Copy as Markdown · Read aloud · Branch from here › · Export › · separator · Report a problem.
- **Retry.** A split button: the retry glyph runs; its 12 chevron opens "Try again with…" (the model list, D8 rows without descriptions).

### D11. Sidebar row menu (kebab and right-click)
- **Width and contents.** 240. Rename · Pin (check when pinned) · Add to project › · Share… · separator · Delete…
- **Opening.** Right-click, Shift+F10 or long-press open **the same items at the pointer** (Shift+right-click keeps the browser's menu).

### D12. Command palette (⌘K)
- **Shell.** Modal shell e4, radius 16, width 640, top 12vh.
- **Search row.** 52: a 20 glyph and `body` 15 input, with 1px `--border` under it.
- **List.** Rows of 40 with a 16 glyph, `nav` 14 name and `ui` 13 muted meta on the right. Group labels are `label` 12 with 12 above. The cursor is `--selected` with the inset ring, moving **instantly**; the spring pill is retired.
- **No footer.** ↑↓ wrap, Home/End, Enter, Esc.
- **Motion.** Opened from the keyboard it appears in 0ms; from the pointer it fades in over 120 with no travel.

### D13. Search inside menus
- **Placement.** The first row is a 40 search field (no box, a `--border` underline). Focus lands there on open with a fine pointer only.
- **Typing** filters with no animation, and the highlight moves to the first match.
- **Empty state.** One 36 row in muted ink: "No matches for ‘…’".

### D14. Slash and @ palettes
- **Shell.** The D1 shell at 340. Anchored to the composer's text column (x = composer left + 16), opening up in the dock and down on the landing, with an **8px gap**.
- **Rows.** 36 (52 with description). The name is in `nav` sans; `/command` is set in `meta` mono only in the trailing slot.
- **No keycap footer.** Motion is the menu recipe (§G1), not a cut.

---

## E. Pop-ups

### E1. Dialogs (modals)

| Property | Value |
|---|---|
| Material | `--modal`, e4, radius 16, `--scrim` behind |
| Widths | **confirm 400**, **form 520**, **workspace 880**, full screen. The 13 widths in use collapse to these. |
| Anatomy | A **3-row grid** (`auto / minmax(0,1fr) / auto`). Header and footer are pinned; only the body scrolls, with 16px edge fades. |
| Header | padding 20/24/0. Title `heading` 18/24/600. Description `nav` 14/20 muted, 4 below the title. **✕ 32 round ghost at top 14 / right 14**, vertically centred on the title's first line, in the header row (flex, not absolute). The title gets right padding 40. |
| Body | padding 16/24 |
| Footer | padding 16/24/20. Buttons lg (36) end-aligned, gap 8: **Cancel (secondary) then primary**. A hairline shows only when the body is scrolled under it. On a phone: stacked full width, primary on top, 44. |
| Default button | Return fires the primary, except in destructive confirms. Esc cancels. |
| Focus | first field, else the primary, else Cancel (destructive). Focus returns to the opener (`useDialogFocusReturn` everywhere). |
| Busy | The primary shows its spinner and keeps its label. Esc, the ✕ and the scrim are locked while busy. |

### E2. Confirm and destructive dialogs (a new `ConfirmDialog` primitive)
- **Layout.** Width 400, with no ✕ (Cancel and Esc are the exits).
- **Copy.** Title as a question: "Delete ‘Q3 forecast’?". Description: the consequence in one or two lines, in muted ink.
- **Footer.** Cancel (secondary), then **Delete** (destructive fill).
- **Focus.** It lands on **Cancel**. Return does nothing until the person moves focus.
- **Role.** `role="alertdialog"`, so outside clicks do nothing.
- **Optional glyph.** A 40 circle tile in `--destructive-wash` with a 20 warning glyph, sitting above the title for irreversible deletes only.

### E3. Sheets and drawers
- **Bottom sheet (phone, below 640): one engine.** It replaces `sheet.css`, `bottom-sheet.tsx` and cv2.
  - Material: `--modal`, top radius 16, e4.
  - **Grabber:** 36×5, radius full, `ink/.18` (dark `#FFFDF8/.22`), 6 from the top, inside a 20px pinned header band.
  - Detents: **medium** (50dvh) and **large** (`100dvh − safe-top − 12px`). Content-height sheets snap to their height.
  - The header is pinned: title `heading` 17/22, and **Close** (text button, trailing) or ✕.
  - **Drag from anywhere** while the content is scrolled to the top. It follows keyboard insets.
- **Side sheet (desktop).** Width **400**, inset 8 from the window edges, radius 16 on all corners, e4. It has the same header as a dialog.
- **The nav drawer** stays edge-attached at 280 / 85vw with inner corners at 16.

### E4. Popovers and hover cards
- **Popover:** the D1 material, padding **12** for content (6 for lists), widths 288 / 340.
- **Hover card** (source chips, citations, people):
  - One component on Popover. Width 320, padding 12.
  - Host line `ui` 13 muted with a 16 favicon. Title `nav` 14/500. Snippet `ui` 13, three lines.
  - **Open intent 300ms** (`--delay-hovercard`), close grace 150 (`--hold-hovercard`).
  - Keyboard: Enter or ↓ on the trigger moves focus in. It replaces the `.cite-card` tooltip hack.

### E5. Toasts (one family; the memory notice becomes a toast)
- **Position.** Bottom centre, **16 above the composer** (`calc(var(--composer-h) + 16px)`, with `--composer-h` actually published), else 24 from the bottom. On a phone: above the composer, full width minus 24.
- **Card.** The D1 material, radius 14. Width **min(420, 100vw − 32)**, padding 10/12/10/14.
  - Glyph 16 (status ink).
  - Message `nav` 14 ink, then an optional description `ui` 13 muted.
  - Action: a ghost sm (28) button in 13/500.
  - ✕ 24 at the right.
- **Stack.** At most 3, **always expanded** (no hidden deck), gap 8, newest at the bottom. A 4th pushes the oldest out.
- **Lifetime.** `--hold-toast` 5000; **8000 with an action** (Undo). Hover or focus pauses all of them. Alt+T focuses the region. Applied at `--z-toast` 70 (not sonner's 999999999).

### E6. Banners
- **Layout.** Full-width strip at the top of the content card, 40 tall, `--muted` fill, a 1px `--border` bottom edge. Glyph 16, `nav` 14 text, one text action, ✕.
- **Tones.** Only attention (offline, limit) and info. They are never used for success.

### E7. Inline alerts
- **Card.** A well (radius 12, `--muted`), padding 12/14, a leading 16 status glyph in its ink, title `nav` 14/500, body `ui` 13.
- **No coloured washes**, except destructive, which gets `--destructive-wash` plus a destructive glyph and the word ("Failed").

### E8. Empty states
- **Layout.** Centred, max width 360. The dot-matrix mark is 160×60 at `ink/.12`.
- **Type.** Title **Newsreader 24/30 400**. Description `nav` 14/20 muted, 8 below.
- **Action.** One primary (md 32), 20 below. No panel box.

---

## F. Composer

### F1. Anatomy (one shell: landing = dock)

```
 ┌───────────────────────── 26 radius, --card, e2 ─────────────────────────┐
 │ [attachment chips row]  inset 16, gap 8, top 16          (if any)       │
 │ Ask anything                     ← field: reading 16/26, inset 16/16/4/16│
 │                                                                          │
 │ (+)  [Web search ✕]                    Auto ⌄   (mic)   (●↑)            │
 └──────────────────────────────────────────────────────────────────────────┘
   controls row: height 52, every control centre 26 from the bottom and side
```

| Part | Value |
|---|---|
| Width | **one width for landing and dock**: `min(100%, 48rem − 2·gutter)` = 704. The 660px grid track at ≤1200 is removed, so the box never jumps on first send. |
| Surface | `--card`, e2 (`--shadow-composer`, which **includes the 1px edge as a ring**), radius 26. Dark: `--card` `#262523` on `#1E1D1C`. |
| Field | `reading` 16/26, padding 16 top / 16 sides / 4 bottom. min-h 46 (dock) **and landing** (no 56px dead band). Placeholder muted: landing "Ask anything", dock "Reply…" (the copied Claude line is dropped). |
| Growth | animates height **120 out-soft per line** (the documented exception), snaps when more than 3 lines change at once (paste). Cap 10 lines desktop, 6 phone, then scrolls inside with 12px fades. |
| Controls row | height 52, padding 0/10/10/10. Leading: `+` (32 round) · armed mode tokens (28 pills, gap 6). Trailing, gap 8: model chip · mic (32 round) · primary disc (36). |
| `+` | 32 circle, ghost, glyph **20** at 1.5px, muted → ink on hover. It does not rotate; ✕ cross-fades while the menu is open. |
| Model chip | **height 32, radius full**, padding 0/10/0/12. Name `ui` **13/500** ink-2 → ink on hover, plus a 12 chevron (the dedicated disclosure cut, same ink). There is no logo on Auto and a 16 lab logo for named models. Hover: `--hover`. Open: `--selected`. Max width 220, truncating the name first. |
| Mic (dictate) | 32 circle ghost, glyph 20. Hidden on a phone when the field has text (the disc carries voice). |
| Primary disc | **36 circle, always `--primary` ink**. There is no grey voice disc, so it is the strongest object on the row. Faces: **voice** (waveform 16, 1.5px) when empty, **send** (arrow 16 @ 2px) with text, **stop** (rounded square 10, r 2.5) while streaming. Disabled send (uploading): `--muted` fill with a tertiary arrow, and a tooltip naming the blocker. |
| Inks | glyphs and the model name share **one** muted ink at rest (`--muted-foreground`). The `--icon-muted`-darker-than-label split is removed. |

### F2. States

| State | Treatment |
|---|---|
| Rest | e2 |
| Pointer focus | `--shadow-composer-focus` (edge ink/.16, a slightly deeper throw); edge and shadow change **together over 120** |
| Keyboard focus | the above plus a 2px ring at offset 2 following radius 26 |
| Streaming | **nothing dims.** The field stays live (Enter queues), `+`, the chip and mic stay at full ink, and only the disc becomes stop. This replaces three opacities on one row. |
| Armed modes | removable pills after `+`: "Web search ✕", "Deep research ✕". Persistent across sends until removed. |
| Private | the surface edge goes dashed-free: a 1px `--border-strong` plus a "Private" pill with the ghost glyph in the leading cluster (dashes on a squircle draw unevenly) |
| Drag over (window-level) | **One** change. A full-window scrim of `--canvas` at 80%, with a centred 2px dashed `ink/.24` drop target, radius 26, the size of the composer + 120px tall, holding "Drop files to attach" (`nav` 14) and a 20 attach glyph. The composer itself only gets its focus edge. No primary ring, no triple outline. |
| Quota | an inline well **inside** the composer's top (radius 26 − 10 = 16, margin 10), not an 8px rectangle on top of a squircle |

### F3. Attachment chips (above the field, inset 16, gap 8)

| Kind | Geometry | States |
|---|---|---|
| **Image** | 56×56 tile, radius 12, `object-fit: cover`, 1px `ink/.08` inner edge | **Uploading:** a 16 ring with a 1.5px stroke centred on a 40% `--card` veil, progress by stroke-dashoffset. **Error:** a destructive 1.5px inner edge, a centred 16 retry glyph button, and "Retry" in the tooltip. |
| **File** | height 56, max width 240, radius 12, `--muted` fill, no border. A 32 tile (r 8, `--card`) with a 16 type glyph, then the name `nav` 14/20 ink (one line, middle-truncated) over meta `ui` 13 muted ("PDF · 1.2 MB") | **Uploading:** the meta reads "Uploading · 42%" and a 2px progress line runs along the bottom inside the radius. **Error:** meta "Couldn’t upload · Retry" in `--destructive-ink`, with Retry as a link. |
| **Remove** | a **20 circle badge on the top-right corner** (offset −6/−6), `--primary` fill with a 12 ✕ in `--primary-foreground` and a 2px ring in `--card`. Shown on hover and focus; always on coarse pointers with a 44 hit. | — |

### F4. Slash and skill menu
- **Layout.** See D14. Skills show their name plus a one-line description. Typing filters.
- **Arming.** Tab or Enter arms the skill as a mode pill (F1); it is not overlaid text-indent.

### F5. Mobile (390px)
- **Placement.** The composer is docked at the bottom, inset 8 from the sides and 8 + safe-area from the bottom, radius 26.
- **Field.** 16px text (no zoom). Grows to 6 lines.
- **Row.** `+` 44 hit (32 visual), the chip collapses to its 13 name with no chevron, and the disc is 36 in a 44 hit. The mic hides when the field has text.
- **`+` opens a bottom sheet**, not a dropdown. Medium detent, grabber, title "Add to chat".
  - A photo strip: four 72 tiles plus "All photos".
  - Then D9's rows at 48 tall with 20 glyphs, the switches inline, and submenus drilling in with a "‹ Back" row.
- **The model chip opens the D8 picker as a sheet** at the medium detent.

---

## G. Motion: step-by-step storyboard

### G0. Vocabulary (all on the closed ladder 70/120/160/220/360/560; no blur; no backdrop-filter)

| Curve token | Value | Job |
|---|---|---|
| `--ease-out-soft` | (0.33, 1, 0.68, 1) | opacity, colour, small fades |
| **`--ease-out-calm`** (rename of `--ease-spring`, kept as alias) | (0.22, 1, 0.36, 1) | every 2–4px travel; soft deceleration, no overshoot |
| `--ease-in` | (0.4, 0, 1, 1) | every exit |
| `--ease-in-out` | (0.65, 0, 0.35, 1) | A→B moves of chrome (sidebar fold) |
| `--ease-out-strong` (`--ease-drawer` becomes its alias) | (0.32, 0.72, 0, 1) | sheets and side panels (long travel) |
| `--spring-snap` | 0.18s / bounce 0 | highlight jumps, press release |
| `--spring-standard` | 0.22s / 0.05 | thumbs, tab bar, send ⇄ stop, toast re-stack |
| `--spring-layout` | 0.36s / 0 | sheet settle, composer handoff |

**Retired:** `--ease-out-back` (no overshoot anywhere), squash-and-stretch, the `.cmenu` content fill-in after 70ms, the 1.08 icon hover scale, and the 0.5 face-swap scale.

**Spring consolidation:** `reward` 0.36 / 0.18 → **0.30 / 0.08**; `articulate` 0.22 / 0.15 → **0.22 / 0.08**. The bounce limit is ≤ 0.10.

**The rules**
1. Opacity is faster than travel. **Opacity runs 120 while travel settles over 220 on out-calm**, so things are readable at once and soft at rest.
2. Travel is 2–4px, from the trigger side (`transform-origin` = the Radix popper origin).
3. Exits take the rung below their entrance, on `ease-in`, with half the travel.
4. **Keyboard-opened layers appear in 0ms.**
5. Hover fills appear in 0ms and leave over 120.
6. Every transition is a CSS **transition**, not a keyframe (using `@starting-style` for entry), so a mid-flight reversal retargets from the current value. Framer uses the same values.
7. **Reduced motion** (all three tiers via `--motion-shift` / `--motion-scale-from`): travel becomes 0, scale becomes 1, and **opacity and colour are kept** at the same durations. Loops stop. Springs become out-soft 120.

### G1. Storyboard

Key: **t** = start offset from the trigger event (ms). **Dur** = the duration token. **Origin** = transform-origin. RM = reduced motion. SwiftUI = the native twin. For any curve not named under SwiftUI, use `JunoMotion` with the same token name.

| # | Interaction | t | Element | Property: from → to | Dur | Curve | Origin | Interruption | RM | SwiftUI |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.1 | **Menu open** (pointer) | 0 | trigger | fill none → `--selected`; chevron 0° → 180° (chips) | 0 / 120 | — / out-soft | — | — | fill kept; chevron instant | system `Menu` (native morph) |
| 1.2 | | 0 | panel | opacity 0 → 1 | **120** | out-soft | — | retargets from current opacity | same | — |
| 1.3 | | 0 | panel | translateY ∓4px (toward the trigger) → 0 | **220** | **out-calm** | popper origin | retargets | 0px | — |
| 1.4 | | 0 | rows | ride the panel; **no stagger, no fill-in** | — | — | — | — | — | — |
| 1.5 | **Menu open** (keyboard: Enter, Space, ↓, Shift+F10) | 0 | panel | appears complete; the first row gets the keyboard highlight | 0 | — | — | — | same | — |
| 1.6 | **Menu close** (Esc, outside, choose) | 0 | panel | opacity 1 → 0; translate 0 → ∓2px | **70** | in | popper origin | reopening reverses from current | opacity only | — |
| 1.7 | | 0 | trigger | fill → none; chevron → 0° | 120 | out-soft | — | — | — | — |
| 1.8 | | 0 | chosen row | keeps its highlight through the 70ms exit (no blink) | — | — | — | — | — | — |
| 2.1 | **Submenu open** | 0 | trigger row | fill → `--selected` (instant); the chevron goes 75 → 100% | 0 | — | — | — | same | system submenu |
| 2.2 | | 100 (`--delay-submenu`) | submenu | opacity 0 → 1 | 120 | out-soft | — | the timer cancels if the pointer leaves the trigger *not* toward the submenu | same | — |
| 2.3 | | 100 | submenu | translateX −4px (from the parent side; +4px when flipped) → 0 | 220 | out-calm | left-centre (right-centre when flipped) | — | 0 | — |
| 2.4 | **Safe triangle** | on leave | pointer polygon | grace valid while moving inside the triangle (5px bleed) | ≤ **300** (`--hold-submenu-grace`) | — | — | a sibling row hovered after grace expires replaces the submenu | same | — |
| 2.5 | **Submenu close** | 0 | submenu | opacity → 0, no travel | 70 | in | — | — | same | — |
| 3.1 | **Select an option** (model picker) | 0 | row | fill → `--selected` (press, tonal) | 70 | out-soft | — | — | same | — |
| 3.2 | | 0 | old check | opacity 1 → 0 | 70 | in | — | — | same | — |
| 3.3 | | 0 | new check | opacity 0 → 1 (scale .9 → 1 when motion is allowed) | 120 | out-calm | centre | — | opacity | `.contentTransition(.opacity)` |
| 3.4 | | 0 | menu | close (1.6), no extra hold | 70 | in | — | — | — | — |
| 3.5 | | 0 | chip label | old opacity → 0 and translateY 0 → −2 (70, in); new opacity 0 → 1 and translateY 2 → 0 (120, out-calm). The width snaps at 70. | 70 / 120 | in / out-calm | — | — | opacity | `.contentTransition(.interpolate)` + `.animation(.smooth(duration: 0.22))` |
| 4.1 | **Dialog open** | 0 | scrim | opacity 0 → 1 | 220 | out-soft | — | — | same | `.sheet` / `.alert` (system) |
| 4.2 | | 0 | panel | opacity 0 → 1 | 120 | out-soft | — | retargets | same | — |
| 4.3 | | 0 | panel | translateY 4px → 0, scale .985 → 1 | 220 | out-calm | centre (from a menu: the menu's origin) | — | 0 / 1 | — |
| 4.4 | | 0 | focus | moves to the initial focus target | 0 | — | — | — | — | — |
| 4.5 | **Dialog close** | 0 | panel | opacity → 0; translateY 0 → 2px; scale → .99 | 120 / 160 | in | centre | — | opacity | — |
| 4.6 | | 0 | scrim | opacity → 0, ending 40ms after the panel | 160 | in | — | — | same | — |
| 5.1 | **Bottom sheet open** | 0 | scrim | 0 → 1 | 220 | out-soft | — | — | same | `.presentationDetents([.medium,.large])` |
| 5.2 | | 0 | sheet | translateY 100% → detent (stays opaque) | **360** | out-strong | bottom | grab mid-flight: the finger takes over at the current y | **fade 0 → 1 over 160, no travel** | `.presentationBackgroundInteraction` |
| 5.3 | **Sheet drag** | live | sheet | y = finger (1:1); above the top detent, rubber-band at 0.55 resistance | — | — | — | — | same | system |
| 5.4 | | live | scrim | opacity = 1 − progress × 0.8 | — | — | — | — | — | — |
| 5.5 | **Release → dismiss** (velocity ≥ 0.5 px/ms down, or offset ≥ 30%) | 0 | sheet | y → 100% | clamp(distance / velocity, `--settle-min` 140, `--settle-max` 300) | out-soft | — | — | fade 120 | — |
| 5.6 | **Release → snap back** | 0 | sheet | y → nearest detent | `--spring-snap` | spring | — | — | instant | — |
| 6.1 | **Toast in** | 0 | toast | opacity 0 → 1 | 120 | out-soft | — | — | same | `JunoToastHost` |
| 6.2 | | 0 | toast | translateY 4px → 0 | 220 | out-calm | bottom | — | 0 | `.transition(.opacity.combined(with: .offset(y: 4)))` |
| 6.3 | **Stack shift** | 0 | older toasts | translateY → −(h + 8) each | 220 | `--spring-standard` | — | retargets | instant | `.animation(.snappy(duration: 0.22))` |
| 6.4 | **Toast out** (timer, ✕, swipe) | 0 | toast | opacity → 0; translateY 0 → 4px (down) or follows the swipe x | 120 | in | — | — | opacity | — |
| 6.5 | | 120 | the rest | close the gap (6.3 reversed) | 220 | spring-standard | — | — | — | — |
| 6.6 | **Timing** | — | — | hold 5000 (8000 with an action); hover or focus pauses all; resumes with the remaining time | — | — | — | — | — | — |
| 7.1 | **Tooltip** | 0 → 400 | — | intent delay (`--delay-tooltip`); a peer within 300 (`--delay-tooltip-skip`) shows at 0 | — | — | — | leaving before 400 cancels | same | `.help()` (system timing) |
| 7.2 | | 400 | tooltip | opacity 0 → 1; translate 2px from the trigger side → 0 | 120 | out-soft | trigger side | — | opacity | — |
| 7.3 | **Out / peer swap** | 0 | tooltip | opacity → 0 (no travel); a peer swap cross-fades old out 70 while new in 70 | 70 | in | — | — | same | — |
| 8.1 | **Composer focus** | 0 | surface | ring edge ink .08 → .16 and throw e2 → focus, **together** | 120 | out-soft | — | — | same | `.animation(.smooth(duration: 0.12), value: focused)` |
| 8.2 | **Composer grow** | 0 | field | height h → h + 26 per line | 120 | out-soft | top-left | snaps when Δ > 3 lines | **instant** | `TextField(axis:.vertical)` + `.animation(.smooth(duration: 0.12))` |
| 9.1 | **Send → stop** | 0 | disc | scale 1 → .96 (press) | 70 | out-soft | centre | — | none | `.buttonStyle(JunoPress)` |
| 9.2 | | 0 | arrow | opacity 1 → 0; translateY 0 → −3px (leaves upward) | 70 | in | — | — | opacity | `.contentTransition(.symbolEffect(.replace.upUp))` |
| 9.3 | | 70 | stop square | opacity 0 → 1; scale .8 → 1 | 120 | out-calm | centre | — | opacity | — |
| 9.4 | | 70 | disc | scale .96 → 1 (release) | `--spring-snap` | spring | centre | — | — | `.snappy(duration: 0.18)` |
| 9.5 | | 0 | face | **pinned to send while submitting** (no voice flicker) | — | — | — | — | — | — |
| 9.6 | **Stop → voice / send** (stream ends) | 0 | stop | opacity → 0, scale → .8 | 70 | in | — | — | opacity | — |
| 9.7 | | 70 | waveform or arrow | opacity 0 → 1; translateY 3 → 0 | 120 | out-calm | — | — | opacity | — |
| 10.1 | **Attachment add** | 0 | above-row | `grid-template-rows` 0fr → 1fr (first tile only) | 220 | out-calm | — | — | instant | `.animation(.smooth(duration: 0.22))` on the row |
| 10.2 | | 0 + 30·i (max 4) | chip | opacity 0 → 1; translateY 4 → 0 (**no scale**) | 120 / 220 | out-soft / out-calm | bottom | — | opacity | `.transition(.opacity.combined(with: .offset(y: 4)))` |
| 10.3 | **Attachment remove** | 0 | chip | opacity → 0 | 120 | in | — | — | same | — |
| 10.4 | | 120 | siblings | FLIP translateX → 0 | 220 | out-calm | — | — | instant | `matchedGeometryEffect` |
| 10.5 | | 120 | above-row (last chip only) | 1fr → 0fr | 160 | in | — | — | instant | — |
| 11.1 | **User message appears** | 0 (same frame as send) | bubble | opacity 0 → 1; translateY 4 → 0 (`rise-user`, now actually wired) | 120 / 220 | out-soft / out-calm | bottom-right | — | opacity | `.transition(.opacity.combined(with: .offset(y: 4)))` |
| 11.2 | | 0 | composer | the field clears in the same frame; the height collapses (8.2) | 120 | out-soft | — | — | instant | — |
| 11.3 | **Assistant pending** | 200 (`--delay-show`) | "Thinking" line | opacity 0 → 1 (only if still waiting) | 120 | out-soft | — | the reply arrives before 200, so it never shows | same | — |
| 11.4 | **Streaming** | per block | new block | opacity 0 → 1 **once per block** (no per-token motion; the existing highlight bands stay) | 120 | out-soft | — | — | same | — |
| 11.5 | **Stream end** | 0 | tail | the buffer drains at ≤ 4× rate, capped at 250ms (never one slab) | ≤ 250 | — | — | — | instant | — |
| 11.6 | | +180 (`--delay-action-row`) | action row | opacity 0 → 1 | 120 | out-soft | — | — | same | — |
| 12.1 | **Page change** (route) | 0 | new page | opacity 0 → 1; translateY 4 → 0. Old page cut (no exit). View-transition hold ≤ 80. | 120 / 220 | out-soft / out-calm | top | — | opacity | `NavigationStack` (system push) |
| 12.2 | **Side panel open** (canvas) | 0 | panel | opacity 0 → 1; translateX 16 → 0 | 120 / 220 | out-soft / out-calm | right | retargets | opacity | `.inspector` (system) |
| 12.3 | | 0 | content column | width settle (named case) | 220 | in-out | — | — | instant | — |
| 12.4 | **Side panel close** | 0 | panel | opacity → 0; translateX → 8 | 160 | in | — | — | opacity | — |
| 12.5 | **Sidebar fold** | 0 | aside | width (named case) with `contain: layout` | 220 | in-out | — | — | instant | `NavigationSplitView` column visibility |
| 13.1 | **Hover** (any row, button, chip) | 0 | fill | none → `--hover` **instant**; glyph ink → ink | 0 | — | — | — | same | `.onHover` → JunoHoverStyle |
| 13.2 | **Unhover** | 0 | fill | → none | 120 | out-soft | — | — | same | — |
| 13.3 | **Press** (controls ≤ 44) | 0 | control | scale 1 → .96; fill → `--selected` | 70 | out-soft | centre | — | fill only | `JunoPressButtonStyle` (.96) |
| 13.4 | **Release** | 0 | control | scale → 1 | `--spring-snap` | spring | centre | — | — | `.snappy(duration: 0.18)` |
| 13.5 | **Press** (rows, cards, > 44) | 0 | row | fill → `--selected` (tonal, no scale) | 70 | out-soft | — | — | same | — |
| 14.1 | **Segmented / tab change** | 0 | thumb / bar | translateX → target (no squash) | `--spring-standard` | spring | — | retargets with velocity | instant | `.animation(.snappy(duration: 0.22))` + `matchedGeometryEffect` |
| 14.2 | | 0 | labels | colour cross-fade | 120 | out-soft | — | — | same | — |
| 15.1 | **Switch toggle** | 0 | thumb | translateX 0 → 14 | `--spring-standard` | spring | — | retargets | instant | system `Toggle` |
| 15.2 | | 0 | track | colour | 120 | out-soft | — | — | same | — |
| 16.1 | **Checkbox** | 0 | tick | stroke-dashoffset 1 → 0 | 120 | out-soft | — | — | instant draw, opacity 120 | system |

### G2. Token mapping onto the ladder (no new duration rungs)

| Duration | Jobs |
|---|---|
| **70** | press, every float exit, tooltip out, old check, send glyph out |
| **120** | every opacity entrance, hover-out, colour, composer focus, line growth, check in |
| **160** | dialog and side-panel exit, attachment row collapse |
| **220** | every 2–4px travel, scrim in, row expand, toast travel |
| **360** | bottom sheet rise only |
| **560** | unused in chrome; the landing greeting rise stays the only consumer |

The lint (`wave2/off-ladder-duration`) passes unchanged, and nothing exceeds 560.

---

## H. Token changes (`src/app/globals.css`, `tailwind.config.ts`)

### H1. Colour values (light `:root` / `.dark`)

All are HSL triplets for the generator. High-contrast blocks keep their existing values and are re-checked against the matrix.

| Token | Light (was → new) | Dark (was → new) |
|---|---|---|
| `--background` | `240 20% 99.02%` → **`40 18% 97.6%`** (#FAF9F7) | `220 5.9% 10%` → **`30 3% 11.4%`** (#1E1D1C) |
| `--foreground`, `--card-foreground`, `--popover-foreground`, `--ring` | `216 9.1% 10.8%` → **`40 5% 11.6%`** (#1F1E1C) | `220 7% 91.6%` → **`40 9% 92%`** (#EDEBE7) |
| `--primary` | `216 9% 11%` → `var(--foreground)` | → `var(--foreground)` |
| `--primary-foreground` | unchanged `0 0% 100%` | → **`30 3% 11.4%`** |
| `--card` | unchanged `0 0% 100%` | `225 5.6% 14.1%` → **`40 4% 14.3%`** (#262523) |
| `--popover` | unchanged | `225 4.9% 16.1%` → **`40 4% 16.7%`** (#2C2B29) |
| `--muted` (= field surface) | `210 11% 96.5%` → **`45 12% 94.5%`** (#F3F2EF) | `225 6% 12.9%` → **`36 4% 13.3%`** (#232220) |
| `--accent` = `--secondary` | `210 6.7% 94.1%` → **`40 8% 94.5%`** | `225 4.3% 18.4%` → **`40 3% 20.5%`** |
| `--selected` | `220 6.4% 90.8%` → **`40 6% 91%`** | `228 4.3% 22.5%` → **`40 3% 25%`** (now ≠ `--border`) |
| `--user-bubble` | → **`40 10% 93.5%`** | → **`40 3% 17.5%`** |
| `--border` | `220 4.9% 88%` → **`40 7% 90%`** | `225 3.6% 22%` → **`40 3% 21%`** |
| `--input` | `214 3% 53.9%` → **`38 4% 53%`** (#8C8881) | → **`38 4% 44.5%`** |
| `--muted-foreground` | `217.5 3.7% 42.4%` → **`40 4% 40.2%`** (#6B6862) | `223 3.4% 59.8%` → **`38 5% 63.5%`** (#A8A49D) |
| `--muted-foreground-on-fill` | → **`40 5% 36.7%`** | → **`38 5% 68.5%`** |
| `--icon-muted` | `220 5% 25%` → `var(--muted-foreground)` (one ink) | → `var(--muted-foreground)` |
| `--ink-tertiary` | `220 4% 62%` → **`38 4% 54%`** | → **`38 4% 47%`** |
| `--sidebar` | `210 9% 95.7%` → **`45 12% 94.5%`** | `210 5.6% 7.1%` → **`30 4% 8.8%`** |
| `--sidebar-hover` / `--sidebar-selected` | → **`43 9% 90.5%`** / **`42 8% 87.5%`** | → **`30 3% 14%`** / **`30 3% 17%`** |
| `--hairline` | `48 12% 18% / .06` → **`40 5% 11.6% / .09`** | → **`45 60% 99% / .08`** |
| `--scrim` | `48 12% 8% / .26` → **`30 12% 8% / .32`** | unchanged |
| `--shadow-ink` | `216 9.1% 10.8%` → **`30 12% 10%`** | unchanged (black) |

**Unchanged:** `--presence`, `--signal`, `--signal-ink`, `--destructive`, `--destructive-ink`, `--success`, `--attention`, and the 7 accents. Accents still fill only the user's own controls (the send disc stays ink on every accent, as today).

### H2. New tokens
- **Colour:**
  - `--modal` (light `var(--popover)`, dark `40 3% 18.2%`)
  - `--hover` (light `40 5% 11.6% / .05`, dark `45 60% 99% / .06`)
  - `--hover-float` (`.06` / `.075`)
  - `--border-strong` (`.14` / `.13`)
  - `--field-edge` (light `40 7% 83.5%`, dark `40 3% 23%`)
  - `--primary-hover` (light `40 5% 22%`, dark `40 9% 84%`)
  - `--destructive-wash` (`356 72% 42% / .08`; dark `356 70% 63% / .14`)
  - `--tooltip` / `--tooltip-foreground` (light `40 5% 15.5%` / `40 20% 95.5%`; dark `40 3% 22%` / `40 20% 95.5%`)

  Add each to the Tailwind colour map, and add `--modal` and `--hover-float` to `GROUNDS`/`FILLS` in `scripts/check-contrast-matrix.ts`.
- **Shadow:** `--shadow-composer`, `--shadow-composer-focus`, `--shadow-modal` (values in §A4). `--shadow-float` changes value. `soft`, `lift`, `glass` and `pop` become aliases.
- **Motion and timing** (existing families, so they auto-project):

  | Token | Value |
  |---|---|
  | `--delay-submenu` | 100ms |
  | `--hold-submenu-grace` | 300ms |
  | `--delay-hovercard` | 300ms |
  | `--hold-hovercard` | 150ms |
  | `--hold-toast` | 5000ms |
  | `--hold-toast-action` | 8000ms |
  | `--shift-pop` | 4px (formalises `--pop-shift`) |
  | `--shift-tip` | 2px |
  | `--shift-modal` | 4px |
  | `--scale-modal-from` | .985 |

- **Value changes:**

  | Token | Value |
  |---|---|
  | `--delay-tooltip` | 200 → **400ms** |
  | `--delay-tooltip-skip` | 400 → **300ms** |
  | `--spring-reward-params` | → `0.30 0.08` |
  | `--spring-articulate-params` | → `0.22 0.08` |

- **Renames (with aliases and a legacy lint):** `--ease-spring` → **`--ease-out-calm`**; `--ease-drawer` → `var(--ease-out-strong)`.
- **Tailwind:** `transitionDuration.DEFAULT = var(--dur-fast)`, which kills the implicit 150ms. Add `future.hoverOnlyWhenSupported: true`.

### H3. Type (`tailwind.config.ts`)
- `label`: font-family **sans** (Inter) 12 / 16px / 500 / .005em (was mono / 1.4 / .01em).
- `ui`: line-height `1.5` → `1.125rem` (18px).
- New `meta`: `["0.75rem", { lineHeight: "1rem" }]`, used with `font-mono tabular-nums`.
- `caption` and `micro` remain deprecated aliases of `ui`/`label`. `kbd` (11px) is removed from menus, which use `ui`; it stays only in `<Kbd>`.

### H4. Radius
- **No value changes.** Fix the literal `26px` at `globals.css:1908` to `var(--radius-composer)`.
- Update the stale prose in `eslint-rules/design-system.mjs:31-34` and the composer-22 comments.

### H5. Native regeneration
- **Yes.** Run `npm run design:tokens` in the same commit. Everything in H1, H2 (colour and timing) and H3 regenerates into `JunoGeneratedTokens.swift`: `JunoGeneratedColors` gets new members `modal`, `hover`, `hoverFloat`, `borderStrong`, `fieldEdge`, `primaryHover`, `destructiveWash`, `tooltip` and `tooltipForeground`. `JunoGeneratedTiming` gets `delaySubmenu`, `holdSubmenuGrace`, `delayHovercard`, `holdHovercard`, `holdToast` and `holdToastAction`. `JunoGeneratedSprings` changes reward and articulate. `JunoGeneratedType.label` changes.
- **No breakage.** Nothing is renamed on the Swift side. `foreground`, `mutedForeground`, `shadowInk`, `selected`, `fieldSurface`, `cmpWell`, `sidebarSelected` and `input` all keep their names.
- **Hand port** (no generator, no gate): `JunoElevation` gets the four shadow levels, `JunoSurfaces.swift` gets `.composer`, and `.float`/`.modal` and `JunoFieldSurface` take `fieldEdge`.
- **Rebuild** `npm run design:editor` (the bundle hashes `globals.css`).
- **Shell contract.** The `+` menu row kinds stay the same; only the visuals change. The primary faces stay send, stop and voice, with busy folded into send-pinned (a `shell:contract` change to the faces list, with EN and FR strings unchanged).

---

## I. Native: macOS 26 and iOS 26 (SwiftUI + Liquid Glass)

### I0. One layout, three renderings

| Region | Web | macOS 26 | iOS 26 (iPhone) |
|---|---|---|---|
| Shell | flat `--sidebar` column (260) + inset content card (r 14) | `NavigationSplitView`. **The sidebar is the system Liquid Glass pane** (the native rendering of the same column). Detail is the opaque `junoCanvas`. | `NavigationStack` + an **overlay** drawer sheet (280 / 85%, like the web phone), not the push drawer |
| Sidebar header | lockup · bell · collapse; **Chat \| Code segmented** under it | the same strip in the sidebar's top `safeAreaBar`: lockup 15 · bell (`.borderless`) · `Picker(.segmented)` Chat / Code. **The toolbar orbit is deleted.** | the same strip at the drawer top: lockup · bell · `Picker(.segmented)` |
| Sidebar body | New chat · Search · Activity · Projects · Library · Customize · *Pinned* · *Orbit* · *Recent* | `List(selection:)` `.listStyle(.sidebar)`, with the same rows, order and sections (`Section` headers in `label` 12/500) | `List(.plain)`, the same rows (44pt), New chat and Search at the **top** |
| Sidebar footer | account row: avatar 24 · name · plan · ⇅ | `safeAreaBar(.bottom)`: the same row as a `Menu` | the same row |
| Title band | 56px in-card: title (crumb) left; Outputs · Share · More · Private right | unified toolbar: `.navigationTitle` + `.navigationSubtitle` (project) + `.toolbarTitleMenu`; trailing `ToolbarItemGroup` Share · More (`Menu`) · Private, as system glass items. **No page-header duplicate.** | top bar: ☰ (glass circle) · title `Menu` (centre) · New chat (glass circle); Search sits in the drawer |
| Transcript | 768 measure, bubble, prose, action row | unchanged (already parity), plus the user bubble's 8pt tuck | `LazyVStack`, bubble max 85% with the tuck, the tool timeline added |
| Composer | the F spec | floating glass composer in `safeAreaBar(.bottom)` (I2) | glass composer card as the bottom bar (I2) |
| Canvas panel | right panel in the content card | `.inspector(isPresented:)` 360 / 460 / 640. **Code also uses `.inspector`; the custom `TrailingDock` is deleted.** | `.sheet` (large) on the phone; `.inspector` on iPad |
| Settings | modal with 12 sections | the `Settings` scene: `NavigationSplitView` with a sidebar `List` + `.searchable(placement: .sidebar)`; panes are `Form(.grouped)` | `NavigationStack` > `List(.insetGrouped)` on **brand** neutrals (`.scrollContentBackground(.hidden)` + `junoCanvas`) |

### I1. Liquid Glass rules (both platforms)
- **Glass only on the floating control layer.** Allowed sites:

  | Platform | Allowed glass |
  |---|---|
  | Mac | the system sidebar, toolbar and title-menu items, system menus, popovers and sheets, the composer card, ⌘K, find bar, toast host, jump-to-latest, Quick Entry |
  | iPhone | the system top-bar items, system menus, partial sheets, the composer card, jump-to-latest, find bar, toast host |

  **Nothing else.** Messages, cards, artifacts, page buttons, segmented controls on pages and settings rows are **never** glass.
- **No glass on glass.** Controls *inside* the composer card are not glass. They are `.buttonStyle(JunoQuietButtonStyle)`: hover fill on Mac, press fill on iOS. The send disc is an **opaque** ink circle on the glass card. Sheets and popovers contain no `.glass` buttons; use `.borderedProminent` and `.bordered` with `.tint(.junoInk)`.
- **Morphing groups** use `GlassEffectContainer(spacing: 8)` with `glassEffectID(_:in:)`. These are siblings only, never nested:
  1. The composer card and the **jump-to-latest** circle are siblings in one container. The circle materialises out of the card's top edge (`glassEffectID("jump")`) when you scroll up 2 screens.
  2. The composer card and the **dictation/voice capsule**: `glassEffectID("composer")` morphs the card into the voice capsule and back.
  3. Mac toolbar: Share and More in one `ToolbarItemGroup` share a glass background (system grouping); Private sits separately behind a `ToolbarSpacer(.fixed)`.
- **Prominence.** `.buttonStyle(.glassProminent)` is used **only** for the single primary action of a floating bar: Quick Entry "Ask", and the toast action is plain. Page primaries are `.borderedProminent` with `.tint(.junoInk)` and `.buttonBorderShape(.roundedRectangle(radius: 8))`. **At most one prominent control per surface.**
- **Tint** sparingly: never ink-tinted glass, and no red glass. Use `.glassEffect(.regular.tint(Color.junoCard.opacity(0.55)))` only on the composer, so it reads as the web's card over an empty canvas.
- **Edges.** Glass composers get a 0.5pt `junoForeground.opacity(0.10)` stroke via `.overlay(ConcentricRectangle().strokeBorder(…))`, so they never look like an edgeless slab.
- **Reduce Transparency** swaps every custom glass for the opaque `junoCard` plus a hairline. **Increase Contrast** raises the edges to 1pt `junoBorder`.

### I2. The composer, native

```swift
// shared JunoComposerShell (DS) – used by Mac AND iOS (the five iOS composers collapse into it)
GlassEffectContainer(spacing: 8) {
  VStack(spacing: 0) {
    if !attachments.isEmpty { AttachmentRow(...) .padding([.horizontal, .top], 16) }   // F3
    TextField(placeholder, text: $draft, axis: .vertical)
      .font(.junoReading)                     // 16/26 web, 17 Dynamic Type .body on iOS
      .lineLimit(1...(isPhone ? 6 : 10))
      .padding(EdgeInsets(top: 16, leading: 16, bottom: 4, trailing: 16))
    HStack(spacing: 8) {
      PlusMenuButton()                       // 32 circle (44 hit iOS), SF "plus" .medium, imageScale(.large)
      ForEach(armedModes) { ModeToken($0) }  // 28 capsule, opaque junoHover fill — NOT glass
      Spacer(minLength: 8)
      ModelChip()                            // 32 capsule, .font(.junoUI.weight(.medium)), chevron.down .caption2
      if showsMic { DictateButton() }         // 32 circle, SF "mic"
      PrimaryDisc(face)                      // 36 opaque Circle().fill(.junoInk); 44 hit
    }
    .padding(EdgeInsets(top: 0, leading: 10, bottom: 10, trailing: 10))   // centres 26 from edges
  }
  .glassEffect(.regular.tint(.junoCard.opacity(0.55)).interactive(),
               in: .rect(cornerRadius: JunoRadius.composer /*26*/, style: .continuous))
  .overlay { RoundedRectangle(cornerRadius: 26, style: .continuous)
               .strokeBorder(Color.junoForeground.opacity(focused ? 0.16 : 0.10), lineWidth: 0.5) }
  .glassEffectID("composer", in: ns)
  .animation(.smooth(duration: 0.12), value: focused)
}
// Mac: hosted in .safeAreaBar(edge: .bottom) over the transcript; .scrollEdgeEffectStyle(.soft, for: .bottom)
// iOS: hosted in .safeAreaBar(edge: .bottom) (the + menu is a system Menu/sheet now, so the old overflow reason is gone)
```

- **Send ⇄ stop:** `Image(systemName: face.symbol)` with `.contentTransition(.symbolEffect(.replace.upUp))` and `.animation(.snappy(duration: 0.22), value: face)`. Symbols: `waveform` (voice), `arrow.up` `.fontWeight(.semibold)` (send), `stop.fill` with `.imageScale(.small)` (stop). Disabled: the fill becomes `junoMuted` and the glyph `junoTertiaryInk`.
- **`+`** on Mac is a `Menu` with `.menuStyle(.button)`, `.buttonStyle(JunoQuietButtonStyle(shape: .circle))` and `.menuIndicator(.hidden)`. On iOS, tap opens the **"Add to chat" sheet** with `.presentationDetents([.medium, .large])` and `.presentationDragIndicator(.visible)`. The 264pt custom panel and the 4000×4000 tap catcher are deleted.
- **Model chip** opens a `Menu`. Sections: Recommended (Auto, Pro, Fast as `Picker(.inline)`, with checks drawn by the system), `Toggle("Thinking")`, `Picker("Effort")` as a submenu (`.pickerStyle(.menu)`), and "More models" submenu. **The gauge glyph and long-press gesture are deleted.** The model *name* is always visible on the row.
- **Attachment chips** are opaque `junoMuted` tiles (r 12) inside the glass card, so there is no `.thinMaterial`. The remove badge is a 20pt circle with a 44pt hit on iOS.

### I3. Per-surface table: web component → SwiftUI

| Web | SwiftUI component | Modifiers and values |
|---|---|---|
| Sidebar column | `NavigationSplitView { List(selection:) }` | `.listStyle(.sidebar)`, `.navigationSplitViewColumnWidth(min: 224, ideal: 260, max: 352)`; **no `listRowBackground` override pill.** Selection tint: `.tint(.junoSelected)`, so the system draws `junoSidebarSelected` as the selection. Drop the "+10 leadingShift". |
| Sidebar row | `Label(title, systemImage:)` in `NavigationLink(value:)` | `.font(.junoNav)` (14/20; Mac 13pt system `.body` ≈ same optical); row height 32 Mac via `.environment(\.defaultMinListRowHeight, 32)`, 44 iOS; trailing `.badge(count)` or a run dot `Circle().fill(.junoPresence).frame(6)` |
| Section label | `Section { } header: { Text("Recent") }` | `.font(.junoLabel)` (12/500 sans), `.foregroundStyle(.junoMutedInk)`, collapsible via `Section(isExpanded:)` |
| Product switch | `Picker("", selection:) { Chat; Code }` | `.pickerStyle(.segmented)`, `.labelsHidden()`, `.controlSize(.regular)`; in the sidebar header `safeAreaBar(.top)` |
| Title band | toolbar | `.navigationTitle`, `.navigationSubtitle`, `.toolbarTitleMenu { Rename; Pin; Move to project; Delete… }`, `ToolbarItemGroup(.primaryAction) { ShareLink; Menu("More") }`, `ToolbarSpacer(.fixed)`, `ToolbarItem { PrivateToggle }` |
| User bubble | `Text` in `UnevenRoundedRectangle(12, bottomTrailing: 8)` | fill `.junoUserBubble`, padding 16×10, max 85% of 768, `.font(.junoReading)` |
| Assistant prose | `JunoMarkdownView` | unchanged (parity) |
| Action row | `HStack(spacing: 2)` of `Button` | `JunoQuietButtonStyle(size: 28)`; SF: `doc.on.doc`, `hand.thumbsup`, `hand.thumbsdown`, `speaker.wave.2`, `square.and.arrow.up`, `arrow.clockwise` + `Menu` with `ellipsis`; `.imageScale(.medium)`, `.font(.system(size: 13))` |
| Composer | `JunoComposerShell` | §I2 |
| `+` menu | `Menu` (Mac) / `.sheet` (iOS) | sections as in D9; `Toggle` rows for Web search, Memory and Deep research (the system draws switches in menus as checkmarks on Mac and toggles on iOS). On the web, every composer menu anchors to the **composer's top edge**, never to the button, so it can never cover the field. |
| Model picker | `Menu` + `Picker(.inline)` + `Toggle` + submenus | §I2 |
| Dropdown / kebab | `Menu { }` with `Section`s | `.menuStyle(.button)`, `.buttonStyle(JunoQuietButtonStyle(size: 28))`, `.menuIndicator(.hidden)`; destructive `Button(role: .destructive)` last; Mac shortcuts `.keyboardShortcut("c", modifiers: .command)` |
| Context menu | `.contextMenu { same items } preview:` | identical items to the kebab (one `RowMenuItems` view feeds both) |
| Submenu | nested `Menu("Add to project")` | system placement and timing (Mac submenus already open on intent) |
| Select | `Picker(.menu)` | Mac: native pop-up button, `.controlSize(.regular)`; iOS: `.pickerStyle(.menu)` |
| Segmented | `Picker(.segmented)` | **replaces `JunoSegmented` (60 uses)** and the 3 iOS hand-rolled ones |
| Switch | `Toggle` | `.toggleStyle(.switch)` in the **system tint** (green on iOS, accent on Mac). iOS cannot invert its white thumb, so an ink track fails in dark mode. This is a recorded platform difference from the web's ink switch. Mac uses `.controlSize(.small)` in forms. |
| Checkbox | `Toggle` | `.toggleStyle(.checkbox)` (Mac); iOS uses a switch or `Picker` |
| Primary button | `Button` | `.buttonStyle(.borderedProminent)`, `.tint(.junoInk)`, `.buttonBorderShape(.roundedRectangle(radius: 8))`, `.controlSize(.large)` (Mac 28pt / iOS 50pt in sheets) |
| Secondary button | `Button` | `.buttonStyle(.bordered)`, same shape, `.tint(.junoInk)` |
| Ghost / icon button | `Button` | `JunoQuietButtonStyle`: no fill at rest; hover `junoHover` (Mac `.onContinuousHover`); press `junoSelected` + scale .96; `.contentShape(.rect)`; 28 Mac / 44 iOS hit |
| Destructive | `Button(role: .destructive)` | inside dialogs only; the system styles it red |
| Text field / search | `TextField` / `.searchable` | `.textFieldStyle(.roundedBorder)` is **not** used. Mac: `.textFieldStyle(.plain)` in a `JunoFieldSurface` (r 10, `junoMuted`, 1px `fieldEdge`, focus edge ink .40); search everywhere via `.searchable` (placement `.sidebar` / `.toolbar`) |
| Dialog | `.sheet` | Mac `.presentationSizing(.form)` (fits content, **no fixed frames**), header `Text.font(.junoHeading)`, footer `HStack { Spacer; Button("Cancel", role: .cancel); Button(primary).keyboardShortcut(.defaultAction) }` |
| Destructive confirm | `.confirmationDialog` (iOS) / `.alert` (Mac) | `titleVisibility(.visible)`; `Button("Delete", role: .destructive)`; `Button("Cancel", role: .cancel)` |
| Bottom sheet | `.sheet` | `.presentationDetents([.medium, .large])`, `.presentationDragIndicator(.visible)` (**never on a single `.large` detent**), `.presentationCornerRadius` system |
| Popover / hover card | `.popover(item:arrowEdge:)` | content-sized (`.fixedSize(horizontal: false, vertical: true)`), no glass buttons inside; Mac hover cards via `.popover` on `.onHover` with a 300ms intent |
| Toast | `JunoToastHost` (glass capsule, allowed) | bottom-centre, 16 above the composer; `.transition(.opacity.combined(with: .offset(y: 4)))` |
| Tooltip | `.help("Copy · ⌘C")` | system |
| Banner | `safeAreaBar(.top)` row | opaque `junoMuted`; **no `.thinMaterial`** |
| Empty state | `ContentUnavailableView` | title `.font(.junoSerif(24))`, description `.junoNav`, `actions: { Button(…).buttonStyle(.borderedProminent) }` |
| Canvas panel | `.inspector` | `.inspectorColumnWidth(min: 360, ideal: 460, max: 640)`; header `Text` 13 semibold; actions `JunoQuietButtonStyle` |
| ⌘K | custom panel (allowed glass) | 640 wide, r 16, `.glassEffect(.regular, in: .rect(cornerRadius: 16))`, rows 40, no glass inside |
| Page header | `Text(title).font(.junoSerif(32))` | **serif 32/40 400**, as on the web; the `navigationTitle` is hidden on pages (`.toolbarTitleDisplayMode(.inline)` + empty principal) to stop the double title |
| Settings rows | `Form { LabeledContent / Toggle / Picker }` | `.formStyle(.grouped)`; destructive `Button(role: .destructive)` (not `Color.red`) |

**Type on native.** Inter is not bundled, so SF Pro is used at **the same rung sizes**: `.junoNav` 14 → Mac 13 `.body` / iOS 17 `.body`, using Dynamic Type relative sizes with `.relativeTo:`. Newsreader is used for the greeting, page titles and empty states. The 58 sites at 10.5/11pt move to 12. Everything goes through `junoFont` with `relativeTo:` so iOS scales.

### I4. SF Symbols mapping (web export → SF Symbol)

**Weights.** Symbols take `.fontWeight` from the adjacent text: `.regular` beside 13–17pt regular text, `.medium` in the composer row, and `.semibold` for the send arrow. Scale is `.medium` in rows and menus and `.large` in the composer.

| Web | SF Symbol | Web | SF Symbol |
|---|---|---|---|
| Plus | `plus` | Close | `xmark` |
| Attach | `paperclip` | Check | `checkmark` |
| Mic / Dictate | `mic` | Trash | `trash` |
| Voice (AudioLines) | `waveform` | Pin / Unpin | `pin` / `pin.fill` / `pin.slash` |
| Send | `arrow.up` (.semibold) | Folder / FolderPlus | `folder` / `folder.badge.plus` |
| Stop | `stop.fill` | Globe (web search) | `globe` |
| Search | `magnifyingglass` | Image | `photo` |
| Settings | `gearshape` | ImagePlus | `photo.badge.plus` |
| Copy | `doc.on.doc` | Camera / Screenshot | `camera` / `camera.viewfinder` |
| Edit | `pencil` | File / FileText | `doc` / `doc.text` |
| Retry / Refresh | `arrow.clockwise` | NewChat (square-pen) | `square.and.pencil` |
| Share | `square.and.arrow.up` | Sidebar / PanelRight | `sidebar.left` / `sidebar.right` |
| More / MoreVertical | `ellipsis` / `ellipsis` (rotated: `.rotationEffect(.degrees(90))` is not used; use `ellipsis` everywhere) | ThumbsUp / Down | `hand.thumbsup` / `hand.thumbsdown` (+ `.fill` when rated) |
| ChevronDown / Right / Left / Up | `chevron.down` / `.right` / `.left` / `.up` | ReadAloud | `speaker.wave.2` |
| ChevronsUpDown | `chevron.up.chevron.down` | Branch / Fork | `arrow.triangle.branch` |
| Library | `books.vertical` | Activity | `chart.bar` |
| Customize | `slider.horizontal.3` | Bell / BellOff | `bell` / `bell.slash` |
| Code | `chevron.left.forwardslash.chevron.right` | Terminal | `terminal` |
| Research | `binoculars` | History | `clock.arrow.circlepath` |
| Info / Warning / Error / Success | `info.circle` / `exclamationmark.triangle` / `xmark.circle` / `checkmark.circle` | Lock | `lock` |
| Link / External | `link` / `arrow.up.right` | Download / Upload | `arrow.down.to.line` / `arrow.up.to.line` |
| Archive | `archivebox` | Apps | `square.grid.2x2` |
| Sketch | `pencil.and.scribble` | Keyboard | `keyboard` |
| Account | `person.crop.circle` | Help | `questionmark.circle` |
| SignOut | `rectangle.portrait.and.arrow.right` | Undo / Redo | `arrow.uturn.backward` / `arrow.uturn.forward` |
| EndCall | `phone.down.fill` | Video | `video` |
| Eye / EyeOff | `eye` / `eye.slash` | Crew | `person.2` |

**Custom variable-symbol templates** (kept, exported with 3 weights so they scale): `alevr.galaxy`, `alevr.orbit`, `alevr.agent`, `alevr.memory`, `alevr.skill`, `alevr.deepfield`, `alevr.auto`, `alevr.ghost` (Incognito on *both* web and native; this also fixes the EyeOff/ghost platform split) and the lab logos.

### I5. Native motion twins (`JunoMotion`, named per storyboard row)

| Storyboard | SwiftUI |
|---|---|
| Opacity entrance 120 | `.easeOut(duration: 0.12)` → `JunoMotion.fast` |
| 2–4px travel 220 out-calm | `.timingCurve(0.22, 1, 0.36, 1, duration: 0.22)` → `JunoMotion.calm`. **New name, generated from `--ease-out-calm`.** |
| Exits 70 / 120 / 160 | `.timingCurve(0.4, 0, 1, 1, duration: 0.07 / 0.12 / 0.16)` → `JunoMotion.exitPress / exitFast / exit` |
| `--spring-snap` | `.snappy(duration: 0.18, extraBounce: 0)` |
| `--spring-standard` | `.snappy(duration: 0.22, extraBounce: 0.05)`. **Replaces `sendMorph` 0.36 / 0.12.** |
| `--spring-layout` | `.smooth(duration: 0.36)` |
| Sheet rise 360 | system sheet presentation (do not override) |
| macOS factor | the existing `platformFactor` 0.75 stays on springs only |
| **Reduced Motion** (`@Environment(\.accessibilityReduceMotion)`) | every `.offset` / `.scale` transition becomes `.opacity` at the same duration; `symbolEffect` uses `.replace.offUp` → `.opacity`; glass morphs become cross-fades (`glassEffectTransition(.identity)`) |

**Haptics (iOS):** `.sensoryFeedback(.impact(weight: .light), trigger: sent)` on send, `.selection` on segmented and picker changes, and `.warning` on a destructive confirm.

### I6. The 25 worst native offences and their fixes

| # | Platform | Offence (from the maps) | Fix |
|---|---|---|---|
| 1 | Mac | Custom dot-orbit Chat/Code switch in the toolbar centre (`ChatToolbar.swift:54`) | `Picker(.segmented)` in the sidebar header; delete `JunoProductOrbit` from chrome |
| 2 | Mac | Glass capsules on the content layer, `.junoGlass` ×97 and `.junoProminent` ×64 (`JunoGlassControls.swift:66-97`) | `.bordered` / `.borderedProminent` with `.tint(.junoInk)` and an 8pt rounded-rect shape; glass only at the I1 sites |
| 3 | Both | Glass on glass: about 48 Mac glass controls inside sheets and popovers; iOS capsules inside the composer | No glass inside sheets, popovers or the composer card; quiet and bordered styles there |
| 4 | Mac | Edgeless `.regular` glass composer slab (`JunoComposerShell.swift:296-318`) | Tinted glass + 0.5pt edge + focus step (I2); opaque under Reduce Transparency |
| 5 | iOS | 114 custom glass sites; the phone exempt from the glass gate (`check-native-glass.mjs:31-37`) | Remove the exemption; enforce the I1 allow-list |
| 6 | iOS | A hand-built 264pt glass `+` panel with a 4000×4000 tap catcher (`JunoMobileComposer.swift:655-667`) | The "Add to chat" `.sheet` with detents, plus a system `Menu` for long-press |
| 7 | iOS | Model invisible on the composer: a gauge plus long-press (`JunoMobileThinkingDial.swift:15-39`) | A labelled model chip `Menu` (I2) |
| 8 | iOS | Five composers with five radii (26/24/24/22/28) | One `JunoComposerShell` at 26 for Chat, Incognito, Code voice and Link |
| 9 | iOS | Push drawer + centre orbit + Search hidden + New chat at the bottom | Overlay drawer with the web's order; top bar ☰ · title · New chat |
| 10 | Mac | SF Medium 32–44 page titles + a duplicate toolbar title (`JunoTypography.swift:168`, `ChatDetail.swift:30-34`) | Newsreader 32/40 400; hide the toolbar title on pages |
| 11 | Both | Bitmap `JunoIconView` icons at 13–15 sizes that ignore Dynamic Type | SF Symbols per I4 + 10 custom variable templates; sizes come from text style |
| 12 | Mac | `JunoSegmented` custom glass track ×60 with ad hoc thumb alphas | `Picker(.segmented)` |
| 13 | Mac | Fat card grids with full-width pill buttons (Connections, Skills, Library) | Two-column `List` rows (52pt, name + description, trailing chevron or `+`), as on the web |
| 14 | Mac | The sidebar fights `List`: an override selection pill, negative insets, a +10 shift (`DesktopChatSidebar.swift:839`) | System selection with `.tint`; standard insets; 16pt glyph edge |
| 15 | Mac | Oversized 40pt "prominent" New chat row | An ordinary 32pt row |
| 16 | iOS | Ink-tinted glass "Chat" capsule + 52pt glass circles in the drawer footer | Account row (avatar 24 · name · plan); New chat as the top row |
| 17 | iOS | Four treatments for the primary slot (opaque, ink-glass, red, red-glass) | One opaque disc: ink for send, voice and stop; End call is `.borderedProminent` `.tint(.junoDanger)` *outside* the card's slot logic |
| 18 | Both | Three typography APIs, with 58 sites at 10.5/11pt | `junoFont(rung, relativeTo:)` only; the 12pt floor |
| 19 | Both | ~22 foreground alphas and 8 border alphas | Generated `hover`, `selected`, `border`, `borderStrong` and `fieldEdge` only |
| 20 | Mac | Artifact canvas header mixes four button idioms + a hand-drawn separator | `.inspector` + `ToolbarItemGroup` with `JunoQuietButtonStyle`; `Divider()` |
| 21 | Both | Fixed-size sheets and popovers (560×520 ×4, a hard-coded account popover height) | `.presentationSizing(.form/.fitted)`, `.fixedSize(vertical)`; no literal frames |
| 22 | iOS | Grabber on single `.large` sheets (5 sites) and `.thinMaterial` banners and chips | Grabber only with ≥ 2 detents; opaque banners |
| 23 | Mac | Hand-rolled settings search (radius 9, `fg .05`) and black disc section tiles | `.searchable(placement: .sidebar)`; `Label` rows with SF glyphs, no discs |
| 24 | Both | 32 Mac and 7 iOS bespoke `ButtonStyle`s, plus 70 hand-written hover state machines | Three styles: `JunoQuietButtonStyle`, `JunoPressButtonStyle` (.96, `.snappy(0.18)`) and system bordered/prominent; hover via one `JunoHoverEffect` modifier |
| 25 | Both | Painted landscape sign-in plates and warm-umber shadows on a graphite brand; stale coral prose | The web's sign-in (dark galaxy plate, cardless form, 48pt fields, an ink rect button); purge the coral and umber comments; delete the orphaned `JunoMac` xcconfigs |

### I7. Review loop
- **Mac.** Add the `workflow_dispatch` job from map-native-macos §1.4, which runs `--juno-preview-snapshot` in light and dark with real glass. Stop approving `junoSnapshotOpaqueGlass` renders.
- **iOS.** Set `TEST_RUNNER_JUNO_SNAPSHOT_DIR` and `actions/upload-artifact` in `native.yml:595-621`.
- **Gates.** Glass (phone exemption removed), `sficons` (allow-list from I4), `prominent` (≤ 1 per view) and `type` (12pt floor).

---

## Per-surface notes (quick reference)
- **Sidebar.** No borders. Section labels in sans 12/500. Rows are 32 with a radius-8 fill, instant selection, one trailing signal, and the run dot in presence only.
- **Thread.** No boxes around answers. The user bubble is `--user-bubble` with an 8 tuck. The action row is 28 ghost icons in muted ink, appearing 180ms after the stream ends. Approval and question cards are wells (r 12, `--muted`) with an ink verb (lg 36) and a secondary refuse, end-aligned.
- **Library and Customize.** Underline tabs, 52 two-line rows, the sans `label` voice, no mono.
- **Settings.** The group card is r 12 with a `--border` hairline and **no fill** (it already has none), with rows divided by an inset `--border` at 16. Switches are rows.
- **Dark mode everywhere.** Each layer steps the surface lightness by +1 (canvas 11.4 → card 14.3 → popover 16.7 → modal 18.2 L) and carries a 1px `#FFFDF8/.08–.10` edge. Shadows only ground the edges.
