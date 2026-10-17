import {
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_PERMISSION_POLICIES,
  narrowestPolicy,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";

/*
 * HOW OFTEN A TASK STARTED FROM A CHAT STOPS TO ASK.
 *
 * A task the chat model starts (`start_task`, src/lib/chat/task-tool.ts) runs
 * as a Work session, and Work already has the three modes and enforces them
 * server side: `approvalRuling` decides what asks under each, the dispatcher
 * meets the session's mode with its project's (`resolveSessionFields`), and an
 * attended run under "Ask before every change" parks on its plan before it
 * acts (`confirmPlanBeforeActing`). What a chat could not do was choose: every
 * model-started task ran as the default, so the plan review and the hands-off
 * mode were both unreachable from the place most tasks start.
 *
 * So the chat composer offers the same three modes, in the same words, saved
 * on the conversation (`Conversation.taskApprovalMode`). No new mode is
 * invented here. A "plan only" mode would need a fourth wire value in a
 * vocabulary four clients decode; the plan gate that exists is the
 * conservative mode's, so that is the mode the chat names as the one that
 * shows the plan first (`CHAT_TASK_MODE_NOTE`).
 *
 * Pure, so the composer, the route and the task tool read one rule.
 */

export const CHAT_TASK_MODES = WORK_PERMISSION_POLICIES;
export type ChatTaskMode = WorkPermissionPolicy;

const MODES = new Set<string>(WORK_PERMISSION_POLICIES);

/** A stored or requested value, or null when it is not one of the three. */
export function parseChatTaskMode(value: unknown): ChatTaskMode | null {
  return typeof value === "string" && MODES.has(value) ? (value as ChatTaskMode) : null;
}

/**
 * The mode a task started from this chat is created with.
 *
 *  - No choice and no agent: the default every composed task gets.
 *  - An agent's thread: the autonomy somebody gave that agent on its page is a
 *    decision, so it holds; a choice in the composer may only narrow it.
 *  - A choice: that mode.
 *
 * The project is not met here because the dispatcher already meets every
 * session with its project's mode; doing it twice would hide which layer
 * narrowed it. `describeChatTaskMode` reports the project's part for display.
 */
export function chatTaskPolicy(input: {
  chosen: ChatTaskMode | null | undefined;
  agentMode?: ChatTaskMode | null;
}): ChatTaskMode {
  const chosen = input.chosen ?? null;
  if (input.agentMode) return chosen ? narrowestPolicy(input.agentMode, chosen) : input.agentMode;
  return chosen ?? DEFAULT_WORK_PERMISSION_POLICY;
}

/**
 * The extra sentence the chat menu adds under a mode, where the chat behaves
 * differently from what the shared summary says. Only the conservative mode
 * has one: a chat task is attended, so under it the run shows its plan first.
 */
export const CHAT_TASK_MODE_NOTE: Partial<Record<ChatTaskMode, string>> = {
  conservative: "You see the plan before it starts.",
};

export interface ChatTaskModeView {
  /** What the conversation stores; null follows the default. */
  chosen: ChatTaskMode | null;
  /** What a task started now would run as, after the agent and the project. */
  effective: ChatTaskMode;
  /**
   * The layer that made `effective` stricter than the choice, if one did. The
   * words for it are written in the composer (task-mode-chip.tsx), not here:
   * a sentence assembled on the server with a name and a label in it would
   * reach the translation catalog as nothing, and stay English for everyone.
   */
  narrowedBy: "project" | "agent" | null;
}

/** What the composer shows: the choice, what it will actually run as, and why. */
export function describeChatTaskMode(input: {
  chosen: ChatTaskMode | null;
  agentMode?: ChatTaskMode | null;
  projectMode?: ChatTaskMode | null;
}): ChatTaskModeView {
  const requested = input.chosen ?? DEFAULT_WORK_PERMISSION_POLICY;
  const afterAgent = chatTaskPolicy({ chosen: input.chosen, agentMode: input.agentMode });
  const effective = narrowestPolicy(afterAgent, input.projectMode ?? null);
  // The project is asked first: when both are stricter than the choice, the
  // mode a task runs as is the project's, and that is the one to name.
  let narrowedBy: ChatTaskModeView["narrowedBy"] = null;
  if (effective !== afterAgent) narrowedBy = "project";
  // An agent's own wider mode with nobody choosing narrows nothing: that is
  // the agent's decision holding, not a choice being overruled.
  else if (input.agentMode && input.chosen && afterAgent !== requested) narrowedBy = "agent";
  return { chosen: input.chosen, effective, narrowedBy };
}
