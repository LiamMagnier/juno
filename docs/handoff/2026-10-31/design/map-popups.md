# Alevr web: pop-up and overlay surfaces (design map)

Read-only audit of `/home/user/juno` at `70661166c`. No source was modified.
All values below come from the code (file:line). The screenshots in `scratchpad/shots/` show only one overlay open: the memory-updated notice, in `thread-light.png` and `thread-dark.png`. Every other surface was mapped from source.

Reference values used for the "premium" comparisons:
- **ChatGPT.** OpenAI Apps SDK UI, in `design-dir/ext/apps-sdk-ui/src/styles/variables-components.css:120-155`. Dialog max-width is 450px with 20px inner padding. The backdrop is `rgb(0 0 0 / 30%)` in light and `/50%` in dark. Popovers and menus use one 12px radius. A popover enters over 350ms from scale 0.95 on `cubic-bezier(0.19,1,0.22,1)` and exits over 200ms.
- **Apple and Claude.** These are general platform conventions, labelled as such where used: one sheet idiom, one close affordance, a pinned header and footer, and a separate elevation for modals.

---

## 0. Shared foundations (what every overlay is supposed to read from)

| Token | Value | Where |
|---|---|---|
| Scrim | light `hsl(48 12% 8% / .26)`; dark `hsl(0 0% 0% / .55)` | `src/app/globals.css:698`, `:950` |
| Scrim note | The dark comment says "the 2px backdrop blur on the overlay does the rest". **No overlay has a backdrop blur** (`dialog.tsx:55`). The comment describes nothing that exists. | `globals.css:946-949` |
| Float material | `.surface-float`: `--popover` fill, `border /.9`, `--shadow-float` | `globals.css:1529-1535` |
| "Glass" material (opaque) | `.overlay-glass`: same fill, `border /.7`, `--shadow-float`. When both classes are applied it wins on source order. | `globals.css:2230-2236` |
| Float shadow (light) | `0 0 0 1px ink/.03, 0 4px 12px -2px ink/.06, 0 24px 56px -16px ink/.22` | `globals.css:676` |
| Float shadow (dark) | `0 0 0 1px hsl(45 20% 96%/.05), 0 4px 12px #000/.35, 0 18px 44px -12px #000/.6` | `globals.css:937` |
| Legacy "glass" shadow | `0 2px 6px /.05, 0 14px 36px -10px /.16`. A lighter rung that only the memory notice uses. | `globals.css:684` |
| Surface contrast | Light: page `--background` 99.0% L, panel `--popover` 100% L. Dark: page 10% L, panel 16% L. | `globals.css:86,94,786,792` |
| Radius ladder | control 8 · field 10 · card/popover 12 · menu 14 · **panel 16** · composer 26 · stage 28 | `tailwind.config.ts:216-232` |
| Z ladder | panel 30 · aura 40 · **modal 50** · popper 55 · toolbar 60 · toast 70 | `globals.css:711-723`, `tailwind.config.ts:302-307` |
| Motion rungs | press 70 · fast 120 · exit 160 · base 220 · slow 360 · emphasis 560 ms | `globals.css:498-506` |
| Curves | spring `(.22,1,.36,1)` (overshoot-free, despite its name); drawer `(.32,.72,0,1)`; in `(.4,0,1,1)`; out-expo `(.16,1,.3,1)` | `globals.css:471-497` |
| Modal keyframes | `modal-in` = pop-in 220ms spring (scale .96 + 4px rise). `modal-out` = pop-out 160ms ease-in. `overlay-in` 120ms, `overlay-out` 220ms. | `tailwind.config.ts:943-944, 961-962, 775-790` |
| Popper keyframes | `pop-in` 220ms spring; `pop-out` **120ms**. The comment claims "~2% overrun", but the curve has none. | `tailwind.config.ts:937-940` |
| Type rungs | title 22/1.25/600 · **heading 18/1.3/600** · body 15/1.6 · nav 14/20 · ui 13/1.5 · caption/label 12 | `tailwind.config.ts:490-564` |

---

## 1. Primitives

### 1.1 `Dialog`: `src/components/ui/dialog.tsx`

| Property | Value | Line |
|---|---|---|
| Panel | `.ui-dialog .overlay-glass fixed centred grid gap-4 overflow-y-auto rounded-panel(16)` | 107 |
| Width | `w-[calc(100%-2rem)] max-w-lg` (512px default); `max-h-[calc(100dvh-2rem)]` | 107 |
| Padding | `p-5` (20) below 640px, `sm:p-6` (24) | 107 |
| Centring | the independent `translate` property (`[translate:-50%_-50%]`), so the keyframe owns `transform` | 107 |
| Scrim | `fixed inset-0 z-modal bg-scrim`, overlay-in 120ms / overlay-out 220ms, no blur | 55 |
| Elevation | `--shadow-float`, identical to a menu, popover, toast or tooltip-card | via `.overlay-glass` |
| Close | `<Pressable kind="icon" size="lg">`: 36px circle (44 on coarse pointers), 16px glyph, `absolute right-4 top-4`, rendered **after** the children | 27-37, 116 |
| Header | `flex flex-col space-y-1.5 text-center sm:text-left`. **No right gutter for the ✕.** | 123-125 |
| Footer | `flex flex-col-reverse gap-2 sm:flex-row sm:justify-end`: primary on top on a phone, Cancel → Primary on desktop. No divider, not sticky. | 127-130 |
| Title | `font-sans text-heading font-semibold tracking-[-0.01em]` (18/600). The tracking override fights the token's own -0.006em. | 137 |
| Description | `text-body text-muted-foreground` (15px) | 145 |
| Motion | in: `modal-in` 220ms spring from .96/+4px. out: `modal-out` 160ms ease-in. The scrim leads by 100ms and trails by 60ms. | 107 |
| Phone (<640) | A bottom sheet via `sheet.css:122-153`: full width, top radius 16, rises 360ms on the drawer curve, sinks 220ms ease-in, 36×4 grabber, swipe to dismiss (`useSwipeDismiss`), follows the keyboard. Opt out with `sheet={false}`. | 82-97, 114 |
| Keyboard and focus | Radix: Esc closes, focus is trapped, scroll is locked. `useDialogFocusReturn` returns focus to the real opener, including menu triggers and the caret in a contenteditable. | 95, `focus-return.tsx:24-80` |

