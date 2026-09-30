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
      <ChatSurface initialPhase="home" initialSegs={empty ? [] : DRAFT} composerStill={{ focused: focused || !!panel, panel }} />
    </AppFrame>
  );
}

/* Thread: after send. Newest at the bottom, as a live chat sits. */
export function ThreadScene({ top, planOpen, stage }: { top?: boolean; planOpen?: boolean; stage?: string }) {
  React.useEffect(() => {
    if (top) return;
    const go = () => window.scrollTo(0, document.documentElement.scrollHeight);
    go();
    const t = window.setTimeout(go, 300);
    const t2 = window.setTimeout(go, 900);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(t2);
    };
  }, [top]);
  const still =
    stage === "thinking"
      ? { stage: "thinking" as const, presence: 1 }
      : stage === "streaming"
        ? { stage: "streaming" as const, revealed: 38 }
        : undefined;
  return (
    <AppFrame sidebar={<ChatSidebar current="thread" />}>
      <ChatSurface initialPhase="thread" initialStage="approval" auto={false} planOpen={planOpen} stillStage={still} />
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
        <p className="jn-board__cap">Auto, four models with one line each, effort, and everything else one step down</p>
        <Composer initial={DRAFT} still={{ model: true, focused: true }} />
      </section>
      <section className="jn-board__cell jn-board__cell--wide" aria-label="App panel">
        <p className="jn-board__cap">An app token opens a panel from the token: what this message may do there, in words</p>
        <Composer initial={DRAFT} still={{ panel: "stripe" }} />
      </section>
    </div>
  );
}
