"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getConsent, onConsentChange, setConsent } from "@/lib/consent";

/**
 * Cookie-consent banner — a small glass card pinned bottom-left, shown until a
 * choice is stored (`juno:consent:v1`). Juno only sets essential sign-in
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
      className="fixed bottom-4 left-4 z-popper w-[min(21rem,calc(100vw-2rem))] rounded-popover overlay-glass p-4 data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out motion-reduce:animate-none"
    >
      {/* The shell's eyebrow treatment (mono / uppercase / 0.10em), not a
          one-off `text-xs`. Every other floating surface in the app opens with
          this exact label role. */}
      <p className="font-mono text-label uppercase text-muted-foreground">Cookies</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Juno only uses essential cookies to keep you signed in — no analytics, no trackers. Your
        choice here also covers anything we might add later.{" "}
        <Link
          href="/legal/confidentialite"
          className="text-foreground underline underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary"
        >
          Privacy policy
        </Link>
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={() => choose(true)}>
          Accept
        </Button>
        <Button size="sm" variant="outline" onClick={() => choose(false)}>
          Essential only
        </Button>
      </div>
    </section>
  );
}
