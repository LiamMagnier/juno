import "server-only";

/**
 * Rooms on the server: membership, the per-message turn plan, and the reads
 * the room header and the chat route need. The rules are pure, in
 * `src/lib/agents/rooms.ts`; this file only reads and writes them.
 *
 * Every query carries the account's id (`AgentRoomMember` and `AgentRoomTurn`
 * are guarded in src/lib/db.ts).
 */

import { Prisma, type Agent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptField, encryptField } from "@/lib/field-crypto";
import { decryptMessageText } from "@/lib/message-crypto";
import { DEFAULT_MODEL } from "@/lib/models";
import { recordAgentEvent, serializeAgents, type AgentActor } from "@/lib/agents/store";
import {
  ROOM_MAX_MEMBERS,
  ROOM_MIN_MEMBERS,
  canAskMember,
  nextRoomTurn,
  planRoomTurns,
  roomHandoffSentence,
  roomTitle,
  type AskRefusal,
  type RoomMemberInfo,
  type RoomTurnReason,
} from "@/lib/agents/rooms";
import type { ClientRoom, ClientRoomDetail, ClientRoomTurn } from "@/lib/agents/room-types";

export interface RoomMembersRead {
  conversationId: string;
  title: string;
  agents: Agent[];
  members: RoomMemberInfo[];
}

function memberInfo(agent: Agent, goalTitles: readonly string[] = []): RoomMemberInfo {
  return {
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    about: [agent.instructions.slice(0, 2_000), ...goalTitles].join("\n"),
    paused: agent.status !== "active",
  };
}

/** The room a conversation is, with its live members, or null when it is not a room. */
export async function readRoomMembers(userId: string, conversationId: string): Promise<RoomMembersRead | null> {
  const rows = await prisma.agentRoomMember.findMany({
    where: { userId, conversationId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { agentId: true },
  });
  if (rows.length === 0) return null;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true, title: true },
  });
  if (!conversation) return null;
  const agentsById = new Map(
    (
      await prisma.agent.findMany({
        where: { userId, deletedAt: null, id: { in: rows.map((row) => row.agentId) } },
      })
    ).map((agent) => [agent.id, agent])
  );
  const agents = rows.map((row) => agentsById.get(row.agentId)).filter((agent): agent is Agent => !!agent);
  const goals = await prisma.agentGoal.findMany({
    where: { userId, agentId: { in: agents.map((agent) => agent.id) }, status: "active" },
    select: { agentId: true, title: true },
    take: 60,
  });
  return {
    conversationId,
    title: conversation.title,
    agents,
    members: agents.map((agent) =>
      memberInfo(
        agent,
        goals.filter((goal) => goal.agentId === agent.id).map((goal) => goal.title)
      )
    ),
  };
}

export type CreateRoomOutcome =
  | { ok: true; room: ClientRoom }
  | { ok: false; status: number; error: string; message: string };

/**
 * A new room with the given agents. The conversation is an ordinary chat
 * titled by the person (or after its members) so the auto-titler leaves it.
 */
export async function createRoomForUser(
  user: AgentActor,
  input: { agentIds: readonly string[]; title?: string | null }
): Promise<CreateRoomOutcome> {
  const ids = [...new Set(input.agentIds)];
  if (ids.length < ROOM_MIN_MEMBERS || ids.length > ROOM_MAX_MEMBERS) {
    return { ok: false, status: 400, error: "invalid_members", message: "A room has two to six agents." };
  }
  const agents = await prisma.agent.findMany({ where: { userId: user.id, deletedAt: null, id: { in: ids } } });
  if (agents.length !== ids.length) {
    return { ok: false, status: 404, error: "agent_not_found", message: "One of those agents no longer exists." };
  }
  const ordered = ids.map((id) => agents.find((agent) => agent.id === id)!);
  const settings = await prisma.settings.findFirst({ where: { userId: user.id }, select: { defaultModel: true } });
  const conversation = await prisma.$transaction(async (tx) => {
    const created = await tx.conversation.create({
      data: {
        userId: user.id,
        title: roomTitle(
          ordered.map((agent) => agent.name),
          input.title
        ),
        titleSource: "manual",
        kind: "chat",
        model: settings?.defaultModel ?? DEFAULT_MODEL,
      },
      select: { id: true },
    });
    await tx.agentRoomMember.createMany({
      data: ordered.map((agent, position) => ({
        userId: user.id,
        conversationId: created.id,
        agentId: agent.id,
        position,
      })),
    });
    return created;
  });
  for (const agent of ordered) {
    await recordAgentEvent({
      userId: user.id,
      agentId: agent.id,
      kind: "room_joined",
      title: `Joined ${roomTitle(ordered.map((a) => a.name), input.title)}`,
      detail: { conversationId: conversation.id },
    });
  }
  const room = await loadRoom(user.id, conversation.id);
  if (!room) return { ok: false, status: 500, error: "room_unavailable", message: "The room could not be read back." };
  return { ok: true, room };
}

