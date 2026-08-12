"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The settings index.
 *
 * Settings was thirteen `<Tile>`s stacked in one `max-w-3xl` column, separated
 * by nothing but a bottom hairline each. That is a legible way to render two or
 * three sections and an unusable way to render thirteen: there is no way to see
 * what the page contains without scrolling all of it, no way to get back to a
 * section you just left, and — because every tile is the same weight — no
 * reading order beyond "top to bottom". "Danger zone" and "Response language"
 * arrive at identical volume.
 *
 * So the page grows an index, and the tiles group under it. The rail is the
 * table of contents; the groups are the chapters.
 *
 * WHY SCROLL-SPY AND NOT ROUTED TABS
 *
 * Tabs would hide twelve sections to show one, and settings is a surface people
 * scan as much as they navigate — you come here to change one thing but you
 * often do not know which section owns it. Keeping everything in one scroll and
 * marking your position preserves scanning, adds navigation, and costs no
 * routing. It also means Cmd-F still finds everything, which a tabbed settings
 * page always breaks.
 */
export type SettingsSection = { id: string; label: string };

export function SettingsSectionNav({
  sections,
  className,
}: {
  sections: SettingsSection[];
  className?: string;
}) {
  const [active, setActive] = React.useState(sections[0]?.id ?? "");

  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    const targets = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el != null);
    if (targets.length === 0) return;

    /*
     * The page scrolls inside `.app-page-scroll`, not the viewport, so the
     * observer has to be rooted there. Rooted at the viewport (the default) it
     * measures against a box that never moves and every section reads as
     * permanently intersecting — the rail would light one item and stay there.
     * `null` is still the correct fallback: inside the settings MODAL there is
     * no such ancestor and the dialog body scrolls the viewport.
     */
    const root = targets[0].closest(".app-page-scroll");

    /*
     * Top-biased: a band across the upper third rather than the whole box. The
     * active section is the one you are READING, which is the one under the top
     * of the window — not the one occupying the most pixels. Without the bottom
     * inset a tall section stays "active" long after its heading has left, and
     * the last short section can never win at all because it cannot fill enough
     * of the box to beat the one above it.
     */
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { root, rootMargin: "0px 0px -68% 0px", threshold: 0 }
    );

    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav aria-label="Settings sections" className={cn("flex flex-col gap-0.5", className)}>
      {sections.map((s) => {
        const isActive = s.id === active;
        return (
          <a
            key={s.id}
            href={`#${s.id}`}
            /*
             * `aria-current`, not just a colour. The rail's whole job is to say
             * where you are, and to a screen reader a brighter foreground is
             * not a statement.
             */
            aria-current={isActive ? "location" : undefined}
            className={cn(
              // No focus fork. The chain here was
              // `focus-visible:outline-none` + a ring + `ring-offset-background`,
              // which suppresses the authoritative global :focus-visible rule
              // (globals.css) and repaints the 2px gap in a SOLID page colour —
              // the exact pattern button.tsx documents as how four hand-forked
              // offset colours accumulated. The global outline uses
              // outline-offset, so the real surface shows through and the rail
              // focuses in the same language as everything around it.
              "group relative rounded-control px-3 py-1.5 text-sm transition-colors duration-fast ease-out-soft",
              isActive
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {/*
             * The marker is a separate absolutely-positioned bar rather than a
             * `border-l` on the link, because a border participates in layout:
             * toggling it shifts the label 2px sideways every time the active
             * section changes, so the whole rail twitches as you scroll. This
             * scales from the centre on the transform-only path and costs no
             * reflow.
             */}
            <span
              aria-hidden
              className={cn(
                "absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-primary transition-transform duration-base ease-out-soft motion-reduce:transition-none",
                isActive ? "scale-y-100" : "scale-y-0"
              )}
            />
            {s.label}
          </a>
        );
      })}
    </nav>
  );
}

/**
 * A titled group of tiles. The heading is what makes the rail's labels mean
 * something when you land on them — an anchor that jumps to an unlabelled band
 * of controls tells you nothing about whether you arrived.
 *
 * `scroll-mt` is load-bearing: the scroll container has a sticky header above
 * it, so an anchor jump without the offset parks the heading underneath it.
 */
export function SettingsGroup({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 pt-2 first:pt-0">
      <div className="mb-1 pt-6 first:pt-0">
        <h2 id={`${id}-title`} className="font-serif text-heading text-foreground">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-0">{children}</div>
    </section>
  );
}
