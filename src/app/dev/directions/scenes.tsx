"use client";

import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import { MessageItem } from "@/components/chat/message-item";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ArrowRight, Plus, Settings2, Share2, SquarePen, TriangleAlert } from "@/components/ui/icons";
import { Pressable } from "@/components/ui/pressable";
import type { ChatMessage } from "@/hooks/use-chat";
import type { ClientArtifact } from "@/types/chat";
import { cn } from "@/lib/utils";
import { ContextToken, DraftComposer, DraftSentence, MentionPalette, ModelPopover } from "./composer";
import { ACCOUNT, ANSWER, CREW, MIRA, PRESENCE, PRESENCE_ORDER, SCOUT, THREAD_TITLE, type CrewMember } from "./fixtures";
import { ThinkingLine } from "./glyphs";
import { AppFrame } from "./shell";
import type { DirectionId } from "./tokens";
import { ActivityLine, ApprovalPanel, JunoTurn, TaskCard, TokenUserTurn } from "./transcript";

/* ————————————————————————————————————————————————————————————————————————
 * 1. Home: the Chat workspace at rest.
 * ———————————————————————————————————————————————————————————————————— */

/**
 * At most three suggestions, each derived from the account's own state: a
 * crew member waiting, a result to review, a project touched today. Rows on
 * the real `Pressable`, their leading edge on the composer's text inset.
 */
export function Suggestions({ className }: { className?: string }) {
  const rows: { key: string; lead: React.ReactNode; text: string; meta: string; signal?: boolean }[] = [
    {
      key: "mira",
      lead: <AgentFace avatar={MIRA.avatar} state="waiting" size={20} live={false} />,
      text: "Answer Mira about Halvorsen",
      meta: "Waiting since 10:40",
      signal: true,
    },
    {
      key: "scout",
      lead: <AgentFace avatar={SCOUT.avatar} state="idle" size={20} live={false} />,
      text: "Review the Q3 forecast Scout finished",
      meta: "25 min ago",
    },
    {
      key: "atlas",
      lead: <SquarePen className="size-4.5 text-muted-foreground" aria-hidden="true" />,
      text: "Continue: Atlas launch plan",
      meta: "Edited today",
    },
  ];
  return (
    <ul className={cn("flex flex-col", className)} aria-label="Suggestions">
      {rows.map((row) => (
        <li key={row.key}>
          <Pressable kind="row" className="group h-10 gap-3 px-4 py-0 text-body coarse:h-12">
            <span className="flex size-5 shrink-0 items-center justify-center">{row.lead}</span>
            <span className="min-w-0 flex-1 truncate text-foreground">{row.text}</span>
            <span className={cn("hidden shrink-0 text-ui sm:inline", row.signal ? "text-warning" : "text-muted-foreground")}>
              {row.meta}
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
          </Pressable>
        </li>
      ))}
    </ul>
  );
}

export function HomeScene({ direction }: { direction: DirectionId }) {
  const airy = direction === "meridian";
  return (
    <AppFrame direction={direction} place="home">
      <main className="app-main-canvas flex flex-1 flex-col">
        <div className={cn("page-gutter flex flex-1 flex-col justify-center py-10", airy ? "md:pb-[16vh] md:pt-16" : "md:pb-[14vh] md:pt-12")}>
          <div className="dir-column">
            <h1 className={cn(airy ? "text-display" : "text-page-title", "text-foreground")}>Good afternoon, {ACCOUNT.first}</h1>
            <DraftComposer className={airy ? "mt-8" : "mt-6"}>
              <DraftSentence />
            </DraftComposer>
            <Suggestions className={airy ? "-mx-px mt-6" : "-mx-px mt-4"} />
          </div>
        </div>
      </main>
    </AppFrame>
  );
}

/* ————————————————————————————————————————————————————————————————————————
 * 2. Thread: a conversation with a task and an approval in it.
 * ———————————————————————————————————————————————————————————————————— */

