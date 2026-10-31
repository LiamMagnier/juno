# Alevr web: component system audit (read-only)

Scope: `src/components/ui/*`, the three recipes, and the bespoke feature components (chat cards, approval cards, settings rows, library rows, agent cards, customize nav, product switch, composer). The sources are:
- the code;
- the token sheet (`tailwind.config.ts`, `src/app/globals.css`);
- the compiled dev stylesheet (`.next/static/css/app/layout.css`);
- the 22 screenshots in `scratchpad/shots/` (1280×900, above the fold only).

No source was modified. All px values assume a 16px root.

Screenshot note: `/dev/run` (run-light.png) renders a Next build error ("server-only" imported via `src/lib/action-approval-store.ts`), so the approval card could not be checked visually. It was audited from code only.

---

## 0. Foundations as they actually ship

### 0.1 Radius ladder (`tailwind.config.ts:208-262`)

| token | px | notes |
|---|---|---|
| micro | 2 | also the name of a retired 12px **font** rung (`text-micro`). The name collides. |
| sm | 4 | |
| xs | 6 | "chips, dots, tiny badges". 159 uses, but it is never named in the documented ladder. |
| control / md | 8 | buttons, rows, menu rows, tooltips |
| field | 10 | inputs, select, chat cards (!) |
| card / lg / popover / surface / bubble | 12 | five names for one value |
| menu / composer-control | 14 | |
| panel / composer-action | 16 | |
| composer | **26** | every comment says 22: `tailwind.config.ts:30,187,192,214,235`, `globals.css:385`, BRAND_IDENTITY.md:86 |
| stage | 28 | marketing |
| inner | `calc(--r-outer − --pad)` | concentric helper |

Usage counts in src: control 355, full 334, card 232, field 214, xs 159, sm 71, panel 44, md 33, menu 32, micro 21, lg 18, composer 18, inner 12, popover 10, composer-control 6, **composer-action 1**.

### 0.2 Elevation (`globals.css:669-691`, light theme)

| token | value | used |
|---|---|---|
| raised | `0 1px 2px ink/.04` | 18 |
| soft (legacy) | **identical to raised** | 30 (more than raised) |
| raised-lg | `0 1px 2px .04, 0 6px 16px -6px .08` | 7 |
| lift (legacy) | `0 1px 2px .04, 0 4px 12px -4px .08`, which is about the same as raised-lg | 3 |
| glass (legacy) | `0 2px 6px .05, 0 14px 36px -10px .16` | 3 |
| float | `0 0 0 1px .03, 0 4px 12px -2px .06, 0 24px 56px -16px .22` | 16, plus `.surface-float`/`.overlay-glass` |
| pop | `0 1px 2px .06` | 4 |
| inset / pressed | `0 0 0 0 transparent`, so dead | 2 |
| **arbitrary `shadow-[…]`** | — | **61** |

Bespoke shadow recipes outside the kit:
- `.control-primary` (`globals.css:1590-1593`);
- `.composer-surface` (`:1888-1890`);
- `.product-switch-thumb` (`:1685-1688`);
- `.ui-tooltip` (`:4830`);
- `.glass-slider` thumb (`chat/live-ui/live-ui.css:219-222, 243-246, 252-256`).

### 0.3 Fill and ink tokens

| role | light (HSL L) | dark (L) |
|---|---|---|
| background | 99.0 (hue 240/20%, the only bluish one) | 10.0 |
| card | 100 | 14.1 |
| popover | 100 | 16.1 |
| muted | 96.5 | 12.9 |
| accent (hover) | 94.1 | 18.4 |
| secondary | **= accent** 94.1 | **= accent** 18.4 |
| user-bubble | **= accent** 94.1 | 15.3 |
| selected (on) | 90.8 | 22.5 |
| sidebar-accent | **= selected** 90.8 | 18.4 |
| border | 88.0 | 22.0 (≈ selected 22.5) |
| input / field-border / switch-off track | **53.9** | 45.1 |
| primary | graphite 11 | 91 |
| shadow-ink | cool 216° | black |
| hairline / scrim / neu-dark | **warm 45–48°** | warm 45° |

Concrete findings:
- `accent`, `secondary` and `user-bubble` are one value. A secondary badge, a hover wash, the user bubble and a tool chip are indistinguishable.
- In dark mode `--selected` (22.5%) equals `--border` (22.0%). A selected key's fill and its hairline merge.
- The warm hairline (`globals.css:690`), the warm scrim (`:698`) and `--neu-dark` (`:663`) are leftovers of the pre-graphite palette. The comment at `:694-697` admits this.

### 0.4 Border weights and alphas

Surface classes draw a 1px hairline at five different strengths:
- `.surface-raised` fg/.06 (`:1480`);
- `.surface-key` border/.8 (`:1494`);
- `.surface-inset` border/.8 (`:1522`);
- `.surface-float` border/.9 (`:1532`);
- `.overlay-glass` border/.7 (`:2231`);
- `.control-neu` border/1.0 (`:1550`);
- `.composer-surface` fg/.1 (`:1887`).

Call-site utilities add more:

| utility | uses |
|---|---|
| `border-border/60` | 266 |
| `/70` | 117 |
| `/50` | 27 |
| `/40` | 12 |
| `/80` | 11 |
| `/45` | 2 |
| `border-foreground/[0.06 … 0.16]` | ~30 (nine distinct arbitrary alphas) |
| `border-white/[…]` | 6 |

Weights in use are 1px (default), 1.5px (inset-shadow radios, `work-run-panel.tsx:467`) and 2px:
- the settings mode/font tiles' selected edge (`settings/sections/general.tsx:370`, 1px border + 1px ring);
- `approval-frame.tsx:137`;
- the surface-tabs bar `h-0.5`.

Field borders use `--input` at 54% L, about 2.4× the contrast of the card hairline beside them.

### 0.5 Type rungs (`tailwind.config.ts:420-572`) and use counts

| rung | size / lh / weight | uses |
|---|---|---|
| hero | 38→64 | 1 |
| display | 32→48 / 1.08 / 500 | 30 |
| page-title | 32→44 / 1.08 / 500 | 23 |
| home-title | 34→50 / 400 | **0** |
| title | 22 / 1.25 / 600 | 40 |
| heading | 18 / 1.3 / 600 | 71 |
| body-lg | 17 / 1.6 | 32 |
| reading | 16 / 1.7 | 18 |
| body | 15 / 1.6 | 309 |
| nav | 14 / 20px | 29 |
| ui | 13 / 1.5 | 938 |
| label | 12 mono / 500 / .01em | 173 |
| **caption (deprecated)** | 12 / 1.4 | **1176**, the most-used rung in the product |
| **micro (retired)** | 12 / 1.4 | **239** |
| kbd | 11 mono | **0**. Kbd and Badge, the two components it exists for, don't use it. |

A second, parallel type scale in raw px lives in `components/app/editorial.css`:

| class | value | location |
|---|---|---|
| ed-display | `clamp(40px, 4.6vw, 60px)` | `:20`. Uses vw, which the tailwind comments call a bug. |
| ed-h2 | 28 | `:28` |
| ed-h3 | 22 | `:35` |
| ed-lead | 21 | `:42` |
| ed-figure | 30 | `:50` |
| ed-name | 18 | `:198` |
| shell-title | 17 | `:145` |
| ed-annot / shell-annot | **11px mono** | `:58`, `:137`. Below the documented 12px type floor (D16). |

Other type debt:
- `font-mono` + caption/micro appears in about 550 strings; with `text-label`, about 720 mono metadata sites.
- Tracking overrides: `tracking-tight` 23, plus nine distinct arbitrary `tracking-[…]` values.
- Inline `fontSize:` appears 37 times, including 15.5, 11 and 8.5.

### 0.6 Spacing

Of ~8,700 spacing utilities:
- 2,183 (~25%) are half-steps (0.5, 1.5, 2.5, 3.5 → 2/6/10/14px);
- 44 are arbitrary spacing values;
- 343 are arbitrary h/w/size values.

