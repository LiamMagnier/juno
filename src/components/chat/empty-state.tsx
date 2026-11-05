"use client";

import * as React from "react";
import { useApp } from "@/components/app/app-provider";
import { IncognitoGlyph } from "@/components/chat/incognito-glyph";
import { Construction } from "@/components/home/construction";
import { cn } from "@/lib/utils";

/**
 * The home's one line (V3 gallery, home scene): upright Newsreader at its
 * display size, regular weight, no italic name and no entrance animation
 * (D-027). It rests on the composer from above; what to do is the composer.
 */
export function EmptyGreeting() {
  const { user } = useApp();
  const firstName = user.name?.trim().split(/\s+/)[0];
  return (
    <div className="flex w-full max-w-2xl flex-col items-center">
      <h1 className="chat-home__title text-balance text-center font-serif font-normal text-foreground">
        What’s next{firstName ? <>, <span>{firstName}</span></> : null}?
      </h1>
    </div>
  );
}

/**
 * The home's field: the homepage's construction as a dot matrix, centred on
 * the composer the way the hero's product window sits on its orbits. The
 * number line crosses the composer on the diagonal and the orbits open around
 * it. No ℵ marks: at this size they crowd the greeting. It draws itself on when the home arrives, faint, masked to
 * an ellipse so it never reaches the sidebar or the header band, and then
 * HOLDS STILL (`hold`): no sway, and no presence trajectory, because presence
 * blue means something live and an empty home has nothing live to show; a
 * moving comet beside the starters only pulled the eye off the composer. No
 * pointer parallax and no pointer lamp in the product either: the dots never
 * brighten or take presence blue under the cursor. Decorative.
 *
 * CALM (G34). The field rests at one low ink (0.55) for as long as the home
 * is on screen, and it never returns to full ink or to presence once the
 * home has settled: not while the person types (when the starters step back
 * and the field used to come forward, lit blue wherever the mouse crossed it,
 * loudest exactly while they work), not under a voice call, not while the
 * chips are dealing in. The content owns the empty state; the drawing is
 * paper. `calm` (whether the starters show) is kept only as `data-calm`, for
 * tests and captures. Nothing is paused mid-draw.
 *
 * NEVER BEHIND TYPE. The greeting rests on the composer from above, so the
 * drawing is fully gone AT the composer's top edge and fades in over the 32px
 * below it, where the composer covers it (FIELD_HORIZON): the orbits open
 * beside and below the composer and never cross the headline, and no loose
 * dot fragments sit in the band between the headline and the composer (the
 * old fade began 24px above the edge and finished 8px below it). The edge
 * follows the composer's own height (`--home-field-lift`, half of it,
 * measured), so a composer that grows with a long draft keeps the headline
 * clear. The starter chips sit in a clearing too: the field fades out by the
 * tray's lower edge, is gone across the gap and the chips' row and comes
 * back under it (`--home-field-clear-bottom`, the row's measured offset
 * below the composer), so no arc threads between the chips or touches their
 * outlines, and no fragments hang in the gap under the tray. While a chip's prompts are open the field steps out altogether
 * (home-starters.css, `[data-open]`), so no arc runs through a prompt.
 *
 * Not on a phone. There the composer sits at the foot of the screen, so half
 * the field hung below it as scrollable overflow (an empty home that moved
 * under a swipe), and what stayed on screen was only dot fragments at the
 * edges and between the chips, no shape at all. Hidden there, the canvas has
 * no area and draws nothing (dot-engine.ts stops asking for frames).
 */
