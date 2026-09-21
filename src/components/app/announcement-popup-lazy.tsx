"use client";

import * as React from "react";

/**
 * The announcement popup, fetched once the page has gone quiet.
 *
 * Nothing about it is needed at first paint: it asks `/api/announcements`
 * what is current, and on almost every load the answer is "nothing" or
 * "something this reader already dismissed". Loading it with the shell meant
 * every app route carried its dialog, its video/image surface and a provider
 * logo set before it could hydrate, and spent a request on the answer while
 * the page the reader asked for was still arriving.
 *
 * Deferred rather than gated on the fetch: the popup does that fetch itself,
 * and doing it here as well to decide whether to mount would ask the same
 * question twice. Idle is late enough to be off the critical path and early
 * enough that a live announcement still appears as the page settles.
 */
type AnnouncementModule = typeof import("@/components/app/announcement-popup");

export function AnnouncementPopupLazy() {
  const [Loaded, setLoaded] = React.useState<AnnouncementModule["AnnouncementPopup"] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = () => {
      void import("@/components/app/announcement-popup").then((mod) => {
        if (!cancelled) setLoaded(() => mod.AnnouncementPopup);
      });
    };
    const win = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (win.requestIdleCallback) {
      const handle = win.requestIdleCallback(load, { timeout: 5000 });
      return () => {
        cancelled = true;
        win.cancelIdleCallback?.(handle);
      };
    }
    const timer = window.setTimeout(load, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  return Loaded ? <Loaded /> : null;
}
