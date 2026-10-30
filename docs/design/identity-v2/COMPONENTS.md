# Identity v2 · COMPONENTS

Appendix to `docs/design/IDENTITY_V2.md` §9. One recipe per idea. Values refer to TOKENS.md and
MOTION.md. Each recipe states anatomy, sizes, states, keyboard behaviour and **roles and names**. Web files
are named where the recipe lives; native equivalents are in NATIVE.md. Revision 3 applies the review
(sheet and popover semantics, the Effort group, the composer's own anatomy, the voice recipe, forced
colours).

**State vocabulary** used everywhere: rest · hover · pressed · selected (on) · focus-visible (keyboard
only) · disabled · busy. Hover never changes size or weight. Pressed is `--press` (rows: no scale;
buttons: no scale either, d1). A selected row never stacks hover or press: hovering or pressing it keeps
`--selected`. Focus-visible is drawn only after keyboard input (`src/lib/input-modality.ts`): a 2 px
`--ink` **outline** (never a box-shadow, so forced colours keep it) at offset 2 on controls, inset (offset
−2) on rows inside menus and lists, so it is never clipped by the float's edge. **Pointer focus draws no
ring anywhere.** A text field's own 1 px edge changes colour on focus by any means (`--line-strong` →
`--ink-2`); that is a field state, not a focus ring, and it never thickens. The existing tests that hold
owner rule 1 (`tests/focus-keyboard-only.test.ts`, `tests/input-modality.test.ts`,
`e2e/keyboard-focus.spec.ts`) are W3 and W4 gates (MIGRATION).

---

## 1. The floating-layer family (one shell, one row)

Covers dropdown menus, submenus, context menus, selects, popovers, the composer `+`, the model picker, row
and message menus, the account menu, Code's pickers (`.cv2-pop` is deleted), the citation popover and the
notifications inbox. One primitive (Radix `DropdownMenu`, `ContextMenu`, `Popover`, `Select`) and one
recipe file: `src/components/ui/menu-recipe.ts`. `.cmenu` (`src/components/chat/composer.css`) and
`.cv2-pop`/`.cv2-mi` (`src/components/code/v2/code-v2.css`) are deleted.

### 1.1 Shell

| Property | Value |
|---|---|
| Fill | `--float` |
| Radius / inset | 12 / 4 on all sides (rows radius 8 = 12 − 4) |
| Elevation | tier 2 (its first layer is the ring; no separate border). HC: the ring is 1 px `--line-strong` at alpha 1 (TOKENS §6). Forced colours: a transparent 1 px border that becomes `CanvasText` (§15) |
| Width | content-sized between 224 and 320; `+` menu 272; row menus 232; long labels truncate with an ellipsis and show the full label in a `title` and to AT, never wrap |
| Max height | 60 % of the viewport, then the list scrolls inside the inset with 8 px static fades (user-generated lists only) |
| Placement | anchored to the trigger, 6 px gap, flipping on either axis at the viewport edge. Composer menus open **upward and never cover the composer** (the menu's bottom sits 6 px above the composer's top). Context menus open at the pointer, offset 4 px toward the inline end and 4 px down (so toward the left of the pointer in RTL) |
| Motion | MOTION §5 (pointer: 120 fade + 4 px on `snap`; keyboard: instant) |
| Loading inside a menu | never grey bars: one row "Loading skills…" in `ink-2` with the 12 px busy ring; replaced in place |

### 1.2 Row anatomy (today's row, at d1 density)

```
| 8 | glyph 16 | 10 | Label  ui 13.5/20 450 ink ............ | 16 | trailing slot | 8 |   height 32 (touch 44), radius 8
```

- **Glyph**: 16 px at `--ink-2`, turns `--ink` with the row. **All or none per group**: a group of verbs
  with clear metaphors carries glyphs; a group of user-made names (skills, projects, chats, files) carries
  none. Never a provider logo except in the model picker; never a coloured tile.
- **Label**: sentence case on web and iPhone (verb first, no articles; "…" when more input follows:
  "Rename…"); Title Case in Mac menus only (NATIVE §4).
- **Trailing slot**, exactly one of: shortcut (`caption` 12, `ink-2`, `tnum`, symbols not words: `⌘U`;
  `aria-hidden` when it repeats the item's `aria-keyshortcuts`), submenu chevron (16, `ink-2`, mirrored in
  RTL), check (16, `ink`) for a checked toggle or the chosen radio item, or a quiet value (`caption`,
  `ink-2`).
- **Two-line rows** only where the description decides the choice (model picker, task mode): label +
  `caption` description in `ink-2`, min height 44, 8 px vertical padding.
- **Separators**: 1 px `--line-soft`, inset 8 from the shell edge, 4 px above and below, between groups
  only. **Headings**: `caption` 12 / 16 at 520, `ink-2`, sentence case, padding 8 8 4, not focusable, only
  when a group needs a name ("Your skills").

### 1.3 Row states

