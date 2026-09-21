"use client";

import * as React from "react";
import { readAura, subscribeAura } from "@/lib/aura";

/**
 * The voice light, fetched when a call starts rather than with the shell.
 *
 * The aura is a canvas and about a thousand lines of per-frame painting, and
 * it belongs to voice alone (see lib/aura.ts) — so outside a call it is a
 * layer that draws nothing. Mounting it with `<main>` meant every app route,
 * on every navigation, downloaded and compiled a renderer for a mode almost no
 * page load enters.
 *
 * The state bus it already reads is the gate: `lib/aura.ts` is a small
 * dependency-free store, so asking it whether a call is up costs nothing, and
 * the renderer arrives the moment the answer changes. Once loaded it STAYS
 * mounted — the aura has a fade-out to play when the call ends, and a later
 * call in the same session should light immediately.
 */
type AuraModule = typeof import("@/components/ambient/ambient-aura");

export function AmbientAuraLazy() {
  const [Loaded, setLoaded] = React.useState<AuraModule["AmbientAura"] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let requested = false;
    const load = () => {
      if (requested) return;
      requested = true;
      void import("@/components/ambient/ambient-aura").then((mod) => {
        if (!cancelled) setLoaded(() => mod.AmbientAura);
      });
    };
    // A call already up when this mounts — a navigation during voice — has to
    // light the new page without waiting for the next state change.
    if (readAura().state !== "idle") load();
    const unsubscribe = subscribeAura((aura) => {
      if (aura.state !== "idle") load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return Loaded ? <Loaded /> : null;
}
