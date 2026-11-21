"use client";

import type { useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";

type Router = ReturnType<typeof useRouter>;
const hoverPrefetch = new WeakMap<Router, { href: string; timer: number }>();

/** Warm a dynamic destination after a brief hover or keyboard focus. */
export function intentPrefetch(router: Router, href: string) {
  const cancelHover = () => {
    const pending = hoverPrefetch.get(router);
    if (pending?.href !== href) return;
    window.clearTimeout(pending.timer);
    hoverPrefetch.delete(router);
  };
  const prefetch = () => {
    try {
      router.prefetch(href, { kind: PrefetchKind.FULL });
    } catch {
      // Navigation can still use the link if prefetch is unavailable.
    }
  };
  return {
    onMouseEnter: () => {
      const pending = hoverPrefetch.get(router);
      if (pending) window.clearTimeout(pending.timer);
      hoverPrefetch.set(router, {
        href,
        timer: window.setTimeout(() => {
          hoverPrefetch.delete(router);
          prefetch();
        }, 90),
      });
    },
    onMouseLeave: cancelHover,
    onFocus: (event: React.FocusEvent<HTMLAnchorElement>) => {
      if (!event.currentTarget.matches(":focus-visible")) return;
      cancelHover();
      prefetch();
    },
  };
}
