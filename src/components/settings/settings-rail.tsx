"use client";

import * as React from "react";
import Link from "next/link";
import { MotionConfig, motion, useReducedMotion } from "framer-motion";
import { Pressable } from "@/components/ui/pressable";
import {
  ALL_SETTINGS_SECTIONS,
  SETTINGS_GROUPS,
  SETTINGS_KEYWORDS,
  type SettingsSectionId,
  type SettingsSectionMeta,
} from "@/components/settings/settings-sections";
import { Search } from "@/components/ui/icons";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** The ids that tie a tab to its panel, shared with SettingsPane. */
export const settingsTabId = (id: SettingsSectionId) => `settings-tab-${id}`;
export const settingsPanelId = (id: SettingsSectionId) => `settings-panel-${id}`;

/** Width of the strip's edge fade, where there is more to scroll that way. */
const FADE_PX = 24;

/**
 * The settings rail: one row per section, text on the surface, with the open
 * one on the selected tone. The same rail serves the modal and the `/settings`
 * page, and the two are different patterns, marked as such:
 *
 *   - In the modal the rows switch a pane in place, so the rail is a
 *     `tablist` of `tab`s with `aria-selected`, one roving tab stop and arrow
 *     keys between them, and the pane is the matching `tabpanel`.
 *   - On the page the rows are links carrying `?section=`, so a section can be
 *     bookmarked; the rail is a <nav> and the open row is
 *     `aria-current="page"`. They replace the history entry rather than
 *     pushing one, so Back leaves settings instead of replaying every section
 *     the reader glanced at.
 *
 * No well around it. It used to sit in an inset box, a second frame inside
 * the modal's own; the rows now sit on the surface like the sidebar's do, and
 * the selected tone is the only fill.
 *
 * A strip or a column, decided by the width the rail is GIVEN (its
 * `@container/rail` parent) rather than the window: it has two parents that
 * go side by side at different widths. With 16rem or more to itself it is the
 * stacked layout's horizontal strip; narrower, it is the side column. The
 * strip scrolls the open section into view and fades its edges only where
 * there is more to scroll, so a deep link to "Plan & usage" on a phone does
 * not open on a strip that hides where you are.
 *
 * THE SELECTION TRAVELS. It is one shared `layoutId` element rather than a
 * background per row, so choosing a section slides the fill from the old row
 * to the new one on the standard spring. Under reduced motion framer turns
 * the slide into a swap (`MotionConfig reducedMotion="user"`).
 *
 * Glyph ink follows ICONS_AND_MOTION.md §1.2: muted at rest, the row's
 * foreground on hover or when selected. The accent is not used: a selected
 * rail row is a place you are, not an action.
 */
