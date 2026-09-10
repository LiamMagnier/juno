"use client";

import * as React from "react";
import Link from "next/link";
import { Pressable } from "@/components/ui/pressable";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/components/settings/settings-sections";
import { useRadioGroup } from "@/components/settings/use-radio-group";
import { cn } from "@/lib/utils";

/** The ids that tie a tab to its panel — shared with SettingsPane. */
export const settingsTabId = (id: SettingsSectionId) => `settings-tab-${id}`;
export const settingsPanelId = (id: SettingsSectionId) => `settings-panel-${id}`;

/**
 * The settings rail: an inset well holding one icon row per section, the
 * active one raised. The same rail serves the modal and the `/settings` page,
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
  const railClass = cn(
    "surface-inset flex gap-1 overflow-x-auto rounded-card p-1.5 [scrollbar-width:none] md:flex-col md:overflow-visible [&::-webkit-scrollbar]:hidden",
    className
  );
  const rowClass = "w-auto shrink-0 whitespace-nowrap md:w-full";
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
      <section.icon
        className={cn("size-4 shrink-0", selected ? "text-primary-ink" : "text-muted-foreground")}
        aria-hidden="true"
      />
      <span className="truncate">{section.label}</span>
    </>
  );

  if (hrefFor) {
    return (
      <nav aria-label="Settings sections" className={railClass}>
        {SETTINGS_SECTIONS.map((section) => {
          const selected = section.id === active;
          return (
            <Pressable key={section.id} asChild kind="row" selected={selected} className={rowClass}>
              <Link href={hrefFor(section.id)} aria-current={selected ? "page" : undefined} scroll={false}>
                {content(section, selected)}
              </Link>
            </Pressable>
          );
        })}
      </nav>
    );
  }

  return (
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
            className={rowClass}
            {...tabOption(i)}
          >
            {content(section, selected)}
          </Pressable>
        );
      })}
    </div>
  );
}
