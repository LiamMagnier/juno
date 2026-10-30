# Identity v2 · TOKENS

Appendix to `docs/design/IDENTITY_V2.md` (§3 colour, §4 type, §5 geometry, §6 elevation). Every value in
this file is a real value; every contrast figure was computed, not estimated (method in §1.3). Where a
value is a judgement that still needs a device, it says "unverified". Revision 3 (30 Oct 2026) applies the
review: cool granite neutrals, raised dark `ink-2`, status inks and HC twins re-measured over every state
fill, APCA for dark text, chart hues moved away from the status inks, and alias tables for type, radius and
springs.

---

## 1. Colour

### 1.1 Source, format and the generator (W0)

- **The source is OKLCH.** A new file `src/lib/tokens/palette.source.ts` holds, per appearance (light,
  dark, HC light, HC dark), each role as `[L, C, h]`, plus the alpha roles as `{ base: role, alpha }`.
  Inputs: **the granite neutral hue 255** (chroma 0.001–0.008; today's graphite measures hue 248–264 at
  C 0.002–0.009, WA §2.1), the bronze hue 66–80, the signal hue 256–262, the danger hue 25–27, success
  150–152, warning 50–62. The reference implementation of the maths is
  `docs/design/identity-v2/tools/palette.py` (OKLCH → linear sRGB → gamma sRGB, per-channel clamp, 8-bit
  rounding, then HSL; `python3 palette.py cool md` prints every table below).
- **The neutral hue is one constant.** `palette.py warm` (and the same switch in `palette.source.ts`)
  produces d3's warm stone (hue 80) with every lightness, status ink and rule unchanged; it is the owner's
  alternative (IDENTITY_V2 §20 Q2), rendered side by side in `shots/margin-1440-light.png` (granite) and
  `shots/margin-1440-warm-light.png` (stone), dark twins likewise.
- **`globals.css` keeps HSL triplets, never `oklch()`.** The generator's HSL regex, the 71
  `hsl(var(--x) / <alpha-value>)` colour entries in `tailwind.config.ts` (66 of them with
  `<alpha-value>`) and the 1,534 `hsl(var(--…))` uses under `src/` (counted on 30 Oct 2026 with
  `grep -rho 'hsl(var(--' src`) all need a bare `H S% L%` triplet.
- **How it flows.** `scripts/generate-design-tokens.ts` gains a palette step that runs first: it reads
  `palette.source.ts`, converts each role to the 8-bit sRGB value (the canonical value), writes the HSL
  triplet with three decimals into a fenced region of `src/app/globals.css`
  (`/* @generated palette:start */ … /* @generated palette:end */`) inside `:root`, `.dark` and the
  `@media (prefers-contrast: more)` blocks, then runs the existing projection unchanged. The triplet is
  derived from the rounded hex, so `hslToRgb()` returns the same 8-bit value (`--check` asserts the round
  trip for every role, ±0.5/255).
- **`--check`** re-derives the region and fails CI on any difference, exactly as the spring twins work
  today. It also fails when **any colour custom property in `globals.css` is neither a v2 role nor in the
  alias map (§1.6)**: the map is generated from the declarations, not kept by hand.
- **Alpha roles** (`--hover`, `--press`, `--line-soft`, `--scrim`, `--drawer-dim`, `--shadow-*`) stay
  hand-written in globals.css as `var(--ink-rgb) / a` style declarations the generator already follows
  (`VAR_COLOR`), so the 1:1 Tailwind utilities `bg-hover`, `bg-press` work over any surface.

### 1.2 Roles (light and dark)

Light and dark are separate ramps, not inversions. Dark elevation is lightness: base 0.160 → stage 0.214 →
raised 0.246 → float 0.284 (OKLCH L). Granite (hue 255) is the pick; the warm alternative is listed after
the table.

| Role | Use | Light OKLCH | Light hex | Light HSL triplet | Dark OKLCH | Dark hex | Dark HSL triplet |
|---|---|---|---|---|---|---|---|
| `--base` | Window ground, sidebar, landing page | 0.950 0.005 255 | `#eceff2` | `210.000 18.750% 93.725%` | 0.160 0.003 255 | `#0c0d0f` | `220.000 11.111% 5.294%` |
| `--stage` | The content sheet (chat, pages); reading ground | 0.996 0.001 255 | `#fdfefe` | `180.000 33.333% 99.412%` | 0.214 0.003 255 | `#18191b` | `220.000 5.882% 10.000%` |
| `--raised` | In-flow tonal surface on the stage: user turn, code block, tiles, draft preview | 0.966 0.003 255 | `#f2f4f6` | `210.000 18.182% 95.686%` | 0.246 0.004 255 | `#1f2123` | `210.000 6.061% 12.941%` |
| `--float` | Menus, popovers, dialogs, sheets, toasts, the composer when lifted | 1.000 0 255 | `#ffffff` | `0.000 0.000% 100.000%` | 0.284 0.004 255 | `#282a2c` | `210.000 4.762% 16.471%` |
| `--well` | Fields and tracks sitting on the base (sidebar search, segmented track) | 0.928 0.005 255 | `#e5e7ea` | `216.000 10.638% 90.784%` | 0.182 0.003 255 | `#111213` | `210.000 5.556% 7.059%` |
| `--selected` | Selected row (sidebar, list, palette), segmented thumb in dark | 0.925 0.005 255 | `#e4e6e9` | `216.000 10.204% 90.392%` | 0.306 0.005 255 | `#2e2f32` | `225.000 4.167% 18.824%` |
| `--line` | Hairlines, table row rules, card edges (decorative; see the boundary rule in §1.4) | 0.905 0.004 255 | `#dee0e2` | `210.000 6.452% 87.843%` | 0.330 0.004 255 | `#343537` | `220.000 2.804% 20.980%` |
| `--line-strong` | Field edges, switch-off ring, segmented thumb edge, table head rule, every HC boundary (non-text 3:1) | 0.600 0.006 255 | `#7e8084` | `220.000 2.381% 50.588%` | 0.610 0.006 255 | `#818387` | `220.000 2.439% 51.765%` |
| `--ink` | Primary text, glyphs on hover/selected, primary button fill, focus ring | 0.205 0.008 255 | `#15171b` | `220.000 12.500% 9.412%` | 0.935 0.004 255 | `#e8eaec` | `210.000 9.524% 91.765%` |
| `--ink-2` | Every secondary text: placeholders, timestamps, hints, captions, counts, shortcut hints, resting glyphs | 0.430 0.008 255 | `#4d5054` | `214.286 4.348% 31.569%` | 0.850 0.005 255 | `#cbced1` | `210.000 6.122% 80.784%` |
| `--ink-3` | Decorative only: disabled glyphs, bullets, rails. Never text | 0.620 0.006 255 | `#84868a` | `220.000 2.500% 52.941%` | 0.600 0.005 255 | `#7e8083` | `216.000 1.976% 50.392%` |
| `--on-ink` | Label on the ink primary and the send disc | 0.996 0.001 255 | `#fdfefe` | `180.000 33.333% 99.412%` | 0.214 0.003 255 | `#18191b` | `220.000 5.882% 10.000%` |
| `--bronze` | Live label text ("Working", "Reading sources") | 0.465 0.082 68 | `#775020` | `33.103 57.616% 29.608%` | 0.805 0.088 78 | `#dfb97e` | `36.495 60.248% 68.431%` |
| `--bronze-fill` | The stone: brand mark, live dot, writing point, live rule, the working face's orbit | 0.595 0.106 70 | `#a7722e` | `33.719 56.808% 41.765%` | 0.765 0.1 76 | `#d7aa67` | `35.893 58.333% 62.353%` |
| `--signal` | Needs you: word, dot, badge, step marker. Nothing else | 0.470 0.16 260 | `#1c55b2` | `217.200 72.816% 40.392%` | 0.785 0.11 258 | `#8dbbff` | `215.789 100.000% 77.647%` |
| `--danger` | Destructive and failed text, destructive menu items | 0.480 0.175 27 | `#aa1f1f` | `0.000 69.154% 39.412%` | 0.790 0.12 25 | `#fe9b93` | `4.486 98.165% 78.627%` |
| `--danger-fill` | The danger button (destructive confirm only) | 0.505 0.18 27 | `#b52524` | `0.414 66.820% 42.549%` | 0.640 0.17 27 | `#e15a50` | `4.138 70.732% 59.804%` |
| `--on-danger` | Label on the danger button | 1.000 0 255 | `#ffffff` | `0.000 0.000% 100.000%` | 0.160 0.003 255 | `#0c0d0f` | `220.000 11.111% 5.294%` |
| `--success` | Completed (rare; always with glyph and word) | 0.455 0.1 150 | `#256637` | `136.615 46.763% 27.255%` | 0.775 0.125 152 | `#74cd8e` | `137.528 47.090% 62.941%` |
| `--warning` | Quota, degraded service (rare; always with glyph and word) | 0.475 0.128 52 | `#924200` | `27.123 100.000% 28.627%` | 0.795 0.13 60 | `#f9a760` | `27.843 92.727% 67.647%` |

The warm alternative (owner question, IDENTITY_V2 §20 Q2) changes only the neutral rows: light base
`#f1eeea`, stage `#fefefd`, raised `#f5f3f1`, well `#e9e7e3`, selected `#e8e6e2`, line `#e1dfdc`,
line-strong `#82807c`, ink `#191713`, ink-2 `#524f4b`, ink-3 `#888682`; dark base `#0e0d0c`, stage
`#1a1918`, raised `#22201f`, float `#2b2a28`, well `#131211`, selected `#312f2c`, line `#363533`,
line-strong `#85837f`, ink `#ebe9e6`, ink-2 `#cfcdca`, ink-3 `#82807d`. It meets every floor below except
light `success` on base (5.98 against the 6.0 target; a −0.002 L nudge fixes it if warm is chosen).

