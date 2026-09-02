"use client";

import * as React from "react";
import Link from "next/link";
import { Pressable } from "@/components/ui/pressable";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/components/settings/settings-sections";
import { cn } from "@/lib/utils";

/**
 * The settings rail: an inset well holding one icon row per section, the
 * active one raised. The same rail serves the modal (rows are buttons that
 * switch the pane) and the `/settings` page (rows are links carrying
 * `?section=` so a section can be bookmarked and shared).
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
  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        "surface-inset flex gap-1 overflow-x-auto rounded-card p-1.5 [scrollbar-width:none] md:flex-col md:overflow-visible [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {SETTINGS_SECTIONS.map((section) => {
        const selected = section.id === active;
        const content = (
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
            <Pressable
              key={section.id}
              asChild
              kind="row"
              selected={selected}
              className="w-auto shrink-0 whitespace-nowrap md:w-full"
            >
              <Link href={hrefFor(section.id)} aria-current={selected ? "page" : undefined} scroll={false}>
                {content}
              </Link>
            </Pressable>
          );
        }
        return (
          <Pressable
            key={section.id}
            type="button"
            kind="row"
            selected={selected}
            aria-current={selected ? "page" : undefined}
            onClick={() => onSelect?.(section.id)}
            className="w-auto shrink-0 whitespace-nowrap md:w-full"
          >
            {content}
          </Pressable>
        );
      })}
    </nav>
  );
}
