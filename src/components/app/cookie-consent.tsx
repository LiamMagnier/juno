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

  React.useEffect(() => {
    // Read after mount so SSR markup never flashes the banner for users who chose.
    setVisible(getConsent() === null);
    // Hide if another tab (or future settings UI) records a choice.
    return onConsentChange((state) => setVisible(state === null));
  }, []);

  const choose = (analytics: boolean) => {
    setConsent(analytics);
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <section
      role="region"
      aria-label="Cookie preferences"
      className="fixed bottom-4 left-4 z-50 w-[min(21rem,calc(100vw-2rem))] rounded-[18px] border border-border/60 bg-popover/80 p-4 text-popover-foreground glass-raised backdrop-blur-xl motion-safe:animate-rise-in"
    >
      <p className="font-mono text-xs font-medium text-muted-foreground">Cookies</p>
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
