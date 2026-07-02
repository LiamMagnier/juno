"use client";

import * as React from "react";
import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

export function Providers({
  children,
  defaultTheme = "system",
  session = null,
}: {
  children: React.ReactNode;
  defaultTheme?: string;
  session?: Session | null;
}) {
  return (
    // Hydrate with the server-resolved session so the client doesn't fetch
    // /api/auth/session on first paint, and don't refetch on window focus —
    // both are the usual sources of Auth.js "ClientFetchError: Load failed".
    <SessionProvider session={session} refetchOnWindowFocus={false}>
      <ThemeProvider attribute="class" defaultTheme={defaultTheme} enableSystem disableTransitionOnChange>
        <TooltipProvider delayDuration={200}>
          {children}
          <Toaster position="top-center" richColors closeButton />
        </TooltipProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
