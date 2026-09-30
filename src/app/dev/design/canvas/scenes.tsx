"use client";

import * as React from "react";
import { ChatSurface } from "./chat";
import { Composer } from "./composer";
import { DRAFT } from "./fixtures";
import { AppFrame, ChatSidebar } from "./shell";

/* Home: Chat at rest, with the draft written as tokens. */
export function HomeScene({ panel, focused }: { panel?: string; focused?: boolean }) {
  return (
    <AppFrame sidebar={<ChatSidebar />}>
      <ChatSurface initialPhase="home" composerStill={{ panel, focused }} />
    </AppFrame>
  );
}

/* Thread: after send. Newest at the bottom, as a live chat sits. */
export function ThreadScene({ top, planOpen }: { top?: boolean; planOpen?: boolean }) {
  React.useEffect(() => {
    if (top) return;
    const go = () => window.scrollTo(0, document.documentElement.scrollHeight);
    go();
    const t = window.setTimeout(go, 400);
    return () => window.clearTimeout(t);
  }, [top]);
  return (
    <AppFrame sidebar={<ChatSidebar current="thread" />}>
      <ChatSurface initialPhase="thread" initialStage="approval" auto={false} planOpen={planOpen} />
    </AppFrame>
  );
}

/* Menus: the "@" palette at the caret, and the model list, on the canvas. */
export function MenusScene() {
  return (
    <div className="cv-board">
      <div className="cv-gridlayer" aria-hidden="true" />
      <section className="cv-board__cell" aria-label="Add context with @">
        <p className="cv-board__cap">Type @ to put a file, app, project or teammate in the sentence</p>
        <Composer
          initial={[
            { t: "text", v: "Compare " },
            { t: "token", id: "forecast" },
            { t: "text", v: " with " },
            { t: "token", id: "stripe" },
            { t: "text", v: " and ask " },
          ]}
          still={{ palette: { query: "", active: 0 } }}
        />
      </section>
      <section className="cv-board__cell" aria-label="Model">
        <p className="cv-board__cap">The model list: Auto, the current best, effort, and everything else one step down</p>
        <Composer initial={DRAFT} still={{ model: true }} />
      </section>
    </div>
  );
}