const AT = "2026-09-30T13:12:00.000Z";
const NO_ARTIFACTS = new Map<string, ClientArtifact>();
const noop = () => {};

const ANSWER_MESSAGE: ChatMessage = {
  id: "dir-a1",
  role: "ASSISTANT",
  content: ANSWER,
  createdAt: AT,
  attachments: [],
  conversationId: "dir-thread",
  model: "claude-opus-5-5",
};

const FOLLOW_UP: ChatMessage = {
  id: "dir-u2",
  role: "USER",
  content: "Post the summary to #design in Slack, then draft a note to Halvorsen's finance lead.",
  createdAt: AT,
  attachments: [],
  conversationId: "dir-thread",
};

export function ThreadScene({ direction }: { direction: DirectionId }) {
  return (
    <AppFrame direction={direction} place="thread" title={THREAD_TITLE}>
      <header className="sticky top-0 z-20 hidden h-14 items-center justify-between gap-4 bg-background px-6 lg:flex">
        <h1 className="truncate text-nav font-medium text-foreground">{THREAD_TITLE}</h1>
        <IconButton variant="ghost" size="sm" label="Share">
          <Share2 className="size-4" aria-hidden="true" />
        </IconButton>
      </header>
      <main className="app-main-canvas page-gutter flex-1">
        <div role="log" aria-label="Conversation" className="dir-column dir-turns pb-10 pt-6 lg:pt-4">
          <TokenUserTurn>
            <DraftSentence />
          </TokenUserTurn>
          <JunoTurn direction={direction}>
            <ActivityLine />
            <MessageItem
              message={ANSWER_MESSAGE}
              isLast={false}
              busy={false}
              artifactsByIdentifier={NO_ARTIFACTS}
              onOpenArtifact={noop}
              onRegenerate={noop}
              onFeedback={noop}
            />
          </JunoTurn>
          <TaskCard direction={direction} />
          <MessageItem
            message={FOLLOW_UP}
            isLast={false}
            busy={false}
            artifactsByIdentifier={NO_ARTIFACTS}
            onOpenArtifact={noop}
            onFeedback={noop}
          />
          <JunoTurn direction={direction}>
            <ApprovalPanel />
            <ThinkingLine direction={direction} className="mt-5">
              Drafting the note to Halvorsen&apos;s finance lead
            </ThinkingLine>
          </JunoTurn>
        </div>
      </main>
      <div className="page-gutter sticky bottom-0 z-10 bg-background pb-4 pt-2">
        <div className="dir-column">
          <DraftComposer frame="dock" placeholder="Reply to Juno" />
        </div>
      </div>
    </AppFrame>
  );
}

/* ————————————————————————————————————————————————————————————————————————
 * 3. Menus: the @ palette and the model popover, each open over a composer.
 * ———————————————————————————————————————————————————————————————————— */

function Stage({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-[44rem] flex-col border-border p-4 sm:p-8 lg:min-h-dvh lg:border-r lg:last:border-r-0">
      <h2 className="text-label font-medium text-muted-foreground">{caption}</h2>
      <div className="mt-auto w-full">{children}</div>
    </section>
  );
}

export function MenusScene({ direction }: { direction: DirectionId }) {
  return (
    <main className="app-main-canvas grid min-h-dvh grid-cols-1 lg:grid-cols-2">
      <Stage caption="Mention palette">
        <DraftComposer frame="dock" above={<MentionPalette />}>
          Ask <span className="text-primary">@</span>
        </DraftComposer>
      </Stage>
      <Stage caption="Model">
        <DraftComposer frame="dock" modelOpen popover={<ModelPopover direction={direction} />}>
          Compare <ContextToken kind="file" name="Q3 Forecast.xlsx" /> with <ContextToken kind="app" name="Stripe" />
        </DraftComposer>
      </Stage>
    </main>
  );
}

/* ————————————————————————————————————————————————————————————————————————
 * 4. Crew: the roster, and a member's header with every presence state.
 * ———————————————————————————————————————————————————————————————————— */

