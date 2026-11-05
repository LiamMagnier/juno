import "server-only";

import {
  authorizeExternalAction,
  completeExternalAction,
  type AuthorizeActionInput,
} from "@/lib/action-approval-store";
import type { ClientActionApproval } from "@/lib/action-approval";
import { actionPolicyFromSetting } from "@/lib/chat/app-approval-preview";
import { verifyState } from "@/lib/crypto";
import { getActiveConnectors, openMcpToolset, type ActiveConnector } from "@/lib/mcp";
import { prisma } from "@/lib/prisma";
import { checkProjectAccess } from "@/lib/project-collaboration";
import { parseWorkspaceConfig, workspacePermits, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import { createAlevrSearchTurn } from "@/lib/search/alevr/turn";
import { recordSpend } from "@/lib/spend";
import { recordToolInvocation, settleToolInvocation } from "@/lib/tool-audit";
import { executeToolBatch, type ToolBatchPorts } from "@/lib/tools/dispatch";
import { recordToolFees, type ToolFeeAccumulator } from "@/lib/tools/metering";
import { junoToolSpec } from "@/lib/tools/registry";
import { mcpConnectTimeoutMs } from "@/lib/tools/connector-tools";
import { openChatToolset } from "@/lib/tools/toolset";
import type { ChatToolset, ToolSpec } from "@/lib/tools/types";
import { getUserPlan } from "@/lib/usage";
import {
  composeVoiceToolset,
  spokenApprovalAllowed,
  voiceResultStatus,
  voiceResultText,
  voiceToolCallerOf,
  voiceToolDescriptors,
  voiceToolInstructions,
  voiceToolPlan,
  voiceToolSessionId,
  type VoiceToolCaller,
  type VoiceToolDescriptor,
  type VoiceToolResultStatus,
} from "@/lib/voice-tools";
import { chatSearchAvailable } from "@/lib/web/search";

/*
 * The voice relay's tools, on Juno's side (src/lib/voice-tools.ts says what a
 * call carries and why). Two things happen here, each for a relay that proved
 * itself with a callback token:
 *
 *   - listing: the call's toolset is opened as a chat turn's would be — the
 *     chat's entitlement table for this account, project and conversation, the
 *     registry's specs, the person's connectors resolved against their own
 *     rows — and described to the relay without a credential in it;
 *   - running: one call goes through the chat's dispatcher, whose broker port
 *     and connector chokepoint ask the approval broker exactly as a typed turn
 *     does. A pending approval is streamed out before the dispatcher blocks
 *     on it, so the relay can put the card up and the voice can ask.
 *
 * NOTHING HERE DECIDES AN APPROVAL. The relay can list and run, never answer:
 * a card is answered by the person's own signed-in client through the chat's
 * decision route (`/api/approvals/[id]`, digest-bound), whether they tapped it
 * or said yes aloud (the relay tells their client what it heard,
 * `tool.spoken`). A decision reaches Juno only from a signed-in person
 * (tests/permission-conformance.test.ts).
 *
 * Connector tokens stay where they always were: inside `ActiveConnector`
 * headers, read by the MCP transport and nothing else.
 */

/** One call, read from its callback token and the account's rows. */
export interface VoiceCall {
  caller: VoiceToolCaller;
  conversationId: string | null;
  projectId: string | null;
  workspace: WorkspaceConfig;
  plan: Awaited<ReturnType<typeof getUserPlan>>;
  lockdown: boolean;
  approvalPolicy: ReturnType<typeof actionPolicyFromSetting>;
  /** Connector ids the call may open: the conversation's and the call's, through the workspace's rules. */
  connectorIds: string[];
}

/** The relay, for one audience, from its `Authorization` header. */
export function voiceToolCaller(header: string | null, audience: string): VoiceToolCaller | null {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const body = verifyState(token);
  if (!body) return null;
  try {
    return voiceToolCallerOf(JSON.parse(body), audience);
  } catch {
    return null;
  }
}

/**
 * The call's account facts, or null when the account is gone. The
 * conversation is read under the caller's own id, so a signed id that is not
 * theirs (or no longer exists) is no conversation, never someone else's; a
 * project they can no longer open leaves the call with no connectors.
 */
export async function loadVoiceCall(caller: VoiceToolCaller): Promise<VoiceCall | null> {
  const [user, settings, conversation] = await Promise.all([
    prisma.user.findUnique({ where: { id: caller.userId }, select: { id: true } }),
    prisma.settings.findUnique({
      where: { userId: caller.userId },
      select: { lockdownMode: true, actionApprovalPolicy: true },
    }),
    caller.conversationId
      ? prisma.conversation.findFirst({
          where: { id: caller.conversationId, userId: caller.userId },
          select: { id: true, projectId: true, activeConnectors: true },
        })
      : Promise.resolve(null),
  ]);
  if (!user) return null;

  let projectId = conversation?.projectId ?? null;
  let workspace: WorkspaceConfig = {};
  if (projectId) {
    if (!(await checkProjectAccess(caller.userId, projectId, "VIEWER")).allowed) {
      // A project they cannot open is not a project whose apps or chats they
      // may reach: the call keeps only what needs no project at all.
      workspace = { allowedTools: [], allowedConnectorIds: [] };
      projectId = null;
    } else {
      const row = await prisma.projectWorkspace.findFirst({
        where: { projectId, userId: caller.userId },
        select: { config: true },
      });
      workspace = parseWorkspaceConfig(row?.config);
    }
  }

  // The same rule a typed turn applies (src/lib/chat/turn/context.ts): the
  // workspace may switch connectors off or allow only some of them.
  const requested = [...new Set([...(conversation?.activeConnectors ?? []), ...caller.connectorIds])];
  const connectorIds = workspacePermits(workspace, "connectors")
    ? requested.filter((id) => workspace.allowedConnectorIds === undefined || workspace.allowedConnectorIds.includes(id))
    : [];

  return {
    caller,
    conversationId: conversation?.id ?? null,
    projectId,
    workspace,
    plan: await getUserPlan(caller.userId),
    lockdown: !!settings?.lockdownMode,
    approvalPolicy: actionPolicyFromSetting(settings?.actionApprovalPolicy),
    connectorIds,
  };
}

/** The broker, the audit trail and the receipt store, as the dispatcher's ports. */
function brokerPorts(): ToolBatchPorts {
  return {
    authorizeExternalAction: (request) => authorizeExternalAction(request as unknown as AuthorizeActionInput),
    completeExternalAction: (request) =>
      completeExternalAction(request as unknown as Parameters<typeof completeExternalAction>[0]),
    recordToolInvocation: (request) =>
      recordToolInvocation(request as unknown as Parameters<typeof recordToolInvocation>[0]),
    settleToolInvocation: (id, outcome) =>
      settleToolInvocation(id, (outcome ?? { status: "executed" }) as Parameters<typeof settleToolInvocation>[1]),
  };
}

interface OpenedVoiceToolset {
  toolset: ChatToolset;
  fees: ToolFeeAccumulator | null;
  connectorLabels: string[];
  toolContext: Record<string, unknown>;
}

/**
 * The call's toolset: the plan's registry specs (search bound to a per-request
 * ledger, limits and source list, as a chat turn binds them) and the plan's
 * connectors, opened with the chat's per-server budget and tool-list cache.
 */
export async function openVoiceToolset(call: VoiceCall, opts: { signal?: AbortSignal } = {}): Promise<OpenedVoiceToolset> {
  const { caller } = call;
  const sessionId = voiceToolSessionId(caller.sessionId);
  const active: ActiveConnector[] = [];
  const plan = voiceToolPlan({
    plan: call.plan,
    lockdown: call.lockdown,
    approvalPolicy: call.approvalPolicy,
    workspace: call.workspace,
    saved: !!call.conversationId,
    alevrSearch: chatSearchAvailable(),
    connectorsRequested: call.connectorIds.length > 0,
  });
  if (plan.connectors && call.connectorIds.length > 0) {
    active.push(...(await getActiveConnectors(caller.userId, call.connectorIds, { timeZone: caller.timeZone })));
  }

  const searchIds = plan.juno.filter((id) => id === "web_search" || id === "search_news");
  const search = searchIds.length
    ? createAlevrSearchTurn({
        userId: caller.userId,
        conversationId: call.conversationId,
        private: false,
        effort: null,
        voice: true,
        userTexts: [],
        specs: searchIds.map((id) => junoToolSpec(id)).filter((spec): spec is ToolSpec => !!spec),
      })
    : null;
  const specs: ToolSpec[] = plan.juno
    .flatMap((id) =>
      id === "web_search" || id === "search_news"
        ? (search?.specs.filter((spec) => spec.id === id) ?? [])
        : [junoToolSpec(id)].filter((spec): spec is ToolSpec => !!spec)
    );

  const toolContext: Record<string, unknown> = {
    userId: caller.userId,
    surface: "voice",
    sessionId,
    // The broker keys a call's receipts by the generation; for a call it is the call.
    generationId: sessionId,
    conversationId: call.conversationId,
    projectId: call.projectId,
    private: false,
    citationsNumbered: false,
    ...(caller.timeZone ? { timeZone: caller.timeZone } : {}),
  };

  const connectors =
    active.length > 0
      ? await openChatToolset({
          plan: { ...plan.chat, juno: [] },
          connectors: active,
          skipped: [],
          context: { userId: caller.userId, conversationId: call.conversationId, projectId: call.projectId, surface: "voice", sessionId },
          mcpContext: {
            userId: caller.userId,
            conversationId: call.conversationId,
            surface: "voice",
            sessionId,
            projectId: call.projectId,
          },
          nativeTools: [],
          // The chat's per-server budget and its tool-list cache: a call opens
          // the toolset for every tool it runs, and only the server it calls
          // is dialled when its list is cached.
          openMcp: (connectorList, mcpContext, openOpts) =>
            openMcpToolset(connectorList, mcpContext, {
              ...openOpts,
              connectTimeoutMs: mcpConnectTimeoutMs(),
              cacheTools: true,
              ...(opts.signal ? { signal: opts.signal } : {}),
            }),
        })
      : null;

  return {
    toolset: composeVoiceToolset(specs, connectors),
    fees: search?.fees ?? null,
    connectorLabels: active.map((connector) => connector.label),
    toolContext,
  };
}

/**
 * The most listing may take. A call is waiting to start on it (the relay gives
 * up at 6 s), and each connector already has its own 5 s budget; one that has
 * not listed by then is left out of this call rather than holding it.
 */
const LIST_BUDGET_MS = 5_500;

/** What the relay is told: the call's tools and Juno's note about them. */
export async function listVoiceTools(call: VoiceCall): Promise<{ tools: VoiceToolDescriptor[]; instructions: string | null }> {
  const opened = await openVoiceToolset(call, { signal: AbortSignal.timeout(LIST_BUDGET_MS) });
  try {
    const tools = voiceToolDescriptors(opened.toolset);
    const appLabels = opened.connectorLabels.filter((label) =>
      tools.some((tool) => tool.label.startsWith(`${label} · `))
    );
    return { tools, instructions: voiceToolInstructions({ descriptors: tools, connectorLabels: appLabels }) };
  } finally {
    await opened.toolset.close().catch(() => undefined);
  }
}

/** One line of the call stream (relay/src/tools.ts reads these). */
export type VoiceToolFrame =
  | { type: "approval"; approval: ClientActionApproval; spoken: boolean }
  | { type: "result"; status: VoiceToolResultStatus; text: string };

/**
 * Run one tool call for the relay, through the chat's dispatcher, emitting a
 * frame when the call starts waiting on the person and one with its outcome.
 * Every way it can end is a result frame; nothing is thrown at the route.
 */
export async function runVoiceToolCall(
  call: VoiceCall,
  input: { callId: string; name: string; arguments: string },
  emit: (frame: VoiceToolFrame) => void,
  signal: AbortSignal
): Promise<void> {
  let opened: OpenedVoiceToolset | null = null;
  try {
    opened = await openVoiceToolset(call, { signal });
    const resolved = opened.toolset.resolve(input.name);
    const label = resolved
      ? (voiceToolDescriptors({ tools: opened.toolset.tools.filter((tool) => tool.function.name === input.name), resolve: opened.toolset.resolve })[0]?.label ?? resolved.title)
      : input.name;
    const batch = executeToolBatch(
      [{ name: input.name, callId: input.callId, providerCallId: input.callId, round: 0, index: 0, argsText: input.arguments }],
      signal,
      { toolset: opened.toolset, ports: brokerPorts(), toolContext: opened.toolContext }
    );
    let body: string | undefined;
    let step = await batch.next();
    while (!step.done) {
      const event = step.value;
      if (event.type === "tool" && event.phase === "status" && event.status === "awaiting_approval" && event.approval) {
        emit({ type: "approval", approval: event.approval, spoken: spokenApprovalAllowed(event.approval) });
      } else if (event.type === "tool" && event.phase === "result") {
        body = event.result;
      }
      step = await batch.next();
    }
    const [result] = step.value;
    emit({
      type: "result",
      status: voiceResultStatus(result?.status ?? "failed"),
      text: voiceResultText({ label, text: result?.text ?? "The call returned no result.", body, status: result?.status ?? "failed" }),
    });
  } catch {
    // The relay went away (the call ended) or the request ran out of time; the
    // dispatcher answered the call cancelled and the broker superseded any
    // approval still waiting. Nothing is left to report to anyone listening.
    emit({ type: "result", status: "cancelled", text: voiceResultText({ label: input.name, text: "The call was cancelled before it finished.", status: "cancelled" }) });
  } finally {
    await opened?.toolset.close().catch(() => undefined);
    if (opened?.fees) {
      // Paid searches are billed to the person who asked, as a chat turn's are.
      await recordToolFees(opened.fees, recordSpend, { userId: call.caller.userId, source: "web" }).catch(() => 0);
    }
  }
}

