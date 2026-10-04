import "server-only";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseWorkspaceConfig } from "@/lib/projects/workspace-config";
import { prepareRoomTurn, type RoomTurnSetup } from "@/lib/agents/room-store";
import { buildRoomPromptBlock, canAskMember } from "@/lib/agents/rooms";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { TurnUser } from "./types";

/*
 * Pipeline stage 3 — resolveAssistantIdentity: who answers this turn. The
 * project assistant (workspace config), the agent whose thread this is, and in
 * a room the member picked to speak. Resolved before any tool is admitted,
 * because the server is the trust boundary for what each of them may use.
 */

/** Whether the answering member of a room may ask another one (`ask_room_member`). */
export function roomMayAsk(setup: RoomTurnSetup, roomMessageId: string | null): boolean {
  // Offered only when some member could actually be asked: the same pure rule
  // `askRoomMember` enforces (cap, loop guard, paused), so the prompt never
  // invites a call the room would refuse.
  const turns = setup.messageTurnAgentIds.map((agentId) => ({ agentId }));
  return (
    !!roomMessageId &&
    setup.mode.kind !== "retry" &&
    setup.room.members.some(
      (member) =>
        canAskMember({ fromAgentId: setup.speaker.agentId, targetAgentId: member.agentId, members: setup.room.members, turns }).ok
    )
  );
}

/** The room section appended after the answering agent's own block (src/lib/agents/rooms.ts). */
export function roomPromptBlock(setup: RoomTurnSetup, personName: string | null | undefined, roomMessageId: string | null): string {
  const fromAgentId = setup.mode.kind === "follow_up" ? setup.mode.fromAgentId : null;
  const asked =
    setup.mode.kind === "follow_up" && fromAgentId
      ? {
          fromName: setup.room.members.find((member) => member.agentId === fromAgentId)?.name ?? "Another agent",
          request: setup.mode.request,
        }
      : null;
  return buildRoomPromptBlock({
    self: { agentId: setup.speaker.agentId, name: setup.speaker.name },
    members: setup.room.members,
    personName,
    asked,
    canAsk: roomMayAsk(setup, roomMessageId),
  });
}

export async function resolveAssistantIdentity({ user, input }: { user: TurnUser; input: ChatRequestBody }) {
  // Resolve the project assistant before any tool is admitted. Native clients
  // already hide denied controls, but the server is the trust boundary and the
  // web/iOS clients must receive identical enforcement even on an older build.
  let workspaceProjectID: string | null = null;
  /** The agent whose thread this is, when it is one: read now because its model is a candidate below. */
  let threadAgentId: string | null = null;
  /** Set when the conversation is a room: who answers this request, and why. */
  let roomSetup: RoomTurnSetup | null = null;
  if (input.roomTurn && (!input.regenerate || input.privateMode || !input.conversationId)) {
    return NextResponse.json(
      { error: "invalid_room_turn", message: "A room turn answers a saved room's newest message." },
      { status: 400 }
    );
  }
  if (!input.privateMode) {
    if (input.conversationId) {
      const thread = await prisma.conversation.findFirst({
        where: { id: input.conversationId, userId: user.id },
        select: { projectId: true, agentId: true },
      });
      workspaceProjectID = thread?.projectId ?? null;
      threadAgentId = thread?.agentId ?? null;
      // A room (src/lib/agents/rooms.ts): one member answers this request,
      // and from here on the turn is that agent's, exactly as in its thread.
      if (thread && !thread.agentId) {
        const setup = await prepareRoomTurn({
          userId: user.id,
          conversationId: input.conversationId,
          message: input.message ?? null,
          regenerate: !!input.regenerate,
          roomTurnAgentId: input.roomTurn?.agentId ?? null,
        });
        if (setup && "status" in setup) {
          return NextResponse.json({ error: setup.error, message: setup.message }, { status: setup.status });
        }
        if (setup) {
          roomSetup = setup;
          threadAgentId = setup.speaker.agentId;
        }
      }
    } else if (input.projectId) {
      workspaceProjectID = (
        await prisma.project.findFirst({
          where: { id: input.projectId, userId: user.id },
          select: { id: true },
        })
      )?.id ?? null;
    }
  }
  const workspaceRow = workspaceProjectID
    ? await prisma.projectWorkspace.findFirst({
        where: { projectId: workspaceProjectID, userId: user.id },
        select: { config: true },
      })
    : null;
  const workspaceConfig = parseWorkspaceConfig(workspaceRow?.config);
  // A workspace row means the reader has configured an assistant. Its omitted
  // knowledge list is the compact spelling of "no standing files"; with no row
  // at all, preserve the longstanding project behaviour of referencing every
  // project file.
  const selectedKnowledgeFileIds = workspaceRow
    ? (workspaceConfig.knowledgeFileIds ?? [])
    : undefined;

  /*
   * An agent's thread answers on the agent's model and effort unless this
   * message names another model (`agentTurnModel` has the rule). An agent's
   * model this account cannot use right now is dropped quietly, and the turn
   * resolves as if no model had been named, rather than refusing to answer in
   * a thread whose setup the person may not remember.
   */
  const threadAgent = threadAgentId
    ? await prisma.agent
        .findFirst({
          where: { id: threadAgentId, userId: user.id, deletedAt: null },
          select: { model: true, reasoningEffort: true },
        })
        .catch(() => null)
    : null;

  return { workspaceProjectID, threadAgentId, roomSetup, workspaceRow, workspaceConfig, selectedKnowledgeFileIds, threadAgent };
}

export type TurnIdentity = Exclude<Awaited<ReturnType<typeof resolveAssistantIdentity>>, Response>;
