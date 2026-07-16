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
          <Toaster position="top-center" richColors closeButton />
        </TooltipProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
