"use client";

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
 * The home's field: the homepage's construction, centred on the composer the
 * way the hero's product window sits on its orbits. The number line runs
 * through the composer, the orbits open around it, and the one presence
 * trajectory ends past ℵ₃, the frame's one live object. Drawn once when the
 * home arrives (alv-draw), faint, masked to an ellipse so it never reaches
 * the sidebar or the header band. Decorative.
 */
export function HomeField({ visible = true }: { visible?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "alv chat-home__field [&.alv]:bg-transparent",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <Construction />
    </div>
  );
}

/**
 * Incognito's quiet field: the homepage construction (nested orbits on a
 * number line) drawn still and very faint, centred on the mark, so the mark
 * sits at the origin of the brand's own drawing. No trajectory and no ticks:
 * presence blue means something live, and a private chat has nothing live to
 * show. Static (no draw-on), masked to a soft ellipse so it never reaches the
 * composer, and decorative.
 */
function PrivateField() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "alv pointer-events-none absolute left-1/2 top-6 -z-10 aspect-[3/2] w-[36rem] sm:w-[56rem] -translate-x-1/2 -translate-y-1/2 opacity-50 [&.alv]:bg-transparent",
        "[mask-image:radial-gradient(ellipse_50%_50%_at_50%_50%,#000_12%,transparent_72%)] [&_svg]:size-full",
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
 * headline, for a mode whose whole point is to be quiet. It sits at the
 * origin of a faint, still construction (`PrivateField`), which is what makes
 * the page read as Alevr rather than as a generic "private window" notice.
 */
export function PrivateGreeting({ field = true }: { field?: boolean }) {
  return (
    <div className="relative isolate flex w-full flex-col items-center text-center">
      {field ? <PrivateField /> : null}
      <span className="grid size-12 place-items-center rounded-full border border-foreground/[0.12] bg-background text-foreground shadow-[0_1px_2px_hsl(var(--foreground)/0.04)]">
        <IncognitoGlyph className="size-6" strokeWidth={1.5} />
      </span>
      <h1 className="mt-5 text-balance font-serif text-display font-normal text-foreground">Incognito chat</h1>
      <p className="mt-2 max-w-md text-pretty text-body text-muted-foreground">
        This chat won&apos;t appear in your history, won&apos;t be added to memory, and isn&apos;t used to train models.
      </p>
    </div>
  );
}
