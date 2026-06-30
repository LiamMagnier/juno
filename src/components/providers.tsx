"use client";

import * as React from "react";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

export function Providers({
  children,
  defaultTheme = "system",
}: {
  children: React.ReactNode;
  defaultTheme?: string;
}) {
  return (
    <SessionProvider>
      <ThemeProvider attribute="class" defaultTheme={defaultTheme} enableSystem disableTransitionOnChange>
        <TooltipProvider delayDuration={200}>
          {children}
          <Toaster position="top-center" richColors closeButton />
        </TooltipProvider>
      </ThemeProvider>
    </SessionProvider>
  );
}
