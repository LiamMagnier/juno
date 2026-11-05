# Map: menus, submenus, pop-ups, selects, palettes, tooltips

Read-only audit of `/home/user/juno` (Next.js + Tailwind 3 + Radix). No source was modified.
Paths are relative to the repo root. Line numbers are as of this read.

**About the screenshots.** The PNGs in `scratchpad/shots/` show only closed triggers: the model chip,
the composer row and tray, the answer action bar, the settings rows and the library sort. No menu is open
in any of them. So every value below comes from the code. Colour pairs were computed from the HSL tokens
in `src/app/globals.css`.

---

## 0. The short version

The product does not have one menu system. It has **six that ship**, plus three tooltip materials:

| # | System | Where it lives | Used by |
|---|---|---|---|
| S1 | **Menu recipe**: Radix DropdownMenu / Select on `menu-recipe.ts` | `src/components/ui/menu-recipe.ts`, `dropdown-menu.tsx`, `select.tsx` | ~50 kebab/row/header menus, every Settings Select, ChoiceMenu, the landing phone nav |
| S2 | **`.cmenu`**: the composer menu recipe | `src/components/chat/composer.css:794-1098`, `composer-menu.tsx` | the chat `+` menu and its flyouts, the tray menus (Project/Apps/Skills), the task-mode chip, the media-param menus and popovers |
| S3 | **`.composer-layer`**: the slash and `@` palettes | `composer.css:126-348`, `composer.tsx:397-490`, `context-composer-layers.tsx` | `/` commands, `@` mentions, the token popover |
| S4 | **Popover + hand-rolled list**: Radix Popover with a custom listbox inside | `ui/popover.tsx` and each call site | the model catalogue, the effort panel, the Settings model picker, the Compare model picker, the Code target and checkout pickers, the voice settings, notifications, the Work `+` panel, the report TOC, Code checks, the right-column overflow |
| S5 | **Command palette**: Radix Dialog + framer highlight | `src/components/app/command-palette.tsx` | ⌘K search |
| S6 | **Code v2**: non-Radix `ComposerPopover` + `MenuList` | `src/components/code/v2/primitives.tsx:107-330`, `code-v2.css:393-423` | every menu and picker in the shipped `/code/[id]` route |
| T | **Tooltips**: `.ui-tooltip` ink label, `.cite-card` hover card, `.pf-tip` (popover material), native `title=` | `ui/tooltip.tsx`, `globals.css:4822-4849` | 94 files, 183 `TooltipContent` uses |

The two menus people open most are the chat composer `+` (S2) and a sidebar row kebab (S1). They are
built differently and look different:

- **corner radius:** 18 / 12 against 14 / 8
- **type size:** 14px against 13px
- **gap:** 10 against 12
- **highlight:** a gliding pill against an instant fill
- **shadow and animation:** each has its own

`menu-recipe.ts` says these two "are one object now". That claim is false: `.cmenu.cmenu` overrides the
recipe at higher specificity (§6.1).

---

## 1. Primitive specs (exact computed values)

### 1.1 S1: the menu recipe (`src/components/ui/menu-recipe.ts`)

**Shell.** Source: `menuShellFrameClass` (l.70-73) plus `menuShellClass` (l.82), wrapped in `dropdown-menu.tsx:35-39`.

| Property | Value | Source |
|---|---|---|
| Material | `surface-float overlay-glass`. Both are components-layer classes. `.overlay-glass` (globals.css:2230) is declared after `.surface-float` (:1529), so its values win. | |
| Fill | `hsl(var(--popover))`: light #FFFFFF, dark #27282B | |
| Border | `1px solid hsl(var(--border) / .7)`: light about #DFE0E2 at 70%, dark #36373A at 70% | |
| Shadow | `--shadow-float`. Light: `0 0 0 1px ink/.03, 0 4px 12px -2px ink/.06, 0 24px 56px -16px ink/.22`. Dark: `0 0 0 1px warm-white/.05, 0 4px 12px #000/.35, 0 18px 44px -12px #000/.6`. | globals.css:676 / :937 |
| Radius | **14px** (`nest-menu`, a plugin utility; it also publishes `--r-outer:14px`) | |
| Padding | **6px** (`nest-p-1.5`; publishes `--pad:6px`) | |
| Width | `min-w-[11rem]` (176px) when the call site sets no width. Two rungs are documented: `MENU_W` = `w-56` (224px) and `MENU_W_WIDE` = `w-72` (288px) (l.189-190). | |
| Max-height | `min(24rem, var(--radix-dropdown-menu-content-available-height, 24rem))`, with `overflow-y-auto overscroll-contain` | dropdown-menu.tsx:38 |
| Max-width | `calc(100vw - 1rem)` | |
| z-index | `z-popper` = 55 | |
| Offsets | `sideOffset=4`, `collisionPadding=8`. SubContent has **no `sideOffset`** (Radix default 0) and `alignOffset` 0. | dropdown-menu.tsx:61, :101 |
| Enter | `animate-pop-in`: 220ms (`--dur-base`), `--ease-spring` = `cubic-bezier(.22,1,.36,1)`, from opacity 0 at `scale(.96)` with a 4px drift toward the trigger (`origin-popper`, globals.css:3586-3590). Side menus get 0px drift. The curve never overshoots, so the "~2% overrun" in tailwind.config.ts:937 does not happen. | |
| Exit | `animate-pop-out`: 120ms (`--dur-fast`), `ease-in`, back to `.96` | |
| Scroll affordance | none (a bare `overflow-y-auto`) | |

**Row.** Source: `menuRowClass` (l.100-109).

| Property | Value |
|---|---|
| Height | `min-h-9` = **36px**; `coarse:min-h-11` = 44px. The header comment (l.32, l.85) says "32px". |
| Padding | `px-2.5 py-1.5` = 10px / 6px |
| Gap | `gap-3` = **12px**. The header table (l.9) says `gap-2.5`, and user-menu.tsx:35 also says gap-2.5. |
| Radius | `rounded-inner` = 14 − 6 = **8px** |
| Type | `text-ui` = **13px / 1.5** (19.5px line), inherited ink |
| Glyph | 16px (`[&_svg:not([class*='size-'])]:size-4`), muted (`menuGlyphInkClass`, l.148-154). It turns `foreground` on `data-highlighted` or `data-state=open`, with a colour cross-fade at 120ms. |
| Press | `active:scale-[0.985]`, transitioning background, colour and transform over 120ms `ease-out-soft` |
| Hover / focus | Set at the call site: `focus:bg-accent focus:text-accent-foreground`. Light #EFF0F1 on #FFFFFF is **1.14:1**. Dark #2D2E31 on #27282B is **1.09:1**. |
| Open sub-trigger | `data-[state=open]:bg-accent` |
| Disabled | `opacity-50 pointer-events-none` |
| Destructive | `variant="destructive"` → `danger-hover text-destructive-ink`. Red ink at rest; when highlighted, `bg destructive/.09` (dark `.14`) and a red glyph (globals.css:1422-1443). |
| Focus-visible | Nothing separate. The highlight fill is the keyboard signal and the row has `outline-none`. |

**Group label** (`menuLabelClass`, l.161-162): `px-2.5 pb-1 pt-1.5 text-caption font-medium text-muted-foreground`.
That is 12px/1.4 sans at weight 500. `caption` is a **deprecated** rung (tailwind.config.ts:10, :557-564).

**Separator** (`menuSeparatorClass`, l.176): `-mx-1.5 my-1 h-px bg-foreground/10`. It runs edge to edge, with 4px above and below.

**Sub-trigger** (dropdown-menu.tsx:77-93): a row, plus a 14px chevron (`size-3.5`, muted, `ml-auto`).

