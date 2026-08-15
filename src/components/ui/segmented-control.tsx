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

/**
 * The squash below is a transform the CSS `prefers-reduced-motion` block cannot
 * reach, because it is written from JavaScript. Asked here instead, so the
 * setting is honoured by the same rule as everything else rather than by the
 * absence of one.
 */
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

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
}) {
  const refs = React.useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const trackRef = React.useRef<HTMLDivElement>(null);
  const thumbRef = React.useRef<HTMLSpanElement>(null);
  /**
   * Whether the ACTIVE segment is currently held down.
   *
   * The control claimed to be a physical thing — a key standing proud of a
   * recess — and then, on the one gesture that tests the claim, only the label
   * moved: `active:scale-[0.97]` dipped the text and icon while the raised
   * surface under them stayed exactly where it was. Pressing a real key pushes
   * the KEY down. So the thumb dips with its contents and its shadow collapses
   * toward the well, because a surface travelling toward the ground it sits on
   * casts less shadow, not the same shadow lower down.
   *
   * Only for the active segment. Pressing an inactive one is a request to move
   * the thumb, not to push it — dipping the thumb there would animate the wrong
   * object, and it would do it in the wrong place.
   */
  const [pressed, setPressed] = React.useState(false);

  /**
   * Release is watched on the WINDOW, not on the segment.
   *
   * The obvious version — onPointerUp/onPointerLeave on the button — leaves the
   * thumb stuck down, and it is not a rare path: press a segment, slide off it,
   * release. The pointerup then lands on whatever is under the cursor, the
   * button never hears it, and the control sits permanently dipped until it is
   * pressed again. (Verified in the browser: after a press that ended off the
   * element, `data-pressed` was still set.) `pointerleave` is no help either,
   * because React derives it from pointerout, so a release outside the document
   * or during a drag can miss both.
   *
   * A window listener answers all of those with one rule: the press ends when
   * the POINTER comes up, wherever it happens to be. `blur` covers the tab
   * losing focus mid-press, which fires no pointer event at all.
   */
  React.useEffect(() => {
    if (!pressed) return;
    const release = () => setPressed(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [pressed]);
  // The thumb is placed from measured pixels, so it must snap (not glide) into
  // its first position and after a track resize — gliding there would animate
  // from a place the user never selected.
  const hasPlaced = React.useRef(false);

  /** Where the thumb was last placed, so travel distance is knowable. */
  const lastPos = React.useRef<{ x: number; y: number } | null>(null);
  /** The one-frame stretch applied while the thumb is in flight. */
  const [travel, setTravel] = React.useState<{ sx: number; sy: number } | null>(null);

  /**
   * How far the thumb stretches along its direction of travel, as a fraction of
   * the distance it covers.
   *
   * This is the part that makes the switch read as a physical object rather
   * than a rectangle being repositioned. A shape that moves and stays perfectly
   * rigid reads as a slide transition; a shape that leans into its travel and
   * relaxes on arrival reads as something with mass. Apple's segmented control
   * does a version of this, which is why its switch feels like a switch.
   *
   * The cross-axis contracts by the reciprocal, so the thumb conserves its
   * apparent area and the stretch reads as deformation rather than as growth.
   *
   * Capped hard at 8%. Beyond roughly that it stops being physics and starts
   * being an effect — and this control sits in a 240px sidebar, where the whole
   * travel is ~90px and an over-eager stretch just looks like a rubber band.
   *
   * Both constants had been zeroed, which made `along` always 0, `grow`/`shrink`
   * always 1 and `setTravel` a no-op that wrote `scale: "1 1"` — so the effect
   * these ~70 lines of comment exist to justify never ran once. Restored to the
   * spec above: 0.0011/px reaches the 8% cap at ~73px of travel, which is inside
   * the ~90px the sidebar toggle covers, so a full-width switch saturates and a
   * neighbour-to-neighbour one does not.
   */
  const STRETCH_PER_PX = 0.0011;
  const MAX_STRETCH = 0.08;

  const place = React.useCallback(
    (animate: boolean) => {
      const thumb = thumbRef.current;
      const el = refs.current[value];
      if (!thumb || !el) return;

      const x = el.offsetLeft;
      const y = el.offsetTop;

      if (!animate) thumb.style.transition = "none";
      thumb.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      thumb.style.width = `${el.offsetWidth}px`;
      thumb.style.height = `${el.offsetHeight}px`;

      if (!animate) {
        void thumb.offsetHeight; // flush the jump before the class transition returns
        thumb.style.transition = "";
        lastPos.current = { x, y };
        setTravel(null);
        return;
      }

      // The stretch is STATE, not an inline style cleared from a rAF callback.
      //
      // The first version wrote `thumb.style.scale` directly and scheduled a
      // rAF to clear it. Verified in the browser: it never cleared — the thumb
      // stayed permanently deformed at 1.08 × 0.93 after the first switch. An
      // imperative write racing a declarative render is a bug waiting for a
      // slow frame; React owns the attribute, so React owns the value.
      const prev = lastPos.current;
      lastPos.current = { x, y };
      if (!prev || prefersReducedMotion()) return;

      const dx = Math.abs(x - prev.x);
      const dy = Math.abs(y - prev.y);
      if (dx < 1 && dy < 1) return;

      const along = Math.min(Math.max(dx, dy) * STRETCH_PER_PX, MAX_STRETCH);
      const grow = 1 + along;
      const shrink = 1 / grow;
      // Stretch along travel, contract across it: the thumb keeps its apparent
      // area, so it reads as a body deforming rather than one growing.
      setTravel(dx >= dy ? { sx: grow, sy: shrink } : { sx: shrink, sy: grow });
    },
    [value],
  );

  /**
   * Release the stretch one frame after it is applied.
   *
   * Applying and releasing on the same frame would collapse into no animation
   * at all; a frame apart, the `scale` transition runs the whole way back on
   * its own (slower) curve while the thumb is still travelling. The overlap is
   * the effect: the body leans into the move, arrives, and relaxes a beat
   * later — which is what "settled" looks like, as opposed to "stopped".
   */
  React.useEffect(() => {
    if (!travel) return;
    const id = requestAnimationFrame(() => setTravel(null));
    return () => cancelAnimationFrame(id);
  }, [travel]);

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
        // in both themes. It shares TabsList's material and geometry — this and
        // the tab strip are two renderings of one idiom, and shipping them with
        // two concentric systems and two track colours is the drift. The track
        // used to be a raw `bg-black/[0.055] dark:bg-black/25` literal, which no
        // retheme can reach. No border: the thumb is positioned from
        // offsetLeft/offsetTop, which agree with left-0/top-0 only while the
        // padding edge and border edge coincide.
        // Concentric corners: the track's outer radius = the thumb's inner
        // radius + the padding that separates them (menu 12 = control 9 + 4, to
        // within the 1px that a rounded corner cannot show), and the padding is
        // uniform (p-1) so the thumb's inset is identical on all four sides.
        //
        // This line said "shares TabsList's material and geometry" while
        // diverging from it on four axes at once: radius 9 vs 12, fill 55% vs
        // 70%, a border TabsList does not have, and no `field-well` — the inset
        // the docstring at the top of this file calls the track's defining
        // feature. Two renderings of one idiom cannot disagree about all four.
        // It is TabsList's string now, verbatim — including the removal of
        // `bg-muted/70`, which was silently overriding `field-well`'s own fill.
        // Utilities are emitted after the components layer, so on light the
        // utility won; on dark `.dark .field-well` (0,2,0) outranked it and won
        // instead. One track, two themes, two different sources of truth — and
        // the one that knows a well has to LIFT on a black ground rather than
        // recess below it was the half that kept getting overruled.
        "relative gap-1 rounded-menu p-1 field-well",
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
        data-pressed={pressed ? "" : undefined}
        // Scale is driven from one place: a press wins over travel, because a
        // finger on the control outranks an animation it interrupted.
        style={
          pressed
            ? { scale: "0.97" }
            : travel
              ? { scale: `${travel.sx} ${travel.sy}` }
              : undefined
        }
        className={cn(
          // rounded-control (9), not rounded-xs (6): the track is 12 with p-1, so
          // 12 − 4 = 8 ≈ 9 is the concentric answer, the same one TabsTrigger
          // already uses inside the identical shell.
          "pointer-events-none absolute left-0 top-0 z-0 rounded-control border border-border/80 bg-card",
          // Opaque, and the fill is per-theme, because "raised" is a lightness
          // relationship and the two themes do not agree on which direction it
          // points from here.
          //
          // On paper the well is --background (97%) and the thumb is --card
          // (99%): two points up, which is the whole read. On dark the well
          // lifts to --secondary (9.5%) and --card would land at 6.5% — the
          // thumb DARKER than the well it is supposed to stand out of, so the
          // selection was carried entirely by a 1px sheen. --accent (13%)
          // restores the same "one rung up" the light theme has.
          //
          // This is also why the earlier `bg-card/80 backdrop-blur-xl` glass is
          // gone rather than restored: a translucent pane reads as a lens only
          // when there is a lightness difference for it to sample, and on a
          // black ground it sampled a surface identical to itself — a
          // compositor layer per switch, for nothing visible.
          "bg-card dark:bg-accent",
          // THE SLIDE. `ease-out-back` overshoots by ~3% and comes back, so the
          // pane arrives with weight instead of stopping on the mark. This is
          // the one curve in the system that overshoots and this is what it was
          // added for. (`ease-spring`, which this used to name, was an alias of
          // ease-out-strong that never sprang at all — since deleted.)
          //
          // THE RELAX. `scale` is given a slower rung and a plain decelerate, so
          // the stretch is still unwinding for ~140ms after the travel has
          // finished. Two properties, two durations, deliberately out of phase —
          // an element whose deformation ends exactly when its movement ends
          // reads as rigid, however far it stretched on the way.
          // ONE transition declaration, written longhand because the four
          // properties genuinely want four timings and any shorthand that gave
          // them one would flatten the whole effect:
          //
          //   transform  --dur-base  ease-out-back   the slide, overshooting ~3%
          //                                          so the pane settles rather
          //                                          than stops
          //   width/height  ditto                    kept in lockstep with it,
          //                                          or the box visibly resizes
          //                                          after arriving
          //   scale      --dur-slow  ease-out-soft   the stretch relaxing — a
          //                                          slower rung on purpose, so
          //                                          deformation is still
          //                                          unwinding ~140ms after the
          //                                          travel ends. An element
          //                                          that stops deforming exactly
          //                                          when it stops moving reads
          //                                          as rigid however far it
          //                                          stretched on the way.
          //   box-shadow --dur-fast                  depth answers the pointer,
          //                                          not the journey
          //
          // What shipped was 180ms/ease-out-soft for transform and --dur-press
          // for scale: an off-ladder duration (the rungs are 70/120/160/220/360/
          // 560), no overshoot anywhere, and a "relax" that finished before the
          // travel did — i.e. the exact three things the block above says are the
          // point. It is the spec now.
          "[transition:transform_var(--dur-base)_var(--ease-out-back),width_var(--dur-base)_var(--ease-out-back),height_var(--dur-base)_var(--ease-out-back),scale_var(--dur-slow)_var(--ease-out-soft),box-shadow_var(--dur-fast)_var(--ease-out-soft)]",
          // The specular edge: a glass pane is lit along its top and shadowed
          // where it meets the recess it floats in. This was `shadow-sm` —
          // Tailwind's STOCK default, a raw `rgb(0 0 0 / 0.05)` that is not on
          // the Juno ramp, is invisible on black, and drew none of the lit top
          // edge the sentence above promises. Same recipe TabsTrigger uses, plus
          // the --hairline bottom edge that is the "shadowed where it meets the
          // recess" half of the sentence.
          "[box-shadow:inset_0_1px_0_hsl(var(--sheen)),inset_0_-1px_0_hsl(var(--hairline)),var(--shadow-pop)]",
          // Held: the pane goes down into its well and its cast shadow collapses
          // to a single tight rung, which is what closing the gap to the ground
          // looks like. `scale` is re-timed to --dur-press here — the slow rung
          // above is right for relaxing a stretch and far too slow for answering
          // a finger.
          // --shadow-ink, not the literal `48 12% 18%` that was baked in here:
          // that is the LIGHT theme's warm ink, and an 18%-lightness shadow on a
          // #000 ground is a light patch under the thumb — the halo again with
          // the saturation turned down. The token is exactly this value on light
          // and pure black on dark, which is what the line was reaching for.
          "data-[pressed]:[box-shadow:inset_0_1px_0_hsl(var(--sheen)),0_1px_1px_-1px_hsl(var(--shadow-ink)/0.10)]",
          "data-[pressed]:[transition:scale_var(--dur-press)_var(--ease-out-strong),box-shadow_var(--dur-press)_var(--ease-out-soft)]",
          // Rest value for the independent `scale` property. Independent rather
          // than a transform utility because `place()` writes
          // `transform: translate3d(...)` inline on every move, and a
          // `scale-[...]` class would be clobbered by the next placement.
          "[scale:1]",
          "motion-reduce:transition-none",
        )}
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
          // Only the press starts here; the window listener above ends it, so a
          // release anywhere on screen lifts the thumb.
          onPointerDown={() => value === opt.value && !opt.disabled && setPressed(true)}
          className={cn(
            // The contents dip WITH the thumb rather than instead of it, so the
            // key and its legend travel together. --dur-press, matching .pressable.
            "group relative z-10 flex items-center justify-center rounded-control font-medium",
            "transition-[color,transform,background-color] duration-fast ease-out-soft",
            "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
            "motion-reduce:transition-none motion-reduce:active:scale-100",
            // `coarse:` growth on the icon rail. This is the one variant meant
            // for a sidebar toggle on touch and it was the only control in the
            // product still under the 44px target — Button (button.tsx) and
            // Pressable (pressable.tsx) both grow every icon target on a coarse
            // pointer. `text-sm` rather than the off-ladder 13px: this is the
            // same idiom as TabsTrigger and now says so at the same size.
            labelHidden ? "size-8 coarse:size-10" : "gap-1.5 px-3 py-1 text-sm",
            value === opt.value
              ? "text-foreground"
              : // An inactive segment had colour-only hover: the label brightened
                // with no ground under it, so the hit area was invisible until
                // you were already on it. A faint wash names the target. It is
                // deliberately far below the thumb's own contrast — this is
                // "you can press here", not a second selected state.
                //
                // `bg-accent/60`, not `bg-foreground/[0.035]`: 3.5% of a 94%
                // foreground over the track lands at ~3% lightness, so on pure
                // black the wash the comment above describes was still invisible.
                // The accent rung is what the rest of the product hovers with.
                "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            optionClassName,
          )}
        >
          {/* The mark arrives WITH the thumb rather than snapping when the
              class flips. An unselected icon sits slightly small and dimmed;
              becoming selected brings it to full size and full ink over the
              same --dur-base the thumb travels in, so the destination segment
              is visibly "coming alive" while the thumb is still on its way.
              That overlap is what makes the switch feel like one gesture
              instead of a slide followed by a colour change. */}
          <span
            className={cn(
              "inline-flex transition-[transform,opacity] duration-base ease-out-strong motion-reduce:transition-none",
              value === opt.value ? "scale-100 opacity-100" : "scale-[0.92] opacity-70",
            )}
          >
            {opt.icon}
          </span>
          {/* The label tracks the same curve. `font-medium` throughout — shifting
              weight on selection would reflow the segment and make the thumb
              chase a target that moved while it was travelling. */}
          {!labelHidden && (
            <span
              className={cn(
                "transition-opacity duration-base ease-out-strong motion-reduce:transition-none",
                value === opt.value ? "opacity-100" : "opacity-85",
              )}
            >
              {opt.label}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