`size-[18px]` appears 11 times, although `size-4.5` was added for exactly that purpose (`tailwind.config.ts:310-320`).

### 0.7 Motion

Durations:

| token | value | uses |
|---|---|---|
| press | 70ms | 12 |
| fast | 120ms | 436 |
| exit | 160ms | 7 |
| base | 220ms | 173 |
| slow | 360ms | 17 |
| emphasis | 560ms | — |
| `duration-[160ms]` (arbitrary) | 160ms | 1 |

Curves: out-soft, out-strong, out-expo, in, in-out, breathe, out-back, spring, drawer. Springs come from `SPRING` in `lib/design/tokens.generated.ts`, with `standard` at 220ms and bounce .05.

Press scales in use: 0.97 (canonical), 0.99, 0.98, 0.985, 0.995, 0.96, 0.95, 0.9 and 1.1. That is **nine values**.

`motion-reduce:transition-none` appears **365** times. It cuts colour feedback, which contradicts the Tier-A rule in `control-recipe.ts:1-5` and `globals.css:1610-1612`.

---

## 1. Recipes

### 1.1 `control-recipe.ts`

`controlMotionClass` (`:6-11`) is `.pressable` plus reduced-motion escapes:
- under reduced motion it keeps colour, bg, border, opacity, box-shadow and filter on 120ms out-soft;
- `active:scale-100`.

`.pressable` (`globals.css:1379-1399`):
- transform 70ms out-soft;
- colour, bg, border, opacity, shadow and filter 120ms out-soft;
- `:active` scale(.97).

Consumers: Button, IconButton, Pressable.

Not consumers: Toggle (`toggle.tsx:18` uses bare `pressable` plus `motion-reduce:transition-none`, so it does not get Tier A), SegmentedControl, Tabs, SurfaceTabs and CustomizeNav. Each restates its own press.

Trap: a `transition-*` utility next to `.pressable` replaces the shorthand and silently removes the press transition. This happens at:
- `hold-button.tsx:156`;
- `agents-home.tsx:472`;
- `app-sidebar.tsx:2019`;
- `product-switch.tsx:275+278` and `:340`;
- `connector-directory.tsx:717`;
- `reasoning-slider.tsx:481`.

### 1.2 `field-recipe.ts`

`fieldSurfaceClass` (`:10-20`):
- border `--field-border` (= `--input`, 54% L);
- fill `--field-surface` (= `--muted` 96.5%);
- no shadow;
- 120ms out-soft on colour, border, shadow and bg.

States:
- hover border fg/.64 (enabled only);
- focus border ring/.72 and fill `--card`;
- **kbd focus**: border `--field-ring` plus `0 0 0 1px` ring (`:15`), which differs from the global 2px outline;
- invalid: destructive border, ring when kbd-focused (`:17-19`);
- disabled: opacity .5, `cursor-not-allowed`.

`fieldFrameClass` (`:22-25`): `rounded-field` 10, 1px border, `text-ui` 13px, and `text-reading` 16px on coarse pointers.

`fieldHeightClass` (`:27`): `h-9` (36), and `h-11` (44) on coarse.

`fieldGroupClass` (`:30-33`) and `fieldChoiceClass` (`:36-41`): open state keeps focus edge and fill.

Consequences:
- A field's fill equals `.surface-raised`'s fill (both `--muted`). A field inside a default Card is the same grey as the card, and only the 54% border separates them.
- Bypassed by the settings search (`settings-rail.tsx:100`), the agents hire field (`agents-home.tsx:346`) and the composer (see §3).

### 1.3 `menu-recipe.ts`

Shell (`:70-73`):
- `surface-float overlay-glass` stacked; both set border/fill/shadow, and the later `.overlay-glass` wins, so the border is border/.7;
- `nest-menu` 14px;
- pop-in/out (spring).

`menuShellClass` adds `nest-p-1.5` (6px), giving rows a radius of 14 − 6 = 8 (concentric, correct).

Row (`:100-109`):
- `min-h-9` **36px**, and `coarse:min-h-11` 44;
- `px-2.5` (10), `py-1.5` (6), `gap-3` (12);
- `rounded-inner` 8, `text-ui` 13;
- svg 16;
- press `active:scale-[0.985]` with transition 120ms out-soft.

The header comment says "One row. 32px" (`:85`) and quotes the reference set at ~32px (`:32`), but the code is 36. The drift table (`:9-12`) quotes `gap-2.5`, but the recipe ships `gap-3`, while ICONS_AND_MOTION §1.2 says `gap-2` beside `text-ui`.

Other parts:
- Glyph ink (`:148-154`): muted, then foreground on highlight, open or hover; 120ms.
- Label (`:161-162`): `text-caption` (deprecated rung).
- Separator (`:176`): `bg-foreground/10`. That is a different ink from `<Separator>` (`bg-border` at 100%), the settings `divide-border/60`, library `fg/0.07` and ed-list `fg/0.08`, so five divider inks in total.
- Width ladder (`:189-190`): `w-56` and `w-72`. It is ignored at:
  - `library-items.tsx:431` (`min-w-48`);
  - `orbit-stage.tsx:162` (`min-w-40`);
  - `popover.tsx:36` (`w-72` only by coincidence).

---

## 2. `src/components/ui` inventory

Values are written as Tailwind → px. "Global focus" means `outline: 2px solid hsl(--ring); outline-offset: 2px` (`globals.css:1225-1228`). It is hidden for pointer modality and widens to 3px under high contrast.

### Button (`button.tsx`)

Base (`:44`):
- `rounded-control` 8, 1px border, `text-ui` 13/500, `gap-2` 8;
- svg defaults to 16 (`.ui-button svg`, `globals.css:1371`);
- disabled: opacity .5 and no pointer events.

Variants (`:48-66`):

| variant | rest | hover | active | notes |
|---|---|---|---|---|
| default | `.control-primary`: graphite fill, border primary/90, **3-layer tinted shadow** (`inset 0 1px 0 white/.16, 0 1px 2px primary/.22, 0 3px 8px -3px primary/.32`) | `brightness(1.06)`, which on 11% L graphite is ~0.7 L points, effectively no hover (in dark, 91% L, it barely moves either) | `brightness(.94)` + scale .97 | — |
| destructive | red fill | brightness 1.06 | brightness .94 | `shadow-none` |
| destructive-outline | `danger-hover`, border-border, red text | border destructive/.32, bg destructive/.09 (dark .38/.14) | — | — |
| outline | transparent, border-border | border fg/20, bg accent | bg selected | — |
| secondary | `.control-neu`: card fill, border-border | bg accent, border fg/.18 | bg selected, border fg/.22, scale .97 | — |
| ghost | transparent | accent | selected | — |
| link | text-primary | underline (offset 4) | muted | — |

Sizes (`:71-87`):

| size | height | coarse | padding | notes |
|---|---|---|---|---|
| default | 36 | 44 | `px-4` 16 | also redundant `py-2` |
| sm | 32 | 40 + hit-44 | 12 | |
| xs | 28 | 40 + hit-44 | 10 | gap 6 |
| lg | 44 | — | 24 | radius **10** and `text-body` 15; the only size that changes radius |
| icon | 36 | 44 | — | |
| icon-sm | 32 | 40 + hit-44 | — | |

States:
- focus is global;
- loading (`:111-148`): the label fades to 0 and a 16px Loader2 fades and scales in from 0.8 over 120ms; the button is disabled but kept at opacity 100;
- there is no selected state.

Screenshot (controls-light/dark): secondary and outline render identically on the 99% page (white vs transparent at 88% border). The primary's drop shadow is visible and is the only shadowed control on the page.

### IconButton (`icon-button.tsx`)

Radius 8.
- Variants (`:32-37`): default (`.control-neu`); ghost (muted ink, accent hover, selected on active or `aria-pressed`); primary (`.control-primary`).
- Sizes (`:40-42`): sm 32, md 36 and lg 44 on desktop. On coarse pointers **all three become 44**. Button `icon-sm` takes the 40 + hit-44 route instead, so two different touch strategies exist.
- Motion: `controlMotionClass`.
- No loading state.

