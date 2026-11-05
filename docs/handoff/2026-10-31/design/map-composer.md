# Alevr chat composer: design map and polish audit

This is a read-only audit. No source was changed.
Repo: `/home/user/juno`, audited 2026-10-31.

**Evidence used**
- Screenshots in `scratchpad/shots/`:
  - `composer-landing-{light,dark}.png`
  - `model-picker-{light,dark}.png`
  - `thread-{light,dark}.png`
- Dock screenshots in `scratchpad/composer-audit/`: `dock-empty-d-{light,dark}.png` (desktop, 1280×900) and `dock-empty-m-light.png` (390×844 @2x).
  - These were used because the `/dev/thread` scene renders no composer at all. Its screenshot shows the thread with no dock.
- Pixel measurements taken with PIL from those PNGs. Crops are in `scratchpad/crop-*.png`.
- Built CSS at `.next/static/css/app/layout.css`, used to settle cascade order.

All coordinates below are in CSS px at 1x.

---

## 0. Architecture in one paragraph

`Composer` (`src/components/chat/composer.tsx`, 3,681 lines) owns all state and passes slot content to `ComposerShell` (`src/components/ui/composer-shell.tsx`):

- `field`
- `above`
- `leading`
- `trailing`
- `action`

The shell draws one surface (`.composer-surface`, `src/app/globals.css:1885`) containing three things:
1. a scrollable `above` region;
2. the field tier;
3. one controls row.

The rest of the composer lives in separate places:
- **Field.** A contenteditable with inline context tokens (`context-composer-field.tsx`).
- **Mode glow.** Wraps the whole shell: `DictationSwap` (dictation) and `VoiceComposerGlow` (live call).
- **Tray.** The landing-only `ComposerTray` hangs under the box.
- **Menus.** The `+` menu, task-mode chip and model chip open their own menus and popovers.
- **Palettes.** `/` and `@` open portalled layers, placed with `placeComposerLayer`.

**Landing vs dock.** `chat-view.tsx:2380` renders the same `<Composer>` JSX in two different subtrees:
- The empty home: `.chat-home__composer`, `chat-view.tsx:3013`.
- The dock: `chat-view.tsx:2933`.

Because the subtrees differ, the first send remounts the composer. The draft survives only through `draftSession`.

---

## 1. The surface (shell)

| Property | Value | Source |
|---|---|---|
| Element | `div.composer-surface.relative.flex.w-full.flex-col.rounded-composer`, plus `max-h-[600px]` from the host | `composer-shell.tsx:107`, `composer.tsx:3089` |
| Radius | `rounded-composer` = **26px**. In browsers with `corner-shape`, it becomes `superellipse(1.5)` | `tailwind.config.ts:229`, `globals.css:4786-4790` |
| Fill (light) | `hsl(var(--card))` = #FFFFFF on page #FBFBFC | `globals.css:1886` |
| Fill (dark) | `hsl(var(--card)/0.96)` ≈ #222326 on page #18191B | `globals.css:1895` |
| Border (light) | 1px `hsl(--foreground / 0.10)`. Measured #E7E7E8 | `globals.css:1888` |
| Border (dark) | 1px `hsl(0 0% 100% / 0.09)`. Measured #363639 | `globals.css:1896` |
| Shadow (light) | `0 1px 2px ink/.04, 0 8px 28px -12px ink/.12` | `globals.css:1889-1891` |
| Shadow (dark) | `inset 0 1px 0 white/.05, 0 12px 36px -14px black/.7` | `globals.css:1897-1899` |
| Width | Dock: `page-gutter mx-auto transcript-column` → max 48rem including a 32px gutter each side = **704px** content. Landing: `max-w-[calc(48rem-2*var(--page-gutter))]` = 704, but inside a `.chat-home` grid track of **720px, or 660px at viewports ≤1200px** | `composer.tsx:2983-2996`, `composer.css:414-421, 499-503` |
| Rest height | Dock **100** (1 + 46 field + 6 + 36 disc + 10 + 1). Landing **110** (56px field). Coarse pointer **114** | `composer-shell.tsx:188-200`. Confirmed: the dock measured 776→876 and the landing 375→485 |
| Inner layout | `above` (scrolls, `min-h-0 shrink overflow-y-auto`) / field (`shrink-0`) / row (`shrink-0`) | `composer-shell.tsx:115-158` |
| `@container` | The field tier is a size container. Armed-mark labels hide below 30rem (`@[30rem]`) | `composer-shell.tsx:115, 429` |

**Focus and states of the surface itself**

- **Rest:** as in the table above.
- **Pointer focus** (`:focus-within`):
  - Border goes from 0.10 to 0.18 alpha. Dark: white 0.09 to 0.16.
  - Shadow deepens to `0 1px 2px /.05, 0 14px 40px -14px /.18`.
  - Source: `globals.css:1972-1983`.
  - Transitions: border on `--dur-fast` (120ms), but **shadow on `--dur-slow` (360ms)**.
- **Keyboard focus** (`data-kbd-focus`):
  - Set only when the field has focus **and** input modality is keyboard (`composer-shell.tsx:99-101`).
  - Border becomes `--ring/0.55`, and a `::after` 1px ring fades in over 120ms, giving a 2px graphite ring in total.
  - Sources: `globals.css:1902-1913` and `1984-1990`.
  - The `::after` has a **hard-coded `border-radius: 26px` and no `corner-shape`**. Where the surface is a superellipse, the ring and the edge diverge at the corners.
- **Increase contrast:** border goes to 0.45, focus to 0.65, keyboard ring to the full `--ring` (`globals.css:1998-2006`).
- **Forced colors:** 2px `Highlight` outline (`globals.css:2010-2012`).
- **Private mode:** `border-dashed border-foreground/25` (`composer.tsx:3093`).
- **Drag over:**
  - The shell gets `border-primary/55 ring-2 ring-primary/20`.
  - The `ring-*` utility rewrites `box-shadow` and **removes the composer's lift shadow**.
  - The `above` slot also paints an absolute overlay: 2px dashed `primary/45`, `primary/10` tint, a 24px files glyph, and mono label "Drop to attach". It animates in with `animate-fade-in` (`composer.tsx:3094, 3106-3113`).
- **Voice call:** a WebGL canvas reaches 44px outside the edge (`.voice-glow-canvas`, `globals.css:1940-1947`).
  - With no WebGL, the border takes the speaker tone over 220ms (`globals.css:1948-1955`).
  - Tones (light): ember #BC5806 is you, presence #2D49C9 is Alevr, #9A9CA0 is muted (`globals.css:1929-1938`).

