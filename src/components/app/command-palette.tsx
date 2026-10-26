"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  BookOpen,
  Columns2,
  Keyboard,
  Map as MapIcon,
  MessageSquareText,
  Moon,
  PanelLeft,
  SearchX,
  Sun,
  type IconComponent,
} from "@/components/ui/icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/components/app/app-provider";
import { ActionIcons, AppIcons, CodeIcons, ComposerIcons, SettingsIcons, StatusIcons } from "@/lib/app-icons";
import {
  SEARCH_TYPE_LABELS,
  SEARCH_WINDOWS,
  SEARCH_WINDOW_LABELS,
  type SearchHit,
  type SearchMark,
  type SearchSnippet,
  type SearchType,
  type SearchWindow,
  type UnifiedSearchResult,
} from "@/lib/search/types";
import { cn } from "@/lib/utils";
import { openNotifications } from "@/components/notifications/notifications-transport";
import { Pressable } from "@/components/ui/pressable";
import { Kbd } from "@/components/ui/kbd";
import { useModifierKeyLabel } from "@/components/ui/platform";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { staggerDelay } from "@/lib/motion";
import { useAgents } from "@/components/agents/use-agents";
import type { ClientConversation } from "@/types/chat";
import { BRAND, FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";
import { shortcutGroups } from "@/lib/shortcut-groups";
import { useReducedMotion } from "@/lib/motion-preference";
import { chordKeys, chordLabel, isAppleModifier, keyCap } from "@/components/app/key-chord";
import { focusSnippet, matchMarks, SNIPPET_LEAD_WIDE, SNIPPET_TAIL_WIDE } from "@/components/app/palette-text";
import { chipRevealScroll } from "@/components/app/chip-strip";
import { PHONE_QUERY, useMediaQuery } from "@/hooks/use-media-query";
import "@/components/app/palette.css";
import "@/components/app/sidebar-column.css";

/** One row in either palette. `run` fires on click / Enter; `meta` is the muted
 *  trailing text (relative time, "Project"); `hint` renders as ⌘-keys. A
 *  `snippet` turns the row into two lines — the matched line of content under
 *  the title, with the matched terms marked. */
type PaletteItem = {
  id: string;
  group: string;
  label: string;
  meta?: string;
  hint?: string;
  snippet?: SearchSnippet | null;
  /** Matched spans inside `label`, so a title-only match is highlighted too. */
  labelMarks?: SearchMark[];
  icon: IconComponent;
  keywords?: string;
  run: () => void;
};

/**
 * Text with its matched spans marked.
 *
 * The server sends offsets rather than markup (see src/lib/search/types.ts), so
 * this walks them and emits real `<mark>` elements — which is also what makes
 * the highlight legible to a screen reader, since `mark` carries meaning that a
 * coloured `span` does not.
 *
 * `bg-primary/15` deliberately, not `bg-accent`: `accent` is the highlighted
 * row's own fill, so a mark painted with it would vanish on exactly the row the
 * user is looking at.
 *
 * `-mx-0.5` takes back the tint's `px-0.5`, so the letters do not move: a
 * match inside a word ("Pric" in "Pricing") read as "Pric ing", the word
 * split by four pixels of padding.
 */
function Marked({ text, marks }: { text: string; marks: readonly SearchMark[] }) {
  if (marks.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  marks.forEach((mark, i) => {
    if (mark.start > cursor) parts.push(text.slice(cursor, mark.start));
    parts.push(
      <mark key={i} className="-mx-0.5 rounded-micro bg-primary/15 px-0.5 text-primary">
        {text.slice(mark.start, mark.end)}
      </mark>
    );
    cursor = mark.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Compact relative time for the trailing meta ("Just now", "2d", "3mo"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "Just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * The shared palette surface — one shell, two surfaces (search + command menu).
 * It owns everything a11y/motion: the combobox input (role=combobox +
 * aria-activedescendant), the role=listbox/option rows, the highlighted row's
 * cross-fading fill, arrow-key nav + scrollIntoView, Enter-to-run, Escape (via
 * Radix Dialog), the scrim and the spring pop-in. Each surface just hands it an
 * ordered `items` list, a `placeholder` and an `emptyState`.
 */
function PaletteShell({
  open,
  onOpenChange,
  ariaLabel,
  placeholder,
  query,
  onQueryChange,
  items,
  emptyState,
  lead,
  filters,
  notices,
  status,
  resetKey,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ariaLabel: string;
  placeholder: string;
  query: string;
  onQueryChange: (v: string) => void;
  items: PaletteItem[];
  emptyState: React.ReactNode;
  /**
   * Drawn above the rows when there are rows: the command menu's "nothing
   * matched" note over its one remaining row, the hand-off to full search.
   * Presentation only (aria-hidden): say the same thing through `status`.
   */
  lead?: React.ReactNode;
  /** Optional controls between the input and the listbox (search filters). */
  filters?: React.ReactNode;
  /** Optional "here is what could not be searched" strip above the results. */
  notices?: React.ReactNode;
  /** Text announced politely whenever the result set changes. */
  status?: string;
  /**
   * Moves the cursor back to the first row when it changes. The command menu
   * leaves it undefined and keeps its old behaviour; search passes the query
   * and its filters, because a cursor left on row 7 while the results underneath
   * it are replaced is how Enter opens something nobody chose.
   */
  resetKey?: string;
  /**
   * The palette handing focus back as it closes. A command that opens a
   * surface of its own prevents it: focus returning to wherever it was before
   * the palette opened would land outside that surface and dismiss it.
   */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const [active, setActive] = React.useState(0);
  // Key hints in the platform's own spelling: "⌘⇧O" on Apple, "Ctrl Shift O"
  // elsewhere (key-chord.ts).
  const mod = useModifierKeyLabel();
  const baseId = React.useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = React.useCallback((cmdId: string) => `${baseId}-opt-${cmdId}`, [baseId]);
  const listRef = React.useRef<HTMLDivElement>(null);
  // One highlight, carried between rows by `layoutId` (unique per palette).
  const highlightId = `${baseId}-highlight`;
  const reduceMotion = useReducedMotion() ?? false;
  // True when `active` last changed via the keyboard, so we only auto-scroll then
  // (not while the mouse is hovering rows).
  const keyboardNav = React.useRef(false);

  // Reset the cursor to the top each time the surface opens, and whenever the
  // caller says the list underneath it has been replaced.
  React.useEffect(() => {
    if (open) setActive(0);
  }, [open, resetKey]);

  // Whether the READER has moved the cursor since it was last put on row 0.
  // Presentation only: it gates `data-highlighted` (and with it the glyph's
  // hover gesture), never which row Enter runs. Without it the first result's
  // mark sat in its hover pose the moment the palette opened, and the pose
  // hopped rows on every keystroke as results were replaced, with no hand on
  // the list at all — a glyph moving on its own (ICONS_AND_MOTION.md §1.3).
  const [readerMoved, setReaderMoved] = React.useState(false);
  React.useEffect(() => {
    if (open) setReaderMoved(false);
  }, [open, resetKey]);

  React.useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  // Keep the highlighted row in view when navigating with the arrow keys.
  React.useEffect(() => {
    if (!keyboardNav.current) return;
    keyboardNav.current = false;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    // For the first row, scroll to the very top so its group header shows too.
    if (active === 0) listRef.current?.scrollTo({ top: 0 });
    else el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      keyboardNav.current = true;
      setReaderMoved(true);
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      keyboardNav.current = true;
      setReaderMoved(true);
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.run();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        // Pinned near the top so it stays above the phone keyboard: never a bottom sheet.
        sheet={false}
        // svh + inset-x centering (no transform) so the pop-in/out keyframes own
        // `transform`, and the palette stays reachable above the mobile keyboard.
        // Surface/radius/border come from DialogContent; only the position,
        // size and the pop-in keyframes are the palette's own.
        //
        // `[translate:none]` is load-bearing: DialogContent centres itself on the
        // independent `translate` property now, and a translate-x/y utility writes
        // `transform`, so it can no longer cancel it. The palette is not centred
        // vertically, so it has to switch that property off outright.
        //
        // The 180/120 tier stays: Cmd+K is keyboard-initiated and opened dozens of
        // times a day, so it is rightly the fastest overlay in the product. Only the
        // `!` goes, now that DialogContent no longer ships a competing
        // tailwindcss-animate chain for it to beat.
        // The window material is the popover's, OPAQUE (FLAT_UI.md, spec D15:
        // no backdrop-filter in product chrome). It was `bg-popover/88` under a
        // 20px blur, so the page behind ghosted through the results and the
        // reader's own chat titles sat on a moving smear. Cut with a 1px
        // hairline at foreground 10% rather than the border token, the
        // homepage's product-window finish.
        // `sm:p-0` is load-bearing: DialogContent ships `sm:p-6`, which `p-0`
        // alone does not cancel, so the list sat 24px inside the shell and its
        // rows were not concentric with it. Now the list's `p-2` (8) inside the
        // shell's `rounded-panel` (16) holds `rounded-control` (8) rows.
        // Entrance: the shared pop-in keyframe on the homepage curve
        // (expo out), from 0.97 and 6px above, origin at the top edge, where the
        // window hangs from, on the `base` rung (220ms) — it was a 260ms
        // literal, off the duration ladder. The 0.97 start is written behind
        // `motion-safe:` so reduced motion's own scale token still wins; the
        // travel already rides `--motion-shift`, so that leaves a plain fade.
        className="left-0 right-0 top-[9svh] mx-auto w-[calc(100%-2rem)] max-w-[640px] origin-top [translate:none] translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-panel border-foreground/10 bg-popover p-0 motion-safe:[--motion-scale-from:0.97] [--pop-shift:-6px] sm:p-0 data-[state=open]:[animation:pop-in_var(--dur-base)_var(--ease-out-expo)_both] data-[state=closed]:animate-pop-out dark:border-white/10"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector("input")?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogTitle className="sr-only">{ariaLabel}</DialogTitle>

        {/* Search — the palette's one input, given real presence rather than
            the density of a list row: `body-lg` (17px) on a 60px band, which
            is the size the thing you are typing into should be when it is the
            only field on a 560px overlay. It was `body` (15px), the same rung
            as the results under it, so the field read as the first row of the
            list rather than as the control that drives it. */}
        <div className="flex h-14 items-center gap-3 border-b border-foreground/[0.07] px-4 coarse:h-16 dark:border-white/[0.07]">
          <AppIcons.search className="size-5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="h-full w-full bg-transparent text-body-lg tracking-[-0.011em] outline-none placeholder:text-muted-foreground"
            // `ariaLabel`, not the placeholder. The placeholder is one word
            // now ("Search"), and a one-word accessible name on the only input
            // of an overlay is thinner than what a screen reader had before —
            // this is the fuller sentence the dialog is titled with.
            aria-label={ariaLabel}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={items[active] ? optionId(items[active].id) : undefined}
          />
          {/* Fades in with the first character rather than cutting in, and at
              the icon button's own 32px (40 on a coarse pointer) — it was a
              24px target, under the 32px floor, on the one control in this
              field a hand reaches for. The X makes its quarter turn on hover. */}
          {query && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Pressable
                  kind="icon"
                  size="md"
                  onClick={() => onQueryChange("")}
                  aria-label="Clear search"
                  className="-mr-2 shrink-0 text-muted-foreground motion-safe:animate-fade-in"
                >
                  <ActionIcons.dismiss className="size-4" />
                </Pressable>
              </TooltipTrigger>
              <TooltipContent>Clear</TooltipContent>
            </Tooltip>
          )}
        </div>

        {filters}
        {notices}

        {/* The listbox is a visual change, not an announced one — a screen
            reader following aria-activedescendant hears the focused row but
            never hears that eleven others arrived, or that a whole source could
            not be searched. This says both, once per settled result set. */}
        <div role="status" aria-live="polite" className="sr-only">
          {status}
        </div>

        {/* Combobox popup: focus stays on the input; aria-activedescendant
            tracks the highlighted option, so rows are role=option and out of
            the tab order. Group headers are visual-only (aria-hidden).
            A listbox only while there are options in it: the empty states
            (the resting prompt, "nothing matches", the skeleton) are prose,
            and a listbox holding prose and no options is an invalid widget
            (axe: aria-required-children) that a screen reader enters as an
            empty list. The box itself stays, so the overlay keeps its shape. */}
        <div
          ref={listRef}
          id={listboxId}
          role={items.length > 0 ? "listbox" : undefined}
          aria-label={items.length > 0 ? ariaLabel : undefined}
          /*
           * `min-h` as well as `max-h`. With one result the dialog measured
           * 550×233 — a squat box whose footer was a seventh of it — and with
           * none it was shorter still, so the surface CHANGED SHAPE between
           * keystrokes as results arrived and left. A floor holds the overlay
           * still while you type, which is the difference between a palette
           * and a tooltip that grew.
           *
           * 13rem is the height the SEARCHING state already holds — five
           * skeleton rows at `h-9` plus their gaps and the list's own padding —
           * so results landing under a query never resize the overlay at all,
           * and a short resting list does not sit in a void.
           */
          className="relative min-h-[13rem] max-h-[min(56svh,calc(100dvh-10rem))] overflow-y-auto overscroll-contain scroll-fade-y p-2"
        >
          {/*
           * THE HIGHLIGHT (history: it cross-faded per row; it slides again now, see below).
           *
           * It was one absolutely-positioned bar driven by a layout effect that
           * measured the active row and wrote `translateY` AND `height` into it
           * — the one animated `height` in the shell, and the reason a snippet
           * row (two lines) and a title row (one) made the bar visibly stretch
           * as it travelled between them. A bar flying past four rows to reach
           * the one under the pointer also says "something moved" about a list
           * where nothing did.
           *
           * Each row now owns its fill and fades it on the `fast` rung, the
           * same tonal cross-fade every menu row in the product makes — so
           * arrowing down a list reads as the highlight handing over, row to
           * row, the way Claude's and ChatGPT's palettes do. `bg-accent`, the
           * menus' own highlight, now that the dark theme's accent sits four
           * points off the popover rather than on it.
           *
           * Rows are `rounded-control` (8): the shell is `rounded-panel` (16)
           * and the list insets it by `p-2` (8), so 8 is the concentric
           * radius.
           *
           * Since the refinement pass the fill is ONE element again, but carried
           * by framer's `layoutId` on a short, critically damped spring rather
           * than a measured `translateY` + `height`: framer projects the box, so
           * a two-line row and a one-line row hand over without the bar
           * stretching, and the arrow keys move it one row in ~120ms. Reduced
           * motion snaps it.
           */}
          {items.length > 0 && lead ? <div aria-hidden="true">{lead}</div> : null}
          {items.length === 0
            ? emptyState
            : items.map((c, i) => {
                const showHeader = i === 0 || items[i - 1].group !== c.group;
                const Icon = c.icon;
                const isActive = active === i;
                return (
                  <React.Fragment key={c.id}>
                    {showHeader && (
                      // Keyed off the index rather than a `first:` variant: the
                      // header is a sibling of the rows in one flat list, so
                      // "first" has to mean the first ROW's group.
                      <div
                        aria-hidden="true"
                        // The SIDEBAR's section voice, which this list's rows
                        // are a flat copy of: sentence-case sans at `ui`,
                        // muted, one rung under the rows it heads. It was a
                        // mono uppercase eyebrow — the treatment a settings
                        // page heads its groups with — and a machine voice
                        // over "Chats" and "Projects" is what made a list of
                        // the reader's own things read as a console.
                        // Arrives with the row it heads, on that row's beat.
                        style={staggerDelay(Math.min(i, 8), "tight")}
                        className={cn(
                          "px-2 pb-1.5 text-caption font-medium text-muted-foreground motion-safe:animate-fade-in [animation-fill-mode:backwards]",
                          // 24px before a later group, matching the break the
                          // sidebar leaves above a section heading. It was 16,
                          // which is the same gap the rows inside a group use
                          // between themselves — so a new group started with no
                          // more ceremony than the next line of the old one.
                          i === 0 ? "pt-1.5" : "pt-5"
                        )}
                      >
                        {c.group}
                      </div>
                    )}
                    <button
                      type="button"
                      id={optionId(c.id)}
                      role="option"
                      tabIndex={-1}
                      data-index={i}
                      // The highlighted row is `data-highlighted`, the attribute
                      // Radix sets on a menu row under the keyboard, so its
                      // glyph makes its one gesture (globals.css) when the
                      // arrow keys land on it and not only under the pointer.
                      // Only once the reader has moved the cursor: the row the
                      // palette opens (or re-filters) onto is `aria-selected`
                      // and filled, but its mark stays at rest, the way a
                      // Radix menu opened by the pointer highlights nothing.
                      data-highlighted={isActive && readerMoved ? "" : undefined}
                      onMouseMove={() => {
                        setActive(i);
                        setReaderMoved(true);
                      }}
                      onClick={() => c.run()}
                      aria-selected={isActive}
                      // Dealt, not dumped: rows that arrive together — on open,
                      // and when a search lands — fade in on the `tight`
                      // stagger, the first eight in sequence and the rest with
                      // the eighth. A row that survives a keystroke keeps its
                      // key and does not replay. Opacity only, so nothing moves
                      // under a pointer already on its way to a row.
                      style={staggerDelay(Math.min(i, 8), "tight")}
                      className={cn(
                        // ONE GRID WITH THE SIDEBAR. `px-2` inside the list's
                        // `p-2` puts the glyph on 16 and `gap-2.5` carries the
                        // text to 46 — the same two numbers every destination
                        // row in the panel behind this overlay is built on.
                        // `text-body` (15px) for the same reason: a result is
                        // the reader's own chat or file, and it was set two
                        // rungs under the field that found it.
                        "menu-item group group/menu-item relative flex w-full gap-2.5 rounded-control px-2 text-left text-body transition-colors duration-fast ease-out-soft motion-safe:animate-fade-in motion-reduce:transition-none [animation-fill-mode:backwards]",
                        // A fixed 36px when the row is one line — a hair above
                        // the sidebar's 32, because this list is driven by the
                        // arrow keys and its rows are targets as well as text.
                        // A snippet makes it two lines, so it grows instead,
                        // and hangs its glyph and meta off the TITLE rather
                        // than off the centre of the pair.
                        c.snippet ? "items-start py-2 coarse:py-2.5" : "h-9 items-center coarse:h-11",
                        // Every row at full ink. Inactive rows were drawn at
                        // 75%, so the reader's own chat titles read greyed out
                        // until the cursor reached them; the fill below is what
                        // marks the active row, and its glyph steps up with it.
                        "text-foreground"
                      )}
                    >
                      {/* A PLAIN GLYPH, not a plated one. Every row used to
                          carry a 28px bordered tile with its own fill, on the
                          argument that it gave the row a consistent optical
                          anchor and let the active state read without moving
                          anything — both true, and both bought at the price of
                          a list of the reader's own chats looking like a
                          console. Ten rows meant ten bordered plates stacked
                          down a 560px overlay, which is the single thing that
                          made this surface read as heavy.
                          The anchor survives: the glyph still sits in a fixed
                          `size-5` slot, so every title lands on one text edge
                          whether its row has a snippet or not. The active state
                          survives too — the row's own fill carries it, and the
                          ink goes to full strength on top. `mt-px` on a
                          two-line row drops the glyph onto the title's optical
                          centre rather than its box's. */}
                      {isActive && (
                        <motion.span
                          layoutId={highlightId}
                          aria-hidden="true"
                          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
                          style={{ borderRadius: 8 }}
                          className="absolute inset-0 bg-foreground/[0.06] shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.05)] dark:bg-white/[0.07] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]"
                        />
                      )}
                      <span
                        className={cn(
                          "relative flex size-5 shrink-0 items-center justify-center transition-colors duration-fast ease-out-soft [&_svg]:size-4.5",
                          c.snippet && "mt-px",
                          isActive ? "text-foreground" : "text-muted-foreground"
                        )}
                      >
                        <Icon />
                      </span>
                      <span className="relative min-w-0 flex-1">
                        {/* A title that does not fit fades out rather than
                            ending in "…" (sidebar-column.css), as the
                            sidebar's rows do. */}
                        <span className="title-fade block">
                          <Marked text={c.label} marks={c.labelMarks ?? []} />
                        </span>
                        {/* Up to two lines, and cut so its match is in view
                            (`focusSnippet`): one truncated line put the
                            highlighted word past the edge on a phone, so a
                            body hit looked unrelated to the query. */}
                        {c.snippet && (
                          <span className="mt-0.5 line-clamp-2 text-ui leading-[1.45] text-muted-foreground">
                            <Marked text={c.snippet.text} marks={c.snippet.marks} />
                          </span>
                        )}
                      </span>
                      {c.meta && (
                        // Full --muted-foreground at the caption rung. At /55 this
                        // composited to ~2.9:1 on black — on the timestamp that is
                        // the only thing telling two same-titled chats apart.
                        <span className="relative shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{c.meta}</span>
                      )}
                      {c.hint && (
                        // The shortcuts sheet's convention, so one chord is
                        // drawn one way everywhere: a cap per glyph on a Mac
                        // (⌘ ⇧ O), and elsewhere ONE cap spelled as Windows and
                        // Linux write a chord, "Ctrl+Shift+O" (`chordLabel`),
                        // as the sidebar and the sheet draw it. Three word caps
                        // here beside one in the sheet read as two products.
                        <span className="relative flex shrink-0 items-center gap-1">
                          {isAppleModifier(mod) ? (
                            chordKeys(c.hint, mod).map((k, ki) => <Kbd key={ki}>{k}</Kbd>)
                          ) : (
                            <Kbd>{chordLabel(c.hint, mod)}</Kbd>
                          )}
                        </span>
                      )}
                    </button>
                  </React.Fragment>
                );
              })}
        </div>

        {/*
         * NO KEYCAP STRIP. It was a bordered, filled band carrying
         * "↑ ↓ navigate  ↵ open · esc close" — 34px of a 233px dialog, about
         * one seventh of the whole surface, spent restating the three
         * conventions every search overlay on every platform already obeys.
         * With one result in the list it was as tall as the result.
         *
         * It is not an accessibility loss: the listbox is a real combobox
         * popup with `aria-activedescendant`, the row count is announced
         * through the live region above, and arrow/enter/escape are what a
         * screen reader's own docs say a combobox does. What went is a
         * picture of a keyboard.
         */}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the list says when it has no rows: one muted glyph in a quiet tile, one
 * sentence and — only where it adds something — a second line saying what to
 * do (ICONS_AND_MOTION.md §3). It fades in rather than cutting, because it
 * replaces a list the reader was just looking at.
 */
function PaletteEmpty({
  icon: Icon,
  tone = "empty",
  title,
  hint,
}: {
  icon: IconComponent;
  tone?: "empty" | "error";
  title: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-3 py-10 text-center motion-safe:animate-fade-in">
      <span
        className={cn(
          "mb-4 flex size-10 items-center justify-center rounded-card border border-foreground/[0.07]",
          tone === "error" ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground"
        )}
      >
        <Icon className="size-5" motion="none" aria-hidden="true" />
      </span>
      <p className="text-body-lg text-foreground">{title}</p>
      {hint && <p className="mt-1.5 text-ui text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Projects aren't in app context, so the search surface fetches them for its filter. */
type PaletteProject = { id: string; name: string; starred: boolean; updatedAt: string };

/** One row of /api/recents — the merged Chat / Work / Code / Projects timeline. */
type RecentRow = { id: string; kind: string; title: string; updatedAt: string; href: string };

/*
 * Result marks come from the registries (src/lib/app-icons.ts), so a chat, a
 * project or a memory is drawn here exactly as the sidebar, the composer and
 * Settings draw it. A conversation was a SQUARE bubble in this list while the
 * sidebar, the product switch and every conversation row drew the round one —
 * one idea, two drawings, open side by side. A matched MESSAGE keeps the
 * squared bubble with lines in it, because it is a different thing: a line
 * inside a conversation rather than the conversation.
 */
const SEARCH_TYPE_ICONS: Record<SearchType, IconComponent> = {
  conversation: AppIcons.conversation,
  message: MessageSquareText,
  project: AppIcons.projects,
  file: CodeIcons.file,
  knowledge: BookOpen,
  artifact: AppIcons.artifacts,
  memory: ComposerIcons.memory,
  work: AppIcons.work,
};

const RECENT_ICONS: Record<string, IconComponent> = {
  chat: AppIcons.conversation,
  work: AppIcons.work,
  code: AppIcons.code,
  project: AppIcons.projects,
};

/**
 * How long the input rests before a search is issued.
 *
 * 180ms rather than the usual 300: the request is cancelled on the next
 * keystroke anyway, and this surface is judged on whether results appear to
 * follow the typing. Long enough to skip most intermediate words, short enough
 * that a three-word query does not feel like it is buffering.
 */
const SEARCH_DEBOUNCE_MS = 180;

/** Radix Select reserves "" for "nothing selected", so the "no project filter"
 *  option needs a real value of its own. */
const ALL_PROJECTS = "__all__";

/** A filter chip. A real button with a pressed state, not a styled div. */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      // No `transition-colors`: `.pressable` already declares one covering both
      // colour and transform, and a transition-* utility replaces that shorthand
      // outright — which is what dropped `transform` and left the press dip
      // snapping to scale(.97) in one frame on every chip in this strip.
      //
      // The fills are re-based on the popover this strip floats in. Both were
      // dead on dark: --accent IS --popover (48 5% 13%), so the pressed chip was
      // the panel colour, and `bg-muted/50` composited to ~11.3% against 13%,
      // i.e. under the two points where a fill starts existing. The unpressed
      // chip now takes the popover's recessed rung whole and the pressed one an
      // ink tint, which is the only thing that lifts off a floating layer.
      className={cn(
        // `text-label` (12px) on a 28px pill, up from `caption` (11px) on 22.
        // Eleven pixels is the rung PREMIUM_AUDIT keeps for machine metadata,
        // and these are the controls that decide what the list contains.
        "pressable inline-flex h-7 shrink-0 items-center rounded-full border px-2.5 text-label coarse:min-h-11 coarse:px-3",
        active
          ? "border-border bg-foreground/10 text-foreground"
          : "border-transparent bg-secondary text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

/**
 * SURFACE A — Search. The magnifying-glass button opens this (event
 * "juno:search"); it does NOT open on ⌘K.
 *
 * This used to filter the conversation titles the app context happened to be
 * holding, in the browser. That was never search: it could not see message
 * text, files, knowledge, artifacts, memories or tasks, it silently excluded
 * archived chats, and it stopped at whatever the 200-row context contained.
 * There was a server-side title search behind `GET /api/conversations?q=` and
 * nothing in the repository ever passed the `q`.
 *
 * It now calls /api/search, which searches all eight sources and reports what
 * it could not cover (see src/lib/search/index.ts for why the message branch is
 * bounded). The command menu below is deliberately untouched: content search
 * and command execution share this shell, and nothing else. A palette that
 * mixes "open the thing I wrote" with "run this action" makes Enter ambiguous
 * at the exact moment it must not be.
 */
function SearchPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [type, setType] = React.useState<SearchType | "all">("all");
  const [dateWindow, setDateWindow] = React.useState<SearchWindow>("any");
  const [projectId, setProjectId] = React.useState("");
  const [projects, setProjects] = React.useState<PaletteProject[]>([]);
  const [recents, setRecents] = React.useState<RecentRow[]>([]);
  const [result, setResult] = React.useState<UnifiedSearchResult | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const narrow = useMediaQuery(PHONE_QUERY);

  const go = React.useCallback(
    (href: string) => {
      router.push(href);
      setOpen(false);
    },
    [router]
  );

  /*
   * A query handed over with the event (`detail.query`): the command menu's
   * last row, "Search messages and files for …", sends what the reader typed
   * there, so one keyboard path reaches full-text search without typing it
   * twice. Held in a ref because the reset below runs AFTER this listener on
   * open and would clear it; the reset seeds the field from it instead.
   */
  const seedQuery = React.useRef("");
  React.useEffect(() => {
    const openSearch = (event: Event) => {
      const seeded = (event as CustomEvent<{ query?: unknown } | null>).detail?.query;
      seedQuery.current = typeof seeded === "string" ? seeded : "";
      // Already open (the reset will not run again): take the query now.
      if (seedQuery.current) setQuery(seedQuery.current);
      setOpen(true);
    };
    window.addEventListener("juno:search", openSearch);
    return () => window.removeEventListener("juno:search", openSearch);
  }, []);

  // A fresh surface every time: the previous query's results behind a cleared
  // input would be read as results for the empty one. A handed-over query is
  // the one exception, and it is taken once.
  React.useEffect(() => {
    if (!open) return;
    setQuery(seedQuery.current);
    seedQuery.current = "";
    setType("all");
    setDateWindow("any");
    setProjectId("");
    setResult(null);
    setFailed(false);
  }, [open]);

  // Recents and the project list, refreshed each time the surface opens. The
  // last list stays visible until the fresh one lands so the default view does
  // not flash empty; a failure keeps whatever was there, which is why neither
  // catch clears state.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;

    fetch("/api/recents?limit=8")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { items?: unknown }) => {
        if (cancelled || !Array.isArray(data.items)) return;
        setRecents(
          (data.items as Array<Record<string, unknown>>).map((row) => ({
            id: String(row.id ?? ""),
            kind: String(row.kind ?? "chat"),
            title: String(row.title ?? ""),
            updatedAt: String(row.updatedAt ?? ""),
            href: String(row.href ?? "/"),
          }))
        );
      })
      .catch(() => {});

    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { projects?: unknown }) => {
        if (cancelled || !Array.isArray(data.projects)) return;
        setProjects(
          (data.projects as Array<Record<string, unknown>>).map((p) => ({
            id: String(p.id ?? ""),
            name: String(p.name ?? ""),
            starred: Boolean(p.starred),
            updatedAt: String(p.updatedAt ?? ""),
          }))
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [open]);

  const trimmed = query.trim();

  /**
   * The search itself: debounce, then one request that the next keystroke
   * aborts. Aborting matters more than the debounce — without it the answer to
   * "guar" can arrive after the answer to "guard" and overwrite it, and the
   * user watches their own results get worse as they finish the word.
   */
  React.useEffect(() => {
    if (!open || !trimmed) {
      setResult(null);
      setSearching(false);
      setFailed(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed });
      if (type !== "all") params.set("types", type);
      if (projectId) params.set("projectId", projectId);
      if (dateWindow !== "any") params.set("window", dateWindow);
      fetch(`/api/search?${params.toString()}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data: UnifiedSearchResult) => {
          setResult(data);
          setFailed(false);
          setSearching(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          // A failed search must not look like an empty account.
          setResult(null);
          setFailed(true);
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed, type, projectId, dateWindow]);

  const items = React.useMemo<PaletteItem[]>(() => {
    if (!trimmed) {
      return recents.map((row) => ({
        id: "recent-" + row.kind + "-" + row.id,
        group: "Recent",
        label: row.title || "Untitled",
        meta: relativeTime(row.updatedAt),
        icon: RECENT_ICONS[row.kind] ?? AppIcons.conversation,
        run: () => go(row.href),
      }));
    }
    if (!result) return [];
    return result.groups.flatMap((group) =>
      group.hits.map((hit: SearchHit) => ({
        id: hit.id,
        group: group.label,
        label: hit.title,
        meta: hit.locator ?? relativeTime(hit.updatedAt),
        // Cut to the match on a phone row only; a wider row has room for
        // the server's whole window (palette-text.ts).
        snippet: hit.snippet
          ? narrow
            ? focusSnippet(hit.snippet)
            : focusSnippet(hit.snippet, SNIPPET_LEAD_WIDE, SNIPPET_TAIL_WIDE)
          : null,
        labelMarks: hit.titleMarks,
        icon: SEARCH_TYPE_ICONS[hit.type],
        run: () => go(hit.href),
      }))
    );
  }, [trimmed, recents, result, go, narrow]);

  // Only the sources that came back short say anything, and each says what it
  // was: "still being indexed" and "could not be read" are different problems
  // with different answers, and collapsing them into "partial results" leaves
  // the user with nothing to do about either.
  const notices = React.useMemo(() => {
    const list = (result?.coverage ?? []).filter((c) => c.state !== "complete" && c.detail);
    if (!trimmed || list.length === 0) return null;
    const shown = list.slice(0, 2);
    // Same recessed rung as the footer strip. `bg-muted/20` landed ~0.7 of a
    // point off the popover behind it, so the one band saying "part of your
    // account could not be searched" had no band.
    return (
      <div className="border-b border-foreground/[0.07] bg-secondary/70 px-4 py-2 dark:border-white/[0.07]">
        {shown.map((c) => (
          <p key={c.type} className="text-caption leading-snug text-muted-foreground">
            <span className="text-foreground">{SEARCH_TYPE_LABELS[c.type]}:</span> {c.detail}
          </p>
        ))}
        {list.length > shown.length && (
          <p className="text-caption leading-snug text-muted-foreground">
            {list.length - shown.length} more part of your account was searched only in part.
          </p>
        )}
      </div>
    );
  }, [result, trimmed]);

  /*
   * THE KIND OF THING SCROLLS; WHEN AND WHERE STAY IN VIEW.
   *
   * This was two stacked rows — eight type chips above, four date chips and a
   * project Select below — which is thirteen controls in 64px directly under
   * the field and directly above the results, and read as a control panel.
   * Then it was one scrolling row of all fourteen, which hid the date chips
   * and the project filter off the right edge (1193px of chips in a 614px
   * strip, 1245 in 332 on a phone) behind a scrollbar macOS and iOS do not
   * draw, sliced the ninth chip mid-pill, and lost a "Past week" left on the
   * moment the strip re-mounted at its start: a filter you cannot see is a
   * filter you will not remember is on.
   *
   * Now the type chips alone scroll, and their strip fades at whichever end
   * continues (`chip-scroller`, palette.css). When and which project are two
   * compact Selects pinned at the end of the line, outside the scroller, so
   * whatever they are set to is always on screen, drawn filled when it is not
   * the default as a pressed chip is. On a phone they take a second line
   * rather than squeezing the chips to nothing.
   */
  const chipStrip = React.useRef<HTMLDivElement>(null);
  const hasQuery = trimmed.length > 0;
  /* The pressed type chip is brought into the strip: on a new query the
     strip mounts at its start, and a pressed "Tasks" off the right end is
     the stuck filter this layout exists to prevent. The strip scrolls and
     nothing else does (not `scrollIntoView`, which would move the dialog),
     with 32px of margin so the chip clears the strip's edge fade.

     AGAIN WHENEVER THE STRIP CHANGES WIDTH, not once. At remount the Selects
     beside it have not drawn their values yet, so the strip is wider than it
     will be a frame later; one measurement taken then left "Tasks" pressed
     and off the right edge after an emptied field was typed into again. The
     math is on layout offsets (`chipRevealScroll`), which a running open
     animation's transform does not skew.

     AND AGAIN AFTER EITHER SELECT CLOSES. While a Select hands focus back to
     its trigger, the trigger is laid out for an instant without its value,
     so the strip beside it is briefly ~60px wider and the browser clamps the
     strip's scroll to that wider box ("Tasks" pressed, "Past week" picked:
     272 became 212 and "Tasks" sat just off the edge). The strip ends the
     frame at the width it started, so no resize is ever observed; the frame
     after the close is when the pressed chip is brought back. */
  const revealPressedChip = React.useCallback(() => {
    const strip = chipStrip.current;
    const chip = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!strip || !chip) return;
    const next = chipRevealScroll({
      chipLeft: chip.offsetLeft,
      chipWidth: chip.offsetWidth,
      scrollLeft: strip.scrollLeft,
      clientWidth: strip.clientWidth,
      scrollWidth: strip.scrollWidth,
    });
    if (next !== null) strip.scrollLeft = next;
  }, []);
  React.useLayoutEffect(() => {
    const strip = chipStrip.current;
    if (!strip) return;
    revealPressedChip();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealPressedChip);
    observer.observe(strip);
    const pressed = strip.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (pressed) observer.observe(pressed);
    return () => observer.disconnect();
  }, [type, hasQuery, revealPressedChip]);
  // Not `preventDefault`: the trigger still takes focus back as usual.
  const afterFilterClose = React.useCallback(() => {
    requestAnimationFrame(revealPressedChip);
  }, [revealPressedChip]);
  const filterSelectClass = (isSet: boolean) =>
    cn(
      // Deliberately overrides `.field-well` (select.tsx), which paints a fill
      // and an inset shadow: these triggers sit in a strip of chips, not in a
      // form, so they take the FilterChip pill shape, height and fills.
      // `shadow-none` is what cancels the well's inset — a groove under a
      // 28px pill reads as damage — and it has to be a utility, because
      // utilities are emitted after the components layer.
      // `w-auto`: the trigger is a full-width field by default. The `dark:`
      // fills repeat the light ones because the field's own `dark:` border
      // and fill would otherwise win in dark mode, and the Select would be
      // the one boxed control in a strip of pills.
      //
      // FOCUS IS THE CHIPS' FOCUS. The field's own `focus-visible:` primary
      // border, 3px halo and background fill are not under the keyboard-only
      // gate (lib/input-modality.ts), so a date or project picked with the
      // mouse left a near-black edge and a halo on its pill until focus moved:
      // a heavy border in a strip of soft pills. They are cancelled here, so
      // the pill keeps its rest or set look; a keyboard user gets the 2px
      // ring outline every FilterChip beside it draws (the trigger's own
      // `focus-visible:outline-none` would otherwise leave it no mark at all).
      "h-7 w-auto shrink-0 gap-1.5 rounded-full border px-2.5 py-0 text-label shadow-none focus-visible:shadow-none kbd-focus:outline kbd-focus:outline-2 kbd-focus:outline-offset-2 kbd-focus:outline-ring coarse:min-h-11",
      isSet
        ? "border-border bg-foreground/10 text-foreground focus-visible:border-border focus-visible:bg-foreground/10 dark:border-border dark:bg-foreground/10"
        : "border-transparent bg-secondary text-muted-foreground hover:border-transparent hover:text-foreground focus-visible:border-transparent focus-visible:bg-secondary dark:border-transparent dark:bg-secondary"
    );
  const filters = trimmed ? (
    // `min-w-0`: the dialog lays its children out on a grid, and a grid
    // item's automatic minimum is its content's width, which for a strip of
    // chips is wider than the dialog. Without it the strip did not scroll; it
    // widened the whole column, so every result row ran past the dialog's
    // right edge and lost its trailing time.
    <div className="min-w-0 border-b border-foreground/[0.07] px-3 py-2 dark:border-white/[0.07]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <div
          ref={chipStrip}
          role="group"
          aria-label="Filter by type"
          // `relative`: the strip is its chips' offset parent, which is what
          // `chipRevealScroll` measures against.
          className="chip-scroller no-scrollbar relative flex min-w-0 flex-[1_1_12rem] gap-1 overflow-x-auto"
        >
          <FilterChip active={type === "all"} onClick={() => setType("all")}>
            Everything
          </FilterChip>
          {(Object.keys(SEARCH_TYPE_LABELS) as SearchType[]).map((t) => (
            <FilterChip key={t} active={type === t} onClick={() => setType(t)}>
              {SEARCH_TYPE_LABELS[t]}
            </FilterChip>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Select value={dateWindow} onValueChange={(v) => setDateWindow(v as SearchWindow)}>
            <SelectTrigger aria-label="Filter by date" className={filterSelectClass(dateWindow !== "any")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent onCloseAutoFocus={afterFilterClose}>
              {SEARCH_WINDOWS.map((w) => (
                <SelectItem key={w} value={w}>
                  {SEARCH_WINDOW_LABELS[w]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {projects.length > 0 && (
            // The Radix Select, not a native <select>: the OS popup list
            // ignored --popover, the border tokens and the pop-in/out pair.
            // `ALL` stands in for the empty value because Radix reserves ""
            // for "no selection".
            <Select
              value={projectId || ALL_PROJECTS}
              onValueChange={(v) => setProjectId(v === ALL_PROJECTS ? "" : v)}
            >
              <SelectTrigger aria-label="Filter by project" className={cn(filterSelectClass(projectId !== ""), "max-w-[10rem]")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-w-[16rem]" onCloseAutoFocus={afterFilterClose}>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="truncate">{p.name || "Untitled project"}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </div>
  ) : null;


  // Five states, each with its own words. "Searching" is not "nothing found",
  // and a request that failed is not an empty account — telling someone their
  // account is empty when the network dropped is the one mistake this surface
  // must never make, because they will believe it.
  //
  // In flight, the surface holds its SHAPE rather than its words. A single
  // centred "Searching…" inside a 10rem block collapsed the palette to nearly
  // empty on every keystroke past the debounce, which reads as "no results" for
  // 200ms at a time; placeholder rows at the result row's own geometry keep the
  // list's height and say loading instead. The sidebar already answers the
  // identical situation this way.
  //
  // AND EACH PLACEHOLDER IS A RESULT ROW, not a grey bar: the 16px glyph in
  // its 20px slot on the rows' 16px edge, a title line and a shorter snippet
  // line on the 46px text edge, at the two-line row's own padding, dealt on
  // the `tight` stagger the rows arrive on. Five full-width slabs said
  // "loading" and nothing about what was coming. Three of them, 61px each,
  // fill the list's 13rem floor, so the overlay keeps its height.
  const emptyState = searching ? (
    <div aria-hidden="true">
      {["62%", "48%", "70%"].map((width, i) => (
        <div key={i} className="flex items-start gap-2.5 px-2 py-2 coarse:py-2.5">
          <span className="flex size-5 shrink-0 items-center justify-center">
            <span className="skeleton size-4 rounded-xs" style={staggerDelay(i, "tight")} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex h-6 items-center">
              <span className="skeleton block h-3 rounded-full" style={{ width, ...staggerDelay(i, "tight") }} />
            </span>
            <span className="mt-0.5 flex h-[1.1875rem] items-center">
              <span className="skeleton block h-2.5 w-2/5 rounded-full" style={staggerDelay(i, "tight")} />
            </span>
          </span>
        </div>
      ))}
    </div>
  ) : failed ? (
    <PaletteEmpty
      icon={StatusIcons.error}
      tone="error"
      title="Search is unavailable right now."
      hint="Check your connection and try the search again."
    />
  ) : trimmed ? (
    <PaletteEmpty
      icon={SearchX}
      title={<>Nothing matches “{query}”.</>}
      hint="Try fewer words, or widen the filters above."
    />
  ) : (
    // The one sentence on an otherwise empty 560px overlay, so it is
    // foreground ink at the reading rung rather than a muted line: at
    // `text-body text-muted-foreground` the prompt that tells you what this
    // surface can find was quieter than the placeholder in the field above it.
    <PaletteEmpty
      icon={AppIcons.search}
      title={`Search everything in ${PRODUCT_NAME}`}
      hint="Chats and their messages, projects, files, artifacts, memories and tasks."
    />
  );

  const status = !trimmed
    ? ""
    : failed
      ? "Search is unavailable right now."
      : searching
        ? "Searching"
        : `${items.length} ${items.length === 1 ? "result" : "results"}${
            result?.partial ? ", some sources searched only in part" : ""
          }`;

  return (
    <PaletteShell
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Search everything"
      // A word, not an inventory. At 17px the old placeholder —
      // "Search chats, files, artifacts, memory and tasks" — ran the full
      // width of the field and read as a sentence you had to finish
      // rather than a box you type into. What it listed is still listed,
      // in the empty state directly below, which is the one moment that
      // list is useful and the one place there is room for it.
      placeholder="Search"
      query={query}
      onQueryChange={setQuery}
      items={items}
      filters={filters}
      notices={notices}
      status={status}
      resetKey={`${trimmed}|${type}|${dateWindow}|${projectId}`}
      emptyState={emptyState}
    />
  );
}

/**
 * SURFACE B — Command menu. Keyboard-first (⌘K, plus the "juno:command-palette"
 * event).
 *
 * AT REST IT LEADS WITH THE READER'S OWN WORK: the five most recent chats,
 * then six actions (new chat, new code session, search, the sidebar, the
 * inbox, settings). It used to open on twenty-four commands — "New routine",
 * "Open pull requests", "Roadmap…" — before the first chat, so the one thing
 * a person most often opens it for was below the fold of a 560px overlay.
 * Every other destination, the code sessions, the projects, the agents and
 * the rest of Settings are still here and one word away: a typed query
 * searches all of them, best match first.
 *
 * AND A QUERY NEVER DEAD-ENDS. It ends on "Search messages and files for …",
 * which hands the words to the search surface, so a sentence that matches no
 * title still goes somewhere on Enter.
 */
function CommandMenu() {
  const router = useRouter();
  const pathname = usePathname();
  // The rows' key hints print the platform's own modifier: a Windows or Linux
  // reader was shown "⌘" for four shortcuts their keyboard cannot make.
  const mod = useModifierKeyLabel();
  const { setTheme, resolvedTheme } = useTheme();
  const { conversations, setSettings } = useApp();
  const [open, setOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [projects, setProjects] = React.useState<PaletteProject[]>([]);
  /*
   * A command that opens a surface of its own (the notifications popover)
   * runs once the palette has closed, in place of focus going back to where
   * it was. Run earlier, the popover opens and the returning focus lands
   * outside it a moment later, which dismisses it.
   */
  const afterClose = React.useRef<(() => void) | null>(null);
  const onCloseAutoFocus = React.useCallback((event: Event) => {
    const next = afterClose.current;
    if (!next) return;
    afterClose.current = null;
    event.preventDefault();
    next();
  }, []);

  const go = React.useCallback(
    (href: string) => {
      router.push(href);
      setOpen(false);
    },
    [router]
  );

  const toggleTheme = React.useCallback(() => {
    const next = resolvedTheme === "dark" ? "light" : "dark";
    setTheme(next);
    setSettings({ theme: next });
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: next }),
    }).catch(() => {});
  }, [resolvedTheme, setSettings, setTheme]);

  // Global hotkeys + event bus (so the user menu can open these too).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setOpen(false);
        router.push("/chat");
        window.dispatchEvent(new CustomEvent("juno:new-chat"));
      } else if (mod && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    const openMenu = () => setOpen(true);
    const openShortcuts = () => setShortcutsOpen(true);
    // ⌘⇧L (use-global-shortcuts) lands here: this is the one place the theme
    // toggle also writes the setting back.
    const onToggleTheme = () => toggleTheme();
    window.addEventListener("keydown", onKey);
    window.addEventListener("juno:command-palette", openMenu);
    window.addEventListener("juno:shortcuts", openShortcuts);
    window.addEventListener("juno:toggle-theme", onToggleTheme);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("juno:command-palette", openMenu);
      window.removeEventListener("juno:shortcuts", openShortcuts);
      window.removeEventListener("juno:toggle-theme", onToggleTheme);
    };
  }, [router, toggleTheme]);

  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const { agents: rawSidebarAgents } = useAgents({ enabled: open });
  const sidebarAgents = React.useMemo(() => rawSidebarAgents ?? [], [rawSidebarAgents]);

  // Projects are not in app context; fetched per open so the section is live.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { projects?: unknown }) => {
        if (cancelled || !Array.isArray(data.projects)) return;
        setProjects(
          (data.projects as Array<Record<string, unknown>>).map((p) => ({
            id: String(p.id ?? ""),
            name: String(p.name ?? ""),
            starred: Boolean(p.starred),
            updatedAt: String(p.updatedAt ?? ""),
          }))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  const typed = query.trim();
  const q = typed.toLowerCase();

  const items = React.useMemo<PaletteItem[]>(() => {
    /*
     * A QUERY MATCHES AT A WORD START, NEVER INSIDE ONE.
     *
     * This was a raw `includes` over a space-joined keyword blob, and the
     * blob is where it went wrong: "Open Artifacts" carried the keywords
     * "documents canvas generated", so typing `rate` matched it — inside
     * "gene-RATE-d". Actions is the first section and its first row is the
     * default selection, so typing the exact title of a conversation and
     * pressing Enter navigated to the Artifacts page instead of opening the
     * chat. `gen`, `an`, `ate`, `ent` and a dozen other common fragments do
     * the same thing across the other rows.
     *
     * A word-start rule kills all of them and costs nothing real: `doc` still
     * finds "documents", `canvas` still finds "canvas", and a multi-word
     * query like `pull req` still matches "Open pull requests" because the
     * needle only has to BEGIN on a boundary, not end on one. Matching the
     * middle of a word was never a feature anybody asked for; it was what
     * `includes` happened to do.
     */
    const atWordStart = (hay: string, needle: string) => {
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
        if (i === 0 || !/[a-z0-9]/.test(hay[i - 1])) return true;
      }
      return false;
    };
    const matches = (label: string, keywords?: string) =>
      !q || atWordStart(label.toLowerCase(), q) || (keywords ? atWordStart(keywords, q) : false);
    /*
     * How well a row answers the query, so the best answer is the row Enter
     * runs. A label that starts with the query beats one with the query at a
     * later word, which beats a keyword; a title that merely contains it (the
     * chats' substring rule) ranks with a keyword. Typing `new` puts New chat
     * ahead of a chat about "the new Florence plan", and typing `sync` still
     * opens the chat about the sync worker.
     */
    const score = (label: string, keywords?: string) => {
      const l = label.toLowerCase();
      if (l.startsWith(q)) return 3;
      if (atWordStart(l, q)) return 2;
      if (l.includes(q) || (keywords ? atWordStart(keywords, q) : false)) return 1;
      return 0;
    };

    /* What the menu shows before anything is typed: the actions a person
       reaches for daily. The rest are matched, not listed. */
    const AT_REST = new Set(["new-chat", "new-code", "search-everything", "toggle-sidebar", "notifications"]);

    const actions: PaletteItem[] = [
      {
        id: "new-chat",
        group: "Actions",
        label: "New chat",
        hint: `${mod}⇧O`,
        icon: AppIcons.new,
        keywords: "start compose message",
        run: () => {
          go("/chat");
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
        },
      },
      /* "New Work task" used to sit here and open /work. There is no such
         destination and no such kind of thing to start any more: you delegate
         from the chat composer, in the conversation the run will live in
         (docs/design/TWO_PRODUCTS.md §2.2), so the palette's answer to "I want
         Juno to go and do this" is the same "New chat" row above. */
      /* Straight to `/code`, not to `/code/new`. The Code landing IS the
         composer now (docs/design/TWO_PRODUCTS.md §3) and `/code/new` is a
         redirect onto it, so routing through it would spend a round trip to
         arrive at the row's own destination. */
      { id: "new-code", group: "Actions", label: "New code session", icon: AppIcons.code, keywords: "code start workspace session mac task agent", run: () => go("/code") },
      /* To Artifacts, filtered to designs, with New already open on the
         presets: choosing a size there is what makes the design, so this row
         never creates one behind the reader's back from a keystroke. Starting
         from a preset used to mean opening the Design page first; this is
         that page's preset grid, one command away
         (docs/design/artifacts-design/04-MERGE-PLAN.md §4.6). */
      { id: "new-design", group: "Actions", label: "New design", icon: AppIcons.design, keywords: "mockup wireframe prototype", run: () => go("/artifacts?type=DESIGN&new=design") },
      /* "New scheduled task" is now "New automation" and lands on the editor
         rather than on a list: scheduled tasks are retired into Automations,
         and its old keywords ride along so the words people type for it still
         find something. */
      { id: "new-automation", group: "Actions", label: "New routine", icon: AppIcons.automations, keywords: "schedule scheduled task recurring automation routine cron reminder trigger", run: () => go("/automations/new") },
      { id: "new-assistant", group: "Actions", label: "New assistant", icon: AppIcons.assistants, keywords: "create custom assistant bot gem gpt instructions", run: () => go("/assistants") },
      { id: "new-agent", group: "Actions", label: FEATURE_NAMES.createAgent.label, icon: AppIcons.agents, keywords: "new hire agent orbit crew teammate bot muse grok delegate", run: () => go("/agents/new") },
      {
        id: "search-everything",
        group: "Actions",
        label: "Search everything",
        icon: AppIcons.search,
        keywords: "find messages files artifacts memory",
        run: () => {
          setOpen(false);
          window.dispatchEvent(new CustomEvent("juno:search"));
        },
      },
      /* The sidebar's own toggle mark — the panel glyph its collapse button
         draws — rather than the two columns Compare uses two rows down. */
      { id: "toggle-sidebar", group: "Actions", label: "Toggle sidebar", hint: `${mod}⇧S`, icon: PanelLeft, keywords: "collapse expand rail panel", run: () => { setOpen(false); window.dispatchEvent(new CustomEvent("juno:toggle-sidebar")); } },
      /* The sidebar's Notifications row, from the keyboard. It opens the same
         popover, so there is still one inbox; `afterClose` holds it until the
         palette has gone (see there). */
      {
        id: "notifications",
        group: "Actions",
        label: "Open notifications",
        icon: AppIcons.notifications,
        keywords: "inbox alerts unread activity bell updates",
        run: () => {
          afterClose.current = openNotifications;
          setOpen(false);
        },
      },
      { id: "assistants", group: "Actions", label: "Open Assistants", icon: AppIcons.assistants, keywords: "custom assistants bots gpt gems prompts", run: () => go("/assistants") },
      { id: "agents", group: "Actions", label: `Open ${BRAND.orbit.label}`, icon: AppIcons.orbit, keywords: "orbit agents your agents crew teammates roster delegate goals routines", run: () => go("/agents") },
      { id: "code-runs", group: "Actions", label: `Open ${BRAND.code.label}`, icon: AppIcons.code, keywords: "sessions runs agents executions tasks alevr juno code", run: () => go("/code") },
      { id: "code-pulls", group: "Actions", label: "Open pull requests", icon: AppIcons.pulls, keywords: "pr github review merge code", run: () => go("/code/pulls") },
      /* DESIGN IS A TYPE NOW, NOT A PLACE, and this row is the word people
         already type for it. It lands on Artifacts filtered to designs, which
         is where `/design` itself redirects, so the palette and an old
         bookmark agree about where designs live.

         EACH WORD FINDS ONE PLACE. "canvas" used to key both this row and
         Open Artifacts, so typing it offered two destinations for one
         thought, and the first of them, the default selection, was the one
         that is now a filter of the other (L34). The design words live here;
         Artifacts keeps the words for everything else it holds. Matching is
         at word starts, so no word here may begin another row's word either:
         "frame" on one row would still find "frames" on another. */
      { id: "design", group: "Actions", label: "Open Designs", icon: AppIcons.design, keywords: "canvas frames screens figma", run: () => go("/artifacts?type=DESIGN") },
      { id: "artifacts", group: "Actions", label: FEATURE_NAMES.artifacts.label, icon: AppIcons.artifacts, keywords: "documents generated made", run: () => go("/artifacts") },
      { id: "activity", group: "Actions", label: `Open ${FEATURE_NAMES.activity.label}`, icon: AppIcons.activity, keywords: "running needs you approvals tasks runs research code status ready blocked", run: () => go("/activity") },
      { id: "library", group: "Actions", label: `Open ${FEATURE_NAMES.library.label}`, icon: AppIcons.library, keywords: "saved prompts snippets", run: () => go("/library") },
      { id: "connections", group: "Actions", label: `Open ${FEATURE_NAMES.apps.label}`, icon: AppIcons.connections, keywords: "apps connections plugins integrations github mcp connectors", run: () => go("/connections") },
      /* The three rooms Work's tab row used to hold. They are destinations in
         their own right now, so they are reachable from the keyboard — which
         the tab row never made them, since you had to be standing inside Work
         to see it. Left out of the shell's own commit because the routes did
         not exist yet; they do. */
      { id: "skills", group: "Actions", label: `Open ${FEATURE_NAMES.skills.label}`, icon: AppIcons.skills, keywords: "instructions reusable slash capability library", run: () => go("/skills") },
      { id: "automations", group: "Actions", label: `Open ${FEATURE_NAMES.routines.label}`, icon: AppIcons.automations, keywords: "routines automations schedule scheduled tasks recurring trigger cron email calendar monitor", run: () => go("/automations") },
      { id: "permissions", group: "Actions", label: "Open Permissions", icon: AppIcons.permissions, keywords: "approvals allow ask macs hosts security", run: () => go("/permissions") },
      { id: "compare", group: "Actions", label: "Compare models", icon: Columns2, keywords: "side by side race versus models", run: () => go("/compare") },
      { id: "memory", group: "Actions", label: `Open ${FEATURE_NAMES.memory.label}`, icon: ComposerIcons.memory, keywords: "remember facts", run: () => go("/memory") },
      { id: "roadmap", group: "Actions", label: "Roadmap & feature requests", icon: MapIcon, keywords: "feedback vote ideas", run: () => go("/roadmap") },
    ].filter((c) => (q ? matches(c.label, c.keywords) : AT_REST.has(c.id)));

    /*
     * CODE SESSIONS ARE ROWS HERE NOW.
     *
     * They were excluded outright — `kind !== "code"` — on the reasoning that
     * Code had its own list page with its own search field. That page is being
     * retired (docs/design/TWO_PRODUCTS.md §3), and even while it stood, this
     * exclusion plus the sidebar's identical one meant an open Code session
     * could not be reached from the keyboard from anywhere else in the product.
     *
     * The meta line is the repository or workspace rather than a timestamp,
     * because that is the fact that tells two sessions apart — a person has
     * three "Fix the flaky test"s and one of them is in the repo they mean. A
     * status mark is deliberately NOT drawn here: this surface holds no run
     * data, and a palette that is open for two seconds must not start a poll to
     * colour a dot. The state is on the row in the sidebar, which is the
     * surface whose job is triage.
     */
    const live = conversations.filter((c) => !c.archivedAt);
    const byRecency = (a: ClientConversation, b: ClientConversation) =>
      new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
    const chatRows = live.filter((c) => c.kind !== "code");
    /*
     * AT REST, THE CHAT YOU ARE IN IS NOT A ROW. The first row is the one
     * Enter runs, and it was the open chat itself (the newest by recency), so
     * ⌘K then Enter went nowhere and the commonest thing this menu is opened
     * for, going back to the chat before, took an arrow press first. Leaving
     * it out makes the default row the previous chat: ⌘K, Enter is alt-tab.
     * A typed query still finds it, since a title typed out is a request for
     * that chat. Read from the address, not from `activeConversationId`,
     * which keeps the last chat after you leave it for another page.
     */
    const openChatId = pathname?.match(/^\/chat\/([^/]+)/)?.[1] ?? null;
    const chats: PaletteItem[] = (
      q
        ? chatRows.filter((c) => c.title.toLowerCase().includes(q)).slice(0, 6)
        : chatRows.filter((c) => c.id !== openChatId).sort(byRecency).slice(0, 5)
    ).map((c) => ({
      id: "recent-" + c.id,
      group: "Chats",
      label: c.title || "New chat",
      // The typed words, marked in the title, as the search palette marks
      // them: the two surfaces share a shell and now a highlight.
      labelMarks: q ? matchMarks(c.title || "New chat", typed) : undefined,
      meta: relativeTime(c.lastMessageAt),
      icon: AppIcons.conversation,
      run: () => go("/chat/" + c.id),
    }));

    const codeRows = live.filter((c) => c.kind === "code");
    const codeSessions: PaletteItem[] = (
      q ? codeRows.filter((c) => c.title.toLowerCase().includes(q)).slice(0, 6) : []
    ).map((c) => ({
      id: "code-session-" + c.id,
      group: "Code sessions",
      label: c.title || "Untitled session",
      labelMarks: matchMarks(c.title || "Untitled session", typed),
      meta: c.codeWorkspaceName || relativeTime(c.lastMessageAt),
      icon: AppIcons.code,
      run: () => go("/chat/" + c.id),
    }));

    const projectRows: PaletteItem[] = (
      q
        ? [...projects]
            .sort((a, b) => Number(b.starred) - Number(a.starred) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
            .filter((p) => p.name.toLowerCase().includes(q))
            .slice(0, 6)
        : []
    ).map((p) => ({
      id: "project-" + p.id,
      group: "Projects",
      label: p.name || "Untitled project",
      labelMarks: matchMarks(p.name || "Untitled project", typed),
      meta: p.starred ? "Pinned" : relativeTime(p.updatedAt),
      icon: AppIcons.projects,
      run: () => go("/projects/" + p.id),
    }));
    if (q && matches("All projects", "projects workspaces group")) {
      projectRows.push({ id: "projects", group: "Projects", label: "All projects", icon: AppIcons.projects, run: () => go("/projects") });
    }

    const allSettings: PaletteItem[] = [
      { id: "settings", group: "Settings", label: "Settings", icon: AppIcons.settings, keywords: "preferences account theme", run: () => go("/settings") },
      { id: "upgrade", group: "Settings", label: "Plans & upgrade", icon: SettingsIcons.billing, keywords: "billing pro max pricing", run: () => go("/upgrade") },
      {
        id: "theme",
        group: "Settings",
        label: `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`,
        hint: `${mod}⇧L`,
        icon: resolvedTheme === "dark" ? Sun : Moon,
        keywords: "theme dark light appearance",
        run: () => {
          toggleTheme();
          setOpen(false);
        },
      },
      {
        id: "shortcuts",
        group: "Settings",
        label: "Keyboard shortcuts",
        hint: `${mod}/`,
        icon: Keyboard,
        keywords: "keys help",
        run: () => {
          setOpen(false);
          setShortcutsOpen(true);
        },
      },
    ];
    const settings = q ? allSettings.filter((c) => matches(c.label, c.keywords)) : [];
    // At rest, Settings itself closes the short Actions list.
    if (!q) {
      const settingsRow = allSettings.find((c) => c.id === "settings");
      if (settingsRow) actions.push({ ...settingsRow, group: "Actions" });
    }

    const agentRows: PaletteItem[] = (
      q ? sidebarAgents.filter((a) => matches(a.name, `${a.role} agent teammate`)) : []
    ).map((a) => ({
      id: "agent-" + a.id,
      group: "Agents",
      label: a.name,
      labelMarks: matchMarks(a.name, typed, { wordStartOnly: true }),
      meta: a.role || a.stateSentence,
      icon: AppIcons.agents,
      run: () => go(a.conversationId ? `/chat/${a.conversationId}` : `/agents/${a.id}`),
    }));

    // The reader's own things first, then the doors. With a query, each group
    // is ordered by its own best match and the groups by theirs, ties keeping
    // this order (the sort is stable).
    const groups = [chats, codeSessions, projectRows, agentRows, actions, settings];
    if (!q) return groups.flat();
    const best = (rows: PaletteItem[]) => Math.max(0, ...rows.map((r) => score(r.label, r.keywords)));
    const ranked = groups
      .filter((rows) => rows.length > 0)
      .map((rows) => [...rows].sort((a, b) => score(b.label, b.keywords) - score(a.label, a.keywords)))
      .sort((a, b) => best(b) - best(a))
      .flat();
    // The way out of a query no title answers: the full-text surface, with the
    // words already in its field (SearchPalette seeds from `detail.query`).
    ranked.push({
      id: "search-messages",
      group: "Search",
      label: `Search messages and files for “${typed}”`,
      icon: AppIcons.search,
      run: () => {
        setOpen(false);
        window.dispatchEvent(new CustomEvent("juno:search", { detail: { query: typed } }));
      },
    });
    return ranked;
  }, [conversations, projects, sidebarAgents, q, typed, go, resolvedTheme, toggleTheme, mod, pathname]);


  /*
   * NOTHING MATCHED, SAID OUT LOUD. A query no chat or command answers still
   * leaves one row, the hand-off to full search, so the list was never empty
   * and its "No matches" state never drew: the reader got that one row at the
   * top of a 13rem box with 150px of blank under it, which looked half
   * loaded. The note says what happened and the row under it says what Enter
   * will do; together they fill the box. ONE sentence each: a second line
   * here ("Enter searches inside your messages and files") only restated the
   * row beneath it.
   */
  const nothingMatched = q !== "" && items.length === 1 && items[0].id === "search-messages";
  const lead = nothingMatched ? (
    <div className="flex flex-col items-center px-3 pb-5 pt-6 text-center motion-safe:animate-fade-in">
      <span className="mb-3 flex size-10 items-center justify-center rounded-card border border-foreground/[0.07] bg-secondary text-muted-foreground">
        <SearchX className="size-5" motion="none" aria-hidden="true" />
      </span>
      <p className="text-body text-foreground">No chats or commands match “{typed}”.</p>
    </div>
  ) : null;

  // The same anatomy as the search surface's empty state, so the two
  // palettes that share this shell also share what "nothing" looks like.
  const emptyState = (
    <PaletteEmpty
      icon={SearchX}
      title={<>No matches for “{query}”.</>}
      hint="Try a chat title, or a command like “settings”."
    />
  );

  return (
    <>
      <PaletteShell
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Command menu"
        // What it does today: it jumps. "Search or start a chat" promised a
        // chat from a typed sentence, and Enter on one did nothing; until
        // /chat takes a prefill, the field says what Enter will do.
        placeholder="Jump to a chat or command"
        query={query}
        onQueryChange={setQuery}
        items={items}
        emptyState={emptyState}
        lead={lead}
        status={nothingMatched ? `No chats or commands match. Enter searches inside your messages and files.` : undefined}
        // Each keystroke re-ranks the list, so the cursor goes back to the
        // best match rather than staying on whatever row now sits at its index.
        resetKey={q}
        onCloseAutoFocus={onCloseAutoFocus}
      />
      <ShortcutsSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}

/** Mounts both surfaces: ⌘K → command menu, magnifying glass → search. */
export function CommandPalette() {
  return (
    <>
      <CommandMenu />
      <SearchPalette />
    </>
  );
}

function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const mod = useModifierKeyLabel();
  const groups = React.useMemo(() => shortcutGroups(mod), [mod]);
  // BALANCED COLUMNS: Everywhere (6) and Products (2) beside Composer (8) and
  // Responses (3) left the right column three rows and a heading longer, an
  // empty block under Products. Everywhere and Responses (9) beside Composer
  // and Products (10) end within a row of each other.
  const columns = React.useMemo(() => {
    const [everywhere, products, composer, responses, ...rest] = groups;
    return [[everywhere, responses], [composer, products, ...rest]].map((c) => c.filter(Boolean));
  }, [groups]);
  const appleKeys = isAppleModifier(mod);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* max-w-lg and two columns from sm up: twenty rows in four groups do not
          fit one screen in a single 28rem column, and a shortcuts sheet you
          have to scroll is a sheet you close and guess instead.

          TWO EXPLICIT COLUMNS, not CSS `columns`. The balancer decided where
          each group landed, and the gap between groups was a bottom margin
          it was free to drop at a column end, so "Responses" sat flush under
          "Apps and tools" while "Products" had its 16px. Each column is now a
          stack with one gap between its groups, and a group never splits.

          40rem, not 32: at 512px a column was 216px, and off a Mac five
          labels wrapped beside a "Ctrl+Shift+C" cap ("Copy the last /
          response", "Focus the / composer"). Every row is one line now. */}
      <DialogContent className="max-w-[40rem]">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <div className="mt-1 grid gap-4 sm:grid-cols-2 sm:gap-x-8">
          {columns.map((column, ci) => (
            <div key={ci} className="space-y-4">
              {column.map((group) => (
                <section key={group.title}>
                  <p className="pb-1 font-mono text-label text-muted-foreground">{group.title}</p>
                  <ul className="divide-y divide-border/60">
                    {group.items.map((s) => (
                      <li key={s.label} className="flex items-center justify-between gap-4 py-2 text-ui">
                        <span className="text-foreground">{s.label}</span>
                        {/* Each key as its platform writes it (`keyCap`), never
                            a word beside a glyph: one cap per glyph on a Mac
                            (⌘ ⇧ O), and elsewhere ONE cap spelled the way
                            Windows and Linux write a chord, "Ctrl+Shift+O",
                            as the sidebar's hints do (`chordLabel`). Three
                            word caps side by side were twice as wide and
                            wrapped "Copy the last response" onto three lines. */}
                        <span className="flex shrink-0 items-center gap-1">
                          {appleKeys ? (
                            s.keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)
                          ) : (
                            <Kbd>{s.keys.map((k) => keyCap(k, mod)).join("+")}</Kbd>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
