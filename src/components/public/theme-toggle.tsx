"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "@/components/ui/icons";

export function PublicThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const dark = ready && resolvedTheme === "dark";
  return <button type="button" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={dark ? "Use light mode" : "Use dark mode"} title={dark ? "Use light mode" : "Use dark mode"} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground motion-reduce:transition-none">
    {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
  </button>;
}
