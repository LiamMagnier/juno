"use client";

import * as React from "react";
import Link from "next/link";
import { MotionConfig, motion } from "framer-motion";
import { Pressable } from "@/components/ui/pressable";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/components/settings/settings-sections";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** The ids that tie a tab to its panel — shared with SettingsPane. */
export const settingsTabId = (id: SettingsSectionId) => `settings-tab-${id}`;
export const settingsPanelId = (id: SettingsSectionId) => `settings-panel-${id}`;

/**
 * The settings rail: an inset well holding one icon row per section, the
 * active one on a tonal fill. The same rail serves the modal and the `/settings` page,
 * but the two are different patterns and are marked as such:
 *
 *   - In the modal the rows switch a pane in place, so the rail is a
 *     `tablist` of `tab`s with `aria-selected`, one roving tab stop and arrow
 *     keys between them, and the pane is the matching `tabpanel`. It used to
 *     be a <nav> of buttons wearing `aria-current="page"` beside a tabpanel —
 *     half of one pattern glued to half of another.
 *   - On the page the rows are links carrying `?section=` so a section can be
 *     bookmarked, so the rail stays a <nav> and the open row is
 *     `aria-current="page"`, which is what a link that is the page you are on
 *     should say.
 *
 * On narrow widths it turns into a horizontally scrolling chip strip: the
 * rows keep their icons and labels, so a phone still sees the whole table of
 * contents rather than a hamburger hiding it.
 *
 * THE ACTIVE FILL TRAVELS. It is one shared `layoutId` element rather than a
 * background on each row, so choosing a section slides the tonal fill from the
 * old row to the new one on the standard spring — the switch reads as the
 * rail moving its marker, not as two rows repainting in the same frame. It
 * sits under the row's content (`relative` on the glyph and the label) and is
 * inert to the pointer. `MotionConfig reducedMotion="user"` turns the slide
 * into a plain swap under the preference, as framer does for every layout
 * animation it is told about.
 *
 * Glyph ink follows ICONS_AND_MOTION.md §1.2: muted at rest, the row's
 * foreground on hover or when selected. The accent is not used here — a
 * selected rail row is a place you are, not an action.
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
  // A strip or a column, decided by the width the rail is GIVEN — its
  // `@container/rail` parent (settings/page.tsx, settings-modal.tsx) — not by
  // the window. It has two parents that go side by side at different widths:
  // the page at 48rem of content column, the modal at a 768px window. Keyed to
  // `md:`, the page's stacked layout (a 1024 window with the sidebar out) drew
  // a vertical column of eight rows above the pane. The one rule that holds in
  // both parents: a rail with 16rem or more to itself is the stacked layout's
  // strip; narrower than that it is the side column (13.5rem on the page,
  // 14rem less padding in the modal).
  const railClass = cn(
    "surface-inset flex flex-col gap-1 rounded-card p-1.5 [scrollbar-width:none] @[16rem]/rail:flex-row @[16rem]/rail:overflow-x-auto [&::-webkit-scrollbar]:hidden",
    className
  );
  // `group` for the glyph ink. The selected row's own fill is cleared: the
  // travelling indicator below paints it, and Pressable's selected `bg-accent`
  // under it would show the new fill a frame before the indicator arrives.
  const rowClass = "group w-full shrink-0 whitespace-nowrap @[16rem]/rail:w-auto";
  const selectedRowClass = "bg-transparent hover:bg-transparent";
  // One indicator per rail instance: the modal and the page never mount
  // together, but a shared id would let them trade the fill if they did.
  const indicatorId = `settings-rail-active-${React.useId()}`;
  // Arrow keys move between tabs and select in the same gesture — the ARIA
  // tabs pattern with automatic activation, which is also what the radio
  // hook implements, so it is reused rather than rewritten.
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
          // The radius rides `style` (rounded-control's 10px), as the tabs
          // thumb's does, so framer keeps the corners true while it scales the
          // fill between two chips of different widths in the strip layout.
          // `-inset-px` covers the row's border box, so the fill's 10px corner
          // is struck from the same centre as the row's own.
          className="pointer-events-none absolute -inset-px bg-accent"
          style={{ borderRadius: 10 }}
        />
      )}
      {/* The ink cross-fades on a wrapper, not on the glyph: a `transition-*`
          utility on the svg would replace the base-layer transition its hover
          articulation runs on (Memory's pen and Voice's microphone tilt), and
          the gesture would snap instead of settling. */}
      <span
        className={cn(
          "relative flex shrink-0 transition-colors duration-fast ease-out-soft",
          selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
        )}
      >
        <section.icon className="size-4" aria-hidden="true" />
      </span>
      <span className="relative truncate">{section.label}</span>
    </>
  );

  if (hrefFor) {
    return (
      <MotionConfig reducedMotion="user">
        <nav aria-label="Settings sections" className={railClass}>
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
                <Link href={hrefFor(section.id)} aria-current={selected ? "page" : undefined} scroll={false}>
                  {content(section, selected)}
                </Link>
              </Pressable>
            );
          })}
        </nav>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <div role="tablist" aria-label="Settings sections" aria-orientation="vertical" className={railClass}>
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
