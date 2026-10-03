"use client";

import * as React from "react";
import { Search } from "@/components/ui/icons";
import type { IconComponent } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/*
 * THE COMPOSER'S MENUS: the + menu, its flyouts, and the tray's menus, cut
 * from one recipe (composer.css, `.cmenu`).
 *
 *   shell   18px corners, 6px inset, a hairline and a soft two-step shadow
 *   rows    36px, 12px corners (18 − 6: concentric with the shell), 14px type
 *   focus   one highlight that glides from row to row (MenuGlide) instead of
 *           a fill that blinks off one row and on at the next
 *   motion  the shell grows from its trigger (scale .96, 6px of travel toward
 *           the trigger's side, expo-out 240ms), its contents settle in 40ms
 *           behind it; it leaves faster than it came (130ms, no travel)
 *
 * Reduced motion keeps the fades and drops every scale, travel and glide.
 */

/** The shell class. Pair with a width; the rest is composer.css. */
export const composerMenuClass = "cmenu";

/**
 * The highlight that follows the active row. One element per menu, under the
 * rows, moved with a transform: Radix stamps `data-highlighted` on whichever
 * row the pointer or the arrow keys are on, and this reads it.
 */
export function MenuGlide() {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const pill = ref.current;
    const menu = pill?.parentElement;
    if (!pill || !menu) return;
    let shown = false;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const row = menu.querySelector<HTMLElement>("[role^='menuitem'][data-highlighted]");
        if (!row) {
          pill.dataset.on = "false";
          shown = false;
          return;
        }
        const box = menu.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        const x = rect.left - box.left - menu.clientLeft + menu.scrollLeft;
        const y = rect.top - box.top - menu.clientTop + menu.scrollTop;
        if (!shown) {
          // Arriving: appear where the row is, without travelling from the last one.
          pill.style.transition = "none";
        }
        pill.style.width = `${rect.width}px`;
        pill.style.height = `${rect.height}px`;
        pill.style.transform = `translate(${x}px, ${y}px)`;
        pill.dataset.destructive = row.classList.contains("text-destructive") ? "true" : "false";
        if (!shown) {
          void pill.offsetWidth;
          pill.style.transition = "";
        }
        pill.dataset.on = "true";
        shown = true;
      });
    };
    const observer = new MutationObserver(place);
    observer.observe(menu, { subtree: true, attributes: true, attributeFilter: ["data-highlighted"], childList: true });
    menu.addEventListener("scroll", place, true);
    place();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      menu.removeEventListener("scroll", place, true);
    };
  }, []);
  return <span ref={ref} aria-hidden="true" className="cmenu-glide" data-on="false" />;
}

/**
 * Says whether the list it sits in has more above or below the fold, as
 * `data-more-above` / `data-more-below` on that scroller. `.cmenu-scroll`
 * reads them to fade the edge rows out, so a menu capped to a short window
 * reads as a list that scrolls, not one cut off by whatever it sits against.
 */
export function MenuScrollEdges() {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const list = ref.current?.parentElement;
    if (!list) return;
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const above = list.scrollTop > 1;
        const below = list.scrollHeight - list.clientHeight - list.scrollTop > 1;
        list.toggleAttribute("data-more-above", above);
        list.toggleAttribute("data-more-below", below);
      });
    };
    read();
    list.addEventListener("scroll", read, { passive: true });
    const resize = new ResizeObserver(read);
    resize.observe(list);
    const changes = new MutationObserver(read);
    changes.observe(list, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      list.removeEventListener("scroll", read);
      resize.disconnect();
      changes.disconnect();
    };
  }, []);
  return <span ref={ref} hidden aria-hidden="true" />;
}

/** A small heading over a group of rows. */
export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="cmenu-label">{children}</div>;
}

/**
 * The filter at the head of a long list: a row-height field with no box of
 * its own, a hairline under it. Keys other than the ones that leave the field
 * stay in it, so the menu's typeahead never fights it for letters.
 */
export function MenuSearch({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <label className="cmenu-search">
      <Search aria-hidden="true" className="size-4" motion="none" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!["Escape", "ArrowDown", "ArrowUp", "Tab"].includes(event.key)) event.stopPropagation();
        }}
        placeholder={placeholder}
        aria-label={label}
        autoFocus
      />
    </label>
  );
}

/** What an empty list says: a quiet mark, a line, and what would fill it. */
export function MenuEmpty({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: IconComponent;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="cmenu-empty">
      <span className="cmenu-empty__mark">
        <Icon aria-hidden="true" className="size-4" motion="none" />
      </span>
      <span className="min-w-0">
        <span className="cmenu-empty__title">{title}</span>
        {hint ? <span className="cmenu-empty__hint">{hint}</span> : null}
        {action}
      </span>
    </div>
  );
}

/** Placeholder rows while a list loads, in the rows' own shape. */
export function MenuSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="cmenu-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={cn("cmenu-skeleton__row")} style={{ "--w": `${62 - i * 14}%` } as React.CSSProperties}>
          <span className="skeleton" />
          <span className="skeleton" />
        </span>
      ))}
    </div>
  );
}