**Checkbox and radio items** (dropdown-menu.tsx:146-190):
- **Gutter:** the label is pushed to `pl-8` (32px) with `pr-2` (8px). The indicator sits in a 16px box at `left-2`.
- **Checkbox mark:** a 16px `StatusIcons.success` tick in `text-primary` (the account accent).
- **Radio mark:** a 6px disc in the label's own ink, with no accent.
- **Indicator motion:** both cross-fade (opacity, plus scale from .6) over 120ms; `forceMount` keeps them in the DOM.

**Keyboard (Radix):** ↑ and ↓ move between rows, with `loop` defaulting to **false**, so they stop at the ends. Home and End jump to the ends. Typeahead works. Enter and Space activate. → opens a submenu and ← closes it. Esc closes. Radix grace polygons cover the diagonal move into a submenu.

### 1.2 S1b: Select (`src/components/ui/select.tsx`)

- **Trigger** (l.19-41): the field recipe, i.e. `rounded-field` (10px), `h-9` (`coarse:h-11`), `px-3.5`, `text-ui`, plus a 16px chevron that rotates 180° over 120ms `ease-in-out`.
  - On open, the border becomes `field-focus` and the fill `field-active`.
- **Content** (l.58-92): the same frame as S1 (14px corners, float material), but `min-w-[8rem]` (128px) rather than 11rem.
  - Height cap: `min(24rem, available)`.
  - The 6px inset moves to the Viewport (`nest-p-1.5`).
  - Scroll buttons are opaque `bg-popover`, `py-1`, with 16px muted chevrons. This is the only menu in the product with Apple-style scroll arrows.
- **Item** (l.95-118): `menuRowClass` with `pl-8 pr-2`.
  - The mark is a 16px `text-primary` tick on the left.
  - The indicator has **no** `forceMount`, so it appears and disappears in one frame, unlike DropdownMenu.
- **Not exported:** `SelectLabel`, `SelectSeparator`, `SelectGroup` label styling.

### 1.3 S1c: Popover (`src/components/ui/popover.tsx:25-42`)

- **Material:** the same float material, but at `rounded-popover` = **12px** (the documented "card" rung).
- **Size and spacing:**

  | Width | Height cap | Padding | Offsets |
  |---|---|---|---|
  | `w-72` (288px) | `var(--radix-popover-content-available-height)` | `p-4` (16px) | `sideOffset` 4, `collisionPadding` 8 |

- **Motion:** `pop-in` / `pop-out`, the same as menus.
- **Call-site overrides:** widths, padding and radius are all overridden at call sites (§3.4).

### 1.4 S2: `.cmenu` (`src/components/chat/composer.css:794-1098`, `composer-menu.tsx`)

These rules use doubled selectors (`.cmenu.cmenu`, 0,2,0) so they **beat** the S1 shell and row they sit on.

**Shell** (l.799-823):

| Property | Value |
|---|---|
| Radius | **18px** (`--cm-radius`) |
| Padding | **6px** |
| Border | `1px hsl(var(--foreground)/.07)`; dark `#fff/.08` |
| Fill | `hsl(var(--popover))` |
| Shadow | its own three layers. Light: `0 1px 2px ink/.04, 0 8px 20px -6px ink/.08, 0 28px 56px -18px ink/.16`. Dark: `inset 0 1px 0 #fff/.04, 0 8px 20px -6px #000/.4, 0 28px 56px -18px #000/.55`. |

**Motion** (l.830-861):

| Phase | What happens |
|---|---|
| Enter | `cmenu-in`, 220ms on `cubic-bezier(.16,1,.3,1)` (expo-out), from `scale(.96)` with **6px** of travel toward the trigger. Opacity reaches 1 at 45% of the run. |
| Contents | Every child **then** plays `cmenu-fill` for 220ms after a 70ms delay, rising 3px from opacity 0. Total time to settle is **~290ms**. |
| Exit | `cmenu-out`, 120ms `ease-in`, to `.97` with no travel |

**Row** (l.869-901):

| Property | Value |
|---|---|
| Height | `min-height: 36px` |
| Padding | `0 10px` (vertical padding is zeroed) |
| Gap | **10px** |
| Radius | **12px** (18 − 6) |
| Type | **14px / 20px**, `foreground` |
| Transition | `color` only, which drops the recipe's transform transition, so the 0.985 press snaps |
| Highlight | Not a fill. The row background is cleared and the **`MenuGlide` pill** (l.903-926) slides behind it, moving its transform, width and height over 220ms on the expo curve, with a 120ms opacity fade. |
| Glide fill | `foreground/.06`, which is #F1F1F1 on white (1.13:1). Dark: `#fff/.075`, which is #37383B on #27282B (**1.26:1**). |

**Other parts:**
- **Separator** (l.892): `margin: 6px 10px` (inset), `foreground/.07`, 1px.
- **Label** (`.cmenu-label`, l.968): `6px 10px 4px` padding, 12px/16px, weight 500, muted.
- **Search row** (l.977): 36px tall, 16px glyph, 14px input, a hairline under it at `foreground/.07`.
- **Empty state** (l.1001): a 28px tile in `foreground/.05` with a radius of 8px, a 14px title and a **12.5px** hint. 12.5px is a half-pixel size the type-scale comments say they removed.
- **Skeleton:** 36px rows.
- **Scroll edges** (l.939-966): 28px popover-to-transparent gradients, shown only when there is more above or below.
- **Toggle row** (`composer-plus-menu.tsx:234-250`): a custom **28×16** switch with a `bg-foreground` track and a 12px thumb.
- **Radio row** (l.271-282): a **14px** `text-primary` tick on the **right**.
- **Detail and shortcut text** (l.219-228): `font-mono text-label` (12px), `tracking-[0.02em]`, tabular figures, muted, hidden under a coarse pointer.
- **Flyout** (l.495-505): `sideOffset 6`, `alignOffset -7`, `collisionPadding 16`. Its first row lines up with the row that opened it. Only this menu does that.
- **Keyboard-open state:** the comment at l.306 says a menu opened from the keyboard "appears in the same frame (F0)". `data-opened-by` is set on the content (l.382), but **no product CSS reads it**. The only rule is in `src/app/dev/design/juno/tokens.css:968`, so the claim is not true in the product.
- **Destructive:** composer.css l.886-888 colours `.text-destructive` rows with the **fill** token `--destructive`, not the ink token. `MenuGlide` turns red only for `.text-destructive`, but `variant="destructive"` adds `text-destructive-ink`. No composer menu has a destructive row today, so this is latent.

### 1.5 S3: `.composer-layer` (`composer.css:126-348`), the slash and `@` palettes

These do not use Radix. They are portalled to `<body>` at a fixed position computed by `placeComposerLayer`.

| Part | Values |
|---|---|
| Shell (l.129) | `surface-float`, **14px** radius, 6px padding, `z-index: var(--z-popper, 50)` |
| Row (l.157) | **34px** tall, `0 10px` padding, gap 10, **8px** radius, **14px/20px** |
| Hover | `foreground/.045`, fine pointer only |
| Selected (cursor) row (l.177) | `foreground/.06` (dark `#fff/.068`), with **no transition** |
| Icon slot | 20px holding a 16px mark |
| Group label (l.150) | `7px 10px 3px` padding, 12px/16px, weight 500 |
| Detail | 12px muted |
| Footer (l.225) | `9px 14px 10px` padding, `border-top: 1px hsl(var(--border))`, 12px; holds **keycaps** |
| Keycaps (l.241) | 20px tall, 5px radius, 1px border, **11px**. That is below the 12px type floor. |
| Coarse pointer | rows grow to 44px and the footer is hidden |
| Motion | none: it appears and disappears in the same frame |
| Token popover `--popover` (l.268) | `14px 16px 12px` padding; footer verbs are 28px tall, 8px radius, 13px |

### 1.6 S5: Command palette (`src/components/app/command-palette.tsx`)