| State | Treatment |
|---|---|
| Rest | transparent |
| Highlighted (pointer hover or keyboard focus; always the same row) | `--hover` fill, glyph and label `--ink`; instant in, 80 out |
| **Keyboard focus** | the highlighted fill **plus a 2 px `--ink` inset outline** (offset −2, radius 8). The fill alone measures 1.07–1.13:1 against the float, which fails WCAG 1.4.11 (J-ux must-fix); the ring is ≥ 7.98:1 on every fill in all four appearances (TOKENS §1.3). Drawn only when the menu is being driven by the keyboard (`input-modality`) |
| Submenu open | the trigger row keeps `--hover` while its submenu is open |
| Checked | trailing check; the label does not change. Persistent toggles (Web search) also show as a composer token, so state is never only inside a menu |
| Destructive | label and glyph `--danger` (7.18:1 on float light, 7.08:1 dark; 6.57 / 5.96 on hover and 6.08 / 5.36 while pressed), always in the last group, "…" when a confirm follows. No red fills in menus |
| **Disabled** | **label `--ink-2`** (≥ 6.00:1 light, ≥ 6.90:1 dark on every fill, so it stays readable when highlighted) and **glyph `--ink-3`**, plus `aria-disabled="true"`; **stays keyboard-focusable** (WAI-ARIA APG), shows the keyboard ring when focused, and **always shows why as its visible `caption` description** ("Needs a project first"), never only in a tooltip (tooltips never appear on touch). Never removed from the list just because it is unavailable |
| Pressed | no scale; the menu closes on pointer-up and focus returns to the trigger |

### 1.4 Submenus

- **When**: a term that repeats across more than two items ("Add to project", "Run a skill", "Use an
  app"). One level only, about five items, plus at most one "Browse…" row under a separator.
- **The trigger row never runs a command**; it carries the chevron; the default action is the first row
  inside.
- **Placement (d1)**: to the inline end of the parent, 2 px clear, with its **first item level with the
  trigger row** (a heading, if any, sits above that line). Fallbacks in order: shift up to fit the
  viewport; flip to the inline start; on viewports under 640 px or coarse pointers, drill in (§1.9).
- **Pointer intent**: opens 100 ms after the pointer rests on the trigger; a safe polygon from the pointer
  to the submenu's near corners suppresses sibling hover for 300 ms or until the pointer reaches an item
  (Radix grace area). Leaving in any other direction closes it at once; closing a submenu never closes
  the parent.
- **Motion**: opacity 120 + 4 px from the parent side on `snap`; no scale; keyboard: instant.

### 1.5 Keyboard (all menus)

Enter, Space or ArrowDown on the trigger opens with focus on the first enabled-or-disabled item; ArrowUp
opens on the last. Up/Down move (wrapping), Home/End jump, type-ahead jumps by label (1 s buffer, repeated
letter cycles). The inline-end arrow (ArrowRight in LTR, ArrowLeft in RTL) or Enter opens a submenu and
focuses its first item; the inline-start arrow or Escape closes **one level** and returns focus to its
trigger; Tab closes the whole tree and moves on. Focus returns to the trigger on close, with a ring only if
the menu was driven by the keyboard. Pointer-opened menus do not move focus into the menu until the first
arrow key.

### 1.6 Context menus

Right-click, Shift+F10 and long-press (touch, 500 ms) open **the same items as the row's kebab**, at the
pointer, on every row that has a kebab: sidebar chats, projects, Library rows, Research reports, messages,
agent rows, Code sessions. **Shift+right-click keeps the browser's own menu.** The row keeps `--hover`
while its menu is open; the kebab shows on row hover and focus (always on touch). Today right-click opens
the browser menu everywhere except Code's list (WA §3.11).

### 1.7 Roles and names

Menus are `role="menu"` with `menuitem`, `menuitemcheckbox` (toggles, `aria-checked`) and
`menuitemradio`; submenu triggers have `aria-haspopup="menu"` and `aria-expanded`; separators
`role="separator"`; headings are `role="presentation"` text with the group as `role="group"`
`aria-labelledby`. A menu contains nothing else: no radiogroup, slider or text field (see §11 for Effort).
The composer `+` trigger is named "Add" (`aria-label`), the kebab "More actions for <row name>". Disabled
items: `aria-disabled` and `aria-describedby` to their reason. Every icon-only trigger has an accessible
name and a tooltip.

### 1.8 Canonical menus (contents and order are identical on web, Mac and iPhone)

| Menu | Groups (glyph rule) |
|---|---|
| Composer `+` | Add photos and files ⌘U · Add from Library · Add to project › // Web search ✓ · Deep research · Create an image // Run a skill › · Use an app › (glyphs: yes) |
| Chat row | Pin · Rename… · Add to project › · Share… // Archive · Delete… (glyphs: yes) |
| Message More | Copy · Branch in new chat · Quote in reply · Don't remember this · Share… // Report a problem… |
| Account (from the account row) | header (name, plan, usage) // Profile · Settings ⌘, · Keyboard shortcuts ⌘/ // Get the apps · Sign out |
| Model (`Auto ⌄` token) | §11 |
| Agent row (Orbit) | Open · Pause · Message… // Settings… · Stop… |

One name per tool everywhere: the menu row, the composer token, the settings label and the native menu all
say **"Web search"** (today the menu says "Search the web", J-ux).

### 1.9 Phone and touch: bottom sheet + drill-in (prototyped)

Below 640 px wide or on coarse pointers, every menu becomes a bottom sheet (`shots/phone-menu-light.png`,
`shots/phone-menu-dark.png`, keyboard ring `shots/phone-menu-keyboard-light.png`):

- `--float`, top radius 24 (24 = the composer rung; the sheet's bottom corners are the device's), tier 3
  plus scrim, 8 px inset, 34 px bottom safe area. Grabber (36 × 5) only when the sheet has two detents.
- **Header 52**: the sheet's title (`title-3`) at the inline start and a visible **Close** icon button
  (44 × 44, named "Close") at the inline end, so a screen-reader user can always leave without choosing
  an item (VoiceOver captures swipes and the scrim is not a control).
- Rows 44 high, 20 px glyphs, label 16 / 22 (`.body` equivalent), radius 8.
- **Submenus drill in** inside the same sheet (`shots/phone-drill-light.png`, `-dark.png`): the header
  title becomes the submenu's name; under it a back row ("‹ Add": the visible text names where back goes,
  44 high, chevron 20, mirrored in RTL), a separator, then the items. The sheet height animates on
  `glide` (instant under reduced motion); the new level slides 16 px + fades 120 on `snap`. Back: tap the
  back row, swipe from the inline-start edge, or Escape; reduced motion fades.