Alpha roles (composited over whatever they sit on; `ink` means the appearance's `--ink`):

| Role | Light | Dark | HC light | HC dark | Use |
|---|---|---|---|---|---|
| `--hover` | ink 4.5 % | ink 6 % | ink 8 % | ink 10 % | Hover fill on rows, icon buttons, composer controls, menu rows (pointer and keyboard). Never stacked on `--selected` |
| `--press` | ink 8 % | ink 10 % | ink 12 % | ink 14 % | Pressed fill while held. Never stacked on `--selected` |
| `--line-soft` | ink 8 % | ink 9 % | ink 22 % | ink 24 % | Separators inside floats and lists |
| `--scrim` | ink 28 % | black 50 % | ink 40 % | black 60 % | Behind dialogs, the palette and phone sheets. Never blurred |
| `--drawer-dim` | ink 12 % | black 50 % | ink 20 % | black 60 % | Over the stage while the phone drawer is open (the drawer is a push surface, not a modal; the stage stays readable) |
| `--shadow-ink` | `#15171b` | `#000000` | same | same | Shadow throws (§6) |
| `--shadow-ring` | `#15171b` | `#ffffff` | 1 px `--line-strong` at alpha 1 (§6) | same | The 1 px first layer of every shadow tier |

High-contrast twins (`@media (prefers-contrast: more)` on the web; Increase Contrast on Mac and iPhone):
only these roles change, so no layout moves. **Every status ink has a twin** (darker in HC light, lighter
in HC dark), so no text loses contrast when HC darkens `--selected` and raises `--hover`/`--press`.

| Role | HC light OKLCH | HC light hex | HC light HSL | HC dark OKLCH | HC dark hex | HC dark HSL |
|---|---|---|---|---|---|---|
| `--ink-2` | 0.370 0.008 255 | `#3d4044` | `214.286 5.426% 25.294%` | 0.900 0.004 255 | `#dcdee1` | `216.000 7.692% 87.255%` |
| `--ink-3` | 0.520 0.006 255 | `#67696c` | `216.000 2.370% 41.373%` | 0.700 0.005 255 | `#9c9fa1` | `204.000 2.591% 62.157%` |
| `--line` | 0.760 0.006 255 | `#aeb1b5` | `214.286 4.516% 69.608%` | 0.440 0.005 255 | `#515355` | `210.000 2.410% 32.549%` |
| `--line-strong` | 0.450 0.008 255 | `#52565a` | `210.000 4.651% 33.725%` | 0.700 0.006 255 | `#9c9fa2` | `210.000 3.125% 62.353%` |
| `--selected` | 0.900 0.005 255 | `#dcdee1` | `216.000 7.692% 87.255%` | 0.330 0.005 255 | `#343538` | `225.000 3.704% 21.176%` |
| `--bronze` | 0.415 0.075 66 | `#67431a` | `31.948 59.690% 25.294%` | 0.870 0.075 80 | `#eecf9c` | `37.317 70.690% 77.255%` |
| `--bronze-fill` | 0.550 0.104 70 | `#986521` | `34.286 64.324% 36.275%` | 0.765 0.1 76 | `#d7aa67` | `35.893 58.333% 62.353%` |
| `--signal` | 0.420 0.15 262 | `#1a469d` | `219.847 71.585% 35.882%` | 0.850 0.09 256 | `#a7d1ff` | `211.364 100.000% 82.745%` |
| `--danger` | 0.430 0.16 27 | `#941617` | `359.524 74.118% 33.333%` | 0.850 0.095 25 | `#ffb6ae` | `5.926 100.000% 84.118%` |
| `--danger-fill` | 0.450 0.17 27 | `#9e1618` | `359.118 75.556% 35.294%` | 0.640 0.17 27 | `#e15a50` | `4.138 70.732% 59.804%` |
| `--success` | 0.405 0.095 150 | `#18572c` | `139.048 56.757% 21.765%` | 0.850 0.11 152 | `#96e3aa` | `135.584 57.895% 73.922%` |
| `--warning` | 0.430 0.12 50 | `#813700` | `25.581 100.000% 25.294%` | 0.860 0.11 62 | `#ffc184` | `29.756 100.000% 75.882%` |

**Agent face tones.** The six stored tone ids (`src/lib/agents/avatar.ts` `AGENT_TONES`) are kept, so no
agent record changes; their values are re-derived at one OKLCH lightness and chroma per theme so no agent
reads louder than another. **The eye ink is one value in both themes** (`--agent-ink` = `#15171b`, OKLCH
0.205 0.008 255), keeping the rig's invariant that "an agent is the same agent in light and dark"
(AGENTS.md §4.1; today `--agent-ink: 30 14% 11%` in both blocks); every tone clears 7.38:1 against it, above
the rig's 5.4:1 floor. Face shapes and the rig (`src/components/agents/face-*.ts`, `agent-face.tsx`) do not
change.

| Tone id (stored, unchanged) | OKLCH light | Light hex | OKLCH dark | Dark hex | Eye ink on body light / dark | Working orbit (`--bronze-fill`) on body light / dark |
|---|---|---|---|---|---|---|
| `coral` | 0.860 0.05 40 | `#efc7b9` | 0.730 0.055 40 | `#c79d8e` | 11.57 / 7.38 | 2.66 / 1.14 |
| `amber` | 0.860 0.05 85 | `#e0cfac` | 0.730 0.055 85 | `#b8a680` | 11.70 / 7.52 | 2.69 / 1.12 |
| `sage` | 0.860 0.05 135 | `#c3d9b8` | 0.730 0.055 135 | `#99b08d` | 11.91 / 7.65 | 2.74 / 1.10 |
| `juniper` | 0.860 0.05 165 | `#b3dcc9` | 0.730 0.055 165 | `#88b39f` | 11.96 / 7.69 | 2.75 / 1.09 |
| `teal` | 0.860 0.05 200 | `#abdbde` | 0.730 0.055 200 | `#7eb3b5` | 11.89 / 7.69 | 2.73 / 1.09 |
| `violet` | 0.860 0.05 295 | `#d3cbef` | 0.730 0.055 295 | `#aaa1c7` | 11.59 / 7.38 | 2.66 / 1.14 |

**The face's state paint** (decided here; it lives in `src/components/agents/agent-face.css`, which today
paints with alias names):

| Paint | Today (`agent-face.css`) | v2 | Measured |
|---|---|---|---|
| Working orbit ring and its ball | `--presence` (:47, :55) | **`--bronze-fill`**: a working face is the live state, the same colour as every other "Working" mark | on grounds: light: base 3.58, stage 4.08, raised 3.74, selected 3.30, hover/base 3.26 / dark: base 9.11, stage 8.24, raised 7.57, selected 6.27, hover/base 8.16. On the tone bodies 2.66–2.75 light, 1.09–1.14 dark: the ring passes under the body with a cut-paper gap and its far half goes behind, so the ground figures are the ones that count; the state is also always in words |
| Needs-you badge (the ball in the upper-left notch) | `--status-needs-you` (:67) | `--signal` | 5.61–7.02:1 light, 6.81–9.89:1 dark on the grounds and the selected fill |
| Blocked: stalled ring / its ball / small-size bar | `--muted-foreground` (:63) / `--destructive` (:64) | `--ink-2` / `--danger` | as `ink-2` and `danger` in §1.3 |
| Sleeping body | `--agent-dormant` (face-local) | unchanged recipe (neutral grey + 14 % of the tone), re-derived from the granite neutrals | rig test floors unchanged (≥ 1.8:1 on page and card) |

Chart series (`--chart-1` … `--chart-6`, Live UI and data blocks only; the one place several hues appear,
and only as data). Series 1 is ink, series 6 is `ink-2` drawn dashed; series 2–5 sit in the gaps between
the status hues, each with its own lightness, so a chart never reads as "live", "needs you" or "failed".
Series are also separated by marker shape and dash, never by colour alone. Measured (WCAG 2.x, non-text
floor 3:1; OKLab distance to the nearest of `danger`, `danger-fill`, `warning`, `success`, `signal`,
`bronze`, `bronze-fill` in the same theme):

| Series | Hue | Light | on stage / raised | Dark | on stage / raised | Nearest status ink (OKLab, light / dark) |
|---|---|---|---|---|---|---|
| `--chart-1` | (ink) | `#15171b` | 17.76 / 16.28 | `#e8eaec` | 14.59 / 13.39 | neutral |
| `--chart-2` | 120 | `#6d801a` | 4.37 / 4.01 | `#c6dd7d` | 11.76 / 10.80 | 0.104 (bronze-fill) / 0.099 (bronze) |
| `--chart-3` | 212 | `#007387` | 5.47 / 5.01 | `#47b7cc` | 7.47 / 6.86 | 0.118 (success) / 0.103 (signal) |
| `--chart-4` | 302 | `#74579c` | 5.80 / 5.31 | `#d8baff` | 10.38 / 9.53 | 0.117 (signal) / 0.098 (signal) |
| `--chart-5` | 350 | `#8d3a66` | 7.09 / 6.50 | `#e084b1` | 6.79 / 6.23 | 0.106 (danger) / 0.098 (danger) |
| `--chart-6` | (ink-2, dashed) | `#4d5054` | 8.02 / 7.35 | `#cbced1` | 11.13 / 10.22 | neutral |

