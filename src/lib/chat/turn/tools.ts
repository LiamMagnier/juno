import "server-only";
import type { Plan } from "@prisma/client";
import { canUseModel } from "@/lib/plans";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { modelToolCallingVerdict, type loadModelCapabilityMap } from "@/lib/model-capability";
import { supportsProMode } from "@/lib/model-metrics";
import type { NativeChatTool } from "@/lib/llm";
import { executionEntitlements } from "@/lib/tools/entitlements";
import { openGrantedProviders, providerAvailability, toolProviders } from "@/lib/tools/providers";
import type { ToolTurn } from "@/lib/tools/types";
import { codeExecutionNote } from "@/lib/chat/prompt-sections";
import { narrowRuntimeToolsForSkill } from "@/lib/chat/skills";
import { createStartTaskTool } from "@/lib/chat/task-tool";
import { createHandoffTool } from "@/lib/chat/handoff-tool";
import { createAgentConfigTools } from "@/lib/chat/agent-config-tools";
import { createSetupChangeTool } from "@/lib/chat/setup-change-tool";
import { createAskRoomMemberTool, createCreateRoomTool } from "@/lib/chat/room-tools";
import { isAgentComputerConfigured } from "@/lib/computer/provider";
import { agentApprovalMode } from "@/lib/agents/domain";
import type { RoomTurnSetup } from "@/lib/agents/room-store";
import type { WorkspaceConfig } from "@/lib/projects/workspace-config";
import type { ActiveConnector } from "@/lib/mcp";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { SseSender } from "@/lib/chat-stream";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { ReasoningEffort } from "@/types/chat";
import type { TurnSettings } from "./account";
import type { TurnApprovals } from "./approvals";
import { roomMayAsk } from "./identity";
import type { TurnSkill } from "./skills";
import type { TurnUser } from "./types";

/*
 * Pipeline stage — resolveTools: the execution and skill tools this turn is
 * granted (from the model's VERIFIED tool calling, never its claim), and the
 * native acting tools (`buildNativeTools`) the approvals stage opened.
 */
export async function resolveTools({
  user,
  input,
  plan,
  settings,
  modelInfo,
  capabilityProbes,
  useProMode,
  generationId,
  conversation,
  appliedSkill,
  artifactEdit,
  workspaceConfig,
  functionToolsReachModel,
  attachmentToolToggles,
}: {
  user: TurnUser;
  input: ChatRequestBody;
  plan: Plan;
  settings: TurnSettings;
  modelInfo: ModelInfo;
  capabilityProbes: Awaited<ReturnType<typeof loadModelCapabilityMap>>;
  useProMode: boolean;
  generationId: string;
  conversation: { id: string; projectId: string | null };
  appliedSkill: TurnSkill["appliedSkill"];
  artifactEdit: boolean;
  workspaceConfig: WorkspaceConfig;
  functionToolsReachModel: boolean;
  /** Mutated: the legacy code interpreter is an execution tool (verified models only). */
  attachmentToolToggles: { documents: boolean; code: boolean; images: boolean };
}) {
  const taskGate = { functionToolsReachModel };
  /*
   * ── Execution and skill tools ─────────────────────────────────────────────
   *
   * Which of `run_code`, `check_run`, `use_skill` and `read_skill_file` this
   * turn carries, from one table of rows keyed to the providers that serve
   * them (src/lib/tools/entitlements.ts), and what the model is told when it
   * carries none. The decisive fact is the model's VERIFIED tool calling
   * (the round-trip probe's evidence on the capability row): an untested
   * model gets no execution tool, only a plain-language note, so it never
   * writes code and implies it ran. The legacy `code_interpreter` is gated
   * the same way. No provider is installed until the execution and skill
   * lanes land, so today every turn gets the note and no execution tool.
   */
  const toolCallingVerdict = modelToolCallingVerdict(modelInfo, capabilityProbes, new Date(), { proMode: useProMode });
  const installedToolProviders = toolProviders();
  const toolTurn: ToolTurn = {
    userId: user.id,
    surface: input.voiceMode ? "voice" : "chat",
    sessionId: generationId,
    conversationId: conversation.id,
    projectId: conversation.projectId,
    plan,
    modelId: modelInfo.id,
    vision: modelInfo.vision,
    // The skill that actually APPLIED, never the raw slug the request named:
    // a blocked, unscanned or consent-pending skill is not armed, and the
    // providers must not be told it is.
    skillSlug: appliedSkill?.candidate.slug ?? null,
  };
  const execution = executionEntitlements({
    plan,
    private: false,
    lockdown: !!settings?.lockdownMode,
    artifactEdit,
    workspaceRestrictsTools: workspaceConfig.allowedTools !== undefined,
    toolsReachModel: taskGate.functionToolsReachModel,
    modelVerdict: toolCallingVerdict,
    providers: installedToolProviders.length > 0 ? await providerAvailability(installedToolProviders, toolTurn) : {},
    legacySandboxConfigured: attachmentToolToggles.code,
  });
  // The old code tool is an execution tool: a verified model only.
  attachmentToolToggles.code = execution.legacyCodeInterpreter;
  // A skill narrows the grant and can never widen it, as it does every tool.
  const executionGrant = {
    exec: narrowRuntimeToolsForSkill(execution.granted.exec, appliedSkill),
    skills: narrowRuntimeToolsForSkill(execution.granted.skills, appliedSkill),
  };
  const toolProviderSessions =
    executionGrant.exec.length + executionGrant.skills.length > 0
      ? await openGrantedProviders(installedToolProviders, toolTurn, executionGrant)
      : null;
  const verifiedAlternatives =
    execution.codeExecution === "unverified_model"
      ? MODEL_LIST.filter(
          (candidate) =>
            candidate.modality === "chat" &&
            candidate.status === "current" &&
            !candidate.comingSoon &&
            candidate.id !== modelInfo!.id &&
            isProviderConfigured(candidate.provider) &&
            canUseModel(plan, candidate.id) &&
            modelToolCallingVerdict(candidate, capabilityProbes, new Date(), {
              proMode: useProMode && supportsProMode(candidate),
            }) === "verified",
        ).map((candidate) => candidate.name)
      : [];
  const executionSections =
    toolProviderSessions && toolProviderSessions.specs.length > 0
      ? toolProviderSessions.promptSections
      : [codeExecutionNote(execution.codeExecution, verifiedAlternatives)].filter((note): note is string => !!note);

  return { toolProviderSessions, executionSections };
}