### Pressable (`pressable.tsx`)

**row** (`:79`):
- px 10, py 6, gap 10, radius 8, `text-body` 15/1.6, so about 38px tall;
- hover accent, active selected, no scale; selected holds the selected fill;
- sm (`:144`): `text-caption` 12, ~31px;
- lg (`:145`): ~46px.

**tile** (`:80`):
- `.control-neu`, `rounded-card` 12, p 12, gap 4, `text-ui`;
- sm p 10, lg p 16;
- selected: `border-primary/70`.

**chip** (`:81`):
- `.control-neu`, `rounded-full`, px 10, py 4, `text-caption` 500, muted;
- **md has no fixed height (~26.8px, non-integer)**; sm is `h-6` 24; lg is `h-8` 32 at `text-ui`;
- selected: border primary/70 and foreground text.

**icon** (`:83`):
- **circle**, transparent;
- sm 28 (coarse 36 + hit), md 32 (coarse 40 + hit), lg 36 (coarse 44);
- selected: `bg-selected text-primary`.

The comment at `:71-74` says the row moved to `text-body` to match "the sidebar that opens them". The sidebar is `text-nav` 14 (`app-sidebar.tsx:2273`), so the settings rail is now a rung **above** the sidebar (see settings-light.png vs thread-light.png).

### Input (`input.tsx:17-19`)

- field recipe, `h-9` 36 (coarse 44);
- px 14, py 4;
- file text `text-ui` 500.

### Textarea (`textarea.tsx:15`)

- field recipe;
- `min-h-[60px]`, which is off the 4px grid (an arbitrary value);
- px 14, py 10.

### Field (`field.tsx`)

- Wrapper `space-y-2` (8px) (`:72`).
- Label `text-ui` 13/500 foreground (`label.tsx:19`).
- Trailing slot `right-1.5` with `pr-11` (`:65`, `:91`).
- Error `text-caption` destructive with a 14px icon and `rise-in` 220ms (`:105-107`). Hint `text-caption` muted (`:111`).
- `:64` re-adds the invalid classes that the recipe already carries (dead duplication).

### Select (`select.tsx`)

Trigger (`:25-31`):
- field recipe and `fieldChoiceClass`, px 14, py 8;
- chevron 16 muted, rotating 180° over 120ms in-out (`:39`).

Content (`:65-70`):
- menu shell 14, `min-w-[8rem]`, max height 24rem;
- viewport `nest-p-1.5` (`:83`);
- scroll buttons are opaque popover fill with py 4.

Item (`:101-105`):
- menu row, `pl-8`, `pr-2`, focus bg accent;
- tick 16 `text-primary` at left 8.

### Checkbox (`checkbox.tsx:38`)

- `size-[18px]`, an arbitrary value that `size-4.5` already covers, `rounded-xs` 6.
- Border: the `border-input` utility (54% L) beats `.surface-inset`'s border/.8, so the box is heavier than every other inset.
- Fill: `--background`.
- Hover: border fg/60.
- Checked or indeterminate: primary fill, border primary/80, bold 14px tick or dash.
- Hit area 24 (44 coarse) via `::before`.
- Motion: fill and border 120ms; mark in over 220ms spring from scale .5 and −14°; out over 120ms ease-in (`:48-50`).
- There is no hover state when checked.

### RadioGroup (`radio-group.tsx`)

- Group `grid gap-2`.
- Item (`:34`): an 18px circle, same border and hover as Checkbox. Checked changes only the border to primary/80; the dot is 8px `bg-primary`.
- Motion: in over 220ms spring from .25, out over 120ms ease-in.

### Switch (`switch.tsx`)

- Track 20×36, `rounded-full`, transparent border. Off: `bg-input` (**54% L grey**, much heavier than the iOS/macOS light track). On: `bg-primary`.
- Thumb 16, `bg-card` (dark: foreground; dark-on: primary-foreground), `shadow-raised-lg`.
- Travel 1→17px over 220ms out-strong; fill 220ms out-soft; plus a **10% squash-and-stretch** over 220ms (`useTravelSquash`).
- Hit 24×44. No hover state. Disabled opacity .5.

### Slider (`slider.tsx`, overridden in `chat/live-ui/live-ui.css:198-275`)

What the component declares (`:69-80`):
- 8px `surface-inset` track;
- 16px round thumb with border-border and `shadow-raised-lg`;
- active: scale 1.1, ring-4 primary/20, 120ms.

What actually renders (settings-light/dark.png), because `.glass-slider span[role=slider]` (0,2,1) beats every utility:
- a **38×24 white capsule**, raw `#fff` (dark `hsl(0 0% 96%)`), with a three-layer shadow;
- a 6px fg/.09 track with an inset shadow;
- a **gradient** primary range;
- grabbed: **scale 1.45×1.3** on 360/220ms `ease-out-back`, turning into a translucent "Liquid Glass lens" with specular radial gradients.

Problems:
- The component's own docs (`:7-33`) describe a control that no longer exists.
- A global override of a ui primitive lives in a chat feature stylesheet.
- It contradicts the "opaque, no glass" rule (spec D15, `globals.css:1526-1528`).
- Other stale copy: "coral range" (`:8`) and "thumb is 20px" (`:19`).

### Toggle (`toggle.tsx`)

Base (`:18`): radius 8, 1px border, `text-ui` 500, svg 16, `.pressable`.

Variants:
- default (`:22`): `control-neu` but `border-border/60`, so it is lighter than the secondary Button's `control-neu`; text is muted, then foreground when on;
- ghost (`:23-24`).

Sizes (`:27-29`):

| size | height | coarse | padding | notes |
|---|---|---|---|---|
| default | 36 | 44 | 12 | |
| sm | 32 | 40, **no hit-44** | 8 | redundant `text-ui` |
| lg | 44 | — | — | radius 10 |

`motion-reduce:transition-none` drops all fades.

### Tabs (`tabs.tsx`)

List (`:76`): `.surface-inset` (bg-background, border/.8), p 4, gap 4; md `rounded-menu` 14 (36px tall), sm `rounded-card` 12 (32px).

Trigger (`:122`):
- md h-26 px 12, sm h-22 px 10 (`segmented-control.tsx:77-84`); **26 and 22 are off the 4px grid**;
- radius 9 or 7 via inline `style` (`:112`), so it bypasses the lint;
- `text-ui` 500, gap 6;
- inactive muted, with hover bg accent/60 (opacity-tinted; `tailwind.config.ts:170-174` itself says states told apart by opacity are not told apart).

Thumb (`:141`): `.surface-key` (card fill, `shadow-raised`, border overridden to /60), moved by `layoutId` on `spring.standard`.

Content: fade-in. Note: **no squash** here, unlike SegmentedControl and SurfaceTabs, which `:58-60` claims are "drawn and moved the same way".

### SurfaceTabs (`surface-tabs.tsx`)

- Nav: `border-b border-border` at 100% (`:70`).
- Link (`:88-96`): radius 8, px 12, py 8 (coarse 12), `text-ui` 500; inactive muted with hover bg accent/60.
- Bar: 2px `rounded-full` `bg-primary` spanning the full padded item width (`:109-116`), on `spring.standard` with a 10% squash.

The doctrine at `:13-31` says level-2 view navigation is never boxed. `CustomizeNav` (memory-light.png top) does exactly that (§3).

### SegmentedControl (`segmented-control.tsx`)

- Track (`:171`): `.surface-inset`, p 4, gap 4; md `rounded-menu` 14 (36px), sm `rounded-card` 12 (32px).
- Segment (`:215-219`): `text-ui` 500, gap 6; icon-only segments 32/28 wide.
- Thumb radius 9/7 (concentric: 14 − 1 − 4 and 12 − 1 − 4; correct, but off-ladder values passed inline).
- Hover (`:225`): bg accent/60.
- Thumb (`:246`): `.surface-key` with spring and squash.
- Press (`:217`): scale .97 over 70ms.
- Count (`:268`): `font-mono text-micro` (retired rung).
- Badge (`:278`): 16px primary disc, mono micro.
- `motion-reduce:transition-none` (`:218`, `:253`, `:258`) contradicts the "labels cross-fade" doc at `:27`. The comment at `:234-237` still says `.surface-raised`.

