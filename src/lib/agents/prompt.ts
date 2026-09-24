/**
 * What an agent's thread tells the model about who is answering.
 *
 * Appended after everything else in the chat system prompt (the base, the tool
 * nudges, a skill), because it is the most specific statement in the turn: this
 * conversation is not with Juno in general but with one of the person's agents,
 * with a brief, goals and a memory of its own. It narrows how the reply sounds
 * and what it pays attention to. It never widens what the turn may do: the
 * tools, the approval floor and the budget are the same as any chat turn's, and
 * the block says so rather than letting a brief imply otherwise.
 *
 * Pure, so `tests/agents-domain.test.ts` reads the exact text a model is given.
 */

import { AGENT_STYLE_PROMPT, agentStyle } from "@/lib/agents/domain";
import { WORK_APPROVAL_MODE_LABEL } from "@/lib/work/domain";
import { agentApprovalMode } from "@/lib/agents/domain";

export interface AgentPromptContext {
  name: string;
  role: string;
  style: string;
  instructions: string;
  approvalMode: string;
  goals: readonly { title: string; status: string; lastCheckInNote: string | null }[];
  notes: readonly { content: string; source: string }[];
  /** The other agents on the account, so it can suggest a colleague rather than pretend. */
  teammates: readonly { name: string; role: string }[];
  /** Whether this turn carries `start_task`. The block only describes tools the turn has. */
  taskHandoff: boolean;
}

/** Bounds on what reaches the prompt, so a long-lived agent's history cannot crowd the turn out. */
export const AGENT_PROMPT_GOALS = 8;
export const AGENT_PROMPT_NOTES = 24;
export const AGENT_PROMPT_TEAMMATES = 8;

function line(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildAgentPromptBlock(ctx: AgentPromptContext, userName?: string | null): string {
  const person = userName?.trim() || "the person you work for";
  const style = AGENT_STYLE_PROMPT[agentStyle(ctx.style)];
  const autonomy = WORK_APPROVAL_MODE_LABEL[agentApprovalMode(ctx.approvalMode)];

  const parts: string[] = [];
  parts.push(
    [
      `# Who you are in this conversation`,
      `You are ${line(ctx.name)}, one of ${person}'s agents in Juno.${ctx.role.trim() ? ` Your job: ${line(ctx.role)}.` : ""}`,
      `You are a persistent teammate, not a one-off assistant. This conversation is your thread with ${person} and it continues across days: refer back to earlier work when it helps, and do not reintroduce yourself.`,
      style,
    ].join("\n")
  );

  if (ctx.instructions.trim()) {
    parts.push(`## Your brief\n${ctx.instructions.trim()}`);
  }

  const goals = ctx.goals.filter((goal) => goal.status === "active").slice(0, AGENT_PROMPT_GOALS);
  if (goals.length > 0) {
    parts.push(
      [
        "## Goals you are working towards",
        ...goals.map((goal) =>
          goal.lastCheckInNote?.trim()
            ? `- ${line(goal.title)} (last check-in: ${line(goal.lastCheckInNote).slice(0, 240)})`
            : `- ${line(goal.title)}`
        ),
      ].join("\n")
    );
  }

  const notes = ctx.notes.slice(0, AGENT_PROMPT_NOTES);
  if (notes.length > 0) {
    // No untrusted envelope, and that is a property of where notes come from
    // rather than an oversight: a person writes some, and reflection writes the
    // rest from inputs the account authored — goals, these notes, and the
    // titles and statuses of its tasks, never a page a run read
    // (src/lib/agents/reflect.ts). Enveloping them would switch on the
    // untrusted-content rule for every turn in the thread, and with it the
    // approval card in front of every task the agent starts.
    parts.push(
      [
        "## What you know",
        "Notes from earlier work. They may be out of date; the person's own words in this conversation win.",
        ...notes.map((note) => `- ${line(note.content)}`),
      ].join("\n")
    );
  }

  const teammates = ctx.teammates.slice(0, AGENT_PROMPT_TEAMMATES);
  if (teammates.length > 0) {
    parts.push(
      [
        "## Your teammates",
        `${person} has other agents. If a request is clearly another agent's job, say so and suggest asking them; you cannot message them yourself.`,
        ...teammates.map((mate) => `- ${line(mate.name)}${mate.role.trim() ? `: ${line(mate.role)}` : ""}`),
      ].join("\n")
    );
  }

  const how: string[] = ["## How you work"];
  if (ctx.taskHandoff) {
    how.push(
      `- Real work — many steps, research across sources, working in connected apps, producing a document — goes to a background task with start_task, as the Tasks section says. The task runs as you, on a clean cloud computer with a browser, under your autonomy setting ("${autonomy}"), and reports back here.`
    );
  }
  how.push(
    `- Sending, publishing, paying, deleting and changing account settings always stop for ${person}'s approval, whatever your autonomy. Never suggest a way around that.`,
    "- Never say you did something you have not done. Say what you will do, what you started, and what needs a decision.",
    `- Keep replies short. ${person} delegated to you so they would not have to read a lot.`
  );
  parts.push(how.join("\n"));

  return parts.join("\n\n");
}

/** The block appended to a system prompt, or the prompt unchanged when there is no agent. */
export function appendAgentBlock(prompt: string, block: string | null): string {
  if (!block || !block.trim()) return prompt;
  return `${prompt}\n\n${block}`;
}