export async function loadRoom(userId: string, conversationId: string): Promise<ClientRoom | null> {
  const read = await readRoomMembers(userId, conversationId);
  if (!read) return null;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { title: true, lastMessageAt: true, createdAt: true },
  });
  if (!conversation) return null;
  return {
    conversationId,
    title: conversation.title,
    members: await serializeAgents(userId, read.agents),
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
  };
}

/** Every room of the account, newest activity first. Archived conversations are left out. */
export async function listRoomsForUser(userId: string): Promise<ClientRoom[]> {
  const rows = await prisma.agentRoomMember.findMany({
    where: { userId },
    orderBy: [{ position: "asc" }],
    select: { conversationId: true, agentId: true },
    take: 600,
  });
  if (rows.length === 0) return [];
  const conversationIds = [...new Set(rows.map((row) => row.conversationId))];
  const conversations = await prisma.conversation.findMany({
    where: { userId, id: { in: conversationIds }, archivedAt: null },
    select: { id: true, title: true, lastMessageAt: true, createdAt: true },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
  });
  const agents = await prisma.agent.findMany({
    where: { userId, deletedAt: null, id: { in: [...new Set(rows.map((row) => row.agentId))] } },
  });
  const serialized = new Map((await serializeAgents(userId, agents)).map((agent) => [agent.id, agent]));
  return conversations.map((conversation) => ({
    conversationId: conversation.id,
    title: conversation.title,
    members: rows
      .filter((row) => row.conversationId === conversation.id)
      .map((row) => serialized.get(row.agentId))
      .filter((agent): agent is NonNullable<typeof agent> => !!agent),
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// The turn plan
// ---------------------------------------------------------------------------

/** The agent that wrote the newest assistant message in the room, if known. */
async function lastSpeakerId(userId: string, conversationId: string): Promise<string | null> {
  const row = await prisma.agentRoomTurn.findFirst({
    where: { userId, conversationId, status: "answered" },
    orderBy: { updatedAt: "desc" },
    select: { agentId: true },
  });
  return row?.agentId ?? null;
}

export interface RoomTurnSetup {
  room: RoomMembersRead;
  /** The agent answering this request. */
  speaker: RoomMemberInfo;
  /** How this turn came to be. */
  mode:
    | { kind: "new"; plan: { agentId: string; reason: "addressed" | "routed" }[] }
    | { kind: "follow_up"; turnId: string; userMessageId: string; fromAgentId: string | null; request: string | null }
    | { kind: "retry"; turnId: string | null; userMessageId: string | null };
}

export type RoomTurnRefusal = { status: number; error: string; message: string };

/**
 * Decides which member answers this chat request in a room, before the route
 * builds anything. Returns null when the conversation is not a room.
 *
 * - A new message: plan who answers (addressed members, or the best fit). The
 *   rows are written once the message is saved (`recordRoomPlan`).
 * - `roomTurn`: a follow-up the web client runs for a planned or asked turn.
 *   It must be the next pending turn of the newest message.
 * - A regenerate: re-answer as whoever wrote the answer being replaced. A
 *   native client's regenerate after appending a message (the last message
 *   is the person's) is a new message and is planned like one.
 */
export async function prepareRoomTurn(input: {
  userId: string;
  conversationId: string;
  message: string | null;
  regenerate: boolean;
  roomTurnAgentId: string | null;
  now?: Date;
}): Promise<RoomTurnSetup | RoomTurnRefusal | null> {
  const room = await readRoomMembers(input.userId, input.conversationId);
  if (!room) {
    return input.roomTurnAgentId
      ? { status: 409, error: "not_a_room", message: "This conversation is not a room." }
      : null;
  }
  const byId = (agentId: string) => room.members.find((member) => member.agentId === agentId) ?? null;

  if (input.roomTurnAgentId) {
    const lastUser = await prisma.message.findFirst({
      where: { conversationId: input.conversationId, role: "USER", conversation: { userId: input.userId } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!lastUser) return { status: 409, error: "room_turn_not_pending", message: "There is nothing to answer yet." };
    const turns = await prisma.agentRoomTurn.findMany({
      where: { userId: input.userId, userMessageId: lastUser.id },
    });
    const next = nextRoomTurn(turns, input.now);
    if (!next || next.agentId !== input.roomTurnAgentId) {
      return { status: 409, error: "room_turn_not_pending", message: "That agent is not the next to answer." };
    }
    const speaker = byId(next.agentId);
    if (!speaker || speaker.paused) {
      await markRoomTurn(input.userId, next.id, "skipped");
      return { status: 409, error: "room_turn_not_pending", message: "That agent cannot answer right now." };
    }
    const claimed = await prisma.agentRoomTurn.updateMany({
      where: { id: next.id, userId: input.userId, status: "pending" },
      data: { status: "running" },
    });
    if (claimed.count !== 1) {
      return { status: 409, error: "room_turn_not_pending", message: "That turn has already started." };
    }
    return {
      room,
      speaker,
      mode: {
        kind: "follow_up",
        turnId: next.id,
        userMessageId: lastUser.id,
        fromAgentId: next.fromAgentId,
        request: next.request ? decryptField(next.request) : null,
      },
    };
  }

  if (input.regenerate) {
    const last = await prisma.message.findFirst({
      where: { conversationId: input.conversationId, conversation: { userId: input.userId } },
      orderBy: { createdAt: "desc" },
      select: { id: true, role: true, content: true },
    });
    if (last?.role === "ASSISTANT") {
      const turn = await prisma.agentRoomTurn.findFirst({
        where: { userId: input.userId, messageId: last.id },
      });
      const speaker = (turn && byId(turn.agentId)) || room.members.find((member) => !member.paused) || null;
      if (!speaker) return { status: 409, error: "room_paused", message: "Everyone in this room is paused." };
      if (turn) {
        await prisma.agentRoomTurn.updateMany({
          where: { id: turn.id, userId: input.userId },
          data: { status: "running" },
        });
      }
      return { room, speaker, mode: { kind: "retry", turnId: turn?.id ?? null, userMessageId: turn?.userMessageId ?? null } };
    }
    if (last?.role === "USER") {
      const text = decryptMessageText(last.content) ?? "";
      const plan = planRoomTurns({
        text,
        members: room.members,
        lastSpeakerId: await lastSpeakerId(input.userId, input.conversationId),
      });
      const speaker = plan[0] ? byId(plan[0].agentId) : null;
      if (!speaker) return { status: 409, error: "room_paused", message: "Everyone in this room is paused." };
      return { room, speaker, mode: { kind: "new", plan } };
    }
  }

  const plan = planRoomTurns({
    text: input.message ?? "",
    members: room.members,
    lastSpeakerId: await lastSpeakerId(input.userId, input.conversationId),
  });
  const speaker = plan[0] ? byId(plan[0].agentId) : null;
  if (!speaker) return { status: 409, error: "room_paused", message: "Everyone in this room is paused." };
  return { room, speaker, mode: { kind: "new", plan } };
}

/**
 * Writes the plan for a new message: the first turn running (it is the one
 * answering now), the rest pending. Returns the running turn's id.
 */
export async function recordRoomPlan(input: {
  userId: string;
  conversationId: string;
  userMessageId: string;
  plan: readonly { agentId: string; reason: RoomTurnReason }[];
}): Promise<string | null> {
  let firstId: string | null = null;
  for (const [position, turn] of input.plan.entries()) {
    try {
      const row = await prisma.agentRoomTurn.create({
        data: {
          userId: input.userId,
          conversationId: input.conversationId,
          userMessageId: input.userMessageId,
          agentId: turn.agentId,
          reason: turn.reason,
          position,
          status: position === 0 ? "running" : "pending",
        },
        select: { id: true },
      });
      if (position === 0) firstId = row.id;
    } catch (error) {
      // A retried request for the same message: the plan is already written.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        if (position === 0) {
          const existing = await prisma.agentRoomTurn.findFirst({
            where: { userId: input.userId, userMessageId: input.userMessageId, position: 0 },
            select: { id: true },
          });
          firstId = existing?.id ?? null;
        }
        continue;
      }
      throw error;
    }
  }
  return firstId;
}

export async function markRoomTurn(
  userId: string,
  turnId: string,
  status: "answered" | "failed" | "skipped",
  messageId?: string | null
): Promise<void> {
  await prisma.agentRoomTurn
    .updateMany({
      where: { id: turnId, userId },
      data: { status, ...(messageId ? { messageId } : {}) },
    })
    .catch((error) => {
      console.error("[rooms] could not mark a turn", {
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export type AskMemberOutcome =
  | { ok: true; toName: string; sentence: string }
  | { ok: false; reason: AskRefusal | "stopped" };

/**
 * Queues `targetAgentId` to answer the message right after the asking member.
 * The pure rule (`canAskMember`) decides; the unique keys hold under a race.
 */
export async function askRoomMember(input: {
  userId: string;
  conversationId: string;
  userMessageId: string;
  fromAgentId: string;
  fromName: string;
  targetAgentId: string;
  request: string;
  members: readonly RoomMemberInfo[];
}): Promise<AskMemberOutcome> {
  const turns = await prisma.agentRoomTurn.findMany({
    where: { userId: input.userId, userMessageId: input.userMessageId },
    select: { agentId: true },
  });
  const verdict = canAskMember({
    fromAgentId: input.fromAgentId,
    targetAgentId: input.targetAgentId,
    members: input.members,
    turns,
  });
  if (!verdict.ok) return verdict;
  const target = input.members.find((member) => member.agentId === input.targetAgentId)!;
  try {
    await prisma.agentRoomTurn.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        userMessageId: input.userMessageId,
        agentId: target.agentId,
        fromAgentId: input.fromAgentId,
        reason: "asked",
        request: encryptField(input.request),
        position: verdict.position,
        status: "pending",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Either this member was just queued by another call (the loop guard) or
      // the last position was taken (the cap). Both refuse the same way.
      return { ok: false, reason: "already_answering" };
    }
    throw error;
  }
  await recordAgentEvent({
    userId: input.userId,
    agentId: input.fromAgentId,
    kind: "room_asked",
    title: roomHandoffSentence(input.fromName, target.name, input.request),
    detail: { conversationId: input.conversationId, toAgentId: target.agentId },
  });
  return { ok: true, toName: target.name, sentence: roomHandoffSentence(input.fromName, target.name, input.request) };
}

/** Who wrote each assistant message in the room, for labelling history. */
export async function roomSpeakers(
  userId: string,
  conversationId: string,
  members: readonly RoomMemberInfo[]
): Promise<Map<string, { agentId: string; name: string }>> {
  const rows = await prisma.agentRoomTurn.findMany({
    where: { userId, conversationId, messageId: { not: null } },
    select: { messageId: true, agentId: true },
    orderBy: { createdAt: "desc" },
    take: 400,
  });
  const names = new Map(members.map((member) => [member.agentId, member.name]));
  const map = new Map<string, { agentId: string; name: string }>();
  for (const row of rows) {
    if (!row.messageId || map.has(row.messageId)) continue;
    map.set(row.messageId, { agentId: row.agentId, name: names.get(row.agentId) ?? "Another agent" });
  }
  return map;
}

/** The room, the turns of its recent messages, and what should run next. */
export async function loadRoomDetail(userId: string, conversationId: string, now = new Date()): Promise<ClientRoomDetail | null> {
  const room = await loadRoom(userId, conversationId);
  if (!room) return null;
  const rows = await prisma.agentRoomTurn.findMany({
    where: { userId, conversationId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  rows.reverse();
  const names = new Map(room.members.map((member) => [member.id, member.name]));
  const turns: ClientRoomTurn[] = rows.map((row) => ({
    id: row.id,
    userMessageId: row.userMessageId,
    agentId: row.agentId,
    fromAgentId: row.fromAgentId,
    reason: (row.reason === "asked" || row.reason === "addressed" ? row.reason : "routed") as ClientRoomTurn["reason"],
    handoffSentence:
      row.reason === "asked" && row.fromAgentId
        ? roomHandoffSentence(
            names.get(row.fromAgentId) ?? "An agent",
            names.get(row.agentId) ?? "another agent",
            row.request ? decryptField(row.request) : null
          )
        : null,
    status: row.status as ClientRoomTurn["status"],
    messageId: row.messageId,
  }));
  const lastUser = await prisma.message.findFirst({
    where: { conversationId, role: "USER", conversation: { userId } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const current = lastUser ? rows.filter((row) => row.userMessageId === lastUser.id) : [];
  const next = nextRoomTurn(current, now);
  return {
    room,
    turns,
    next: next && lastUser ? { agentId: next.agentId, userMessageId: lastUser.id } : null,
  };
}