| Part | Values |
|---|---|
| Shell (l.279) | `DialogContent`: `overlay-glass`, `rounded-panel` = **16px**, `border-foreground/10` (the utility overrides `/.7`), `bg-popover`, `max-w-[640px]`, `top-[9svh]` |
| Enter | `pop-in` at 220ms on **`ease-out-expo`**, from `.97` with a −6px shift |
| Backdrop | a scrim behind it |
| Search row (l.294) | 56px tall, 20px glyph, **17px** input (`text-body-lg`) |
| Group header (l.428) | `text-caption font-medium`, `px-2 pb-1.5`, and `pt-5` (20px) before every group after the first |
| Row (l.477) | **36px** (`h-9`), **px-2** (8px), gap 10, **15px** type (`text-body`), 18px glyph in a 20px slot, radius 8 |
| Highlight (l.509-515) | a framer `layoutId` pill, spring with stiffness 520, damping 40, mass .7. Fill `foreground/.06` (dark `#fff/.07`) **plus** an inset 1px ring at `foreground/.05`. |
| Rows arriving | each row fades in on a stagger |
| Meta | `font-mono text-caption tabular-nums` |
| Shortcut hints (l.556-560) | `<Kbd>` keycaps: `surface-inset`, 20px, `rounded-xs` (6px), `font-mono text-micro` |
| Filters | Radix **Select** ×2 with custom 28px pill triggers (`filterSelectClass`, l.694) |
| Keyboard (l.226-241) | ↑ and ↓ clamp (no wrap). **No Home/End.** Enter runs the row. |

### 1.7 S6: Code v2 (`src/components/code/v2/primitives.tsx`, `code-v2.css`)

This system ships at `src/app/(app)/code/[id]/client.tsx`.

**Shell** (`ComposerPopover`, l.107-170, with `.cv2-pop` at code-v2.css:393):

| Property | Value |
|---|---|
| Portal | not portalled: `position:absolute` in the anchor's parent |
| z-index | **40**, below `--z-popper` 55 |
| Radius | **12px** |
| Shadow | `--cv2-shadow-pop`, four layers. In **dark** it is `none` (l.54): only a 1px `#fff/.08` edge and no depth. |
| Max-height | `min(480px, 100dvh − 120px)` |
| Width | set per call in px: 220, 240, 260, 280, 300, 380, 460 |
| Collision handling | none. It is fixed above the anchor (`bottom: calc(100% + 8px)`) or below it with `.down`. |
| Enter | `cv2-pop-in`, 160ms (local `--dur-mid`), a **2px translate and no scale** |
| Exit | about 104ms |
| Phone (≤760px) | becomes a bottom sheet with an 18px top radius, a scrim and a grabber |

**`MenuList`** (l.243-330, `.cv2-mi` at code-v2.css:414):

| Part | Values |
|---|---|
| Row | `min-height 32px`, padding `0 8px`, margin `0 6px`, gap 10, radius 8, **14px** (inherits `.cv2` font-size 14) |
| Hover / active | `bg-accent` over 70ms (`--dur-press`) |
| Two-line row | `.two`, with a 12px second line |
| Trailing text | 12px tabular, plus a 14px chevron for a submenu |
| Section label | 26px tall, `0 14px 4px` padding, 12px, **not bold** |
| Separator | full bleed, `margin 6px 0`, `border/.8` |
| Selected mark | `.ck` 16px tick in **foreground** |
| Danger | `hsl(var(--destructive))`, the fill token |
| Submenus | **drill in** (the pane is replaced by a back row), not fly out |
| Keyboard | ↑ and ↓ wrap; Enter or → opens; ← or Backspace goes back. **No typeahead, no Home/End, no Esc handler in the list** (`useDismiss` handles outside clicks). Focus is not moved into the list on open. |

### 1.8 T: Tooltips (`src/components/ui/tooltip.tsx`, `globals.css:4822-4849`)

**`.ui-tooltip`**: an ink label.

| Property | Value |
|---|---|
| Fill | light `hsl(222 9% 12%)` = #1C1D21; dark `hsl(225 6% 22%)` = #35363B |
| Text | `#FAFAFA`, `text-label` in sans, i.e. **12px/1.4 weight 500**, tracking .01em |
| Radius | `rounded-control` **8px** |
| Padding | `px-2.5 py-1.5` |
| Shadow | its own: `0 4px 14px -4px #000/.35, 0 0 0 .5px #fff/.06` |
| Offsets | `sideOffset 6`, `collisionPadding 8` |
| Max width | **none** beyond the viewport, so each call site picks its own: `max-w-xs`, `-60`, `-64`, `[20rem]` |
| Timing | delay **200ms**, skip window 400ms (`tokens.generated.ts:62-63`) |
| Enter | `tooltip-in`: 120ms, scale .97 plus 2px drift. `instant-open` has no entrance. |

`.ui-tooltip` re-points `--foreground`, `--muted-foreground`, `--icon-muted` and `--border`. Two problems follow:
- `--border` gets **an alpha baked in** (`0 0% 100% / 0.14`), so every `hsl(var(--border) / x)` inside a tooltip is invalid CSS.
- `--background` is **not** re-pointed (§6.12).

**`.cite-card`** (globals.css:4837): the popover material at a **14px** radius. Used by `source-chip.tsx:311` (w-20rem, p-0).

**`.pf-tip`** (`profile/activity-chart.tsx:225`): `surface-float rounded-control px-2.5 py-1.5`. A *light* popover-material tooltip, unlike the ink one.

**Native `title=` tooltips** on menu triggers:
- `project-chat-list.tsx:242` (`title="More"`)
- `project-folders.tsx:715` (`title="More"`, `rounded-full`)
- `project-workspace-header.tsx:210`
- `code-work-list.tsx:231` (`title="Options"`)
- every `cv2-*` button in Code v2

---

## 2. The composer `+` menu and the model picker (what the owner opens most)

### 2.1 Chat `+` (`src/components/chat/composer-plus-menu.tsx`)

- **Trigger:** `Button ghost icon-sm` with `composerIconButtonClass`: 32px, `rounded-full`, a 20px `+` glyph. It rotates 45° over 220ms `ease-in-out` (composer.css:350-365).
- **Content (l.369-402):** `side=top`, `align=start`, `sideOffset 8`, `collisionPadding 12`.
  - Classes: `MENU_W_WIDE` (288px), `cmenu`, `cmenu-scroll`, max-height `min(32rem, available)`.
  - So it is S2 sitting on S1, and **S2 wins**: 18px shell, 12px rows, 14px type.
- **Rows:** `PlusMenuRow` (l.153-286) is a `DropdownMenuItem` with an explicit `role` of `menuitemcheckbox` or `menuitemradio`. The trailing control is one of three:

  | Row kind | Trailing control |
  |---|---|
  | Toggle | a custom switch (28×16) |
  | Radio | a 14px tick, cross-faded |
  | Action | a mono `detail` |

- **Separators:** `PlusMenuSeparator` (`mx-2.5 my-1.5 bg-foreground/[0.08]`), which `.cmenu` then overrides to `6px 10px` and `/.07`.
- **Submenus:** Radix flyouts at 288px. At phone width they become drill-in panels (`animate-stage-in` with 12px travel) behind a Back row.
- **Keyboard:** Radix, plus → to drill in, ← and Esc to step back.

### 2.2 Code `+` (`src/components/code/code-composer-parts.tsx:107`)

- **Shell and rows:** plain S1 at `MENU_W` (224px): a 14px shell and 13px rows.
- **Contents:**
  - a **mono** label, "Add" (`font-mono text-label`);
  - a submenu "Attach" holding Photos, Files and From your library.
- **Trigger:** a 16px `+` that rotates 45° over 220ms on **`ease-out-strong`**.

### 2.3 Work `+` (`src/components/work/composer/work-thread-composer.tsx:499`)

- **Shell:** `PopoverContent`, `w-80` (320px), **12px** radius, `p-0`.
- **Contents:** `WorkThreadAddPanel` (`work-thread-add-panel.tsx`), a form-like panel rather than a menu:
  - mono eyebrows (`font-mono text-label`): Project, Files, Apps;
  - outline buttons;
  - real `<Switch>` components (32×20);
  - prose.