**Structural defects in the primitive**
1. **The ✕ scrolls away.** The panel itself is the scroller (`overflow-y-auto`, l.107) and the ✕ and the phone grabber are `absolute` children of it. In any dialog taller than the viewport, the close button and the grabber leave with the content. ChatGPT, Claude and Apple all pin the header and footer.
2. **No title gutter.** `DialogHeader` has no `pr-*`. In a `max-w-sm` dialog (384px, 336px text column) any title over roughly 308px runs under the 36px ✕. Call sites patch this by hand: `library-quick-look.tsx:223` uses `pr-14`, `work-site-preview.tsx:624/780` use `pr-10`, and `preferences.tsx:421` uses `pr-12`.
3. **The ✕ does not line up with the title.** On a coarse pointer the ✕ grows to 44px at top 16px, so its centre is at 38px. The phone title centre is at 20 + 11.7 = 31.7px, so the two are 6.3px apart. `preferences.tsx:418-421` documents this ("landed 6px below its centre on a phone").
4. **`sm:p-6` leaks.** `cn()` (tailwind-merge) drops `p-5` when a call site passes `p-0`, but it keeps `sm:p-6`. Five dialogs therefore pick up an unintended 24px frame at ≥640px:
   - `onboarding.tsx:185`
   - `mermaid-block.tsx:226`
   - `checkout-sheet.tsx:62`
   - `suggestion-compare-dialog.tsx:304`
   - `import-dialog.tsx:158`

   In the last two, the full-bleed `border-t px-6 py-4` footer is inset by 24px, so its hairline stops short of the panel edge. `command-palette.tsx:271-274` documents the same trap and patches it with `sm:p-0`.

### 1.2 `Sheet`: `src/components/ui/sheet.tsx` + `sheet.css`

| Property | Value | Line |
|---|---|---|
| Material | `.ui-sheet .overlay-glass fixed z-modal` | sheet.tsx:73 |
| Left/right | `inset-y-0 h-full w-[280px] max-w-[85vw]`; radius 16 on the inner edge only (`rounded-r-panel` / `rounded-l-panel`); safe-area padding | 76-78 |
| Bottom | `inset-x-0 bottom-0 max-h-[100dvh - safe-top - 1.5rem] rounded-t-panel` + grabber | 75, 88 |
| Scrim | `--scrim`. With `scrim="mobile"` (default) it is `md:hidden`; `"always"` draws it at every width. | 61-66 |
| Title | Built in and visually hidden (`title="Navigation"` by default) | 85-87 |
| Close | None built in; each call site draws its own (see §2.13) | n/a |
| Motion | side: `sheet-in` 220ms drawer / `sheet-out` 160ms ease-in (`tailwind.config.ts:921-922`). bottom: `ui-sheet-rise` 360ms drawer / `ui-sheet-sink` **220ms** ease-in (`sheet.css:76-81`) | |
| Gesture | Drag back to the edge; edge-pull to open (`edgeSwipe`); dismiss on velocity ≥ 0.5 px/ms or offset ≥ 30% (`lib/sheet-gesture.ts:22-24,102-107`) | 52-57 |
| Grabber | 56×20 hit area; 36×4 pill at top 7px in `hsl(foreground/.18)` | sheet.css:85-115 |
| Focus | Radix trap + `useDialogFocusReturn` | 50 |

### 1.3 `BottomSheet`: `src/components/ui/bottom-sheet.tsx` (a third sheet implementation)

| Property | Value | Line |
|---|---|---|
| Panel | `overlay-glass fixed inset-x-0 bottom-0 z-modal max-h-[88dvh] rounded-t-panel border-b-0 pb-safe`. `tall` sets `h-[88dvh]`. | 160-161 |
| Grabber | In-flow 24px band; 36×4 pill in **`bg-muted-foreground/35`**, a different ink from `sheet.css`'s `foreground/.18` | 172-174 |
| Motion | Own keyframes injected as `<style>`: in 360ms drawer, out **160ms** (`--dur-exit`) ease-in. `sheet.css` sinks in 220ms. | 26-39 |
| Gesture | Own pointer code. Drag works **only from the grabber or `[data-sheet-drag]`**, not from anywhere on the sheet. Dismiss at 0.5 px/ms with >24px travel, or past `max(80, h/3)`. `sheet-gesture.ts` uses 0.3·h with no floor. | 91-130, 187-190 |
| Missing | No `useDialogFocusReturn`. No keyboard-inset handling (`--sheet-keyboard`), so the feedback note field can sit under the iOS keyboard. | n/a |
| Consumers | `message-feedback.tsx:170` (phone only), `activity-timeline.tsx:544` (thought process) | |

### 1.4 `Popover`: `src/components/ui/popover.tsx:28-41`
`surface-float overlay-glass z-popper w-72 (288) p-4 rounded-popover (12)`, `sideOffset 4`, `collisionPadding 8`, pop-in 220ms spring and pop-out 120ms ease-in. There is no phone variant; it stays a floating card at every width.

### 1.5 Tooltip: `src/components/ui/tooltip.tsx:48-64` + `globals.css:4822-4849`
An ink label: `rounded-control (8)`, `px-2.5 py-1.5`, `text-label` (12/500). It has its own fill (`hsl(222 9% 12%)`) and its own shadow, off the elevation ladder. Delay 200ms, skip 400ms, 120ms in and out.

### 1.6 Toasts: `src/components/ui/sonner.tsx` + `globals.css:3930-4100`

| Property | Value | Line |
|---|---|---|
| Position | `bottom-center`; offset `8rem` on composer routes, `1.5rem` elsewhere; mobile `7rem`/`1.25rem` with 0.75rem sides | sonner.tsx:89-104 |
| Card | `rounded-card (12) surface-float text-ui pr-9`. Sonner defaults: 356px wide, 14px gap, 3 visible, 4000ms. | 114 |
| Icons | 16px glyphs from the product set: success `CheckCircle2` success-ink; error destructive-ink; warning; info muted; loading GalaxyMark | 58-65 |
| Close | 24px drawn / 32px hit, inside the top-right corner, radius `12-4=8`, accent on hover | globals.css:3958-3994 |
| Description | `--muted-foreground` | 4041-4043 |
| Action buttons | 32px, `padding 0 12px`, **radius 10px** (`Button` uses 8), `--secondary` fill + hairline, 13/500. Cancel is a ghost. | 4066-4114 |
| Motion | in `--dur-slow` (360) on out-expo; out `--dur-exit` (160) ease-in | 4020-4027 |
| Z-index | **Sonner default `999999999`**. `--z-toast: 70` is declared and never applied to the toaster. | node_modules/sonner/dist/styles.css |
| Keyboard | Sonner hotkey Alt+T focuses the region | sonner default |
| Fork | The design editor host mounts **stock `sonner` with `richColors`**, which gives stock green/red tinted toasts. | `src/components/design/host/main.tsx:18,73` |

---

## 2. Product surfaces

### 2.1 Confirm and alert dialogs (generic pattern)
There is **no `AlertDialog` / `ConfirmDialog` primitive** (no `@radix-ui/react-alert-dialog` in `package.json`). About 45 confirms are hand-assembled from `DialogContent` + `DialogHeader` + `DialogFooter`.

Representative examples:
- **Delete conversation/project.** `app-sidebar.tsx:2085-2105`: `max-w-sm`, ghost Cancel then destructive confirm.
- **Rename project.** `app-sidebar.tsx:2108-2131`: `max-w-sm`; Enter submits through the input's `onKeyDown`; busy shows the label "Renaming…".
- **Trash/restore artifact.** `artifact-lifecycle-actions.tsx:341-369`: `max-w-sm`; the dialog cannot be closed while busy.