Screenshot: at 36px the 14px track sits beside a 10px Input and an 8px Button. Three corner families in one row (controls-light.png row 1; library-light.png toolbar).

### Badge (`badge.tsx`)

- Base (`:13`): `rounded-full`, 1px border, px 10, py 2, `font-mono text-caption` 12/1.4, 500 → **22.8px tall (non-integer)**; 120ms colour transition.
- Variants (`:17-23`): default (primary), secondary, outline, success, muted, soft.
- **`soft` uses `bg-primary/12`, which Tailwind 3 does not generate** (it is not on the opacity scale; absent from the compiled CSS), so the soft badge renders with **no fill**, only a primary/25 border.
- The comment at `:6` says "11px/0.02em"; it is 12px with no tracking.
- The kbd rung (11px) meant for count badges is unused.
- No sizes, no states.

### Card (`card.tsx`)

- Base (`:27`): `rounded-card` 12; 220ms **ease-out-expo** (controls use 120 out-soft).
- default (`:31`): `.surface-raised`, which is a **grey** `--muted` fill (96.5) with an fg/.06 hairline (almost invisible) and no shadow.
- elevated (`:32`): adds `shadow-raised-lg`.
- flat (`:33`): **white** `bg-card` with `border-border/60`. The docs (`:11-12`) frame flat as "default minus shadow", but default has no shadow; the real difference is fill colour and border alpha.
- interactive (`:34-41`), fine pointer only:
  - hover: border fg/20, bg accent/40, `shadow-raised-lg`, −1px;
  - active: bg selected, `shadow-raised`;
  - focus-within: border fg/25.
- Slots:
  - Header p 20 with `space-y-1.5` 6;
  - Title (`:64`) `font-semibold leading-none tracking-tight`, with **no type rung** (it inherits size);
  - Eyebrow (`:76`) mono `text-label` (the comment at `:70-72` still says 0.10em; the token is .01em);
  - Description `text-body`;
  - Content and Footer p 20 with `pt-0`.

### Avatar (`avatar.tsx`)

- `.surface-key` circle (card fill, border/.8, `shadow-raised`).
- Sizes: xs 24, sm 32, md 40, lg 48, xl 64.
- Fallback (`:53`): bg muted, `font-mono text-caption` 12, uppercase, muted. Initials stay 12px at 64px, so they do not scale with the avatar. No states.

### Kbd (`kbd.tsx:15`)

- h 20, min-w 20, px 6, `rounded-xs` 6;
- `.surface-inset` with `border-border/60`;
- `font-mono text-micro` (12px, retired) 500, muted.

The `text-kbd` 11px rung exists for this and is unused. Settings re-implements keycaps by hand twice (`settings-rail.tsx:118`, `:153`: border/80, px 4, `leading-none`).

### Progress (`progress.tsx`)

- Track: 8px `rounded-full` `.surface-inset`.
- Fill: `rounded-full` tone (primary, success, warning, destructive, fg/60), moved by translateX over 360ms out-soft.
- The comment at `:9` says "raised coral fill"; the fill is graphite and flat.

### UsageMeter (`usage-meter.tsx`)

Full (`:88`):
- `rounded-card`, `border-border/80`, `bg-card`, p 12, **`shadow-soft` (legacy)**;
- label mono caption; upgrade link mono **micro** (`:98`);
- value mono `text-ui` 600; percentage mono caption 600;
- bar (`:127`): **6px `bg-secondary`**, which is a different track from Progress (8px `surface-inset` with border) for the same idea;
- exhausted: border destructive/40, bg destructive/5, mono micro message.

Compact (`:60`):
- `rounded-full`, `border-border/70`, `bg-card/90`, px 10, py 4;
- mono micro text; 48×6 bar.

Motion: translate over 360ms. No hover.

### Skeleton (`skeleton.tsx`)

- `.skeleton`: `--muted` fill with a 1px inset **warm** hairline (`globals.css:3561`).
- Breathes opacity 1→.62 on a 1.8s loop.
- `rounded-control` **8**; the comment at `:5-6` says "(10)" and "slow shimmer", both stale.

### EmptyState (`empty-state.tsx`)

Page size:
- py 64, px 24, open (no box), dot-matrix mark 208×76;
- title `ed-h3`: serif 22/400 (`editorial.css:32-37`), mt 16;
- description `text-body`, mt 8;
- actions mt 24, gap 8.

Panel size:
- `rounded-card`, px 16, py 28;
- `.empty-well`: fg/.022 fill with an inset fg/.045 line (`editorial.css:185-189`), a third tint system;
- mark 128×48;
- title `font-serif text-heading`, which is **serif at weight 600**. No other serif in the product is set above 500.

Error tone:
- `border-border/80 bg-background`;
- icon tile 48 (`rounded-field`) or 36 (`rounded-control`) in `bg-destructive/10`, glyph 24/20.

Motion: `rise-in` (6px over 220ms).

### PageHeader (`page-header.tsx:33-35`)

- Eyebrow: mono `text-label`, mb 12.
- H: `font-serif text-display font-medium tracking-tight`; the −0.025em tracking overrides the rung's −0.02em.
- Lede: `text-body-lg` muted, mt 12.

Compare AppPageHeader (`app-page-header.tsx:163`): `font-serif text-page-title font-normal`, i.e. weight 400 overriding the token's 500. Two h1 treatments.

### Separator (`separator.tsx:23`)

- `bg-border` at 100%, 1px.
- It is the darkest of the five divider inks: menus use fg/10, settings border/60 and library fg/.07.

### ScrollArea (`scroll-area.tsx`)

- Bar 10px with 1px padding.
- Thumb: `rounded-full` `bg-border`, hover muted-fg/50, 120ms.
- Matches the native scrollbar (`globals.css:1312-1320`).

### Collapse (`collapse.tsx`)

- Grid rows 0fr→1fr on `transition.symmetric` (220ms in-out).
- Opacity uses `transition.base` (220ms out-soft); exit opacity 160ms ease-in.
- Reduced motion: rows snap.

### Floating siblings (for the elevation and radius audit)

| component | radius | other values |
|---|---|---|
| Dropdown, Select | 14 | `surface-float` + `overlay-glass` |
| Popover (`popover.tsx:36`) | **12** | p 16 |
| Tooltip (`tooltip.tsx:58`) | **8** | px 10, py 6, `font-sans text-label`; raw `hsl(222 9% 12%)` fill and its own shadow (`globals.css:4828-4830`) |
| Dialog (`dialog.tsx:107`) | 16 | p 20 / sm:p 24; close button at right/top 16 (`:32`), not on the padding |
| Sonner toast (`sonner.tsx:114`) | 12 | `surface-float` |
| Memory toast (`memory-updated-notice.tsx:130`) | **16** | `shadow-glass`, border/70 |
| Cite card (`globals.css:4843`) | 14 | hard-coded |

Floating radii in use: 8, 12, 14 and 16.

---

## 3. Bespoke feature components

### Composer (`ui/composer-shell.tsx`, `globals.css:1885-1910`)

Shell:
- `rounded-composer` **26**; the comments say 22, and `::after` hard-codes 26px at `:1908`;
- `bg-card`, fg/.1 border;
- shadow `0 1px 2px .04, 0 8px 28px -12px .12`, a bespoke elevation between raised-lg and float;
- kbd focus is a 1px ring at ring/.55.

Controls:
- row px 10, pb 10, pt 6, gap 2 (`:141`);
- chips (`:276`): h 32, radius 8, px 10, `font-sans text-label`;
- icon buttons (`:514`): **32px circles**;
- primary (`:676`): a **36px** circle; the comment at `:629` says "The 32px circle".

