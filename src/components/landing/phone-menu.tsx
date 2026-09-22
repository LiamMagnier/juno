"use client";

import * as React from "react";

import { Menu, X } from "@/components/ui/icons";
import { menuGlyphInkClass, menuRowClass, menuShellClass } from "@/components/ui/menu-recipe";
import { cn } from "@/lib/utils";

/**
 * The landing's phone menu: the section links below `md`, where the bar has no
 * room for them.
 *
 * A NATIVE <details> FIRST. The summary is the button and the list is a
 * floating menu at the popper rung, so the markup works as served: with no
 * JavaScript, on a slow chunk, before hydration. What the browser does not
 * give a disclosure is a menu's manners, and this island adds only those:
 *
 * - It LEAVES. The browser hides a closing <details> in the frame it closes,
 *   so the list that popped in on the spring used to vanish. Now a close is a
 *   decision first (`closing`): the shell runs the menu recipe's own exit
 *   (`data-[state=closed]:animate-pop-out`, --dur-fast on --ease-in), and the
 *   element only closes once that animation has finished. The Menu/X swap and
 *   the summary's pressed tone release at the decision, not after it, so the
 *   glyph turns back while the list is still going.
 * - It closes when a SECTION LINK is taken. The link still navigates on its
 *   own (a plain hash link, nothing prevented); the menu leaves while the
 *   page moves under it instead of staying open over the section it opened.
 * - Escape closes it and returns focus to the button, and a press anywhere
 *   outside closes it without being swallowed, the way the app's menus do.
 *
 * Tapping the button mid-exit sends the list straight back. The shell takes
 * no pointer while it leaves, so a second tap cannot land on a row that is
 * on its way out. Not `inert`: a link taken with Enter is still mid-dispatch
 * when the close commits, and its navigation must not depend on how a
 * browser treats an anchor that turned inert under its own click.
 *
 * Reduced motion: pop-out reads --motion-shift and --motion-scale-from, so
 * the exit keeps its fade on the same timing and loses its drift and scale
 * (docs/design/ICONS_AND_MOTION.md §2.2.10), and the element still closes on
 * that fade's end.
 */

type Phase = "closed" | "open" | "closing";

/** One face of the Menu/X swap: `icon-swap.tsx`'s FACE, which owns the
 *  opacity/scale transition so the glyph inside keeps its own. */
const SWAP_FACE =
  "col-start-1 row-start-1 inline-flex items-center justify-center transition-[opacity,transform] duration-fast ease-out-soft";

