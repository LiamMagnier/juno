"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A segmented control that follows the product's lighting model (globals.css
 * "Depth kit"): the track is a well (`field-well` / `--well-inset`) and the live
 * segment is a raised thumb wearing the same top sheen + `--shadow-pop` as a
 * `secondary` Button, so the selection reads as a key standing proud of its slot
 * rather than a tinted rectangle.
 *
 * One thumb glides between the segments — measured geometry (offsetLeft/Top),
 * no new dependency — so the switch says "these sit side by side and you moved
 * between them" instead of cross-fading two fills. It travels on whichever axis
 * the group is laid out on (horizontal by default; vertical for icon rails).
 *
 * Radiogroup semantics: selection follows focus, arrows move it (with wrap).
 * This is the shared idiom behind the sidebar's Home/Code toggle and the
 * /code/new Device/Cloud toggle.
 */

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Rendered before the label (or alone, when `labelHidden`). */
  icon?: React.ReactNode;
  /** Disables just this segment (still announced, not selectable). */
  disabled?: boolean;
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  orientation = "horizontal",
  labelHidden = false,
  className,
  optionClassName,
  ringOffsetClassName = "focus-visible:ring-offset-background",
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  ariaLabel: string;
  orientation?: "horizontal" | "vertical";
  /** Icon-only segments (the label rides `aria-label`/`title` instead). */
  labelHidden?: boolean;
  /** Extra classes on the track. */
  className?: string;
  /** Extra classes on each segment button (sizing/typography). */
  optionClassName?: string;
  /** The focus ring's offset color — match the surface the control sits on. */
  ringOffsetClassName?: string;
}) {
  const refs = React.useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const trackRef = React.useRef<HTMLDivElement>(null);
  const thumbRef = React.useRef<HTMLSpanElement>(null);
  // The thumb is placed from measured pixels, so it must snap (not glide) into
  // its first position and after a track resize — gliding there would animate
  // from a place the user never selected.
  const hasPlaced = React.useRef(false);

  const place = React.useCallback(
    (animate: boolean) => {
      const thumb = thumbRef.current;
      const el = refs.current[value];
      if (!thumb || !el) return;
      if (!animate) thumb.style.transition = "none";
      thumb.style.transform = `translate3d(${el.offsetLeft}px, ${el.offsetTop}px, 0)`;
      thumb.style.width = `${el.offsetWidth}px`;
      thumb.style.height = `${el.offsetHeight}px`;
      if (!animate) {
        void thumb.offsetHeight; // flush the jump before the class transition returns
        thumb.style.transition = "";
      }
    },
    [value],
  );

  React.useLayoutEffect(() => {
    place(hasPlaced.current);
    hasPlaced.current = true;
  }, [place, orientation, labelHidden]);

  // Fluid segments (resizable sidebar, responsive page) go stale without this.
  React.useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(track);
    return () => ro.disconnect();
  }, [place]);

  const move = (dir: 1 | -1) => {
    const enabled = options.filter((o) => !o.disabled);
    if (enabled.length === 0) return;
    const currentIdx = enabled.findIndex((o) => o.value === value);
    const from = currentIdx === -1 ? 0 : currentIdx;
    const next = enabled[(from + dir + enabled.length) % enabled.length];
    onChange(next.value);
    refs.current[next.value]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    move(e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1);
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        // The track is a shadow cast into its surface, so it darkens the parent
        // in both themes. It deliberately doesn't use --muted (identical to the
        // sidebar in light, lighter in dark — which would invert the lighting
        // model the thumb depends on). No border: the thumb is positioned from
        // offsetLeft/offsetTop, which agree with left-0/top-0 only while the
        // padding edge and border edge coincide.
        "field-well relative gap-0.5 rounded-[10px] bg-black/[0.055] p-0.5 dark:bg-black/25",
        orientation === "vertical" ? "flex flex-col items-center" : "grid",
        className,
      )}
      style={
        orientation === "horizontal"
          ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }
          : undefined
      }
    >
      <span
        ref={thumbRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-0 rounded-[8px] bg-card transition-[transform,width,height] duration-base ease-spring [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-pop)] motion-reduce:transition-none"
      />
      {options.map((opt) => (
        <button
          key={opt.value}
          ref={(el) => {
            refs.current[opt.value] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          aria-label={labelHidden ? opt.label : undefined}
          title={labelHidden ? opt.label : undefined}
          disabled={opt.disabled}
          // Roving tabindex: the group is one tab stop; arrows move within it.
          tabIndex={value === opt.value ? 0 : -1}
          onClick={() => !opt.disabled && onChange(opt.value)}
          onKeyDown={handleKeyDown}
          className={cn(
            // Press dips the label/icon (the fill under them is the thumb),
            // matching the Button component's active:scale language.
            "group relative z-10 flex items-center justify-center rounded-[8px] font-medium transition-[color,transform] duration-fast ease-out-soft active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100",
            ringOffsetClassName,
            labelHidden ? "h-8 w-8" : "gap-1.5 px-3 py-1 text-[13px]",
            value === opt.value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            optionClassName,
          )}
        >
          {opt.icon}
          {!labelHidden && opt.label}
        </button>
      ))}
    </div>
  );
}