- Dismiss: Close, tap the scrim, swipe down past 30 % or with velocity, or Escape.
- **Roles and focus**: the sheet is `role="dialog"` `aria-modal="true"` `aria-labelledby` its title and
  contains the `role="menu"`; the page behind is `inert`. On open, focus moves to the first item; on
  drill-in, to the back row (accessible name "Back to Add"); on drill-back, to the submenu's trigger row;
  on close, to the control that opened the sheet. Gate: `e2e/wave2/identity-v2/phone-sheet.spec.ts` (W3)
  tabs and swipes through the sheet at 390 px asserting roles, names and each focus move.

### 1.10 Popovers

The shell above with free content: inset 16, width 280–400, optional header row (`title-3` + 28 px close
icon button). **Roles**: `role="dialog"` with `aria-labelledby` its header (or `aria-label` when it has
none), not modal; Escape closes it and returns focus to its trigger. A popover holds at most one decision;
anything with a form becomes a dialog; a deeper level pushes inside.

**Citation popover**: 320 wide, favicon tile 20 (radius 6, `--raised`, or the designed monogram: the
first letter of the source's site name, i.e. `og:site_name` or else the first hostname label that is not
`www`, in `micro` 600 `ink-2` on `--raised` with a 1 px `--line` ring), title `title-3`, domain `caption`,
the verbatim passage (two lines, "Show more"), "Open at passage" (quiet button), and a pager ("1 of 2")
when it was opened from a run of adjacent numerals. **One opening rule** (it replaces "opens on focus"):
keyboard focus on a numeral only highlights its note; Enter, Space, click or tap opens the popover; a
pointer resting 300 ms previews it (WCAG 1.4.13: it stays while the pointer is over the numeral or the
popover, Escape dismisses it, it never covers the line being read); it never opens on focus alone. While
it is open, Tab from the numeral moves into the popover; Escape closes it and returns focus to the
numeral.

### 1.11 Dialogs

| Property | Value |
|---|---|
| Width | 420 (confirm), 560 (form), 720 (content) only |
| Radius / padding | 16 / 24 |
| Elevation | tier 3 + `--scrim` (no blur) |
| Title | `title-2` 18 / 24 600; a question for confirms that names the object: "Delete “Planning formats for a small team”?" |
| Body | `ui` 13.5 / 20 `ink-2`; the consequence with numbers ("The chat and its 2 files are removed. This can't be undone.") |
| Actions | right-aligned (inline end), 8 apart, 24 above: secondary then primary; destructive confirms use the danger button with a named verb ("Delete chat"), never "OK" |
| Close | Escape and Cancel; the scrim closes non-destructive dialogs only; no × on confirms (a 28 × close only on content dialogs) |
| Focus | first field, or the safe button for destructive confirms; trapped; returned to the trigger |
| Roles | `role="dialog"` `aria-modal="true"` `aria-labelledby` the title; **destructive confirms are `role="alertdialog"`** with `aria-describedby` the consequence sentence |
| Motion | enter 160 / exit 120, scrim and panel together (MOTION §5) |
| Phone | below 640 px, a bottom sheet with the same content (§1.9) |

### 1.12 Sheets

- **Phone bottom sheet**: §1.9; detents medium (55 %) and large (92 %) where content scrolls.
- **Desktop side sheet** (artifact window, sources panel, an agent's profile in the thread's side slot):
  docks inside the stage at the inline end as part of the layout, 440 or 560 wide, separated by a 1 px
  `--line`, no shadow, slides on `glide`; below 1,024 px window it overlays with tier 3 + scrim. Floating
  side sheets do not exist. **An agent's live computer is not a side sheet**: it opens full screen over
  the thread (AGENTS.md §3, §5.2; IDENTITY_V2 §12).

### 1.13 Toasts