- **Trigger:** rotates 45° over 220ms on `ease-in-out`.

**So the product has three `+` menus.** They use three primitives, three radii (18, 14, 12), three widths (288, 224, 320), two type sizes and three easing curves for the same 45° turn.

### 2.4 The model picker: five different ones

| Picker | File:line | Primitive | Shell | Row | Selected mark | Keyboard |
|---|---|---|---|---|---|---|
| Composer **effort panel** (first click for thinking models) | `chat/model-selector.tsx:628` | Popover | `rounded-menu` **14**, `p-3`, `w-[min(18.5rem,100vw−1.5rem)]` = 296px | slider plus switches (`reasoning-slider.tsx:427+`) | n/a | arrows on the slider |
| Composer **catalogue** | `chat/model-catalogue.tsx:1138-1194` | Popover | `rounded-menu` **14**, `p-0`, 640×500 (`min(640px,100vw−2rem)` × `min(500px,available)`). Three panes: a 48px rail on `bg-muted/40`, the list, and a 272px detail pane on `bg-muted/40` with `border-border/60` dividers. | `min-h-9` (36), `px-2.5`, gap 10, radius 8, 13px, 18px lab logo (l.992-1035) | 16px tick in **`text-foreground`** on the right, plus `font-medium` | custom: ↑↓ **wrap**, Home/End, Enter |
| Catalogue failure card | `model-selector.tsx:146` | Popover | `rounded-menu`, `p-4`, 296px | text plus buttons | n/a | n/a |
| Regenerate → "Switch model" | `chat/message-item.tsx:428` | S1 SubContent | 224px, `max-h-[min(24rem,60vh)]` | recipe row (13px) | 14px tick in `text-primary` on the right | Radix |
| Settings **ModelPicker** | `settings/model-picker.tsx:177-293` | Popover + combobox | `rounded-menu` 14, `p-0`, `w-80`; search 40px; `border-border/70` | **`min-h-8` (32)**, `px-2.5 py-1.5`, gap 10, 13px | 16px tick in `text-primary`; multi mode uses a filled **star** | custom: ↑↓ wrap, Home/End, Enter |
| Compare picker | `compare/compare-model-picker.tsx:88-138` | Popover | default **12px**, `p-0`, `w-80`; list `max-h-72` (18rem) at `p-1`; search is an `Input` at `h-8 rounded-control` | `Pressable kind=row`: 15px base and a 13px-medium label, about 34px | **filled row** (`bg-selected`) plus a 14px tick; locked shows the plan name in **`text-primary`** | **none**: Tab through buttons |
| Code v2 picker | `code/v2/pickers.tsx:356` | S6 | 12px radius, 380px | `.cv2-mi` 32px, 14px | `.ck` in foreground | S6 |

Every one of these differs from the others in radius, row height, type, tick colour or keyboard model.

---

## 3. Full inventory

Key: **W** width · **MH** max-height · **Lbl** group-label style · **Sel** selected marker · **Kbd** shortcut display.
Unless noted, a row is the S1 recipe row (36px, 13px, gap 12, radius 8, 16px muted glyph).

### 3.1 S1 dropdown menus (Radix `DropdownMenuContent`)

| Surface | File:line | W | MH | Notes: labels, rows, states |
|---|---|---|---|---|
| Sidebar chat-row kebab | `app/app-sidebar.tsx:3120` | 224 | 24rem | **Trigger:** `KEBAB_CLASS` (l.455), 28px, `rounded-control`, a 14px glyph, opened with `aria-expanded:bg-foreground/5`. **Opening:** Shift+F10 / Menu key opens it from the row (`useRowMenu`, l.475). **Contents:** one separator before Delete; Delete is destructive. |
| ↳ "Add to project" sub | `app-sidebar.tsx:3140` | 224 | 24rem | Selected = the **leading glyph is replaced** by a 16px `text-primary` tick. "No project" uses an empty `size-4` span as a spacer. The sub sits flush at 0px and its rows are 7px lower than the trigger row. |
| ↳ CrossMessages toggle | `chat/cross-messages-menu-item.tsx:26-42` | (in 224) | | The label "Messages from other conversations" **wraps** at 224px. Its on state is a plain `Check` drawn **muted** by the glyph-ink rule. It is `role=menuitem` with no `aria-checked`, and the menu closes when it is toggled. |
| Sidebar project kebab | `app-sidebar.tsx:3314` | 224 | | same as the chat-row kebab |
| Account menu | `app/user-menu.tsx:223` | **trigger width, min 256** (rail: 288) | | Enter animation is `menuEntranceClass`: **160ms, ease-out-expo, from .97**, not 220ms / spring / .96. It has a header block (36px avatar, 13px name, 12px email), a usage card (`rounded-control border foreground/.08`, a dot bar) and inset separators (`mx-2.5 my-1.5 /0.08`). The shortcut is shown as `font-mono text-caption`. Sign out is destructive styling over muted text at rest. |
| Code session row | `app/code-work-list.tsx:237` | 224 | | Icons come from **another icon API** (`<Icon name size={16}>`). The native `title="Options"`. Right-click (`onContextMenu`, l.210) opens this menu **at the kebab, not at the pointer**. |
| Code project filter | `code-work-list.tsx:340` | 224 | | RadioItems sit at `pl-8` (label at 32px), but the **SubTrigger rows sit at 10px** in the same list, so labels sit at two different x positions. The SubContent (l.347) has **no width** (176px). "Remove from Alevr…" is **not** destructive. |
| Answer → Regenerate | `chat/message-item.tsx:418` | 224 | | Trigger is `Pressable icon md` (32px, round) with a 12px mini-chevron at 60% opacity, opened with `data-[state=open]:control-neu`. |
| ↳ Switch model | `message-item.tsx:428` | 224 | `min(24rem,60vh)` | Labels are **mono** (`font-mono text-label`) with a 12px provider logo. Tick is 14px. The empty state is `px-2 py-3` (8px, not 10). |
| Answer → More | `message-item.tsx:1620` | 224 | | Contains a Branch sub (l.1634, 224) and an Export sub (`conversation-export-menu.tsx:93`, 224). On a phone, Export becomes a `DropdownMenuLabel` heading with the items inline. |
| Conversation header More | `chat/conversation-export-menu.tsx:119` | 224 | | Trigger is `Pressable icon lg` (36px) with a **20px** glyph. Has a sans label. |
| Continue on device | `chat/continue-on-menu.tsx:37` | **176** | | Rows have **no icons** (the trigger has one). |
| Decision alternatives | `chat/decision.tsx:107` | 288 | | Two-line rows with `text-caption leading-relaxed`. |
| Thought panel → Filter | `chat/thought-process-panel.tsx:907` | 224 | `available, 32rem` | Mixes a plain row with a **trailing** search glyph (`ml-auto`), **CheckboxItems** (labels at 32px) and **RadioItems** (dots) in one list. Counts are `font-mono text-caption`. |
| Thought panel → Copy | `thought-process-panel.tsx:981` | **176** | | No icons. |
| Work project chip | `work/composer/work-thread-controls.tsx:253` | **240** (`w-60`) | `min(22rem,60vh)` | `p-0` with a `ScrollFade` viewport at `p-1.5`. Selected = the glyph turns `text-primary` **and** a trailing 14px tick. Rows use 13px type (S1), while the same composer's chat chips open S2 menus at 14px. |
| Work permission chip | `work/composer-home/permission-chip.tsx:87` | 288 | | **Mono** label. Two-line rows (`items-start gap-2.5`). Selected = the label turns `text-primary`, plus a 14px tick. "default" is shown in `font-mono text-micro`. |
| Settings ChoiceMenu | `settings/choice-menu.tsx:82` | 288 | | RadioItems with a **6px dot**. Labels are `text-ui font-medium`; descriptions are `text-caption`. Sits in the same column as Selects (tick) and ModelPicker (tick). |
| Settings → Data export | `settings/sections/data-privacy.tsx:80` | 288 | | Two-line rows (`items-start py-2`). |
| Download menu | `app/download-menu.tsx:114` | 288 | | Header in `text-body` (15px) medium plus a caption. Loading and error rows are 12px with a 14px glyph. One row overrides `gap-2.5 px-2.5`. |
| Design canvas context menu (true right-click) | `design/design-context-menu.tsx:190` | 224 | `available` | Anchored at the pointer. **No icons on any row.** Shortcut `Hint` (l.110-118): `ml-auto pl-6 font-mono text-micro tabular-nums` (12px), red on Delete. Delete sits **mid-menu** (row 4), not last. |
| Design editor / layers / effects | `design/design-editor.tsx:689`, `layers-panel.tsx:669`, `effects-panel.tsx:990` | 224 / 224 / 288 | | effects: two-line rows `flex-col items-start gap-0.5` |
| Artifacts | `app/(app)/artifacts/page.tsx:272`, `:543` | 224 | | :543 has a label and a mono count |
| Artifact lifecycle | `artifacts/artifact-lifecycle-actions.tsx:252` | 224 | | |
| Canvas panel | `canvas/canvas-panel.tsx:995` | 224 | | spinner glyph while exporting |
| Library browser / item | `library/library-browser.tsx:195` / `library-items.tsx:431` | 224 / **min-w-48 (192)** | | |
| Projects: chat / header / folder | `projects/project-chat-list.tsx:246`, `project-workspace-header.tsx:214`, `project-folders.tsx:719` | 224 | | Triggers use native `title="More"`. Folder trigger is `rounded-full`. `projects/[id]/page.tsx:907` adds "Remove image", which is **not** destructive. |
| Memory row | `memory/entry-row.tsx:488` (+ sub `:513` at 224) | 288 | | The sub's loading, failed and empty states are **disabled rows at 50% opacity**. "Forget" is a two-line row, not destructive. Delete is a two-line destructive row. |
| Memory header | `memory/memory-header.tsx:85` | 288 | | Counts in 13px sans `tabular-nums`. "Reset memory…" is destructive with a *restore* glyph. |
| Memory scope | `memory/scope-bar.tsx:89` | 288 | | RadioItems (dot) with trailing counts |
| Compare run settings | `compare/compare-run-settings.tsx:90` | 288 | | Footnote at `px-2` (8px), not the rows' 10px |
| Compare summary | `compare/compare-summary.tsx:185` | 224 | | |
| Research export / doc picker | `research/report-export.tsx:212` / `report-document.tsx:265` | 288 / **w-72 literal** | `max-h-80` | |
| Code run review / session | `code/run-review.tsx:940`, `code/code-session-menu.tsx:134` | 224 | | |
| Skills | `skills/skill-source-group.tsx:221`, `skill-detail-view.tsx:187`, `add-skill-menu.tsx:44`, `teach/teach-permissions.tsx:186` | **208, 208, 240, 288** | | |
| Agents | `agents/agent-computer.tsx:393`, `agent-thread-header.tsx:246`, `orbit-stage.tsx:162` | **176, min-w-44 (176), min-w-40 (160)** | | Destructive is **hand-rolled** as `text-destructive focus:text-destructive`: no tint, and the fill token rather than the ink. |
| Shared links | `share/shared-links-card.tsx:289` | **176** | | |
| Admin users | `admin/users-admin.tsx:441` | **176** | | |
| Landing phone nav | `landing/phone-menu.tsx:175` | | | `menuShellClass` with plain links, `hover:bg-accent focus-visible:bg-accent` |