---

## 2. The field (typing area)

| Property | Value | Source |
|---|---|---|
| Element | `ContextComposerField`: `contentEditable`, `enterKeyHint` from `useEnterKeyHint`, `spellCheck` | `context-composer-field.tsx:774-800`, mounted at `composer.tsx:3418-3483` |
| Metrics | `px-4 pt-4 pb-1`, `text-base` (16px), `leading-relaxed` (26px), `min-h-[2.875rem]` (46px), `coarse:min-h-[3.25rem]` (52px) | `composer-shell.tsx:225-227` |
| Landing override | `min-h-[3.5rem]` (56px), and `max-[760px]:min-h-[3.25rem]` | `composer.tsx:3472` |
| Ink | `text-foreground`. Placeholder uses `::before content: attr(data-placeholder)` in `--muted-foreground`, measured #686B70 light / #95979C dark. Tracking −0.006em | `composer.css:112-127` |
| Placeholder copy | Landing: "How can I help you today?" (word for word Claude's). Dock: "Ask a follow-up". Other values come from modality, quote, clarification, steering and voice | `composer.tsx:812-834`, `chat-view.tsx:2477-2491` |
| Growth | Snaps with no animation (`useComposerAutosize`, sync measure). The cap is **8 lines** (8×26 + 20 = 228px), then the field scrolls inside itself | `composer-shell.tsx:536-578`, `composer.tsx:1353-1357` |
| Growth while a clarification is pending | Cap is 3 lines | `composer.tsx:1354` |
| Long draft, over 1,500 chars or 30 lines | A hint row appears above the field: "That's a long one. Attach it as a file…". It uses `px-4 pt-3` and has an outline `h-7` button | `composer.tsx:1501, 3289-3307` |
| Huge draft, over 8,000 chars | The field is replaced by a "Large paste ready to send" card: `mx-4 mt-3.5 rounded-control border-border/70 bg-secondary px-3 py-3`, with `h-7` outline buttons "Expand to edit" and "Attach as file". After expanding, the field has `minHeight` 120 and `maxHeight` 448 | `composer.tsx:1355-1356, 1503-1504, 3207-3285` |
| Disabled | Only when `sendLocked` (voice transcript saving). `disabled:opacity-60`. The field stays live while a reply streams | `composer.tsx:3446`, `composer-shell.tsx:245` |
| Focus ring | None on the field. Focus is drawn on the surface (§1) | `composer.css:117-119` |

### 2a. Context chips inside the sentence (`@` tokens)

Source: `composer.css:34-110`.

- **Size:** 24px tall on the 26px line, `padding: 0 6px 0 4px`, `margin: 0 1px`, **radius 7px**.
- **Fill:** `--cmp-well` (#EEF0F1-ish light / 18.4% L dark).
- **Type:** **15px** regular, −0.004em.
- **Mark:** 16px, muted, `vertical-align: -3px`, `margin-right: 5px`.

| State | Treatment |
|---|---|
| Hover (fine pointer) | `--cmp-well-2` |
| Selected (first Backspace) | `--cmp-well-2` plus `0 0 0 1.5px muted` ring |
| Needs connection | Mark at 40% |
| Settle on insert | Fill animates from `--cmp-well-3` to the well over 220ms ease-out-soft |
| Leaving (pointer removal) | Opacity 0 on `--dur-exit` (160ms) ease-in. Keyboard removal is instant |

### 2b. Armed marks at the head of the draft (skill, Deep research)

Source: `ComposerArmedMark` at `composer-shell.tsx:314-426` and `ComposerFieldLead` at `composer-shell.tsx:449-490`.

- **Placement:** overlaid on the textarea. The field gets a `text-indent` equal to the group's measured width.
- **Container:** `inline-flex gap-1 rounded-control (8px) bg-accent pl-1 font-medium text-foreground`, entering with `motion-safe:animate-pop-in` (220ms, ease-spring, 4px + scale 0.96).
- **Size:** the label button has `py-0.5` on a 26px line, so the mark is **about 30px tall at 16px medium**. It is taller than the line it sits in.
- **Icon slot:** 20px holding a 16px glyph. On hover or focus it cross-fades to a 14px ✕ (120ms).
- **Detail:** " · Max" in muted, hidden below 30rem of composer.
- **Placeholder:** suppressed while any mark is present (`composer.tsx:3452-3458`).

---

## 3. The controls row

Source: `composer-shell.tsx:141-157`.

- **Container:** `flex flex-nowrap items-center gap-0.5 px-2.5 pb-2.5 pt-1.5` (10px sides and bottom, 6px top).
- **Leading cluster:** `gap-0.5` (2px).
- **Trailing cluster:** `gap-1` (4px), `coarse:gap-0.5`. It sits before the action with another `gap-0.5`.
- **Dimmed** (`controlsLocked && !steerMode`): `leading` and `trailing` go to `opacity-60` over 120ms. The `action` slot stays at full strength.

**Measured on the dock (light)**, as visible glyph extents in x:

| Element | Visible extent |
|---|---|
| `+` glyph | 308–321 |
| Task chip (hand) | 775–782 |
| Task chip chevron | 795–800 |
| Model mark | 824–842 |
| Model label "Auto" | 846–876 |
| Model chevron | 885–892 |
| Mic | 921–932 |
| Disc | 945–980 (36px), y 829–864 |

- Text column: left 305, right 975. Composer inner box: 289–991 by 777–875.
- Visible gaps: hand chevron → model mark is 27px; model chevron → mic is 29px; mic → disc is 13px.

**Measured inks (light)**, darkest pixel per glyph:

| Ink | Elements |
|---|---|
| #3D3F43 (`--icon-muted`, 25% L) | `+`, hand, model chevron, mic |
| #686B70 (`--muted-foreground`, 42% L) | "Auto" label, model mark, **the disc's own waveform glyph**, placeholder |
| #7D7E80 (muted at 70%) | Task chip chevron |

- **Dark mode inks:** #C4C6CA for `+`, hand, mic and model chevron. #95979C for the label, the disc glyph and the placeholder.
- **Why the glyphs are darker:** glyphs that are direct `svg.ji` children of a `.text-muted-foreground` control take `--icon-muted` (`globals.css:4815-4817`). The primary disc's glyph is wrapped in a `motion.span`, so it misses this rule and stays at the lighter muted ink.

### 3a. `+` button and menu

Source: `composer-plus-menu.tsx:288-516`.

**Trigger**
- `Button variant=ghost size=icon-sm` plus `composerIconButtonClass` (`composer-shell.tsx:513-514`).
- Shape: `size-8` (32px) `rounded-full`, transparent, `text-muted-foreground`.
- Hover: `bg-accent text-foreground`. Active: `bg-selected`. Open: `bg-accent`.
- Coarse pointer: `size-11` (44px).
- Glyph: `Plus` at `size-5` (20px, 1.5px line). Visible stroke is 14px wide, starting **3px right of the text column** (308 vs 305).
- Open state: the glyph rotates 45° over `--dur-base` (220ms) `--ease-in-out`. Opened from the keyboard it rotates instantly. Reduced motion: none (`composer.css:352-367`).
- Disabled only by `plusLocked` (send lock or quota). It stays **live while streaming but is drawn at 60%** (dimmed row).

**Menu**
- `DropdownMenuContent side=top align=start sideOffset=8`, collision padding 12, `w-72` (288px), `max-h-[min(32rem,available)]`.
- Uses the `.cmenu` recipe (`composer.css:799-1098`):
  - radius **18px**, padding 6px, 1px `fg/0.07` border, `bg-popover`;
  - three-layer shadow;
  - rows 36px, gap 10, px 10, 14px type, row radius 12;
  - a "glide" highlight that moves between rows: transform, width and height on 220ms `cubic-bezier(.16,1,.3,1)`.
- Entrance: `cmenu-in` 220ms (translate 6px toward the trigger, scale 0.96 → 1, opacity reaches 1 at 45%). Rows fill in after a 70ms delay over 220ms. Exit: `cmenu-out` 120ms to scale 0.97.
- Sections (`composer.tsx:2795-2934`):
  1. Add photos and files (`⌘U`), Add from Library, Take a screenshot, Sketch (`/sketch`).
  2. Web search toggle, Memory toggle.
  3. Add to project ›, Apps › (only when the tray doesn't already offer them).
- Toggle rows draw a **mini switch**: 28×16 track (`bg-foreground` when on, `fg/0.14` when off) with a 12px thumb. Transition is 220ms ease-out-expo (`composer-plus-menu.tsx:231-250`).
- Radio rows draw a 14px tick in **`text-primary`**.
- Compact mode (≤639px): submenus drill in place with `animate-stage-in` (±12px). ← and Esc step back.

### 3b. Task-mode chip (the "✋ ⌄")

Source: `task-mode-chip.tsx:76-96`.

**Trigger**
- `composerChipClass` (`composer-shell.tsx:275-276`): `h-8 rounded-control (8px) px-2.5 gap-1.5 font-sans text-label` (12px / 500 / lh 1.4), `text-muted-foreground`.
- Hover, focus or open: `bg-accent text-foreground`. Transition: background, color and opacity over 120ms.
- **`coarse:h-10` = 40px, below the 44px touch minimum** the rest of the row honours.
- At the default mode: `px-2`, a **14px hand glyph only**, and the chevron (12px, opacity 70%) is hidden below 640px.
- Off the default: the hand turns `text-primary`, the label fades in (`animate-fade-in`), and padding becomes `px-2.5`.

**Menu**
- `.cmenu`, `side=top align=end`, `w-[min(21rem,…)]`.
- Radio rows are two lines; the active label is `text-primary`, with a tick in `text-primary`.

### 3c. Model chip and picker

Source: `model-selector.tsx:523-683`.

**Chip**
- `composerChipClass` + `max-w-[16rem]` + `composer-model-chip coarse:h-11 max-sm:gap-1 max-sm:pl-2 max-sm:pr-1`.
- Contents: `ModelMark` at `size-3.5` (lab logo, or the Auto/Juno mark), then the name (12px/500; it fades in on change), then an optional effort word and "Pro" in muted, then a speed bolt, then the chevron.
- **Cascade conflict.** `composer.css:370-407` declares the chip as **14px / 400 / pill (999px) / padding 0 8 0 11 / `--cmp-ink-2`**. That block loads **before** the Tailwind utilities (`layout.css` line 706 vs utilities at 9233+). At equal specificity the utilities win, so it renders as **12px / 500 / 8px radius / 10px padding / muted ink**. That CSS block is dead.
- Two rules in that block are more specific than the utilities, and they *do* apply: `.composer-model-chip > svg { width:16px; height:16px; opacity:1 }` (0,1,1). The result is that the **model chevron is 16px at full ink** (#3D3F43), while the task chip's chevron is 12px at 70% (#7D7E80), side by side. The model-picker screenshot confirms the chevron is darker than the name.
- Fit: `useChipFit` drops the mark first, then the effort word, then whole words off the name. Below 360px the name is hidden and only the mark shows.
- Disabled while `controlsLocked`. It also gets `pointer-events-none` from the host (`composer.tsx:3518`). With `disabled:opacity-50` inside a row at 60%, it renders at **about 30%**.

**Popovers**
1. **Thinking panel** (when the model has 2+ effort levels): `PopoverContent side=top align=end sideOffset=8`, `w-[min(18.5rem,…)]`, `rounded-menu` (**14px**), `p-3`. Material is `surface-float overlay-glass` (1px `border/.7`, `--shadow-float`). Motion is `animate-pop-in` (220ms, ease-spring, 4px drift, scale 0.96) and `pop-out` (120ms). It contains `ReasoningSlider` (28px thumb).
2. **Catalogue** (`model-catalogue.tsx:1137-1193`): 640×500 (clamped), `rounded-menu` 14px, `p-0`, origin bottom-right. It has three panes: a 48px lab rail, a names column, and a detail panel. The search field is autofocused only with a fine pointer.
3. **Load error:** `CatalogueUnavailable`, an 18.5rem popover with a Retry button (`model-selector.tsx:146-186`).

### 3d. Dictate (mic) button

Source: `composer.tsx:3521-3540`.

- `Button ghost icon-sm` + `composerIconButtonClass`: 32px (44px coarse), `Mic` at `size-[18px]`, ink #3D3F43.
- Disabled when `controlsLocked || dictating || voiceActive`. While streaming that means about 30% opacity (60% row × 50% disabled).
- `aria-pressed={dictating}`.

### 3e. Primary action: send, stop, voice, busy

Source: `ComposerPrimaryAction`, `composer-shell.tsx:651-724`.

- **Shape:** `size-9` (**36px**) `rounded-full`, `coarse:size-11`, with `.pressable` (press scales to 0.97 in 70ms; colour and background change in 120ms).
- **Face logic** (`composer.tsx:1460-1469`): `checking` → busy; steering with text → send; busy or a standalone run → stop; can send, or voice unavailable → send; otherwise voice.

| Face | Fill | Glyph | Notes |
|---|---|---|---|
| voice (empty draft) | `bg-secondary` (light #EFF0F1 on white; dark #2D2E31 on #222326) | `AudioLines` 18px in muted #686B70 | Hover: `bg-selected` + foreground glyph. This is the **lowest-contrast object on the row** |
| send | `bg-foreground` (#1A1C1F light / #E8E9EB dark) | `Send` 18px `text-background`. Its `weight="bold"` is **ignored**: the icon family has one weight (`icons.tsx:51, 61`), so the arrow draws at a 1.5px line | Hover `foreground/90` (dark: white). Active `foreground/80` |
| stop | Same ink disc | `Square` 16px filled | Disabled while `stopping` or `checking` |
| busy (clarify preflight) | Ink disc, but disabled (`!canSend`), so it renders `bg-secondary` + `ink-tertiary` | `Loader2` 16px spinning | — |
| disabled send (uploading, quota) | `bg-secondary`, `text-ink-tertiary` (62% L) | Arrow | The tooltip names the blocker ("Waiting for the upload to finish") |

- **Face morph:** `AnimatePresence mode="sync" initial={false}`. Each face is a `motion.span` stacked in one grid cell going from `{opacity:0, scale:0.5}` to `{1, 1}`, with exit back to `{0, 0.5}`, on `transition.fast` (120ms, ease-out-soft `[.33,1,.68,1]`). The outgoing and incoming glyphs overlap.
- **Escape key:** while busy, Escape anywhere on the page calls `onStop` unless a dialog or menu is open (`composer.tsx:1338-1347`).
- **Live call:** the slot is replaced by `VoiceCallEnd` (`realtime-voice.tsx:355-372`): 36px `bg-destructive` **with `shadow-sm`**. It is the only shadowed control on the row.

---

## 4. Above the field: attachments, quote, clarification, steering

**Attachment row** (`ComposerAttachmentRow`, `composer-shell.tsx:925-964`)
- `flex flex-wrap gap-2 px-3.5 pt-3.5 empty:hidden`. That is a **14px** inset, while the field text starts at **16px**.
- The comment claims concentricity with a "22px corner". The corner is now 26px, so it no longer holds.

**Image tile** (`composer-shell.tsx:767-919`)
- 64×64, `rounded-control` (8px), `border-border/70`, `bg-secondary`, `object-cover`.
- Optional label strip: `bg-card/85`, 12px mono uppercase.

**File tile**
- 224×64 (`w-56`).
- Left: a 64px `FilePreview` page showing the first lines of the file, or the extension in mono.
- Right: `border-l` then `px-2.5`, with the name (12px sans 500, `line-clamp-2`) and a meta line (12px mono uppercase, "PDF · 1.2 MB").

**Tile states**

| State | Treatment |
|---|---|
| Uploading | `bg-card/70` scrim with a 16px `GalaxyMark` (phase "working"). Meta line reads "Uploading 42%" |
| Error | `border-destructive/60`. Meta line reads "Failed". **There is no retry** |
| Hover (fine pointer) | Remove button appears: absolute `right-0.5 top-0.5`, `size-6` (24px), `rounded-xs` (6px), `bg-foreground/80 text-background`, with a 12px ✕. It is a dark square tucked *inside* the tile corner. On coarse pointers it is always shown at 32px |
| Reopenable (sketch) | A full-tile button with an inset 2px outline on focus |

**Tile motion:** framer `TILE_MOTION` goes from `{opacity 0, scale 0.9}` to 1 with `layout`, on `spring.standard` (visualDuration 0.22s, bounce 0.05). The **row and the shell do not animate height**: the composer jumps about 78px taller in one frame while the tile scales in.

**Quote card** (`composer.tsx:3136-3205`)
- `mx-4 mt-3.5 flex gap-2.5 rounded-control border-border/70 bg-secondary px-3 py-2`.
- Contents: a 24px `rounded-xs` icon plate with a 14px glyph; a mono "Ask"/"Modify" label, a 13px medium title and a mono location; a two-line mono excerpt.
- Dismiss control: `p-1 rounded-full` with a 14px ✕.
- Enters with `animate-rise-in` (220ms, 6px) and exits with `animate-pop-out` (120ms).

**Clarification** (`composer.tsx:3115-3125`): `ComposerClarificationPopover variant="inline"` inside `above`. The `above` region scrolls inside the 600px cap, the field is capped at 3 lines, and the landing greeting fades out (`chat-view.tsx:2972-2983`).

**Steering** (`composer.tsx:226-245`):
- `modeControl` (`GuideModeSwitch`) and `steering.above` (`PendingSteers`) render at the head of `above`.
- The placeholder becomes the steering prompt, the row is **not** dimmed, and the disc shows send or stop.

**Quota** (`composer.tsx:2999-3025`)
- An `mb-2 rounded-control border-primary/30 bg-primary/5 px-3 py-2 text-ui` banner sits **outside and above** the 26px box. It is an 8px-radius rectangle stacked on a 26px squircle.
- The row dims, the `+` locks, and send is disabled.

**Project chip on a new chat** (`composer.tsx:3030-3058`; only when the tray is hidden)
- `mb-2 h-8 rounded-control border bg-card pl-2.5 pr-1 text-label`, with a 24px ✕.

---

## 5. Slash, `@` and skill commands

### `/` palette

Sources: `composer.tsx:1786-1950` (items), `2024-2056` (placement), `3314-3410` (render), and `.composer-layer` in `composer.css:129-266`.

- Triggered by a leading "/".
- **Groups:** Commands (`/model /artifact /sketch /voice /new`), Skills (`/<slug>` per installed skill, with description and source note), Tools (`/search /research`), Go to (`/projects /library /memory`).
- **Placement:** portalled with `position:fixed`. It is **420px** wide, anchored at the composer's left + 16, with a **4px** gap from the composer. It opens below on the home and above in the dock.
- **rAF loop:** placement runs on a `requestAnimationFrame` loop for the whole time the palette is open (`composer.tsx:2032-2054`).
- **Shell:** radius **14px**, padding 6px, `surface-float`.
- **Rows:**
  - 34px tall (44 coarse), gap 10, px 10, radius 8, 14px type.
  - The label is `font-mono text-ui` (13px) and the hint is 12px sans muted.
  - The state tick is 14px `text-foreground`.
  - Group eyebrows are 12px/500 muted.
- **Highlight:** hover `fg/0.045`; selected `fg/0.06` with no transition.
- **Motion:** none. It appears and disappears in the same frame (spec F0).

**Keys** (`composer.tsx:2092-2143`)
- ↑ / ↓ move. Enter or Tab applies. Esc dismisses.
- ↑ in an empty field edits the last message.
- Enter sends unless "send with ⌘↩" is on. On a touch keyboard, Return inserts a newline.

### Skills

- `use-chat-skills.ts`. Typing `/slug rest` sends with `skillSlug`. A bare `/slug` arms the skill as a head mark (§2b) and clears the text (`composer.tsx:1627-1639`).

### `@` palette

Sources: `context-composer-layers.tsx:143` and `context-composer-field.tsx:117-119, 495-505`.

- Same `.composer-layer` recipe, but **372px** wide.
- Anchored at the **caret**, with a **20px** gap (inset 20).
- Rows add a mark, a name, and a detail ("today", "yesterday"…).
- **Token popover:** 344px, `padding 14px 16px 12px`, 24px mark, 14px/500 name, 13px lede, and a foot of 28px text verbs.

---

## 6. Voice: dictation, live call and "orb"

### Dictation

Sources: `DictationSwap` (`ui/dictation-swap.tsx`) and `ComposerDictation` (`chat/composer-dictation.tsx:520-599`).

- **Swap:** the composer and the dictation capsule share one grid cell and cross-fade on opacity over `--dur-fast` (120ms).
- **Capsule surface:** its own `composer-surface rounded-composer`. It adds `transition-opacity`, which **replaces** the surface's border and shadow transitions.
- **Field area:** `composerFieldClass` + `max-h-40`. Final words are in foreground; interim words in muted.
- **Errors** (no transcription, mic blocked, failed take) appear as muted paragraphs inside the field area. They carry no error colour.

**Row** (`composer-dictation.tsx:135-175`)
- `px-2.5 pb-2.5 **pt-0.5**`. The composer row uses `pt-1.5`, so the dictation row sits 4px higher.
- Left: a ✕ cancel (`composerIconButtonClass`, 32px, 16px glyph).
- Middle: `DictationWaveform` (`mx-2`).
- Right: a "Done" disc at **`size-8` (32px), `bg-primary`**, with a 15px `Check weight="bold"` (the weight is ignored).
- Mismatches with the send disc: send is 36px `bg-foreground`. The comment says the two land "exactly on" each other; they do not.
  - On the landing, the 56px field becomes a 46px field during dictation.
  - With a non-default accent (ultramarine, juniper and so on), the ✓ turns that colour while Send stays graphite.

**Glow:** `JunoVoiceGlow`. Ember while you speak, then a "thinking" handoff while transcribing.

### Live voice call

Sources: `VoiceComposerGlow`, `voiceCallParts` (`realtime-voice.tsx:147-170`) and `composer.tsx:3485-3549`.

- **Leading:** `+`, then `VoiceCallStatus` — a one-word state in `text-ui` muted with `pl-1 pr-1.5`, fading in on change.
- **Trailing:** replaced by `VoiceCallControls` — `CallButton`s at **`size-9` (36px)**, compared with 32px icon buttons at rest. They are interrupt, mute (a mic / mic-off swap), screen share and a settings popover. After a call ends, a "Try again" `h-9` text pill appears.
- **Action:** the red End disc, 36px with `shadow-sm`.
- **Edge light:** the WebGL canvas reaches 44px outside the edge (§1). With reduced motion it is a static tone with 120ms fades.

### Voice entry

- Voice is the primary disc's empty face (§3e).
- Below Pro the disc still shows; pressing it opens a toast and routes to `/upgrade` (`chat-view.tsx:1903-1910`).

### The "orb"

- `VoiceOrb` (`src/components/signature/voice-orb.tsx`) is **not imported anywhere**.
- `.composer-voice-wave` (`globals.css:2146-2165`) is also unused.
- The only voice "orb" a user sees is the grey disc and the edge glow.

---

## 7. Landing (empty chat) vs docked

| | Landing (`frame="landing"` → shell `home`) | Dock (`frame="dock"`) |
|---|---|---|
| Position | Centre of `.chat-home`, a three-row grid (`minmax(0,1fr) auto minmax(0,1fr)`). The composer is at true centre; the greeting rests on it (padding-top 56, margin-bottom 28) (`composer.css:414-445`) | Bottom of the chat column. `pb-[calc(1rem+safe)]`, or `sm:1.5rem`, or only the safe area when a footnote is present (`composer.tsx:2988-2992`) |
| Width | 704 at viewports over 1200px. **660 at ≤1200px** (grid track) | 704 (48rem − 2×32 gutter). 576 with the "narrow" setting, **928 with "wide"** (`globals.css:4745-4747`) |
| Field | 56px min | 46px min |
| Height | 110 | 100 |
| Greeting | "What's next, Liam?" in Newsreader, 50/56px, −0.032em (`composer.css:443-448`) | — |
| Tray | Shown for a brand-new non-private chat (`composer.tsx:2427, 3637-3657`) | Hidden. The media-params row shows when an image, video or audio model is active |
| Starters | `HomeStarters`: 34px rounded-full bordered pills (`control-neu`), 13px, 16px glyphs, gap 8, 30px below the tray (`home-starters.tsx:340-350`, `home-starters.css:20-67`) | — |
| Below | — | Footnote, 12px muted, `min-h-4 sm:min-h-6`, centred. It sits 0–5px under the edge (measured: edge at 876, text at 880–895) |
| Construction drawing | `HomeField`, a dot matrix masked to an ellipse behind the composer, 1080×640 | — |
| Phone (≤760px) | The composer drops to the bottom (grid row 3, `margin-bottom 12 + safe`). Starters move above it. The greeting is centred at 34/40px | Same dock, at 114px tall |

**Tray** (`composer.css:567-795`, `composer-tray.tsx:128-190`)
- A shelf tucked 18px under the composer: `margin: -18px 14px 0`, padding `24px 6px 6px`.
- **Bottom radius 20px** (14 + 6) under a 26px composer, so the corners are not concentric. On coarse pointers it is 32px.
- Fill: `fg/0.035` over `--background`. No border or shadow. `z-index:-1`.
- Items: **28px**, padding 0 9px, **radius 14px** (pill), **13px** type in `--cmp-ink-2`, 16px glyphs, **14px** chevrons. Hover `fg/0.055`, open or active `fg/0.085`, press scale 0.97.
- Contents: Project ⌄, Apps ⌄ (connector marks overlap by −6px), Skills ⌄, and Mac app at the end. Mac app is hidden ≤480px; the Project word is hidden ≤339px.
- Arrival: `chat-home-tray` runs 560ms on `--alv-ease` (expo-out), translate −10px, delayed 220ms. The title runs `chat-home-rise`, 18px, 560ms, delayed 70ms (`composer.css:479-498`).

### Landing → dock transition

Source: `chat-view.tsx:1795-1890`.

**Sequence**
1. Send from the empty composer arms `handoff`.
2. When `hasMessages` flips within 8 seconds, the phase becomes "leaving". The greeting plays `title-out` (160ms ease-in: opacity to 0, −4px, scale 0.985), the starters hide, and the composer holds still.
3. After `--dur-exit` (160ms), the phase becomes "entering". React swaps the subtrees and the dock composer is a **fresh mount**.
4. A WAAPI `translateY(dy) → 0` runs over `--dur-slow` (360ms) `--ease-out-expo`, but only if the distance is over 12px. The transcript fades in beneath it.
5. The flag clears at 600ms.
6. With reduced motion, the swap is plain.

**What is not choreographed**
- The tray disappears with no exit.
- The field height drops from 56 to 46 instantly, so the box is 10px shorter at the start of its travel.
- At ≤1200px the width jumps from 660 to 704 (or to 576/928 with the narrow/wide setting).
- The construction drawing vanishes.
- The two outer track heights collapse.
- Composer component state is lost on remount. The draft survives through `draftSession`; other state, such as the `+` open state and the slash index, does not.

---

## 8. Mobile behaviour

**Detection.** Coarse-pointer styles use `coarse:` variants and `@media (pointer: coarse)`. Width breakpoints are 360, 480, 639/640 and 760px.

**Control sizes on coarse pointers**

| Control | Size |
|---|---|
| Icon buttons, disc, model chip | 44px |
| Task chip | **40px** |
| Tray items | 44px |
| Palette rows | 44px |
| `.cmenu` rows | 44px |
| Popover verbs | 44px |

**Composer and field**
- The composer is 114px tall at rest. The field keeps 16px padding and a 52px minimum.
- 16px text prevents iOS focus zoom.

**Model chip**
- The name shortens below `sm` (`chipShortName`).
- `useChipFit` measures the row's slack.
- Below 360px only the mark shows.

**Other controls**
- **`+` menu:** drill-in panels below 640px.
- **Catalogue:** on touch, focus does not go to the search field (avoids raising the keyboard).
- **Task chip:** at the default, its chevron is hidden below 640px. The dock-mobile screenshot shows "✋" with no chevron next to "Auto ⌄".

**Keyboard and gestures**
- Return on a touch keyboard inserts a newline; there is a separate send gesture (`lib/touch-keyboard.ts`, `composer.tsx:2133-2141`).
- Hover-reveal affordances (attachment ✕, armed-mark ✕) are always shown on coarse pointers.

**Viewport**
- `viewport` sets `viewportFit: "cover"` with no `interactiveWidget` (`src/app/layout.tsx:111-128`).
- Nothing tracks `visualViewport` for the dock. Android's default `resizes-visual` behaviour with the soft keyboard has not been checked on a device.

---

## 9. Drag and drop

Sources: `composer.tsx:1065-1068, 3076-3113` and `library-drop-zone.tsx` (`useFileDrop`).

- The drop target is **only the composer wrapper**. A drag must land on the 704×100 box; there is no window-level drop zone.
- Only drags that carry files activate it. It is refused in private mode or when storage is off.
- The visual treatment is the triple edge described in §1 (Drag over), fading in over 220ms.
- On drop, `addComposerFiles` runs, then tiles pop in (§4).

---

## 10. Motion inventory (composer only)

| Interaction | Motion | Timing |
|---|---|---|
| Hover fills (chips, icon buttons, tray) | background and colour | 120ms ease-out-soft |
| Press (disc, tray, `pressable`) | scale 0.97 | 70ms |
| Menu row press | scale 0.985 | 70ms |
| `+` glyph open | rotate 45° | 220ms in-out (instant from keyboard) |
| Chevron open | rotate 180° | 220ms ease-out-soft (chips) or in-out (tray) |
| Disc face swap | opacity + scale 0.5 ↔ 1, overlapping (`mode="sync"`) | 120ms ease-out-soft |
| Disc fill change | background via `.pressable` | 120ms |
| Row dim while streaming | opacity → 0.6 | 120ms |
| Field growth | snap | 0 |
| Attachment tile in/out | opacity + scale 0.9, layout | spring.standard 0.22s / bounce 0.05 |
| Quote card | rise-in 6px / pop-out | 220 / 120ms |
| Armed mark | pop-in (4px, scale 0.96) | 220ms ease-spring |
| Context token settle | fill from well-3 to well | 220ms |
| `/` and `@` palettes | none | 0 |
| `+` and task menus (`.cmenu`) | translate 6px + scale 0.96, content fill +70ms; out scale 0.97 | 220ms expo / 120ms |
| Model popovers (`PopoverContent`) | pop-in 4px + scale 0.96 / pop-out | 220ms ease-spring / 120ms |
| Model label change | fade-in | 220ms |
| Surface focus | border 120ms; **shadow 360ms** | — |
| Keyboard ring | `::after` opacity | 120ms |
| Drag overlay | fade-in | 220ms |
| Dictation ⇄ composer | opacity cross-fade | 120ms |
| Voice glow | WebGL, per frame; reduced motion: static | — |
| Landing arrival | title rises 18px over 560ms +70ms delay; tray drops −10px over 560ms +220ms delay | `--dur-emphasis` |
| Landing → dock | title-out 160ms, then remount, then translateY over 360ms expo-out | — |

---

## 11. What looks unpolished compared with ChatGPT and Claude (2026)

**Reference points**, from current public builds; values are approximate unless noted.

**ChatGPT web**
- At rest the composer is a **single-line pill**, about 52–56px tall, fully round. OpenAI's own Apps SDK UI tokens give `--composer-radius: 24px` and `--composer-gutter: 12px` (`scratchpad/design-dir/ext/apps-sdk-ui/src/styles/variables-components.css:100-104`).
- Controls: `+` on the left; mic and a **solid black voice disc** on the right.
- The disc morphs in place to a black send disc with a heavy up-arrow, and later to a stop square.
- The pill grows into a two-row box for multi-line text or attachments.
- The model picker lives in the header.
- Files can be dropped anywhere in the window (full-page overlay).

**Claude web**
- Two-tier box, about 20px radius, 0.5–1px edge, faint shadow.
- Controls: `+` and tool buttons at the bottom left (32px, 8px radius); the model name at about 14px with a chevron and a **32px accent send button** at the bottom right.
- The send button is pale when disabled.
- Category pills sit under the landing composer.

Items are ordered by visual cost.

### Alignment

1. **The `+` glyph is 3px right of the text column.** Visible stroke starts at 308; the text starts at 305. The disc's right edge (980) overshoots the text's right edge (975) by 5px. The shell's own comment says both edges share the text inset.
2. **The inner margins are top-heavy and asymmetric.**
   - Measured from the 1px edge:
     - 22px down to the placeholder cap (16px `pt-4`, plus half-leading);
     - 19px to the left of the `+` glyph;
     - 11px under and to the right of the disc.
   - On the landing, the 56px field leaves a 14px dead band between the placeholder and the row. You can see it in `composer-landing-*`.
   - ChatGPT and Claude both use roughly even 10–12px margins around their controls.
3. **Content above the field uses three different insets.**

   | Content | Horizontal inset | Top inset |
   |---|---|---|
   | Attachment row | 14px (`px-3.5`) | 14px |
   | Quote and large-paste cards | 16px (`mx-4`) | 14px |
   | Long-text hint | 16px | 12px (`pt-3`) |

   Tiles therefore sit 2px left of the text column, and the attachment comment's "concentric with a 22px corner" is stale (the corner is 26px).
4. **The landing width does not match the dock width.** At viewports ≤1200px the landing composer is 660px (grid track) and the dock is 704px, so the box gains 44px on first send. With the narrow or wide transcript setting the difference is 128px or 224px.
5. **The tray's corners are not concentric with the composer's.** The tray uses 20px bottom corners under a 26px composer, inset 14px each side. Its pills are 28px tall with 14px radius; the composer chips are 32px with 8px radius. Two chip shapes are stacked on top of each other.
6. **The keyboard-focus ring's `::after` uses a plain 26px radius.** The surface uses `corner-shape: superellipse(1.5)` where supported, so the ring and the edge separate at the corners.

### Spacing rhythm

7. **Gaps on the row are uneven.** Code gaps are 2 / 4 / 2px. The visible spacing between glyphs is 27px (task → model), 29px (model → mic) and 13px (mic → disc). So the mic reads as attached to the disc and the two chips float. ChatGPT's right cluster uses one steady 8px rhythm between 36px buttons.
8. **Chip padding changes with state.** The task chip is `px-2` at the default and `px-2.5` off it. The model chip's intended asymmetric 11/8 padding is dead CSS, so it renders 10/10.
9. **The footnote nearly touches the composer.** "Alevr can make mistakes…" starts 4px under the edge, inside a 24px line box. ChatGPT leaves about 8–10px and a lighter line.
10. **The landing stacks three tiers of controls at three heights.** Row 32px, tray 28px, starter pills 34px. Starters sit 30px below the tray. That is 14 interactive objects around an empty field (5 on the row, 4 in the tray, 5 starters). Claude shows 4 controls and 5 pills; ChatGPT shows 3 controls.

### Icon weights and sizes

11. **One row uses up to seven glyph sizes.**

    | Glyph | Size |
    |---|---|
    | `+` | 20px |
    | Mic, voice, send | 18px |
    | Stop, spinner, model chevron | 16px (the chevron through the CSS override) |
    | Hand, model mark | 14px |
    | Task chevron | 12px |

    Because the family's stroke depends on size, they also mix line weights: 1.25px at 16px, 1.5px at 18px and up, and a small bold cut at 12px and under. Claude uses one 16–18px set on its row.
12. **The icons are darker than the words.** `--icon-muted` (#3D3F43, 25% L) colours `+`, hand, mic and the model chevron, while the model name is `--muted-foreground` (#686B70, 42% L). The chevron is visibly darker than "Claude Opus 5.5" (model-picker screenshot). The same holds in dark mode: #C4C6CA icons against #95979C labels.
13. **The two chevrons side by side differ.** The model chevron is 16px at full ink (`.composer-model-chip > svg`, specificity (0,1,1), overrides `size-3 opacity-70`). The task chevron is 12px at 70%. The tray chevrons are a third size, 14px.
14. **The send arrow is thin.** `Send weight="bold"` and the dictation `Check weight="bold"` both fall back to the family's one line (about 1.5px). ChatGPT's and Claude's send arrows are clearly heavier against their solid fills. The comment at `composer-shell.tsx:713-715` describes a bold cut that is never drawn.
15. **The primary disc's glyph is lighter than its neighbours.** The waveform renders #686B70 (dark: #95979C), lighter than the mic beside it (#3D3F43 / #C4C6CA), because the `motion.span` wrapper misses the glyph-ink rule.

### Button sizes

16. **The primary slot changes size between modes.**

    | Mode | Primary disc |
    |---|---|
    | Normal (send) | 36px `bg-foreground` |
    | Dictation (✓) | **32px** `bg-primary`, with the row raised 4px (`pt-0.5` vs `pt-1.5`) |
    | Call (End) | 36px red with `shadow-sm` |

    The secondary buttons also change: 32px at rest, 36px in a call. Every mode swap shifts the row's geometry, although the comments say these land exactly on each other.
17. **Touch targets are inconsistent.** Icon buttons, the model chip and the disc are 44px on coarse pointers; the task chip is **40px** (`composerChipClass coarse:h-10`).
18. **The attachment remove control is weak.** It is a 24px dark *square* (6px radius) inside the tile's top-right corner and only appears on hover. ChatGPT and Claude use a round ✕ badge that sits on the corner and is always discoverable.

### Hierarchy

19. **At rest, the strongest object is not the primary action.** The voice disc is `bg-secondary` (#EFF0F1 on white; dark #2D2E31 on #222326, a difference of about 4% L) with a muted glyph. It is the faintest control on the row, while `+` and mic are the darkest. ChatGPT's empty state leads with a black voice disc; Claude's disabled send still reads as the send button.
20. **The right cluster is crowded.** It has four objects (unlabelled "✋⌄", "Auto ⌄", mic, disc) where both references have two. At the default the task chip is an icon and a chevron with no word; its meaning ("how often tasks ask") is invisible.
21. **The model label is undersized.** It renders at 12px/500 (`text-label`), smaller than the tray labels (13px), the starter labels (13px) and Claude's model name (about 14px). The 14px/400 the CSS intended is dead because of source order (`composer.css:370` loads before the utilities).
22. **The landing reads as two toolbars.** The tray (Project, Apps, Skills, Mac app) is a second chrome row under the box. It is visually close in tone to the composer and competes with it. The "Mac app" download link sits at the same level as the actions.
23. **Copy and states that read as borrowed.**
    - The landing placeholder is Claude's exact "How can I help you today?".
    - The quota banner is an 8px-radius rectangle stacked on a 26px squircle.
    - The private-mode dashed border on a squircle corner draws uneven dashes.

### State morphs

24. **Sending probably flickers through the voice face** (inferred from the code; needs a frame capture to confirm).
    - **Cause.** During submission the draft is still present, but `canSend` is false because `sendBlocked` includes `submitting`. With `voiceAvailable` true, the face logic selects `voice` until `isBusy` flips.
    - **Normal send.** The disc can go ink (send) → grey (voice) → ink (stop).
    - **With clarify preflight.** It goes ink → grey with a spinner (busy and disabled) → ink.
    - **Why it shows.** The 120ms overlapping scale-from-0.5 swap makes each step visible as a blink.
    - **Reference.** ChatGPT goes straight from send to stop.
25. **The face swap overlaps.** `mode="sync"` with scale 0.5 ↔ 1 draws two glyphs at once mid-transition (for example waveform and arrow). The cleaner pattern is an exit then an entrance (`mode="popLayout"` or `"wait"` at about 80ms), or a crossfade at scale 0.8.
26. **Dimming while streaming is inconsistent.**
    - The row drops to 60%, but the `+` remains fully interactive at 60% (it looks disabled and isn't).
    - The model chip and mic are disabled on top of that, landing at about 30%.
    - The result is three opacities on one row.
    - ChatGPT keeps the controls readable and only swaps send for stop.
27. **Height changes jump, except for one tile.** Adding an attachment, quote or long-text hint makes the box about 78px, 60px or 40px taller in one frame. Only the tile itself springs. Because the dock is at the bottom of the column, the top edge jumps up and the transcript reflows. Typing growth snaps by design, but attachments could animate the `above` height (for example, framer `layout` on the shell or a grid-rows 0fr→1fr trick).
28. **Landing → dock is not a shared-element move.**
    - The composer remounts, and the tray, the 10px of field height, the construction drawing and (at ≤1200px) 44px of width all change in one frame.
    - The only animated property is `translateY` (360ms).
    - In ChatGPT the box glides down unchanged and the greeting dissolves.
29. **Focus timing is mismatched.** The edge darkens in 120ms while the shadow deepens over 360ms, so the edge snaps and the lift lags. A single 160–220ms value would read as one change.
30. **Menus from the same row use three different materials.**

    | Surface | Recipe | Radius | Padding | Entrance |
    |---|---|---|---|---|
    | `+` and task menus | `.cmenu` | 18px | 6px | 220ms expo, translate 6px, delayed content fill |
    | Model popovers | `surface-float` / `pop-in` | 14px | 12px | 220ms spring, 4px |
    | `/` palette | `.composer-layer` | 14px | — | none; 420px wide, 4px gap, anchored at the composer edge |
    | `@` palette | `.composer-layer` | 14px | — | none; 372px wide, 20px gap, anchored at the caret |

31. **The same tool shows two different on-states.** Web search and Memory show as a **switch** (28×16) in the `+` menu and as a **tick** in the `/` palette. Ticks are `text-primary` in the `+` and task menus and `text-foreground` in the palette. A code comment at `composer-plus-menu.tsx:252-260` says both moved to the tick; only radio rows did.
32. **The drag state is heavy.** It draws a primary border, a 2px primary ring (which also wipes out the lift shadow), and an inner 2px dashed border with a tint. That is three outlines on one box. The drop zone is also only the composer, while both references accept a drop anywhere in the window.
33. **Two smaller mode-swap seams.**
    - **Dictation.** The cross-fade is fine, but the capsule's `transition-opacity` cancels the surface's edge and shadow transitions, and on the landing the field shrinks from 56 to 46px.
    - **Live call.** The edge glow is polished, but the row's controls grow from 32 to 36px and the only drop shadow on the row appears (End).

### Hygiene: spec drift that hides the problems above

34. **Comments state geometry that the code no longer has.**

    | Comment says | Code has |
    |---|---|
    | Corner radius 22px | 26px |
    | Primary disc 32px | 36px |
    | Face swap from scale 0.9 | from 0.5 |
    | Field 45px / `2.8125rem` | 46px / `2.875rem` |
    | Text column 20px | 16px |
    | Model chip: "No logo", 14px, pill | Shows a mark; 12px; 8px radius |
    | Dictation disc "exactly on" the send disc | 32px vs 36px, row 4px higher |
    | `+` "A tick, not a Switch" | Toggle rows draw a switch |

    Each is a place where a reviewer reads the comment and approves the wrong thing.
35. **Dead code that still invites edits.**
    - `.composer-model-chip` declarations except the `> svg` rule.
    - `.composer-voice-wave`.
    - `VoiceOrb`.
    - `--transcript-fade`.
    - `ComposerDivider`.

---

## 12. Suggested fix order

Ordered by visual return per line changed.

1. **Primary disc.**
   - Make the empty voice face an ink disc, or at least `bg-foreground/90`.
   - Wrap disc glyphs so they get `--icon-*` ink.
   - Add a real bold send arrow (about 2px line).
   - Swap faces with `mode="popLayout"` and scale 0.8, or cross-fade.
   - Pin the face to `send` while `submitting` (fixes item 24).
2. **One icon set on the row.**
   - Use 18px glyphs for `+`, mic, voice and send (`+` currently 20).
   - Use 16px for marks; use one chevron of 12px at 70% everywhere; delete the `.composer-model-chip > svg` override.
   - Make labels and icons one ink: either both `--icon-muted` or both `--muted-foreground` at rest.
3. **Row geometry.**
   - Use one gap (6–8px) between trailing objects.
   - Seat the `+` glyph on the text column; use 12px row padding all round.
   - Reduce the landing field to the dock's 46px.
   - Put the model label at 13–14px/400 and delete the dead CSS block.
4. **One popover material** for the `+`, task, model and palette layers: one radius, one padding, one entrance. Give `/` and `@` the same width and gap.
5. **Landing → dock.**
   - Make the landing width equal to the dock width at every breakpoint and transcript setting.
   - Fade the tray out during the exit beat.
   - Animate height alongside the existing translate, or keep one mounted composer and use a FLIP.
6. **Attachments.**
   - Use a 16px inset for every `above` item.
   - Give the remove control a round corner badge.
   - Animate the `above` height.
   - Add retry on "Failed".
7. **Dimming and states.**
   - Dim only what is disabled; don't dim the live `+`.
   - Raise the task chip to 44px on coarse pointers.
   - Make the dictation ✓ 36px `bg-foreground`, with the same `pt-1.5`.
   - Simplify drag to one edge change plus an overlay, and add a window-level drop zone.
