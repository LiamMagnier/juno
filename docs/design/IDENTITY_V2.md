# Alevr · Identity v2

**The single source of truth for Alevr's identity, design system, interface and motion on the web, the Mac
and the iPhone.** Date: 30 October 2026. Status: approved direction (owner decision 30 Oct 2026: d3
"Sculpted" as the base, plus the best of every direction and of today's product), **revision 3** after a
four-lens review (best-of, brand, accessibility, build): every blocker and major is settled below (index in
§17.4); disagreements are in the Review log at the end. This document and its appendices supersede
`docs/design/FLAT_UI.md`, `ICONS_AND_MOTION.md`, `UI_UX_MOTION_SPEC_2026-10.md` and `SOFT_UI.md` wherever
they disagree.

| Appendix | Holds |
|---|---|
| [`identity-v2/BEST_OF.md`](identity-v2/BEST_OF.md) | The best-of matrix: the strongest idea per area from d1, d2, d3 and today, the pick, and every conflict decided |
| [`identity-v2/TOKENS.md`](identity-v2/TOKENS.md) | Palette (OKLCH source, HSL triplets, contrast over every ground and state fill, APCA, distinctiveness), aliases for colour, type, radius and springs, accent retirement, type ladder with platform data, fonts, spacing, radius, borders, elevation, targets |
| [`identity-v2/COMPONENTS.md`](identity-v2/COMPONENTS.md) | One recipe per component, with roles and names: floating layers, buttons, fields, segmented, tabs, switch, page header, rows, cards, empty/loading/error, composer, model picker, live primitives, the voice bar, forced colours |
| [`identity-v2/MOTION.md`](identity-v2/MOTION.md) | Duration ladder, the four springs (measured), where the weight is (the shadow lag), choreography per layer, reduced motion, gates |
| [`identity-v2/ICONS.md`](identity-v2/ICONS.md) | Family v4 construction, metaphors, native projection with the fixed-topology outliner, verification, every export name with status |
| [`identity-v2/BRAND.md`](identity-v2/BRAND.md) | The Arch, masters, wordmark cuts, app icon layers, favicon, misuse, trademark note |
| [`identity-v2/NATIVE.md`](identity-v2/NATIVE.md) | macOS 26 and iOS 26: what carries the identity, shell mapping, colour, keyboard-only focus, glass, menus, accessibility sizes, faces, removals, gates, device checks |
| [`identity-v2/MIGRATION.md`](identity-v2/MIGRATION.md) | Build waves W0–W9: ownership of every directory, dependency edges, gates that run in CI, the screenshot harness |
| `identity-v2/brand/` | The final brand SVGs and `geometry.json` (granite palette) |
| `identity-v2/shots/`, `identity-v2/ref/` | Renders made for this spec (45 files, §19); reference copies of the directions' screenshots |
| `identity-v2/tools/`, `identity-v2/proto/` | Every script that produced a measured value, its vendored inputs (fonts, d3's brand code, the frame tool, the "before" icon renderer, a neutral seed), and the static prototype |

Words: **must** is a requirement a gate checks; **should** is a requirement a reviewer checks. Every number
is a real value. "Measured" means computed or rendered while writing this spec (method in §19);
"unverified" means nobody has checked it yet. Citations: `J-owner`, `J-ux`, `J-platform` = the judge panel;
`WA` web audit, `NA` native audit, `PR` principles, `LUI` / `MEM` / `RES` / `ART` the Live UI, memory,
research and artifacts feature audits, each with its section number. Their files live in the session
scratchpad `/tmp/claude-0/-home-user-juno/fa198b77-5ed6-5d1e-9041-b11ebba8d703/scratchpad/identity-v2/`
(`JUDGES.md`, `web-audit/AUDIT.md`, `native-audit/AUDIT.md`, `refs/PRINCIPLES.md`) and
`…/scratchpad/features/{live-ui,memory,research,artifacts}/AUDIT.md`. Nothing a wave needs to build lives
only there: the inputs are committed under `identity-v2/tools/` (MIGRATION W0).

## Owner rules (fixed; not reopened here)

1. Focus rings are keyboard-only (input-modality aware), never on pointer clicks, on every platform.
2. The sidebar's Orbit section lists only busy agents (working or needs you); Orbit appears once in the sidebar.
3. No prompt suggestions or chips above the composer, anywhere, on any platform, phones included.
4. Pinned chats lead Recent (at the top of Recent, not in a separate Pinned section).
5. Settings keep exactly 12 sections.
6. Agent faces stay flat (the current rig in `src/components/agents/face-*.ts` and `agent-face.tsx`);
   colours may be retuned, shapes stay.
7. The name Alevr stays; the mark, wordmark and app icon are redone (the Arch).
8. Principles, never pixels: no copying of proprietary interfaces, artwork, branding or copy strings
   (every retired line, including the competitors' own home headings and receipt leads, is in §14.2 and
   in the shell contract's `retired` list).
9. Never invent citations; sample content uses neutral placeholders (`*.example.com/.org/.net`, "Vendor A"),
   never real third-party sites that imply endorsement.

---

## 1. The idea

**Alevr lifts the work.** The ground is still; the work sits on a paper stage; only what floats, or waits
for your hand, rises, and its shadow lands a beat after it. The brand is the same idea drawn as a mark: an
arch holding one stone clear of the ground.

Three ideas carry every decision, and every pick in BEST_OF.md is tested against them:
1. **The Arch** (brand): a stone held aloft by shape alone. Bronze is the stone, and means "Alevr is at
   work here". It is the only warm note on cool granite.
2. **Lift is earned** (depth): four tiers; in-flow content never casts a shadow; floats, the composer while
   the transcript passes under it, and a question waiting for you are the only lifted objects.
3. **Lift and settle** (motion): things rise from where they were caused and come to rest without bounce;
   a lifted object's shadow lands 60–80 ms after its body, which is where the weight is felt (MOTION §3.1,
   proved by frame strips, not by overshoot); frequent and keyboard actions do not move.

### 1.1 What changes (a rework, not a reskin)

| Layer | Today | Identity v2 |
|---|---|---|
| Mark | Continuum blades + Newsreader wordmark | the Arch (pixel-fitted masters 16/20/24/large) + Geologica wordmark in two cuts; three-layer Icon Composer app icon |
| Composition | flat sidebar panel with a seam; full-bleed page; one column | sidebar directly on the granite base; the work on an inset paper stage; **answers in two lanes: the reading column and a working margin of sources**, the lane reserved on wide windows so nothing moves |
| Type | Newsreader voice, Inter, mono as a label voice (746 uses) | Geologica for one display line per screen; Inter 4.1 for all work; mono for code only |
| Colour | graphite, one drifting live colour, ember "needs you", seven accents | granite neutrals (cool, hue 255) in OKLCH, one ink for action and focus, bronze = live (the only warm note), signal blue = needs you; no accents |
| Depth | in-flow shadows, gloss on primaries, blur in chrome | four tiers, lift is earned, the shadow lands after the body, no blur anywhere on the web |
| Motion | six springs, three menu timings, shimmer, galaxy loops | four springs (bounce ≤ 0.10), one choreography per layer, instant keyboard menus, one live loop capped at 5 s |
| Icons | V3, 1.5 / 2 px | v4: 1.25 / 1.5 px, flat-cut terminals, continuous containers, 1 px pixel-snapped at 1x |
| Recipes | three menu shells, nine page-title recipes, four model pickers, four composers | one float family, one page header, one model picker, one composer that also carries voice |
| Native | glass page controls on Mac; a ChatGPT-modelled iPhone shell with literal colours | system chrome only in glass; Alevr surfaces opaque; generated four-way colour; the web's anatomy and IA; an inset stage on the Mac and a push drawer that reveals it on the iPhone (§13) |

### 1.2 Why it beats ChatGPT and Claude (on principle, never pixels)

| Dimension | Their pattern (PR §12; COMPETITIVE_AUDIT_2026-10-15) | Alevr v2 |
|---|---|---|
| Trust in answers | sources as a list or chips after the answer | **the margin**: each source sits beside the line it supports on wide windows, and in a source line under its paragraph on phones; a receipt line under every answer |
| Home | one centred question or greeting over a centred pill composer | a dateline and a question set on the reading column's left edge, with the composer's text on the same edge: the first line of a document (§11.5; `shots/home-1440-light.png`) |
| Composer | `+` at the start; a dictation mic beside a round control that is voice when empty and send with text; model in the header (ChatGPT) or beside send (Claude) | the model is the first word token at the start, beside the other mode tokens; voice is a named control ("Talk") that turns the composer itself into the voice bar; send is only send (two states); dictation is a mic inside the field (COMPONENTS §10) |
| Voice | a separate full-screen mode | the composer becomes the voice bar; the Arch's stone rises with your voice; the transcript stays readable (COMPONENTS §13) |
| Agents | separate products or modes | agents live in the same shell; busy-only Orbit; the agent's question is the one lifted object, with a step rail and timers |
| Navigation | history hidden by mode merges; tooltip-only icon rails | five destinations, pinned first in Recent, sidebar collapses to nothing |
| Depth and material | flat | a stated depth model you can feel: ground, stage, lift, float, modal |
| Brand | ChatGPT: achromatic greys (C 0); Claude: a warm neutral ramp (hue 95–107) with a terracotta mark and a serif | cool granite (hue 248–264 measured, C 0.003–0.009) with one warm metal, bronze, the Arch, a soft geometric display face. Measured in TOKENS §1.3: the difference is the ramp's hue and the composition; near-white paper and near-black ink sit within about 2 ×100 OKLab of everyone's, so that is not claimed as a difference |
| Platform fit | the iOS app modelled on its web; Mac diverged | same anatomy and IA on all three, platform expression |

---

## 2. Brand (detail: BRAND.md)

- **Symbol**: d3's Arch: round-shouldered arch (superellipse shoulders n 2.8 / 2.6), flat feet, one bronze
  stone lifted clear of the ground. Masters 16, 20, 24 and large are drawn, not scaled; **the 16 master is
  pixel-fitted at 1x with a 4 px stone, 1 px clearance from each leg and 1 px lift**, so the stone is
  visible in a browser tab (`identity-v2/shots/favicon-zoom.png`). Whether the 16 px silhouette still reads
  as a lowercase "n" is **unverified**; W1 runs a recognition check and widens the small masters if it
  fails (BRAND §2.1). Mono fallback (`currentColor`, the gap keeps the stone separate) for single-ink
  contexts. Never draw the arch without the stone.
- **Wordmark**: Geologica, CRSV 1, outlined. Large cut 450, −1.2 %, A–l +0.020 em (d3 was 540); small cut
  520, +1 %, A–l +0.030 em for rendered heights ≤ 24 px.
- **App icon**: Icon Composer layers: ground (basalt `#202225`), arch group, stone group in front (the OS
  renders its lift); appearances default, dark, tinted, clear. **One alternate app icon, on iPhone only**
  (the Light ground): iOS already supplies dark, clear and tinted, and macOS has no alternate-icon API.
- **Clear space** = the stone's diameter; minimum symbol 16 px.
- **The mark is the window's live light**: the sidebar symbol is mono at rest; its stone turns bronze while
  anything in the window is live; the stone rises 4 px → 0 once per launch; in the voice bar it rises with
  the voice level.
- **Bronze budget**: bronze only on the mark, the live primitives and the working face's orbit, enforced by
  `design-system/bronze-budget` and `check-native-colour.mjs` (TOKENS §1.5).
- **Trademark clearance: unverified** (no search run). Blocking for W1's production deploy (BRAND §8).
- Retired: the Continuum, the galaxy as wallpaper, generated photographic art and its public prompt files.

---

## 3. Colour (detail and every measured pair: TOKENS §1)

### 3.1 Roles at a glance (granite; the warm-stone alternative is TOKENS §1.2 and §20 Q2)

| Role | Light | Dark | Job |
|---|---|---|---|
| `--base` | `#eceff2` | `#0c0d0f` | window ground, sidebar, landing (granite) |
| `--stage` | `#fdfefe` | `#18191b` | the paper sheet the work sits on |
| `--raised` | `#f2f4f6` | `#1f2123` | in-flow tone: user turn, code, tiles, drafts |
| `--float` | `#ffffff` | `#282a2c` | menus, popovers, dialogs, sheets, toasts, the lifted composer |
| `--well` | `#e5e7ea` | `#111213` | fields and tracks on the base |
| `--selected` | `#e4e6e9` | `#2e2f32` | selected row |
| `--line` / `--line-strong` | `#dee0e2` / `#7e8084` | `#343537` / `#818387` | hairline (decorative) / boundary that must be found (≥ 3:1) |
| `--ink` / `--ink-2` / `--ink-3` | `#15171b` / `#4d5054` / `#84868a` | `#e8eaec` / `#cbced1` / `#7e8083` | text / every secondary text / decorative only |
| `--bronze` / `--bronze-fill` | `#775020` / `#a7722e` | `#dfb97e` / `#d7aa67` | live label / the stone, live dot, writing point, live rule, working orbit |
| `--signal` | `#1c55b2` | `#8dbbff` | needs you, only |
| `--danger` / `--danger-fill` | `#aa1f1f` / `#b52524` | `#fe9b93` / `#e15a50` | destructive and failed |

### 3.2 Rules

1. **One colour per meaning.** Ink = action and the focus ring; bronze = live; signal blue = needs you;
   red = destructive. Nothing else is coloured: no gradients, washes, tinted cards or tiles, coloured
   borders, left stripes, glows or edge lights.
2. **Focus ring**: 2 px `--ink` outline, offset 2, keyboard-only through `src/lib/input-modality.ts`
   (≥ 7.98:1 on every surface and state fill in all four appearances); inset on rows in menus and lists.
   **Natively the same rule**: Alevr-drawn fields and controls disable the system focus effect and draw the
   ink ring only when focus arrived by keyboard (NATIVE §2.1); the system ring remains only on system-drawn
   controls during keyboard navigation.
3. **All text is `--ink` or `--ink-2`.** Placeholders, timestamps, shortcut hints, captions, counts and
   metadata use `--ink-2`: measured ≥ 6.48:1 on every light ground and the selected fill (≥ 6.00:1 on the
   lowest light state fill) and ≥ 9.12:1 on the four dark grounds (≥ 6.90:1 on the lowest dark state
   fill); **APCA |Lc| ≥ 72.8 on the four dark grounds** (TOKENS §1.3). `--ink-3` is decorative only
   (disabled glyphs, bullets, rails) and banned as a text colour by lint.
4. **Status words** (Working, Needs you, Failed, Done, quota warnings; one or two words, always with a dot
   or glyph): ≥ 6.00:1 light and ≥ 7.08:1 dark on the four grounds, ≥ 5.53 / 6.58 on the selected fill,
   ≥ 5.12 / 5.36 on the lowest state fill; HC raises each (TOKENS §1.3).
5. **Dark mode is a separate ramp with elevation by lightness**: OKLCH L base 0.160 → stage 0.214 → raised
   0.246 → float 0.284; measured luminance steps stage/base 1.105:1, raised/stage 1.089:1, float/stage
   1.221:1; plus a white 8 % ring on floats, so menus and the stage separate clearly from the base.
6. **High contrast** (`prefers-contrast: more`, Increase Contrast natively): `ink-2`, `ink-3`, `line`,
   `line-strong`, `selected`, every status ink (`bronze`, `signal`, `danger`, `success`, `warning`) and
   (light) `bronze-fill` and `danger-fill` change; floats' ring becomes `--line-strong` at alpha 1; every
   boundary that relies on `--line` by default (composer, tokens, Secondary buttons, well fields) becomes
   `--line-strong`; layouts never move.
7. **Boundaries**: `--line` is decorative; a control may rely on it only when its own visible text or glyph
   identifies it (TOKENS §1.4 rule 7 lists the four cases). Forced colours: COMPONENTS §15.
8. **Pipeline**: an OKLCH source (`src/lib/tokens/palette.source.ts`) generates the HSL triplets in a
   fenced region of `globals.css`; never `oklch()` in globals.css (71 Tailwind colour entries and 1,534
   `hsl(var(--x))` uses need triplets); `--check` verifies the region, the round trip and that no colour
   property is left unmapped.
9. **Old names stay as aliases for one release, then are banned** (map: TOKENS §1.6, covering every colour
   property in globals.css). `--signal` keeps its name with the new blue value (release note: "Needs you is
   now blue"); today's `--attention` (amber warning) is aliased to `--warning`; `--presence` is aliased to
   `--ink`, but **the face's working orbit and `--status-running` take `--bronze-fill`** (the live state).
10. **The seven accent themes are retired** (TOKENS §1.7: the web in one change; natively the accent members
    stay as deprecated aliases of ink until W9 migrates their 350 references).
11. **Agent tones**: the six stored ids stay; values re-derived at one lightness; **one eye ink in both
    themes** (AGENTS.md's invariant). **Chart series**: ink, four hues placed between the status hues with
    their own lightness (≥ 0.098 OKLab from every status ink, measured), and `ink-2` dashed (TOKENS §1.2).

---

## 4. Type (detail: TOKENS §2)

- **Geologica** (CRSV 1, SHRP 0, instanced, 23,752 B Latin) for **one display line per screen at 28 px and
  up**: the home greeting, page titles, auth, landing. **Inter 4.1** (rsms build with `opsz`, `cv05`,
  `cv08`, `tnum`, `case`; subset 65,452 B roman) for all work, with Cyrillic, Greek and Vietnamese subsets
  cut from the same build (24,420 / 25,544 / 12,728 B, loaded by `unicode-range`). **JetBrains Mono** for
  code only. **SF Pro** natively. Preloaded total 89,204 B (budget 120 KB). Newsreader and Literata leave
  the product. Arabic and Hebrew fall through to the platform face (TOKENS §2.1).
- **The ladder** (web px / iOS text style / Mac pt; `fontSize` in rem in `tailwind.config.ts`, platform
  data in `src/lib/tokens/type.source.ts`): hero clamp 44–72 (web only, rem intercept) · display Geologica
  40/46 / Geologica 32 `.largeTitle` / 30 · display-compact 30/36 (below 600 px) · title-1 Geologica 28/34 /
  `.largeTitle` nav title / SF 22 · title-2 18/24 / `.title3` / 15 · title-3 15/22 / `.headline` / 13 ·
  answer-h2 20/28 / `.title3` / 17 · answer-h3 16/24 / `.headline` / 14 · reading 16/27 / `.body` / 15 ·
  bubble 15/24 / `.body` / 14 · ui 13.5/20 / `.body` or `.subheadline` / 13 · caption 12/16 / `.footnote`
  / 11 · micro 11/14 / `.caption2` / 10 · code 13/21 / SF Mono 14 / SF Mono 12. Today's rung names stay as
  aliases with today's values until their owning wave migrates the file (TOKENS §2.2).
- **Native weights**: every rung carries an explicit `appleWeight`; the fallback rounds to the nearest
  hundred with ties down (replaces `JunoType.weight(css:)`, which collapses 430/450/460/520/580 to
  `.regular`). Geologica ships natively as TTF and sets its exact `wght` through the font descriptor's
  variation axis (unverified on device).
- **Dark trim**: −20 weight on reading and body rungs, web only.
- **Reading measure: 36 em = 576 px at 16 px, measured at 74.7 characters per line on average**
  (TOKENS §2.4); reading size is a setting (15 / 16 / 18 px; the column follows in em).
- Mono is never a label or a number style; numbers that align use Inter `tnum`. No all-caps. 12 px floor
  (11 for `micro`, never a sentence).
- Geologica's CRSV forms were rendered in English, French, German and Russian at 40 px with the new
  greeting and no fallback (`identity-v2/shots/brand-check-light.png` row 4).

---

## 5. Geometry (detail: TOKENS §3, §4, §8)

- **Spacing**: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96 (no 14).
- **Radius ladder** (names chosen so no existing name changes meaning): `sm` 4 · `chip` 6 · `control` 8 ·
  `card` 12 · `sheet` 16 · `composer` 24 · `full`. Concentric rule: child = parent − inset (menu 12 −
  inset 4 = row 8; segmented track 8 − 2 = thumb 6; composer 24 − 8 = 16 = the radius of its 32 px
  controls). Today's fourteen names stay as aliases (TOKENS §4).
- **Continuous corners**: the ladder is designed as plain circular radii (what Safari and Firefox draw);
  Chromium adds `corner-shape: superellipse(1.5)` **and** the ×1.35 radius in one `@supports` layer on the
  same elements, so no element ever gets the larger radius without the shape; concentric children are
  computed from the scaled parent. Native: `.continuous` with the ladder values. WebKit render: CI only,
  unverified until W3.
- **Control heights**: 24 (inline), 28 (small), 32 (default), 40 (large: landing, auth, phone composer
  controls), 44 (touch).
- **Targets**: ≥ 24 × 24 px on the web pointer, 28 × 28 pt on the Mac, 44 × 44 on coarse pointers and
  iPhone; text-only controls get the same through padding (TOKENS §8).
- **Density (d1)**: menu and sidebar rows 32 (touch 44); page list rows 52 with tabular right-aligned
  numeric columns under a `line-strong` header rule; palette rows 36; settings rows ≥ 56 with the whole row
  as the switch's hit area.
- **Icon boxes**: 12, 16, 20, 24 glyphs; 32 and 40 tiles. **Agent faces ≥ 20 px** (the rig's smallest
  tested size; exempt from the icon ladder).
- **Platform variants are declared tokens** (TOKENS §8), never literals in Swift; row heights are minimums
  at accessibility text sizes (NATIVE §5.1).
- These are the values the geometry gate enforces (MIGRATION §5).

---

## 6. Elevation and materials (detail: TOKENS §6, §7)

| Tier | Who |
|---|---|
| 0 ground | base, stage, raised, cards, code, turns, rows, Live UI cards, the step rail, the margin |
| 1 lift | the composer and the voice bar **only while content scrolls beneath them**; the needs-you card and permission requests **while they wait** |
| 2 float | menus, submenus, popovers, selects, toasts |
| 3 modal | dialogs, sheets, the palette, the phone drawer (+ scrim, never blurred) |

- Every tier's first layer is a 1 px ring; floats need no border. Generated once from `globals.css` into
  `JunoGeneratedElevation` and TS in all four appearances (HC redeclares the ring at alpha 1); the hand
  `JunoElevation` enum goes. Forced colours add a transparent 1 px border to every tier.
- **Static shadows in scrolling chrome**: the composer's tier 1 is a static `box-shadow` toggled by an
  `IntersectionObserver` sentinel (opacity cross-fade 160 ms on a pseudo-element, never during scroll);
  `onScrollGeometryChange` natively.
- **No blur anywhere in web product chrome**: `no-backdrop-filter` and `no-blur-entrance` lose every
  product-chrome exemption (user-made designs keep theirs, TOKENS §7). Natively, glass only where the
  system draws it; every Alevr surface is opaque.
- No inset highlights, coloured shadows or shadows on buttons.

---

## 7. Motion (detail: MOTION.md)

- **Four springs**, defined once and emitted to CSS `linear()`, framer and SwiftUI. Values measured with
  the generator's own spring model (`tools/springs.py`):

| Spring | Params | Settle | Overshoot (on 10 px) | Use |
|---|---|---|---|---|
| snap | 0.24 s / 0 | 341 ms | 0 | menus, submenus, popovers, selects, thumbs |
| glide | 0.32 s / 0 | 455 ms | 0 | sidebar collapse, FLIP reorder, drawer and sheet settle, margin relayout |
| settle | 0.36 s / 0.10 | 377 ms | 0.152 % (0.015 px) | dialogs, phone sheets, palette |
| lift | 0.32 s / 0.10 | 335 ms | 0.152 % (0.015 px) | four signature moments: toast, needs-you card, sent message, the stone's first rise |

- **The weight is in the shadow, not the bounce.** No spring here overshoots by a visible amount (0.015 px
  on a 10 px lift; 0.12 would make it 0.030 px). A lifted object is drawn as a body and a pre-blurred
  shadow layer; the body arrives on `lift` (95 % at 246 ms), the shadow starts 70 ms later as a tight
  contact shadow and lands at its tier at 310 ms (MOTION §3.1). Everything completes in under 400 ms.
- **Effects ladder**: 80 · 120 · 160 · 200 · 240 · 400 ms (token names unchanged). Exits ≤ 160 ms and
  shorter than entrances; the dialog exits in 120 with its scrim.
- **One choreography per layer type** (MOTION §5). **Keyboard-opened menus, submenus, selects and the
  palette appear instantly.** **The scrim never outlives its panel.** Hover in 0 ms, out 80 ms.
  **Selection in navigation (sidebar rows, tabs, lists) changes instantly**; only a control's own thumb
  moves.
- **Streaming**: no per-token animation; a new block fades in once over 120 ms; the bronze writing point
  rides the end of the text; nothing animates text the reader is on.
- **No endless loops**: the live dot loops for the first 5 s after each step starts, then rests.
- **Reduced motion = fade only** at the same rungs; **every size or position change is instant** (sidebar,
  list rows, the receipt collapse, sheet height, the home composer's move); loops stop; direct manipulation
  stays; no blur in either mode. `platformFactor 0.75` is removed natively.
- **RTL**: the drawer opens from the inline-start (leading) edge, which is the right side in RTL (MOTION §5).

---

## 8. Icons v4 (detail and all names: ICONS.md)

- **Line**: 1 px at 12–15, 1.25 px at 16–23, 1.5 px at 24–31, 1.75 px at 32+ (DPR ≥ 2); at DPR < 2,
  1 px pixel-snapped from 12 to 23; −0.1 px in dark on the web.
- **Construction**: 24-unit grid, keylines about 6 % larger than d3's (d1's presence rule), **flat-cut
  terminals** (echo the arch's flat feet), round joins, continuous-corner containers, the 1.5-unit house
  gap, filled points, **on = filled** for the selected destination and toggles that are on, per-size pixel
  fitting (the existing `fitDrawing`), small cuts below 18 px.
- **Stem ratio rule** (DPR ≥ 2): icon line ÷ the paired Inter stem stays 0.85–1.05 (16 px glyph beside
  13.5 px text: 0.98). At DPR < 2 the 1 px snapped line gives 0.79, a stated exemption checked on a real
  1x display in W2.
- **Metaphors fixed**: Projects = a portfolio (new export `JunoProjects`); Code keeps its slash `</>`;
  Orbit = the face squircle; Auto = a gauge, never a ring; **Research = a telescope** (today's idea,
  redrawn), so it never sits as a second magnifier under Search; Talk = five level bars beside the word.
- **Every export name stays**: 242 today, 243 after W2 adds `JunoProjects` (the gate counts them from
  `icons.tsx`). 205 drawings: 39 re-cut from d3's drawings, 166 to draw. Glyphs all-or-none per menu group.
  Hover articulation removed.
- **Native**: variable symbol templates with Ultralight-S, Regular-S and Black-S masters of identical point
  structure, produced by a purpose-built Node offsetter with a fixed number of segments per primitive
  (ICONS §3), RTL flags, `.fill` on forms, 24 pt bar glyphs at `.light`; validated in the SF Symbols app
  before commit (unverified until done).
- **Verification**: "before" rendered with the product's own `juno-icons` renderer (entry committed in
  `tools/vendor/`); in context at 1x and 2x, both themes; a real 1x display check (unverified until done).

---

## 9. Components (detail: COMPONENTS.md)

The non-negotiables, each a recipe in COMPONENTS.md:

1. **One floating-layer family** for menus, submenus, context menus, selects, popovers, the model picker,
   Code's pickers and the inbox: `--float`, radius 12, inset 4, tier 2; rows 32 (touch 44) with today's
   anatomy (16 px glyph, `ui` label, one trailing slot). `.cmenu` and `.cv2-pop` are deleted.
2. **Keyboard focus in menus is visible**: fill **plus** a 2 px ink inset outline (the fill alone is
   1.07–1.13:1 and fails WCAG 1.4.11). **Disabled items stay keyboard-focusable and readable**: label in
   `ink-2`, glyph in `ink-3`, the reason always visible as the row's description.
3. **Submenus**: one level, about five items, first row level with the trigger (shift up to fit, then flip,
   then drill-in), 100 ms intent, 300 ms grace polygon; the trigger never runs a command.
4. **Context menus** open at the pointer on every row that has a kebab (right-click, Shift+F10,
   long-press); Shift+right-click keeps the browser's menu.
5. **Composer menus open above the composer and never cover it.**
6. **Phone**: every menu is a bottom sheet that is a modal dialog with a visible Close and a named back row;
   submenus drill in (prototyped: `shots/phone-menu-{light,dark}.png`, `phone-drill-{light,dark}.png`).
7. **Buttons**: one ink primary per view; secondary, tonal, quiet, danger (destructive confirm only), icon;
   never disabled-grey on an empty form (validate on press); busy keeps the label; no scale on press.
8. **Segmented**: every selected thumb has a 1 px `line-strong` ring (≥ 3.19:1). **Switch**: the whole
   labelled row is the hit area; its name is the title, its description is a description.
9. **One page header**, one list row, one card recipe, one empty / one loading / one error vocabulary.
10. **The composer contract** (COMPONENTS §10): `+`, the model token, mode tokens, Talk, and a send disc
    with two states (send, stop) that is never disabled; text aligned to the reading column; dictation as a
    field adornment; persistent tools as removable tokens with full accessible names and 44 pt remove
    targets; Code's device and permission controls become tokens or collapse into `+`, never letters; no
    disclaimer row; no suggestions; opaque on iPhone; shadow only while content scrolls beneath.
11. **One model picker** everywhere (COMPONENTS §11), with Effort as a group of menu radio items.
12. **Voice is the composer's other state** (COMPONENTS §13): the voice bar, no glow, the Arch's stone as
    the level, captions in ink, Mute and End at 44.
13. **Bronze and signal blue are written only where the lint allows** (TOKENS §1.5): `src/components/brand/**`,
    `ui/live.tsx`, `ui/needs-you.tsx`, and the face files (`agents/agent-face.css`, `agents/face-*.ts`,
    `agents/agent-face.tsx`); natively `JunoBrand*.swift`, `JunoLive.swift`, `JunoNeedsYou.swift`,
    `JunoAgentFace.swift` and the generated face file.
14. **Roles and names** are stated per recipe (COMPONENTS §14), and forced colours keep every boundary
    (COMPONENTS §15).

---

## 10. The transcript

### 10.1 Layout and the margin

The reading column is `--measure` (36 em, 576 px at the default size), left-aligned text. **The margin**
is a lane beside the column that holds each source next to the line that cites it. It exists in three
tiers, chosen by the stage's content width relative to the measure (TOKENS §3), so the tiers follow the
reading size:

| Tier | Content width (16 px reading size) | Margin | Note content | Common windows (sidebar open, 264 + 8 px) |
|---|---|---|---|---|
| Wide | ≥ measure + 544 px (1,120 px) | gap 48 + rail 208 | numeral · title (two lines max) · domain | 1,440 → 1,168 px; 1,512 → 1,240 px; 1,280 with the sidebar closed → 1,264 px |
| Compact | ≥ measure + 364 px (940 px) | gap 32 + rail 160 | numeral · domain (title in the popover) | 1,280 → 1,008 px; 1,366 → 1,094 px |
| None | below that, and all phones | — | **a source line under each cited paragraph** + the end-of-answer sources control | 1,180 → 908 px; tablets; 390 px phones |

**The lane is reserved in the wide and compact tiers everywhere**: on the home, in chats with no cited
answer, in agent threads. The column-plus-lane group is centred in the stage, so the column sits 128 px
(wide) or 96 px (compact) left of the stage centre, and **neither the first send nor the first cited answer
moves the column or the composer** (W4 and W5 assert it). The stage header's margin toggle (`panel-right`)
hides the lane for that window (remembered per device), re-centres the column on `glide` (instant under
reduced motion), and the notes fall back to the source line. The composer stays centred on the column.
Renders: `identity-v2/shots/margin-1440-{light,dark}.png` (wide), `margin-1280-{light,dark}.png`
(compact), `margin-1180-none-{light,dark}.png` (none), `home-1440-light.png` (the reserved lane on the
home).

**Wide blocks** (code, tables, Live UI cards) may widen up to `--measure-wide` (45 em, 720 px): toward the
inline start only, so the margin lane stays clear, and **clamped to the space that exists**:
`min(measure-wide, measure + free inline-start space − page gutter)`; whatever does not fit scrolls inside
the block's own frame with a static 24 px edge fade (TOKENS §3 gives the widths at 1,168, 1,120, 1,008, 940
and at Large). Without a margin they widen symmetrically under the same clamp.

**Layout algorithm (must)**:
1. Each paragraph-level block that cites sources is followed **in the DOM** by its notes:
   `<ol class="answer-notes" aria-label="Sources for this paragraph">` with one plain `<li id="note-…">` per
   source (no role override: a `role="note"` on `li` is not allowed and fails axe's list rule). DOM order
   is therefore reading order for screen readers and for "find in page".
2. A block is **committed** when the stream moves past it (the next block starts) or the answer completes.
   Notes are positioned only for committed blocks: each note's top = the top of the line box of its first
   citing numeral, plus 5 px to align cap heights; collisions are resolved top-down with an 8 px gap (a note
   pushed down never pushes text).
3. Positions are computed once per committed block (`position: absolute` inside the answer, measured with
   `getClientRects()` of the numeral's line), and again only when the answer's width changes
   (`ResizeObserver`, coalesced to one animation frame, visible answers only). **Never per token**; the
   column never shifts because of the margin.
4. **In the none tier the same `<ol>` is shown, not hidden**: it renders as one `caption` line under its
   paragraph ("**1** field-notes.example.org · **2** ledger.example.com", `ink-2`, numerals in `ink` 560,
   up to two lines, then "+2" which opens the sources sheet); it is a button on touch (≥ 32 px hit; the 44 pt
   sources control at the answer's end stays the primary path). Notes therefore stay in reading order in
   every tier (`shots/phone-thread-light.png`, `margin-1180-none-light.png`).
5. Natively (Mac, detail column ≥ 900 pt) notes align to the citing **paragraph's** top through
   `anchorPreference` and are the paragraph's accessibility children; the iPhone uses the source line
   (NATIVE §1).

**Citation numerals** (d2): superscript `micro` 11 px 560 in `--ink` (never bronze, never blue), on every
platform including phones (no boxed chips). Each is a `<button aria-haspopup="dialog" aria-expanded
aria-describedby="note-…">` named "Source 3". **Hit area 24 × 24 px, centred horizontally on the numeral
and vertically on the line box** (top = line top + 1.5 px at the 27 px line; never centred on the raised
glyph, which would reach 2 px into the line above): measured in the prototype at the 1,440 layout, line box
215–242 px, hit area 216.5–240.5 px (`shots/margin-1440-keyboard-focus-light.png` draws exactly that box).
The reading line height stays ≥ 25.3 px at the Small size, so the box always fits. **A run of adjacent
numerals is one control** ("Sources 2 and 3", the numerals separated by a thin space, hit area as wide as
the run plus 4 px each side) that opens the popover on the first with the pager. Focus highlights the
matching note (title underline) and the note highlights its numerals; Enter, Space, click or tap opens the
citation popover; a 300 ms pointer hover previews it; it never opens on focus; Escape closes it and returns
focus to the numeral (COMPONENTS §1.10). The keyboard ring is the standard 2 px ink outline on the 24 × 24
box, radius 4. On touch the hit area is 32 and the 44 pt sources control is the primary path.

**The margin head** sits at the top of the lane, **level with the answer's first line** (its centre on the
first line's centre): "3 sources ›" (opens the docked sources panel: every source with its quoted passage)
once the answer is done; while sources are being read, **"Reading sources 3 of 4"** (`LiveDot` +
`LiveLabel` in `--bronze`, the count in `ink-2` `tnum`) above a 1.5 px **bronze `LiveRule`** whose width
steps with each source read (`margin-1440-streaming-{light,dark}.png`, re-rendered to match). Without a
margin the same line sits where the action row will appear and becomes the action row when done. The head
is a text-only control with a 24 × 24 minimum hit area.

### 10.2 Answer anatomy

- **User turn**: right-aligned (inline end), `--raised`, radius 16, padding 10 × 14, `bubble` 15/24, max
  78 % of the column; no avatar.
- **Answer**: no bubble, no avatar, no name. `reading` 16/27; `answer-h2` 20/28 600 (24 above), `answer-h3`
  16/24 600 (one family: no serif headings); `strong` 600; lists with 5 px squircle bullets in `--ink-3`
  (decorative) and `tnum` ordinal numerals in `--ink-2`; blockquotes with a 2 px `--line-strong` rule.
- **Tables**: `ui` 13.5/20, header `caption` 520 `ink-2` over a 1 px `--line-strong` rule, rows separated
  by `--line`, numbers right-aligned `tnum`, no vertical rules; wide tables follow the clamp and scroll
  inside their own frame with a static edge fade; sortable headers with `aria-sort` when the table is a data
  view (LUI §11.6).
- **Code blocks**: `--raised`, radius 12, a 36 px header (language `caption` `ink-2`, copy icon button),
  JetBrains Mono 13/21; inline code on `--raised` radius 4 with a 1 px `--line`.
- **Action row** under each answer: copy · retry · share · more (28 icon buttons with 32 hit areas, 16
  glyphs), the **sources control** when there is no margin (a capsule with a 1 px `--line` hairline edge,
  up to three 16 px source tiles + "3 sources"; d1), and at the trailing end the **stamp line** (§10.4).
  Icons show on the latest answer and on hover/focus for older ones (always on touch); the stamp is always
  visible.
- **Reasoning**: while the model reasons, the live line says **"Reasoning"** (`LiveLabel`). When it is done
  nothing sits above the answer: the time becomes a stamp fact ("reasoned 6 s") and the reasoning itself is
  the first row of the stamp's "What this answer used" popover ("Reasoning · 6 s ›"). No "Thought for"
  line (retired, §14.2).
- **Errors in a turn**: the inline error recipe (alert glyph, what happened, "Try again" · "Carry on without
  it").
- **No disclaimer under the thread** (limits are explained once in the first-run note and in Help).

### 10.3 Streaming and progress (one vocabulary)

| Moment | What shows |
|---|---|
| Before the first token | the **live line** at the answer's start: `LiveDot` + `LiveLabel` naming the actual step ("Reasoning", "Searching the web", "Reading 4 sources", "Running code") |
| Reading sources | "Reading sources 3 of 4" + `LiveRule` in the margin head (or in the live line without a margin) |
| Writing | text appears as it arrives; a new block fades in once (120 ms); the 2 × 16 px bronze `WritingPoint` sits after the last character |
| Tools in a chat answer (≥ 2 steps) | the step rail (§10.5) inline, collapsing to one line when done ("4 steps · 0:48 ›") |
| Done | the writing point fades (200 ms); the stamp line fades in (200 ms) |
| Stopped | the stamp reads "Stopped · Auto · 9 s"; a cut-off Live UI view says "This view was cut off before it finished" |

No skeleton bars, shimmer, spinners or galaxy in the transcript. One loop per screen region, for the first
5 s of each step; loops pause off-screen and in hidden tabs.

### 10.4 The stamp line (receipt + instrument, merged)

One line in `caption` 12/16, `--ink-2`, `tnum`, at the trailing end of the action row:
`<model> · <time>[ · <facts>]`. The time is always a plain duration with no lead word.

- **Model**: "Auto" when Auto chose (hover: "Auto chose <model name>"), else the model's short name.
- **Time**: "18 s", "1 min 04 s", "2 h 05 min".
- **Facts** (at most three, past tense or plain counts, no adjectives): "3 sources" (the same noun and count
  as the margin head and the sources control), "ran code", "reasoned 6 s", "used memory", "saved 1
  memory", "made 2 files", "6 steps".
- Examples: "Auto · 18 s" · "Auto · 14 s · 3 sources" · "Opus 5.5 · 2 min 10 s · 6 sources · used memory".
- It is a button (text-only control, ≥ 24 px hit): it opens **"What this answer used"** (a popover: the
  reasoning, the model and why, duration, each tool run, the sources, memory facts used with Edit / Forget /
  Not relevant / Open in memory, files made).
- Settings › General › "Show timing on answers" (default on) hides the time and facts, keeps the model.

### 10.5 Agents in the thread: header, step rail, needs-you card

Render: `shots/agent-1440-waiting-{light,dark}.png`, `agent-1440-answered-{light,dark}.png`.

**Agent header** (64 high, opaque stage, no second bar, no blur): **face 34** (the flat rig at today's
header size, AGENTS.md §4.3) · name `title-3` · one status line in `caption` `tnum`: state word ("Needs you"
`--signal`; "Working" `--bronze` with the `LiveDot`; "Blocked" `--danger` with the alert glyph; "Paused",
"Done" `--ink-2`) · task title · "Step 4 of 5" · elapsed "6 min 12 s". Trailing: Pause (tonal), Open
computer (quiet with glyph; opens the computer full screen over the thread, AGENTS.md §5.2), more (icon).
Example: **"Needs you · Weekly summary · Step 4 of 5 · 6 min 12 s"**. At accessibility text sizes the line
wraps (NATIVE §5.1).

**Step rail** (d1, with d3's per-step glyphs): an `<ol>`; a 1 px `--line` rail; markers 7 × 7 on the rail:
done = `--ink-2` squircle; live = `LiveDot`; needs you = `NeedsYouDot`; pending = a 1 px `--line-strong`
ring; failed = `--danger` square. Each row: **the step's tool glyph 16 in `ink-2`** (web search, read, a
table, a file, mail, an app, code, the computer) · label `ui` (done `--ink-2`, live and waiting `--ink`) ·
trailing **state in words and the time**: done "0:48" (`caption` `tnum` `--ink-2`, with visually hidden
"Done"); live "Working · 1:12" (`LiveLabel` + the counting timer, which keeps counting under reduced
motion); waiting "Needs you" (`caption` 520 `--signal`, in place of the timer); failed "Failed: <reason>"
(`--danger`). The current step has `aria-current="step"`. Times in m:ss ("0:48"; ≥ 1 h "1:02:05"). More
than six steps: "Show 4 earlier steps" (text-only control, ≥ 24 px hit). The same rail renders tool runs
in chat answers and research runs.

**Needs-you card** (d1 content model, d3 lift, d3's question card). Every variant shares the label row, the
material, the lift and the receipt; only the body and the actions change:

| Part | Spec |
|---|---|
| Label row | `NeedsYouDot` + "Needs you" (`caption` 520 `--signal`) · trailing "<Agent> · Asked at 16:06" (`caption` `tnum` `--ink-2`; the agent's name only outside its own thread) |
| Question | `title-3`, **states the consequence**: "Send this summary to 4 people?" (not "Approve?") |
| While waiting | `--float`, radius 12, padding 20, tier 1 whose ring is 1 px `--line-strong`; arrives on `lift` with its shadow layer landing 70 ms behind (≤ 335 ms total); iPhone `.warning` haptic; **announced once** through the app-level polite region: "Otto needs you: Send this summary to 4 people?" (natively `AccessibilityNotification.Announcement`). **No coloured leading stripe, no wash** |
| When answered | the shadow fades out (200 ms), ring → `--line`, the card collapses on `glide` (instant under reduced motion) to one receipt line: the v4 `success` check glyph 16 in `ink-2` + "You approved · Sent to 4 people · 16:07" (+ Undo for 10 s where the action allows) |
| Where | the agent thread; the home screen (under the composer, the only extra object there); the Orbit page (first, above the crew); the inbox |

| Variant (AGENTS.md §4.3 lead verbs) | Body | Actions | Lift |
|---|---|---|---|
| **Approval** ("needs your approval") | people chips (28 high, radius full, `--raised`: avatar 20 with initials centred on both axes, `display: grid; place-items: center; line-height: 1`, `micro` 600, + name `ui`); the draft (`--raised`, radius 8, padding 12 × 16, two lines + "Show the draft") | **Approve and send** (primary) · **Edit first** (secondary) · **Don't send** (quiet); the verbs name the consequence | tier 1 |
| **Question** ("asked") | the question; when it has options, each option is a Secondary button with its own words ("Vendor A first", "Vendor B first"); "Show me the draft" (quiet) when there is one | the option buttons · **Answer in your own words** (quiet; moves focus to the composer with the question quoted) | tier 1 |
| **Take control** (the computer needs a password, a code, a CAPTCHA or a payment step) | a 16:10 poster thumbnail of the computer (radius 8, 1 px `--line`) and its status line ("Needs you · take control to continue") | **Take control** (primary; opens the computer full screen) · **Not now** (quiet) | tier 1 |
| **Waiting for your Mac** ("is waiting for your Mac") | one sentence naming the Mac and what it waits for | **Open Alevr on the Mac** (primary, when a deep link exists) · **Run in the cloud instead** (secondary, when allowed) | tier 1 |
| **Blocked** ("is blocked") | the reason in `--danger` with the alert glyph | **Continue** (tonal) · **Open the task** (quiet) | **tier 0** (nothing waits on a choice from you yet; the card sits flat with a 1 px `--line` edge) |
| **Out of usage** ("ran out of usage") | the limit and when it resets, in `--warning` with its glyph | **See plans** (secondary) | **tier 0** |

The dot never appears without the words "Needs you" in the same row (the face badge included: its row or
header carries the word); `NeedsYouDot` and `LiveDot` render only beside their labels (lint, COMPONENTS
§12).

### 10.6 Sources control and citation popover

- Below the margin tier: the source line under each cited paragraph (§10.1) and the sources control in the
  action row (§10.2), which opens a popover list (each source: favicon tile 20 or the designed monogram,
  title, domain, the passage it supports, "Open at passage").
- Favicons are fetched and cached; when missing, the **designed monogram** (the first letter of the
  source's site name, i.e. `og:site_name` or else the first hostname label that is not `www`, in `micro`
  600 `ink-2`, on `--raised` with a 1 px `--line` ring, radius 6) replaces today's grey letter squares.
- The citation popover: COMPONENTS §1.10. Never interactive beyond "Open at passage" and the pager.
- **Sample content in fixtures, galleries, the landing and screenshots uses subdomains of `example.com`,
  `example.org`, `example.net` (so monograms differ: `field-notes.example.org` → F) and invented titles;
  never real third-party sites** (the d3 landing's scrumguides.org and basecamp.com "Shape Up", the web
  audit's Wikipedia and Python docs seeds, and vendor sample names, are replaced; seed:
  `identity-v2/tools/seed/identity-seed.json`).

### 10.7 Live UI (visual requirements from LUI §11; behaviour stays with the Live UI workstream)

1. Live UI views are **tier-0 cards** on the stage (radius 12, `--stage` + `--line` light, `--raised` +
   `--line-soft` dark). No in-flow shadow (today `0 12px 32px -16px`).
2. **Control fills are ink, never bronze** (sliders, steppers, selected chips, the recommended pick); the
   "Best pick" badge is ink fill with `--on-ink` text (17.76 / 14.59:1, fixing 2.36:1 in dark, LUI B5).
3. One honest "Interactive" cue (16 px customize glyph + `caption` `ink-2`) only when the view has controls.
4. A distinct look and copy for each phase: building (per item; a static `--raised` placeholder only for the
   next item), complete, cut off ("This view was cut off before it finished"), empty ("No data to chart"),
   partial ("Only the first 200 of 500 values are used"), calculation problem ("Some values couldn't be
   calculated"), failed (readable fallback, the source behind a disclosure).
5. Targets ≥ 44 × 44 on coarse pointers (steppers, chips, timers, checkboxes, tabs, flashcard arrows,
   hotspots, links).
6. **Chart family**: line, area, bar, horizontal bar, stacked bar, pie/donut, scatter; series from
   `--chart-1…6` plus marker shape and dash; legend chips; an axis-density rule at phone width (≥ 3 ticks);
   wrapped or tooltipped long labels; a readout formatted like the metrics; a "Show data" table under every
   chart; a focus-visible ring and the crosshair at rest on focus.
7. **Table pattern**: sortable headers with `aria-sort`, sticky header, numeric alignment, a phone layout
   (horizontal scroll with a visible edge fade), a row-cap notice, hover and focus rows.
8. A per-view actions menu (Copy as text, Copy data, Download CSV, Save image) in the card header's trailing
   corner.
9. Send-state styles for controls that post a message: idle, sending, sent, queued, "Couldn't send. Try
   again".
10. Long text wraps; very long words break; RTL uses logical properties; reduced-motion equivalents for
    count-up, flip and tab moves; phone density collapses to one column.
11. Native draws the same spec; unknown kinds fall back to readable text, never an empty card.

### 10.8 Artifacts (visual requirements from ART §6)

- **One artifact window, two placements**: docked in the stage as a 560 px side sheet beside the chat, and
  full page at `/a/{id}`; the same header: title (`ui` 520), status (`caption`: "Published · v3", "Alevr's
  suggestion is waiting"), version stepper, Edit, Ask Alevr, Share, Export ▾ (named files: "Excel workbook
  (.xlsx)", "Word document (.docx)", "PowerPoint (.pptx)", "PDF", "Source (.json)"), more. Neither placement
  is read-only for the latest version.
- Per-type edit states (document blocks with hover, caret, add-between, drag handle; deck slide strip with
  selected slide and fit warnings; sheet cell, range, formula bar, header menus, "recalculated" ink in
  `--ink` 600), saving honesty ("Saving…", "Saved", conflict, offline keeps the value), visible Undo/Redo.
- Change review speaks the type (cells `Sheet1!B4 120 → 140`, block-level word diff, slides by number);
  insert/delete never by colour alone (+ / − and words, in `--success` / `--danger`); a loud warning when a
  suggestion would undo the person's edit; Apply · Dismiss · "Ask for a different change" as equals.
- Preview states (loading with "taking longer than usual" after 5 s, run error with Console and source,
  blocked library); present mode for decks; the Artifacts home on the page header and list-row recipes with
  picture tiles; phone: a full-screen sheet with the same actions.

### 10.9 Memory in chat (MEM §7)

The memory receipt lives in the stamp line ("used memory", "saved 1 memory") and its popover (§10.4): each
fact with *why* it was used and Edit, Forget (or Undo when saved this turn), Not relevant, Open in memory.
It never covers the conversation on a phone. **The stage header's subtitle carries the memory state, on all
three platforms**: a project chat states "Uses project memory only"; Incognito states "Memory is off in
this chat"; an ordinary chat has no subtitle. "Don't remember this" is in the answer's More menu.

### 10.10 Research reports

The report reader reuses the transcript: the article at the reading measure, **the same margin** (cited
rail) on wide windows and the source line below, contents as a sticky list at the inline start on windows
≥ 1,280 px (a popover below), the audit verdict under the title (`caption`), a support mark per block in the
gutter (check, partial, flagged, each with a word on hover/focus) and a "Next flagged claim" control;
numbers in the text match the rail and the exports (one citation vocabulary, RES §6.6).

---

## 11. Shell and information architecture

### 11.1 Composition (what makes it read as a rework)

1. **The sidebar sits directly on the granite base**: no panel fill, no seam hairline (today: a separate
   flat panel with a seam).
2. **The work sits on an inset paper stage**: 8 px from the window's top, right and bottom edges, radius 16,
   a `0 0 0 1px` ink 6 % edge (dark white 5 %); full-bleed with no radius below 1,024 px.
3. **Inside the stage, answers have two lanes**: the reading column and the margin (§10.1), the lane
   reserved on wide windows. The lane is structure, not a panel.
4. **The composer is a floating object concentric with the stage** (radius 24), lifted only while content
   passes under it; its text sits on the column's edge.
5. **Page titles are one Geologica line**; the stage header shows the title only after it scrolls away.
6. **The sidebar mark is the window's live light** (BRAND §2.2).

Renders of the composition: `identity-v2/shots/margin-1440-light.png`, `margin-1440-dark.png`,
`home-1440-light.png`.

### 11.2 Sidebar (web; the Mac and iPhone drawer use the same order)

```
[Arch 20, mono · stone bronze while live]          [inbox bell 32] [hide sidebar 32 · ⌘\]
New chat                                            ⌘⇧O (on hover; Mac app: ⌘N in the menu bar)
Search                                              ⌘K
                                                    (12)
Projects
Library
Research                                            (telescope glyph)
Code
Customize
                                                    (16)
[orbit] Orbit             1 working · 1 needs you ›  ← one 32 px header row, a link to /agents
  (face 20) Mira                          ● Working
  (face 20) Otto                          ● Needs you
                                                    (16)
Recent
  Weekly review template                         (pin)      ← pinned chats first, pin glyph trailing
  Hiring loop scorecard                          (pin)
  Draft a data retention policy          ● Needs you        ← a chat waiting on the person keeps its place
  Planning formats for a small team
  …
────────────────────────────────────────────────────
(SR) Sam Rivera · Max plan                        [settings]  ← account menu on the row
```

- **Width** 264 (232–336, drag below 200 closes). **Collapses to nothing** (no icon rail) with ⌘\ (⌘⇧S,
  today's binding, stays an alias for one release) or the button; the stage header then shows the sidebar
  button. Hovering the window's leading edge for 300 ms peeks the sidebar as a tier-2 float.
- **Shortcuts**: New chat is **⌘⇧O on the web** (today's binding in `src/lib/shortcut-groups.ts:17`;
  browsers keep ⌘N for a new window and never deliver it to the page) and ⌘N only in the Mac app's menu bar.
  W4 updates `shortcut-groups.ts` and the shortcuts sheet, and a test fails any printed hint that is unbound
  or browser-reserved.
- **Rows** 32 (touch 44), `ui` `ink-2`; the selected destination is `--selected` + `--ink` 520 + its
  on-glyph + `aria-current="page"`; section labels `caption` 520 `ink-2`, sentence case, no mono.
- **Destinations**: Projects, Library, **Research** (new: the list of reports, RES B8), Code, Customize.
  Activity merges into the **inbox bell** (one inbox: a popover with "See all" → `/activity`). **The bell
  never carries state by colour alone**: its dot is ink and means unread; its accessible name and tooltip
  carry the words ("Inbox, 3 unread, 1 needs you"); what needs you is already said in words where it lives
  (the Orbit header, the agent rows, the chat's Recent row).
- **Orbit appears once**: a section whose **header is a 32 px row** (Orbit glyph, "Orbit", the counts in
  words, a chevron; the `--hover` plate; a link to the Orbit page; accessible name "Orbit, 1 working, 1
  needs you"; the section is a `role="group"` labelled by it). Rows list **only busy agents**: the busy set
  is **working, thinking, listening, waiting and blocked** (a new `ORBIT_BUSY_STATES`; today's
  `ORBIT_LIVE_STATES` in `app-sidebar.tsx:358` leaves out `waiting`, which would drop exactly the agents
  that need you). Each row shows its state in words: "Working" (working, thinking), "On a call"
  (listening), "Needs you" (waiting), "Blocked" (blocked). The header counts "N working" (working,
  thinking, listening) and "N needs you" (waiting and blocked). With no busy agent the header row stays,
  reading "Orbit ›", so the page is always one click away and the section never shows an empty list (a
  decided conflict, BEST_OF). **The count is derived from the same list as the rows.** No separate Orbit nav
  item, no badge.
- **Asks that are not an agent's** (today's "Needs you" fold, `app-sidebar.tsx:247-345`: chat tasks waiting
  for approval) are shown **on the chat's own Recent row**: `NeedsYouDot` + "Needs you" in its trailing
  slot; the row keeps its place (pinned chats still lead). They also appear in the inbox. The fold goes.
- **Recent**: pinned chats first, then by recency; no separate Pinned section.
- **Row menus**: the chat row menu (COMPONENTS §1.8) on the kebab, right-click, Shift+F10, long-press.

### 11.3 Settings (exactly 12 sections)

Settings **take over the sidebar column**: the column shows "‹ Back to Alevr" (a 32 row), a search field
(`--well`), then the 12 sections in three groups, and the stage shows the pane. No second navigation
column (today's modal rail and d3's two columns, ~600 px of navigation at 1,440, are gone). Render:
`shots/settings-1440-{light,dark}.png`.

| Group | Sections (ids from `settings-sections.ts`) |
|---|---|
| Personal | General (`general`) · Notifications (`notifications`) · Personalization (`personalization`) · Memory (`memory`) · Models (`models`) · Voice (`voice`) |
| Account | Account (`account`) · Data & privacy (`data`) · Plan & usage (`billing`) |
| Connections | Apps (`connectors`) · Devices (`devices`) · Code (`code`) |

The pane: `title-1` (Geologica) section name + one-line description, then **grouped setting cards** (d3:
tier-0 cards, radius 12, rows ≥ 56 separated by `--line-soft`, the whole row the switch's hit area), group
heads `title-3`. Changes save on change; a toast confirms only what can be undone. Mac and iPhone show the
same 12 sections (NATIVE §1).

**One home each for Memory and Apps.** The Memory page is the canonical place for memory: it is reached at
`/memory` and is what Customize's **Memory** tab shows (one page, not two). **Settings › Memory** holds only
the on/off switch with its consequence, the defaults (reference past chats, the never-remember topics) and
"Open memory". The same pattern for Apps: the canonical page is Customize › **Apps** (the connections
page), and **Settings › Apps** holds only the defaults and "Open apps". `check-ia-parity.mjs` checks both
on the web, the Mac and the iPhone.

### 11.4 Stage header

52 high, opaque `--stage`, a 1 px `--line` only once content scrolls under it. Leading: the chat title
(`ui` 520) with a title-menu chevron (Rename, Add to project, Pin, Share, Export, Delete…), or the page title
after it scrolls away. **Subtitle** (all platforms, when space allows): the project, Incognito or memory
state (§10.9); never the stamp. Trailing: Share, the margin toggle on wide windows (`panel-right`: hides or
shows the margin lane, §10.1), More. Bare 32 icon buttons; no bordered circles (WA §3.12).

### 11.5 Home

Renders: `shots/home-1440-{light,dark}.png`, `home-1440-needs-you-{light,dark}.png`,
`home-390-{light,dark}.png`, `home-390-needs-you-{light,dark}.png`.

- **Composition**: the home is the first page of an empty transcript. On the reading column (in its
  reserved-lane position, §10.1), at 30 % of the stage height: the **dateline** "Thursday 30 October"
  (`caption`, `ink-2`, Inter, d2), then the **greeting as a question** in Geologica `display` 40/46,
  left-aligned on the column, then the composer (`--composer-w`, tier 0) 24 px below. **One left edge**: the
  dateline, the greeting and the composer's placeholder start on the same x (the composer's text inset is
  `(composer-w − measure) / 2` = 24 px; measured in the prototype at the 1,440 layout: all three at
  x = 432 px). On sending, the composer moves to the bottom on `glide` and the message lifts into place
  (`lift`): the same page, not a scene change; the column does not move.
- **Greeting width rule**: max width `--measure` + 24 px (600 px, so it never passes the composer's right
  edge), `text-wrap: balance`, at most two lines; if a long name would need a third line, the name is
  dropped. Phone: `display-compact` 30/36, left-aligned at 24 % of the height with 20 px gutters, at most two
  balanced lines.
- **The greeting line (owner pick, §20 Q1)**. The previous pick, "What are you working on, Sam?", is
  ChatGPT's own home heading (OpenAI Academy's getting-started page, found by the reviewers through web
  search; unverified at source), so it is retired with the other competitor lines (§14.2). Five owned
  candidates in Alevr's plain, work-first voice, measured in Chromium with the shipped Geologica at 460,
  −2.6 %, CRSV 1 (the method reproduces the reviewers' 589 px for the old line):

| # | Candidate (EN) | Width at 40 px / 30 px | Notes |
|---|---|---|---|
| 1 | **"What needs doing, Sam?"** (no name: "What needs doing?") | 465 / 351 | **build default**; FR "Qu’y a-t-il à faire, Sam ?" (445), DE "Was steht an, Sam?" (369), RU "Что нужно сделать, Сэм?" (477); "…, Alexandra?" 571 fits one line; RU "…, Александра?" 641 wraps to two balanced lines |
| 2 | "What’s next, Sam?" | 348 / 263 | today's shipped contract line (`home.greetingNamed`), FR "Et maintenant, Sam ?" (403); continuity, but the plainest |
| 3 | "What shall we take on, Sam?" | 534 / 404 | the lift idea in words; "we" presumes a partnership the earlier pick avoided |
| 4 | "What’s next for Q3 planning, Sam?" | 648 / 490 | **ties the line to something only Alevr knows**: the person's most recently active project (last 7 days), falling back to #1; two lines at 40 px |
| 5 | "Sam, what’s first?" | 332 / 251 | the shortest; reads well at any hour |

  **Collision check (recorded 30 Oct 2026)**: (a) the repo's competitor research (`docs/rework/program/
  COMPETITIVE_AUDIT_2026-10-15.md`, `docs/rework/research/*`, `docs/rework/audit/*`,
  `docs/chat-rework/audit/*`, grepped for each candidate) contains none of them as a competitor line ("What's
  next" appears only in Alevr's own earlier specs); it records "Where should we begin?" (ChatGPT, :297), "How
  can I help you today?" and "Back at it, <name>" (Claude, :629), "How can I help, *Name*?" (today's own web
  greeting, a Claude pattern), "Welcome back, <name>" (Mistral, `ai-chat-ui-references-ios.md:131`);
  (b) web search on 30 Oct 2026: candidate 1 searched with "ChatGPT", "Claude" and "Gemini" returned no
  product using it as a home heading; candidates 2–5 were **not** searched one by one; two searches for the
  competitors' rotating home headings returned no usable list; one search surfaced "pick up where you left
  off" as Anthropic's framing for its memory feature, so that phrase is avoided; (c) the live ChatGPT, Claude
  and Gemini home screens were
  **not opened** from this session (no access): **unverified at source**. W4's owner-rules gate requires a
  person with accounts to check the chosen line against the three live home screens and record it.
- **Nothing else**, except: one lifted needs-you card under the composer when an agent is waiting
  (§10.5). No chips, no starters, no tray, no suggestions above or below the composer.
- Why: both competitors centre one line over a centred composer; Alevr's home is a document's first page:
  a dateline and a question on the reading column's edge with the composer's text on the same edge, and the
  column already where the conversation will be.
- Code home uses the same composition with "What needs building, Sam?" (509 px at 40).

### 11.6 Phone web shell (390 px)

Header 52 (drawer button 44, the chat title with its menu, new chat 44); the drawer on `--base`, 86 % of
the width (max 336), **opening from the leading edge and pushing the stage**, which shows its radius-16
corners and edge against the base while the drawer is open (dim `--drawer-dim`); the sidebar's order and
rows at 44; the stage full-bleed when the drawer is closed; the composer pinned at the bottom, opaque, with
the safe area; every menu a bottom sheet with drill-in (§9.6); dialogs become sheets below 640 px; no double
titles; no chips anywhere; citations as superscript numerals with the source line (§10.1). Renders:
`shots/phone-thread-{light,dark}.png`, `phone-menu-*.png`, `phone-drill-*.png`, `home-390-*.png`,
`voice-390-*.png`.

---

## 12. Pages

Every page uses the page header (COMPONENTS §6), list rows (§7), cards (§8) and the empty/loading/error
vocabulary (§9). Page content max 1,040 px with the page gutter.

| Page | Spec |
|---|---|
| **Projects** | Header "Projects" + count + "New project" (primary); toolbar: segmented All · Pinned · Shared with counts, filter field, sort, list/grid. **Default view: a table** (d1): a neutral `--raised` tile 32 with the portfolio glyph in `ink-2` · name + one-line description · Chats · Files · Updated (`tnum`, right-aligned) · kebab. Grid view: tier-0 cards with **the same neutral tile** at 40 (portfolio glyph or a two-letter monogram in `ink-2`), name (2 lines max), one `caption` line. No tints, no cover art (eight galaxy covers deleted). Render: `shots/projects-1440-{light,dark}.png` |
| **Library** | Header "Library" + "Upload" (primary); segmented All · Made by Alevr · Files · Media · Research with counts; search; sort; list/grid. Table (d2 structure): file tile 32 (d3) · name + kind/size `caption` · From (chat) · Kind · Modified `tnum` · kebab; `line-strong` header rule. Grid: picture tiles. Drop anywhere to upload. |
| **Research** (new destination) | Header "Research" + "New research" (primary, arms Deep research in a new chat); segmented All · Live · Done · Failed with counts; rows: report title + question `caption` · state word (Working in `--bronze` with `LiveDot`; Needs you in `--signal`; Done · checked; Failed + reason in `--danger`) · audit verdict · date. The run console and reader follow RES §6: live state above the fold at 390 px, progress as rounds or time bounds (never a fake percentage), "Write with what you have" primary, Pause and Guide secondary, Stop destructive with a confirm, every state with its own words, cost in the plan's currency labelled as spend. |
| **Memory** (canonical; also Customize's Memory tab, §11.3) | Header "Memory" + one on/off row with its consequence ("Alevr won't learn or use memory while this is off") and distinct paused / blocked / reading-past-chats / no-model states; a summary card (updated date, Rebuild, what reads it); facts as two-line rows (sentence editable in place; topic; scope; Sensitive · Inferred · Added by you as words; "Learned in <chat>" link; "Used <when>"; menu with Edit, Move to project, Open source chat, Forget, Delete), switchable by topic or date with search; retired history behind a disclosure; the never-remember area; import as a three-step dialog; the activity side sheet. The 40–60 px editorial display and constellation go. |
| **Code** | On the shared shell and recipes: the Code home (§11.5), sessions in the sidebar's Recent with the same row, "All projects" as a select (no mono), the session view with its panes as docked side sheets, the shared composer with Code's tokens. `.cv2-*` styles (851 lines, 34 local tokens) fold into the family; mono only for code, terminals, diffs and file contents. |
| **Orbit (agent home)** | **Today's information architecture (AGENTS.md §4.3, §5.1), restyled with v2 tokens**: header "Orbit" + the hire field on the composer recipe (placeholder "Describe a job for a new agent"; validates on press); then **what needs you first**: the needs-you cards (§10.5), lifted, each with the ask itself and the way in, no face (the crew below shows it); then **the crew** (`OrbitCrew`): one tile per agent with its **large live face** (120 px for up to four agents, 96 for six, 64 beyond; 72 on a phone, two columns), its name, its role and one line in words saying what it is doing ("Working on the competitor pricing brief", "Next: Weekly spend review, Mon at 09:00", "Ready", "Paused"); the ⋯ menu revealed on hover or focus (always on touch). Tiles are tier-0 cards on the stage. **Empty roster: the hire board** ("Hire your first agent" with the starting points, AGENTS.md §5.1), not a generic empty state. |
| **Agent profile** | **In the thread's side slot** (`?agent=profile`; `/agents/[id]` redirects there, AGENTS.md §3.1): a 560 px docked side sheet with the face (96), name `title-2`, role and **Message**, then the profile's sections as **grouped tier-0 cards** (Needs your answer / Working on, Ideas, Working toward, When it works, What it knows, What it can use, How much it asks, When it tells you, What it thinks with: the model picker §9.11, Runs on, What it may remember, What it may spend); the footer pauses or retires it. No tabs. |
| **Agent thread** | §10.5; the composer placeholder "Message Mira". |
| **Agent live computer view** | **Full screen over the thread** (`?agent=computer`, AGENTS.md §5.2), on the stage colour with no blur (`backdrop-blur-xl` in `agent-computer.tsx` goes): a 16:10 viewport in a radius-12 frame with a 1 px `--line`; a top bar with the status badge in words ("Running", "Needs you · take control to continue", "Paused for you", "Sleeping", "Waking up…"), **Watch** / **Take control** (primary when the agent needs you) / **Hand back to <name>**, Close; below the viewport the feed of the last 5 actions. |
| **Customize** | Header "Customize"; tabs Apps · Skills · Routines · Memory · Instructions (one name: "Routines", not "Automations", per the shell contract's retired list); each tab is the canonical page for its subject (§11.3); rows and tier-0 cards; connector detail as a side sheet. |
| **Activity** | Header "Activity"; the inbox list (rows with the actor's face or glyph, sentence, `tnum` time, unread as `--ink` 520 + a 7 px `--ink` dot; needs-you items with the signal dot and words). |
| **Profile** | Header with the account's avatar and name (`title-1`); activity chart in chart tokens; no editorial display. |
| **Upgrade / plans** | Header "Plans"; plan cards as tier-0 cards side by side with one primary on the recommended plan; no orbit drawing; prices in the viewer's currency; the operator-facing "Set the Stripe environment variables" line becomes "Upgrades aren't available on this server yet." |
| **Landing** | §12.1. |
| **Auth (sign in, sign up, reset)** | Two panes on desktop: the base on the inline start with the large Arch (240 px, stone bronze) and the lockup, and the stage on the inline end with a 360 px form column (`title-1` **"Sign in to Alevr"**, which states the task; "Welcome back" is retired, §14.2), fields 40 high, the primary full width); one column on phones. No galaxy, no generated art. Render: `shots/auth-1440-{light,dark}.png` |
| **Legal** | Page header + reading measure; the template marker "[À COMPLÉTER : …]" must never render (content decision for the owner, §20). |
| **Download** | Header "Get the apps"; platform cards (Mac, iPhone) with their real state in plain words ("The Mac app isn't available to download yet.") and the primary only where a download exists. |
| **404 / 500** | The page-error recipe: `display` Geologica "This page isn't here" (404) / "Something went wrong on our side" (500), a `caption` code, "Back to Alevr" (primary) and one secondary. No giant numerals, no galaxy. |
| **Shared chat** (`/share/[token]`) | The stage alone (no sidebar), the transcript with the margin, a header with the small lockup and **"Continue this conversation"** (primary; fixes the dead end in the website discovery report §2). |

### 12.1 Landing and public pages

Render: `shots/landing-1440-{light,dark}.png` (the hero with the real prototype transcript in the frame).

- **Built on the app's tokens and components**: the `--alv-*` palette, type scale and shadows
  (`src/components/home/alv-base.css`) are deleted; the landing is the product's own stage, type and
  components.
- **Nav** 64: small-cut lockup, Product · Orbit · Code · Pricing · Download, Sign in (quiet), "Get Alevr"
  (primary, 40).
- **Hero** (d1 composition, d3 type): left column: a `caption` line "Alevr for Mac, iPhone and the web";
  the headline in Geologica `hero`: **"Answers you can check. / Work that keeps going."** (not shared with
  any direction; "Think it through" was shared by d1 and d3); one lede at 18/28 `ink-2`: "Alevr reads,
  writes and codes with you, puts every source beside the line it supports, and runs agents that ask
  before they act."; "Get started" (primary 40) and, **only when a Mac build exists** (the same condition as
  the Download page), "Download for Mac" (secondary 40). Right: **the real product at about 78 % scale** in
  a radius-16 frame with the stage edge, bleeding off the right edge, showing a wide-tier answer with its
  margin. Never a mock with a sidebar the app does not have.
- **"Every answer shows its working"** section, built from real components: an answer with three
  citations and the margin (sources on `example.*` subdomains), the step rail with timers, and one lifted
  needs-you card (the page's only lifted object). Then Orbit, Code, the platforms, pricing and the footer.
- No scroll-reveal choreography hiding content, no marquee (`lab-marquee.tsx` goes), no generated
  imagery, no vendor sample names, no real third-party sources.

---

## 13. Native (detail: NATIVE.md)

- **What carries Sculpted natively** (NATIVE §0.1): on the Mac, the detail column draws the granite base and
  the stage as an inset sheet (verify on device with the glass sidebar; edge-to-edge is the decided
  fallback, owner §20 Q8); the margin at ≥ 900 pt; the lifted needs-you card with its shadow lag; the Arch as
  the window's live light; granite and bronze; the composer lifting only over content. On the iPhone: a push
  drawer that reveals the base behind the rounded stage sheet; the source line under cited paragraphs; the
  same lift with `.warning`; the voice bar's stone. The Mac's floating glass sidebar and the iPhone's single
  lane are accepted as platform expression.
- **System chrome only in glass; every Alevr surface opaque** (the stage, transcript, composer, cards, the
  needs-you card, faces, pages). The 121 `.junoGlass` page controls become `.bordered` /
  `.borderedProminent` (ink) / `Picker(.segmented)`.
- **Keyboard-only focus natively** (NATIVE §2.1): `.focusEffectDisabled()` on Alevr-drawn fields with an ink
  ring on keyboard focus only; gated by `check-native-focus.mjs`.
- **One `JunoComposerShell`** in the package for both apps: **the existing component is extended to the
  iPhone** (radius 24, opaque, tier 1 only while content scrolls beneath, the voice bar inside); the
  1,977-line iPhone composer is retired.
- **Drop `platformFactor 0.75`**; the four springs map 1:1.
- **Four-way colour resolve** (light, dark, HC light, HC dark) in `Color.junoAdaptive`; the iPhone literal
  palette is deleted.
- **Generated `AccentColor` (= ink) for both apps and `LaunchBackground` (= stage) for the iPhone** (the Mac
  has no launch screen); no dark launch flash (verify on device).
- **Mac sidebar selection is drawn by the system** (AccentColor ink: graphite pill; users with their own
  system accent keep it); the custom pill is deleted.
- **iPhone**: system `Menu` for `+` and the model token (the bloom panels and the 4,000 × 4,000 tap catcher
  are deleted); `.warning` haptic plus a VoiceOver announcement only when an agent needs you; no haptic on
  send; accessibility text sizes change layouts rather than truncate (NATIVE §5.1).
- **Delete decorative debt**: `JunoComposerAura`, `JunoProviderGlow`, `JunoBorderBeam`, `JunoShimmerText`,
  `JunoAIcssShine`, `JunoProductOrbit`, the pointer-chasing `JunoDotGrid`, the galaxy as the live mark.
- **The iPhone app stops being ChatGPT-modelled**: 45 + 9 competitor references removed from comments and
  rationale; the retired greeting replaced; the shell contract compiled in; IA parity with the web (same
  sidebar order, Orbit busy-only, pinned-first Recent, exactly 12 settings sections).
- **Faces**: the same flat rig in two parts: data generated from `face-*.ts` into `JunoGeneratedFaces.swift`;
  the procedural rig ported by hand; golden frames compare the two within 0.25 pt (NATIVE §6).
- **Gates**: literal radius and colour, bronze/signal budgets, focus, blur in transitions, bounce ≤ 0.10,
  retired copy, IA parity, wrapper-level glass counting (NATIVE §8). Device checks: NATIVE §9.

---

## 14. Voice and copy

### 14.1 Five interface lines

| Line | Pattern |
|---|---|
| "What needs doing, Sam?" | The greeting: a question, a name, nothing else (build default; owner pick in §20 Q1). |
| "Auto · 14 s · 3 sources" | The stamp: the model, a plain duration, facts; no lead words, no adjectives, no "I". |
| "Mira needs a decision before she sends the email." | An agent waiting: who, what, why it stopped. |
| "Delete “Planning formats for a small team”? The chat and its 2 files are removed. This can't be undone." | A confirm: the object, the consequence, a named verb on the button ("Delete chat"). |
| "Couldn't reach that page. Try again, or carry on without it." | An error: what happened, two ways forward, no apology theatre. |

Rules: sentence case on web and iPhone (Title Case only in Mac menus); verbs on buttons; no exclamation
marks; no "AI" as a noun in the interface ("Alevr" or the agent's name); one name per tool everywhere
("Web search"); one noun per count ("sources", in the margin head, the sources control and the stamp);
"Incognito", never "Private chat"; "Routines", never "Automations"; no copy borrowed from another assistant,
checked against the retired list.

### 14.2 Copy list (retired → replacement)

| Retired (where; source) | Replacement |
|---|---|
| "Alevr can make mistakes. Check important info." (`chat-view.tsx:2187`) | nothing under the thread; first-run note: "Answers that use sources show them beside the line they support." (states only what is true: an answer with no sources shows none) |
| "How can I help you today?" (`composer.tsx:827`, `chat-view.tsx:2299`; Claude) | home placeholder "Describe what you need, or drop a file" |
| "How can I help, <name>?" (today's web greeting, `empty-state.tsx`; a Claude pattern, `docs/rework/audit/web-shell-chat.md:123`) | the greeting (§11.5) |
| "What can I help with?" (Mac `DesktopEmptyChat.swift:209`, iPhone `JunoMobileConversationsView.swift:2979`; ChatGPT) | the greeting (contract `home.greetingNamed`; default "What needs doing, {firstName}?", FR "Qu’y a-t-il à faire, {firstName} ?") |
| "What are you working on?" (the previous v2 pick; ChatGPT's home heading per the OpenAI Academy page, unverified at source) | never used |
| "Where should we begin?" (ChatGPT, COMPETITIVE_AUDIT:297) | never used |
| "Back at it" (Claude, COMPETITIVE_AUDIT:629) | never used |
| "Welcome back" (auth title in §12 before this revision; Mistral's home greeting and a common sign-in line) | auth title "Sign in to Alevr" |
| "Worked for <time>" (stamp lead in the previous revision; ChatGPT Work and Codex, COMPETITIVE_AUDIT:302, `docs/rework/research/openai.md:141`; `code/v2/thread.tsx:6-7` credits it to a Codex front end) | the stamp's plain duration ("Auto · 14 s · 3 sources"); Code's run summary likewise ("3 min 43 s · checked with `swift test`") |
| "Thought for <time>" (reasoning line in the previous revision; ChatGPT, `docs/chat-rework/audit/external-motion-audit.md:61-62`) | the live line "Reasoning" while it runs; then the stamp fact "reasoned 6 s" and the popover row "Reasoning · 6 s" |
| "What’s next?" (contract `home.greeting`, today) | kept as candidate 2 (§11.5); replaced by the owner's pick |
| "Ask a follow-up" | "Reply, or ask something new" |
| "Describe a task or ask a question..." (Code) | "Describe the change" |
| "What are you building, Sam?" (the previous Code home line) | "What needs building, Sam?" |
| "Private chat" (Mac and iPhone) | "Incognito" |
| "Search the web" (`+` menu) | "Web search" |
| "Good afternoon, Sam." (d2) / "What are we working on, Sam?" (d3) | not used |
| "Sent. Answering below." on a refused send (LUI B6) | "Sent" · "Queued: sends after this reply" · "Couldn't send. Try again" |
| "Investigating" on paused, failed or cancelled runs (RES B12) | "Paused" · "Failed: <reason>" · "Cancelled" |
| "Nothing to draw yet." on a finished chart (LUI B16) | "No data to chart" |
| "1 ingredients" (LUI B15) | plural rules ("1 ingredient") |
| Memory load error blaming the connection (MEM B15) | "Couldn't load your memory. Try again." |
| "Set the Stripe environment variables" (`billing/upgrade-view.tsx:318-323`) | "Upgrades aren't available on this server yet." |
| "Not published yet" (download page) | "The Mac app isn't available to download yet." |
| d1/d3 landing "Think it through. …" | "Answers you can check. Work that keeps going." |

`contracts/product/juno-shell-v1.json` `retired` gains every left-hand string except "What’s next?"
(matched case-insensitively as a leading phrase, so "Worked for 2m 30s" and "Back at it, Ana" both fail);
`check-native-copy.mjs`, a web copy test and W4's owner-rules spec fail if one reappears in source,
`.xcstrings` or the rendered home, thread or settings. W0 makes the contract edits (MIGRATION W0).

---

## 15. Accessibility (the floors, all gated)

1. Text ≥ 4.5:1 on every ground **and every state fill** in four appearances; `ink-2` ≥ 6:1 light /
   ≥ 6.9:1 dark everywhere and ≥ 9:1 on the four dark grounds, with APCA |Lc| ≥ 70 on dark grounds; status
   words ≥ 6:1 light / ≥ 7:1 dark on the four grounds (TOKENS §1.3); non-text boundaries, indicators, the
   focus ring and chart series ≥ 3:1.
2. `ink-3` never carries information (lint).
3. Focus visible on every control from the keyboard only, 2 px ink outline, never obscured, on every
   platform; menus and lists show an inset ring on the focused row, not only a fill. A field's 1 px edge
   colour change on focus is a field state, not a ring.
4. Targets ≥ 24 × 24 px (web pointer), 28 × 28 pt (Mac), 44 × 44 (touch); text-only controls included;
   switches' whole rows; citation numerals 24 × 24 inside their own line box, clusters as one control.
5. State is never colour alone: every status has a word (and usually a glyph or a shape); the needs-you dot
   and the live dot render only beside their words; the inbox bell carries its state in its name; diffs use
   + / − and words.
6. Semantics: menus `role="menu"`/`menuitem*` (nothing else inside: Effort is a group of `menuitemradio`);
   phone sheets `role="dialog"` `aria-modal` with a visible Close; popovers `role="dialog"`; destructive
   confirms `alertdialog`; segmented `radiogroup`; tabs `tablist`/`tab`/`tabpanel`; switches `role="switch"`
   named by their title; the step rail an `<ol>` with `aria-current="step"`; the selected sidebar row
   `aria-current="page"` (its fill is 1.08:1, so selection is carried by ink, weight, the filled glyph and
   `aria-current`); citation numerals are buttons that `aria-describedby` their notes (plain `li`, in DOM
   order); one polite live region per transcript for streaming status, one for research runs, **one app-level
   region for needs-you arrivals**; voice captions announce finished sentences (COMPONENTS §14).
7. Disabled items stay focusable, readable (`ink-2` label) and show their reason as visible text.
8. Reduced motion fades; size and layout changes are instant; loops stop; no blur. Increase Contrast swaps
   the HC twins on all three platforms. **Forced colours** keep every boundary and ring (COMPONENTS §15).
9. Dynamic Type on iPhone with layouts that change shape at accessibility sizes (NATIVE §5.1, checked at
   AX3 and AX5); the reading size setting on the web and Mac.
10. RTL: logical properties; **the drawer opens from the leading (inline-start) edge, which is the right
    side in RTL**; context menus open toward the inline end of the pointer; submenu arrows follow the
    reading direction; directional icons mirror. W4 and W8 screenshot an RTL drawer, a menu with a submenu
    and the margin.
11. No endless animation: live loops stop 5 s after each step starts (WCAG 2.2.2).

---

## 16. Pipeline, lint and gates

- **Sources of truth** (unchanged in kind, extended in scope): `src/lib/tokens/palette.source.ts` (new,
  colour) and `src/lib/tokens/type.source.ts` (new, type platform data) → `src/app/globals.css` (triplets,
  alpha roles, shadows in four appearances, springs, durations, shell metrics) and `tailwind.config.ts`
  (radius in px with the `--r` plugin, `fontSize` in rem, spacing, platform variants) →
  `scripts/generate-design-tokens.ts` → `src/lib/design/tokens.generated.ts`, `JunoGeneratedTokens.swift`
  (colours four-way, type with `iosTextStyle`/`macPointSize`/`appleWeight`, springs, elevation, shell),
  `AccentColor.colorset` (both apps), `LaunchBackground.colorset` (iOS). `--check` in CI, including no
  unmapped colour property.
- **Aliases**: colour (TOKENS §1.6), type rungs (TOKENS §2.2), radius names (TOKENS §4), springs
  (MOTION §3), native accent members (TOKENS §1.7); each with a legacy lint (warn from W0, error in W9) and
  a W9 codemod; `tests/tailwind-class-resolution.test.ts` fails on any class that resolves to nothing.
- Other generators: `generate-native-icons.mjs` (variable templates, the fixed-topology Node offsetter,
  `--check`), `generate-native-brand-geometry.mjs` (Arch masters, `--check`), new
  `generate-native-faces.mjs` (face data, `--check`).
- **Lint** (web): `design-system/bronze-budget` and `signal-budget` (following `var()` aliases, with the
  exact allow-lists of TOKENS §1.5), `no-ink-3-text`, `glyph-size`, `no-legacy-colour-role`,
  `no-legacy-type-rung`, `no-legacy-radius` (new); `no-arbitrary-radius` and `concentric-radius` on the new
  ladder; `wave2/off-ladder-duration` on the new ladder; `no-backdrop-filter` and `no-blur-entrance` with no
  product-chrome exemptions; `no-arbitrary-text`/`no-raw-text-size` promoted to error in W9; per-wave
  enforcement through `eslint-rules/enforce/identity-v2-w<n>.json`.
- **Gates**: palette and contrast tests (state fills, APCA, chart distance, the hue gate), owner-rules
  (node data test + Playwright DOM spec), focus tests (web and native), IA parity, geometry gate with
  `scales.identity-v2.json`, axe (light, dark, forced colours), motion tests, icon and brand checks, native
  design gates, all e2e specs in the `e2e/wave2/identity-v2/` package that `design-gates.yml` runs;
  thresholds in MIGRATION §5.

---

## 17. Judge ledger (every graft and every must-fix, and where this spec settles it)

### 17.1 Grafts

| # | Judge | Graft | Settled in |
|---|---|---|---|
| 1 | owner | d2 margin (notes beside the citing line, receipt, "Reading sources 3 of 4" + rule; d3 tokens; per committed paragraph) | §10.1, §10.3, §10.4 (with a laptop tier and a reserved lane) |
| 2 | owner | d2 Orbit header count in words; no separate Orbit nav item; header links to the page | §11.2 |
| 3 | owner | d2 instant keyboard menus; scrim never outlives its panel; pinned inside Recent | MOTION §1, §11.2 |
| 4 | owner | d2 line-to-text-stem rule; heavier small wordmark cut | ICONS §1.1, BRAND §3 |
| 5 | owner | d1 instrument stamp merged with d2's receipt; hairline sources control | §10.4, §10.2 |
| 6 | owner | d1 step rail with tabular timers; header status line; needs-you content model; fix initials baseline | §10.5 |
| 7 | owner | d1 composer contract (states named; Code tokens; no disclaimer; no suggestions) | COMPONENTS §10 (send is two states; voice moved to Talk, §1.2) |
| 8 | owner | d1 sidebar collapses to nothing (⌘\); settings take over the sidebar column | §11.2, §11.3 |
| 9 | owner | d1 accent-usage lint and native gate; measured contrast with HC twins; per-size pixel fitting | TOKENS §1.3–§1.5, ICONS §1 |
| 10 | owner | d1 landing composition (78 % product hero; "Every answer shows its working" from real components); d3 type | §12.1 (headline replaced: J-platform found it shared) |
| 11 | owner | d2 dateline in Inter caption above the greeting | §11.5 |
| 12 | ux | d1 density (menus 30–32, sidebar 32, lists 52, tabular columns, strong header rule) | §5, TOKENS §8, COMPONENTS §7 |
| 13 | ux | d1 step rail + stamp beside the receipt | §10.4, §10.5 |
| 14 | ux | d1 strict button ladder | COMPONENTS §2 |
| 15 | ux | d1 menu rules (disabled focusable; keyboard opens do not travel; Shift+right-click; context menu at the pointer) | COMPONENTS §1.3–§1.6 |
| 16 | ux | d1 Code controls collapse into `+` at narrow widths | COMPONENTS §10 |
| 17 | ux | d1 icon construction (flat-cut, per-size fitting, 1 px at 12–14 and 1x, larger keyline) + d2 ratio | ICONS §1 |
| 18 | ux | d1 dark-mode weight −20 | TOKENS §2.2 |
| 19 | ux | d3 lift is earned for the needs-you card; keep the dot and the word | §10.5 (dot in signal blue) |
| 20 | ux | d3 native choices (opaque iPhone composer, system menus, `.warning` haptic) | NATIVE §3–§5 |
| 21 | ux | d3 colour-budget lint; ink-3 banned as text | TOKENS §1.5 |
| 22 | ux | d3 hover and press as ink-alpha fills | TOKENS §1.2 |
| 23 | ux | d3 icon verification method | ICONS §4 |
| 24 | ux | d3 greeting as a question in Alevr's voice | §11.5 (five owned candidates; the previous line was ChatGPT's) |
| 25 | platform | d3 colour migration plan (OKLCH source → triplets, `--check`, alias map, lint ban) | TOKENS §1.1, §1.6 |
| 26 | platform | generated elevation family (`JunoGeneratedElevation`) | TOKENS §6 |
| 27 | platform | generated AccentColor and LaunchBackground | NATIVE §2 |
| 28 | platform | d2 variable symbol masters (Ultralight-S, Regular-S, Black-S) and RTL list | ICONS §3, §5 |
| 29 | platform | d3 Node-side stroke outliner with fixed topology | ICONS §3 (purpose-built offsetter) |
| 30 | platform | d2 Mac sidebar selection drawn by the system; AccentColor neutral/ink; colour only through explicit tints | NATIVE §2 |
| 31 | platform | d2 margin and receipt as a wide-window enhancement, laid out per committed paragraph | §10.1 |
| 32 | platform | d3 needs-you lift (bounce ≤ 0.1, reduced motion = fade); composer shadow only while content scrolls beneath | MOTION §3 (lift 0.10 + the shadow lag), TOKENS §6 |
| 33 | platform | d3 "roles shared, sizes per platform" as data | TOKENS §2.2 (`type.source.ts`) |
| 34 | platform | d2 motion rules; haptics only on state change | MOTION §1, NATIVE §5 |
| 35 | platform | the consensus native plan (system menus, one composer shell, no platformFactor, four-way colour, 12 sections, deletions, gates) | NATIVE |

### 17.2 Must-fix

| # | Judge | Must-fix | Settled in |
|---|---|---|---|
| 1 | owner | Orbit duplicated with a contradictory badge | §11.2 |
| 2 | owner | `lift` bounce 0.18 | MOTION §3 (0.32 s / 0.10, 335 ms; weight from the shadow lag, §3.1) |
| 3 | owner | Blue = needs you and focus; update agent-face docs and native; release note | §3.2, MIGRATION W5 (`docs/design/AGENTS.md`), MIGRATION §6 |
| 4 | owner | `corner-shape` Chromium-only; radii that look right without it; WebKit check; `.continuous` natively | §5, TOKENS §4 (scale and shape in one layer; WebKit in CI, W3) |
| 5 | owner | Rework, not reskin: margin, stamp, step rail; retune stage/base tones and gutters | §11.1, §10, TOKENS §1.2 (light base 0.950, stage inset 8 px with a new edge, no seam) |
| 6 | owner | Settings with two navigation columns | §11.3 |
| 7 | owner | Wordmark weight, kerning, A–l, small cut, outline; Geologica once ≥ 28 px; CRSV in FR/DE/Cyrillic; greeting not a template | BRAND §3, §4 of this doc (rendered), §11.5 |
| 8 | owner | Mark legibility at 16; real tabs; stone visible with a mono fallback; never arch without stone; trademark search | BRAND §2 (recognition check and real tabs: W1) |
| 9 | owner | ~195 icons to draw behind stable names via the native generator; Projects and Code metaphors; all-or-none; 1.25 px at 1x | ICONS (166 to draw + 39 re-cut; 1x rule) |
| 10 | owner | Dark elevation by lightness with measured steps; small text 7:1 | §3.2 rules 3–5, TOKENS §1.3 (`ink-2` ≥ 9:1 on dark grounds; status words ≥ 7:1 on dark grounds; APCA) |
| 11 | owner | Bronze budget lint + native gate; bronze "Working" AA on the base, paper, selected | TOKENS §1.3 (bronze ≥ 5.27:1 anywhere), §1.5 |
| 12 | owner | Static shadow in scrolling chrome | §6, TOKENS §6 |
| 13 | owner | Sample content without real third-party sources or vendor names | §10.6, §12.1, MIGRATION §4 (committed neutral seed) |
| 14 | owner | Native device verification; remove ChatGPT-modelled iPhone lines | NATIVE §7, §9 |
| 15 | ux | Keyboard focus ring in menus, in `menu-recipe.ts` and the gallery | COMPONENTS §1.3, MIGRATION W3 |
| 16 | ux | Every hint, timestamp, placeholder, caption and count at ink-2 (≥ 6:1); ink-3 decorative by lint | §3.2 rule 3, TOKENS §1.5 |
| 17 | ux | Reading measure 70–75 characters | §4 (576 px, 74.7 average measured) |
| 18 | ux | A margin tier for laptop widths | §10.1 (compact tier, measure + 364) |
| 19 | ux | Margin keyboard and screen-reader path; DOM order; no layout thrash | §10.1 (plain `li`, the source line in the none tier) |
| 20 | ux | Citation numerals with 24 × 24 non-overlapping hit areas; 44 pt sources control on phones | §10.1 (centred on the line box, measured; clusters as one control) |
| 21 | ux | Home not Claude's composition; no chip row | §11.5 (rendered) |
| 22 | ux | Needs-you without a leading rule: tier-1 lift + strong edge; keep dot and word | §10.5 |
| 23 | ux | Signal dot ≥ 3.5:1 or never without the word | TOKENS §1.3 (≥ 5.20:1), §10.5 (always with the word) |
| 24 | ux | Phone tokens keep their × (44 pt) and full names | COMPONENTS §10 |
| 25 | ux | One name per tool | COMPONENTS §1.8, §14 |
| 26 | ux | Disabled menu items focusable and readable | COMPONENTS §1.3 (`ink-2` label, visible reason) |
| 27 | ux | Segmented thumb ring for everyone | COMPONENTS §4 |
| 28 | ux | Targets ≥ 24 px web; switches' whole row | §5, COMPONENTS §5, TOKENS §8 |
| 29 | ux | Streaming settle once per paragraph, never on text being read; reduced motion | MOTION §1 rule 8, §6 |
| 30 | ux | Opaque iPhone composer by default | NATIVE §3 |
| 31 | ux | A 16 px master that keeps the mark's distinguishing part; trademark search | BRAND §2.1, §8 |
| 32 | ux | Faint 1 px icons at 1x; check dark on 1x; filled stop | ICONS §1, §2 |
| 33 | ux | Roles, names and `aria-current` in the spec | COMPONENTS §1.7, §14; §15 |
| 34 | ux | Build and screenshot the phone bottom sheet + drill-in + back row at 390 px | COMPONENTS §1.9; `shots/phone-*.png`; transition strips in W3 |
| 35 | platform | No `oklch()` in globals.css | TOKENS §1.1 |
| 36 | platform | Alias and codemod plan | TOKENS §1.6, §2.2, §4; MOTION §3; MIGRATION W9 |
| 37 | platform | Native weights; dark trims web-only | TOKENS §2.3 |
| 38 | platform | iOS text style and Mac size per rung, generated | TOKENS §2.2 |
| 39 | platform | Symbol masters, identical point structure, Black clearance, 24 pt lighter, SF Symbols validation | ICONS §3 |
| 40 | platform | AccentColor = ink or the system accent; colour only by explicit tint | NATIVE §2 |
| 41 | platform | Retiring the accents as one coordinated change | TOKENS §1.7 (web in one change; native through deprecated aliases) |
| 42 | platform | Elevation generated | TOKENS §6 |
| 43 | platform | Declared platform-variant tokens | TOKENS §8 |
| 44 | platform | Brand clearance incl. AI-sector marks; intrinsic at 16 | BRAND §2.1, §8 |
| 45 | platform | Distinctiveness against ChatGPT (margin, receipt, needs-you lift, a crafted greeting) | §1.2 (measured, TOKENS §1.3), §10, §11.5 |
| 46 | platform | Font payload ~120 KB, subset, italic on demand | TOKENS §2.1 (89,204 B preloaded) |
| 47 | platform | Settings switch hit areas; phone drill-in built and tested | COMPONENTS §5, §1.9 |
| 48 | platform | Verify 1x icons and ink-2 on near-black on a real 1x display | ICONS §4, MIGRATION W2 (unverified until then) |

### 17.3 Conflicts decided

The full table is in BEST_OF.md ("Conflicts … decided"). The decisions that change the base direction: ink
focus ring (not blue); signal blue for needs you only; first-row submenu alignment; flat-cut icon
terminals; 1 px pixel-snapped icons at 1x; rows 32; lift bounce 0.10 with weight from the shadow lag; no
haptic on send; opaque iPhone composer; AccentColor = ink; accent themes retired; galaxy retired; three
margin tiers with the lane reserved; **cool granite neutrals** (warm stone kept as the owner's alternative);
an owned greeting; a new landing headline; the Orbit header stays when no agent is busy.

### 17.4 Review of 30 October (four lenses): where each blocker and major is settled

| Finding (lens) | Settled in |
|---|---|
| Home greeting is ChatGPT's heading (best-of, brand: blockers) | §11.5 (five candidates, measured, collision check recorded), §14.1, §14.2, §20 Q1, BEST_OF row 14 |
| "Worked for" / "Thought for" are OpenAI strings (brand: blocker) | §10.2, §10.4, §14.1, §14.2; NATIVE §1 subtitle |
| Contrast matrix omits state fills; HC status inks (a11y: blocker) | TOKENS §1.2 (HC twins for every status ink), §1.3 (every state fill; no hover-over-selected) |
| Wide blocks overflow in the compact tier and at Large (a11y: blocker; best-of: major) | §10.1, TOKENS §3 (clamp; tiers relative to the measure), MIGRATION W5 margin spec |
| Type, radius and spring names renamed without aliases (build: blocker) | TOKENS §2.2, §4; MOTION §3; MIGRATION §0.3 |
| Neutral palette edges toward Claude (best-of, brand) | TOKENS §1.1–§1.3 (granite; distinctiveness measured and gated), §1.2 table, §20 Q2, renders `margin-1440-warm-*` |
| Lift weight invisible (best-of; brand minor) | §1 idea 3, §7, MOTION §3.1 |
| Left-aligned home never rendered; left edges disagree (best-of) | §11.5 (one edge, measured 432 px; renders) |
| No voice recipe; "edge light" (best-of, brand) | COMPONENTS §13, MOTION §5–6, MIGRATION W9 |
| Needs-you card covers approvals only (best-of) | §10.5 variant table; step rail glyphs |
| Orbit pages conflict with AGENTS.md (best-of) | §12 Orbit, Agent profile, Agent live computer rows |
| Sidebar faces at 16 px (best-of, brand) | §11.2, COMPONENTS §7, TOKENS §8 (faces ≥ 20) |
| `--presence` alias turns the working orbit ink; alias map incomplete (best-of, brand, build) | TOKENS §1.2 face paint, §1.5 allow-lists, §1.6 complete map |
| APCA never run (best-of) | TOKENS §1.3 APCA table; dark `ink-2` raised to L 0.850 |
| Composer copies ChatGPT's controls (brand) | COMPONENTS §10, §1.2 of this doc |
| Margin lane on the home / column shift (brand) | §10.1, §11.4, §11.5 |
| Needs-you fold, busy set, bell colour-only (brand; a11y) | §11.2, COMPONENTS §7, §14 |
| Native focus policy missing (brand, build) | NATIVE §2.1, §8, §9 item 10; §3.2 rule 2 |
| Mac subtitle has two contents (brand) | §10.9, §11.4, NATIVE §1 |
| Composites never rendered (brand) | §19 (home, needs-you, agent thread, settings, landing, Projects, auth, voice, phone thread: 45 renders) |
| Composition does not cross platforms (brand; best-of minor) | §13, NATIVE §0.1 |
| Status words below the small-text target (a11y) | TOKENS §1.3 (targets met on grounds; stated honestly on fills), §15 item 1, BEST_OF row 31 |
| `--line` boundaries on the composer, tokens, wells (a11y) | TOKENS §1.4 rule 7, COMPONENTS §3, §10 |
| `li role="note"` invalid; `hidden` ambiguous (a11y) | §10.1 steps 1 and 4 |
| Popover opens on focus; link vs popover (a11y) | §10.1, COMPONENTS §1.10, §14 |
| Numeral hit areas overlap; clusters too narrow (a11y) | §10.1 (measured), TOKENS §8 |
| Phone sheet semantics (a11y) | COMPONENTS §1.9 |
| Effort segmented inside a menu (a11y) | COMPONENTS §11 |
| State by colour alone: bell, step rail (a11y) | §11.2, §10.5, COMPONENTS §12, §14 |
| Needs-you has no non-visual signal (a11y) | §10.5, COMPONENTS §12, NATIVE §1 |
| Reduced motion leaves size changes (a11y) | MOTION §6 |
| RTL drawer edge (a11y) | §7, §15 item 10, MOTION §5, NATIVE §1 |
| Dynamic Type layouts (a11y) | NATIVE §5.1 |
| Forced colours (a11y) | COMPONENTS §15, TOKENS §5–6 |
| ⌘N not deliverable on the web; bindings replaced (a11y) | §11.2, MIGRATION W4 |
| fontSize metadata breaks typecheck; hero clamp; display switch (build) | TOKENS §2.2 |
| Corner scale without shape; concentric maths; generator (build) | TOKENS §4 |
| Native accent retirement under-scoped; macOS CI "unverified" escape (build) | TOKENS §1.7, MIGRATION §0.4 |
| Unowned surfaces and gate infrastructure (build) | MIGRATION §2.0 |
| Parallel waves overlap; missing edges; † marks (build) | MIGRATION §0.2, §1 |
| Gates that never run or cannot run (build) | MIGRATION §0.4, W0, W3, W4, §5 |
| Screenshot harness cannot run (build) | MIGRATION §4 |
| Inputs only in the scratchpad (build) | `identity-v2/tools/` (vendored code, fonts, seed, requirements), MIGRATION W0, W1 |
| Node stroke outliner does not exist (build) | ICONS §3 |
| Face generator cannot carry a procedural rig (build) | NATIVE §6 |
| Alternate icons on the Mac; LaunchBackground on the Mac (build) | TOKENS §1.7, BRAND §4, NATIVE §2, MIGRATION W1 |

---

## 18. Migration (detail: MIGRATION.md)

| Wave | Delivers | Depends on |
|---|---|---|
| W0 Foundations | palette source + generator + aliases (colour, type, radius, springs, native accent), elevation, motion, type data, fonts, accent retirement (web), contract strings and IA, new lint rules, gate infrastructure, screenshot harness and the full baseline | — |
| W1 Brand | the Arch everywhere, favicon set, app icon layers, the iPhone Light alternate, share images, recognition check | W0 |
| W2 Icons v4 | every export redrawn, renderer rules, native variable symbols, the fixed-topology outliner | W0; W1 for the `JunoSymbols.swift` move |
| W3 Floating layers and controls | the float family, keyboard ring, phone sheets, buttons, fields, segmented, tabs, switch, page header, empty/loading/error, model picker, live/needs-you primitives, forced colours | W0 |
| W4 Shell | composition, sidebar, Orbit once, settings frame, composer contract, home, shortcuts | W1, W3 |
| W5 Transcript | margin, stamp line, step rail, needs-you variants, sources, Live UI and artifact visuals, agents in the thread, the voice bar | W4 |
| W6 Pages | Projects, Library, Research, Memory, Code, the Orbit home, Customize, landing, auth, legal, 404/500, share, settings panes | W4 |
| W7 Native foundations + Mac | package (four-way colour, type, motion, composer shell, faces, focus, gates), the Mac app | W0, W1, W2; face port after the Orbit workstream merges |
| W8 iPhone | the iPhone app on the package, IA parity, accessibility sizes | W7 |
| W9 Coherence sweep | codemods, deletions, alias removal, `JunoCode`, every rule at error, final geometry and a11y gates | all |

Each wave owns explicit files (every directory is assigned in MIGRATION §2.0), follows the shared-file
protocol with the other running workstreams, ends green on gates that run in CI, and hands the owner
before/after screenshots in light and dark on desktop and phone.

---

## 19. What was verified while writing this spec, and what was not

**Measured or rendered (30 Oct 2026; tools in `identity-v2/tools/`, prototype in `identity-v2/proto/`)**

| Claim | Method |
|---|---|
| Every colour value, contrast ratio over every ground and state fill, and HC twin in TOKENS §1 | OKLCH → sRGB (Ottosson's matrices, per-channel clamp, 8-bit) → WCAG 2.x relative luminance, alpha roles composited in 8-bit; `tools/palette.py cool` (and `warm` for the alternative) |
| APCA Lc for every text ink in dark, HC dark and light | APCA-W3 0.0.98G simple sRGB in `palette.py` `apca()`; it reproduces the review's −61.4 (old dark `ink-2` on float) and −64.0 (on stage) |
| Distinctiveness distances and hue/chroma of the neutral ramps | OKLab Euclidean distance against the Claude host tokens recorded in COMPETITIVE_AUDIT:623; `palette.py cool distinct`, `warm distinct` |
| Chart series ≥ 0.098 OKLab from every status ink, ≥ 0.104 between series | a 60,000-sample search over hue, lightness and chroma per series (best uniform-lightness set: 0.056), then rounded and re-measured in `palette.py`; the reviewer's 0.060 (old dark clay vs danger) reproduced |
| Spring settle, overshoot (also in px) and 95 % times, including lift at 0.10, 0.12 and 0.15 | the generator's own model reimplemented in `tools/springs.py` (0.5 ms steps, rest delta 0.005); the review's 335 ms / 0.152 % / 246 ms reproduced |
| 576 px = 74.7 characters per line on average at 16 px | Chromium (Playwright) rendering the Inter 4.1 subset over a 1,190-character paragraph, per-character `Range.getClientRects()`; `proto/measure.html` |
| Greeting widths (five candidates, four languages, 40 and 30 px) | Chromium with the shipped `proto/fonts/geologica.woff2` (+ Cyrillic) at 460, −2.6 %, CRSV 1; `proto.html?s=greet-measure`; the old line measures 589 px as the review found |
| One left edge on the home (dateline, greeting, placeholder at x = 432 px) | Chromium, `proto.html?s=home&w=1440`, `Range.getClientRects()` of each text |
| Citation hit area inside its line box (line 215–242 px, box 216.5–240.5 px) | Chromium, `proto.html?s=margin&w=1440&focus=1`, the line box from the preceding character's content box and the 27 px line height |
| Font sizes: Inter roman 65,452 B, italic 70,772 B, Cyrillic 24,420 B, Greek 25,544 B, Vietnamese 12,728 B; Geologica Latin 23,752 B, Cyrillic 15,108 B, TTF variable 69,508 / 36,876 B, static 460 41,380 / 22,756 B | fontTools 4.68.0 `subset` + `varLib.instancer` on the committed inputs in `tools/fonts-src/` (SHA-256 in `tools/fonts.md`); outputs in `tools/fonts-out/` |
| Brand files regenerated in the granite palette with identical geometry | `tools/brand3.py` (no scratchpad paths); every SVG compared with the previous set after normalising colours: identical; favicon contrast recomputed (BRAND §2.1) |
| The renders in `shots/` (45 files) | static prototype at DPR 2, light and dark, with `reducedMotion: 'reduce'`: `margin-{1440,1280,1180-none,1440-streaming}-*`, `margin-1440-keyboard-focus-light`, `margin-1440-warm-*` (the palette comparison), `home-{1440,390}{,-needs-you}-*`, `agent-1440-{waiting,answered}-*`, `voice-{1440,390}-*`, `settings-1440-*`, `projects-1440-*`, `landing-1440-*`, `auth-1440-*`, `phone-{thread,menu,drill}-*`, `phone-menu-keyboard-light`, `brand-check-*`, `favicon-zoom`. The prototype's faces are stand-ins (a flat tone body with two cuts, not the rig) and its glyphs are sketches, not the v4 drawings |
| Counts quoted from the repo (71 Tailwind colour entries, 1,534 `hsl(var(--` uses, 242 icon exports, 12 settings ids, 110 colour properties in globals.css, 350 `junoAccent` references in 143 files, today's radius and type names) | `grep` and a Python scan over the working tree on 30 Oct 2026 |

**Unverified (each is a gate in MIGRATION)**: the chosen greeting against the live ChatGPT, Claude and
Gemini home screens; WebKit and Firefox rendering of the corners; the favicon in real Safari, Chrome and
Firefox tabs; the 16 px mark's recognition as a portal rather than an "n"; every native item in NATIVE §9
(the Mac inset stage, keyboard-only focus, accessibility sizes, Geologica's variable TTF, the voice bar);
the Icon Composer render; SF Symbols validation of the variable templates; 1x-display rendering of icons and
of `ink-2` on near-black; the Inter stem at 450 (interpolated); the SwiftUI approximation of negative shadow
spread; axe results on the built product; the trademark search; d3's 39 drawings re-cut with flat terminals
and the 166 new drawings (not yet drawn); the transition frame strips (W3, W5).

---

## 20. Open questions for the owner

1. **The greeting.** Pick one of the five lines in §11.5 (build default: "What needs doing, Sam?"; the
   context-tied #4 is the most Alevr-specific). The previous pick was ChatGPT's heading and is retired.
2. **Granite or warm stone.** The spec ships cool granite (hue 255), which continues today's graphite,
   separates Alevr from Claude's warm ramp and makes bronze the only warm note. d3's warm stone is one
   constant away (`palette.py warm`; it meets the same floors). Compare
   `shots/margin-1440-light.png` with `shots/margin-1440-warm-light.png`, and the dark twins.
3. **The serif greeting.** The owner liked today's serif greeting; the audit called it "the product's best
   single moment" (WA §5.3). This spec retires it (Geologica carries the one display line). If the serif
   should survive, the place this spec would accept is d2's opt-in **"Answer typeface: Sans · Serif"**
   reading setting in Personalization, loading the serif on demand and never preloading it, so it never
   becomes the brand voice.
4. **The galaxy.** It is retired from the product and the landing because two signatures compete with the
   Arch. If the owner wants it kept somewhere, the only place this spec would accept is the 404 page,
   redrawn in granite and bronze, static.
5. **Trademark clearance** must be commissioned before W1 ships (BRAND §8).
6. **Legal page content**: the French template marker "[À COMPLÉTER : raison sociale de l'éditeur]" needs
   the publisher's legal name; the design can only hide the marker, not supply the fact.
7. **Research as a sidebar destination** (added to answer RES B8). If the owner prefers four destinations
   without it (Projects, Library, Code, Customize), Research moves under Library as a segment with the
   same list.
8. **The Mac's stage**: inset sheet (the spec's pick) or edge to edge, decided from the W7 device screenshot
   pair (NATIVE §0.1, §9 item 9).
9. **The alternate app icon**: one, on iPhone, the Light ground (the system already provides dark, clear
   and tinted; the Mac has no alternate-icon API). Confirm, or drop alternates entirely.

---

## Review log

One line per finding this revision did not adopt as written, and why.

- **Per-token ΔE ≥ 4 distinctiveness gate (brand lens)**: not adopted as stated, because no near-white
  paper or near-black ink can meet it (`#ffffff` vs `#fdfefe` is 0.39 ×100); the gate is on the neutral
  ramp's hue and chroma instead, and the measured distances are recorded (TOKENS §1.3, §1.5).
- **Status words at ≥ 6:1 / ≥ 7:1 on the selected fill and state fills too (a11y lens, first option)**:
  met on the four grounds; on the selected and state fills they are 5.12–5.74:1 light and 5.36–6.93:1 dark,
  because raising them further turns dark danger pastel pink and light signal near navy; mitigated by the
  word-plus-shape rule and the HC twins, and stated honestly (TOKENS §1.3, BEST_OF row 31).
- **`hidden` notes below the margin tier (a11y lens)**: replaced by a visible source line under each cited
  paragraph, which keeps the notes in reading order and gives phones the margin's idea (§10.1 step 4).
- **Chart series 2 at hue 55–60 (best-of lens)**: not adopted, because the warning ink sits at hue 50–62;
  series 2 moved to hue 120 with its own lightness instead (TOKENS §1.2).
- **A stone-squircle send control (brand lens, an option)**: not adopted, because the send control must stay
  concentric with the composer's corner (24 − 8 = 16 = a full 32 px capsule); the difference from the
  competitors is carried by the state machine (send is only send), the placement (model token first, Talk
  as a word) and the text edge (COMPONENTS §10).
- **Voice from a long-press on send (brand lens, an option)**: not adopted, because a long-press is
  undiscoverable and has no keyboard equivalent; voice is the named Talk control with ⌘⇧. (COMPONENTS §10).
- **Reading measure 35 em (a11y lens, minor)**: kept at 36 em; the 70–75 target is the average (74.7), and
  inline citation numerals only lower the count (TOKENS §2.4).
- **The serif "Answer typeface" setting (best-of lens)**: offered to the owner (§20 Q3), not adopted by
  default, because it adds a font and a setting the owner has not asked for.
