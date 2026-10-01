"use client";

import * as React from "react";
import { ChatSurface } from "./chat";
import { Composer } from "./composer";
import { DRAFT, type Segment } from "./fixtures";
import { AppFrame, ChatSidebar, usePanelAtEnd } from "./shell";
import { Answer, UserMessage } from "./thread";

/*
 * Home: Chat at rest, empty, so the placeholder teaches @ and / (a new viewer
 * never mistakes a pre-typed draft for their own words). `draft=1` shows the
 * sentence written with tokens; `focus=1` the focused composer; `app=stripe`
 * opens its panel; `model=1` the model list; `plus=1` the + menu.
 */
export function HomeScene({
  focused,
  panel,
  draft,
  pop,
  model,
  plus,
}: {
  focused?: boolean;
  panel?: string;
  draft?: boolean;
  pop?: "account" | "activity";
  model?: boolean;
  plus?: boolean;
}) {
  return (
    <AppFrame sidebar={<ChatSidebar pop={pop} />} skip={{ href: "#jn-message", label: "Skip to message" }}>
      <ChatSurface initialPhase="home" initialSegs={draft || panel ? DRAFT : []} composerStill={{ focused, pointerFocused: !!panel || model || plus, panel, model, plus }} />
    </AppFrame>
  );
}

/* Thread: after send. Newest at the bottom, as a live chat sits. */
export function ThreadScene({ top, planOpen, stage, menu }: { top?: boolean; planOpen?: boolean; stage?: string; menu?: boolean }) {
  usePanelAtEnd(!top);
  const still =
    stage === "thinking"
      ? { stage: "thinking" as const, presence: 1, seconds: 4 }
      : stage === "streaming"
        ? { stage: "streaming" as const, revealed: 38 }
        : undefined;
  return (
    <AppFrame sidebar={<ChatSidebar current="thread" threadNeeds />} skip={{ href: "#jn-message", label: "Skip to message" }}>
      <ChatSurface initialPhase="thread" initialStage="approval" auto={false} planOpen={planOpen} stillStage={still} approvalMenu={menu} />
    </AppFrame>
  );
}

/*
 * Menus: the floating layers, each opened from a docked composer over a real
 * transcript, inside a framed panel, so the material (D-033) is judged where
 * it lives: over text and a table, not over an empty ground.
 *   the @ palette at the caret: Crew, Files, Projects, Apps, Chats, key hints
 *   the model popover: Auto, four models with one line each, effort, all models
 *   an app's panel, grown from its token: what this message lets Stripe do
 */
export function MenusScene() {
  const atDraft: Segment[] = [
    { t: "text", v: "Compare " },
    { t: "token", id: "forecast" },
    { t: "text", v: " with " },
    { t: "token", id: "stripe" },
    { t: "text", v: " and ask " },
  ];
  return (
    <div className="jn-board jn-board--menus">
      <MenuCell cap="Typing @ puts an agent, file, project, app or chat in the sentence" label="Add context with @">
        <Composer variant="dock" initial={atDraft} still={{ palette: { query: "", active: 0 } }} />
      </MenuCell>
      <MenuCell cap="Auto, four models with one line each, effort, then every model" label="Model">
        <Composer variant="dock" initial={DRAFT} still={{ model: true, pointerFocused: true }} />
      </MenuCell>
      <MenuCell cap="An app’s token opens what this message lets the app do" label="App panel">
        <Composer variant="dock" initial={DRAFT} still={{ panel: "stripe", pointerFocused: true }} />
      </MenuCell>
    </div>
  );
}

function MenuCell({ cap, label, children }: { cap: string; label: string; children: React.ReactNode }) {
  return (
    <section className="jn-board__cell" aria-label={label}>
      <p className="jn-board__cap">{cap}</p>
      <div className="jn-board__panel">
        <div className="jn-board__behind" aria-hidden="true">
          <UserMessage segments={DRAFT} />
          <Answer />
        </div>
        <div className="jn-dock jn-board__dock">{children}</div>
      </div>
    </section>
  );
}
