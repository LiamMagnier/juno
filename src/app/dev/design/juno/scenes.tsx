"use client";

import * as React from "react";
import { ChatSurface } from "./chat";
import { Composer } from "./composer";
import { DRAFT, type Segment } from "./fixtures";
import { AppFrame, ChatSidebar } from "./shell";

/* Home: Chat at rest, the draft written with tokens. `focus=1` shows the focused composer; `app=stripe` opens its panel. */
export function HomeScene({ focused, panel, empty }: { focused?: boolean; panel?: string; empty?: boolean }) {
  return (
    <AppFrame sidebar={<ChatSidebar />}>
      <ChatSurface initialPhase="home" initialSegs={empty ? [] : DRAFT} composerStill={{ focused, pointerFocused: !!panel, panel }} />
    </AppFrame>
  );
}

/* Thread: after send. Newest at the bottom, as a live chat sits. */
export function ThreadScene({ top, planOpen, stage, menu }: { top?: boolean; planOpen?: boolean; stage?: string; menu?: boolean }) {
  React.useEffect(() => {
    if (top) return;
    const go = () => window.scrollTo(0, document.documentElement.scrollHeight);
    go();
    const ts = [150, 400, 900, 1500, 2200].map((ms) => window.setTimeout(go, ms));
    return () => ts.forEach((t) => window.clearTimeout(t));
  }, [top]);
  const still =
    stage === "thinking"
      ? { stage: "thinking" as const, presence: 1, seconds: 4 }
      : stage === "streaming"
        ? { stage: "streaming" as const, revealed: 38 }
        : undefined;
  return (
    <AppFrame sidebar={<ChatSidebar current="thread" />}>
      <ChatSurface initialPhase="thread" initialStage="approval" auto={false} planOpen={planOpen} stillStage={still} dockNeeds={!!top && !still} approvalMenu={menu} />
    </AppFrame>
  );
}

/* Menus: the "@" palette at the caret, and the model popover, on the plain ground. */
export function MenusScene() {
  const atDraft: Segment[] = [
    { t: "text", v: "Compare " },
    { t: "token", id: "forecast" },
    { t: "text", v: " with " },
    { t: "token", id: "stripe" },
    { t: "text", v: " and ask " },
  ];
  return (
    <div className="jn-board">
      <section className="jn-board__cell" aria-label="Add context with @">
        <p className="jn-board__cap">Typing @ puts a teammate, file, project, app or chat in the sentence</p>
        <Composer initial={atDraft} still={{ palette: { query: "", active: 0 } }} />
      </section>
      <section className="jn-board__cell" aria-label="Model">
        <p className="jn-board__cap">Auto, four models with one line each, effort, and every other model one step down</p>
        <Composer initial={DRAFT} still={{ model: true, pointerFocused: true }} />
      </section>
    </div>
  );
}
