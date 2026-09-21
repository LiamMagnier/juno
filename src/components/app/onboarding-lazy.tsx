"use client";

import * as React from "react";
import { useApp } from "@/components/app/app-provider";

/**
 * The first-run card, fetched only by an account that is actually on its first
 * run.
 *
 * `Onboarding` decides whether to show itself from two facts — a localStorage
 * flag and whether the account has any conversations — and for everyone past
 * their first session the answer is no. Both facts are free to read, and the
 * card behind them is not, so the test happens here and the card is fetched
 * only when it passes. A returning reader never downloads it at all.
 *
 * The key is duplicated from onboarding.tsx deliberately: importing it would
 * import the module, which is the thing this file exists not to do.
 */
const KEY = "juno:onboarded:v1";

type OnboardingModule = typeof import("@/components/app/onboarding");

export function OnboardingLazy() {
  const { conversations } = useApp();
  const [Loaded, setLoaded] = React.useState<OnboardingModule["Onboarding"] | null>(null);

  React.useEffect(() => {
    try {
      // Already finished first-run — never load the card again.
      if (localStorage.getItem(KEY)) return;
      // Any history at all means they are past first-run. The flag is written
      // HERE and not left to the card, because the card is exactly what this
      // branch declines to load: without this write, an account that never saw
      // onboarding would be shown the welcome card the day it deleted its last
      // conversation. That is the case the flag was introduced to prevent.
      if (conversations.length > 0) {
        localStorage.setItem(KEY, "1");
        return;
      }
    } catch {
      // Private mode / no storage — onboarding skips itself there anyway.
      return;
    }
    let cancelled = false;
    void import("@/components/app/onboarding").then((mod) => {
      if (!cancelled) setLoaded(() => mod.Onboarding);
    });
    return () => {
      cancelled = true;
    };
  }, [conversations.length]);

  return Loaded ? <Loaded /> : null;
}
