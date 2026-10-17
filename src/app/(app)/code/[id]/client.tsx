"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import "@/components/code/v2/code-v2.css";
import type { CodeV2RouteProps } from "@/components/code/v2/live-route";
import { CodeSessionFirstPaint } from "@/components/code/v2/session-shell";

/**
 * The page's props, for the dynamic import's fallback (which next/dynamic
 * renders without them).
 */
const FirstPaintProps = React.createContext<CodeV2RouteProps | null>(null);

function FirstPaint() {
  const props = React.useContext(FirstPaintProps);
  return props ? <CodeSessionFirstPaint conversation={props.conversation} initialMessages={props.initialMessages} /> : null;
}

/**
 * Client-only: the workspace reads localStorage (dock width, per-thread model
 * choice) and the live transports on mount, so it renders after hydration.
 * Until it does, the fallback paints the session's frame with the server's
 * turns (server-rendered on a direct load), so the first paint is the thread
 * rather than a blank column.
 */
const Route = nextDynamic(() => import("@/components/code/v2/live-route").then((m) => m.CodeV2Route), { ssr: false, loading: FirstPaint });

export function CodeV2Client(props: CodeV2RouteProps) {
  return (
    <FirstPaintProps.Provider value={props}>
      <div style={{ height: "100%", minHeight: 0 }}>
        <Route {...props} />
      </div>
    </FirstPaintProps.Provider>
  );
}
