"use client";

import * as React from "react";
import type { Direction } from "./orbit-render";

export function OrbitAgentsBoard({ dir }: { dir: Direction }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void import("./gallery").then(({ mountGallery }) => {
      if (!cancelled) mountGallery(el, dir);
    });
    return () => {
      cancelled = true;
      el.replaceChildren();
    };
  }, [dir]);
  return <div ref={ref} />;
}
