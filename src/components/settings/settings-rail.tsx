"use client";

import * as React from "react";
import Link from "next/link";
import { MotionConfig, motion, useReducedMotion } from "framer-motion";
import { Pressable } from "@/components/ui/pressable";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/components/settings/settings-sections";
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
    const left = row.offsetLeft - (el.clientWidth - row.offsetWidth) / 2;
    el.scrollTo({ left: Math.max(0, left), behavior: firstScroll.current || reduce ? "auto" : "smooth" });
    firstScroll.current = false;
  }, [active, reduce]);

  const listClass = cn(
    "flex flex-col gap-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
    "@[16rem]/rail:flex-row @[16rem]/rail:gap-1 @[16rem]/rail:overflow-x-auto",
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
    SETTINGS_SECTIONS,
    SETTINGS_SECTIONS.findIndex((s) => s.id === active),
    (section) => onSelect?.(section.id)
  );

  const content = (section: (typeof SETTINGS_SECTIONS)[number], selected: boolean) => (
    <>
      {selected && (
        <motion.span
          layoutId={indicatorId}
          aria-hidden="true"
          transition={spring.standard}
          // The radius rides `style` (rounded-control's 10px) so framer keeps
          // the corners true while it scales the fill between two chips of
          // different widths. `-inset-px` covers the row's border box.
          className="pointer-events-none absolute -inset-px bg-selected"
          style={{ borderRadius: 10 }}
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

  if (hrefFor) {
    return (
      <MotionConfig reducedMotion="user">
        <nav aria-label="Settings sections">
          <div ref={listRef} onScroll={measure} className={listClass} style={listStyle}>
            {SETTINGS_SECTIONS.map((section) => {
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
          </div>
        </nav>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={listRef}
        onScroll={measure}
        role="tablist"
        aria-label="Settings sections"
        aria-orientation={strip ? "horizontal" : "vertical"}
        className={listClass}
        style={listStyle}
      >
        {SETTINGS_SECTIONS.map((section, i) => {
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
      </div>
    </MotionConfig>
  );
}
