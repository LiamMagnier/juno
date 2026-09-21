"use client";

import type { useRouter } from "next/navigation";

type Router = ReturnType<typeof useRouter>;

/**
 * Prefetch a route when the reader AIMS at it, not when it scrolls into view.
 *
 * WHAT THIS IS FOR. `<Link>` prefetches every link in the viewport. For a list
 * of static pages that is close to free; for this app it is not, because every
 * route is under a `force-dynamic` layout, so a prefetch is a full server
 * render — `getAppBootstrap` and all — that no cache can absorb. A sidebar
 * showing forty conversations therefore fired a wave of full renders on every
 * single page load, measured at sixteen concurrent RSC requests on a fresh
 * /chat, against the one Node process that was also trying to render the page
 * the reader had actually asked for.
 *
 * Hover and keyboard focus are the honest signal: a row someone is pointing at
 * is a row they are about to open, and a row they scrolled past is not. The
 * prefetch still lands well before the click, so navigation feels the same —
 * the server just stops rendering thirty-nine pages nobody asked for.
 *
 * Use WITH `prefetch={false}` on the link, which is what turns the viewport
 * behaviour off; this supplies what replaces it. A plain function rather than
 * a hook because the rows that need it are built inside `.map()` callbacks,
 * where a hook cannot be called.
 *
 * Deduplication is left to the router: `router.prefetch` already serves a
 * route it has in its cache without going to the network, and the client
 * router cache (`staleTimes.dynamic`, next.config.mjs) is what decides when a
 * second look is worth a second render.
 */
export function intentPrefetch(router: Router, href: string) {
  const prefetch = () => {
    try {
      router.prefetch(href);
    } catch {
      // A prefetch is an optimisation; a failed one must never break the click
      // that follows it.
    }
  };
  return { onMouseEnter: prefetch, onFocus: prefetch, onTouchStart: prefetch };
}