The `composer-control` (14) and `composer-action` (16) radius tokens exist "for the composer's controls" but those controls are `rounded-full`, so the tokens are effectively unused (6 and 1 uses).

### Chat decision family (`chat/decision.tsx`)

VerbButton (`:41-44`, `:92`): a Button with the default variant, overridden with `bg-foreground`:
- hover `bg-foreground/90` (opacity), active /80;
- the `.control-primary` 3-layer shadow survives under the override;
- unarmed it sits at opacity .5 with the shadow still drawn (the thread screenshot's grey "Continue").

The plain primary Button hovers by `brightness()`, so there are two hover languages for the same filled verb.

QuietButton (`:125`): outline, h 36, **px 14, `font-normal`**, unlike Button outline (px 16, weight 500).

NeedsLead (`:37`): `text-[hsl(var(--attention))]` (arbitrary instead of a `text-attention` class), with a weight flip in dark mode.

### Chat approval card (`chat/approval-card.tsx:1041-1048`)

- `rounded-field` **10** (the comment says "radius 12"), `bg-muted`, no border (one appears under contrast-more).
- px 16, pb 16, **pt 14**, my 20.
- Receipt row: `min-h-11`, radius 10, hover accent (`:1063`).
- Chevron 14, rotating over **220ms** in-out. Select's chevron rotates over 120ms.

### Work run panel / task card (`chat/work-run-panel.tsx`)

- Card (`:180`): `rounded-field`, `bg-muted` (the comment again says 12).
- Plan footer (`:239`): `h-[38px]` arbitrary, `border-t border-border/70`.
- Option rows (`:459`): `min-h-11`, radius 8, **`text-nav`** (the sidebar rung); hover **accent/70**, active **accent**, inverting the system's accent→selected order.
- Bespoke radios (`:464-479`): **16px** with a 1.5px inset ring at muted-fg/.7; selected is a foreground disc with a background dot. They are not `RadioGroupItem` (18px, 1px `--input` border, primary dot). Visible in thread-light.png.

### Work approval card (`work/approvals/approval-card.tsx`, `approval-frame.tsx`)

- Quote bar: `shadow-[inset_2px_0_0_hsl(var(--border))]` (`:149`).
- Disclosure: `rounded-md` (alias), `min-h-8` (`:169`).
- Parameters: `font-mono text-micro` (`:183`, `:310`).
- Frame (`approval-frame.tsx:112`): `rounded-card`, `border-border/60`, `bg-muted/40`. Marker: a 32px ring, 2px border, with a 3px background halo (`:137`).

### Other chat cards (card radius, fill and border all vary)

| component | file:line | radius | fill | border |
|---|---|---|---|---|
| artifact inline | `artifact-inline-card.tsx:516` | 12 | card | border/60 |
| agent change | `agent-change-card.tsx:75` | 12 | card | border (100%) |
| tool-run detail | `tool-run.tsx:164` | 12 | secondary | border/60 |
| image-gen notice | `image-generation-card.tsx:210` | 10 | muted/40 | border/70 |
| routine proposal | `routine-proposal-card.tsx:301` | 10 | muted | none |
| sources panel | `sources-pill.tsx:77` | **14 (menu, in flow)** | card | border/70 |
| answer memory | `answer-memory.tsx:102` | 12 | card/60 | border/60 |
| attachment tile | `attachment-tile.tsx:79` / `:113` | 12 | card / secondary | border/70 |

Pills:
- `sources-pill.tsx:249`: h 28, `bg-foreground/[0.05]`;
- `answer-memory.tsx:64`: `control-neu` pill, h 36;
- `tool-run.tsx:142`: `bg-secondary`, px 8, py 2;
- `memory-updated-notice.tsx:160`: mono micro count.

### Settings

Group card (`setting-row.tsx:25`):
- `border-border/60`, `divide-border/60`;
- **`rounded-panel` 16** (cards are 12);
- px 16, **no fill** (the white-on-99% card in settings-light.png).

Group header:
- `pt-10` between groups, destructive `pt-14` (`:66`);
- title `text-body` 500, description `text-ui`, pb 12.

Row:
- py 16; label `text-body` 500; description `text-ui`, mt 2;
- gap-x 16, or 32 at ≥34rem; control gap 8.

Pane header (`:228`): `font-sans text-title font-medium`, where the comment says "the display serif at the page-title rung". The skeleton (`:243`) is drawn at `text-page-title` (32–44px) and the real header at 22px, so the page jumps on load.

Rail search (`settings-rail.tsx:100`):
- **borderless**, `bg-foreground/[0.045]`, hover /[0.07];
- **radius 8**;
- focus: border-border, background fill, a 1px shadow;
- kbd: ring/.55.

The Input primitive is a 54%-border field at radius 10, so settings-light.png and library-light.png show two different search fields.

Rail rows: Pressable row (15px, ~38px tall) with 16px icons. ICONS_AND_MOTION §1.2 reserves 18px for "sidebar destinations". Group label (`:126`): `text-caption`, pt 20, pb 6.

Mode and chat-font tiles (`sections/general.tsx:370`): selected is `border-foreground` plus `shadow-[0_0_0_1px_hsl(var(--foreground))]`, an effective **2px foreground edge**. No other selected state in the system uses it: Pressable tile uses 1px primary/70. Hover lifts −1px (`:371`). Accent swatches (`:70`) use yet another selection mark, a 2px outline at offset 2.

### Library

Grid tile (`library-items.tsx:468-471`):
- `surface-raised`, radius 12, p 4; preview radius 8 (concentric, correct);
- `duration-[160ms]` written raw;
- hover: border fg/[0.12], −1px, `shadow-raised-lg`; press scale .99.

`EntryRow` (`:729`):
- h 48, radius 8, px 10, `text-caption`;
- hover `bg-foreground/[0.04]`;
- divider `shadow-[0_-1px_0_fg/0.07]`;
- icon tile 32, `bg-fg/[0.04]` with an inset fg/0.06 line.

`LibraryListRow` (`library-browser.tsx:388`), the row in the screenshots:
- `min-h-16` 64, px 8, **no radius** (square full-bleed selection, library-light.png bottom row);
- hover accent, selected `bg-selected`;
- thumb 40, `surface-inset`, radius 8;
- `motion-reduce:transition-none`.

So there are two list rows in one feature, with different heights (48 vs 64), radii (8 vs 0), hover inks (fg/.04 vs accent), dividers (shadow vs border) and thumbs (32 vs 40).

Upload progress (`library-items.tsx:679-680`, `:612-613`):
- 2px track `bg-fg/10`, fill fg/70;
- animates **width**, not transform, contrary to Progress and UsageMeter;
- a third progress look.

Row head (`:706`): h 36, `border-b fg/[0.07]`, `text-caption` 500.

### Agents

Needs-you card (`agents-home.tsx:189-191`):
- radius 12, `border-foreground/[0.08]`, **`bg-card`** (Card default is `bg-muted`);
- py 14, px 16; hover border /[0.14] and accent/40; press .995.

The "Answer" button (`:203`) is a hand-built span (`bg-foreground`, radius 8, px 12, py 6), **not `<Button>`**: no shadow, different padding, no hover tone, only a gap widening.

Crew tile (`orbit-stage.tsx:116`):
- **`rounded-panel` 16**, hover `bg-fg/[0.03]`;
- name `font-serif text-body-lg tracking-[-0.012em]`;
- kebab: radius 8, hover `bg-fg/[0.05]`, menu `min-w-40`.

Hire field (`agents-home.tsx:346`): `rounded-panel` 16, `border-fg/[0.1]`, `bg-background`, p 8, kbd ring/.55. It is composer-like at a different radius from the composer (26).

Example chips (`:472`): hand-rolled `pressable rounded-full border-border bg-card` px 14, py 6, `text-ui`, plus `transition-colors`, which kills the press transition.

### Track/thumb idiom: four implementations

| component | track | height | radius | thumb | motion |
|---|---|---|---|---|---|
| SegmentedControl md / Tabs md | `surface-inset` (bg-background + border/.8) | 36 | 14 | 9, `surface-key` | `spring.standard` (+ squash) |
| SegmentedControl sm / Tabs sm | `surface-inset` | 32 | 12 | 7 | `spring.standard` (+ squash) |
| CustomizeNav (`customize-nav.tsx:56`, `:74`, `:82-85`) | `bg-muted` + inset fg/.07 | **40** | 14 | 10 | **raw spring 520/40**, static `layoutId` |
| ProductSwitch (`product-switch.tsx:231`, `:275`, `:294`) | `bg-sidebar-accent/80`, p 2 | 32 | 10 | 8, bespoke `.product-switch-thumb` shadow | `spring.standard` |

Notes:
- CustomizeNav is boxed level-2 navigation, which contradicts the SurfaceTabs doctrine.
- CustomizeNav carries a stale `eslint-disable` (`:68-71`) claiming the lint table is out of date. The table was fixed (`eslint-rules/design-system.mjs:242-285`), but the lint's own prose at `:31-34` still describes the old ladder ("10px is control, 12px is field, 16 card, 20 panel").

---

## 4. Consistency audit

### 4.1 Radius and concentricity

Correct concentric pairs:
- menu 14 / p 6 / row 8;
- SegmentedControl 14 − 1 − 4 = 9 and 12 − 1 − 4 = 7;
- CustomizeNav 14 − 4 = 10;
- ProductSwitch 10 − 2 = 8;
- library tile 12 − 4 = 8.

Problems:
1. **Equal-height controls do not share a corner.** At 36px: Input/Select 10, Button/Toggle/IconButton 8, segmented track 14, segmented thumb 9, Pressable icon and composer buttons full circle.
2. **Card radius depends on who wrote the card.**
   - 10: chat approval, work-run panel, routine proposal, image-gen notice;
   - 12: Card, artifact, agent change, tool-run, library tile, agents needs-you;
   - 14: sources panel;
   - 16: settings group, crew tile, hire field, memory toast.
   The `card` rung is meant to be one number.
3. **Floating radius**: menu 14, popover 12, tooltip 8, dialog 16, toast 12 and 16. A Popover and a Dropdown opened side by side differ by 2px.
4. **Size changes radius**: Button lg and Toggle lg jump to 10 while their sm/default sizes are 8.
5. **Icon-button shape**: circle (Pressable icon ×68, composer) vs rounded square (IconButton ×57, Button icon/icon-sm ×99) for the same role.
6. **Doc and value drift**:
   - composer 22 vs 26 (5 places);
   - `popover` = 12 in config vs 14 in BRAND_IDENTITY.md:86;
   - Skeleton "(10)" vs 8;
   - approval card and work-run "radius 12" vs 10;
   - `tailwind.config.ts:216` claims tooltips and kbd are `control`, but Kbd is `xs`;
   - `tailwind.config.ts:221` says menu is for "tabs shells", but Tabs sm is `card`;
   - `tailwind.config.ts:226-228` says the composer "takes the panel rung" (16), then sets 26.
7. **Off-ladder radii passed inline**: 9 and 7 (segmented/tabs), 8 (product switch), hard-coded 26/14/12/10 in globals (`:1908`, `2455`, `2701`, `2934`, `3125`, `3318`, `4071`, `4610`, `4843`).
8. **Settings full-bleed rows** vs rounded rows elsewhere: library selection is square while sidebar, settings rail and menus are rounded 8.

### 4.2 Spacing rhythm

- About 25% half-steps, so the effective grid is 2px. There are four card padding rungs (12, 14, 16, 20) plus asymmetric sets:
  - approval `pt-3.5 pb-4`;
  - answer-memory `pt-3 pb-1.5`;
  - memory toast `pl-2 pr-1.5`.
- Off-grid heights: tabs/segment 26 and 22; plan footer 38; textarea min 60; badge 22.8; chip ~26.8.
- Label-to-input gap is 8 (Field) vs 10 (`SettingBlock mb-2.5`). Group gaps are 40 / 56.
- **Row-height ladder**:
  - sidebar 32 @ 14px;
  - menu 36 @ 13px;
  - settings rail ~38 @ 15px;
  - approval options 44 @ 14px;
  - library 48 and 64;
  - setting row py 16.
- **Icon gaps**: Button 8, Pressable row 10, menu row 12, chip 6. The doc (ICONS_AND_MOTION §1.2) says `gap-2` beside `text-ui`.
- **Icon sizes**: size-3.5 (14px) has 529 uses against 675 for size-4. The settings rail uses 16 where §1.2 says 18.

### 4.3 Elevation

- Named rungs duplicate each other: raised ≡ soft, and raised-lg ≈ lift. Legacy `shadow-soft` (30 uses) outnumbers `shadow-raised` (18).
- 61 arbitrary `shadow-[…]` utilities exist; globals.css:1449 calls them "a fork of this system".
- In-flow surfaces carry seven elevations: none, raised, raised-lg, soft, composer, control-primary (tinted) and product-switch-thumb.
- Out-of-flow layers carry four: float, glass (memory toast), tooltip bespoke and glass-slider bespoke.
- The doctrine says only out-of-flow layers get a real throw. Yet the in-flow primary Button carries a 3-layer tinted throw (`globals.css:1590-1593`), while its own comment block (`:1580-1584`) says "no shadow, no glow", and `button.tsx:11` says "no shadow".
- `.surface-key` shadow-raised sits on thumbs while the track is flat. Fine, but Avatar also gets it.

### 4.4 Border weights and inks

- Seven surface-class hairline strengths, plus 6+ call-site alphas, plus about nine arbitrary foreground alphas.
- Field and checkbox borders are 54% L; card hairlines are fg/.06 (about 99→93 L). The two most common edges on a page differ by roughly 40 L points.
- Five divider inks: `bg-border`, fg/10, border/60, fg/.07 and fg/.08.
- 2px borders appear only for settings tile selection and approval markers.

### 4.5 Fill tokens

There are five tints for "quiet surface":
- `--muted` (cards, fields, chat cards);
- `--accent`/`--secondary` (hover, badges, tool chips);
- `bg-card` (agent cards, artifact cards, flat card);
- arbitrary fg/[0.022 … 0.07] (empty-well, library, settings search, crew tile);
- the `/40` and `/60` alpha variants of muted, accent and card.

Hover fills alone take 25+ distinct values: `bg-accent` (177), plus accent/60 (14), /40 (12), /70, /50, `bg-muted`, `bg-secondary/60`, `bg-foreground/5`, `/[0.05]`, `/[0.07]` and `/[.02]`. On-states (`selected`) are applied fairly consistently in primitives, but feature rows invert the order (work-run options: hover accent/70, active accent).

Disabled opacity takes seven values: 50 (32 uses), 40, 60, 70, 35, 55 and 30.

**Broken utilities**, missing from the compiled CSS: `bg-primary/12` (Badge soft), `dark:border-foreground/18` (`composer-clarification-popover.tsx`) and `bg-popover/88` (referenced in a comment).

### 4.6 Type rungs

- The deprecated `caption` (1,176) and retired `micro` (239) remain the de facto small rungs. `kbd` (0) and `home-title` (0) are unused.
- The mono metadata voice covers about 720 sites (`text-label`, mono caption, mono micro); 24 more force `font-sans text-label`. Examples: tooltip, composer chips.
- The parallel raw-px editorial scale includes 11px annotations below the type floor (`editorial.css:58`, `:137`).
- Weight overrides on the same rung:
  - page-title at 400 (AppPageHeader) vs token 500;
  - display at 500 with tracking-tight (PageHeader) vs a 400 / −0.03em hand-roll (`agents-home.tsx:254`);
  - title at 500 (settings pane) vs token 600;
  - heading at 600 serif (EmptyState panel).
- CardTitle has no rung.
- Stale tracking claims in comments: CardEyebrow "0.10em" and Badge "0.02em".

### 4.7 Focus

Four keyboard-focus languages:
1. Global 2px outline, offset 2.
2. Field: 1px edge plus a 1px ring at the field-ring colour, no offset.
3. Composer, agents hire field and settings search: 1px ring at ring/.55. There are seven `kbd-focus` shadow variants: 1px, 2px, inset 2px, field-ring and destructive.
4. Inset `ring-2` (composer marks `composer-shell.tsx:376`, `:401`; hold-button destructive/50 `hold-button.tsx:156`).

Separately, there are 113 `focus-visible:ring*` and 70 `focus-visible:outline*` hand overrides, despite "the global rule is authoritative".

### 4.8 Motion

- Press depth takes nine values.
- Selection thumbs use `spring.standard`, except CustomizeNav (raw 520/40) and `spring.interactive` (raw 320/30/0.8, `lib/motion.ts:127`, not generated).
- Squash-and-stretch (10%) applies to segmented, surface-tab bar and switch, but not to Tabs.
- Chevron rotation runs at 120ms (Select) or 220ms (approval, composer).
- Card hover runs at 220ms out-expo while control hover runs at 120ms out-soft. The library tile uses a raw 160ms.
- 365 `motion-reduce:transition-none` sites remove Tier-A colour feedback.
- The slider overshoots with `ease-out-back` and scale 1.45×1.3, the only overshoot on a control. The motion docs say "a face never overshoots; the one pop in the system is the needs-you ball".

---

## 5. Numbered inconsistency list

1. `tailwind.config.ts:229` sets composer to 26, but `:30`, `:187`, `:192`, `:214`, `:235` and `globals.css:385` say 22. `globals.css:1908` hard-codes 26.
2. `tailwind.config.ts:226-228` says the composer "takes the panel rung" (16), then sets 26.
3. The `composer-action` and `composer-control` tokens are almost unused; the composer controls are `rounded-full` (`composer-shell.tsx:514`, `:676`).
4. `composer-shell.tsx:629` says "The 32px circle"; the code is `size-9` 36 (`:676`).
5. `menu-recipe.ts:85` says the row is 32px; the code is `min-h-9` 36 (`:101`). The drift table says gap-2.5; the code is `gap-3`.
6. `menu-recipe.ts:162` uses `text-caption` (deprecated) for menu labels.
7. `badge.tsx:23`: `bg-primary/12` is never generated, so the soft badge has no fill.
8. `badge.tsx:6`: the "11px/0.02em" comment is wrong (12px, 0).
9. `kbd.tsx:15` and `badge.tsx:13` use micro/caption; the `kbd` rung is unused.
10. `skeleton.tsx:5-6`: "rounded-control (10)" and "shimmer" are stale; the values are 8 and breathe.
11. `card.tsx:31` vs `:33`: default is a grey muted fill and flat is a white card fill. The variant names do not describe that.
12. `card.tsx:64`: CardTitle has no type rung. `card.tsx:70-72` carries a stale 0.10em claim.
13. `card.tsx:27`: 220ms ease-out-expo, while controls use 120ms out-soft.
14. `slider.tsx` is entirely overridden by `chat/live-ui/live-ui.css:204-275` (capsule thumb, gradient, glass, overshoot). The component docs are dead.
15. `progress.tsx:24` (8px `surface-inset`), `usage-meter.tsx:127` (6px `bg-secondary`) and `library-items.tsx:679` (2px fg/10, width-animated) are three progress bars.
16. `checkbox.tsx:38` and `radio-group.tsx:34` use `size-[18px]` where `size-4.5` exists. `border-input` (54% L) overrides the inset hairline.
17. `work-run-panel.tsx:464-479` hand-rolls 16px radios that differ from `RadioGroupItem`.
18. `switch.tsx:52`: the off track is `bg-input` (54% L), a heavy mid-grey.
19. `toggle.tsx:22` (`border-border/60`) vs `.control-neu` (border at 100%) on secondary Button and IconButton.
20. `toggle.tsx:28`: sm lacks `hit-44` (Button and Pressable sm have it). `IconButton` sm and md go to 44 on coarse while Button `icon-sm` goes to 40 + hit.
21. `button.tsx:48` / `globals.css:1586-1608`: the primary carries a 3-layer tinted shadow, contradicting `button.tsx:11` and `globals.css:1580` "no shadow". Its hover `brightness(1.06)` is invisible on graphite.
22. `decision.tsx:41-44`: VerbButton re-skins the primary with opacity hover and keeps the shadow. `decision.tsx:125`: QuietButton is px 14 at weight 400, where Button outline is px 16 at 500.
23. `agents-home.tsx:203`: the "Answer" button is a styled span, not a Button.
24. `button.tsx:63` vs `:61-62`: secondary and outline are visually identical on the page ground (controls screenshot).
25. `segmented-control.tsx:77-84`: segment heights 26 and 22 are off-grid; thumb radii 9 and 7 are passed inline.
26. `segmented-control.tsx:218,253,258` and `tabs.tsx:122`: `motion-reduce:transition-none` contradicts "labels cross-fade" and Tier A.
27. `tabs.tsx` lacks the travel squash that SegmentedControl and SurfaceTabs have (contradicts `tabs.tsx:58-60`).
28. `customize-nav.tsx:56-85`: a boxed tab strip for level-2 navigation (contradicts `surface-tabs.tsx:13-31`), with a 40px track, raw spring 520/40, a static `layoutId`, and a stale `eslint-disable`.
29. `eslint-rules/design-system.mjs:31-34`: the lint's prose still describes the old ladder.
30. `pressable.tsx:71-74`: the row is "like the sidebar" at text-body 15, but the sidebar is text-nav 14 (`app-sidebar.tsx:2273`).
31. `setting-row.tsx:228` (sans text-title) vs its comment ("display serif, page-title rung") vs its skeleton `:243` (text-page-title).
32. `setting-row.tsx:25`: the settings card is `rounded-panel` 16 with no fill. The Card rung is 12 with a muted fill.
33. `settings-rail.tsx:100` is a second search-field design (borderless, radius 8, ring/.55). `:118` and `:153` hand-roll keycaps.
34. `chat/approval-card.tsx:1046` and `work-run-panel.tsx:180` are `rounded-field` 10 while their comments say 12. Neighbouring chat cards are 12; sources is 14.
35. `memory-updated-notice.tsx:130` is a toast at 16 with `shadow-glass`, while Sonner is 12 with `surface-float`.
36. `library-browser.tsx:388` vs `library-items.tsx:729`: two library list rows (64 vs 48 tall, radius 0 vs 8, hover accent vs fg/.04, divider border vs shadow, thumb 40 vs 32).
37. `library-items.tsx:469`: `duration-[160ms]` written raw (equals `--dur-exit`).
38. Raw shadows that bypass the kit:
   - `library-items.tsx:471`, `:504`, `:617`, `:652`, `:655`, `:729`;
   - `customize-nav.tsx:56`;
   - `approval-card.tsx:149` (work);
   - `approval-frame.tsx:137`.
39. `globals.css:690`, `:698`, `:663`: warm-hue hairline, scrim and neu-dark in a cool graphite palette. The skeleton hairline (`:3561`) inherits the warmth.
40. `globals.css:4828`: the tooltip uses raw `hsl(222 9% 12%)` and a private shadow. `tooltip.tsx:58` sets the label rung in sans.
41. Press transitions killed by a `transition-*` next to `.pressable`:
   - `hold-button.tsx:156`;
   - `agents-home.tsx:472`;
   - `app-sidebar.tsx:2019`;
   - `product-switch.tsx:275+278` and `:340`;
   - `connector-directory.tsx:717`;
   - `reasoning-slider.tsx:481`.
42. `hold-button.tsx:156`: a private destructive hover (destructive/35, /[0.07]) vs `.danger-hover` (.32 / .09).
43. `orbit-stage.tsx:162` (`min-w-40`) and `library-items.tsx:431` (`min-w-48`) break the two-rung menu width ladder.
44. `empty-state.tsx:101`: the panel title is serif at weight 600, the only bold serif.
45. `avatar.tsx:53`: fallback initials are fixed at 12px across 24–64px avatars.
46. `dialog.tsx:32`: the close button sits at 16 while content padding is 20 or 24.
47. `field.tsx:64` duplicates the invalid classes already in `field-recipe.ts:17-19`.
48. Dark `--selected` 22.5% equals `--border` 22.0% (`globals.css:821`, `:878`).
49. Light `--accent` = `--secondary` = `--user-bubble` (`globals.css:147`, `:121`, `:84`). A hover wash and a resting tonal fill cannot be told apart.
50. `editorial.css:58`, `:137`: 11px mono annotations under the 12px type floor. The `ed-display` vw clamp contradicts the cqi rule.

---

## 6. What keeps it from feeling Apple / Claude / ChatGPT premium

Ordered by visual impact.

1. **Heavy form edges.** Every Input, Select and Checkbox draws a 1px `--input` border at 54% L around a grey (`--muted`) fill. On library-light.png and controls-light.png the search field is the heaviest object on the page, heavier than the primary button's edge. ChatGPT and Claude use either a light hairline (~85–88% L) on white, or a borderless tinted fill that darkens on focus. Apple uses a light grey fill with no visible stroke. Fix: `--field-border` at about 82–85% L, hover at ~70%, fill `--card`; keep the 3:1 boundary through focus or high-contrast mode, which `prefers-contrast` already handles (`globals.css:1284`).
2. **One row, three corner families.** At 36px, Input 10, Button 8, segmented track 14, thumb 9 and composer circles all sit together. Premium systems give same-height controls one corner: Apple uses capsules or 6–8 for toolbars; ChatGPT uses pills for chips and buttons. Fix: put every 32–36px control (field, select, button, toggle, segmented track) on one radius, either 10 or full, and derive the thumb from it.
3. **Five card materials.** Grey-filled with an invisible hairline (Card), white with border/60 (agents, artifact), grey with no border (chat approval, task), transparent with border/60 at 16 (settings), and fg/.022 wells. Two adjacent cards rarely match. Fix: one in-flow card (white `--card` + border/60 + radius 12) and one recessed well (`--muted`, no border). Retire `/40` and `/60` fill alphas and arbitrary fg tints.
4. **Mono metadata everywhere.** About 720 sites set dates, counts, labels, eyebrows, avatar initials and stat captions in JetBrains Mono, plus 11px mono annotations (memory-light.png: "Memories", "Topics", "About you", the orbit labels). That reads as a dev tool. Claude and ChatGPT keep metadata in the UI sans at 12–13px, with tabular numbers where needed. Fix: confine mono to code, ids and keycaps; move `text-label`, mono caption and mono micro to sans caption.
5. **A skeuomorphic primary in a flat system.** The tinted three-layer drop shadow and inset highlight on the black button (visible in library-light.png's "Upload" and the controls row) is the only lifted control. Its disabled state keeps the shadow at 50% (thread-light.png "Continue" reads muddy grey). Its hover (`brightness 1.06` on 11% L) is invisible. Fix: a flat fill; hover to fg/88 or a defined `--primary-hover` token; disabled as a neutral fill without shadow (the composer already does this, `composer-shell.tsx:636-640`).
6. **Cartoon motion on serious controls.** A 10% squash-and-stretch on segmented thumbs, tab bars and the switch thumb. The slider capsule balloons to 1.45×1.3 with overshoot and a fake glass lens. There are nine press depths. Apple's segmented controls and switches slide on a critically damped spring with no deformation; ChatGPT barely animates chrome. Fix: drop `useTravelSquash` from controls; one press depth (.97 for small controls, none for rows); the slider back to a 20–24px disc with no overshoot; a single spring token everywhere (CustomizeNav's 520/40 and `spring.interactive` included).
7. **No single list rhythm.** Sidebar 32px/14px, settings rail 38px/15px, menus 36px/13px, library 48 and 64px rows, approval options 44px/14px. Selection is rounded in some lists and square full-bleed in the library. Claude's sidebar and menus share one row rhythm (~32–36px, 14px, radius 8) and one selection shape. Fix: a row ladder of compact 32, default 36 and two-line 56, all radius 8, inset selection everywhere.
8. **Too many hairline and tint strengths.** Seven surface hairline alphas, five divider inks, 25+ hover fills, seven disabled opacities, and a dark mode where the selected fill equals the border. The cumulative effect is "assembled": edges and fills that should match are visibly a step apart. Fix: three hairlines (subtle, default, strong) and two hover fills (wash, on); ban arbitrary `fg/[0.0x]`.
9. **Four focus treatments.** A 2px offset outline, a 1px field ring, a 1px ring at 55% and inset `ring-2`, plus 183 manual overrides. Apple and Chrome-quality web apps use one focus ring. Fix: one 2px ring at offset 2 (fields included), and remove the overrides.
10. **Hue drift.** Warm hairline, scrim and skeleton outline (hue 45–48°) against a cool graphite UI (216–225°) and a bluish page (240°). It is subtle, but it makes neutrals look slightly dirty next to each other. Fix: rebase `--hairline`, `--scrim` and `--neu-dark` on `--shadow-ink`.
11. **Type scale sprawl.** Fifteen Tailwind rungs plus a parallel raw-px editorial scale, with the deprecated `caption` as the most-used size and four weights applied to the same serif headings. Claude and ChatGPT run about 6 sizes in-product. Fix: collapse to roughly 12 / 13 / 14 / 15–16 / 18 / 22 / 32+, and pick one serif weight (400) and one sans heading weight (600).
12. **Spacing on a 2px grid.** About 25% half-steps, card paddings of 12/14/16/20, and off-grid heights (22, 26, 38, 22.8, 26.8). Fix: snap padding to 4/8 (12/16/20), heights to 4 (24/28/32/36/44), and fix chip and badge heights.
13. **Broken or stale system parts erode trust.** Badge `soft` renders with no fill. Slider docs describe a different control. Comments disagree with values in a dozen places (composer 22/26, skeleton 10/8, approval 12/10, menu 32/36, "coral" fills that are graphite). Each is small, but together they show the system is no longer the source of truth.
14. **Bespoke chrome inside primitives' territory.** Hand-rolled buttons (agents "Answer"), radios (work-run), keycaps (settings), search fields (settings), progress bars (library) and toasts (memory) each drift a little from the primitive beside them. Fix: route all of these through the ui primitives.

---

## 7. Screenshot cross-check (what is visible)

| screenshot | what it shows |
|---|---|
| controls-light/dark | Field (dark 54% border, radius 10), segmented track (radius 14, light border), "New design" button (radius 8) at equal height. Secondary ≈ outline. The primary has a visible drop shadow. Dark-mode primary is a near-white key with shadow. |
| library-light/dark | Same toolbar mismatch, plus the Select "Newest first" with the dark field border. A square full-bleed selected row. 2px progress hairlines in rows (third progress style). 40px mono "PDF/MOV/TS" tiles. Checkbox borders noticeably darker than row dividers. |
| settings-light/dark | Capsule slider thumb (glass override). Mode/font tiles with a 2px foreground selection edge. Rail rows at 15px vs a 14px sidebar. A borderless grey search at radius 8 (vs Input's bordered 10). Settings card at 16 with no fill. |
| memory-light/dark | Boxed CustomizeNav (40px, muted track) as page tabs. Pill chips with a darker selected border. Pervasive small mono labels. |
| thread-light/dark | Task card in muted with no border at radius 10. Hand-rolled 16px radios. A greyed shadowed "Continue". A pill-shaped memory chip. Sidebar section heads ("Orbit", "Recent") are in the mono label voice (`sidebar-section.tsx:84`, `text-label`) over 14px sans rows. |
| composer-landing | Composer at 26 with circle controls, tray under it, pill starters. Coherent and the strongest surface; corner families still differ from the toolbar controls elsewhere. |
| run-light | Build error; the approval card could not be checked visually. |