### 3.2 S2 `.cmenu` surfaces

| Surface | File:line | W | MH | Notes |
|---|---|---|---|---|
| Chat `+` | `chat/composer-plus-menu.tsx:369` | 288 | `min(32rem, available)` | §2.1 |
| `+` flyouts (Project, Apps, Skills…) | `composer-plus-menu.tsx:495` | 288 | (avail) | Gap 6, aligned to the row |
| Tray menus (Project / Apps / Skills) | `chat/composer-tray.tsx:281` | 288 | `min(30rem, available)` | Rows in `composer.tsx:2600-2700`. Contents: `MenuSearch` (36px), `MenuLabel`, `MenuSkeleton`, `MenuEmpty`, `cmenu-tile` (22px tile, 7px radius, `0 0 0 1px foreground/.08`). Trigger is `.composer-tray__item`: 28px, 14px radius, 13px; open fill `foreground/.085`. |
| Task-mode chip | `chat/task-mode-chip.tsx:103` | **336** (`min(21rem,…)`) | | Uses `DropdownMenuPrimitive.RadioItem` **directly** (not the wrapper). Two-line rows; the description is `text-caption leading-relaxed`; selected = the label turns `text-primary` plus a 14px tick (top-aligned); "Default" is shown in `font-mono text-micro`. |
| Media params → choice | `chat/composer-media-params.tsx:455` | **min 208** (`min-width:13rem`) | 26rem | Head is **mono 11px** (`.cparams-head`, media-params.css:312), below the type floor. Selected = a **1.5×16px blue `--presence` bar** at the left edge (l.355) plus weight 500, with **no tick**. Notes are **mono 10.5px** (l.288). Animation curve is `--cp-ease` = `cubic-bezier(.16,1,.3,1)`. |
| Media params → frame | `composer-media-params.tsx:610` | `max-content` (a 188px stage plus a grid) | available | `PopoverPrimitive` direct, at the `.cmenu` 18px radius. Has its own glide (`cframe__glide`). |
| Media params → length | `composer-media-params.tsx:759` | `min(18rem,100vw−24px)` | | Popover at the 18px radius. Number is a **34px serif**. |

### 3.3 S3 composer layers

| Surface | File:line | Notes |
|---|---|---|
| Slash palette | `chat/composer.tsx:465-490` (`SlashLayer`), rows at `:397`, `PaletteEyebrow` at `:417` | §1.5. The counter is mono. |
| `@` mention palette | `chat/context-composer-layers.tsx:143-230` | Has the keycap footer (↑ ↓ ↵ esc) that the ⌘K palette deliberately removed (`command-palette.tsx:571`). |
| Token popover | `context-composer-layers.tsx:334` | `composer-layer--popover`, 14px, `14px 16px 12px` padding |

### 3.4 S4 popovers used as menus or pickers

