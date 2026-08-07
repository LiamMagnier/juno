"use client";

import * as React from "react";
import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AutoTranslate } from "@/components/i18n/auto-translate";

export function Providers({
  children,
  defaultTheme = "system",
  session = null,
  locale = "en",
  autoDetect = true,
}: {
  children: React.ReactNode;
  defaultTheme?: string;
  session?: Session | null;
  locale?: string;
  /** False when `locale` is the user's explicit choice, which no client-side detection may override. */
  autoDetect?: boolean;
}) {
  return (
    // Hydrate with the server-resolved session so the client doesn't fetch
    // /api/auth/session on first paint, and don't refetch on window focus —
    // both are the usual sources of Auth.js "ClientFetchError: Load failed".
    <SessionProvider session={session} refetchOnWindowFocus={false}>
      <ThemeProvider attribute="class" defaultTheme={defaultTheme} enableSystem disableTransitionOnChange>
        <TooltipProvider delayDuration={200}>
          {children}
          <AutoTranslate locale={locale} autoDetect={autoDetect} />
          {/*
            Bottom, not top: the transcript's newest content sits at the top of
            the scroll area, so a top-center toast landed directly on the
            message that caused it — and on mobile it covered the entire top bar
            (menu, title, search, new chat).

            The offsets clear the composer. Sonner ignores the x-position below
            600px and goes full-bleed, so the mobile offset has to be set
            explicitly or the toast sits on the input.

            No `richColors`: it emits sonner's own success/error/warning background
            and border custom properties at equal specificity to ours, so any of the
            ~237 toast.success() calls could render in stock green instead of Juno's
            glass — the toast surface was effectively indeterminate. The semantics
            now come from Juno's own ink ramps (sonner.tsx).
          */}
          <Toaster
            position="bottom-center"
            offset={{ bottom: "8rem" }}
            mobileOffset={{ bottom: "7rem", left: "0.75rem", right: "0.75rem" }}
            closeButton
          />
        </TooltipProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