export type TurnTools = Awaited<ReturnType<typeof resolveTools>>;

/**
 * The native acting tools this turn carries: `start_task`, `hand_off_to_teammate`,
 * the agent configuration tools, setup-by-conversation and the room tools.
 * Built inside the stream because each reports through it.
 */
export async function buildNativeTools({
  user,
  input,
  conversationId,
  conversation,
  userMessageId,
  approvals: { taskToolOn, agentConfigToolsOn, agentContext },
  appliedSkill,
  conversationModelId,
  requestedEffort,
  contextAttachmentIds,
  activeConnectors,
  untrustedContentInTurn,
  allAttachments,
  generationId,
  requestApproval,
  send,
  sendActivity,
  roomSetup,
  roomMessageId,
  clarificationVisibleContent,
  preflightVisibleContent,
}: {
  user: TurnUser;
  input: ChatRequestBody;
  conversationId: string;
  conversation: { projectId: string | null };
  userMessageId: string | null;
  approvals: Pick<TurnApprovals, "taskToolOn" | "agentConfigToolsOn" | "agentContext">;
  appliedSkill: TurnSkill["appliedSkill"];
  conversationModelId: string;
  requestedEffort: ReasoningEffort | undefined;
  contextAttachmentIds: string[];
  activeConnectors: ActiveConnector[];
  untrustedContentInTurn: boolean;
  allAttachments: readonly unknown[];
  generationId: string;
  requestApproval: (approval: ClientActionApproval) => void;
  send: SseSender["send"];
  sendActivity: SseSender["sendActivity"];
  roomSetup: RoomTurnSetup | null;
  roomMessageId: string | null;
  clarificationVisibleContent: string | null;
  preflightVisibleContent: string | null;
}): Promise<NativeChatTool[]> {
  let taskAnnounced = false;
  const taskTool =
    taskToolOn && !agentContext?.paused && userMessageId
      ? createStartTaskTool({
          user,
          conversation: { id: conversationId, projectId: conversation.projectId },
          userMessageId,
          userRequest: clarificationVisibleContent ?? preflightVisibleContent ?? input.message?.trim() ?? "",
          skillSlug: appliedSkill?.candidate.slug ?? null,
          model: conversationModelId,
          reasoningEffort: requestedEffort,
          attachmentIds: [...(input.attachmentIds ?? []), ...contextAttachmentIds],
          connectorIds: activeConnectors.map((connector) => connector.id),
          // Wider than the memory rule's flag: any file in the window
          // counts, pictures included. A screenshot of an email reaches a
          // vision model as pixels with no envelope around them, and
          // starting a task is the one tool whose whole effect is to act
          // later with nobody watching, so it asks first.
          untrustedContent: untrustedContentInTurn || allAttachments.length > 0,
          agent: agentContext
            ? {
                id: agentContext.agent.id,
                approvalMode: agentApprovalMode(agentContext.agent.approvalMode),
                status: agentContext.agent.status,
              }
            : null,
          generationId,
          onApprovalRequest: requestApproval,
          // The panel appears as soon as the run exists rather than on the
          // client's next discovery poll. Once per generation.
          onStarted: (session) => {
            if (taskAnnounced) return;
            taskAnnounced = true;
            send({ type: "work", session });
          },
        })
      : null;
  // No `onStarted` here, on purpose: the task a handoff starts lives in the
  // teammate's thread, and announcing it would pull it into this one's panel.
  const handoffTool =
    agentContext?.handoff && userMessageId
      ? createHandoffTool({
          user,
          conversation: { id: conversationId, projectId: conversation.projectId },
          fromAgent: {
            id: agentContext.agent.id,
            name: agentContext.agent.name,
            status: agentContext.agent.status,
          },
          userMessageId,
          userRequest: clarificationVisibleContent ?? preflightVisibleContent ?? input.message?.trim() ?? "",
          // The same reading as the task's: any file in the window counts.
          untrustedContent: untrustedContentInTurn || allAttachments.length > 0,
          generationId,
          onApprovalRequest: requestApproval,
        })
      : null;
  const agentConfigTools =
    agentConfigToolsOn && userMessageId
      ? createAgentConfigTools({
          user,
          conversation: { id: conversationId, projectId: conversation.projectId },
          agent: agentContext
            ? {
                id: agentContext.agent.id,
                name: agentContext.agent.name,
                role: agentContext.agent.role,
                style: agentContext.agent.style,
                instructions: agentContext.agent.instructions,
                approvalMode: agentContext.agent.approvalMode,
                notify: (agentContext.agent as { notify?: string | null }).notify ?? "results",
                proactive: agentContext.agent.proactive,
                status: agentContext.agent.status,
                model: agentContext.agent.model,
                reasoningEffort: agentContext.agent.reasoningEffort,
                connectorIds: agentContext.agent.connectorIds,
              }
            : null,
          userMessageId,
          untrustedContent: untrustedContentInTurn,
          timeZone: input.timeZone,
          generationId,
          onApprovalRequest: requestApproval,
          onAgentChange: (change) => {
            sendActivity({
              kind: "tool",
              title: change.summary,
              agentChange: change,
            });
          },
          // Off, no declaration mentions a computer (PRODUCT_REFOUNDATION §7).
          computerConfigured: await isAgentComputerConfigured().catch(() => false),
        })
      : [];
  // Setup by conversation (src/lib/chat/setup-change-tool.ts): only in a
  // crew member's own thread, on the same gate as the other config tools.
  const setupChangeTool =
    agentConfigToolsOn && userMessageId && agentContext && !agentContext.paused
      ? createSetupChangeTool({
          user,
          conversation: { id: conversationId, projectId: conversation.projectId },
          agent: { id: agentContext.agent.id, name: agentContext.agent.name },
          userMessageId,
          untrustedContent: untrustedContentInTurn,
          timeZone: input.timeZone,
          generationId,
          onApprovalRequest: requestApproval,
          onAgentChange: (change) => {
            sendActivity({
              kind: "tool",
              title: change.summary,
              agentChange: change,
            });
          },
        })
      : null;
  // Rooms (src/lib/agents/rooms.ts). `create_room` rides the same gate as
  // the configuration tools; `ask_room_member` is offered only to a room's
  // answering member, and the store holds the cap and the loop guard.
  const createRoomTool =
    agentConfigToolsOn && userMessageId
      ? createCreateRoomTool({
          user,
          untrustedContent: untrustedContentInTurn,
          onReceipt: (change, url) => {
            sendActivity({ kind: "tool", title: change.summary, url, agentChange: change });
          },
        })
      : null;
  const askRoomMemberTool =
    roomSetup && roomMessageId && agentContext && !agentContext.paused && roomMayAsk(roomSetup, roomMessageId)
      ? createAskRoomMemberTool({
          user,
          conversationId,
          userMessageId: roomMessageId,
          self: { agentId: roomSetup.speaker.agentId, name: roomSetup.speaker.name },
          members: roomSetup.room.members,
          untrustedContent: untrustedContentInTurn || allAttachments.length > 0,
          onAsked: (sentence) => {
            sendActivity({ kind: "tool", title: sentence });
          },
        })
      : null;
  const nativeTools = [
    taskTool,
    handoffTool,
    ...agentConfigTools,
    setupChangeTool,
    createRoomTool,
    askRoomMemberTool,
  ].filter(
    (tool): tool is NativeChatTool => tool !== null
  );
  return nativeTools;
}
