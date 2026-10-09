"use client";

import nextDynamic from "next/dynamic";
import "@/components/code/v2/code-v2.css";
import type { CodeV2RouteProps } from "@/components/code/v2/live-route";

/**
 * Client-only: the workspace reads localStorage (dock width, per-thread model
 * choice) and the live transports on mount, so it renders after hydration.
 */
const Route = nextDynamic(() => import("@/components/code/v2/live-route").then((m) => m.CodeV2Route), { ssr: false });

export function CodeV2Client(props: CodeV2RouteProps) {
  return (
    <div style={{ height: "100%", minHeight: 0 }}>
      <Route {...props} />
    </div>
  );
}