Census of the 77 product `DialogContent`s:

| Aspect | Variants found |
|---|---|
| Width | `max-w-sm` 384px ×21 · `max-w-md` 448 ×26 · default `lg` 512 ×6 (e.g. `agent-panel.tsx:611`, `agent-computer.tsx:584/603/630`, `agent-thread-header.tsx:280`, `code-work-list.tsx:307`) · `2xl` ×4 · `3xl` ×3 · `5xl` ×2 · `[40rem]`, `[52rem]`, `[58rem]`, `[60rem]`, `420px`, `36rem`, `72rem`. "Delete X?" confirms alone use 384, 448 and 512. |
| Cancel variant | `ghost` in about 40 footers. **`outline`** in 7: `agent-panel.tsx:628`, `agent-computer.tsx:610,637`, `agent-thread-header.tsx:287`, `account-security.tsx:263`, `memory-footer.tsx:129,178`. `destructive-outline` used as a third button: `canvas-draft-ui.tsx:112`. |
| Footer shape | 2 buttons (most) · 3 buttons with `sm:justify-between` (`memory-footer.tsx:129`; also a Done/Cancel/Submit trio at `account-security.tsx:681`) · 4 buttons (`canvas-draft-ui.tsx:112-133`) · bordered full-bleed footers at `/50` (`import-dialog.tsx:264`, `suggestion-compare-dialog.tsx:396`) vs `/60` (`assistant-studio.tsx:316`) · `gap-2 sm:gap-0`, which **butts Cancel against Attach** on desktop (`library-picker.tsx:243`) |
| Busy state | `loading` prop with a cross-faded spinner (`session-expired-dialog.tsx:133`, `cancel-subscription.tsx`, `memory-footer.tsx`) · label swap "Renaming…/Saving…" (`app-sidebar.tsx:2128`, `add-mcp-server-dialog.tsx:301`, `artifact-lifecycle-actions.tsx:372`) · manual `Loader2` beside the label (`library-picker.tsx:250`, `code-run-cards.tsx:1296`) |
| Close lock while busy | Only some: `canvas-draft-ui.tsx:91`, `artifact-lifecycle-actions.tsx:335`, `add-mcp-server-dialog.tsx:143`. The rest can be dismissed mid-request. |
| Initial focus | Radix default: the first focusable, i.e. Cancel (the ✕ comes later in the DOM). Return activates Cancel, which is safe but differs from macOS, where Return fires the default button. |

### 2.2 Incognito-leave dialog: `src/components/chat/incognito-leave-dialog.tsx:46-86`
- **Layout.** `max-w-sm`, `role="alertdialog"` (an override on a Radix Dialog, l.53), `hideClose`. Title and description use the default rungs. A checkbox row reads "Don't ask again" (`text-ui`, `gap-2.5`). The footer has a ghost **Keep chatting** (focused on open, l.57-60) and a primary **End chat**.
- **Keyboard.** Esc or Return keeps the chat. A click outside still dismisses (→ `onKeep`). A true alert dialog blocks outside dismissal.
- **Phone.** House bottom sheet with a grabber and no ✕.
- **Inconsistency.** It is the only dialog with `role="alertdialog"`. The session-expired dialog interrupts just as hard and is a plain `dialog` with a ✕.

### 2.3 Session-expired dialog: `src/components/chat/session-expired-dialog.tsx:117-138`
- **Layout.** `max-w-sm`, default ✕, default rungs. The footer has ghost **Not now** and primary **Sign in again** (`loading`).
- **States.** Five copy variants (l.107-115). The ✕ and Not now do the same thing (two dismissals).
- **Focus.** Radix default, which is "Not now" by DOM order.
- **Phone.** House sheet.

### 2.4 Settings modal: `src/components/settings/settings-modal.tsx:78-145` (+ section sheet + page)

| Property | Desktop (md+) | Phone (<768, **not** the 640 sheet breakpoint) |
|---|---|---|
| Frame | `md:h-[min(86dvh,46rem)] md:w-[calc(100%-3rem)] md:max-w-[58rem]`, `p-0`, radius 16 (l.98) | `h-dvh w-full rounded-none border-0`, full screen (l.99), `sheet={false}` |
| Rail | `md:w-60` (240) behind `border-r border-border/60`; label `text-heading` + `⌘,` Kbd (l.121-125) | Becomes one 44px section-menu button that opens a **second dialog** (`settings-rail.tsx:434-454`): a bottom sheet `h-[min(85dvh,44rem)] sm:max-w-sm` over the full-screen modal, i.e. a stacked scrim (.26 + .26) |
| Close | `CloseButton` at `right-3 top-3` (12px, not 16) with a tooltip (l.136) | `static` in a phone bar `pl-5 pr-3 pt-2 pb-1` beside the "Settings" label (l.114-119) |
| Title | `sr-only` DialogTitle; visible label `text-heading` (600) | the section sheet title is `text-heading font-medium` (**500**) (`settings-rail.tsx:454`) |
| Pane | `max-w-2xl px-5 sm:px-8 pt-6 md:pt-9 pb-14` (l.138) | same |
| Motion | **Its own recipe:** pop-in 220ms on **ease-out-soft** (not spring), from 0.97, no rise. Out on **120ms** `--dur-fast` (dialogs use 160) (l.104-105) | 24px rise, scale 1, opacity |
| Keyboard | ⌘, opens with **no entrance** (`via==="keyboard"`, l.106); focus goes to the active section tab (l.86-95) | focus goes to the section-menu button |

The full-page sibling `/settings` (`src/app/(app)/settings/page.tsx:56-87`) is another frame:
- `fixed inset-0 z-modal` with **no dialog role, no focus trap and no scroll lock**.
- Escape is a `window` listener (l.43-53).
- Rail `md:w-64` (256 vs 240). Pane `max-w-[44rem]` (vs 42rem) with `md:pt-16`.
- Header is the serif `ed-h3` "Settings" (sans `text-heading` in the modal). See `settings-light.png`.

### 2.5 Search and command palette: `src/components/app/command-palette.tsx`

| Property | Value | Line |
|---|---|---|
| Shell | One `PaletteShell` drives both Search (l.1164) and the Command menu (l.1651) | 130, 243-590 |
| Frame | `top-[9svh] w-[calc(100%-2rem)] max-w-[640px] rounded-panel(16) p-0 bg-popover`; the border is **`foreground/10`** (`dark: white/10`), a hand-picked edge instead of the token | 279 |
| Field | `h-14` (56, 64 on coarse) band, `border-b foreground/[.07]`, 20px search glyph, `text-body-lg` (17px). The comment says "60px band … 560px overlay"; the code is 56px and 640px. | 285-300 |
| List | `min-h-[13rem] max-h-[min(56svh,100dvh-10rem)] p-2 scroll-fade-y`; rows `h-9` (36) `rounded-control` `text-body`; group headers `text-caption` 500 | 373, 410-475 |
| Highlight | framer `layoutId` spring (520/40/0.7) on `bg-foreground/[.06]` + inset hairline, inline `borderRadius: 8` (the comment says `bg-accent`) | 506-515 |
| Footer | None (the keycap strip was removed on purpose) | 552-565 |
| Motion | pop-in 220ms on **out-expo** from .97 and **-6px** (drops from above); out `pop-out` **120ms** | 279 |
| Keyboard | ⌘K; combobox + `aria-activedescendant`; ↑/↓/Enter; focus goes to the input; caret restored on close | 225-240, 280-283 |
| Phone | `sheet={false}`: stays a top card above the keyboard | 247 |