The minimum distance from a status ink is 0.098 (dark violet and rose; the gate is ≥ 0.095); the closest pair of coloured series is 0.104
(OKLab). Five hues cannot all sit ≥ 0.10 from seven status inks at one lightness (searched: the best
uniform-lightness set reaches 0.056), so the series vary lightness as well as hue.

Code syntax colours (`--code-*`, inside code blocks only) keep their eight hues; W0 re-measures each on
`--raised` in both themes and lifts any pair under 4.5:1. They never use bronze or signal.

### 1.3 Measured contrast for every pair the system uses

Method: WCAG 2.x relative luminance from the 8-bit sRGB values above; alpha roles composited over their
surface first, in 8-bit sRGB (`press/base` = ink at 8 % over base). Grounds are the six opaque surfaces;
"lowest state fill" is the minimum over **every** state fill there is: hover over base, stage, raised,
float and well; press over base, stage, raised and float. **A selected row never stacks hover or press**
(COMPONENTS §1.3, §7: hovering or pressing a selected row keeps `--selected`), so there is no
hover-over-selected fill. Computed by `docs/design/identity-v2/tools/palette.py` (same luminance formula as
`contrastRatio()` in `scripts/generate-design-tokens.ts`). Floors: text 4.5:1; non-text boundaries and
indicators 3:1. `ink-3` rows are listed only to show they never qualify as text; `line-strong` is listed on
state fills only for completeness (it is never drawn on one).

**light**

| Foreground | base | stage | raised | float | well | selected | lowest state fill |
|---|---|---|---|---|---|---|---|
| `ink` | 15.55 | 17.76 | 16.28 | 17.94 | 14.48 | 14.35 | 13.29 (press/base) |
| `ink-2` | 7.02 | 8.02 | 7.35 | 8.10 | 6.54 | 6.48 | 6.00 (press/base) |
| `bronze` | 6.16 | 7.04 | 6.45 | 7.11 | 5.74 | 5.69 | 5.27 (press/base) |
| `signal` | 6.08 | 6.95 | 6.37 | 7.02 | 5.67 | 5.61 | 5.20 (press/base) |
| `danger` | 6.22 | 7.11 | 6.51 | 7.18 | 5.79 | 5.74 | 5.32 (press/base) |
| `success` | 6.00 | 6.85 | 6.28 | 6.92 | 5.59 | 5.53 | 5.12 (press/base) |
| `warning` | 6.06 | 6.92 | 6.35 | 7.00 | 5.65 | 5.60 | 5.18 (press/base) |
| `ink-3` | 3.16 | 3.61 | 3.31 | 3.65 | 2.94 | 2.92 | 2.70 (press/base) |
| non-text `line-strong` | 3.43 | 3.92 | 3.59 | 3.96 | 3.19 | 3.16 | 2.93 (press/base) |
| non-text `bronze-fill` | 3.58 | 4.08 | 3.74 | 4.13 | 3.33 | 3.30 | 3.05 (press/base) |
| non-text `signal` | 6.08 | 6.95 | 6.37 | 7.02 | 5.67 | 5.61 | 5.20 (press/base) |

Other pairs (light): `on-ink` on `ink` 17.76; `on-danger` on `danger-fill` 6.45; focus ring `ink` lowest 13.29; `line` on `stage` 1.31 (decorative); `ink-3` on `float` 3.65.
Surface steps (light): stage/base 1.142; raised/stage 1.091; float/stage 1.010; selected/base 1.083; well/base 1.073.

**dark**

| Foreground | base | stage | raised | float | well | selected | lowest state fill |
|---|---|---|---|---|---|---|---|
| `ink` | 16.12 | 14.59 | 13.39 | 11.94 | 15.55 | 11.10 | 9.04 (press/float) |
| `ink-2` | 12.30 | 11.13 | 10.22 | 9.12 | 11.87 | 8.47 | 6.90 (press/float) |
| `bronze` | 10.53 | 9.53 | 8.75 | 7.81 | 10.16 | 7.25 | 5.91 (press/float) |
| `signal` | 9.89 | 8.95 | 8.22 | 7.33 | 9.54 | 6.81 | 5.55 (press/float) |
| `danger` | 9.56 | 8.65 | 7.94 | 7.08 | 9.22 | 6.58 | 5.36 (press/float) |
| `success` | 10.06 | 9.10 | 8.36 | 7.45 | 9.70 | 6.93 | 5.64 (press/float) |
| `warning` | 9.93 | 8.98 | 8.25 | 7.36 | 9.58 | 6.84 | 5.57 (press/float) |
| `ink-3` | 4.91 | 4.44 | 4.08 | 3.64 | 4.74 | 3.38 | 2.75 (press/float) |
| non-text `line-strong` | 5.12 | 4.63 | 4.25 | 3.79 | 4.94 | 3.52 | 2.87 (press/float) |
| non-text `bronze-fill` | 9.11 | 8.24 | 7.57 | 6.75 | 8.78 | 6.27 | 5.11 (press/float) |
| non-text `signal` | 9.89 | 8.95 | 8.22 | 7.33 | 9.54 | 6.81 | 5.55 (press/float) |

Other pairs (dark): `on-ink` on `ink` 14.59; `on-danger` on `danger-fill` 5.35; focus ring `ink` lowest 9.04; `line` on `stage` 1.43 (decorative); `ink-3` on `float` 3.64.
Surface steps (dark): stage/base 1.105; raised/stage 1.089; float/stage 1.221; selected/base 1.452; well/base 1.037.

**hc-light**

| Foreground | base | stage | raised | float | well | selected | lowest state fill |
|---|---|---|---|---|---|---|---|
| `ink` | 15.55 | 17.76 | 16.28 | 17.94 | 14.48 | 13.31 | 12.18 (press/base) |
| `ink-2` | 9.03 | 10.31 | 9.45 | 10.42 | 8.41 | 7.73 | 7.07 (press/base) |
| `bronze` | 7.60 | 8.68 | 7.95 | 8.77 | 7.08 | 6.51 | 5.95 (press/base) |
| `signal` | 7.56 | 8.64 | 7.91 | 8.73 | 7.04 | 6.47 | 5.92 (press/base) |
| `danger` | 7.62 | 8.71 | 7.98 | 8.80 | 7.10 | 6.53 | 5.97 (press/base) |
| `success` | 7.46 | 8.52 | 7.81 | 8.61 | 6.95 | 6.39 | 5.84 (press/base) |
| `warning` | 7.34 | 8.38 | 7.68 | 8.47 | 6.83 | 6.28 | 5.75 (press/base) |
| `ink-3` | 4.77 | 5.45 | 4.99 | 5.51 | 4.44 | 4.08 | 3.74 (press/base) |
| non-text `line-strong` | 6.41 | 7.32 | 6.71 | 7.40 | 5.97 | 5.49 | 5.02 (press/base) |
| non-text `bronze-fill` | 4.31 | 4.93 | 4.51 | 4.98 | 4.02 | 3.69 | 3.38 (press/base) |
| non-text `signal` | 7.56 | 8.64 | 7.91 | 8.73 | 7.04 | 6.47 | 5.92 (press/base) |

Other pairs (hc-light): `on-ink` on `ink` 17.76; `on-danger` on `danger-fill` 8.13; focus ring `ink` lowest 12.18; `line` on `stage` 2.13 (decorative); `ink-3` on `float` 5.51.
Surface steps (hc-light): stage/base 1.142; raised/stage 1.091; float/stage 1.010; selected/base 1.168; well/base 1.073.

**hc-dark**

| Foreground | base | stage | raised | float | well | selected | lowest state fill |
|---|---|---|---|---|---|---|---|
| `ink` | 16.12 | 14.59 | 13.39 | 11.94 | 15.55 | 10.17 | 7.98 (press/float) |
| `ink-2` | 14.42 | 13.05 | 11.98 | 10.69 | 13.91 | 9.10 | 7.14 (press/float) |
| `bronze` | 13.00 | 11.76 | 10.80 | 9.63 | 12.54 | 8.20 | 6.44 (press/float) |
| `signal` | 12.23 | 11.06 | 10.16 | 9.06 | 11.79 | 7.71 | 6.06 (press/float) |
| `danger` | 11.62 | 10.52 | 9.66 | 8.61 | 11.21 | 7.33 | 5.76 (press/float) |
| `success` | 12.84 | 11.61 | 10.66 | 9.51 | 12.38 | 8.10 | 6.36 (press/float) |
| `warning` | 12.23 | 11.07 | 10.16 | 9.06 | 11.80 | 7.72 | 6.06 (press/float) |
| `ink-3` | 7.30 | 6.61 | 6.07 | 5.41 | 7.04 | 4.61 | 3.62 (press/float) |
| non-text `line-strong` | 7.31 | 6.61 | 6.07 | 5.42 | 7.05 | 4.61 | 3.62 (press/float) |
| non-text `bronze-fill` | 9.11 | 8.24 | 7.57 | 6.75 | 8.78 | 5.74 | 4.51 (press/float) |
| non-text `signal` | 12.23 | 11.06 | 10.16 | 9.06 | 11.79 | 7.71 | 6.06 (press/float) |

Other pairs (hc-dark): `on-ink` on `ink` 14.59; `on-danger` on `danger-fill` 5.35; focus ring `ink` lowest 7.98; `line` on `stage` 2.28 (decorative); `ink-3` on `float` 5.41.
Surface steps (hc-dark): stage/base 1.105; raised/stage 1.089; float/stage 1.221; selected/base 1.585; well/base 1.037.

**APCA sanity check** (PRINCIPLES D6 and checklist Q6: WCAG 2 overstates contrast for light text on dark
grounds). APCA-W3 0.0.98G, simple sRGB coefficients, implemented in `tools/palette.py` `apca()`; it
reproduces the review's figures for the v2 palette (old dark `ink-2` `#bcbab6` on float `#2b2a28`:
Lc −61.4; on stage −64.0). Lc for every text ink (negative = light text on dark):

