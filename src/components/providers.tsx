"use client";

import * as React from "react";
import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AutoTranslate } from "@/components/i18n/auto-translate";
import { MotionConfig } from "framer-motion";
import { useUiPref } from "@/lib/ui-prefs";
import { framerReducedMotion } from "@/lib/motion-preference";
import { ApprovalAnnouncerProvider } from "@/components/approvals/announcer";
import { installInputModality } from "@/components/ui/input-modality";

/** Settings › Appearance › Motion reaches framer-motion too, not only CSS: Reduced holds it still, Full lets it move on a device that reduces. */
function MotionPreference({ children }: { children: React.ReactNode }) {
  const [motion] = useUiPref("motion");
  // Overlays opened from the keyboard only fade (spec C7): track the last input kind for sheet.css.
  React.useEffect(() => installInputModality(), []);
  return <MotionConfig reducedMotion={framerReducedMotion(motion)}>{children}</MotionConfig>;
}

export function Providers({
  children,
  defaultTheme = "system",
  session = null,
  locale = "en",
  autoDetect = true,
  nonce,
}: {
  children: React.ReactNode;
  defaultTheme?: string;
  session?: Session | null;
  locale?: string;
  /** False when `locale` is the user's explicit choice, which no client-side detection may override. */
  autoDetect?: boolean;
  /**
   * The request's CSP nonce, for next-themes' first-paint script. The
   * provider inlines a `<script>` that stamps the theme class before React
   * hydrates; without the nonce the policy the middleware sets refused it on
   * every page, the browser logged a violation, and a dark-theme reader saw
   * the light palette for a frame on each navigation. The middleware mints
   * the nonce and Next stamps it on its own scripts — this one is ours.
   */
  nonce?: string;
}) {
  return (
    // Hydrate with the server-resolved session so the client doesn't fetch
    // /api/auth/session on first paint, and don't refetch on window focus —
    // both are the usual sources of Auth.js "ClientFetchError: Load failed".
    <SessionProvider session={session} refetchOnWindowFocus={false}>
      <ThemeProvider attribute="class" defaultTheme={defaultTheme} enableSystem disableTransitionOnChange nonce={nonce}>
        {/* The tooltip timing is the provider's own default (500 / 300, spec C7). */}
        <TooltipProvider>
          <MotionPreference>
            {/* One approval announcer per window (spec C16), with the ⌥⌘A chord. */}
            <ApprovalAnnouncerProvider>{children}</ApprovalAnnouncerProvider>
          </MotionPreference>
          <AutoTranslate locale={locale} autoDetect={autoDetect} />
          {/*
            The Toaster stays mounted for the whole app (spec C15). Its bottom
            offset is calc(var(--composer-h, 0px) + 16px) (sonner.tsx): the
            composer publishes its height on :root and resets it to 0 when it
            unmounts, so no route list is needed.

            No `richColors`: it emits sonner's own success/error/warning background
            and border custom properties at equal specificity to ours, so any of the
            ~237 toast.success() calls could render in stock green instead of Juno's
            glass — the toast surface was effectively indeterminate. The semantics
            now come from Juno's own ink ramps (sonner.tsx).
          */}
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