| Surface | File:line | Radius | W | Pad | Row / selected notes |
|---|---|---|---|---|---|
| Model catalogue | `chat/model-catalogue.tsx:1138` | 14 | 640×500 | 0 | §2.4 |
| Effort panel | `chat/model-selector.tsx:628` | 14 | 296 | 12 | |
| Settings ModelPicker | `settings/model-picker.tsx:177` | 14 | 320 | 0 | 32px rows |
| Compare picker | `compare/compare-model-picker.tsx:88` | **12** | 320 | 0 (list p-1) | Pressable rows with a filled selection |
| Code target (machine) | `code/code-target-picker.tsx:247` | **12** | `min(100vw−2rem, 92vw)`, sm: **368** | 0 | `PickerRow` = `Pressable row` at **46px** (`ROW_HEIGHT`, l.164), two lines. Selected = `bg-selected` fill plus the icon in `text-primary`, **no tick**. Rows fade up on a stagger. |
| Code target (checkout) | `code-target-picker.tsx:524` | 12 | 368 | 0 | same; max-height `min(28rem, available)` |
| Code landing skills | `code/code-landing-skills.tsx:101` | 12 | **380** | 0 | its own `cv2` CSS inside |
| Voice settings | `voice/realtime-voice.tsx:499` | 12 | `min(20rem,…)` | 0 (list p-1) | Rows are `px-2.5 py-2` with a **12px second line**. Selected = **`bg-accent`, the same colour as hover** (hover is `bg-accent/60`), plus a 14px tick. Disabled is `opacity-40`. Heading is `text-caption`. |
| Notifications | `notifications/notifications-popover.tsx:115` | 12 | **384** (`w-96`) | 0 | Header is 48px in **serif** `text-heading`. Max-height `min(36rem, available)`. Opens to the **right** of the sidebar, at a 12px offset. |
| Work `+` panel | `work/composer/work-thread-composer.tsx:499` | 12 | 320 | 0 | §2.3 |
| Report TOC | `research/report-fullscreen.tsx:134` | 12 | 320 | **4** | `max-h-[70dvh]` |
| Code checks | `code/code-session-banner.tsx:317` | 12 | 320 | 4 | |
| Right-column overflow | `chat/panel/right-column-shell.tsx:263` | 12 | `w-auto` | 4 | A **vertical stack of icon-only `IconButton`s** (the header actions) with no labels. |
| Session outputs | `chat/session-outputs.tsx:300` | 12 | 336 | 0 (inner p-4) | |
| Auto receipt | `chat/auto-receipt.tsx:54` | 12 | 288 | 0 | |
| Message feedback | `chat/message-feedback.tsx:181` | 12 | 320 | 16 | |
| Memory-updated notice | `chat/memory-updated-notice.tsx:193` | 12 | `min(24rem,…)` | 12 | |
| Citation (hover popover) | `research/citation-card.tsx:201` | **12** | 320 | 16 | Its job is the same as `source-chip.tsx:311`, which is a **Tooltip** `.cite-card` at **14px**, `p-0`. |
| Image-edit help | `chat/image-edit-overlay.tsx:803` | 12 | 256 | 12 | |
| Design popovers | `design/effects-panel.tsx:2189` (224, p-3), `layers-panel.tsx:1200` (256, p-3) | 12 | | |
| Clarification card | `chat/composer-clarification-popover.tsx:224` | `rounded-popover overlay-glass` + `animate-pop-in` | | Inner options are `rounded-menu` (14) bordered cards. |

### 3.5 Selects (S1b)

Triggers in the `fieldHeightClass` recipe are 36px. Overrides:
- **`h-8` (32px):** `admin/users-admin.tsx:396` (also `w-32 text-caption`), `share/share-dialog.tsx:353` (`w-44`), `app/(app)/roadmap/[id]/page.tsx:201` (`w-[180px]`)
- **`w-40`:** `library/library-toolbar.tsx:143`, `projects/page.tsx:363`
- **`w-48`:** `settings/sections/models.tsx:205`, `agents/agent-profile-fields.tsx:372`
- **`w-52`:** `general.tsx:561`, `personalization.tsx:236`, `:326`
- **`w-64`:** `models.tsx:228`
- **`max-w-[200px]`:** `roadmap/submit-dialog.tsx:157`
- **`max-w-sm` / `max-w-xs`:** `teach-editor.tsx:518`, `live-ui-controls.tsx:156`
- **28px pills:** the ⌘K filters (`command-palette.tsx:1053`, `:1073`)
- **`text-caption` items** (12px rows inside a 13px-row component): `design/effects-panel.tsx:2104-2106`

---

## 4. States matrix (how each system draws each state)