| Appearance | Text | base | stage | raised | float | selected | press/float |
|---|---|---|---|---|---|---|---|
| dark | `ink` | -93.8 | -92.8 | -91.8 | -90.2 | -89.1 | -85.3 |
| dark | `ink-2` | -76.4 | -75.4 | -74.4 | -72.8 | -71.7 | -67.9 |
| dark | `bronze` | -67.7 | -66.7 | -65.7 | -64.1 | -63.0 | -59.2 |
| dark | `signal` | -64.4 | -63.4 | -62.4 | -60.8 | -59.7 | -55.9 |
| dark | `danger` | -62.8 | -61.8 | -60.8 | -59.2 | -58.1 | -54.3 |
| dark | `success` | -65.3 | -64.4 | -63.4 | -61.8 | -60.7 | -56.8 |
| dark | `warning` | -64.7 | -63.7 | -62.7 | -61.2 | -60.1 | -56.2 |
| hc-dark | `ink` | -93.8 | -92.8 | -91.8 | -90.2 | -87.6 | -82.7 |
| hc-dark | `ink-2` | -86.2 | -85.3 | -84.3 | -82.7 | -80.1 | -75.2 |
| hc-dark | `bronze` | -79.7 | -78.8 | -77.8 | -76.2 | -73.6 | -68.7 |
| hc-dark | `signal` | -76.1 | -75.1 | -74.1 | -72.5 | -69.9 | -65.0 |
| hc-dark | `danger` | -73.2 | -72.2 | -71.2 | -69.7 | -67.0 | -62.1 |
| hc-dark | `success` | -79.0 | -78.1 | -77.1 | -75.5 | -72.9 | -68.0 |
| hc-dark | `warning` | -76.2 | -75.2 | -74.2 | -72.6 | -70.0 | -65.1 |
| light | `ink` | 95.0 | 104.0 | 98.0 | 104.7 | 89.8 | 93.5 |
| light | `ink-2` | 78.3 | 87.4 | 81.4 | 88.1 | 73.2 | 76.9 |
| light | `bronze` | 74.7 | 83.8 | 77.8 | 84.5 | 69.6 | 73.3 |
| light | `signal` | 74.0 | 83.0 | 77.0 | 83.8 | 68.9 | 72.5 |
| light | `danger` | 73.5 | 82.5 | 76.5 | 83.3 | 68.4 | 72.0 |
| light | `success` | 73.9 | 82.9 | 76.9 | 83.7 | 68.8 | 72.4 |
| light | `warning` | 73.8 | 82.9 | 76.9 | 83.6 | 68.7 | 72.4 |

What the tables prove (these are the stated targets, and `tests/palette-source.test.ts` asserts each one):
- **`ink-2`** is ≥ 6.48:1 on every light ground and the selected fill, ≥ 6.00:1 on the lowest light state
  fill (press on base); ≥ 9.12:1 on the four dark grounds, 8.47:1 on dark selected, ≥ 6.90:1 on the lowest
  dark state fill. **APCA: |Lc| ≥ 72.8 on the four dark grounds** (was 61.4 on float), above the Lc 70 the
  review asked for at caption sizes. This is the one ink held to 6:1 light / 7:1 dark everywhere text rests.
- **Status words** (`bronze`, `signal`, `danger`, `success`, `warning`; always one or two words beside a
  dot or glyph, never a sentence): **≥ 6.00:1 light and ≥ 7.08:1 dark on the four grounds** (base, stage,
  raised, float); ≥ 5.53:1 light and ≥ 6.58:1 dark on the selected fill; ≥ 5.12:1 light and ≥ 5.36:1 dark
  on the lowest state fill. HC: ≥ 7.34:1 light / ≥ 8.61:1 dark on the grounds, ≥ 5.75 / 5.76 on the lowest
  HC state fill. APCA in dark: |Lc| 59.2–67.7 on the four grounds; that is below APCA's guidance for
  12 px body text, which is why a status word is never a sentence and always sits with its shape (dot,
  glyph, notch) and in context; HC raises it to |Lc| 69.7–79.7.
- **`ink-3`** never reaches 4.5:1 on a light ground, which is why it is banned as a text colour (§1.5).
- **The signal dot** (non-text) is ≥ 5.20:1 light and ≥ 5.55:1 dark on every ground and state fill: well
  above the 3.5:1 the UX judge asked for.
- **The focus ring** (ink) is ≥ 7.98:1 on every surface and state fill in all four appearances (lowest: HC
  dark, press on float).
- **`bronze-fill`** as an indicator (live dot, writing point, orbit) is ≥ 3.05:1 light and ≥ 5.11:1 dark on
  every ground and state fill.
- Fixes recorded by the review: light `bronze` on hover over base was 5.16 (now 5.27 lowest anywhere);
  dark `danger` on press over float was 4.10 (now 5.36); HC light status inks on press over base were
  4.16–4.43 (now ≥ 5.75).

**Distinctiveness (measured, not "at a glance").** OKLab distance (×100) from the competitor tokens the
repo records (Claude's host tokens, `docs/rework/program/COMPETITIVE_AUDIT_2026-10-15.md`:623; ChatGPT's
dark fills, :297, which are achromatic, C 0):

| Role | Granite (pick) | Hue / chroma | Nearest Claude token, distance | Warm stone (alternative) | Hue / chroma | Nearest Claude token, distance |
|---|---|---|---|---|---|---|
| light `base` | `#eceff2` | 248 / 0.0052 | `#F5F4ED` 2.07 | `#f1eeea` | 75 / 0.0063 | `#F5F4ED` 1.63 |
| light `stage` | `#fdfefe` | 197 / 0.0011 | `#FAF9F5` 1.56 | `#fefefd` | 106 / 0.0013 | `#FAF9F5` 1.55 |
| light `ink` | `#15171b` | 264 / 0.0086 | `#141413` 1.70 | `#191713` | 85 / 0.0083 | `#141413` 1.60 |
| dark `base` | `#0c0d0f` | 264 / 0.0045 | `#141413` 3.27 | `#0e0d0c` | 68 / 0.0027 | `#141413` 3.10 |
| dark `float` | `#282a2c` | 248 / 0.0047 | `#262624` 1.77 | `#2b2a28` | 85 / 0.0039 | `#262624` 1.75 |
| dark `ink-2` | `#cbced1` | 248 / 0.0053 | `#C2C0B6` 4.73 | `#cfcdca` | 78 / 0.0047 | `#C2C0B6` 4.36 |

