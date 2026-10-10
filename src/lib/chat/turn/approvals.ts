import "server-only";
import type { Plan } from "@prisma/client";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { providerAdapterFor } from "@/lib/provider-routing";
import { isGemini3OrLater } from "@/lib/gemini-core";
import { cheapestWorkModel } from "@/lib/work/models";
import { agentChatContext } from "@/lib/agents/store";
import type { RoomTurnSetup } from "@/lib/agents/room-store";
import { narrowRuntimeToolsForSkill } from "@/lib/chat/skills";
import { START_TASK_TOOL_ID, chatTaskToolEnabled, isTaskApproval } from "@/lib/chat/task-tool";
import { HAND_OFF_TOOL_ID, isHandoffApproval } from "@/lib/chat/handoff-tool";
import { chatAgentConfigToolsEnabled } from "@/lib/chat/agent-config-tools";
import { LOCAL_FOLDER_FEATURE, localFolderToolsEnabled } from "@/lib/chat/local-folder";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { SseSender } from "@/lib/chat-stream";
import type { StallWatchdog } from "@/lib/chat-stall";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { TurnSettings } from "./account";
import type { TurnSkill } from "./skills";
import type { TurnUser } from "./types";

/*
 * Pipeline stage — resolveApprovals: which acting tools this turn may carry
 * (start a task, hand off to a teammate, change an agent's setup) and the
 * agent whose autonomy governs them. These are deterministic gates over the
 * plan, the model's verified tool calling, lockdown and the turn's shape; the
 * model decides whether to call a tool, never whether it may. Every call that
 * acts still goes through the action broker's approval (action-approval.ts),
 * whose card the reader answers — `createApprovalRequester` is the one path
 * those requests reach the stream by.
 */
export async function resolveApprovals({
  user,
  input,
  plan,
  settings,
  modelInfo,
  useWebSearch,
  useProMode,
  researchActive,
  userMessageId,
  artifactEdit,
  conversation,
  roomSetup,
  appliedSkill,
}: {
  user: TurnUser;
  input: ChatRequestBody;
  plan: Plan;
  settings: TurnSettings;
  modelInfo: ModelInfo;
  useWebSearch: boolean;
  useProMode: boolean;
  researchActive: boolean;
  userMessageId: string | null;
  artifactEdit: boolean;
  conversation: { id: string; kind: string; agentId: string | null };
  roomSetup: RoomTurnSetup | null;
  appliedSkill: TurnSkill["appliedSkill"];
}) {
  /*
   * Whether the model may hand this request to a background task.
   *
   * The model decides whether to; this decides whether it can. The rule and
   * the reason for each condition are on `chatTaskToolEnabled`. Decided before
   * the prompt is built because the Tasks section rides the same flag: the
   * section without the tool is an instruction to call something absent, and
   * the tool without the section is a tool with no rules for when to use it.
   */
  const taskGate = {
    workHandoff: input.workHandoff,
    privateMode: !!input.privateMode,
    voiceMode: !!input.voiceMode,
    regenerate: !!input.regenerate,
    userMessageId,
    researchActive,
    artifactEdit,
    conversationKind: conversation.kind,
    agenticTools: modelInfo.agenticTools,
    functionToolsReachModel: !(
      useWebSearch &&
      providerAdapterFor(modelInfo, useProMode) === "gemini-native" &&
      !isGemini3OrLater(modelInfo)
    ),
    lockdown: !!settings?.lockdownMode,
    planHasWorkModel: cheapestWorkModel(MODEL_LIST, plan) !== null,
  };
  const taskToolOn = chatTaskToolEnabled({
    ...taskGate,
    skillPermits: narrowRuntimeToolsForSkill([START_TASK_TOOL_ID], appliedSkill).length > 0,
  });
  /*
   * Whether an agent may hand this request to a teammate
   * (src/lib/chat/handoff-tool.ts). The same gate as a task, because a handoff
   * IS a task, on another agent; a skill that lists its tools can leave this
   * one out on its own. The agent context below adds the last condition, a
   * teammate to hand to, and says whether the turn carries it.
   */
  const handoffGateOpen = chatTaskToolEnabled({
    ...taskGate,
    skillPermits: narrowRuntimeToolsForSkill([HAND_OFF_TOOL_ID], appliedSkill).length > 0,
  });
  const agentConfigToolsOn = chatAgentConfigToolsEnabled({
    ...taskGate,
    skillPermits: true,
  });
  /*
   * An agent's thread (docs/design/AGENTS.md): the reply is the agent's, with
   * its brief, goals and notes appended after everything else in the prompt,
   * and a task it starts carries its id and its autonomy. A private turn never
   * has one (it has no saved conversation to be a thread), and a failure to
   * read the agent answers as Juno rather than failing the message — the
   * thread is still a chat.
   */
  /** The agent answering: the thread's, or in a room the member picked for this turn. */
  const turnAgentId = roomSetup ? roomSetup.speaker.agentId : conversation.agentId;
  const agentContext =
    turnAgentId && !input.privateMode
      ? await agentChatContext(user, turnAgentId, {
          taskHandoff: taskToolOn,
          handoff: handoffGateOpen,
        }).catch((err) => {
          console.error("[chat] could not read the thread's agent", {
            conversationId: conversation.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        })
      : null;

  /*
   * The folder on the person's Mac (src/lib/chat/local-folder.ts): whether
   * this turn carries the folder tools, and the folder it names. Not narrowed
   * by an applied skill: the folder is a choice the person made in the
   * composer for this chat, as a connector is, not a tool the model reached
   * for.
   */
  const localFolderOn = localFolderToolsEnabled({
    clientDeclares: input.clientFeatures?.includes(LOCAL_FOLDER_FEATURE) ?? false,
    folder: input.localFolder,
    privateMode: !!input.privateMode,
    voiceMode: !!input.voiceMode,
    lockdown: !!settings?.lockdownMode,
    functionToolsReachModel: taskGate.functionToolsReachModel,
    agenticTools: !!modelInfo.agenticTools,
    conversationKind: conversation.kind,
    artifactEdit,
    researchActive,
    skillPermits: true,
  });
  const localFolder = localFolderOn ? (input.localFolder ?? null) : null;

  return { taskGate, taskToolOn, handoffGateOpen, agentConfigToolsOn, turnAgentId, agentContext, localFolder };
}

export type TurnApprovals = Awaited<ReturnType<typeof resolveApprovals>>;

/**
 * One callback for every approval this turn raises, connector calls and
 * task handoffs alike, so both pause the watchdog and reach the card the
 * same way.
 */
export function createApprovalRequester(
  stallWatchdog: Pick<StallWatchdog, "pause">,
  send: SseSender["send"],
  sendActivity: SseSender["sendActivity"],
  onApproval?: (approval: ClientActionApproval) => void
) {
  return (approval: ClientActionApproval) => {
    onApproval?.(approval);
    // The tool loop is now blocked on a person, not the provider:
    // stop the idle clock until the result event re-arms it.
    stallWatchdog.pause();
    const task = isTaskApproval(approval);
    const handoff = isHandoffApproval(approval);
    sendActivity({
      kind: "tool",
      title: task
        ? "Starting a task needs your approval"
        : handoff
          ? "Handing off needs your approval"
          : `${approval.connectorLabel} needs approval`,
      detail:
        (task || handoff) && typeof approval.detail.title === "string" ? approval.detail.title : approval.preview,
    });
    send({ type: "approval", approval });
  };
}