`--float`, radius 12, height 44, padding 0 6 0 14, tier 2. Anatomy: status glyph 16 (`success` check,
`danger` alert, none for neutral) · message (`ui` 520, one line, past tense, names the object: "Moved to
Q3 planning") · one tonal action ("Undo") · close icon button 28. Bottom-centre of the stage, 12 above the
composer (16 from the bottom on pages without one; above the safe area on phones). Max three; newest in
front. Arrives on `lift` with the shadow layer landing 70 ms behind (MOTION §3.1). Neutral toasts dismiss
after 6 s, paused on hover and focus; toasts with an action stay until dismissed or the action expires;
errors stay until dismissed. `role="status"`, failures `role="alert"`. Loading toasts use the busy ring,
never a galaxy.

### 1.14 Tooltips

Inverted chip: `--ink` fill, `--on-ink` text, `caption` 12 / 16 at 520, padding 5 8, radius 6, optional
shortcut at 70 % opacity of `--on-ink` after an 8 px gap; no shadow. 600 ms delay, 300 ms skip window
(`providers.tsx` is changed to match). Only for icon-only controls and truncated text; never interactive,
never the only name (every icon button has an `aria-label`), never on touch (long-press shows the label as
a context-menu header instead).

### 1.15 Command palette (⌘K)

Dialog shell, 640 wide at 14 vh from the top, radius 16, tier 3 + scrim (no blur). Input row 52 (16 px
text, search glyph 20, Esc keycap). Result groups under menu headings (Chats, Projects, Research, Actions,
Settings); rows 36 with the menu row anatomy; the matched text in 600 (no highlight colour); trailing date
(`tnum`) or shortcut. Footer 36 with keycap hints and the result count. The first result is highlighted;
typing is never blocked by the entrance. Roles: `role="combobox"` input with `aria-controls` a
`role="listbox"` of `option`s, `aria-activedescendant` on the highlighted one.

---

## 2. Buttons (the ladder, d1)

| Rank | Look | Use | Per view |
|---|---|---|---|
| Primary | `--ink` fill, `--on-ink` label (17.76:1 light, 14.59:1 dark), radius 8, no shadow, no gradient | the one action the view exists for | **one** (the composer's send disc, or End in a voice conversation, counts as the chat view's primary) |
| Secondary | `--stage` fill (dark `--raised`), 1 px `--line` edge (identified by its label, TOKENS §1.4 rule 7; HC: `--line-strong`), `--ink` label | alternatives: Cancel, Edit first, Download for Mac | any |
| Tonal | `--hover` fill, `--ink` label | in-context actions: Undo, Pause, Clear | any |
| Quiet | no fill, `--ink-2` label → `--ink` + `--hover` on hover | tertiary: "Don't send", "Show the draft" | any |
| Danger | `--danger-fill`, `--on-danger` label (6.45:1 light, 5.35:1 dark) | the confirm in a destructive dialog only | one |
| Icon | 32 × 32 (28 in dense rows with a 32 hit area, 44 touch), radius 8, glyph 16 `--ink-2` → `--ink` | header and row actions | any |

- Sizes: small 28 (radius 6, `ui` 12.5 / 16 520), default 32 (radius 8, `ui` 13.5 520), large 40
  (radius 12, 15 / 20 520; landing and auth only). Glyph 16, gap 8.
- Hover: primary to ink at 88 % opacity of its fill over the ground; others `--hover`. Pressed: `--press`.
  **No scale on press.**
- **Never disabled-grey on an empty form**: the primary stays ink and validates on press, showing the
  field error (fixes Orbit's "Create agent", WA §4.6). A truly unavailable action is disabled with
  `aria-disabled`, stays focusable, and says why next to it.
- **Busy keeps the label**: a 14 px ring (ink on secondary, on-ink on primary) replaces the leading glyph;
  the width does not change; `aria-busy="true"`. This and the search field are the only places a spinner
  exists.
- Placement: page primary at the inline end of the page header; dialogs at the bottom inline end; never a
  primary inside a card in the middle of a page (the needs-you card is the exception: it is the view's
  question).

## 3. Fields

- Text field: 32 (44 touch, 40 on auth), radius 8, `--stage` fill (dark `--raised`), 1 px `--line-strong`
  edge (≥ 3.92:1 light on stage, 4.25:1 dark on raised), placeholder `--ink-2`, `ui` 13.5. Focus-visible
  (keyboard): the 2 px ink outline. Any focus: the edge goes `--line-strong` → `--ink-2` (a 1 px colour
  change, never an outline, never thicker). Error: edge `--danger` + `caption` message below with the
  alert glyph, value kept, `aria-invalid` + `aria-describedby`.
- Search on the base (sidebar, phone drawer, settings column): `--well` fill, no edge at rest (identified
  by its search glyph, placeholder and keycap; TOKENS §1.4 rule 7), radius 8, leading search glyph 16,
  trailing shortcut keycap (`⌘K`) in `ink-2`. **HC and forced colours: a 1 px `--line-strong` edge.**
- Select: the field look + `chevrons-up-down` 16 trailing; opens the menu recipe with the chosen row checked.
- Textarea: field rules; grows to 40 vh then scrolls.

## 4. Segmented controls and tabs

- **Segmented** (2–5 options that switch a view in place: theme, list/grid, Library filters, reading
  size): track `--well` (dark `--raised`), radius 8, inset 2, height 32; thumb `--float` (dark
  `--selected`), radius 6, **1 px `--line-strong` ring for everyone** (3.19:1 against the light track,
  3.52:1 dark: passes 1.4.11; J-ux must-fix), label `ui` 12.5 520; unselected labels `ink-2`; counts inside
  the segment in `ink-2` `tnum` ("All 24"). The thumb moves on `snap` (it is the value changing; MOTION
  rule 7). Icon-only segments have `aria-label` and a tooltip. Roles: `role="radiogroup"` with `radio`
  items; arrow keys move and select; Left/Right follow the reading direction in RTL. Never inside a menu.
- **Tabs** (sections that change the whole content: Customize › Apps · Skills · Routines · Memory ·
  Instructions): left-aligned (inline-start) text tabs, 36 tall, `ui` 520 in `ink-2`; selected `--ink`
  with a 2 px `--ink` underline; **selection changes instantly** (no sliding underline). Roles:
  `role="tablist"` of `tab`s (`aria-selected`, `aria-controls`) and one `tabpanel` (`aria-labelledby`);
  automatic activation; Left/Right move between tabs (mirrored in RTL), Home/End jump. One tab style;
  `surface-tabs.tsx`, `product-switch.tsx` deleted.
- Navigation inside a section with more than six destinations is a column (Settings), never tabs.

## 5. Switch, checkbox, slider

- **Switch**: 36 × 22 capsule. Off: `--well` with a 1 px `--line-strong` ring and a `--float` thumb; on:
  `--ink` track, `--on-ink` thumb. Thumb moves on `snap`. **In settings rows the whole row is the hit
  area**: the row is a `<label for>` that wraps **only the title**; the description is a sibling linked
  with `aria-describedby`, so the switch's accessible name is the title alone ("Show timing on answers")
  and the description is read as its description. The switch is `role="switch"` with `aria-checked`;
  standalone switches get a 24 × 24 minimum target on web (44 touch).
- **Checkbox**: 16, radius 4, 1 px `--line-strong`; checked `--ink` fill with a 1.5 px `--on-ink` check;
  the whole label is its target.
- **Slider**: 4 px track whose unfilled part is **`--line-strong`** (≥ 3.16:1 light, ≥ 3.52:1 dark, so the
  whole range meets 1.4.11) and filled part `--ink` (never bronze); 18 thumb `--float` with a 1 px
  `--line-strong` ring and tier-1 shadow; thumb hit area 24 (44 touch); the track is clickable;
  `aria-valuetext` carries the formatted value ("15 %", "$80"; LUI B25). No glass knob.

## 6. Page header (one recipe for every page)

`src/components/ui/page-header.tsx` replaces `app-page-header.tsx`, `editorial.css` `.ed-display`,
`memory.css` `.mem-display`, `profile.css` `.pf-name`, `research.css` `.research-title`, `code-v2.css`
`.cv2-h1` and `projects.css` `.pj-*` title recipes.

```
stage header (52):  [‹ back when nested] [title fades in after the page title scrolls under]     [page icon actions]
page head (40 top): Title  title-1 Geologica 28/34  [count  Inter 20/26 450 ink-2 tnum]           [secondary] [Primary]
                    One-line description  ui ink-2 (max 560)
toolbar (16 below): [segmented filter with counts]                   [search field 240] [sort select] [view segmented]
                    ─────────────────────────────────────── 1 px --line under the toolbar
```

No backdrop drawing, no eyebrow, no galaxy (`page-backdrop.tsx` deleted). On phone the navigation bar
shows the title (17 semibold) and the page drops its own `title-1`: no double titles (WA §3.15). Render:
`shots/projects-1440-{light,dark}.png`.

## 7. List rows

| Row | Height | Anatomy | States |
|---|---|---|---|
| Sidebar destination | 32 (44 touch) | glyph 16 · 10 · label `ui` 450 `ink-2` · trailing count or shortcut on hover | hover `--hover` + `--ink`; selected `--selected` + `--ink` 520 + the glyph's on-drawing + `aria-current="page"` (the fill is 1.08:1, so selection is carried by ink, weight, the filled glyph and `aria-current`) |
| Sidebar chat | 32 (44 touch) | label only (all or none: chats have no glyph) · trailing pin glyph 16 `ink-2` for pinned · **when the chat waits on the person** (an approval in a chat task with no agent): `NeedsYouDot` + "Needs you" (`caption` 520 `--signal`) in the trailing slot, the row keeps its place (pinned chats still lead) · kebab on hover/focus (always on touch) | as above |
| **Orbit header** | 32 (44 touch) | Orbit glyph 16 · 10 · "Orbit" `ui` 520 `ink-2` · trailing counts in words (`caption` `tnum`; "needs you" in `--signal` 520) · chevron 12 | a link to the Orbit page with the `--hover` plate; accessible name "Orbit, 1 working, 1 needs you"; the section is a `role="group"` `aria-labelledby` this row |
| Orbit agent (sidebar) | 32 (44 touch) | **face 20** (the rig's `xs` size; never smaller) · 10 · name `--ink` · trailing state word: `LiveDot` + "Working" (`--bronze`; working, thinking), "On a call" (`--bronze`, listening), `NeedsYouDot` + "Needs you" (`--signal`; waiting), alert glyph 12 + "Blocked" (`--danger`; blocked) | only busy agents are listed (IDENTITY_V2 §11.2) |
| Page list (Projects, Library, Research, Activity) | 52 (56 touch) | tile 32 (radius 8, `--raised`, glyph 16 `ink-2`) · name `ui` 520 `--ink` + `caption` meta `ink-2` · numeric columns right-aligned `tnum` · kebab on hover/focus | header row 32: `caption` 520 `ink-2` over a 1 px `--line-strong` rule; row rules 1 px `--line`; hover: a radius-8 `--hover` plate, the rules either side hide; multi-select: `--selected` + leading checkbox; right-click opens the kebab menu |
| Palette result | 36 | glyph 16 · label · trailing date or shortcut | highlighted `--hover` (+ keyboard ring) |
| Settings row | ≥ 56 | title `ui` 520 + description `caption` `ink-2` · control trailing | the whole row is the switch's hit area (§5) |

Rows never draw a left accent bar. Timestamps and counts use Inter `tnum`, never mono.

## 8. Cards

In-flow cards are tier 0: `--stage` with a 1 px `--line` edge (light), `--raised` with `--line-soft` (dark);
radius 12; padding 16–24. Titles sans (`title-3` / `title-2`), two lines max; meta `caption` `tnum`. Cards
group (settings groups, landing tiles, project grid cards, Live UI views); they never wrap ordinary
answers. **Project cards** (grid view): no cover art; a neutral 40 tile (`--raised`, radius 12) with the
portfolio glyph 20 in `ink-2`, or a two-letter monogram of the project's name in `ink-2` `micro` 600; **the same tile in both views** (32 in the table, 40 in the grid). Agent tones are for
faces only; nothing else is tinted. **The one exception to tier 0** is a card that waits for the person
(needs-you, a permission request): `--float` + tier 1 while waiting (IDENTITY_V2 §10.5).

## 9. Empty, loading and error (one vocabulary each)

| State | Recipe |
|---|---|
| **Empty** | under the page header (toolbar hidden), left-aligned in the page column, 48 below: a 40 tile (radius 12, `--raised`, glyph 20 `ink-2`) · `title-2` ("No projects yet") · one or two `ui` sentences in `ink-2` that say what will appear here and how · the page primary and at most one secondary. No illustration, no galaxy. **Orbit's empty roster is the exception**: it shows the hire board (AGENTS.md §5.1) |
| **Loading** | pages: static placeholder rows in `--raised` (no shimmer, no pulse), shown only after 300 ms; menus and popovers: one "Loading…" row (§1.1); transcript: the live line (IDENTITY_V2 §10.3); buttons and the search field: the 14 px busy ring. Nothing else spins |
| **Error** | inline (a row, a turn, a card): alert glyph 16 `--danger` · one sentence in `--ink` saying what happened · two ways forward ("Try again" tonal, "Carry on without it" quiet). Page-level (route errors, Library failed, 404, 500): the empty-state layout with the danger glyph tile, a `title-2` ("Couldn't load your Library"), the reason, "Try again" (primary) and one way out. No giant "500", no red callouts in navigation |

## 10. The composer (one anatomy: Chat home, threads, agent threads, Code, Research)

```
┌ radius 24, --float when lifted / --stage at rest (dark --raised), 1 px --line edge (HC --line-strong), padding 14 8 8 ──┐
│ ·24· field 15/22 (iPhone 17), placeholder ink-2 ..................................................... [mic 24]  │
│        "Describe what you need, or drop a file" (home) · "Reply, or ask something new" (thread)                    │
│        "Message Mira" (agent) · "Describe the change" (Code)                                                       │
│ [+] [◔ Auto ⌄] [Web search ×] [Project: Q3 planning ×] [slot]                              [〰 Talk] [● send]   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Renders: `shots/home-1440-{light,dark}.png` (at rest), `shots/margin-1440-light.png` (lifted, with a
token), `shots/agent-1440-waiting-light.png`.

- **Width** `--composer-w` (624 px at 16 px reading size), centred on the reading column. **The field's
  inline-start padding is `--composer-text-inset` (24 px)**, so the placeholder and the typed text start on
  the column's edge, the same edge as the dateline, the greeting and every answer (measured: x = 432 px for
  all three in the 1,440 home layout). The controls row keeps the 8 px inset that makes its capsules
  concentric (24 − 8 = 16); the `+` hangs into that inset. Phone: full width minus 8 each side, text inset
  12; max field height 40 vh, then it scrolls; no animation on growth.
- **Controls row** (32; phone 40 visual, 44 hit), inline start to end:
  - `+` (named "Add"; opens the canonical `+` menu upward);
  - **the model token** "◔ Auto ⌄" (gauge glyph 16 + short model name + chevron; the one token with no ×,
    always first; opens the model picker, §11). On phones it shows the gauge glyph only, with the full name
    "Model: Auto" as its accessible name;
  - **mode tokens** (every persistent mode or context: Web search, Deep research, a project, attached
    files, a skill, Code's device and permissions): removable capsules, `--raised`, 1 px `--line` (HC
    `--line-strong`), glyph 16 + the full word + a × (24 hit on pointer, **44 pt hit on touch**).
    Accessible name: "Web search, remove". On phones a token may shorten its visible word but never loses
    its × or its full accessible name (J-ux must-fix);
  - a surface slot;
  - at the inline end: **Talk** (a quiet capsule, 32 high: wave glyph 16 + the word "Talk"; glyph only when
    the composer is under 480 px wide, named "Start voice conversation"), then **the send disc**.
- **Send disc** (32, `--ink`, `--on-ink` glyph), **two states**: arrow up (send) and, while streaming, a
  filled stop square ("Stop answering"). It never turns into a voice control and is never disabled-grey:
  pressed with an empty field it moves focus to the field and the polite live region says "Nothing to
  send yet". Accessible names: "Send", "Stop answering".
- **Dictation** is a field adornment, not a control-row button: a 24 px quiet mic glyph at the field's
  inline end on its first line (hit 32; named "Dictate"). On iPhone the system keyboard's dictation is used
  and the adornment is not drawn.
- **Voice conversation** starts from Talk (or ⌘⇧. on web and Mac) and turns the composer into the voice
  bar (§13); the transcript stays where it is.
- Why this anatomy and not the competitors': both put a voice control that morphs into send at the
  trailing end next to a dictation mic; Alevr keeps send as send, names voice with a word, puts the model
  with the other tokens at the start, and lines the text up with the answer column. Owner check before W4
  merges: the home and thread renders beside the competitor references (MIGRATION W4 screens).
- **Code's controls** (device, permissions, project/branch) are tokens with a value and a chevron
  ("Mac mini ⌄", "Ask first ⌄") at composer widths ≥ 560 px; below that they collapse into the `+` menu
  as a "Code settings" group (Device ›, Permissions ›) and one summary token ("Mac mini · Ask first"),
  which itself collapses to its glyph with the full accessible name before any label is truncated.
  **Never letters** (fixes "A\ O… ⌄", WA §3.15).
- **Material and boundary**: tier 0 at rest (home, or nothing under it): `--stage` fill (dark `--raised`)
  with a 1 px `--line` edge; the composer is identified by its placeholder, its controls and the ink send
  disc, so it uses the boundary exception (TOKENS §1.4 rule 7); in HC the edge is `--line-strong`. Tier 1
  (`--float` + shadow-1) only while transcript content scrolls beneath it (TOKENS §6). iPhone and Mac:
  opaque, the same rule (NATIVE §2).
- **Drop target**: on file drag the whole composer shows a 1.5 px dashed `--line-strong` edge and the
  placeholder "Drop to attach".
- **Never**: a disclaimer row under it; suggestions or chips above or below it (any platform); another
  product's placeholder line.

## 11. The model picker (one, everywhere)

Chat, Code, agents, Settings › Models and Compare open the same picker from the same model token ("Auto ⌄",
gauge glyph 16 + short model name + chevron). It is a menu (§1):

1. **Auto** (two-line `menuitemradio`: "Picks the model for each message"), then a heading "Pinned", the
   person's pinned models as two-line `menuitemradio` rows with their provider mark (16 tile) and a
   `caption` description.
2. Separator, then **Effort**: a `role="group"` `aria-label="Effort"` holding three `menuitemradio` items
   (Low · Medium · High, `aria-checked`), **drawn** as a segmented row (the §4 look) but behaving as menu
   rows: Up and Down step through them like any other row; Left and Right move within the group only while
   focus is in it and never open or close a submenu there; Enter or Space checks one and keeps the menu
   open. It applies to the chosen model (replaces the effort popover and its liquid-glass slider).
3. Separator, "All models…" opens the catalogue as a 720 dialog (the three-pane catalogue restyled to this
   spec), not a second flyout.

`src/components/settings/model-picker.tsx`, `compare/compare-model-picker.tsx`, `code/v2/pickers.tsx` and
the Chat chip's effort popover are replaced by this one component (WA §3.10).

## 12. Live and needs-you primitives (the only places bronze and signal blue are written, with the face files)

| Primitive (`src/components/ui/live.tsx`, `needs-you.tsx`) | Look | Behaviour |
|---|---|---|
| `LiveDot` | 7 × 7 squircle (radius 2.5) in `--bronze-fill` | the 1.6 s lift loop for the first 5 s after each step starts, then still (MOTION rule 13); still under reduced motion; **never alone: renders only inside a `LiveLabel` row** (a lint test fails a `LiveDot` with no sibling label) |
| `LiveLabel` | `caption` 520 `--bronze` ("Working", "Reading sources", "Speaking") | `aria-live="polite"` via the region it sits in |
| `LiveRule` | 1.5 px rule, `--line` track, `--bronze-fill` progress | width steps per source read; indeterminate: a 24 px segment once per 1.6 s, within the 5 s cap |
| `WritingPoint` | 2 × 16 px bar, radius 1, `--bronze-fill` | sits after the last streamed character; does not blink; fades 200 at the end |
| `NeedsYouDot` | 7 px circle `--signal` | **renders only beside the words "Needs you"** in the same row or line (same lint test) |
| `NeedsYouLabel` | `caption` 520 `--signal` "Needs you" | |
| `NeedsYouCount` | the Orbit header text "1 needs you" in `--signal` | derived from the same list as the rows |
| `NeedsYouAnnouncer` | no visual | one app-level polite live region; announces once per new item "<Agent> needs you: <question>" ("Otto needs you: Send this summary to 4 people?"); repeats for the same item are suppressed; never assertive (IDENTITY_V2 §10.5) |

## 13. Voice conversation (the voice bar)

Voice happens **in the composer**, not in a full-screen takeover: the composer becomes the voice bar and
the transcript stays readable above it. Renders: `shots/voice-1440-{light,dark}.png`,
`shots/voice-390-{light,dark}.png`.

| Part | Spec |
|---|---|
| Shell | the composer's own shell (radius 24, `--float`, tier 1 while content is under it), width `--composer-w`; height grows from the composer's to 72 (phone 76) on `glide` |
| The Arch (inline start) | the large master at 40 px (phone 44), drawn in `--ink`; **its stone tracks the input level**: `translateY(-level × 6px)` (0–6 px travel, so it never leaves the opening), level smoothed with a 60 ms attack and 200 ms release; the stone is `--ink` while Alevr listens and `--bronze-fill` while Alevr speaks (the brand's live state, inside the bronze budget because the mark lives in `src/components/brand/**`) |
| Captions (middle) | the live line in `ui` 15 / 22 `--ink` (the words being spoken, by either side); the previous line above it in `caption` `--ink-2`, prefixed "You:" for the person; both are also written into the transcript as turns when each turn ends |
| State word | `caption` 520: "Listening" (`--ink-2`), "Thinking" and "Speaking" (`LiveLabel`, `--bronze`, with `LiveDot`), "Muted" (`--ink-2`, mic-off glyph), "Interrupted" (shown 1 s when the person talks over Alevr, `--ink-2`), "Couldn't hear you. Check the microphone." (`--danger`, alert glyph, with "Try again") |
| Controls (inline end) | **Mute** (44 × 44 icon button, quiet, ring 1 px `--line`, mic / mic-off glyph; `aria-pressed`) and **End** (44 high capsule, primary ink, the word "End"; the view's one primary) |
| Agent calls | in an agent's thread the Arch is replaced by the agent's face at 40 in the rig's `listening` state, its eyes following `--level` (AGENTS.md §4.2); the stone rule does not apply |
| Colour | no glow, gradient, edge light or blur, anywhere; bronze only on the stone and the state word |
| Reduced motion | the stone rests; the level is a static 3-step meter (three 4 × 12 px bars beside the state word, filled by level thirds, ink while listening, bronze while speaking); height changes are instant |
| Keyboard and AT | Talk or ⌘⇧. starts; Space toggles Mute while the bar has focus; Escape or End ends; the bar is a `role="region"` "Voice conversation"; captions are an `aria-live="polite"` region that announces each finished sentence, not every word |
| Mac and iPhone | the same bar inside `JunoComposerShell`; iPhone keeps the bar at the bottom with the safe area; `.sensoryFeedback(.selection)` only on Mute; no haptic on start or end |

`src/components/voice/voice-glow-*` and the composer's glow states are deleted (MIGRATION W9); nothing
replaces them.

## 14. Roles and names for the remaining recipes

| Recipe | Roles and names |
|---|---|
| Step rail (IDENTITY_V2 §10.5) | an `<ol aria-label="Steps">`; each step an `<li>`; the current step has `aria-current="step"`; each row's state is in words ("Working", "Needs you", "Done", "Failed: <reason>"; "Done" is visually hidden text, the others are visible) |
| Needs-you card | a `<section aria-labelledby>` its question; the actions are buttons named by their verbs |
| Citation numeral | `<button aria-haspopup="dialog" aria-expanded aria-describedby="note-…">` named "Source 3"; a run of adjacent numerals is **one** button named "Sources 2 and 3" (IDENTITY_V2 §10.1) |
| Margin notes | `<ol class="answer-notes" aria-label="Sources for this paragraph">` with plain `<li id="note-…">` items (no role override) |
| Inbox bell | a button whose name carries the state: "Inbox, 3 unread, 1 needs you"; its tooltip shows the same words |
| Stamp line | a button named by its text plus "What this answer used" |

## 15. Forced colours (Windows High Contrast)

`@media (forced-colors: active)` removes `box-shadow`, so every boundary drawn with a shadow needs a
fallback. W3 carries today's rules from `src/app/globals.css` (:1990 composer focus, :4620 `.tone-edge` and
`:focus-visible`) into `src/components/ui/controls.css` and extends them:

- every tier (composer, needs-you card, floats, dialogs, sheets) and the stage carry a `1px solid
  transparent` border, which the browser paints as `CanvasText`;
- focus rings are outlines (never box-shadows) with `outline-color: Highlight`, including the inset ring
  on menu rows and sheet rows;
- the selected segmented thumb and selected rows use `Highlight` / `HighlightText`; tabs keep their
  underline as a 2 px border in `Highlight`;
- status dots (`LiveDot`, `NeedsYouDot`) keep `forced-color-adjust: none` only because their words sit
  beside them; faces keep their tones the same way, with the state in words;
- gate: `emulateMedia({ forcedColors: 'active' })` screenshots of `/dev/controls` (W3) and the shell and
  transcript (W9), asserting every float has a visible 1 px border.
