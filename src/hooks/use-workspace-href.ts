"use client";

import { useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { workspaceHref } from "@/lib/workspace-surface";

export function useWorkspaceHref() {
  const pathname = usePathname();
  const selected = useSearchParams().get("surface");
  const surface = selected === "code" || pathname === "/code" || pathname?.startsWith("/code/") ? "code" : "chat";
  return useCallback((href: string) => workspaceHref(href, surface), [surface]);
}