| State | S1 dropdown | S1b Select | S2 `.cmenu` | S3 layer | S4 catalogue / settings | S4 Pressable rows (compare, code target) | S5 palette | S6 Code v2 |
|---|---|---|---|---|---|---|---|---|
| Hover / highlight | `bg-accent`, 120ms; dark contrast **1.09:1** | same | gliding pill, 220ms expo; dark **1.26:1** | `fg/.045` hover, `fg/.06` cursor, no transition | `bg-accent` | `hover:bg-accent` | framer spring pill + inset ring | `bg-accent`, 70ms |
| Selected / checked | checkbox: left 16px tick in **accent**; radio: left 6px dot in **ink** | left 16px tick in accent, **no fade** | right 14px tick in accent; toggle = 28×16 switch | n/a | right 16px tick in **foreground** (catalogue) / **accent** (settings) | **filled `bg-selected` row** + tick (compare) or + accent icon (code) | n/a | right 16px tick in foreground |
| Focus-visible | = highlight; no ring | = highlight | = glide | = cursor | catalogue: `ring-2 ring-inset` on rows **and** the `bg-accent` cursor | global 2px ring, offset 2 | none (`tabIndex=-1`) | global ring if Tabbed into |
| Disabled | opacity .5 | .5 | .5 (inherits) | `[data-needs]` mark .4 | `soon` .45 / locked .5 | `disabled:opacity-50` | n/a | .5 |
| Destructive | ink-red + 9% / 14% tint (`.danger-hover`) | n/a | latent: `--destructive` **fill token** + 10% glide | n/a | n/a | n/a | n/a | `--destructive` fill token, no tint |
| Open sub-trigger | `bg-accent` | n/a | `fg/.05` (different from the glide's `.06`) | n/a | n/a | n/a | n/a | drill-in |

Other disabled opacities: voice 0.40, effort panel 0.55, catalogue 0.45. **Five opacity values for one state.**

---

## 5. Submenus, keyboard and motion

**Submenu placement:**
- S1 sub: flush (0px), `alignOffset 0` → rows 7px low, with two 1px borders touching.
- S2 flyout: 6px gap, `alignOffset −7`, aligned.
- S6: drill-in panel replacement with a Back row.
- `+` at phone width: drill-in with 12px slide.
- Export on phone: inline under a heading.

That is **four submenu models.**

**Arrow-key wrap:**
- S1 / S1b: no wrap (Radix `loop=false`).
- Catalogue, Settings ModelPicker, Code v2: wrap.
- Palette: clamp.

**Home and End:** yes in S1, catalogue, settings; **no** in the palette and Code v2.

**Typeahead:** S1 only.

**Enter animations:**

| Surface | Animation |
|---|---|
| S1 / Select / Popover | 220ms "spring" (no overshoot), .96 + 4px |
| Account menu | 160ms expo, .97 |
| S2 | 220ms expo, .96 + **6px**, plus a 220ms content stagger after **70ms** |
| Palette | 220ms expo, .97 − 6px |
| S6 | 160ms, 2px, **no scale** |
| S3 | **none** |
| Tooltip | 120ms, .97 + 2px |

That is **six entrances.**

**Exit animations:** S1 120ms `.96`; S2 120ms `.97` with no travel; S6 about 104ms with travel; S3 none.

**Trigger rotations:**
- **Chevron 180°:** 120ms `ease-in-out` (Select, ChoiceMenu); 220ms `ease-out-soft` (`composerChevronClass`, composer-shell.tsx:493); 220ms `ease-in-out` (tray, compare, work chips).
- **`+` 45°:** `ease-in-out` (chat, work) or `ease-out-strong` (code).

---

## 6. Every inconsistency, with values

### Shell

1. **The recipe is not shared where it claims to be.** `menu-recipe.ts:4-19`, `dropdown-menu.tsx:25` and `composer-plus-menu.tsx:32-35, 106-115` all say the `+` menu and the kebabs are "one object". The `.cmenu.cmenu` rules at (0,2,0) and (0,3,0) override them. The two menus differ as follows:

   | Property | `+` menu | Kebab |
   |---|---|---|
   | Shell radius | 18 | 14 |
   | Row radius | 12 | 8 |
   | Type | 14px | 13px |
   | Gap | 10 | 12 |
   | Border | `fg/.07` | `border/.7` |
   | Shadow | custom | `--shadow-float` |
   | Highlight | gliding pill | instant fill |
   | Separator | inset `/.07` | full-bleed `/.10` |
   | Enter | 220 expo + 6px + stagger | 220 "spring" + 4px |
2. **Five radii for floating lists**:
   - **8px:** tooltip
   - **12px:** Popover, compare and code pickers, notifications, Code v2, citation popover
   - **14px:** S1 menus, the slash and `@` layer, the catalogue, settings picker, `.cite-card` tooltip
   - **16px:** the ⌘K palette
   - **18px:** `.cmenu` and its popovers

   Row radii are 8 or 12.
3. **Three hairlines on the shell:** `border/.7` (S1, Popover), `foreground/.07` (S2), `foreground/.10` (palette). Code v2 has a transparent edge in light and `#fff/.08` in dark.
4. **Four shadow recipes:** `--shadow-float`, the `.cmenu` stack, `--cv2-shadow-pop` (which is `none` in dark), and `.ui-tooltip`'s own.
5. **13 widths in practice against a two-rung ladder** (`menu-recipe.ts:179-190`): 160, 176 (default or min-w-44), 192, 208 (`w-52`), 224, 240 (`w-60`), 256+ (account), 288, 320, 336, 368, 380, 384, 640. Seven dropdowns set no width and fall to 176px, among them `continue-on-menu.tsx:37`, `thought-process-panel.tsx:981` and `shared-links-card.tsx:289`.
6. **Nine height caps:** 18rem, 20rem, 22rem, 24rem, 26rem, 28rem, 30rem, 32rem, 36rem, 480px, 500px, `min(…,60vh)` and `70dvh`.
7. **Four scroll affordances:** none (S1); Select's chevron buttons; `.cmenu-scroll` 28px gradients; `ScrollFade` (catalogue, work chip) or `scroll-fade-y` (palette).

### Rows

8. **Row heights:** 32 (settings picker, Code v2), 34 (slash and `@` layer, compare), 36 (S1, S2, catalogue, palette), 46 (code target). Two-line S1 rows have no fixed height.
9. **Row type:** 13px (S1, Select, catalogue), 14px (S2, S3, Code v2), 15px (palette, Pressable base). The recipe header (l.33-37) argues for 13px "read off" Claude and ChatGPT. The composer chose 14px against it.
10. **Row padding and the text x-position:**
    - S1: 10px pad + 16px glyph + **12px** gap → label at **38px** from the row edge.
    - S2 and S3: 10 + 16 + **10** → **36px**.
    - Palette: 8 + 20 + 10 → **38px**.
    - Checkbox, Radio and Select: `pl-8` → **32px**.
    - Code v2: 8 + 16 + 10 → **34px** (inside a 6px margin).

    Inside one S1 menu, a RadioItem label (32px) and a SubTrigger or plain-item label (10px with no icon, 38 with one) **do not line up**: `code-work-list.tsx:340-360`, `thought-process-panel.tsx:911-966`.
11. **Group labels have six treatments.** In S1, 6 of 12 `DropdownMenuLabel`s override to **mono** (`font-mono text-label`: `code-composer-parts.tsx:108`, `permission-chip.tsx:88`, `work-triggers.tsx:531`, `:541`, `message-item.tsx:431`; and `document-viewer.tsx:549` with `font-mono text-caption`). The other six stay 12px sans medium. Elsewhere:
    - `.cmenu-label`: 12px sans 500
    - `.cparams-head`: **11px mono**
    - catalogue `SectionLabel`: caption sans
    - palette group header: caption sans with a 20px top gap
    - Code v2 `.cv2-msect`: 12px sans **400**
    - Work `+` eyebrows: mono

### Separators and marks

12. **Separators:**
    - S1: full-bleed, `fg/.10`, 4px margins.
    - `PlusMenuSeparator` and the account menu: inset 10px, `fg/.08`, 6px margins.
    - `.cmenu`: inset 10px, `fg/.07`, 6px.
    - Code v2: full-bleed, `border/.8`, 6px.
    - Popover section borders: `border/60` or `/70` or `/80`.
    - The `@` layer foot: `border` at 100%.

    So the account menu and the kebab menu, which both use S1, draw **different** separators.
13. **Selected markers: about 16 idioms.** Left tick in accent (checkbox, Select); left dot in ink (radio); leading glyph swapped for a tick (sidebar "Add to project"); right 14px tick in accent (`+`, regenerate, work, permission, task-mode, voice, compare); right 16px tick in accent (settings picker); right 16px tick in **foreground** (catalogue, Code v2); right **muted plain `Check`** (cross-messages); **blue presence bar** (media params); **filled row** (compare, code target, voice); **label turns accent** (permission, task-mode); **glyph turns accent** (work project, code target); **glyph turns presence-blue** (`project-folders.tsx:516`); filled star (settings multi).
14. **Toggles in menus come in four forms:** the custom 28×16 switch (chat `+`), a left tick CheckboxItem (thought filter), a right muted `Check` on a plain item (cross-messages), and a real 32×20 `<Switch>` (Work `+`).
15. **Shortcut display:**
    - `font-mono text-caption` (account menu)
    - `font-mono text-label` with tracking (chat `+`)
    - `font-mono text-micro` with `pl-6` (design context menu)
    - `<Kbd>` keycaps (palette, some tooltips)
    - 11px bordered keycaps (`@` footer)
    - 12px sans (Code v2 `.cv2-kbd`)
    - a plain `font-mono` span (`document-viewer.tsx:667`, `image-edit-overlay.tsx:1023`)

    No `DropdownMenuShortcut` primitive exists.
16. **Trailing counts:** 13px sans `tabular-nums` (memory, scope), `font-mono text-caption` (thought filter, artifacts, palette meta), 12px sans (Code v2).

### Destructive rows

17. **Destructive rows:**
    - 22 rows use `variant="destructive"`.
    - Two hand-roll `text-destructive focus:text-destructive` with no tint, using the fill token: `agent-computer.tsx:396`, `agent-thread-header.tsx:267`.
    - Code v2 and `.cmenu` use the `--destructive` **fill** token.
    - "Remove from Alevr…" (`code-work-list.tsx:352`), "Remove image" (`projects/[id]/page.tsx:907`) and "Forget" (`entry-row.tsx:550`) are **not** destructive.
    - The design context menu puts Delete fourth, and every other menu puts it last.

### Highlight, empty states and submenus

18. **Highlight contrast is weakest where it is most used.** S1 in dark: #2D2E31 on #27282B = **1.09:1**. The S2 glide in dark: **1.26:1**. In dark mode a keyboard user in a kebab menu can barely see which row is lit, and the composer menu next to it lights up about 3× as much.
19. **Highlight motion:**
    - Instant fill (S1, S3).
    - A 220ms gliding pill (S2).
    - A framer spring with an inset ring (S5).

    So arrowing through the `+` menu, the `/` palette and ⌘K gives three different feelings.
20. **Loading and empty states inside menus:**
    - Disabled 50%-opacity rows (`entry-row.tsx:519-526`).
    - Shimmer rows with an empty tile (`MenuSkeleton` / `MenuEmpty`).
    - A 12px spinner line (download menu).
    - `px-2 py-3` centred text (regenerate).
    - The `EmptyState` component (compare, notifications).
21. **Submenu geometry:** the S1 SubContent has no `sideOffset` or `alignOffset`, so it sits **flush** and its first row is 7px lower than the trigger row (`dropdown-menu.tsx:101`). Only the `+` flyout fixes this (`composer-plus-menu.tsx:496-500`).

### Triggers and tooltips

22. **Triggers for the same "more" job:**
    - 28px `rounded-control` with a 14px glyph (sidebar, code list).
    - 28px `rounded-full` (`project-folders.tsx:715`).
    - 32px round with a 16px glyph (answer bar).
    - 32px IconButton (memory).
    - 36px with a **20px** glyph (conversation header).

    Open states: `bg-foreground/5`, `control-neu` (a bordered key), `bg-selected` (code banner) or `fg/.085` (composer chips).
23. **Tooltips:**
    - **Materials:** the ink `.ui-tooltip`, `.cite-card` (popover material at 14px), `.pf-tip` (popover material at 8px), and native `title=` on several kebabs.
    - **Width:** no default max-width, so call sites set `max-w-xs`, `-60`, `-64` or `[20rem]` and the rest run as wide as the screen.
    - **Doubled tooltips:** `IconButton` writes `title={label}` by default (`icon-button.tsx:65`). Callers inside a Radix tooltip have to pass `title=""` to avoid two tooltips (memory, skills), so this breaks whenever someone forgets.
24. **Unreadable keycap inside light-mode tooltips.** `<Kbd>` is `surface-inset`, i.e. `bg hsl(var(--background))`. `.ui-tooltip` does not re-point `--background`, and it re-points `--muted-foreground` to 72% grey. Its `--border` token carries an alpha, which makes `hsl(var(--border) / .8)` invalid, so the keycap border drops out. The result in light mode is a **near-white #FCFCFD pill with #B3B6BC text (≈2.0:1) inside a near-black tooltip**. Affected: `message-item.tsx:311`, `design-editor.tsx:594-621`, `app-sidebar.tsx:1487`, `:1545`, `product-switch.tsx:306`. This is computed from the CSS, so confirm it in a browser.
25. **Two keyboard-hint policies.** The ⌘K palette removed its keycap footer as noise (`command-palette.tsx:571`). The `@` palette still draws one (`context-composer-layers.tsx:208-226`) at 11px.

### Type, motion and code drift

26. **Below the 12px floor** (tailwind.config.ts:554-564): `.cparams-head` 11px mono, `.cparams-note` **10.5px** mono, `.composer-layer__key` 11px, the `.cmenu-empty__hint` 12.5px half-pixel size, and `text-micro` (a retired rung) in `design-context-menu.tsx:116`, `task-mode-chip.tsx:139`, `permission-chip.tsx:107`, `realtime-voice.tsx:543` and the catalogue.
27. **Easing vocabulary:**
    - `--ease-spring` `(.22,1,.36,1)`.
    - `.cmenu` `(.16,1,.3,1)`.
    - `--cp-ease` `(.16,1,.3,1)`, declared again locally.
    - `ease-out-expo` (palette, account).
    - The local Code v2 `--cv2-ease`.
    - Framer spring 520/40/0.7.

    Durations: 220, 160, 120, 104 and 70ms, plus the 70ms + 220ms content stagger.
28. **Code v2 is a seventh island.**
    - **Layout:** not portalled, z-index 40 (under `--z-popper` 55), no collision flip.
    - **Keyboard:** no typeahead and no Home/End.
    - **Depth:** a dark shadow of `none`.
    - **Widths:** a different px width per menu.
    - **Native tooltips:** `title=` attributes act as tooltips.
29. **Comments disagree with the code**, which shows the system has been patched in many places rather than designed once:
    - `menu-recipe.ts:32` and `:85` say "32px", but the row is 36.
    - `menu-recipe.ts:9`, `:35` and `user-menu.tsx:35` say gap-2.5, but the recipe is gap-3.
    - `composer-plus-menu.tsx:32-35` says "14px shell, 8px rows", but `.cmenu` makes them 18 and 12.
    - `composer-plus-menu.tsx:306` claims the F0 keyboard-open behaviour, which has no product CSS.
    - `command-palette.tsx:689` says "--accent IS --popover" in dark, which is no longer true.
    - tailwind.config.ts:937 promises a spring overshoot that the curve cannot produce.
    - `user-menu.tsx:81` sets both `gap-3` (from the item, via Radix Slot, which concatenates classes without merging) **and** `gap-2.5` on the same `<Link>`. Tailwind's emit order decides which wins, not the author.

---

## 7. Why it reads as un-premium (against Claude, ChatGPT and Apple)

1. **Three menus a second apart look like three products.** Open `+` (18px, 14px type, gliding pill), then the model chip (14px, a 640×500 three-pane popover with `bg-muted/40` side panes), then a sidebar kebab (14px, 13px type, flat fill). Claude, ChatGPT and macOS each use one menu material, with one row height, radius and type size, everywhere.
2. **The dark-mode highlight is nearly invisible** (1.09:1). ChatGPT's and Claude's dark menus use a clearly visible `#fff` at about 8-10% on a lighter panel. Apple uses the accent-blue fill. An almost invisible highlight makes a menu feel unresponsive.
3. **Selection has no single grammar.** Ticks are left or right, 14 or 16px, accent or foreground or muted; there are dots, blue bars, filled rows and coloured labels. Apple always draws a leading ✓ in a fixed gutter. Claude and ChatGPT always draw a trailing ✓. Here, two menus opened from the same Settings column (ChoiceMenu and Select) mark the chosen option with a dot in one and an accent tick in the other.
4. **Labels go mono or sans at random.** Half the group headings are JetBrains Mono and half Inter. Mono 11px heads (media params) and mono provider labels (regenerate) read as "developer console". The command palette's own comment (l.419-426) says exactly this, and the fix was not carried across.
5. **Submenus feel unbuilt.** A flush, 7px-misaligned flyout with two hairlines meeting reads as an accident. macOS and Claude offset the submenu so its first row lines up with the parent row.
6. **Too many sizes for the same thing.** Seven-plus widths for verb menus, and 176px default menus with icon-less rows (Continue on device, Copy, Shared links) next to 224px menus with icons. Premium products use about two widths and always use icons, or always don't, within a family.
7. **Motion is busy where it should be quiet.** The `.cmenu` shell scales and travels 6px, then its *contents* animate again 70ms later (about 290ms to settle). Apple's menus appear in about 0-100ms with a fade. ChatGPT's and Claude's menus run about 150ms. The slash palette, by contrast, has **no** motion, so the product feels both too slow and too abrupt.
8. **Two-line rows inside verb menus** (permission chip, task mode, decision, data export, memory Forget and Delete, Work triggers, effects) make menus read as forms. ChatGPT keeps descriptions to the model picker, and Apple almost never uses them.
9. **Several "menus" are really forms in popovers:** the Work `+` panel with switches and outline buttons; the right-column overflow as a column of bare icon buttons; the voice settings with a filled row that looks like hover; the code target picker with 46px stacked rows. Each makes the overlay family look improvised.
10. **Typography below the floor and in half pixels** (10.5, 11, 12.5px) inside menus. Premium UIs keep menu type at one size (13 or 14px) with one secondary size.
11. **Destructive rows are not consistent.** Some use a red tint, some flat red text in the fill token, and some destructive verbs are not red at all. Delete is sometimes mid-menu.
12. **Tooltip noise:** native OS `title` tooltips on some kebabs and custom ink tooltips on others; tooltips with no max width; a white keycap in black light-mode tooltips. The 200ms delay is quick, so they flash on casual hover (macOS waits about 1s and ChatGPT about 500ms).
13. **Code v2 menus clip and stack wrongly.** They are not portalled, sit at z-index 40, have no collision handling and no shadow in dark, so they can land under toolbars or cut against edges. Nothing else in the product does this.

---

## 8. Where a fix would start (pointers only; nothing was changed)

- **One shell token set.** Pick 12 or 14px for the radius, keep 6px padding with an 8px row radius, and apply it to S1, S2, S3, S5 and S6. Delete the `.cmenu.cmenu` overrides of radius, type, gap, shadow and border, or make the recipe adopt them.
- **One row:** 32 or 36px tall, one type size (13 or 14px), 10px gap, a 16px glyph, and the label always on one x. Use a fixed leading-icon slot *or* a fixed check gutter, applied the same way in DropdownMenu, Select and RadioItem.
- **One selected mark:** a 16px tick in a fixed position and one colour. One toggle form.
- **One highlight:** pick the glide or the instant fill. Use `fg/.06` light and `#fff/.08-.10` dark everywhere, replacing `bg-accent` in menus.
- **Primitives to add:** `DropdownMenuShortcut`, a menu `Empty` / `Loading` row, and a destructive row. Give SubContent defaults of `sideOffset −4/+4` and `alignOffset −7`.
- **Labels:** one style, sans 12px/500, used everywhere.
- **Port Code v2** popovers onto Radix (portal, collision handling, z-popper, shadow-float).
- **Tooltips:** one material with a default `max-w-xs`; re-point `--background` (and fix the `--border` alpha) inside `.ui-tooltip`; remove native `title` tooltips from menu triggers.
