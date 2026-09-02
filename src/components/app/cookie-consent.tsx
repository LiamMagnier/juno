"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getConsent, onConsentChange, setConsent } from "@/lib/consent";

/**
 * Cookie-consent toast — a compact `.surface-float` card at the bottom centre,
 * shown until a choice is stored (`juno:consent:v1`). Juno only sets essential sign-in
 * cookies today; the recorded choice gates any analytics added later (which
 * must check `getConsent()` from `@/lib/consent`).
 */
export function CookieConsent() {
  const [visible, setVisible] = React.useState(false);
  // Mounted-but-leaving. `visible` used to flip straight to false, so the banner
  // disappeared in a single frame; the exit needs the element to survive it.
  const [closing, setClosing] = React.useState(false);

  React.useEffect(() => {
    // Read after mount so SSR markup never flashes the banner for users who chose.
    setVisible(getConsent() === null);
    // Hide if another tab (or future settings UI) records a choice. Note this also
    // fires synchronously for our own setConsent() below, which is why `choose`
    // does not unmount directly — it would cut the exit off at the knees.
    return onConsentChange((state) => {
      if (state === null) {
        setClosing(false);
        setVisible(true);
      } else {
        setClosing(true);
      }
    });
  }, []);

  React.useEffect(() => {
    if (!closing) return;
    // Backstop, not the normal path: motion-reduce:animate-none means no animation
    // runs, so `animationend` never fires and the banner would stay pinned forever.
    const t = setTimeout(() => setVisible(false), 400);
    return () => clearTimeout(t);
  }, [closing]);

  const choose = (analytics: boolean) => {
    setConsent(analytics);
    setClosing(true);
  };

  if (!visible) return null;

  return (
    <section
      role="region"
      aria-label="Cookie preferences"
      // The only overlay a signed-out visitor ever sees, so it has to be on the
      // shared contract: the popover radius (14px — `rounded-panel` is the 18px
      // MODAL rung, too wide for a 21rem corner banner), the shared material,
      // and the same pop-in/out pair as every other floating layer instead of a
      // fifth entrance curve of its own.
      data-state={closing ? "closed" : "open"}
      onAnimationEnd={() => closing && setVisible(false)}
      // A compact toast at the bottom centre, on the floating rung at the
      // toast radius (`rounded-card`), so it sits where every other transient
      // notice does and never covers the sidebar's footer. Centred with
      // inset-x + mx-auto rather than a translate, so the pop-in/out keyframes
      // keep `transform` to themselves.
      className="surface-float fixed inset-x-3 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-popper mx-auto flex w-fit max-w-[min(40rem,100%)] flex-col gap-3 rounded-card px-4 py-3 data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none sm:flex-row sm:items-center"
    >
      <p className="text-sm leading-snug text-muted-foreground">
        <span className="font-medium text-foreground">Cookies.</span> Only the essential ones, to keep you signed in — no analytics, no trackers.{" "}
        <Link
          href="/legal/confidentialite"
          className="text-foreground underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary"
        >
          Privacy policy
        </Link>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => choose(false)}>
          Essential only
        </Button>
        <Button size="sm" onClick={() => choose(true)}>
          Accept
        </Button>
      </div>
    </section>
  );
}