export function LandingPhoneMenu({ links }: { links: readonly { href: string; label: string }[] }) {
  const detailsRef = React.useRef<HTMLDetailsElement>(null);
  const summaryRef = React.useRef<HTMLElement>(null);
  const shellRef = React.useRef<HTMLElement>(null);
  const [phase, setPhase] = React.useState<Phase>("closed");

  const close = React.useCallback(() => {
    if (detailsRef.current?.open) setPhase("closing");
  }, []);

  // The exit. Once the shell's pop-out is running, wait for it to finish,
  // then close the element for real. `getAnimations()` flushes style first,
  // so the animation `data-state="closed"` just started is in the list; with
  // no animation at all (none ran) the element closes at once. A reopen
  // mid-exit cancels the animation and this effect's cleanup drops the close.
  React.useEffect(() => {
    if (phase !== "closing") return;
    const details = detailsRef.current;
    if (!details) return;
    let live = true;
    const exits = shellRef.current?.getAnimations?.() ?? [];
    void Promise.allSettled(exits.map((animation) => animation.finished)).then(() => {
      if (!live) return;
      details.open = false;
      setPhase("closed");
    });
    return () => {
      live = false;
    };
  }, [phase]);

  // A press outside the open menu closes it. Pointerdown, not click, so the
  // list is already leaving as the finger lands; the press itself is not
  // prevented, so whatever it lands on still gets it.
  React.useEffect(() => {
    if (phase !== "open") return;
    const onPointerDown = (event: PointerEvent) => {
      if (!detailsRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [phase, close]);

  const onSummaryClick = (event: React.MouseEvent<HTMLElement>) => {
    const details = detailsRef.current;
    if (!details) return;
    // The browser's own toggle would close in a frame; this island owns it.
    event.preventDefault();
    // The element, not `phase`, says whether it is open: a tap that landed
    // before hydration opened it natively while `phase` still read closed.
    if (!details.open) {
      details.open = true;
      setPhase("open");
    } else if (phase === "closing") {
      setPhase("open");
    } else {
      setPhase("closing");
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== "Escape" || !event.currentTarget.open || phase === "closing") return;
    event.preventDefault();
    setPhase("closing");
    summaryRef.current?.focus();
  };

  return (
    <details
      ref={detailsRef}
      // Read by the swap and the summary's tone below through
      // `group-[[open]:not([data-closing])]`, so both release the moment the
      // close is decided. Without script the attribute is never set and the
      // variant is plain `[open]`.
      data-closing={phase === "closing" ? "" : undefined}
      onKeyDown={onKeyDown}
      className="group relative md:hidden"
    >
      {/* Menu and X overlap and cross-fade on the open state (the contract's
          state swap: opacity plus 0.8 to 1 scale on the fast rung), rather
          than one glyph replacing the other in a frame. This is <IconSwap>
          driven by the element's state instead of a prop, so it also works
          without script: the transition sits on the FACE, never on the
          glyph, because X carries a hover turn and `svg.icon[data-motion]`
          would replace a glyph-level transition list with its own. The scale
          reads --motion-scale-from, so reduced motion keeps the fade and
          drops the scale. */}
      <summary
        ref={summaryRef}
        aria-label="Sections"
        onClick={onSummaryClick}
        className="pressable flex size-9 cursor-pointer list-none items-center justify-center rounded-control text-muted-foreground hover:bg-accent hover:text-foreground group-[[open]:not([data-closing])]:bg-accent group-[[open]:not([data-closing])]:text-foreground coarse:size-11 [&::-webkit-details-marker]:hidden"
      >
        <span className="inline-grid place-items-center">
          <span
            className={cn(
              SWAP_FACE,
              "group-[[open]:not([data-closing])]:opacity-0 group-[[open]:not([data-closing])]:[transform:scale(var(--motion-scale-from,0.8))]"
            )}
          >
            <Menu className="size-4" aria-hidden />
          </span>
          <span
            className={cn(
              SWAP_FACE,
              "opacity-0 [transform:scale(var(--motion-scale-from,0.8))] group-[[open]:not([data-closing])]:opacity-100 group-[[open]:not([data-closing])]:[transform:none]"
            )}
          >
            <X className="size-4" aria-hidden />
          </span>
        </span>
      </summary>
      <nav
        ref={shellRef}
        aria-label="Sections"
        // `open` on arrival, `closed` while it leaves, nothing while the
        // element is shut, so every open starts the entrance afresh rather
        // than relying on the browser to restart an animation it hid.
        data-state={phase === "open" ? "open" : phase === "closing" ? "closed" : undefined}
        // The app's menu shell, not a second one drawn to look like it: this
        // menu is the first one a visitor opens and it sat at a different
        // radius, padding and row height from every menu behind the sign-in
        // wall. The shell carries the recipe's enter/exit pair on
        // `data-state`; without script there is no state, so the entrance
        // falls back to the same keyframe on the element opening.
        className={cn(
          menuShellClass,
          "absolute right-0 top-full mt-2 min-w-40 data-[state=closed]:pointer-events-none [@media(scripting:none)]:animate-pop-in"
        )}
      >
        {links.map(({ href, label }) => (
          <a
            key={href}
            href={href}
            onClick={close}
            className={cn(menuRowClass, menuGlyphInkClass, "hover:bg-accent focus-visible:bg-accent")}
          >
            {label}
          </a>
        ))}
      </nav>
    </details>
  );
}
