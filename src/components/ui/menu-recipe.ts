/**
 * THE MENU RECIPE — one row, one shell, for every floating list in the product.
 *
 * `menu-item` was already stamped on five different components as a shared
 * marker class. It matched no CSS and enforced nothing, so the recipes it
 * marked had drifted into four different objects (the fifth, the command
 * palette, is a deliberate exception — see below):
 *
 *   dropdown-menu.tsx    gap-2.5  rounded-control  px-2.5 py-1.5  text-body  svg 18
 *   select.tsx           gap-2    rounded-control  pl-8 pr-2       text-ui    svg 16
 *   composer-plus-menu   gap-2.5  rounded-control  px-2.5 py-1.5   text-ui    svg 16
 *   landing nav          —        rounded-control  px-3 py-2       text-ui    —
 *
 * Two type sizes, two icon sizes and three gaps, for one idea. Open the
 * composer's `+` beside a row kebab and they were visibly not the same menu —
 * the loudest "assembled, not designed" tell in the chrome, because those two
 * are the menus people open most.
 *
 * So the recipe is real now and lives here, imported by all four.
 *
 * THE COMMAND PALETTE IS NOT ONE OF THEM, and that is deliberate rather than
 * the fifth drift. Its rows are the reader's own chats and files found by a
 * search field, not verbs: they set `text-body` to match the sidebar they
 * mirror, they grow to two lines for a snippet, and they are arrow-key targets
 * at 36px. Raycast and Spotlight draw a taller row than their own menus for
 * the same reason. It keeps the `menu-item` marker for the shared hover ink
 * and nothing else.
 *
 * ── The numbers, and why these ────────────────────────────────────────────
 *
 * Read off the reference set (Claude, ChatGPT, Linear, Raycast) rather than
 * chosen: a menu row there is ~32px tall, sets its label at 13px, and carries
 * a 16px glyph in muted ink. Juno's dropdown was setting 15px prose type with
 * an 18px glyph, which is a LIST ROW's density — correct in the sidebar, where
 * rows are destinations you read, and a size too loud in a menu, where rows are
 * verbs you scan. `ui` (13px) is the scale's own dense-UI rung and already what
 * the `+` menu, Select and every chip in the product use.
 *
 * Concentric, per the radius ladder's own note: "a 14px menu with p-1 holds
 * 10px items." The shell was at `rounded-popover` (16) with p-1.5 — the CARD
 * rung, one step too round for a 224px list, and the reason menus read bubbly
 * beside the flat surfaces they open over.
 *
 * ── The `:not([class*='…'])` guards, which are not a trick ────────────────
 *
 * The old row wrote `[&_svg]:size-4.5`. That compiles to `.\[…\] svg`, which at
 * (0,1,1) outranks a plain `.size-4` utility ON the svg at (0,1,0) — so the
 * ~40 call sites that had written `className="size-4"` on a menu glyph were
 * rendering at 18px anyway and nobody could see why. Same for ink.
 *
 * Guarding on the absence of the class makes the default a DEFAULT: state a
 * `size-*` or a `text-*` on a glyph and it wins, which is what every one of
 * those call sites already believed. Delete the guards and forty overrides go
 * silently dead again.
 */

/**
 * The shell every floating list is cut from — dropdown, submenu, select, the
 * composer's `+`, and the landing page's section nav.
 *
 * `max-h` and `overflow` are deliberately NOT here. Each host caps against its
 * own Radix available-height variable (`--radix-dropdown-menu-…`,
 * `--radix-select-…`), and they scroll in different places: a dropdown scrolls
 * the shell itself, while Select scrolls an inner Viewport between two scroll
 * buttons that must sit outside any padding. Putting either here means one of
 * the two fighting the other in the cascade.
 */
export const menuShellClass =
  "surface-float overlay-glass z-popper origin-popper rounded-menu p-1 " +
  "max-w-[calc(100vw-1rem)] " +
  "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out";

/**
 * One row. 32px at 13px with a 16px glyph, and 44px on a coarse pointer —
 * the full WCAG 2.5.8 target, met by the row itself rather than by the row
 * plus whatever padding the shell happens to have. A menu is the one surface
 * where a mis-tap costs a destructive action.
 *
 * Interaction state (`focus:bg-accent`, the destructive tint, `data-[state=open]`)
 * stays at the call site: Radix spells it differently per primitive, and a row
 * that shipped its own focus colour is how a "shared" recipe stops being shared.
 */
export const menuRowClass =
  "menu-item group/menu-item relative flex min-h-8 cursor-pointer select-none items-center gap-2.5 " +
  "rounded-control px-2.5 py-1.5 text-ui outline-none " +
  "transition-colors duration-fast ease-out-soft " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "[&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 " +
  "coarse:min-h-11";

/**
 * Muted glyph ink — the row's default, kept OUT of `menuRowClass` on purpose.
 *
 * A destructive row reddens its label and its glyph has to follow, and the two
 * rules are the same shape (`.class svg:not(…)`), so whichever the stylesheet
 * happened to emit second would win. Rather than settle that with an `!`, the
 * ink is applied by whoever knows it applies: DropdownMenu's default variant
 * does, its destructive variant does not (its icons inherit the red), and
 * Select, the `+` menu and the landing nav all do.
 */
export const menuGlyphInkClass =
  "[&_svg:not([class*='text-']):not([class*='fill-'])]:text-muted-foreground";

/**
 * The section head inside a menu. Shares the row's left edge (px-2.5) so a
 * label and the rows under it start on one line — they were 2px apart, which
 * is the kind of gap nobody names and everybody feels.
 */
export const menuLabelClass =
  "px-2.5 pb-1 pt-1.5 text-caption font-medium text-muted-foreground";

/**
 * The hairline between groups. `-mx-1` cancels the shell's p-1 so it runs edge
 * to edge.
 *
 * 10%, and the number was walked to rather than picked. It carried 12%, which
 * inside a 224px panel reads as a rule dividing two menus rather than as the
 * comma it is. 8% was then too far the other way — shot at 2× in both themes,
 * the line was simply not there, and a group break with no line is not a
 * quieter separator, it is a gap. 10% is visible at 1× on both grounds and
 * still lighter than the shell's own edge, which is the ordering that matters:
 * the hairline inside a panel must never out-draw the hairline around it.
 */
export const menuSeparatorClass = "-mx-1 my-1 h-px bg-foreground/10";

/**
 * THE WIDTH LADDER — two rungs, and the reason there are only two.
 *
 * Nine were in use (w-40, 44, 48, 52, 56, 60, 64, 72, 19rem) for menus that do
 * the same job, so opening two kebabs on two pages gave two different objects.
 * Width is not a per-call-site decision; what the rows CARRY is.
 *
 *   MENU_W       a list of verbs — Rename, Share, Delete. The overwhelming case.
 *   MENU_W_WIDE  rows with a second line, a trailing figure, or a submenu of
 *                names the user wrote (projects, connectors, model labels).
 */
export const MENU_W = "w-56";
export const MENU_W_WIDE = "w-72";