Read it plainly: any near-white paper or near-black ink sits within about 2 ×100 of every other product's
paper and ink (#ffffff vs `#fdfefe` is 0.39), so a per-token distance gate cannot separate products. What
separates them is the ramp's **hue**: Claude's documented ramp is warm (hue 95–107, C up to 0.014), ChatGPT's
is achromatic (C 0), granite is cool (hue 248–264, C 0.003–0.009) with bronze as its only warm note. The
gate is therefore on hue and chroma (§1.5), and the rest of the distinctiveness lives in composition (the
stage, the margin, the lifted question), not in a few hundredths of OKLab.

### 1.4 One colour per meaning (the colour budget)

1. **Ink** is the only action colour: the one primary button per view, the composer send disc, a checked
   switch or checkbox, the focus ring. The text input caret is ink. Selected tabs are ink text with an ink
   underline.
2. **Bronze** means "Alevr is at work here", and only that: the live dot, the "Working", "Speaking" and
   "Reading sources" labels, the streaming writing point, the live progress rule in the margin, the
   working face's orbit, and the stone in the mark. Never a button, link, selection, fill, chart series or
   status.
3. **Signal blue** means "needs you", and only that: the word "Needs you", its dot, the count in the Orbit
   header, the needs-you step marker, the agent face's needs-you badge. Never the focus ring, never a link,
   never an unread marker.
4. **Red** is destructive and failed, always with a verb or a reason. `--danger-fill` only on the confirm
   button of a destructive dialog.
5. **Green and orange** are rare status inks, always with a glyph and a word.
6. Nothing else is coloured: no gradients, no tinted cards or tiles, no washes behind callouts, no coloured
   borders, no left stripes, no glows, no edge lights.
7. **Boundaries.** `--line` (1.31:1 light, 1.43:1 dark on stage) is decorative. A control may rely on it
   only when the control is identified by its own visible text or glyph (WCAG 1.4.11 asks for a 3:1
   boundary only where the boundary is the information that identifies the control): the composer
   (placeholder, visible controls and the ink send disc identify it), composer tokens (word and ×),
   Secondary buttons (their label), well fields (search glyph, placeholder, keycap). Every other field
   edge, the switch-off ring, the segmented thumb and the slider track are `--line-strong` (≥ 3.16:1 light,
   ≥ 3.52:1 dark on the grounds they sit on). **In HC all four exceptions swap to `--line-strong`.**

### 1.5 Enforcement (lint and native gate)

| Rule | Where | What it fails |
|---|---|---|
| `design-system/bronze-budget` (new) | `eslint-rules/design-system.mjs`, CSS via the `wave2` css processor | Any `bronze`, `bronze-fill`, `--bronze*` reference outside exactly: `src/components/brand/**`, `src/components/ui/live.tsx` (`LiveDot`, `LiveLabel`, `LiveRule`, `WritingPoint`), `src/components/agents/agent-face.css` and `src/components/agents/face-*.ts` (the working orbit). Everything else uses those primitives. **The rule follows `var()` aliases**: a custom property that resolves to a bronze role counts as bronze |
| `design-system/signal-budget` (new) | same | Any `signal` reference (direct or through a `var()` alias such as `--status-needs-you`) outside exactly: `src/components/ui/needs-you.tsx`, `src/components/agents/agent-face.css`, `src/components/agents/face-*.ts`, `src/components/agents/agent-face.tsx` |
| `design-system/no-ink-3-text` (new) | same | `text-ink-3` (and the legacy `text-ink-tertiary`) on any element that contains text; allowed only on `svg`, bullets (`::marker`) and decorative rails |
| `design-system/no-legacy-colour-role` (new; warn in W0, error in W9 + one release) | same | Any old role name from §1.6 |
| `wave2/no-muted-on-fill` (exists) | `eslint-rules/wave2.mjs` | Retargeted to `ink-3` on any fill |
| `tests/palette-source.test.ts` (new, W0) | node test | every pair and target in §1.3 in four appearances; APCA \|Lc\| ≥ 70 for `ink-2` on the four dark grounds (error) and ≥ 55 for status inks (warn); every chart series ≥ 0.095 OKLab from every status ink and ≥ 0.10 from every other series; **the neutral ramp's OKLCH hue in 230–280 with C ≥ 0.003 on light base and ink and on dark base, stage and float** (the distinctiveness gate; flips to 60–100 if the owner picks warm) |
| `scripts/check-native-colour.mjs` (new, W7) | native gate, Node | Literal colours (`Color(red:…)`, `Color.white/black.opacity(…)`, `UIColor/NSColor(…)`), and `junoBronze*` outside `JunoBrand*.swift`, `JunoLive.swift`, `JunoAgentFace.swift` and `Generated/JunoGeneratedFaces.swift`; `junoSignal*` outside `JunoNeedsYou.swift`, `JunoAgentFace.swift` and `Generated/JunoGeneratedFaces.swift` |

### 1.6 Old → new role names (aliases for one release, then banned)

The generator emits both names for one release (old names resolve through `var()` to the new role in each
appearance, so Swift and TS keep compiling). W9 migrates the call sites; one release after W9 the aliases
are deleted and `no-legacy-colour-role` becomes an error. Counts are today's Tailwind utility uses (WA §2.1)
or `var()` uses (counted 30 Oct 2026). **The table covers every colour custom property declared in
`src/app/globals.css` today (110 names minus the spring, duration and easing variables that share the
`var()` form); `design:tokens:check` fails on any colour property that is in neither the v2 roles nor this
table.**

| Old role (uses) | New role (light / dark when they differ) | Note |
|---|---|---|
| `--background` (138) | `--stage` | page ground → the stage |
| `--foreground` (1,449), `--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground` | `--ink` | |
| `--card` (154), `--table-ground` | `--stage` / `--raised` | in-flow cards are stage + `line` in light, raised + `line-soft` in dark |
| `--popover` | `--float` | |
| `--primary` (278), `--primary-ink` | `--ink` | |
| `--primary-foreground` | `--on-ink` | |
| `--secondary` (141), `--muted` (126), `--user-bubble`, `--cmp-well` (16), `--cmp-well-2` (6) | `--raised` | one value, one meaning |
| `--user-bubble-hover` (2), `--cmp-well-3` (5) | `--selected` | today's cool graphite values leave with them |
| `--accent` (240) | `--raised` | today's hover/tonal fill; W9 moves `hover:bg-accent` to `hover:bg-hover` |
| `--muted-foreground` (2,183), `--faint-foreground`, `--muted-foreground-on-fill`, `--icon-muted`, `--sidebar-foreground`, `--cmp-ink-2` (9) | `--ink-2` | never `ink-3`: all text is ink-2 or ink |
| `--ink-tertiary` | `--ink-3` | decorative only |
| `--selected` (42), `--sidebar-selected`, `--sidebar-accent` | `--selected` | |
| `--sidebar` | `--base` | |
| `--sidebar-hover` | `--well` | opaque stand-in until rows use `--hover` |
| `--border` (660), `--sidebar-border`, `--sidebar-selected-border`, `--hairline`, `--fav-ring` | `--line` | today's warm `--hairline` leftover goes |
| `--input` | `--line-strong` | |
| `--ring` (70) | `--ink` | the focus ring |
| `--presence`, `--presence-ink`, `--live` (Live UI) | `--ink` | today's presence paints controls and decoration (WA §3.6b); live components move to the `live.tsx` primitives explicitly. **The face's working orbit does not take this alias**: W5 repaints `agent-face.css` with `--bronze-fill` (§1.2) |
| `--status-running` (3) | `--bronze-fill` | the running state is live |
| `--status-needs-you` (12), `--status-needs-you-ink` (8) | `--signal` | signal-budget follows these aliases (§1.5) |
| `--status-blocked` (3) | `--danger` | |
| `--status-ready` (2) | `--ink` | |
| `--agent-dormant` (face-local, `agent-face.css`) | recipe kept, re-derived from `--ink-2` and the tone | |
| `--presence-wash`, `--signal-wash` | `--raised` | no washes |
| `--signal`, `--signal-ink` | `--signal` | same name, new value: ember → blue. Release note required |
| `--attention` (21) | `--warning` | today `--attention` is the amber warning role; the name is retired to avoid a silent recolour |
| `--warning-foreground` (109) | `--warning` | |
| `--destructive` (262), `--destructive-ink` | `--danger` | text-safe value in both themes |
| `--destructive-foreground` | `--on-danger` | |
| `--success-ink`, `--success-foreground` | `--success` / `--on-ink` | |
| `--agent-mark` | `--agent-ink` | |
| `--scrim`, `--shadow-ink` | `--scrim`, `--shadow-ink` (same names, v2 values) | |
| `--scroll-fade-ground` | `--stage` | static edge fades use the ground they sit on |
| `--canvas-selection`, `--canvas-guide`, `--canvas-measure` | kept as design-editor tokens (`src/components/design/**` only) | user-content tooling, not product chrome; re-measured in W6 |
| `--knob` (4) | `--float` | the liquid-glass knob goes (COMPONENTS §5) |
| `--tone-edge` (5) | deleted with `.tone-edge` (HC rule moves to the forced-colours set, COMPONENTS §15) | |
| `--code-*` (8) | kept, re-measured on `--raised` (§1.2) | |
| `--ultra`, `--ultra-from`, `--ultra-to`, `--source`, `--sheen`, `--neu-dark`, `--galaxy-core`, `--aura-you`, `--aura-thinking`, `--aura-juno`, `--shadow-soft`, `--shadow-glass`, `--shadow-pop`, `--shadow-lift`, `--shadow-raised*` | deleted | no aliases: their only users are the ambient aura, gloss and galaxy that W9 deletes |

### 1.7 Retiring the seven accent themes (one coordinated change, W0, native in steps)

Nothing is left for an accent to paint (ink is action and focus; selection is a neutral fill natively drawn
by the system on Mac). The web change lands in one pull request because the generator throws when an
`ACCENT_IDS` entry has no `[data-accent]` block and `JunoAccent.swift` is drift-checked against it:

1. `src/lib/accents.ts`: `ACCENTS`/`ACCENT_IDS` reduced to the stored default id `"coral"` (kept only so
   stored settings validate); `swatchInk` deleted with its last caller.
2. `scripts/generate-design-tokens.ts`: the accent section and `JunoAccent.generatedPalette/generatedLabel`
   emission removed; `src/lib/design/tokens.generated.ts` and `JunoGeneratedTokens.swift` regenerated.
3. `src/app/globals.css`: every `[data-accent]` block deleted; `src/app/layout.tsx` stops setting
   `data-accent`.
4. Settings: the accent swatches in `src/components/settings/sections/general.tsx`, the onboarding picker in
   `src/components/app/onboarding.tsx`, the save path in `src/components/settings/use-settings-save.ts`;
   the settings API (`src/app/api/settings/route.ts:22`, which also accepts `#hex` accents),
   `src/lib/sync-mutations.ts:74` and `src/lib/preferences.ts:19` keep accepting the seven old ids and any
   hex, and store `"coral"`.
5. **Native, in two steps** (350 references to `Color.junoAccent`, `junoAccentInk` and `junoOnAccent` in
   143 files, counted with `grep -rn junoAccent native` on 30 Oct 2026, including `JunoCode`,
   `JunoWorkKit` and `JunoChatKit`): **W0** keeps `Color.junoAccent`, `junoAccentInk` and `junoOnAccent` as
   `@available(*, deprecated)` aliases that resolve to the generated `ink` / `ink` / `on-ink` with no
   selection, deletes the pickers (`DesktopSettingsGeneralPane.swift`, `DesktopOnboardingSheet.swift`,
   `JunoMobileSettingsView.swift`) and stops reading `JunoAccentSelection` at launch
   (`JunoDesktopRootView.swift`, `JunoDesktopApp.swift`, `JunoMobileRootView.swift`,
   `JunoMobileChrome.swift`, `ComputerUseDesktopHost.swift`); the macOS CI jobs stay green because every
   call site still compiles. **W7/W8/W9** migrate the references in the files they own; `JunoAccent.swift`
   and `JunoAccentSelection` are deleted in W9 once `grep junoAccent native` returns only the alias file.
   Tests: `JunoAccentTests.swift`, the accent rows of `JunoColorConsumptionTests`, `JunoTokenConsumptionTests`,
   `JunoInkContrastTests` and the macOS settings snapshot tests move with their step.
6. Tests: `tests/design-token-parity.test.ts`, `tests/settings-save-ledger.test.ts`,
   `tests/wave2-p1-globals.test.ts`, `tests/presence-token.test.ts`.
7. Other readers of the accent: `src/components/chat/mermaid-block.tsx`, `src/app/dev/directions/tokens.ts`,
   `src/app/dev/research/gallery.tsx`, `src/app/dev/run/gallery.tsx`, `src/app/aura-preview/preview.tsx`
   (sets `data-accent`; the route is deleted in W9 with the aura). **Not readers** (they only share the
   word): `src/lib/work/deliverables/site.ts:73` (a generated website's own theme) and
   `src/lib/provider-colors.ts:3` (lab logo colours); they are left alone.

Replacement personalisation: one **alternate app icon on iPhone** (the Light ground, BRAND §4). iOS 26
already gives every icon Default, Dark, Clear and Tinted appearances, so a "Dark" alternate would duplicate
the system; macOS has no alternate-icon API for a running app (only the Dock tile can be swapped while it
runs), so the Mac gets none. Release note: "Accent colours are gone; Alevr now uses one ink everywhere. On
iPhone you can pick the light app icon in Settings › General."

---

## 2. Type

### 2.1 Families, files and payload

| Family | Job | File shipped (measured size) | Licence |
|---|---|---|---|
| **Geologica** (Monokrom), instanced at CRSV 1, SHRP 0, slnt 0, wght 400–600 | The voice: the home greeting, page titles (`title-1`), empty-state headline on public pages, landing, auth; at most one display line per screen, ≥ 28 px | web: `geologica-latin-crsv1-wght400-600.woff2` 23,752 B; Cyrillic 15,108 B on demand. **Native and share images: TTF** (Apple documents app fonts as TTF/OTF; `next/og` cannot read WOFF2): variable `geologica-latin-crsv1-wght400-600.ttf` 69,508 B, Cyrillic 36,876 B; static 460 for the OG image 41,380 B / 22,756 B | SIL OFL 1.1 |
| **Inter 4.1** (rsms build, keeps `opsz` 14–32), features `kern liga calt ccmp locl mark mkmk tnum case cv05 cv08 ss03 frac numr dnom`, wght 350–650 | All work: controls, reading, tables | Latin roman 65,452 B (preloaded); Latin italic 70,772 B (on first italic); **Cyrillic 24,420 B, Greek 25,544 B, Vietnamese 12,728 B** (each by `unicode-range`, never preloaded) | SIL OFL 1.1 |
| **JetBrains Mono** | Code, diffs, file contents only | `jetbrains-mono-latin-wght-normal.woff2` 40,404 B (on first code block) | SIL OFL 1.1 |
| **SF Pro / SF Mono** (system) | All work on Mac and iPhone | the OS; never bundled | Apple system font |

- Preload budget: Inter roman 65,452 B + Geologica Latin 23,752 B = **89,204 B** (≤ 120 KB, J-platform).
  Today preloads Inter 48,256 B + Newsreader 58,084 B (+ 64,520 B italic). Sizes measured on 30 Oct 2026
  with fontTools 4.68.0; commands, inputs and their SHA-256 in `tools/fonts.md`; the inputs are committed
  in `tools/fonts-src/` and the non-Latin, italic and TTF outputs in `tools/fonts-out/`.
- Why the rsms build and not Fontsource's `inter-latin-opsz`: the Fontsource opsz file has only
  `calt ccmp dnom frac locl numr pnum tnum` (checked), so `cv05` (tailed l), `cv08` (serifed I, so `Il1`
  and model names never collide) and `case` are missing. The non-Latin subsets are cut from the same rsms
  file with the same feature list, for the same reason.
- **Arabic and Hebrew** (the product ships `ar` and `he`, `src/lib/i18n.ts:15`): Inter has neither script,
  so its `unicode-range` never claims them and the stack falls through to the platform's face:
  `font-family: Inter, system-ui, "SF Arabic", "SF Hebrew", "Segoe UI", "Noto Sans Arabic", "Noto Sans Hebrew", sans-serif`.
  Geologica has neither either; in those locales the display line uses the same stack at weight 600.
- Newsreader and Literata leave the product (W6 removes the last users; W0 drops their preload).
- Geologica CRSV 1 checked in French, German and Cyrillic at 40 px with the new greeting
  (`shots/brand-check-{light,dark}.png` row 4): all glyphs present, no fallback; the Cyrillic dateline now
  renders in the Inter Cyrillic subset (it fell back to a serif before).

### 2.2 The ladder (one table; the generator emits every column)

**Shape of the data (fixes the review's typecheck failure).** `tailwind.config.ts` `fontSize` entries stay
what Tailwind's `Config` type accepts: rem sizes and rem-intercept clamps, unitless line heights,
`letterSpacing`, `fontWeight`. The platform data lives in a separate typed file,
**`src/lib/tokens/type.source.ts`** (`export const TYPE_META: Record<Rung, { ios?: { style, size, face },
mac?: { size, face }, appleWeight }>`), which the generator reads beside the config and validates (every
rung in both, or it throws). The generator's `REM` and `CLAMP` parsers (`generate-design-tokens.ts:543-544`)
stay as they are.

| Rung | Web: family, size / line, weight light / dark, tracking | `fontSize` entry | iOS (Dynamic Type style, pt) | Mac (pt) | Apple weight | Used for |
|---|---|---|---|---|---|---|
| `hero` | Geologica 44 → 72 px / 1.04, 460, −3.2 % | `clamp(2.75rem, 2.0652rem + 3.0435vw, 4.5rem)` (44 px at 360 px, 72 px at 1,280 px; rem intercept so text zoom works, WCAG 1.4.4) | — | — | — | Landing hero only |
| `display` | Geologica 40 / 46, 460, −2.6 % | `2.5rem`, line 1.15 | Geologica 32, `relativeTo: .largeTitle` | Geologica 30 | wght axis 460 | Home greeting (desktop), auth title, landing section heads |
| `display-compact` | Geologica 30 / 36, 460, −2.2 % | `1.875rem`, line 1.2 | (iPhone uses `display`) | — | wght axis 460 | The greeting below 600 px wide (a second rung, because one `fontSize` entry cannot switch at a breakpoint) |
| `title-1` | Geologica 28 / 34, 500, −1.8 % | `1.75rem`, line 1.2143 | system `.largeTitle` in the navigation bar | SF 22 | semibold | Page titles, one per screen, never on the same screen as `display` |
| `title-2` | Inter 18 / 24, 600 / 580, −1.2 % | `1.125rem`, line 1.3333 | `.title3` (20) | 15 | semibold | Dialog titles, empty-state titles, card heads |
| `title-3` | Inter 15 / 22, 600 / 580, −0.9 % | `0.9375rem`, line 1.4667 | `.headline` (17) | 13 | semibold | Agent name, needs-you question, settings group heads, sheet headers |
| `answer-h2` | Inter 20 / 28, 600 / 580, −1.6 % | `1.25rem`, line 1.4 | `.title3` (20) | 17 | semibold | Headings inside answers |
| `answer-h3` | Inter 16 / 24, 600 / 580, −1.0 % | `1rem`, line 1.5 | `.headline` (17) | 14 | semibold | Sub-headings inside answers |
| `reading` | Inter 16 / 27, 400 / 380, −0.8 % | `1rem`, line 1.6875 | `.body` (17), line spacing 5 | 15, line 24 | regular | The answer column |
| `bubble` | Inter 15 / 24, 450 / 430, −0.6 % | `0.9375rem`, line 1.6 | `.body` (17) | 14 | regular | The user's turn |
| `ui` | Inter 13.5 / 20, 450 / 430 (buttons 520 / 500), −0.3 % | `0.84375rem`, line 1.4815 | rows `.body` (17); secondary `.subheadline` (15) | 13 | regular (buttons medium) | Rows, menus, inputs, sidebar, descriptions, dialog body |
| `caption` | Inter 12 / 16, 450 / 430, 0, `tnum` where numbers stack | `0.75rem`, line 1.3333 | `.footnote` (13) | 11 | regular | Timestamps, stamp line, metadata, section labels |
| `micro` | Inter 11 / 14, 560 / 540, +1 % | `0.6875rem`, line 1.2727 | `.caption2` (11) | 10 | medium | Badges, kbd, citation numerals; never a sentence |
| `code` | JetBrains Mono 13 / 21, 400 (inline 0.875 em) | `0.8125rem`, line 1.6154 | SF Mono 14, `relativeTo: .callout` | SF Mono 12 | regular | Code |

Rules: 12 px is the web floor (11 only for `micro`); no all-caps, no letter-spaced labels; section labels
are `caption` at 520 in `ink-2`, sentence case; mono is never a label or a number style (numbers use Inter
`tnum`); reading size is a user setting (Small 15 / Default 16 / Large 18, `--measure` follows in em). The
reading line height stays 1.6875 at every reading size, so the line box is ≥ 25.3 px at Small (the citation
hit area needs ≥ 24, IDENTITY_V2 §10.1).

**Old type rungs → new (aliases).** W0 emits the old names as deprecated aliases that **keep today's
values** (so no call site changes size until the wave that owns it migrates it); `no-legacy-type-rung`
warns from W0 and errors in W9; the W9 codemod maps each call site to the target below. Old generated Swift
names (`JunoGeneratedType.pageTitle`, `.homeTitle`, `.heading`, `.label`, `.nav`, `.bodyLg`, `.body`,
`.title`, `.kbd`) stay as `@available(*, deprecated, renamed:)` aliases until W9. Uses counted on 30 Oct 2026
(review figures).

| Old rung (uses) | Today's value | Target in W9 | Note |
|---|---|---|---|
| `text-body` (358) | 15 / 1.6 | `bubble` (same size) or `ui` | by context; the codemod lists each file |
| `text-label` (148) | 12 / 1.4, 500 | `caption` at 520 | |
| `text-heading` (74) | 18 / 1.3, 600 | `title-2` | same size |
| `text-title` (41) | 22 / 1.25, 600 | `title-2` or `title-1` | no 22 rung in v2 |
| `text-body-lg` (37) | 17 / 1.6 | `reading` | |
| `text-page-title` (29) | clamp 32 → 44 cqi, serif | `title-1` | |
| `text-nav` (28) | 14 / 20 | `ui` | |
| `text-home-title` | clamp 34 → 50 cqi, serif | `display` / `display-compact` | |
| `text-kbd` | 11 / 1.45 | `micro` | |
| `text-display` | clamp 32 → 48 cqi | `display` (same name, new value; landing only today) | value change lands with W6's landing |
| `text-micro` | 12 / 1.4 | `micro` (same name, 11 / 14 from W0) | W0's PR lists the call sites that set a sentence in `micro` and moves them to `caption` |
| `text-ui` | 13 / 1.5 | `ui` (same name, 13.5 / 20 from W0) | intended 0.5 px step |

### 2.3 Native weights (fixes `JunoType.weight(css:)`)

Today `JunoType.weight(css:)` (`JunoTypography.swift:324`) maps only 500, 600 and ≥ 700, so 430, 450,
460, 520 and 580 all render `.regular`. Fix (W0 data, W7 code): every rung carries an explicit
`appleWeight` (`type.source.ts`), which wins; for any other CSS weight the fallback rounds to the nearest
hundred with ties going down (450 → `.regular`, 460 → `.medium`, 520 → `.medium`, 580 → `.semibold`).
Geologica sets its exact `wght` axis value through the font descriptor's variation attribute
(`kCTFontVariationAttribute`, axis tag `0x77676874`), because a custom font's `.weight()` only picks named
instances; registering the **variable TTF** natively and setting the axis is **unverified on device** (W7
device check; fallback: ship the static 460 TTF). The dark-mode −20 trim and the −0.1 px dark icon trim
are **web-only** (SF Pro and the system symbol renderer handle irradiation themselves).

### 2.4 Reading measure (measured)

Measured on 30 Oct 2026 in Chromium (Playwright) with the Inter 4.1 subset above at 16 px, 400, −0.8 %
tracking, over a 1,190-character English paragraph, counting characters per rendered line (all lines but
the last): 560 px → 72.3 average; **576 px → 74.7 average (71–79)**; 600 px → 78.4; 680 px → 88.3; 704 px
→ 93.3. The column is therefore **`--measure: 36em`** (576 px at the default 16 px reading size; 540 px at
Small 15; 648 px at Large 18). The 70–75 target is the **average** characters per line, not every line;
inline citation numerals only lower the count. Code blocks, tables and Live UI cards may widen up to `45em`
(720 px) under the clamp in §3.

---

## 3. Spacing and layout metrics

Scale (px): **2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96**. 14 is retired (the geometry gate
flags it); 10 stays because control insets use it.

| Token | Value | Where |
|---|---|---|
| `--sidebar-default` / `-min` / `-max` | 264 / 232 / 336 | sidebar width; drag below 200 closes it |
| `--stage-inset` | 8 (top, right, bottom); 0 below 1,024 px window | the stage's gap to the window edge |
| `--header-h` | 52 (agent thread 64) | stage header |
| `--measure` | 36em | reading column |
| `--measure-wide` | 45em | the most a code block, table or Live UI card may take (clamped, below) |
| `--margin-gap` / `--margin-rail` | wide 48 / 208; compact 32 / 160 | the transcript margin (IDENTITY_V2 §10.1) |
| margin tiers | **wide** when content width ≥ measure + 544 px; **compact** when ≥ measure + 364 px; else none (at 16 px: 1,120 and 940; at Large 18: 1,192 and 1,012; at Small 15: 1,084 and 904) | chosen by the same `ResizeObserver` that places the notes, written as `data-margin-tier` on the transcript; no container query has to compute `em + px` |
| `--composer-w` | `calc(var(--measure) + 48px)` (624 px at 16 px) | composer; centred on the reading column |
| `--composer-text-inset` | `calc((var(--composer-w) - var(--measure)) / 2)` = 24 px | the field's inline padding, so the placeholder's first character sits on the column's edge (measured: dateline, greeting and placeholder all start at x = 432 px in `shots/home-1440-light.png`'s layout) |
| wide-block width | `min(var(--measure-wide), var(--measure) + var(--free-start) - var(--page-gutter))`, where `--free-start` is the distance from the column's inline start to the stage's content edge (written by the same observer); the rest scrolls inside the block with a static 24 px edge fade | code, tables, Live UI cards; they grow toward the inline start only, so the margin lane stays clear |
| `--page-gutter` | 16 / 24 / 32 keyed to the column (today's rule, kept) | page padding |
| page column | max 1,040 | Projects, Library, Research, Memory, Orbit |
| settings column | max 720 | settings pane |
| phone gutter | 20 | phone transcript and pages |
| row gap (sidebar) | 0 (rows abut; one hover plate at a time) | |
| section gap (sidebar) | 16 above a section label | |

Wide-block widths at the review's cases (16 px reading size, measure 576, gutter 32 wide / 24 compact): wide
tier at 1,168 px content → 712 px; at 1,120 → 688; compact at 1,008 → 672; at 940 → 638; Large 18 px at
1,094 (compact) → 751 against a 648 measure. No block passes the stage's content box (W5 asserts it).

## 4. Radius and corners

| Token | px | Used for | Concentric partner |
|---|---|---|---|
| `sm` | 4 | kbd, inline code, checkbox, citation numeral focus box | |
| `chip` | 6 | small buttons (28), tooltips, segmented thumb, monogram tiles | segmented track 8 − inset 2 |
| `control` | 8 | buttons (32), inputs, every row (menu, sidebar, list hover plate, palette), segmented track, icon buttons, tiles 32 | menu 12 − inset 4 |
| `card` | 12 | menus, submenus, popovers, selects, toasts, cards, code blocks, needs-you card, citation popover, large buttons (40) | |
| `sheet` | 16 | the stage, dialogs, the palette, settings group cards on phone, the user turn, phone sheet top corners (native: system) | |
| `composer` | 24 | the composer and the voice bar (web, Mac, iPhone: one value) | 24 − inset 8 = 16 = radius of the 32 px controls inside |
| `full` | 9999 | capsules: tokens, the sources control, switches, avatars, the send disc, status dots | |

Seven names (today: fourteen). **No name changes meaning**: `sm` keeps today's 4 px; today's `xs` (6 px)
becomes an alias of the new `chip` (6 px); the 16 px rung is `sheet`, not `stage` (today `stage` = 28 px,
marketing only). The `no-arbitrary-radius` and `concentric-radius` lint rules keep the ladder; their
allow-list becomes these seven plus `micro` 2 px, the one sub-rung, allowed only on elements under 12 px
(data cells, crop handles).

**Old radius names → new (aliases kept in `tailwind.config.ts` until W9; `no-legacy-radius` warns from
W0).** Uses counted by the review on 30 Oct 2026.

| Old name (uses) | Today | Alias of | Value after W0 |
|---|---|---|---|
| `xs` (155) | 6 | `chip` | 6 (unchanged) |
| `sm` (69) | 4 | `sm` | 4 (unchanged) |
| `md` (61) | 8 | `control` | 8 (unchanged) |
| `lg` (27), `popover` (11), `surface` | 12 | `card` | 12 (unchanged) |
| `field` (227) | 10 | `control` | 8 (intended) |
| `menu` (33) | 14 | `card` | 12 (intended) |
| `panel` (43) | 16 | `sheet` | 16 (unchanged) |
| `stage` (marketing) | 28 | `sheet` | 16 (the painted plates are deleted in W6) |
| `composer-action` | 16 | `sheet` | 16 (unchanged; = composer 24 − 8) |
| `composer-control` | 14 | `card` | 12 |
| `micro` (21) | 2 | `micro` | 2 (sub-rung, < 12 px elements only) |

A test (`tests/tailwind-class-resolution.test.ts`, W0) asserts that every `rounded-*` and `text-*` class
used under `src/` resolves in the Tailwind config, because Tailwind silently generates nothing for an
unknown class.

**Continuous corners without breaking Safari and Firefox.** The ladder values are designed and approved as
plain circular radii: that is what WebKit (Safari, the default browser for Mac users) and Firefox draw.
Chromium adds a progressive enhancement that keeps the same optical corner depth. **The scale and the shape
are applied together, in one layer, to the same elements**, so no element ever gets a larger circular
corner without the superellipse:

```css
@supports (corner-shape: superellipse(1.5)) {
  @layer corners {
    [class*="rounded-"]:not(.rounded-full):not(.rounded-none) {
      corner-shape: superellipse(1.5);
      border-radius: calc(var(--r, 0px) * 1.35);
    }
  }
}
/* tailwind.config.ts keeps px values; a small plugin also writes each radius utility's px value to --r */
```

Why 1.35: a circular corner of radius r cuts 0.414 r off the diagonal; `superellipse(1.5)` (exponent
2^1.5 = 2.83) cuts 0.307 r; 0.414 / 0.307 = 1.35, so the scaled superellipse has the same diagonal depth as
the plain radius. **Concentric children are computed from the scaled parent**: child = R × 1.35 − inset
(menu 12 × 1.35 − 4 = 12.2 px for its rows; composer 24 × 1.35 − 8 = 24.4 px for its 32 px capsules, which
stay `full`), so the plugin's `nest-*` helpers emit `calc(var(--r-parent) * 1.35 - inset)` inside the same
`@supports` block. `tailwind.config.ts` keeps px values, so the generator (`generate-design-tokens.ts:514-520`
reads `/^\d+px$/`) and the geometry audit read the px ladder unchanged; the audit divides computed radii by
1.35 only on elements whose computed `corner-shape` is a superellipse. A Playwright test (W3, Chromium)
asserts that every element with a non-zero, non-full radius has `corner-shape: superellipse(1.5)`
whenever the `@supports` branch is active. WebKit render of the stage, composer and menus: **unverified**
(W3's WebKit screenshots run in CI only; MIGRATION W3). Native: `RoundedRectangle(cornerRadius:style:
.continuous)` and `ConcentricRectangle` with the ladder values as-is.

---

## 5. Borders

| Token | Value | Rule |
|---|---|---|
| hairline | 1 px `--line` | table rules, card edges in light, page dividers (decorative; §1.4 rule 7) |
| soft | 1 px `--line-soft` | separators inside floats and lists |
| strong | 1 px `--line-strong` | anything that must be found: field edges, switch-off ring, segmented thumb, table head rule, slider track; every HC boundary |
| stage edge | `0 0 0 1px` ink 6 % (light) / white 5 % (dark) | the stage against the base |
| focus | 2 px `--ink` **outline** (never a box-shadow), offset 2, keyboard only (`src/lib/input-modality.ts`); inside menus and lists: inset (offset −2) on the row | never on pointer, never animated |
| field pointer focus | the field's own 1 px edge changes colour `--line-strong` → `--ink-2`; no outline, no ring, no width change | a field state, not a focus ring (owner rule 1) |

One width (1 px); no 0.5 px hairlines (they vanish at 1x). No coloured borders anywhere. **Forced colours**
(Windows High Contrast): COMPONENTS §15.

---

## 6. Elevation (one family, generated for web and native)

"Lift is earned": only floating layers, the composer while content scrolls beneath it, and a card that
waits for the person cast a shadow. Every tier's first layer is a 1 px ring, so floats need no border.

| Tier | Who | Light | Dark |
|---|---|---|---|
| 0 ground | base, stage, raised, cards, code, turns, rows, Live UI cards | none (tone + hairline) | none (lightness: base 0.160 → stage 0.214 → raised 0.246) |
| 1 lift | the composer and the voice bar while content is under them; the needs-you card and permission requests while waiting; tooltips have no shadow | `0 0 0 1px rgb(21 23 27 / .06), 0 1px 2px rgb(21 23 27 / .05), 0 6px 16px -6px rgb(21 23 27 / .10)` | `0 0 0 1px rgb(255 255 255 / .07), 0 6px 16px -6px rgb(0 0 0 / .50)` on `--float` |
| 2 float | menus, submenus, popovers, selects, toasts | `0 0 0 1px rgb(21 23 27 / .07), 0 2px 4px -1px rgb(21 23 27 / .06), 0 14px 32px -10px rgb(21 23 27 / .18)` | `0 0 0 1px rgb(255 255 255 / .08), 0 2px 4px -1px rgb(0 0 0 / .35), 0 14px 32px -10px rgb(0 0 0 / .60)` |
| 3 modal | dialogs, sheets, the palette, the phone drawer | `0 0 0 1px rgb(21 23 27 / .06), 0 4px 8px -2px rgb(21 23 27 / .06), 0 28px 64px -18px rgb(21 23 27 / .28)` + scrim | `0 0 0 1px rgb(255 255 255 / .08), 0 4px 8px -2px rgb(0 0 0 / .35), 0 28px 64px -18px rgb(0 0 0 / .70)` + scrim |

- **HC**: `--shadow-1/2/3` are **redeclared** inside the `prefers-contrast: more` blocks with the ring
  layer as `0 0 0 1px hsl(var(--line-strong) / 1)` (a literal alpha of 1, not the 0.06–0.08 the default
  ring carries); throws unchanged. The generator parses the shadow grammar in all four appearances and
  emits each.
- Dark menus: the float is lighter than the stage by a measured 1.221:1 luminance step, and the ring is
  white 8 %; together they fix d3's faint dark menu edges (J-owner must-fix).
- **Generated.** globals.css declares `--shadow-1/2/3` in a constrained grammar (layers of
  `<x>px <y>px <blur>px <spread>px hsl(var(--shadow-ink|--shadow-ring) / <a>)`); the generator parses them
  and emits `JunoGeneratedElevation.tier1/2/3` (per appearance: ring colour and alpha, then each throw as
  x, y, blur, spread, alpha) and `src/lib/design/tokens.generated.ts`. Native renders the ring as a 1 pt
  `strokeBorder` on the shape and each throw as `.shadow(color:radius:x:y:)` with `radius = blur / 2`;
  negative spread has no SwiftUI equivalent and is approximated by the generator as
  `radius = (blur + spread) / 2` (unverified: tune against a web render on device). The hand-written
  `JunoElevation` enum is deleted.
- **Static in scrolling chrome.** The composer's tier 1 is a static `box-shadow` on a pseudo-element whose
  opacity cross-fades 160 ms when an `IntersectionObserver` sentinel at the transcript's end leaves or
  enters view; no `filter`, no `backdrop-filter`, no shadow animation during scroll. Natively the same via
  `onScrollGeometryChange`.
- **The lift's weight** is carried by the shadow layer arriving a beat after the body (MOTION §3.1); the
  shadow is a pre-blurred pseudo-element animated only in `opacity` and `transform`, never an animated
  `box-shadow`.
- No inset highlights, no coloured shadows, no shadow on buttons, cards in flow, rows or turns.
- **Forced colours** remove `box-shadow`; every tier therefore also carries a transparent 1 px border that
  becomes `CanvasText` (COMPONENTS §15).

## 7. Materials

- **Web: no blur anywhere in product chrome.** Floats are opaque `--float`; the scrim is a flat tint;
  scroll edges are static fades of the ground colour (18 px under the header, 64 px above the composer).
  The existing `wave2/no-backdrop-filter` and `wave2/no-blur-entrance` rules lose every **product-chrome**
  exemption (the agent bar 18 px blur, dialog scrim blur, palette blur, image-edit toolbars, the "liquid
  glass" slider knob, `agent-computer.tsx` `backdrop-blur-xl`). **The user-content exemption stays**:
  `src/lib/design/**` and `src/components/design/**` write `backdrop-filter` into designs people make
  (`src/lib/design/export.ts:747`, `render.ts:823`), which is their content, not Alevr's chrome.
- **Native: Liquid Glass only where the system draws it** (toolbars, the Mac sidebar, menus, popovers,
  sheets at partial detents, navigation bar items). Every Alevr surface is opaque (NATIVE.md §3).

## 8. Targets and density

| Element | Web pointer | Mac | Touch (coarse pointer, iPhone) |
|---|---|---|---|
| Any interactive element | ≥ 24 × 24 px (hit area may extend past the visual) | ≥ 28 × 28 pt | ≥ 44 × 44 |
| Text-only controls ("4 sources ›", "Show 4 earlier steps", "Show the draft", the stamp line, "Show more") | ≥ 24 × 24 through padding or `::after`; never a bare caption line | ≥ 28 pt | 44 |
| Menu row | 32 | system | 44 |
| Sidebar row (including the Orbit header row) | 32 | system | 44 |
| Palette row | 36 | 36 | 44 |
| Page list row | 52 | 44 | 56 |
| Settings row | ≥ 56 (12 vertical padding); the whole row is the switch's hit area | ≥ 56 | ≥ 56 |
| Buttons | 28 small / 32 default / 40 large (landing, auth) | 28 / 32 | 44 |
| Icon buttons | 32 (28 in dense rows, hit area 32) | 28 | 44 |
| Composer controls | 32 | 32 | 40 visual, 44 hit |
| Token remove (×) | 24 | 28 | 44 |
| Slider | thumb 18 visual, 24 hit; the track is clickable | 28 | thumb 44 hit |
| Checkbox | 16 visual; the whole label is the target | same | same, row ≥ 44 |
| Citation numeral | 24 × 24, centred horizontally on the numeral and vertically on the **line box** (top = line top + 1.5 px at the 27 px line); a run of adjacent numerals is one control | 28 | 32 hit; the 44 pt sources control is the primary path |

Control heights on the geometry gate: 24, 28, 32, 40, 44. Icon sizes: 12, 16, 20, 24, 32, 40. Agent faces
are exempt from the icon-size check and have their own floor: **≥ 20 px** (the rig's smallest tested size,
AGENTS.md §4.3).

**Declared platform variants** (J-platform must-fix: the generator had no notion of one). `tailwind.config.ts`
gains `theme.extend.platform`, read by the generator and emitted as `JunoGeneratedShell` values, so no
native file types a literal. Row and list heights are **minimums**: at iOS accessibility text sizes they
grow with the text (NATIVE §5.1).

| Token | Web pointer | Web coarse pointer | Mac | iPhone |
|---|---|---|---|---|
| `rowHeight` (menu, sidebar, palette) | 32 | 44 | system (`List` sidebar rows and `NSMenu` draw their own) | min 44 |
| `listRowHeight` | 52 | 56 | 44 | min 56 |
| `composerControl` | 32 | 40 (44 hit) | 32 | 40 (44 hit), `@ScaledMetric` |
| `composerRadius` | 24 | 24 | 24 | 24 (one value; today 26 / 24 / 24 literals) |
| `composerFieldSize` | 15 | 16 | 14 | 17 (`.body`) |
| `drawerDim` | — | `--drawer-dim` (ink 12 % light, black 50 % dark) | — | the same values |
| `sidebarWidth` default / min / max | 264 / 232 / 336 | drawer 86 % of width, max 336 | 264 / 232 / 336 (today literals 220 / 360) | drawer 86 %, max 336 |