Two separate **keyboard-shortcut sheets**:
- `command-palette.tsx:1712`: `max-w-[40rem]`, no description, mono `text-label` group heads, rows `py-2`.
- `settings/sections/preferences.tsx:417-445`: `max-w-2xl`, `p-0` with its own header, a Chat/Code segmented control, `text-caption` sans group heads, rows `py-2.5`, `border-t` body.

### 2.6 Onboarding: `src/components/app/onboarding.tsx:183-308`
- **Frame.** `max-w-[420px] p-0 hideClose` (inherits the `sm:p-6` leak, §1.1 #4), with a DotField at opacity .4 behind the content.
- **Layout.** Body `px-7 pt-7 pb-7` (28; dialogs use 24). Title **`text-title font-medium`** (22/500); description `text-body` (l.200-205).
- **Buttons.** Stacked full width: primary **`size="lg"` (44px, rounded-field 10px)** + ghost `size="sm"` (32px) "Skip for now" (l.296-303). No other dialog uses `lg` or stacks on desktop.
- **Motion.** Rows stagger `fade-in-up` on the "loose" rung (l.210, 225, 255, 291).
- **Focus.** Goes to the primary (l.187-190). Esc or a backdrop click closes (skip).
- **Phone.** House sheet with a grabber over the DotField.

### 2.7 Announcement popup: `src/components/app/announcement-popup.tsx:258-285` + `announcement.css`
- **Frame.** `max-w-[40rem] p-0 sm:p-0 flex`.
- **✕.** `right-3.5 top-3.5` (14px) on `bg-popover shadow-pop` so it shows over the media.
- **Type.** Title is serif `clamp(28px,4.4vw,38px)`/400 (`announcement.css:125-131`).
- **Buttons.** Its own kit: `.ann-btn` 40px (44 under 30rem), radius 8, ink primary, hairline secondary, quiet "Not now" (`announcement.css:158-192`).
- **Motion.** Media settles over 560ms; copy lines rise in sequence (`announcement.css:198+`).
- **Focus.** Goes to the dialog itself (l.264-267).

### 2.8 Library Quick Look: `src/components/library/library-quick-look.tsx:217-284`
- **Frame.** `max-w-3xl` (768) `p-0 sm:p-0`.
- **Header.** Custom `px-5 sm:px-6 pt-5 sm:pt-6 pb-4 pr-14/16`. The title uses the default rung. The description is overridden to **`text-ui`** with `tabular-nums` meta (l.223-230).
- **Well.** `surface-inset rounded-card h-[min(56dvh,32rem)]`.
- **Footer.** Right-aligned `size="sm"` ghost "Open the chat" + `size="sm"` primary "Download" (32px; every other dialog footer is 36px) (l.237-250).
- **Behaviour.** The last item stays drawn through the exit. On a phone it becomes a house sheet.

### 2.9 Image viewers and image overlays
1. **Document/image viewer.** `src/components/documents/document-viewer.tsx:518-610`, `image-view.tsx`.
   - Normally a side split panel (`role="complementary"`).
   - Fullscreen: `fixed inset-0 z-modal bg-background motion-safe:animate-fade-in`, `role="dialog" aria-modal` (l.522-526). **No focus trap, no scroll lock, no exit animation** (the class is simply removed).
   - Header `border-b bg-card py-2`; 36px thumb; title `text-ui font-semibold`; meta mono caption.
   - Close: `Button ghost icon-sm` (32px, **rounded-control square**) with a tooltip (l.599-606).
   - Escape leaves fullscreen first (l.448-460). Zoom steps 10–800% with 20px padding.
2. **Image edit overlay.** `src/components/chat/image-edit-overlay.tsx:712-980` + `image-edit.css`.
   - A full-bleed opaque stage with **raw hex** (`#eef0f1` light, `#0d0e0f` dark), its own shadow stack and its own ease `--ie-ease (.16,1,.3,1)` (`image-edit.css:11-31`).
   - Close: a 40px (44 coarse) bordered filled circle in the **top-left** corner. Every other overlay puts the ✕ top-right (l.741-746; `image-edit.css:34-47`).
   - Motion: in 220ms fade; chrome drops 360ms after a 120ms delay; dock rises 560ms after 160ms; out 160ms `(.4,0,1,1)` written as a literal (`image-edit.css:122-130`).
   - Escape clears the selection before it closes; focus goes to the prompt on fine pointers, otherwise to the root.
3. **Sketch.** `src/components/chat/sketch/sketch-dialog.tsx:140-170` + `sketch.css`.
   - Scrim **`rgb(14 15 17 / .32)`** in light (not `--scrim`'s warm .26) (`sketch.css:63-71`).
   - Panel `inset 24px`, `min(1120,100vw-48)×min(800,100dvh-48)`, **radius 28** (the marketing-only `stage` rung), raw `#f3f4f5`/`#18191b`, its own shadows (`sketch.css:10-60`).
   - 36px `.sketch-key` close in the header row.
   - Outside clicks are blocked (l.150-151).
   - Motion: in 220ms `--sk-ease`; overlay fade on raw `ease-out`/`ease-in` keywords.
   - Full screen below 640px.

### 2.10 Computer viewer overlay: `src/components/agents/agent-computer.tsx:358-560`
- **Frame.** A hand-rolled `div role="dialog" aria-modal` with `fixed inset-0 z-modal bg-background motion-safe:animate-in motion-safe:fade-in duration-base`, i.e. the tailwindcss-animate chain the house primitives removed (l.374-377).
- **Missing.** No Radix: **no focus trap, no focus return, no scroll lock, no exit** (`if (!open) return null`, l.358).
- **Escape.** A `window` listener that defers to its own confirm dialogs but not to its own dropdown (l.203-209).
- **Header.** `px-5 py-4`: 28px presence avatar, name `text-ui font-medium`, ⋯ menu and ✕, both `Button ghost icon-sm` (32px rounded-control, **18px glyphs**; elsewhere they are 16) (l.380-404).
- **Screen.** `rounded-panel bg-muted shadow-[0_30px_80px_-20px_hsl(var(--foreground)/0.35)]` (l.433). This shadow is tinted with **foreground**, so in dark mode it casts a *light* glow. It is the only foreground-tinted drop shadow in the product.
- **Nested dialogs.** Files, Hand back, Reset: plain `DialogContent` (default 512px) with **outline** Cancel (l.584-650).
- **Phone.** Already full screen; no sheet behaviour.

### 2.11 Notifications inbox: `src/components/notifications/notifications-popover.tsx:111-205`
- **Frame.** Non-modal `Popover` (l.113), `w-96` (384), `max-h-[min(36rem, available)]`, `p-0`, radius 12.
- **Header.** `h-12 pl-4 pr-2` with a **`font-serif text-heading`** title (l.133). It is the only serif overlay title apart from the checkout and app-detail sheet. Ghost `sm` "Mark all as read".
- **Rows.** `notification-row.tsx:44-60`: `rounded-control px-2.5 py-2 gap-2.5`, 20px face/mark, title `text-nav` (500 when unread), caption second line with a presence-blue time when pressing.
- **States.** Loading (3 skeleton rows) · failed (EmptyState, outline Try again) · empty · list with "Show earlier" · push offer footer `border-t /60`.
- **Focus.** Goes to the popover container (l.124-127).
- **Phone (<768).** `side="bottom"` under the row *inside the 280px nav drawer*, `sideOffset 4`, `collisionPadding 8` (l.108-119). It is **not a sheet**, while the feedback popover becomes one on a phone (`message-feedback.tsx:166-174`).

### 2.12 Memory-updated notice: `src/components/chat/memory-updated-notice.tsx:66-225`
Seen in `thread-light.png` / `thread-dark.png`: top-centre, about 565×56px, overlapping the transcript's table header.
- **Frame.** `w-max max-w-[min(40rem,100vw-2rem)] rounded-panel (16) border-border/70 bg-popover shadow-glass py-2 pl-2 pr-1.5` (l.130). Toasts use radius 12 + `surface-float` + `shadow-float`.
- **Tile and text.** 32px `rounded-card` tile; label `text-caption`; fact `text-ui font-medium`, two lines.
- **Actions.** View, Edit (opens a Popover `w-[min(24rem)] p-3`), Undo and ✕, all as **28px text buttons at 12px** (`actionClass`, l.47-48). Toast actions are 32px, 13px, bordered.
- **Countdown.** A 1px drain hairline (`MEMORY_NOTICE_MS = 6000`; toasts use 4000) (l.43, 214-225).
- **Motion.** `rise-in` 220ms; exit `title-out` 160ms. `EXIT_MS = 180` claims to be `--dur-exit` (160) (l.45).
- **Placement.** Top-centre under the header on desktop (`chat-view.tsx:2709-2715`), above the composer on a phone (`chat-view.tsx:2946-2950`). Toasts are bottom-centre.
- **A11y.** `role="status" aria-live` wraps interactive buttons. Hover or focus holds it. No hotkey (toasts have Alt+T).

### 2.13 Side sheets
- **Nav drawer.** `app-shell.tsx:654` with `DRAWER_CLASS` (`:37-38`). Left, 280px, radius 16 on the inner edge, edge-swipe, no ✕, scrim `md:hidden`.
- **Memory activity.** `memory/activity-sheet.tsx:63-90`.
  - Right edge-attached `w-[28rem] max-w-[92vw]`, `scrim="always"`.
  - Header `px-5 pt-4 pb-3` with an `h2` in `text-heading`.
  - ✕ is `IconButton ghost sm` (**32px, rounded-control 8**, 44 coarse) with a tooltip.
  - Focus goes to the heading.
- **App details.** `connections/app-detail-sheet.tsx:162-185`.
  - A **floating inset** right sheet: `inset-y-2 right-2 w-[min(480px,100vw-16px)] rounded-panel` on all four corners (unlike the memory sheet).
  - Header `px-6 pt-5 pb-4` with a 40px mark; **serif `text-title` 400** title.
  - ✕ is `Button ghost icon-sm` (32px rounded-control).
- **Two right sheets, two widths (448/480), two attachments (edge vs inset), two title rungs (18/600 sans vs 22/400 serif), two paddings (20 vs 24).**

### 2.14 Hover cards
1. **Chat source chip.** `chat/source-chip.tsx:285-313`.
   - A Radix **Tooltip** dressed as a card (`.cite-card`, `globals.css:4837-4849`): `w-[20rem] p-0`, **radius 14px raw**, `--popover` fill, border `/.9`, `--shadow-float`.
   - Inner `p-3 gap-1.5`; host caption; title `text-ui font-semibold`; three-line caption snippet.
   - Opens after 200ms; 120ms tooltip motion.
   - Content is not focusable, so keyboard users get nothing past the trigger's `aria-label`.
2. **Research citation card.** `research/citation-card.tsx:125-212`.
   - A Radix **Popover**: `w-80` (320) `p-4` radius **12**, `side="top"`.
   - Opens **instantly** on `pointerover` (no intent delay); closes 180ms after leaving.
   - Contains a link and a passage pager, but `onOpenAutoFocus` is prevented and the content is portalled, so **Tab from the chip never reaches them**.
   - Touch: first tap opens, second tap follows the link.
3. Result: the same object (a source preview) has two implementations, two radii (14/12), two paddings (12/16), two open delays (200/0ms) and two motion recipes (tooltip 120ms / pop 220ms).

### 2.15 Approval cards (inline "needs you" surfaces)

| Surface | Frame | Buttons (order · size · fill) | Role |
|---|---|---|---|
| Chat tool approval: `chat/approval-card.tsx:1033-1205` | `rounded-field` (10; the comment says "radius 12", l.1043) `bg-muted`, no border, no shadow, `px-4 pt-3.5 pb-4 my-5`, `rise-in` | **Not now** (outline, 36px) · **Verb** (ink `bg-foreground`, 36px, split caret) · **Tell instead** (outline, `ml-auto`) (`decision.tsx:41-46,92,125`) | `group` |
| Work approval: `work/approvals/approval-card.tsx:215-266` | same family | same order; `QuietButton`/`VerbButton` | `group` |
| Question card ("Needs your answer", in the screenshots): `chat/work-run-panel.tsx:445-491` | same tone step | single **Continue** verb, **right-aligned** (`justify-end`, l.484). Approval verbs are left-aligned. | |
| Code run approval: `code/code-run-cards.tsx:1231-1306` | `rounded-field` **`border-warning/40 bg-warning/10 shadow-raised`**: the warning wash the chat card explicitly forbids (T6) | **Deny** (`destructive-outline`, **44px**) · **Allow** (accent `control-primary`, 44px) + caption. The comment says "h-11, matching chat/approval-card", but that card is h-9. | `group` |
| Code v2 approve: `code/v2/composer.tsx:141,244` + `code-v2.css:372-383,120-129` | flat, `gap 10px`, 160ms fade | spacer · ghost Deny / Cancel · bordered Show diff / Allow for session · **ink** Allow once (rightmost) · all **28px** `.cv2-btn` radius 8 · ⌘⌫ / ⌘⇧↵ / ↵ hints in `title` | **`alertdialog`**, which `code-run-cards.tsx:1227-1230` says is wrong for an inline card |

The ink verb is drawn on top of `Button`'s default `control-primary` class. That class keeps its **primary-tinted glow** (`globals.css:1590-1593`) under an ink fill. You can see it as a shadow under the disabled "Continue" in `thread-*.png`.

### 2.16 Other one-off modals
- **`SkillDialogContent`.** `skills/skill-dialog-shell.tsx:28-61`, used by import-skills, update-source and custom-connector.
  - framer `layout` panel, `surface-float` (border /.9), `max-w-xl` (576), **inline `borderRadius: 20`** overriding `rounded-panel` 16.
  - **No `ui-dialog` and no `data-phone-sheet`, so it is never a phone sheet.** No grabber. No `useDialogFocusReturn`.
- **`AddMcpServerDialog`.** `connections/add-mcp-server-dialog.tsx:143-313`.
  - framer panel, **`borderRadius: 20`**, `max-w-md`; header with a 40px icon tile and a `border-b /60` divider; ✕ `static` in the header; footer `border-t /60`.
  - The framer `exit` has **no `AnimatePresence`**, so on close the panel vanishes instantly while the scrim fades for 220ms.
  - Not a phone sheet.
- **Checkout.** `billing/checkout-sheet.tsx:62-67`: `w-[min(36rem,100vw-2rem)]`; title **serif `text-title` 400**; description `text-ui`; `sm:p-6` leak.
- **Mermaid diagram.** `chat/mermaid-block.tsx:226-227`: `w-[min(96vw,72rem)]`, **`bg-card`** (a utility that beats `--popover`, so it is darker than every other dialog in dark mode: 14% vs 16% L); title is a `text-ui` 500 bar with `border-b`; the default ✕ overlaps that bar; `sm:p-6` leak.
- **Report reader.** `research/report-fullscreen.tsx:107-117`: full-screen `DialogContent`, `rounded-none`, `sheet={false}`, `h-14` toolbar.
- **Library picker.** `chat/library-picker.tsx:125-255`: `max-w-2xl p-6`; 36px circular icon tile; title `text-title font-normal` (22/400); description **`text-caption`** (12); footer `sm:gap-0`.
- **Code v2 has a parallel overlay system.** `code-v2.css`:
  - `.cv2-scrim` z-30 (l.511).
  - `.cv2-sheet` dialog z-31, `min(920px)`, radius 16, own shadow stack, 220ms (l.641-646).
  - `.cv2-palette` z-41, `min(600px)`, **radius 14**, `top 14vh` (l.651).
  - `.cv2-pop` z-40, radius 12, **`--dur-mid: 160ms`**, a rung not on the house ladder (l.41, 393).
  - On a phone the pop becomes a bottom sheet with **radius 18** (l.693).
  - It uses no `--z-*` tokens, and dark mode drops the shadow (`--cv2-shadow-pop: none`).

---

## 3. Inconsistency ledger

### A. Corner radius of "the same object"
| Object | Values in use |
|---|---|
| Modal panel | 16 (`dialog.tsx:107`) · **20** (`skill-dialog-shell.tsx:42`, `add-mcp-server-dialog.tsx:156`) · **28** (`sketch.css:21`) · 16 (`cv2-sheet`) · 0 (full screen) |
| Bottom sheet top | 16 (`sheet.css:131`, `bottom-sheet.tsx:160`) · **18** (`code-v2.css:693`) |
| Command palette | 16 (`command-palette.tsx:279`) · **14** (`code-v2.css:651`) |
| Floating card | popover 12 · toast 12 · **cite-card 14** (`globals.css:4843`) · **memory notice 16** (`memory-updated-notice.tsx:130`) · menu 14 |
| Inline "needs you" card | 10 (`approval-card.tsx:1046`, `code-run-cards.tsx:1238`; comment says 12) |
| Buttons inside overlays | 8 (`Button`) · **10** (toast actions `globals.css:4071`; `Button size=lg` in onboarding) · 8 (`.ann-btn`, `.cv2-btn`) |
| Close glyph plate | **circle** (`DialogCloseButton`, image editor, sketch) · **8px square** (`IconButton` in the memory sheet; `Button icon-sm` in the app sheet, document viewer and computer overlay) · 8px (toast ✕, computed `12-4`) |

### B. Material, border and elevation
- Border alpha on the same opaque panel: `.overlay-glass` /.7 (dialogs, sheets) · `.surface-float` /.9 (skill shell, MCP dialog, toasts, cite-card) · `foreground/10` (palette) · `border/70` hand-written (memory notice) · none (approval cards).
- **One shadow for everything that floats.** A 928px Settings modal, a 288px popover, a 356px toast and a source hover-card all cast `--shadow-float`. Apple and Material give modals a deeper rung than menus. Here a dialog never reads as "above" a popover.
- Off-ladder shadows:
  - memory notice `shadow-glass` (lighter)
  - computer screen `hsl(--foreground/.35)`, which glows in dark mode (`agent-computer.tsx:433`)
  - image editor and sketch use their own 3-layer stacks
  - tooltip has its own
  - code v2 has `--cv2-shadow-pop`, and none in dark
  - `control-primary` glow leaks under ink verbs
- Light-mode separation rests on a **1% lightness step** (page 99% vs panel 100%) plus a .26 scrim. ChatGPT uses `#000/30%` in light.
- Mermaid dialog `bg-card` ≠ every other dialog's `--popover` in dark.

### C. Scrim
- Token `hsl(48 12% 8%/.26)` / `#000/.55` everywhere except:
  - Sketch: `rgb(14 15 17/.32)` (`sketch.css:67`).
  - Image editor, computer overlay, document fullscreen and the settings page: opaque stages, no scrim.
  - The notifications popover is non-modal, with no scrim.
- The dark-scrim comment cites a 2px blur that does not exist (`globals.css:948`).
- Stacked scrims: the settings section-menu sheet over the full-screen settings modal on a phone (.26 twice ≈ .45).

### D. Width
- 384 / 448 / 512 are all used for one-paragraph confirms (§2.1). ChatGPT uses one confirm width (450). Claude also uses one small size.
- Large dialogs: `2xl` 672, `3xl` 768, `[40rem]` 640, `[52rem]` 832, `[58rem]` 928, `[60rem]` 960, `5xl` 1024, `72rem` 1152, `min(920px)` (cv2). That is nine large widths.
- Right sheets: 448 (memory) vs 480 (app details) vs 280 (nav).

### E. Padding, header and footer anatomy
- Panel padding: 20/24 (dialog) · 28 (onboarding `px-7`) · 24 + 24 leak (onboarding, checkout, mermaid, suggestion-compare, import at ≥640) · 20 (`p-5`, MCP) · 12 (sketch `--sk-pad`) · 16 (popover `p-4`) · 12 (cite-card `p-3`) · 8/6 (memory notice).
- Headers: centred on a phone in the primitive (`text-center`), but left-aligned in quick look, checkout, MCP, library picker, preferences and onboarding.
- Header divider: none (primitive) vs `border-b /60` (MCP, mermaid, document viewer) vs `/70` (report reader).
- Footer divider: none vs `/50` vs `/60`.
- **Header and footer are never sticky in the primitive.**

### F. Close button
| Where | Size | Plate | Inset | Glyph | Tooltip |
|---|---|---|---|---|---|
| `DialogCloseButton` (`dialog.tsx:32`) | 36 (44 coarse) | circle | 16/16 | 16 | no |
| Settings modal (`settings-modal.tsx:136`) | 36 | circle | **12/12** | 16 | yes |
| Announcement (`announcement-popup.tsx:283`) | 36 | circle on `bg-popover shadow-pop` | **14/14** | 16 | no |
| MCP dialog (`add-mcp-server-dialog.tsx:171`) | 36 | circle | in-flow header | 16 | no |
| Memory activity sheet (`activity-sheet.tsx:78-84`) | **32** | **square 8** | in-flow, `-mr-1.5` | 16 | yes |
| App detail sheet (`app-detail-sheet.tsx:179-183`) | **32** | **square 8** | in-flow | 16 | no |
| Computer overlay (`agent-computer.tsx:401`) | **32** | **square 8** | in-flow | **18** | no |
| Document viewer (`document-viewer.tsx:601`) | **32** | **square 8** | in-flow | 16 | yes |
| Image editor (`image-edit.css:34-47`) | **40** (44) | bordered filled circle | **top-left** | 16 | no |
| Sketch (`sketch.css:155-176`) | 36 | circle | header row | n/a | n/a |
| Toast (`globals.css:3958`) | **24** (32 hit) | square 8 | 4/4 | 14 | no |
| Memory notice (`memory-updated-notice.tsx:207`) | **28** | square 8 | in-flow, after a divider | 14 | no |

### G. Title and description type
- Titles: `heading` 18/600 sans (primitive) · `heading` **500** (`settings-rail.tsx:454`) · `title` 22/**500** (`onboarding.tsx:200`) · `title` 22/**400** sans (`library-picker.tsx:134`) · `title` 22/400 **serif** (`checkout-sheet.tsx:66`, `app-detail-sheet.tsx:174`) · `heading` **serif** (`notifications-popover.tsx:133`) · `ui` 13/500 (`mermaid-block.tsx:227`, `document-viewer.tsx`, computer overlay) · serif 28–38 (announcement).
- Descriptions: `body` 15 (primitive) vs **`ui` 13** (quick look, checkout, MCP, face studio, add-custom-connector, import-skills, project folders) vs **`caption` 12** (library picker) vs mono caption (update-source, custom-connector).

### H. Button order, variant and size
- **Cancel style:** ghost (about 40 dialogs, flat, no edge at rest) vs outline (7 dialogs + every approval card) vs `.ann-btn-quiet` vs `.cv2-btn.ghost`.
- **Primary fill:** accent `control-primary` (dialogs, code-run Allow) vs **foreground ink** (`VerbButton`, `.ann-btn-primary`) vs `--primary` (`.cv2-btn.ink`). With any accent other than graphite, a dialog confirm turns coloured while an approval verb stays black.
- **Heights:** 36 (dialogs, chat approvals) · 32 (quick look, toasts) · 44 (onboarding primary, code-run approvals) · 40 (announcement) · 28 (code v2 approvals, memory-notice actions).
- **Placement:** dialogs end-aligned with the primary rightmost · chat/work approvals start-aligned with the verb second and Tell instead at the end · the question card end-aligned · code v2 end-aligned with the primary rightmost · onboarding stacked full width on desktop.
- **Destructive language:** solid `destructive` (most confirms) vs `destructive-outline` (code-run Deny, canvas Discard) vs `.cv2-btn.danger`.

### I. Motion
| Surface | In | Out | Curve (in) |
|---|---|---|---|
| Dialog | 220 scale .96 / +4px | 160 | spring |
| Dialog on a phone (sheet) | 360 rise | **220** | drawer |
| BottomSheet | 360 rise | **160** | drawer |
| Side sheet | 220 slide | 160 | drawer |
| Settings modal | 220 scale .97, 0px | **120** | **out-soft** |
| Command palette | 220 scale .97 / **-6px** | **120** | **out-expo** |
| Popover / menu | 220 | 120 | spring |
| Toast | **360** | 160 | out-expo |
| Memory notice | 220 rise 6px | 160 (timer 180) | out-soft |
| MCP dialog | 220 y12 scale .98 | **none (hard cut)** | drawer |
| Skill shell | modal-in + framer layout 360 | 160 | spring/expo |
| Image editor | 220 + staggered 360/560 | 160 | own `--ie-ease` |
| Sketch | 220 | 160 | own `--sk-ease`; scrim on raw `ease-out` |
| Computer overlay | 220 tailwindcss-animate fade | **none** | n/a |
| Document fullscreen | 220 fade | **none** | n/a |
| code v2 pop / sheet | **160** / 220 | ×0.65 | own `--cv2-ease` |

That is about 11 entrance recipes for one family. A phone dialog's scrim and panel leave together (220/220), so the "scrim trails" rule from `tailwind.config.ts:955-959` is broken there.

### J. Focus, keyboard and accessibility
- No focus trap, scroll lock or focus return: computer overlay, document fullscreen and the `/settings` page, though all three are `z-modal` full-screen layers (two of them declare `aria-modal`).
- No `useDialogFocusReturn` in `BottomSheet`, `SkillDialogContent`, the MCP dialog, the image editor or sketch. These fall back to Radix trigger-only return, which drops focus on `<body>` when opened from a menu or an event.
- `role="alertdialog"` is used inconsistently: on the incognito dialog but not on session-expired; on inline code v2 approval cards, where it is wrong.
- Hover cards cannot be reached by keyboard (Tooltip-based in chat; Popover with prevented focus in research).
- The memory notice puts buttons inside a `role=status` live region and has no hotkey. Toasts have Alt+T.
- Escape is handled by window listeners in two overlays (`agent-computer.tsx:203`, `settings/page.tsx:43`) and by Radix everywhere else.
- No confirm dialog has a default button (Return = primary).

### K. Mobile
- **Breakpoints:** 600 (sonner), **640** (dialog sheet, `PHONE_QUERY`), **768** (settings full screen, nav drawer, inbox under-row). Between 640 and 767px, Settings is full screen while every other dialog is a centred card.
- **Three bottom-sheet implementations** (`sheet.css`, `bottom-sheet.tsx`, `code-v2.css:693`). They differ in grabber ink (/.18 vs muted/35), band (20 absolute vs 24 in-flow), max height (100dvh−safe−24 vs 88dvh vs 82dvh), exit (220/160/~), drag zone (anywhere vs grabber only) and keyboard avoidance (yes/no/no).
- Dialogs that **don't** sheet on a phone: every `SkillDialogContent`, `AddMcpServerDialog`, the palette, settings and the report reader. These stay centred cards or go full screen.
- Popovers never sheet except `message-feedback`. On a phone the notifications popover hangs off a 280px drawer.

### L. Notifications are three systems
Toast (bottom, 12px, `shadow-float`, 4s, 32px buttons) vs memory notice (top, 16px, `shadow-glass`, 6s with a countdown, 28px text buttons) vs inbox popover (sidebar, serif header). A Claude/ChatGPT user reads toasts and notices as one family. Here they differ in position, radius, elevation, lifetime, action style and keyboard access.

### M. Off-system surfaces (each restates the material in raw values)
image editor (`image-edit.css`), sketch (`sketch.css`), announcement (`announcement.css`), code v2 (`code-v2.css`), the design-host Toaster (`design/host/main.tsx:73`, stock `richColors`), `SkillDialogContent` and `AddMcpServerDialog` (inline 20px radius).

---

## 4. What keeps these surfaces from feeling premium (priority order)

1. **No pinned chrome.** The ✕, the grabber and the footer scroll with the body (`dialog.tsx:107,32,114`). Claude, ChatGPT and Apple pin the header and actions. *Fix:* make `DialogContent` a 3-row grid (`auto / minmax(0,1fr) / auto`). Put the ✕ in the header row (flex, not absolute). Let only the body scroll, with `scroll-fade-y`.
2. **Too many recipes for one object.**
   - Modal radius: 0/16/20/28.
   - Close plate: circle vs square, at 24/28/32/36/40.
   - Entrance: 11 recipes.
   - Shadow: 6 stacks.
   - Three sheet engines.

   Each one is defensible on its own; together they read as assembled rather than designed. *Fix:* route the skill shell, the MCP dialog, sketch, the image editor and code v2 through `DialogContent` / `SheetContent` tokens. Delete the inline `borderRadius: 20`. Make sketch 16 (or full bleed). Drop `BottomSheet` for `SheetContent side="bottom"`.
3. **The header grid is not designed.** There is no title gutter, and the ✕ sits 2–6px off the title midline (§1.1). Title type comes in 8 variants (§3G). *Fix:* a 56px header row, title 18/600 sans everywhere (serif only as a deliberate "editorial" rung, if at all), description 14–15 muted, and a ✕ 32px circle at 12px from the top and right, vertically centred on the title row.
4. **One elevation for every layer.** *Fix:* add `--shadow-modal`, for example light `0 0 0 1px ink/.04, 0 8px 24px -8px ink/.12, 0 40px 96px -24px ink/.30`, and use it for dialogs and sheets only. Consider raising the light scrim to about .32–.36 so the panel separates from a 99%-L page (ChatGPT uses #000/.30).
5. **Approvals don't share a button grammar.** The heights are 28/36/44, the primary is ink or accent, refuse sits first or last, and the role is `group` or `alertdialog`. *Fix:* one `DecisionRow`. Refuse (outline) then the verb (ink) at 36px (44 coarse), end-aligned like dialogs, with the "Tell instead" link to the left. Strip the `control-primary` glow from `VerbButton`. Make the code-run card a tone step, not a warning wash. Remove `role="alertdialog"` from `cv2-approve`.
6. **The notification family is split.** *Fix:* render the memory notice as a sonner custom toast (or restyle it to toast values: radius 12, `shadow-float`, 32px bordered actions, bottom-centre, one lifetime). Apply `--z-toast` to the toaster. Remove `richColors` from the design host.
7. **Cancel is invisible at rest.** Ghost Cancel beside a filled primary leaves only one visible shape. Apple and ChatGPT draw a bordered or tonal secondary. *Fix:* use `secondary` (`control-neu`) for Cancel in every dialog footer, which matches the approval `QuietButton` outline.
8. **Hard cuts.** The MCP dialog, computer overlay and document fullscreen have no exit, and the computer overlay has no focus management. *Fix:* convert the computer overlay to a `DialogContent` with `sheet={false}` and full-screen classes. Add `AnimatePresence`, or drop framer for `modal-out`.
9. **Widths.** *Fix:* three modal widths (confirm 400, form 520, workspace 880) plus full screen. Map all 21 `sm` and 26 `md` uses to the confirm and form rungs.
10. **Phone.** *Fix:* one breakpoint (640) for "dialog becomes a sheet". Settings becomes a sheet at the large detent at 640–767px rather than full screen. Popovers holding content (inbox, citation card, memory edit) become bottom sheets below 640. Use one grabber spec (36×5 at `foreground/.2`, top 6px, in a pinned header).
11. **Hover cards.** *Fix:* one `HoverCard` on Popover, 12 radius, `p-3`, 300ms open intent and 150ms close. Keyboard can reach it (focus moves in on Enter or ↓). Delete the `.cite-card` tooltip hack.
12. **Documentation drift that misleads the next editor:**
    - the 2px-blur comment (`globals.css:948`)
    - "~2% overrun" on an overshoot-free curve (`tailwind.config.ts:937`)
    - "radius 12" on a 10px card (`approval-card.tsx:1043`)
    - "180/120 tier" and "60px band / 560px" in the palette, whose code says 220/56px/640px (`command-palette.tsx:259,289-291`)
    - "matching chat/approval-card h-11" (`code-run-cards.tsx:1285`)
    - `EXIT_MS = 180` described as `--dur-exit` (`memory-updated-notice.tsx:44-45`)
    - "solid fill, no shadow" on `control-primary`, which has a glow (`button.tsx:11` vs `globals.css:1590`)

---

## 5. Proposed single spec (for the fix pass)

| Slot | Value |
|---|---|
| Scrim | one token; light about `hsl(220 10% 8% / .32)`, dark `#000/.55`; no blur |
| Modal panel | `--popover`, `border/.7`, **`--shadow-modal`** (new), radius **16**; full-screen 0 |
| Floating card (popover, toast, hover card, notice) | radius **12**, `surface-float`, `--shadow-float`, `p-3` (content) / `p-1.5` (lists) |
| Menu | 14 (keep) or 12 to match ChatGPT; pick one and move `.cite-card` to the card rung |
| Widths | confirm 400 · form 520 · workspace 880 · full screen |
| Header | 56px row, `px-6`, title 18/600 sans (`text-heading`), description 14/1.5 muted under it, ✕ 32px circle (44 coarse) right-aligned in the row |
| Body | the only scroller, `px-6`, `scroll-fade-y` |
| Footer | pinned, `px-6 py-4`, hairline only when the body scrolls; Cancel `secondary` 36px then Primary 36px, end-aligned; a phone stacks primary on top at 44px |
| Motion: modal | in 220ms spring from .96 / +4px; out 160ms ease-in; scrim 120 in / 220 out |
| Motion: sheet | in 360ms drawer; out 220ms ease-in; scrim trails by +60ms |
| Motion: floating | in 220ms; out 120ms |
| Motion: toast/notice | in 360ms expo; out 160ms |
| Close (everywhere) | one `DialogCloseButton`; no `IconButton` or `Button icon-sm` close plates |
| Z | dialog 50 · popper 55 · toast 70 (actually applied); code v2 moved onto the ladder |
| Phone | <640: every dialog and content popover is a `SheetContent side="bottom"` with one grabber spec and keyboard avoidance |