export function SettingsRail({
  active,
  onSelect,
  hrefFor,
  className,
}: {
  active: SettingsSectionId;
  onSelect?: (id: SettingsSectionId) => void;
  /** When given, rows render as links to this href. */
  hrefFor?: (id: SettingsSectionId) => string;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const listRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState("");

  // "/" puts the cursor in the search field, as it does in most full-window
  // settings, unless the reader is already typing somewhere.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input,textarea,select,[contenteditable=true],[role=menu],[role=listbox]")) return;
      const field = searchRef.current;
      // Not while the field is hidden (the stacked strip has no search).
      if (!field || field.offsetParent === null) return;
      // Inside a dialog, only the dialog the rail itself lives in (the modal).
      const dialog = target?.closest("[role=dialog]");
      if (dialog && !dialog.contains(field)) return;
      e.preventDefault();
      field.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const q = query.trim().toLowerCase();
  /** The rail in group order, filtered by the search field (label or keywords). */
  const groups = React.useMemo(
    () =>
      SETTINGS_GROUPS.map((group) => ({
        label: group.label,
        sections: group.ids
          .map((id) => ALL_SETTINGS_SECTIONS.find((s) => s.id === id))
          .filter((s): s is SettingsSectionMeta => !!s)
          .filter((s) => !q || s.label.toLowerCase().includes(q) || SETTINGS_KEYWORDS[s.id].includes(q)),
      })).filter((group) => group.sections.length > 0),
    [q]
  );
  const ordered = React.useMemo(() => groups.flatMap((g) => g.sections), [groups]);
  const [strip, setStrip] = React.useState(false);
  const [edges, setEdges] = React.useState({ start: false, end: false });

  const measure = React.useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const overflowing = el.scrollWidth > el.clientWidth + 1;
    setStrip((prev) => (prev === overflowing ? prev : overflowing));
    const start = overflowing && el.scrollLeft > 1;
    const end = overflowing && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  React.useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Bring the open section into the strip's view. Horizontal only, by hand:
  // `scrollIntoView` would also scroll the page or the modal vertically.
  const firstScroll = React.useRef(true);
  React.useEffect(() => {
    const el = listRef.current;
    const row = el?.querySelector<HTMLElement>('[data-active="true"]');
    if (!el || !row || el.scrollWidth <= el.clientWidth + 1) return;
    // Measured from the two boxes rather than `offsetLeft`, whose parent is
    // whichever ancestor happens to be positioned, not the strip.
    const rowBox = row.getBoundingClientRect();
    const stripBox = el.getBoundingClientRect();
    const left = el.scrollLeft + (rowBox.left - stripBox.left) - (el.clientWidth - rowBox.width) / 2;
    el.scrollTo({ left: Math.max(0, left), behavior: firstScroll.current || reduce ? "auto" : "smooth" });
    firstScroll.current = false;
  }, [active, reduce]);

  // The strip scrolls, and a scroller clips at its padding box, so it carries
  // 4px of padding (cancelled by a matching negative margin) for the focus
  // outline to draw into instead of being cut off above and below the chip.
  const listClass = cn(
    "flex flex-col gap-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
    "@[16rem]/rail:-m-1 @[16rem]/rail:flex-row @[16rem]/rail:gap-1 @[16rem]/rail:overflow-x-auto @[16rem]/rail:p-1",
    className
  );
  const listStyle: React.CSSProperties | undefined = strip
    ? {
        maskImage: `linear-gradient(to right, transparent, #000 ${edges.start ? FADE_PX : 0}px, #000 calc(100% - ${edges.end ? FADE_PX : 0}px), transparent)`,
      }
    : undefined;
  // `group` for the glyph ink. The selected row's own fill is cleared: the
  // travelling indicator paints it, and Pressable's selected fill under it
  // would show the new tone a frame before the indicator arrives.
  const rowClass = "group w-full shrink-0 whitespace-nowrap @[16rem]/rail:w-auto";
  const selectedRowClass = "bg-transparent hover:bg-transparent";
  // One indicator per rail instance: the modal and the page never mount
  // together, but a shared id would let them trade the fill if they did.
  const indicatorId = `settings-rail-active-${React.useId()}`;
  // Arrow keys move between tabs and select in the same gesture: the ARIA
  // tabs pattern with automatic activation.
  const tabOption = useRadioGroup(
    ordered,
    ordered.findIndex((s) => s.id === active),
    (section) => onSelect?.(section.id)
  );

  const content = (section: SettingsSectionMeta, selected: boolean) => (
    <>
      {selected && (
        <motion.span
          layoutId={indicatorId}
          aria-hidden="true"
          transition={spring.standard}
          // The radius rides `style` (rounded-control's 8px) so framer keeps
          // the corners true while it scales the fill between two chips of
          // different widths. `-inset-px` covers the row's border box.
          className="pointer-events-none absolute -inset-px bg-selected"
          style={{ borderRadius: 8 }}
        />
      )}
      {/* The ink cross-fades on a wrapper, not on the glyph: a `transition-*`
          utility on the svg would replace the base-layer transition its hover
          articulation runs on. */}
      <span
        className={cn(
          "relative flex shrink-0 transition-colors duration-fast ease-out-soft",
          selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
        )}
      >
        <section.icon className="size-4" aria-hidden="true" />
      </span>
      <span className={cn("relative truncate", selected && "text-foreground")}>{section.label}</span>
    </>
  );

  /** The search field and group heads exist only as a column; as a strip the
   *  rail is one flat scroller, where a heading would be a stray word. */
  const searchField = (
    <div className="group/search relative mb-4 @[16rem]/rail:hidden">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors duration-fast ease-out-soft group-focus-within/search:text-foreground"
      />
      <input
        ref={searchRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Esc clears a query first, then lets go of the field; it never
          // reaches the page's own Esc (which leaves settings) from here.
          if (e.key !== "Escape") return;
          e.preventDefault();
          if (query) setQuery("");
          else e.currentTarget.blur();
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        className="peer h-9 w-full rounded-control border border-transparent bg-foreground/[0.045] pl-8 pr-8 text-ui text-foreground outline-none transition-[background-color,border-color,box-shadow] duration-fast ease-out-soft placeholder:text-muted-foreground hover:bg-foreground/[0.07] focus:border-border focus:bg-background focus:shadow-[0_1px_2px_hsl(var(--foreground)/0.06)] coarse:h-11 [&::-webkit-search-cancel-button]:hidden"
      />
      {/* The key that opens the field, shown only while it is empty and idle. */}
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 grid h-5 min-w-5 -translate-y-1/2 place-items-center rounded-xs border border-border/80 px-1 font-mono text-micro leading-none text-muted-foreground transition-opacity duration-fast ease-out-soft peer-focus:opacity-0 peer-[:not(:placeholder-shown)]:opacity-0 coarse:hidden"
      >
        /
      </kbd>
    </div>
  );
  const groupLabel = (label: string) => (
    <p className="ed-annot px-2.5 pb-1.5 pt-5 first:pt-0 @[16rem]/rail:hidden" aria-hidden="true">
      {label}
    </p>
  );
  const noMatch = groups.length === 0 ? (
    <p className="px-2.5 py-2 text-ui text-muted-foreground">No setting matches “{query.trim()}”.</p>
  ) : null;

  if (hrefFor) {
    return (
      <MotionConfig reducedMotion="user">
        <nav aria-label="Settings sections">
          {searchField}
          <div ref={listRef} onScroll={measure} className={listClass} style={listStyle}>
            {groups.map((group) => (
              <React.Fragment key={group.label}>
                {groupLabel(group.label)}
                {group.sections.map((section) => {
                  const selected = section.id === active;
                  return (
                    <Pressable
                      key={section.id}
                      asChild
                      kind="row"
                      selected={selected}
                      className={cn(rowClass, selected && selectedRowClass)}
                    >
                      <Link
                        href={hrefFor(section.id)}
                        replace
                        scroll={false}
                        data-active={selected}
                        aria-current={selected ? "page" : undefined}
                      >
                        {content(section, selected)}
                      </Link>
                    </Pressable>
                  );
                })}
              </React.Fragment>
            ))}
            {noMatch}
          </div>
        </nav>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      {searchField}
      <div
        ref={listRef}
        onScroll={measure}
        role="tablist"
        aria-label="Settings sections"
        aria-orientation={strip ? "horizontal" : "vertical"}
        className={listClass}
        style={listStyle}
      >
        {groups.map((group) => (
          <React.Fragment key={group.label}>
            {groupLabel(group.label)}
            {group.sections.map((section) => {
              const i = ordered.indexOf(section);
              const selected = section.id === active;
              return (
                <Pressable
                  key={section.id}
                  type="button"
                  kind="row"
                  role="tab"
                  id={settingsTabId(section.id)}
                  aria-selected={selected}
                  aria-controls={settingsPanelId(section.id)}
                  data-active={selected}
                  selected={selected}
                  onClick={() => onSelect?.(section.id)}
                  className={cn(rowClass, selected && selectedRowClass)}
                  {...tabOption(i)}
                >
                  {content(section, selected)}
                </Pressable>
              );
            })}
          </React.Fragment>
        ))}
        {noMatch}
      </div>
    </MotionConfig>
  );
}