// The field's middle is the composer's middle, so 50% ± lift are its edges.
// Before the chips' row is measured (the server's paint) the clearing takes
// the desktop row's place: 30px under the tray, 34px tall.
const FIELD_TOP = "calc(50% - var(--home-field-lift, 75px))";
const FIELD_BOTTOM = "(50% + var(--home-field-lift, 75px))";
const FIELD_HORIZON = `linear-gradient(to bottom, ${[
  `transparent ${FIELD_TOP}`,
  `#000 calc(${FIELD_TOP} + 32px)`,
  `#000 calc(${FIELD_BOTTOM} - 28px)`,
  `transparent calc(${FIELD_BOTTOM} + 4px)`,
  `transparent calc(${FIELD_BOTTOM} + var(--home-field-clear-bottom, 64px) + 4px)`,
  `#000 calc(${FIELD_BOTTOM} + var(--home-field-clear-bottom, 64px) + 40px)`,
].join(", ")})`;
const FIELD_HORIZON_STYLE: React.CSSProperties = { WebkitMaskImage: FIELD_HORIZON, maskImage: FIELD_HORIZON };

export function HomeField({ visible = true, calm = false }: { visible?: boolean; calm?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  // The field is centred on the composer's wrapper, so the composer's top edge
  // sits half its height above the field's middle.
  // The starter chips' row (a sibling track, home-starters.tsx) is measured
  // from the composer's lower edge, so the clearing follows a row that wraps.
  React.useEffect(() => {
    const field = ref.current;
    const composer = field?.parentElement;
    if (!field || !composer || typeof ResizeObserver === "undefined") return;
    const chips = field.closest(".chat-home")?.querySelector<HTMLElement>(".home-starters__chips") ?? null;
    const sync = () => {
      field.style.setProperty("--home-field-lift", `${composer.offsetHeight / 2}px`);
      if (!chips) return;
      const below = chips.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom;
      field.style.setProperty("--home-field-clear-bottom", `${Math.round(below)}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(composer);
    if (chips) observer.observe(chips);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-calm={calm ? "" : undefined}
      className={cn(
        "alv chat-home__field [&.alv]:bg-transparent [@media(max-width:760px)]:hidden",
        visible ? "opacity-[0.55]" : "opacity-0",
      )}
    >
      <div className="absolute inset-0" style={FIELD_HORIZON_STYLE}>
        <Construction ticks={false} trajectory={false} hold paused={!visible} lamp={false} />
      </div>
    </div>
  );
}

/**
 * Incognito's field: the homepage construction drawn still around the mark.
 * OFF by default (PrivateGreeting `field`): centred on the mark it ran its
 * rings straight through the headline and the sentence under it, the loudest
 * drawing on either home in the mode that should be the quietest. Kept only
 * for the composer-landing gallery's side-by-side (`field`).
 */
function PrivateField() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "alv pointer-events-none absolute left-1/2 top-6 -z-10 aspect-[3/2] w-[36rem] sm:w-[56rem] -translate-x-1/2 -translate-y-1/2 opacity-60 [&.alv]:bg-transparent",
        "[mask-image:radial-gradient(ellipse_50%_50%_at_50%_50%,#000_12%,transparent_72%)]",
      )}
    >
      <Construction animate={false} ticks={false} trajectory={false} />
    </div>
  );
}

/**
 * Private-mode empty header. The same headline rung as the normal greeting
 * (`chat-home__title`), so switching modes swaps one still headline for
 * another of the same size, with no entrance animation of its own (the two
 * cross-fade in chat-view).
 *
 * The mark is a hairline ring on the page's own ground rather than a solid
 * disc: the solid one was the heaviest object on the page, louder than the
 * headline, for a mode whose whole point is to be quiet. Incognito is the
 * quietest screen in the product: no drawing behind the mark or the copy (the
 * home's own field steps out too, chat-view `visible`), no starters; the
 * ring, the serif headline and one muted sentence carry the mode.
 */
export function PrivateGreeting({ field = false }: { field?: boolean }) {
  return (
    <div className="relative isolate flex w-full flex-col items-center text-center">
      {field ? <PrivateField /> : null}
      <span className="grid size-12 place-items-center rounded-full border border-foreground/[0.12] bg-background text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.04)]">
        <IncognitoGlyph className="size-6" strokeWidth={1.5} />
      </span>
      <h1 className="mt-5 text-balance font-serif text-display font-normal text-foreground">Incognito chat</h1>
      <p className="mt-2 max-w-md text-pretty text-body text-muted-foreground">
        This chat won’t appear in your history, won’t be added to memory, and isn’t used to train models.
      </p>
    </div>
  );
}
