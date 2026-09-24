"use client";

import * as React from "react";
import Link from "next/link";
import { AgentFace } from "@/components/agents/agent-face";
import { localStateSentence } from "@/components/agents/agent-bits";
import { deriveAgentState, type AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import type { ClientWorkSession } from "@/lib/work/serializers";

/**
 * What the face in a thread shows, from what the chat view already knows.
 *
 * No poll of its own: the chat view follows this thread's task
 * (`useConversationWork`) and knows when a reply is streaming, which are the
 * two facts the face needs. A streaming reply is `thinking`; otherwise the
 * state is derived from the task exactly as the server derives it for the
 * roster (`deriveAgentState`), so the thread and the roster cannot disagree.
 */
export function threadAgentState(
  agent: ClientAgent,
  busy: boolean,
  session: ClientWorkSession | null
): AgentState {
  if (busy) return "thinking";
  // Until the thread's task is discovered (a poll away), the server's read stands.
  if (!session) return agent.state;
  return deriveAgentState({
    status: agent.status,
    task: {
      sessionId: session.id,
      title: session.title,
      status: session.status,
      needsAttention: session.needsAttention,
      lastActivityAt: new Date(session.lastActivityAt),
    },
    now: new Date(),
  });
}

/**
 * The one row an agent's thread gains (docs/design/AGENTS.md §5.3): the face,
 * the name, what it is doing in words, and the way to its page. Chrome, so it
 * may carry a hairline; the transcript under it stays flat.
 */
export function AgentThreadHeader({
  agent,
  state,
  taskTitle,
}: {
  agent: ClientAgent;
  state: AgentState;
  taskTitle: string | null;
}) {
  const sentence =
    state === "thinking"
      ? "Thinking"
      : localStateSentence(
          taskTitle ? { ...agent, task: agent.task ? { ...agent.task, title: taskTitle } : agent.task } : agent,
          state
        );
  return (
    <div className="flex shrink-0 justify-center border-b border-border/70 px-4 py-2">
      <div className="flex w-full max-w-3xl items-center gap-3">
        <Link href={`/agents/${agent.id}`} data-face-trigger className="shrink-0 rounded-full" aria-label={`${agent.name}'s page`}>
          <AgentFace avatar={agent.avatar} state={state} size="sm" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium text-foreground">{agent.name}</p>
          <p className="truncate text-caption text-muted-foreground" aria-live="polite">
            {sentence}
          </p>
        </div>
        <Link
          href={`/agents/${agent.id}`}
          className="shrink-0 rounded-control px-2 py-1 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground coarse:py-2.5"
        >
          Agent page
        </Link>
      </div>
    </div>
  );
}

/** The empty thread greets in the agent's own voice, instead of Juno's. */
export function AgentGreeting({ agent }: { agent: ClientAgent }) {
  return (
    <div className="flex flex-col items-center text-center" data-face-trigger>
      <AgentFace avatar={agent.avatar} state={agent.status === "paused" ? "sleeping" : "idle"} size="lg" name={agent.name} />
      <h1 className="mt-5 font-serif text-display text-foreground">
        Hi, I’m <span className="italic">{agent.name}</span>.
      </h1>
      <p className="mt-2 max-w-md text-body text-muted-foreground">
        {agent.status === "paused"
          ? "I’m paused. Resume me from my page to start something new."
          : agent.role
            ? `${agent.role}. What should I take on?`
            : "What should I take on?"}
      </p>
    </div>
  );
}