function RosterRow({ member }: { member: CrewMember }) {
  const presence = PRESENCE[member.presence];
  const waiting = member.presence === "waiting";
  return (
    <li>
      <button
        type="button"
        className="group -mx-3 grid w-[calc(100%+1.5rem)] grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 rounded-control px-3 py-3 text-left transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none sm:grid-cols-[2.5rem_minmax(0,14rem)_minmax(0,1fr)_auto]"
        aria-label={`${member.name}, ${member.role}. ${presence.label}. ${member.now}`}
      >
        <span className={cn("row-span-2 flex size-10 items-center justify-center sm:row-span-1", member.presence === "offline" && "dir-face-offline")}>
          <AgentFace avatar={member.avatar} state={presence.face} size={32} live={false} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-body font-medium text-foreground">{member.name}</span>
          <span className="block truncate text-ui text-muted-foreground">{member.role}</span>
        </span>
        <span className={cn("col-start-2 flex min-w-0 items-center gap-1.5 text-ui sm:col-start-3", waiting ? "text-warning" : "text-muted-foreground")}>
          {waiting && <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />}
          <span className="truncate">{member.now}</span>
        </span>
        <ArrowRight className="hidden size-4 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover:opacity-100 sm:block" aria-hidden="true" />
      </button>
    </li>
  );
}

export function CrewScene({ direction }: { direction: DirectionId }) {
  const airy = direction === "meridian";
  return (
    <AppFrame direction={direction} place="crew" title="Crew">
      <main className={cn("app-main-canvas page-gutter flex-1", airy ? "py-10 md:py-16" : "py-8 md:py-12")}>
        <div className="mx-auto w-full max-w-4xl">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-page-title text-foreground">Crew</h1>
              <p className="mt-1 text-body text-muted-foreground">Six members. Mira is waiting for you.</p>
            </div>
            <Button type="button" variant="secondary">
              <Plus className="size-4" aria-hidden="true" />
              Add to crew
            </Button>
          </header>

          <ul className={cn("divide-y divide-border", airy ? "mt-8" : "mt-6")} aria-label="Crew members">
            {CREW.map((member) => (
              <RosterRow key={member.id} member={member} />
            ))}
          </ul>

          <section aria-labelledby="dir-member" className={cn("border-t border-border", airy ? "mt-14 pt-12" : "mt-10 pt-10")}>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <div className="flex min-w-0 flex-1 items-start gap-5">
                <AgentFace avatar={MIRA.avatar} state="waiting" size={64} name="Mira" live={false} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <h2 id="dir-member" className="text-title text-foreground">
                    Mira
                  </h2>
                  <p className="text-body text-muted-foreground">Accounts. On your crew since 2 September.</p>
                  <p className="mt-2 flex items-start gap-1.5 text-body text-warning">
                    <TriangleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
                    Wants your answer on the Halvorsen renewal
                  </p>
                </div>
              </div>
              <div className="flex gap-2 sm:shrink-0">
                <Button type="button">Open thread</Button>
                <IconButton label="Setup">
                  <Settings2 className="size-4" aria-hidden="true" />
                </IconButton>
              </div>
            </div>

            <h3 className="mt-10 text-label font-medium text-muted-foreground">Presence</h3>
            <ul className="mt-3 grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-6" aria-label="Presence states">
              {PRESENCE_ORDER.map((p) => (
                <li key={p} className="flex flex-col items-start gap-2.5">
                  <span className={cn("flex size-12 items-center justify-center", p === "offline" && "dir-face-offline")}>
                    <AgentFace avatar={MIRA.avatar} state={PRESENCE[p].face} size={44} live={false} />
                  </span>
                  <span className={cn("text-ui", p === "waiting" ? "text-warning" : "text-foreground")}>{PRESENCE[p].label}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 max-w-prose text-ui text-muted-foreground">
              Every state is also said in words. Thinking, working and waiting move; available, paused and offline hold still.
            </p>
          </section>
        </div>
      </main>
    </AppFrame>
  );
}
